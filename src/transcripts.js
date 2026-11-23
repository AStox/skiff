'use strict'
const fs = require('node:fs')
const path = require('node:path')

const MAX_FILE = 8 * 1024 * 1024
const MAX_RECORD = 512 * 1024
const MAX_CHATS = 128
const MAX_TURNS = 200
const DAY = 86400000
const text = (value, size) => typeof value === 'string' ? value.slice(0, size) : ''
const error = (code, message) => Object.assign(new Error(message), { code })
const copy = (value) => JSON.parse(JSON.stringify(value))

function cleanTurn(turn) {
  if (!turn || !['user', 'assistant', 'tool', 'notice'].includes(turn.kind)) return null
  const out = { id: text(turn.id, 100), kind: turn.kind, text: text(turn.text, 200000) }
  if (turn.kind === 'assistant') Object.assign(out, { thought: '', done: true, stopReason: text(turn.stopReason, 50) || 'interrupted' })
  if (turn.kind === 'tool') Object.assign(out, { toolCallId: text(turn.toolCallId, 200), title: text(turn.title, 500), status: text(turn.status, 30), toolKind: text(turn.toolKind, 50), text: text(turn.text, 4000) })
  if (turn.kind === 'user') out.context = turn.context ? { url: text(turn.context.url, 2000), title: text(turn.context.title, 300) } : null
  return out
}

function createTranscripts({ dir, state, changed = () => {}, emit = () => {} }) {
  const file = path.join(dir, 'transcripts.json')
  const records = new Map()
  const deleted = new Set()
  const current = () => typeof state === 'function' ? state() : state
  const tabs = () => [...current().tabs, ...(current().archive || [])]
  const tabFor = (id) => tabs().find((tab) => tab.chat && tab.url === `skiff://chat/${id}`)
  const excluded = (tab) => Boolean(tab && (tab.agent || tab.userPeek || String(tab.sessionPartition || '').startsWith('incognito-') || current().spaces.some((space) => space.id === tab.spaceId && space.incognito)))
  const normal = (tab) => tab && !excluded(tab) && current().spaces.some((space) => space.id === tab.spaceId)
  const retention = () => Math.min(3650, Math.max(1, Number(current().settings?.transcriptRetentionDays) || 30)) * DAY
  let loadError = null
  let stopped = false
  let scrubbed = false

  try {
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > MAX_FILE) throw new Error('Transcript journal exceeds its size limit')
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.records) || !Array.isArray(saved.deleted)) throw new Error('Invalid transcript journal')
      for (const id of saved.deleted) if (typeof id === 'string' && id.length <= 200) deleted.add(id)
      for (const item of saved.records.slice(-MAX_CHATS)) {
        if (!item || typeof item.id !== 'string' || !Number.isFinite(item.updatedAt) || !Array.isArray(item.turns) || deleted.has(item.id)) continue
        const tab = tabFor(item.id)
        if (excluded(tab)) { scrubbed = true; continue }
        records.set(item.id, { id: item.id.slice(0, 200), tabId: text(item.tabId, 200), agent: text(item.agent, 200), sessionId: text(item.sessionId, 200) || null, title: text(item.title, 300), createdAt: Number(item.createdAt) || item.updatedAt, updatedAt: item.updatedAt, turns: item.turns.slice(-MAX_TURNS).map(cleanTurn).filter(Boolean) })
      }
    }
  } catch (e) {
    loadError = error('transcript_error', `Local transcripts could not be read: ${e.message}`)
  }

  function prune(now = Date.now()) {
    let removed = false
    for (const [id, record] of records) {
      const tab = tabFor(id)
      if (excluded(tab) || record.updatedAt < now - retention()) { records.delete(id); removed = true }
    }
    return removed
  }

  function flush() {
    if (loadError) throw loadError
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const encode = () => JSON.stringify({ version: 1, records: [...records.values()], deleted: [...deleted] })
    let data = encode()
    while (records.size && (records.size > MAX_CHATS || Buffer.byteLength(data) > MAX_FILE)) {
      const oldest = [...records.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]
      records.delete(oldest.id)
      data = encode()
    }
    if (Buffer.byteLength(data) > MAX_FILE) throw error('transcript_error', 'Too many transcript deletion markers')
    fs.writeFileSync(`${file}.tmp`, data, { mode: 0o600 })
    fs.chmodSync(`${file}.tmp`, 0o600)
    fs.renameSync(`${file}.tmp`, file)
    changed()
    emit('transcripts', { count: records.size })
  }

  function record(chat) {
    if (stopped || current().settings?.transcriptRecovery !== true || deleted.has(chat.id)) return false
    if (loadError) throw loadError
    const tab = tabFor(chat.id)
    if (!normal(tab) || !Array.isArray(chat.turns) || !chat.turns.length || chat.recovery?.readOnly) return false
    const now = Date.now()
    prune(now)
    const previous = records.get(chat.id)
    const item = { id: chat.id, tabId: tab.id, agent: text(chat.agent, 200), sessionId: text(chat.sessionId, 200) || null, title: text(tab.title, 300), createdAt: previous?.createdAt ?? now, updatedAt: now, turns: chat.turns.slice(-MAX_TURNS).map(cleanTurn).filter(Boolean) }
    while (item.turns.length && Buffer.byteLength(JSON.stringify(item)) > MAX_RECORD) item.turns.shift()
    records.set(item.id, item)
    flush()
    return true
  }

  function list() {
    if (loadError) throw loadError
    if (prune()) flush()
    return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(({ turns, ...record }) => ({ ...record, turnCount: turns.length }))
  }
  function get({ id } = {}) {
    list()
    const item = records.get(id)
    if (!item) throw error('not_found', `No local transcript ${id}`)
    return { ...copy(item), readOnly: true }
  }
  function remove({ id } = {}) {
    if (typeof id !== 'string' || !id || id.length > 200) throw error('bad_params', 'A transcript id is required')
    if (loadError) throw loadError
    const removed = records.delete(id)
    deleted.add(id)
    flush()
    return { deleted: removed }
  }
  function clear() {
    const count = records.size
    for (const id of records.keys()) deleted.add(id)
    for (const tab of tabs()) if (normal(tab) && tab.chat && tab.url?.startsWith('skiff://chat/')) deleted.add(tab.url.slice('skiff://chat/'.length))
    records.clear()
    loadError = null
    flush()
    return { deleted: count }
  }
  function exportTranscript({ id, format = 'json' } = {}) {
    if (!['json', 'text'].includes(format)) throw error('bad_params', 'Transcript export format must be json or text')
    const item = get({ id })
    const safeName = id.replace(/[^a-zA-Z0-9_-]/g, '_')
    return format === 'json'
      ? { filename: `${safeName}.json`, mime: 'application/json', text: JSON.stringify(item, null, 2) }
      : { filename: `${safeName}.txt`, mime: 'text/plain', text: `${item.title}\nAgent: ${item.agent}\nRead-only local recovery; not agent session context.\n\n${item.turns.map((turn) => `${turn.kind.toUpperCase()}${turn.title ? `: ${turn.title}` : ''}\n${turn.text}`).join('\n\n')}` }
  }
  function register(registry) {
    const id = { type: 'string', minLength: 1, maxLength: 200 }
    const definition = (name, description, properties, required, run) => registry.register('stock.transcripts', { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, tool: false, run })
    const disposers = [
      definition('transcripts.list', 'List local recovery transcripts', {}, [], list),
      definition('transcripts.get', 'Read a local recovery transcript without replaying it', { id }, ['id'], get),
      definition('transcripts.delete', 'Delete a local transcript and stop recording this conversation', { id }, ['id'], remove),
      definition('transcripts.clear', 'Delete all local transcripts', {}, [], clear),
      definition('transcripts.export', 'Export a local transcript as JSON or plain text', { id, format: { type: 'string', enum: ['json', 'text'] } }, ['id'], exportTranscript)
    ]
    return () => disposers.forEach((dispose) => dispose())
  }
  if (!loadError && (prune() || scrubbed)) flush()
  return { record, list, get, delete: remove, clear, export: exportTranscript, register, stop() { stopped = true } }
}

module.exports = { createTranscripts }

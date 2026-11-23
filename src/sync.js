'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const { refreshFolderLabels } = require('./state')

const VERSION = 1
const MAX_BYTES = 16 * 1024 * 1024
const MAX_RECORDS = 50000
const ID = /^(?!(?:__proto__|constructor|prototype)$)[a-zA-Z0-9._-]{1,160}$/
const DEVICE = /^[a-f0-9]{32}$/
const PREFS = {
  autoArchiveHours: [0, 8760], historyRetentionDays: [0, 3650],
  memorySaverMinutes: [1, 1440], memorySaver: 'boolean', downloadAskWhere: 'boolean'
}
const fail = (message) => Object.assign(new Error(message), { code: 'sync_error' })
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => JSON.parse(JSON.stringify(v))
const keyId = (key) => crypto.createHash('sha256').update(key).digest('hex')
const emptyJournal = () => ({ version: VERSION, counter: 0, records: {}, baseline: {}, partitions: {}, conflicts: [] })
const recordKey = (kind, id) => `${kind}/${id}`
const stable = (value) => JSON.stringify(value, Object.keys(value).sort())

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(value))
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
  }
}

function readJSON(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw fail('Sync file exceeds the size limit')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function seal(value, key, purpose, device) {
  const header = { version: VERSION, algorithm: 'AES-256-GCM', purpose, device, keyId: keyId(key) }
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(JSON.stringify(header)))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { ...header, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function unseal(envelope, key, purpose, device) {
  try {
    if (!plain(envelope) || envelope.version !== VERSION || envelope.algorithm !== 'AES-256-GCM' || envelope.purpose !== purpose || envelope.keyId !== keyId(key) || !DEVICE.test(envelope.device) || (device && envelope.device !== device)) throw Error()
    const { version, algorithm, device: writer, keyId: fingerprint } = envelope
    const header = { version, algorithm, purpose, device: writer, keyId: fingerprint }
    const nonce = Buffer.from(envelope.nonce, 'base64')
    const tag = Buffer.from(envelope.tag, 'base64')
    if (nonce.length !== 12 || tag.length !== 16 || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > MAX_BYTES) throw Error()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(JSON.stringify(header)))
    decipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
  } catch { throw fail('Sync authentication failed; pairing key or encrypted data is invalid') }
}

function portableURL(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    // Local services and authentication callback URLs are not portable browser data.
    if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[f[cd]|\[fe80)/i.test(url.hostname) || !url.hostname.includes('.')) return null
    const sensitive = (params) => [...params.keys()].some((key) => /^(access_token|refresh_token|id_token|token|password|secret|api_?key|code|credential|authorization)$/i.test(key))
    const fragment = url.hash.slice(1)
    if (sensitive(url.searchParams) || sensitive(new URLSearchParams(fragment)) || (fragment.includes('?') && sensitive(new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1))))) return null
    return url.href
  } catch { return null }
}

function pick(kind, item) {
  if (!plain(item) || !ID.test(item.id)) return null
  if (['profiles', 'spaces', 'folders'].includes(kind) && (typeof item.name !== 'string' || !item.name.trim())) return null
  if (['tabs', 'folders'].includes(kind) && (typeof item.spaceId !== 'string' || !ID.test(item.spaceId))) return null
  const value = { id: item.id }
  const text = (name, limit = 500) => { if (typeof item[name] === 'string') value[name] = item[name].slice(0, limit) }
  const ref = (name) => { if (typeof item[name] === 'string' && ID.test(item[name])) value[name] = item[name] }
  const bool = (name) => { if (typeof item[name] === 'boolean') value[name] = item[name] }
  if (kind === 'profiles') text('name', 80)
  else if (kind === 'spaces') { text('name', 80); if (/^#[\da-f]{6}$/i.test(item.color)) value.color = item.color; ref('profileId') }
  else if (kind === 'folders') { text('name', 80); ref('spaceId'); ref('parentId'); bool('collapsed') }
  else if (kind === 'tabs') {
    const url = portableURL(item.url)
    if (!url) return null
    value.url = url
    text('title'); ref('spaceId'); ref('profileId'); ref('folderId'); ref('parentId')
    bool('favorite'); bool('pinned'); bool('trailCollapsed'); bool('archived')
    if (item.archived && Number.isSafeInteger(item.archivedAt) && item.archivedAt >= 0) value.archivedAt = item.archivedAt
  } else if (kind === 'preferences') {
    const rule = PREFS[item.id]
    if (rule === 'boolean' ? typeof item.value !== 'boolean' : !Array.isArray(rule) || !Number.isFinite(item.value) || item.value < rule[0] || item.value > rule[1]) return null
    value.value = item.value
  } else return null
  return value
}

function project(s, partitions) {
  const result = {}
  const add = (kind, item) => { const value = pick(kind, item); if (value) result[recordKey(kind, value.id)] = value }
  const spaces = (s.spaces || []).filter((space) => !space.incognito)
  const spaceIds = new Set(spaces.map((space) => space.id))
  const profiles = (s.profiles || []).filter((profile) => /^persist:/.test(profile.partition))
  const byPartition = new Map(profiles.map((profile) => [profile.partition, profile.id]))
  for (const profile of profiles) { partitions[profile.id] = profile.partition; add('profiles', profile) }
  // Imported profiles may predate the profile catalog. Give each a portable ID without revealing its local partition.
  const profileFor = (partition) => {
    if (!partition || !partition.startsWith('persist:')) return undefined
    let id = byPartition.get(partition) || Object.keys(partitions).find((id) => partitions[id] === partition)
    if (!id) { id = `p${crypto.randomBytes(12).toString('hex')}`; partitions[id] = partition }
    byPartition.set(partition, id)
    if (!result[recordKey('profiles', id)]) add('profiles', { id, name: 'Browser profile' })
    return id
  }
  for (const space of spaces) add('spaces', { ...space, profileId: profileFor(space.sessionPartition || 'persist:main') })
  for (const folder of s.folders || []) if (spaceIds.has(folder.spaceId)) add('folders', folder)
  const privateSpaces = new Set((s.spaces || []).filter((space) => space.incognito).map((space) => space.id))
  for (const [items, archived] of [[s.tabs || [], false], [s.archive || [], true]]) for (const tab of items) {
    if ((!archived && !spaceIds.has(tab.spaceId)) || privateSpaces.has(tab.spaceId) || tab.agent || tab.incognito || tab.private || tab.userPeek || tab.chat || (tab.sessionPartition && !tab.sessionPartition.startsWith('persist:'))) continue
    add('tabs', { ...tab, archived, profileId: profileFor(tab.sessionPartition || 'persist:main') })
  }
  for (const name of Object.keys(PREFS)) if (s.settings?.[name] !== undefined) add('preferences', { id: name, value: s.settings[name] })
  return result
}

function validateRecords(payload) {
  if (!plain(payload) || payload.version !== VERSION || !plain(payload.records) || Object.keys(payload.records).length > MAX_RECORDS) throw fail('Unsupported sync records')
  const records = {}
  for (const [key, record] of Object.entries(payload.records)) {
    const [kind, id, extra] = key.split('/')
    if (extra || !ID.test(id) || !['profiles', 'spaces', 'folders', 'tabs', 'preferences'].includes(kind) || !plain(record) || !Number.isSafeInteger(record.clock) || record.clock < 1 || !DEVICE.test(record.device) || typeof record.deleted !== 'boolean') throw fail('Invalid sync record')
    let value = null
    if (!record.deleted) {
      value = pick(kind, record.value)
      if (!value || value.id !== id || stable(value) !== stable(record.value)) throw fail('Non-portable sync record rejected')
    }
    records[key] = { clock: record.clock, device: record.device, deleted: record.deleted, value }
  }
  return records
}

function merge(target, incoming, conflicts) {
  for (const [key, next] of Object.entries(incoming)) {
    const current = target[key]
    if (!current) { target[key] = next; continue }
    const different = stable(current.value || {}) !== stable(next.value || {}) || current.deleted !== next.deleted
    if (current.clock === next.clock && current.device === next.device && different) throw fail('Conflicting versions from one sync device')
    // IDs are never resurrected: a concurrent/offline edit cannot undo a deletion.
    const wins = current.deleted !== next.deleted ? next.deleted : next.clock > current.clock || (next.clock === current.clock && next.device > current.device)
    if (different && current.device !== next.device) conflicts.push({ record: key, winner: wins ? next.device : current.device, deleted: current.deleted || next.deleted })
    if (wins) target[key] = next
  }
}

function observe(journal, s, device) {
  const current = project(s, journal.partitions)
  for (const key of new Set([...Object.keys(current), ...Object.keys(journal.baseline)])) {
    const value = current[key]
    if (stable(value || {}) === stable(journal.baseline[key] || {})) continue
    // Permanent deletion wins over stale live or archived copies; ordinary restore is an update.
    if (journal.records[key]?.deleted) continue
    if (!Number.isSafeInteger(journal.counter + 1)) throw fail('Sync version counter exceeds the supported range')
    journal.records[key] = { clock: ++journal.counter, device, deleted: !value, value: value || null }
  }
  journal.baseline = current
}

function apply(journal, s) {
  const live = (kind) => Object.entries(journal.records).filter(([key, r]) => key.startsWith(`${kind}/`) && !r.deleted).map(([, r]) => r.value)
  const tombstoned = (kind, id) => journal.records[recordKey(kind, id)]?.deleted
  const privateSpaces = new Set((s.spaces || []).filter((space) => space.incognito).map((space) => space.id))
  const localOnly = (kind, item) => item && (item.incognito || item.private || item.agent || item.userPeek || item.chat || privateSpaces.has(item.spaceId) || (kind === 'tabs' && (!portableURL(item.url) || (item.sessionPartition && !item.sessionPartition.startsWith('persist:')))))
  const partitionFor = (id) => {
    const reference = id || 'unassigned'
    return journal.partitions[reference] ||= `persist:sync-${crypto.randomBytes(12).toString('hex')}`
  }
  const upsert = (kind, prepare) => {
    s[kind] ||= []
    for (let i = s[kind].length - 1; i >= 0; i--) {
      const item = s[kind][i]
      if (tombstoned(kind, item.id) && !localOnly(kind, item)) s[kind].splice(i, 1)
    }
    for (const value of live(kind)) {
      const existing = s[kind].find((item) => item.id === value.id)
      if (localOnly(kind, existing)) continue
      const next = prepare(value, existing)
      if (!next) continue
      if (existing) {
        for (const key of Object.keys(pick(kind, existing) || {})) if (!(key in next) && key !== 'id') delete existing[key]
        Object.assign(existing, next)
      } else s[kind].push(next)
    }
  }
  upsert('profiles', (value, existing) => {
    const partition = existing?.partition || partitionFor(value.id)
    journal.partitions[value.id] = partition
    return { ...value, partition }
  })
  upsert('spaces', (value, existing) => ({ ...value, sessionPartition: value.profileId ? partitionFor(value.profileId) : existing?.sessionPartition || partitionFor(value.id) }))
  const spaceExists = (id) => s.spaces.some((space) => space.id === id && !space.incognito)
  upsert('folders', (value) => spaceExists(value.spaceId) ? { ...value, parentId: value.parentId || null, collapsed: value.collapsed || false } : null)
  s.tabs ||= []
  s.archive ||= []
  for (const [key, record] of Object.entries(journal.records)) {
    if (!key.startsWith('tabs/')) continue
    const id = key.slice(5)
    const opened = s.tabs.find((item) => item.id === id)
    const archived = s.archive.find((item) => item.id === id)
    if (localOnly('tabs', opened) || localOnly('tabs', archived)) continue
    const existing = opened || archived
    if (record.deleted) {
      for (const items of [s.tabs, s.archive]) {
        const index = items.findIndex((item) => item.id === id)
        if (index !== -1) items.splice(index, 1)
      }
      continue
    }
    const { archived: isArchived, archivedAt, ...value } = record.value
    // Missing-space tabs stay recoverable in the archive; restore chooses a normal fallback.
    const destination = isArchived || !spaceExists(value.spaceId) ? s.archive : s.tabs
    const source = destination === s.archive ? s.tabs : s.archive
    const index = source.findIndex((item) => item.id === id)
    if (index !== -1) source.splice(index, 1)
    const next = {
      favicon: existing?.favicon || '', ...value,
      sessionPartition: existing?.sessionPartition || partitionFor(value.profileId),
      ...(existing?.browserIdentity !== undefined && { browserIdentity: existing.browserIdentity }),
      ...(existing?.arcSourceId !== undefined && { arcSourceId: existing.arcSourceId }),
      ...(existing?.arcSourceKind !== undefined && { arcSourceKind: existing.arcSourceKind }),
      ...(destination === s.archive ? { archivedAt: archivedAt ?? archived?.archivedAt ?? Date.now() } : { createdAt: opened?.createdAt ?? Date.now(), lastActiveAt: opened?.lastActiveAt ?? Date.now(), favorite: value.favorite ?? false })
    }
    const current = destination.find((item) => item.id === id)
    if (current) {
      if (current.folderId && !next.folderId) delete current.folder
      for (const field of Object.keys(pick('tabs', current) || {})) if (!(field in next) && field !== 'id') delete current[field]
      Object.assign(current, next)
    } else destination.push(next)
  }
  s.archive.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let i = s.folders.length - 1; i >= 0; i--) {
    const item = s.folders[i]
    if (tombstoned('spaces', item.spaceId) && !localOnly('folders', item)) s.folders.splice(i, 1)
  }
  // Repair cross-record references after independent concurrent moves/deletes.
  for (const kind of ['folders', 'tabs']) for (const item of [...(s[kind] || [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (localOnly(kind, item)) continue
    if (item.folderId && !s.folders.some((f) => f.id === item.folderId && f.spaceId === item.spaceId)) { delete item.folderId; delete item.folder }
    const seen = new Set([item.id])
    let parentId = item.parentId
    while (parentId) {
      const parent = s[kind].find((p) => p.id === parentId && p.spaceId === item.spaceId)
      if (!parent || seen.has(parentId)) { delete item.parentId; break }
      seen.add(parentId); parentId = parent.parentId
    }
  }
  refreshFolderLabels(s)
  s.settings ||= {}
  for (const value of live('preferences')) s.settings[value.id] = value.value
  // Keep a usable normal space even if two devices concurrently delete different last spaces.
  if (!s.spaces.some((space) => !space.incognito)) {
    const id = `s${crypto.createHash('sha256').update(Object.keys(journal.records).sort().join('\n')).digest('hex').slice(0, 16)}`
    s.spaces.push({ id, name: 'Home', color: '#4f6bed' })
  }
  if (!s.spaces.some((space) => space.id === s.activeSpaceId)) s.activeSpaceId = s.spaces.find((space) => !space.incognito).id
  s.activeTabBySpace ||= {}
  for (const [spaceId, id] of Object.entries(s.activeTabBySpace)) if (!s.tabs.some((tab) => tab.id === id && tab.spaceId === spaceId)) delete s.activeTabBySpace[spaceId]
  for (const [spaceId, split] of Object.entries(s.splitBySpace || {})) if (!split.ids.every((id) => s.tabs.some((tab) => tab.id === id && tab.spaceId === spaceId))) delete s.splitBySpace[spaceId]
}

function endpointURL(endpoint) {
  let url
  try { url = new URL(endpoint) } catch { throw fail('A valid WebDAV endpoint is required') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw fail('WebDAV requires HTTPS (HTTP is allowed only on loopback)')
  if (url.username || url.password || url.search || url.hash) throw fail('Put WebDAV credentials in the credential fields, not the endpoint URL')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return new URL('skiff-sync-v1.json', url)
}

function request(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers, signal }, (res) => {
      res.once('close', () => clearTimeout(deadline))
      const chunks = []; let size = 0
      res.on('data', (chunk) => { size += chunk.length; if (size > MAX_BYTES) res.destroy(fail('Sync response exceeds the size limit')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag, body: Buffer.concat(chunks).toString('utf8') }))
    })
    const deadline = setTimeout(() => req.destroy(fail('Sync request timed out')), 15000)
    req.once('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end(body)
  })
}

function createSync({ dir, state, changed = () => {}, safeStorage, emit = () => {} }) {
  const root = path.join(dir, 'sync')
  const configFile = path.join(root, 'config.json')
  const journalFile = path.join(root, 'journal.enc.json')
  let config = { version: VERSION, enabled: false, device: crypto.randomBytes(16).toString('hex') }
  let key = null, credentials = null, journal = emptyJournal(), busy = false, controller = null, error = null, lastSync = null, started = false
  const s = () => typeof state === 'function' ? state() : state
  const protectedStorage = () => {
    try { return safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text' } catch { return false }
  }
  const persistConfig = () => atomic(configFile, config)
  const snapshot = () => ({ enabled: config.enabled, transport: config.transport || null, endpoint: config.endpoint || null, directory: config.directory || null, locked: !key, keyId: config.keyId || null, busy, lastSync, error, requiresUnlock: !config.sealedKey, credentialsRequired: !!config.hasCredentials && !credentials, conflicts: journal.conflicts.slice(-50) })
  const notify = () => emit('sync-changed', snapshot())
  const available = () => { if (!started) throw fail('Sync has not started'); if (busy) throw fail('Sync is already running') }
  const persistJournal = (value = journal) => { if (key) atomic(journalFile, seal(value, key, 'journal', config.device)) }
  const loadJournal = (candidate) => {
    if (!fs.existsSync(journalFile)) return emptyJournal()
    const loaded = unseal(readJSON(journalFile), candidate, 'journal', config.device)
    loaded.records = validateRecords(loaded)
    if (!Number.isSafeInteger(loaded.counter) || !plain(loaded.baseline) || !plain(loaded.partitions) || !Array.isArray(loaded.conflicts)) throw fail('Invalid local sync journal')
    return loaded
  }
  const storeSecrets = () => {
    delete config.sealedKey; delete config.sealedCredentials
    if (protectedStorage()) {
      if (key) config.sealedKey = safeStorage.encryptString(key.toString('base64url')).toString('base64')
      if (credentials) config.sealedCredentials = safeStorage.encryptString(JSON.stringify(credentials)).toString('base64')
    }
  }
  function start() {
    if (started) return snapshot()
    if (fs.existsSync(configFile)) {
      const saved = readJSON(configFile)
      if (saved.version !== VERSION || !DEVICE.test(saved.device)) throw fail('Unsupported sync configuration')
      config = saved
    }
    started = true
    if (config.sealedKey && protectedStorage()) {
      try {
        const candidate = Buffer.from(safeStorage.decryptString(Buffer.from(config.sealedKey, 'base64')), 'base64url')
        if (candidate.length !== 32 || keyId(candidate) !== config.keyId) throw Error()
        journal = loadJournal(candidate); key = candidate
        if (config.sealedCredentials) {
          const restored = JSON.parse(safeStorage.decryptString(Buffer.from(config.sealedCredentials, 'base64')))
          if (config.transport === 'webdav' && restored.origin === endpointURL(config.endpoint).origin) credentials = restored
        }
      } catch { key = null; error = 'Unlock sync with your pairing key' }
    }
    return snapshot()
  }
  function configure(params) {
    available()
    const next = { ...config }
    if (params.transport === 'folder') {
      if (typeof params.directory !== 'string' || !path.isAbsolute(params.directory)) throw fail('An absolute shared directory is required')
      const directory = path.resolve(params.directory)
      if (directory === path.resolve(root)) throw fail('The shared folder must not be the local sync configuration directory')
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      next.directory = directory; delete next.endpoint
    } else if (params.transport === 'webdav') {
      endpointURL(params.endpoint)
      next.endpoint = params.endpoint; delete next.directory
    } else throw fail('Choose folder or webdav transport')
    if (config.transport !== 'webdav' || params.transport !== 'webdav' || endpointURL(config.endpoint).origin !== endpointURL(next.endpoint).origin) {
      credentials = null
      next.hasCredentials = false
      delete next.sealedCredentials
    }
    next.transport = params.transport; next.enabled = true
    config = next
    if (config.transport === 'webdav' && (params.username !== undefined || params.password !== undefined)) setCredentials(params)
    storeSecrets(); persistConfig(); error = null; notify()
    return snapshot()
  }
  function setCredentials(params) {
    if (config.transport !== 'webdav') throw fail('Configure WebDAV before supplying credentials')
    if (typeof (params.username ?? '') !== 'string' || typeof (params.password ?? '') !== 'string' || /[\r\n:]/.test(params.username || '') || (params.username || '').length > 2000 || (params.password || '').length > 8000) throw fail('Invalid WebDAV credentials')
    credentials = { origin: endpointURL(config.endpoint).origin, username: params.username || '', password: params.password || '' }
    config.hasCredentials = !!(credentials.username || credentials.password)
  }
  function importKey({ key: value }) {
    available()
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw fail('Pairing key must be a 32-byte base64url key')
    const candidate = Buffer.from(value, 'base64url')
    if (candidate.length !== 32 || candidate.toString('base64url') !== value) throw fail('Invalid pairing key')
    if (config.keyId && config.keyId !== keyId(candidate) && fs.existsSync(journalFile)) throw fail('Pairing key does not match this sync configuration')
    const loaded = loadJournal(candidate)
    if (key) key.fill(0)
    key = candidate; journal = loaded; config.keyId = keyId(key)
    storeSecrets(); persistConfig(); error = null; notify()
    return snapshot()
  }
  function createKey() {
    available()
    if (config.keyId) throw fail('A pairing key already exists; unlock or export it instead')
    return importKey({ key: crypto.randomBytes(32).toString('base64url') })
  }
  function exportKey() {
    available()
    if (!key) throw fail('Unlock sync before exporting its pairing key')
    return { key: key.toString('base64url') }
  }
  function unlock(params = {}) {
    available()
    if (params.key !== undefined) importKey(params)
    if (params.username !== undefined || params.password !== undefined) { setCredentials(params); storeSecrets(); persistConfig() }
    if (!key) throw fail('A pairing key is required to unlock sync')
    notify(); return snapshot()
  }
  function disable() {
    if (!started) start()
    controller?.abort()
    config.enabled = false; persistConfig(); notify()
    return snapshot()
  }
  async function now() {
    available()
    if (!config.enabled || !config.transport) throw fail('Configure and enable sync first')
    if (!key) throw fail('Unlock sync first')
    if (config.hasCredentials && (!credentials || config.transport !== 'webdav' || credentials.origin !== endpointURL(config.endpoint).origin)) throw fail('Unlock WebDAV credentials first')
    busy = true; error = null; controller = new AbortController(); notify()
    const signal = controller.signal
    try {
      const pending = clone(journal)
      observe(pending, s(), config.device)
      const working = clone(pending)
      // Reserve locally observed versions durably before publishing. An accepted PUT
      // can lose its response; reusing its clock for a later edit would fork this device.
      const checkpoint = () => {
        pending.counter = Math.max(pending.counter, working.counter)
        if (JSON.stringify(pending) !== JSON.stringify(journal)) {
          persistJournal(pending)
          journal = clone(pending)
        }
      }
      const conflicts = []
      const absorb = (envelope, device) => {
        const incoming = validateRecords(unseal(envelope, key, 'records', device))
        merge(working.records, incoming, conflicts)
        for (const record of Object.values(incoming)) working.counter = Math.max(working.counter, record.clock)
        if (Object.keys(working.records).length > MAX_RECORDS) throw fail('Sync record count exceeds the limit')
      }
      if (config.transport === 'folder') {
        for (const file of fs.readdirSync(config.directory).sort()) {
          if (!/^[a-f0-9]{32}\.skiff-sync$/.test(file)) continue
          const target = path.join(config.directory, file)
          if (!fs.lstatSync(target).isFile()) throw fail('Sync records must be regular files')
          absorb(readJSON(target), file.slice(0, 32))
        }
        if (signal.aborted) throw fail('Sync cancelled')
        checkpoint()
        atomic(path.join(config.directory, `${config.device}.skiff-sync`), seal({ version: VERSION, records: working.records }, key, 'records', config.device))
      } else {
        const url = endpointURL(config.endpoint)
        const auth = credentials && config.hasCredentials ? { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` } : {}
        let written = false
        for (let attempt = 0; attempt < 4; attempt++) {
          const response = await request(url, 'GET', auth, undefined, signal)
          if (response.status !== 200 && response.status !== 404) throw fail(`WebDAV read failed (${response.status})`)
          if (response.status === 200) {
            if (!response.etag || response.etag.startsWith('W/')) throw fail('WebDAV must support strong ETags for safe concurrent writes')
            absorb(JSON.parse(response.body))
          }
          checkpoint()
          const body = JSON.stringify(seal({ version: VERSION, records: working.records }, key, 'records', config.device))
          const put = await request(url, 'PUT', { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(response.status === 404 ? { 'If-None-Match': '*' } : { 'If-Match': response.etag }) }, body, signal)
          if ([409, 412].includes(put.status)) continue
          if (![200, 201, 204].includes(put.status)) throw fail(`WebDAV write failed (${put.status})`)
          written = true; break
        }
        if (!written) throw fail('WebDAV changed repeatedly; retry manual sync')
      }
      if (signal.aborted || !config.enabled) throw fail('Sync cancelled')
      // Edits made while WebDAV was in flight win locally and are journaled for the next push.
      observe(working, s(), config.device)
      working.conflicts = [...working.conflicts, ...conflicts].slice(-100)
      // Build on a copy before committing: authentication/network/validation errors never partially mutate the browser.
      const next = clone(s())
      apply(working, next)
      working.baseline = project(next, working.partitions)
      persistJournal(working)
      apply(working, s())
      journal = working; lastSync = new Date().toISOString()
      try { changed() } catch { throw fail('Sync was applied, but the browser refresh failed') }
      return { ...snapshot(), busy: false }
    } catch (failure) {
      error = failure.code === 'sync_error' ? failure.message : 'Sync failed; local browser data was not changed'
      throw fail(error)
    } finally { busy = false; controller = null; notify() }
  }
  function stop() {
    controller?.abort()
    if (key) key.fill(0)
    key = null; credentials = null; started = false
  }
  function register(registry) {
    const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
    const string = { type: 'string' }
    const definitions = [
      ['sync.status', 'Show encrypted sync status', schema(), snapshot],
      ['sync.configure', 'Opt in to encrypted folder or WebDAV sync', schema({ transport: { enum: ['folder', 'webdav'] }, directory: string, endpoint: string, username: string, password: string }, ['transport']), configure],
      ['sync.key.create', 'Create a new high-entropy pairing key', schema(), createKey],
      ['sync.key.import', 'Pair using an existing encryption key', schema({ key: string }, ['key']), importKey],
      ['sync.key.export', 'Reveal the pairing key for deliberate device pairing', schema(), exportKey],
      ['sync.unlock', 'Unlock encrypted sync for this run', schema({ key: string, username: string, password: string }), unlock],
      ['sync.now', 'Synchronize portable browser records now', schema(), now],
      ['sync.disable', 'Disable sync without deleting browser data', schema(), disable]
    ]
    const disposers = definitions.map(([name, description, inputSchema, run]) => registry.register('stock.sync', { name, description, inputSchema, tool: false, run }))
    return () => { for (const dispose of disposers) dispose() }
  }
  return { start, stop, snapshot, register, configure, createKey, importKey, exportKey, unlock, now, disable }
}

module.exports = { createSync }

'use strict'
// An Agent Client Protocol agent for tests: `node e2e/fake-agent.js`; FAKE_AUTH=1 makes session/new require authenticate. Sessions are saved to fake-sessions.json in the cwd, so session/load works in a new process.
const fs = require('node:fs')
const http = require('node:http')
const crypto = require('node:crypto')
const { connect } = require('../src/acp')

const FILE = 'fake-sessions.json'
const MODELS = [{ value: 'fake-small', name: 'Fake Small' }, { value: 'fake-large', name: 'Fake Large' }]
const EFFORTS = [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }]
const sessions = new Map()
let authed = process.env.FAKE_AUTH !== '1'
let count = 0

const fail = (code, message) => Object.assign(new Error(message), { code })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const send = (sessionId, update) => rpc.notify('session/update', { sessionId, update })
const say = (sessionId, text) => send(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const configOptions = (session) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model, options: MODELS },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: session.effort, options: EFFORTS }
]
const saved = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {})

function save(sessionId) {
  const { model, effort, turns } = sessions.get(sessionId)
  fs.writeFileSync(FILE, JSON.stringify({ ...saved(), [sessionId]: { model, effort, turns } }))
}

function track(sessionId, params, stored) {
  const session = { mcpServers: Array.isArray(params?.mcpServers) ? params.mcpServers : [], cancelled: false, model: 'fake-small', effort: 'low', turns: [], ...stored }
  sessions.set(sessionId, session)
  return session
}

function mcp(server, message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])) }
  return new Promise((resolve, reject) => {
    const req = http.request(server.url, { method: 'POST', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks)))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function openTab(sessionId, session, url) {
  const toolCallId = `open-${++count}`
  const title = `Open ${url}`
  send(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind: 'fetch', status: 'pending' })
  const options = [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
  const answer = await rpc.request('session/request_permission', { sessionId, toolCall: { toolCallId, title }, options }).catch(() => null)
  if (answer?.outcome?.outcome !== 'selected' || answer.outcome.optionId !== 'allow') return send(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'cancelled' })
  let status = 'failed'
  let text = 'No MCP server named skiff'
  const server = session.mcpServers.find((s) => s.name === 'skiff')
  if (server) {
    try {
      await mcp(server, { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } } })
      const res = await mcp(server, { id: 2, method: 'tools/call', params: { name: 'browser_open_tab', arguments: { url } } })
      text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error)
      if (res.result && !res.result.isError) status = 'completed'
    } catch (e) {
      text = e.message
    }
  }
  send(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text } }] })
}

async function customizeFixture(sessionId, session, params) {
  const server = session.mcpServers.find((item) => item.name === 'skiff')
  if (!server) throw new Error('Customization fixture requires an explicitly selected MCP grant')
  const invoke = async (name, args, denied = false) => {
    const toolCallId = `customize-${++count}`
    send(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'edit', status: 'pending' })
    const response = await mcp(server, { id: count, method: 'tools/call', params: { name, arguments: args } })
    const failed = Boolean(response.error || response.result?.isError)
    const text = response.result?.content?.[0]?.text || JSON.stringify(response.error)
    send(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: failed ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text } }] })
    if (denied) {
      if (!failed) throw new Error(`Unexpected authority: ${name}`)
      return true
    }
    if (failed) throw new Error(`${name}: ${text}`)
    return JSON.parse(text)
  }
  const inspected = await invoke('components.inspect', { id: params.id })
  const file = inspected.manifest.surfaces.launcher
  const original = await invoke('components.source.read', { id: params.id, file })
  const copy = await invoke('components.create', { id: params.copyId, from: params.id, role: 'launcher' })
  const firstSource = original.content + '<p>ACP fixture revision one</p>'
  await invoke('components.source.write', { id: copy.id, file, content: firstSource })
  const checked = await invoke('components.check', { id: copy.id })
  if (!checked.ok) throw new Error('The edited component failed its real component check')
  const preview = await invoke('components.preview', { id: copy.id })
  const first = await invoke('components.apply', { id: copy.id })
  await invoke('components.bind', { id: copy.id, role: 'launcher' })
  await invoke('components.source.write', { id: copy.id, file, content: original.content + '<p>ACP fixture revision two</p>' })
  const second = await invoke('components.apply', { id: copy.id })
  const reverted = await invoke('components.revert', { id: copy.id })
  const deniedSource = await invoke('components.source.read', { id: 'stock.chat', file: 'chat.html' }, true)
  const deniedBrowser = await invoke('browser_read_page', {}, true)
  return { copyId: copy.id, preview, first: first.revision, second: second.revision, reverted: reverted.revision, deniedSource, deniedBrowser }
}

async function prompt({ sessionId, prompt: blocks }) {
  const session = sessions.get(sessionId)
  if (!session) throw fail(-32602, `No session ${sessionId}`)
  const texts = (Array.isArray(blocks) ? blocks : []).filter((b) => b.type === 'text').map((b) => b.text)
  const text = texts.at(-1) || ''
  const context = texts.length > 1 ? texts[0] : null
  session.cancelled = false
  if (text.startsWith('customize-fixture ')) {
    const result = await customizeFixture(sessionId, session, JSON.parse(text.slice('customize-fixture '.length)))
    const reply = `CUSTOMIZE_RESULT ${JSON.stringify(result)}`
    say(sessionId, reply)
    session.turns.push({ user: texts, reply })
    save(sessionId)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('crash')) {
    process.stderr.write('Fake agent crashed\n')
    process.exit(3)
  }
  send(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking at this.' } })
  const open = text.match(/open (https?:\/\/\S+)/)
  if (open) await openTab(sessionId, session, open[1])
  if (session.cancelled) return { stopReason: 'cancelled' }
  if (text.includes('slow')) {
    for (let i = 0; i < 60; i++) {
      if (session.cancelled) return { stopReason: 'cancelled' }
      say(sessionId, '.')
      await sleep(100)
    }
  }
  let reply = `You said: ${text}`
  if (context) {
    const title = context.match(/^Title: (.*)$/m)?.[1] ?? ''
    const start = context.split(/^Page text \(first \d+ characters\):\n/m)[1]?.slice(0, 40) ?? ''
    reply += `\nPage title: ${title}\nPage text starts: ${start}`
  }
  if (text.includes('markdown')) reply += '\n\n## Three ways to say it\n- **Bold** for the point\n- *Italic* for a [linked aside](https://example.com/aside)\n- `code` in a line\n\n```js\nconst boat = { name: "skiff" }\n```\n'
  reply += `\nModel: ${session.model} Effort: ${session.effort}`
  say(sessionId, reply)
  session.turns.push({ user: texts, reply })
  save(sessionId)
  return { stopReason: 'end_turn' }
}

async function handle(method, params) {
  if (method === 'initialize') return { protocolVersion: 1, agentInfo: { name: 'Fake agent', version: '1' }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: process.env.FAKE_AUTH === '1' ? [{ id: 'fake', name: 'Fake sign in' }] : [] }
  if (method === 'authenticate') {
    authed = true
    return {}
  }
  if (method === 'session/new') {
    if (!authed) throw fail(-32000, 'Authentication required')
    const sessionId = `fake-session-${crypto.randomBytes(4).toString('hex')}`
    const session = track(sessionId, params)
    save(sessionId)
    return { sessionId, configOptions: configOptions(session) }
  }
  if (method === 'session/load') {
    const stored = saved()[params?.sessionId]
    if (!stored) throw fail(-32602, `No session ${params?.sessionId}`)
    const session = track(params.sessionId, params, stored)
    for (const turn of session.turns) {
      for (const text of turn.user) send(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
      say(params.sessionId, turn.reply)
    }
    return { configOptions: configOptions(session) }
  }
  if (method === 'session/set_config_option') {
    const session = sessions.get(params?.sessionId)
    if (!session) throw fail(-32602, `No session ${params?.sessionId}`)
    const values = { model: MODELS, effort: EFFORTS }[params.configId]
    if (!values?.some((o) => o.value === params.value)) throw fail(-32603, `Invalid value for ${params.configId}: ${params.value}`)
    session[params.configId] = params.value
    save(params.sessionId)
    return { configOptions: configOptions(session) }
  }
  if (method === 'session/prompt') return prompt(params)
  throw fail(-32601, `Method not found: ${method}`)
}

const rpc = connect({
  input: process.stdin,
  output: process.stdout,
  onNotification: (method, params) => {
    if (method === 'session/cancel' && sessions.has(params?.sessionId)) sessions.get(params.sessionId).cancelled = true
  },
  onRequest: (method, params, id) => handle(method, params).then((result) => rpc.respond(id, result), (e) => rpc.respond(id, e)),
  onClose: () => process.exit(0)
})

'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const S = require('./state')
const { connect } = require('./acp')
const log = require('./log').scope('ai')

const TURNS = 200
const LONG = 200000
const TOOL_TEXT = 4000
const PAGE_TEXT = 12000
const TOOL_STATUS = ['pending', 'in_progress', 'completed', 'failed', 'cancelled']
const UNRESTORED = 'This conversation could not be restored. New messages start a fresh session.'
const KINDS = { model: 'Model', effort: 'Effort' }

const bad = (message) => S.err('bad_params', message)
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const stopped = () => Object.assign(new Error('The agent stopped'), { closed: true })
const loginShell = () => (!process.env.SHELL || /(nologin|false)$/.test(process.env.SHELL) ? '/bin/sh' : process.env.SHELL)
const chatUrl = (id) => `skiff://chat/${id}`

function within(ms, promise, message) {
  let timer
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

const toolText = (content) => (Array.isArray(content) ? content : []).map((c) => {
  if (c?.type === 'diff') return `diff ${str(c.path, 1000)}`
  if (c?.type === 'terminal') return 'terminal'
  return c?.type === 'content' && c.content?.type === 'text' ? str(c.content.text, TOOL_TEXT) : ''
}).filter(Boolean).join('\n').slice(0, TOOL_TEXT)

const contextBlock = (page) => ['Page open in the browser', `Title: ${page.title}`, `URL: ${page.url}`, ...(page.selection ? ['Selected text:', page.selection] : []), `Page text (first ${PAGE_TEXT} characters):`, page.text].join('\n')

// The select option of one category in an ACP configOptions list, its grouped values flattened: {id, values, current} or null.
function option(list, category) {
  const o = (Array.isArray(list) ? list : []).find((x) => S.isObject(x) && x.category === category && Array.isArray(x.options))
  if (!o) return null
  const values = o.options.flatMap((x) => (Array.isArray(x?.options) ? x.options : [x])).filter(S.isObject).slice(0, 200).map((x) => ({ value: str(x.value, 200), name: str(x.name, 200) || str(x.value, 200) }))
  return { id: str(o.id, 200), values, current: str(o.currentValue, 200) || null }
}

// dir: the agents' working folder; state(): the live browser state, whose settings.ai lists the agents; changed(): tabs or settings were changed here;
// favicon: the icon of chat tabs; api({agent,sessionId,chatId,tabId}): scoped {port,token,revoke} or null; pageText(tabId): explicit page context;
// push(name, data): 'ai-agents' with the agents list, or 'chat' with one chat object (at most once per 30 ms per chat);
// watching(tabId): whether the user is looking at that tab right now, which decides if a finished turn leaves it unread.
function createAi({ dir, version, state, changed, favicon, api = () => null, revokeAccess = () => {}, pageText, pageGeneration = () => null, push, transcripts, watching = () => false }) {
  const agents = new Map()
  const chats = new Map()
  let halted = false
  const release = (c) => {
    const credential = c.credential
    c.credential = null
    credential?.revoke?.()
  }
  const journal = (c, force = false) => {
    if (!transcripts || c.replay || c.restorePending || (!force && c.status === 'running' && Date.now() - (c.journalAt || 0) < 500)) return
    try { transcripts.record(shape(c)); c.journalAt = Date.now(); c.transcriptError = '' } catch (e) { c.transcriptError = e.message }
  }

  const configured = () => state().settings.ai.agents
  function agentOf(name) {
    const conf = configured().find((a) => a.name === name)
    if (!conf) return null
    if (!agents.has(name)) agents.set(name, { name, command: conf.command, status: 'idle', error: '', info: null, models: null, model: null, efforts: null, effort: null, loadSession: false, proc: null, ready: null, spare: null })
    return agents.get(name)
  }
  const currentAgent = (agent) => Boolean(agent && agents.get(agent.name) === agent && configured().some((entry) => entry.name === agent.name && entry.command === agent.command))
  const entry = (a) => ({ name: a.name, command: a.command, status: a.status, error: a.error, info: a.info, models: a.models, model: a.model, efforts: a.efforts, effort: a.effort, loadSession: a.loadSession })
  const list = () => configured().map((a) => entry(agentOf(a.name)))
  const pushAgents = () => push('ai-agents', list())

  const shape = (c) => ({ id: c.id, tabId: c.tabId, agent: c.agent, status: c.status, error: c.error, pending: c.pending, sessionId: c.sessionId, models: c.models, model: c.model, efforts: c.efforts, effort: c.effort, permission: c.permission, turns: c.turns, ...(c.recovery && { recovery: c.recovery }), ...(c.transcriptError && { transcriptError: c.transcriptError }) })
  // A chat waiting for a permission answer is not busy: it needs the user, not time.
  const track = (c) => {
    const busy = (c.status === 'running' || c.status === 'restoring') && !c.permission
    if (busy === Boolean(c.busy)) return
    c.busy = busy
    if (S.chatState(state(), c.tabId, busy, watching(c.tabId))) changed()
  }
  const touch = (c) => {
    if (halted) return
    track(c)
    c.timer ??= setTimeout(() => {
      c.timer = null
      journal(c)
      push('chat', shape(c))
    }, 30)
  }
  function newChat(id, tabId, agent, sessionId) {
    const c = { id, tabId, agent, status: 'ready', error: '', pending: '', sessionId, models: null, model: null, efforts: null, effort: null, permission: null, turns: [], count: 0, timer: null, proc: null, asker: null, config: {}, replay: null, stopping: false, want: {}, credential: null, scopeTabId: null, recovery: null }
    chats.set(id, c)
    return c
  }
  const add = (c, item, before) => {
    const turn = { id: `t${++c.count}`, ...item }
    const at = before ? c.turns.indexOf(before) : -1
    if (at < 0) c.turns.push(turn)
    else c.turns.splice(at, 0, turn)
    if (c.turns.length > TURNS) c.turns.splice(0, c.turns.length - TURNS)
    return turn
  }
  const finish = (reply, stopReason) => Object.assign(reply, { done: true, stopReason })
  const toolTurn = (c, toolCallId) => c.turns.findLast((t) => t.kind === 'tool' && t.toolCallId === toolCallId)
  const openOf = (c) => c.turns.findLast((t) => t.kind === 'assistant' && !t.done)
  // Text that streams after a tool call belongs below that tool row: a reply with text is closed and a new one opens at the end; an empty one moves down.
  function liveReply(c) {
    const open = openOf(c)
    if (!open || c.turns.at(-1) === open) return open
    if (open.text || open.thought) {
      finish(open, 'end_turn')
      return add(c, { kind: 'assistant', text: '', thought: '', done: false })
    }
    c.turns.splice(c.turns.indexOf(open), 1)
    c.turns.push(open)
    return open
  }
  // A replayed history has no open reply, so each agent message joins the last reply after the last user message, or starts one.
  function openReply(c) {
    if (!c.replay) return liveReply(c)
    const since = c.turns.slice(c.turns.findLastIndex((t) => t.kind === 'user') + 1)
    return since.findLast((t) => t.kind === 'assistant') || add(c, { kind: 'assistant', text: '', thought: '', done: true, stopReason: 'end_turn' })
  }
  // The tab or archive entry of a chat holds its agent and session id across restarts.
  function saveTab(c, fields) {
    const tab = [...state().tabs, ...state().archive].find((t) => t.chat && t.url === chatUrl(c.id))
    if (!tab) return
    Object.assign(tab.chat, fields)
    changed()
  }

  // A closed connection waits for the exit (2 s at most), so down() has ended the chats and named the error before the caller sees it.
  async function rpc(agent, p, method, params) {
    if (!currentAgent(agent) || agent.proc !== p) throw stopped()
    const result = await p.rpc.request(method, params, { timeout: method === 'session/prompt' ? 0 : 30000 }).catch(async (e) => {
      if (e.closed) await within(2000, p.exited, '').catch(() => {})
      throw e
    })
    if (!currentAgent(agent) || agent.proc !== p) throw stopped()
    return result
  }

  // Ends the agent's process. With a message, every chat running on it or holding a session in it ends in that error and keeps its session id for session/load.
  function down(agent, p, message) {
    if (agent.proc !== p) return
    log.info('agent down', { agent: agent.name, pid: p.child.pid, reason: message ? message.split('\n')[0].slice(0, 200) : 'stopped' })
    for (const c of chats.values()) if (c.agent === agent.name) release(c)
    Object.assign(agent, { proc: null, ready: null, spare: null, status: message ? 'error' : 'idle', error: message })
    p.rpc.close()
    // The shell may run the agent as a child (npx, ssh), so its whole process group goes.
    try {
      process.kill(-p.child.pid)
    } catch {
      p.child.kill()
    }
    for (const c of message ? chats.values() : []) {
      if (c.agent !== agent.name || (c.proc !== p && c.status !== 'running' && c.status !== 'restoring')) continue
      const reply = openOf(c)
      if (reply) finish(reply, 'error')
      Object.assign(c, { proc: null, status: 'error', error: message, permission: null })
      add(c, { kind: 'notice', text: message.split('\n')[0] })
      touch(c)
    }
    pushAgents()
  }

  function launch(agent) {
    fs.mkdirSync(dir, { recursive: true })
    const child = spawn(loginShell(), ['-lc', agent.command], { cwd: dir, stdio: 'pipe', detached: true })
    const started = Date.now()
    log.info('agent spawn', { agent: agent.name, command: agent.command.trim().split(/\s+/).find((word) => !word.includes('='))?.split('/').pop(), cwd: dir, pid: child.pid })
    const p = { child, sessions: new Map(), http: false, auth: [] }
    let tail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data) => {
      tail = (tail + data).slice(-2000)
      for (const line of data.split('\n')) if (line.trim()) log.debug('agent stderr', { agent: agent.name, pid: child.pid, line: line.slice(0, 500) })
    })
    child.on('error', (e) => { log.error('agent process error', { agent: agent.name, pid: child.pid, err: e.stack }); down(agent, p, `Agent could not start: ${e.message}`) })
    child.on('close', (code, signal) => { log.info('agent exit', { agent: agent.name, pid: child.pid, code, signal, ms: Date.now() - started }); down(agent, p, `Agent exited with code ${code ?? signal}${tail.trim() && `\n${tail.trim()}`}`) })
    p.exited = new Promise((resolve) => {
      child.on('close', resolve)
      child.on('error', resolve)
    })
    p.rpc = connect({
      input: child.stdout,
      output: child.stdin,
      onNotification: (method, params) => {
        const c = method === 'session/update' && p.sessions.get(params?.sessionId)
        if (c) update(c, params.update)
      },
      onRequest: (method, params, id) => request(p, method, params, id),
      onClose: (error) => error && down(agent, p, error.message)
    })
    Object.assign(agent, { proc: p, status: 'starting', error: '' })
    pushAgents()
    agent.ready = (async () => {
      const init = await rpc(agent, p, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'skiff', version } })
      agent.info = S.isObject(init?.agentInfo) ? { name: str(init.agentInfo.name, 100), version: str(init.agentInfo.version, 50) } : null
      agent.loadSession = init?.agentCapabilities?.loadSession === true
      p.http = init?.agentCapabilities?.mcpCapabilities?.http === true
      p.auth = Array.isArray(init?.authMethods) ? init.authMethods : []
      log.info('agent ready', { agent: agent.name, pid: child.pid, name: agent.info?.name, version: agent.info?.version, loadSession: agent.loadSession, http: p.http, authMethods: p.auth.length, ms: Date.now() - started })
      agent.status = 'ready'
      pushAgents()
      return p
    })()
    agent.ready.catch((e) => { if (!e.closed) log.error('agent initialize failed', { agent: agent.name, err: e.stack }); return e.closed || down(agent, p, `The agent could not start: ${e.message}`) })
    return agent.ready
  }
  const start = (agent) => halted || !currentAgent(agent) ? Promise.reject(stopped()) : agent.ready || launch(agent)

  // Warm sessions have no credential. A real chat gets only its explicitly selected grant.
  async function open(agent, p, method, extra, c) {
    if (halted || c?.stopping || !currentAgent(agent) || agent.proc !== p) throw stopped()
    if (c) release(c)
    const local = c && p.http ? await api({ agent: agent.name, sessionId: extra.sessionId ?? c.sessionId ?? c.id, chatId: c.id, tabId: c.scopeTabId }) : null
    if (halted || c?.stopping || !currentAgent(agent) || agent.proc !== p) { local?.revoke?.(); throw stopped() }
    if (c) c.credential = local
    const mcpServers = local ? [{ type: 'http', name: 'skiff', url: `http://127.0.0.1:${local.port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${local.token}` }] }] : []
    const params = { ...extra, cwd: dir, mcpServers }
    try {
      const result = await rpc(agent, p, method, params).catch(async (e) => {
        if (e.code !== -32000 || !p.auth.length) throw e
        await rpc(agent, p, 'authenticate', { methodId: p.auth[0]?.id })
        return rpc(agent, p, method, params)
      })
      if (halted || c?.stopping) throw stopped()
      return result
    } catch (e) {
      if (c?.credential === local) release(c)
      throw e
    }
  }

  async function newSession(agent, p, c) {
    const created = await open(agent, p, 'session/new', {}, c)
    if (typeof created?.sessionId !== 'string') { if (c) release(c); throw new Error('session/new returned no sessionId') }
    log.info('session new', { agent: agent.name, chatId: c?.id, sessionId: created.sessionId })
    return { p, sessionId: created.sessionId, configOptions: created.configOptions }
  }

  // Reads the model and effort options; the agent shows those of its most recent session.
  function parse(agent, list) {
    const model = option(list, 'model')
    const effort = option(list, 'thought_level')
    const found = { models: model?.values ?? null, model: model?.current ?? null, efforts: effort?.values ?? null, effort: effort?.current ?? null }
    Object.assign(agent, found, { status: 'ready', error: '' })
    pushAgents()
    return { ...found, config: { model: model?.id, effort: effort?.id } }
  }

  // mode 'rebuild' turns the replayed history into turns; 'ignore' drops it because the chat already shows it.
  async function load(c, agent, p, mode) {
    log.info('session load', { agent: agent.name, chatId: c.id, sessionId: c.sessionId, mode })
    p.sessions.set(c.sessionId, c)
    c.replay = mode
    try {
      const result = await open(agent, p, 'session/load', { sessionId: c.sessionId }, c)
      Object.assign(c, parse(agent, result?.configOptions), { proc: p })
    } catch (e) {
      log.warn('session load failed', { agent: agent.name, chatId: c.id, sessionId: c.sessionId, err: e.message })
      p.sessions.delete(c.sessionId)
      throw e
    } finally {
      c.replay = null
    }
  }

  // Gives a chat a session in the agent's current process: its old one when the agent can load it, else the spare or a new one.
  async function attach(c, agent, p, before) {
    const lost = c.sessionId !== null
    if (lost && agent.loadSession) {
      try {
        return await load(c, agent, p, 'ignore')
      } catch (e) {
        if (e.closed) throw e
      }
    }
    const taken = agent.spare
    agent.spare = null
    const spare = await taken?.catch(() => null)
    const reusable = spare?.p === p && (!p.http || agent.loadSession)
    const { sessionId, configOptions } = reusable ? spare : await newSession(agent, p, c)
    Object.assign(c, parse(agent, configOptions), { sessionId, proc: p })
    if (reusable && p.http) await load(c, agent, p, 'ignore')
    p.sessions.set(sessionId, c)
    saveTab(c, { sessionId })
    if (lost) add(c, { kind: 'notice', text: 'Started a new session' }, before)
  }

  async function choose(c, agent, p, kind, value) {
    if (!c.config[kind] || !(kind === 'model' ? c.models : c.efforts)?.some((o) => o.value === value)) throw new Error(`${KINDS[kind]} ${value} is not available`)
    const result = await rpc(agent, p, 'session/set_config_option', { sessionId: c.sessionId, configId: c.config[kind], value })
    if (Array.isArray(result?.configOptions)) Object.assign(c, parse(agent, result.configOptions))
    else c[kind] = value
    touch(c)
  }

  const eligiblePage = (tab) => Boolean(tab && state().tabs.includes(tab) && !tab.chat && !tab.agent && !tab.userPeek && !String(tab.sessionPartition || '').startsWith('incognito-') && state().spaces.some((space) => space.id === tab.spaceId && !space.incognito))
  const currentPage = (page) => eligiblePage(page.tab) && page.tab.url === page.url && page.tab.spaceId === page.spaceId && page.tab.sessionPartition === page.partition && pageGeneration(page.tab.id) === page.generation
  async function readPage(tabId) {
    const tab = S.findTab(state(), tabId)
    if (!eligiblePage(tab)) return null
    const page = { tab, url: tab.url, spaceId: tab.spaceId, partition: tab.sessionPartition, generation: pageGeneration(tabId) }
    const raw = await within(2000, Promise.resolve().then(() => pageText(tabId)), 'The page did not answer').catch(() => null)
    if (!currentPage(page) || !S.isObject(raw)) return null
    page.content = { title: str(raw.title, 300), url: str(raw.url, 2000), selection: str(raw.selection, PAGE_TEXT), text: str(raw.text, PAGE_TEXT) }
    return page
  }

  async function run(c, user, reply, text, pageTab) {
    const agent = agentOf(c.agent)
    try {
      let page = pageTab ? await readPage(pageTab) : null
      const recheckPage = () => {
        if (page && !currentPage(page)) page = null
        if (!page) { c.scopeTabId = null; user.context = null }
      }
      if (!currentAgent(agent)) return
      if (c.stopping || halted) { finish(reply, 'cancelled'); c.status = 'ready'; return touch(c) }
      recheckPage()
      const p = await start(agent)
      recheckPage()
      if (c.proc !== p) await attach(c, agent, p, user)
      else if (agent.loadSession && p.http) await load(c, agent, p, 'ignore')
      recheckPage()
      for (const kind of ['model', 'effort']) {
        const value = c.want[kind]
        delete c.want[kind]
        if (value && value !== c[kind]) {
          await choose(c, agent, p, kind, value).catch((e) => {
            if (e.closed) throw e
            add(c, { kind: 'notice', text: `${KINDS[kind]} ${value} is not available` }, user)
          })
          recheckPage()
        }
      }
      if (c.stopping) {
        finish(reply, 'cancelled')
        c.status = 'ready'
        c.proc = null
        return touch(c)
      }
      if (!currentAgent(agent)) return
      recheckPage()
      if (page) user.context = { url: page.content.url, title: page.content.title }
      touch(c)
      const t = Date.now()
      log.info('session prompt', { agent: agent.name, chatId: c.id, sessionId: c.sessionId, length: text.length, page: Boolean(page) })
      const result = await rpc(agent, p, 'session/prompt', { sessionId: c.sessionId, prompt: [...(page ? [{ type: 'text', text: contextBlock(page.content) }] : []), { type: 'text', text }] })
      log.info('session prompt done', { chatId: c.id, stopReason: str(result?.stopReason, 50) || 'end_turn', ms: Date.now() - t })
      finish(openOf(c) || reply, str(result?.stopReason, 50) || 'end_turn')
      c.status = 'ready'
      if (c.stopping) c.proc = null
    } catch (e) {
      (e.closed ? log.warn : log.error)('session prompt failed', { agent: agent.name, chatId: c.id, err: e.stack })
      if (!currentAgent(agent)) return
      // A closed connection means the process went down, and down() ends the turn.
      const open = openOf(c)
      if (c.stopping) {
        if (open) finish(open, 'cancelled')
        Object.assign(c, { status: 'ready', proc: null })
        return touch(c)
      }
      if (!open || e.closed) return
      finish(open, 'error')
      if (c.proc) Object.assign(c, { status: 'ready', error: e.message })
      else {
        Object.assign(c, { status: 'error', error: `The agent could not start a session: ${e.message}` })
        add(c, { kind: 'notice', text: c.error.split('\n')[0] })
      }
    }
    touch(c)
  }

  function send(c, text, pageTab) {
    Object.assign(c, { status: 'running', error: '', pending: '', stopping: false })
    if (pageTab) c.scopeTabId = pageTab
    const user = add(c, { kind: 'user', text, context: null })
    const reply = add(c, { kind: 'assistant', text: '', thought: '', done: false })
    run(c, user, reply, text, pageTab)
    touch(c)
    return reply
  }

  function update(c, u) {
    if (!S.isObject(u) || c.replay === 'ignore' || c.stopping || halted) return
    const text = u.content?.type === 'text' ? str(u.content.text, LONG) : ''
    if (u.sessionUpdate === 'user_message_chunk') {
      if (c.replay !== 'rebuild') return
      const last = c.turns.at(-1)
      const user = last?.kind === 'user' ? last : add(c, { kind: 'user', text: '', context: null })
      const page = text.match(/^Page open in the browser\nTitle: (.*)\nURL: (.*)\n/)
      if (page) user.context = { url: page[2].slice(0, 2000), title: page[1].slice(0, 300) }
      else user.text = (user.text + text).slice(0, LONG)
    } else if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') {
      const reply = openReply(c)
      const key = u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought'
      if (reply) reply[key] = (reply[key] + text).slice(0, LONG)
    } else if (u.sessionUpdate === 'tool_call') {
      add(c, { kind: 'tool', toolCallId: str(u.toolCallId, 200), title: str(u.title, 500), status: TOOL_STATUS.includes(u.status) ? u.status : 'pending', toolKind: str(u.kind, 50) || 'other', text: toolText(u.content) })
      if (!c.replay) liveReply(c)
    } else if (u.sessionUpdate === 'tool_call_update') {
      const tool = toolTurn(c, u.toolCallId)
      if (!tool) return
      if (TOOL_STATUS.includes(u.status)) tool.status = u.status
      if (typeof u.title === 'string') tool.title = str(u.title, 500)
      if (Array.isArray(u.content)) tool.text = toolText(u.content)
    } else return
    touch(c)
  }

  function request(p, method, params, id) {
    const c = method === 'session/request_permission' && p.sessions.get(params?.sessionId)
    if (!c || c.stopping || halted || c.status !== 'running') {
      log.debug('agent request declined', { method, id })
      return p.rpc.respond(id, method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : Object.assign(new Error(`Method not found: ${method}`), { code: -32601 }))
    }
    if (c.permission) answer(c, { outcome: 'cancelled' })
    const call = S.isObject(params?.toolCall) ? params.toolCall : {}
    const options = (Array.isArray(params?.options) ? params.options : []).filter(S.isObject).slice(0, 20).map((o) => ({ optionId: str(o.optionId, 200), name: str(o.name, 200), kind: str(o.kind, 50) }))
    c.permission = { id, title: str(call.title, 500) || toolTurn(c, call.toolCallId)?.title || 'The agent asks for permission', options }
    log.info('permission request', { chatId: c.id, id, toolKind: str(call.kind, 50), options: options.map((o) => o.kind) })
    c.asker = p
    touch(c)
  }

  function answer(c, outcome) {
    const { id } = c.permission
    log.info('permission answered', { chatId: c.id, id, outcome: outcome.outcome })
    c.permission = null
    c.asker?.rpc.respond(id, { outcome })
    touch(c)
  }

  async function restore(c) {
    const agent = agentOf(c.agent)
    c.status = 'restoring'
    track(c)
    c.restorePending = true
    const oldTurns = c.turns
    c.turns = []
    log.info('restore', { chatId: c.id, sessionId: c.sessionId })
    try {
      if (!agent) throw new Error(`No agent named ${c.agent}`)
      const p = await start(agent)
      if (!agent.loadSession) throw new Error('The agent cannot load sessions')
      await load(c, agent, p, 'rebuild')
      c.recovery = null
      c.status = 'ready'
    } catch (e) {
      log.warn('restore failed', { chatId: c.id, err: e?.message })
      if (halted) return
      if (c.stopping) { Object.assign(c, { status: 'ready', turns: oldTurns, proc: null }); return touch(c) }
      c.turns = oldTurns
      if (transcripts) {
        try {
          const saved = transcripts.get({ id: c.id })
          c.turns = saved.turns
          c.count = Math.max(c.count, ...c.turns.map((turn) => Number(turn.id?.replace(/^t/, '')) || 0))
          c.recovery = { source: 'local', readOnly: true, requiresFresh: true, transcriptId: c.id }
        } catch (e) {
          if (e.code !== 'not_found') c.transcriptError = e.message
        }
      }
      add(c, { kind: 'notice', text: UNRESTORED })
      Object.assign(c, { status: 'ready', sessionId: null })
      saveTab(c, { sessionId: null })
    } finally {
      c.restorePending = false
    }
    touch(c)
  }

  // A chat not in memory is rebuilt from its tab (or archive entry), restoring its session when it has one.
  function chat(p) {
    if (typeof p.chatId !== 'string') throw bad('chatId must be a string')
    if (chats.has(p.chatId)) return shape(chats.get(p.chatId))
    const tab = [...state().tabs, ...state().archive].find((t) => t.chat && t.url === chatUrl(p.chatId))
    if (!tab) throw S.err('not_found', `No chat ${p.chatId}`)
    const c = newChat(p.chatId, tab.id, tab.chat.agent, tab.chat.sessionId)
    if (!c.agent && !c.sessionId) c.status = 'setup'
    if (c.sessionId) restore(c)
    else if (transcripts) {
      try {
        const saved = transcripts.get({ id: c.id })
        c.turns = saved.turns
        c.count = Math.max(0, ...c.turns.map((turn) => Number(turn.id?.replace(/^t/, '')) || 0))
        c.recovery = { source: 'local', readOnly: true, requiresFresh: true, transcriptId: c.id }
      } catch (e) { if (e.code !== 'not_found') c.transcriptError = e.message }
    }
    return shape(c)
  }
  const find = (p) => {
    chat(p)
    return chats.get(p.chatId)
  }
  const choice = (p, key) => {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || p[key].length > 200)) throw bad(`${key} must be a string of at most 200 characters`)
    return p[key]
  }
  const defaultAgent = () => state().settings.ai.agent || configured()[0]?.name || ''

  function ask(p) {
    const s = state()
    const name = p.agent === undefined ? defaultAgent() : p.agent
    if (typeof name !== 'string' || (name && !agentOf(name))) throw bad(`No agent named ${name}`)
    if (typeof p.text !== 'string' || (name && !p.text.trim())) throw bad('text must be a non-empty string')
    const model = choice(p, 'model') ?? s.settings.ai.model
    const effort = choice(p, 'effort') ?? s.settings.ai.effort
    const source = p.tabId === undefined ? S.activeTab(s) : S.getTab(s, p.tabId)
    const id = `c${crypto.randomBytes(6).toString('hex')}`
    const tab = S.createTab(s, { spaceId: source?.spaceId, parentId: source?.id }, Date.now(), { id, agent: name, title: p.text.trim().slice(0, 80) || 'New chat', favicon })
    if (name) S.setSettings(s, { ai: { agent: name, model, effort } })
    changed()
    const c = newChat(id, tab.id, name, null)
    log.info('chat new', { chatId: id, agent: name, length: p.text.length, model, effort })
    if (!name) {
      Object.assign(c, { status: 'setup', pending: p.text })
      touch(c)
    } else {
      c.want = { model, effort }
      send(c, p.text, p.includePage === true && source && !source.chat && !S.isIncognito(s, source.spaceId) ? source.id : null)
    }
    return { tabId: tab.id, chatId: id }
  }

  function prompt(p) {
    const c = find(p)
    if (typeof p.text !== 'string' || !p.text.trim()) throw bad('text must be a non-empty string')
    if (c.status === 'running' || c.restorePending) throw bad('The agent is still working.')
    if (c.recovery?.requiresFresh && p.fresh !== true) throw bad('This is a read-only local recovery. Choose Start fresh session before sending.')
    const name = agentOf(c.agent) ? c.agent : defaultAgent()
    if (!name) throw bad('No agent configured.')
    if (c.recovery || p.fresh === true) {
      release(c)
      c.proc?.sessions.delete(c.sessionId)
      Object.assign(c, { recovery: null, sessionId: null, proc: null })
      add(c, { kind: 'notice', text: 'Started a fresh session. The recovered transcript was not sent to the agent.' })
      saveTab(c, { sessionId: null })
    }
    if (name !== c.agent) {
      const { model, effort } = state().settings.ai
      Object.assign(c, { agent: name, want: { model, effort } })
      saveTab(c, { agent: name })
    }
    return { turnId: send(c, p.text, null).id }
  }

  async function configure(p) {
    const c = find(p)
    const picks = Object.fromEntries(['model', 'effort'].map((key) => [key, choice(p, key)]).filter(([, value]) => value))
    const agent = agentOf(c.agent)
    for (const [kind, value] of Object.entries(picks)) {
      if (agent?.proc && c.proc === agent.proc) await choose(c, agent, c.proc, kind, value).catch((e) => { throw bad(e.closed ? e.message : `${KINDS[kind]} ${value} is not available`) })
      else c.want[kind] = value
    }
    S.setSettings(state(), { ai: picks })
    changed()
    return shape(c)
  }

  // Starts the agent and opens a session for its next ask, so the bar can list its models and efforts.
  function warm(p) {
    const agent = agentOf(p.agent)
    if (!agent) throw bad(`No agent named ${p.agent}`)
    if (!agent.spare) {
      log.debug('warm', { agent: agent.name })
      const spare = start(agent).then(async (proc) => {
        const made = await newSession(agent, proc)
        parse(agent, made.configOptions)
        return made
      })
      agent.spare = spare
      spare.catch((e) => {
        if (agent.spare === spare) agent.spare = null
        if (e.closed || agent.proc === null) return
        log.warn('warm failed', { agent: agent.name, err: e.stack })
        Object.assign(agent, { status: 'error', error: e.message })
        pushAgents()
      })
    }
    return agent.spare.then(() => entry(agent), () => entry(agent))
  }

  function cancel(p) {
    const c = find(p)
    log.info('cancel', { chatId: c.id, status: c.status })
    release(c)
    c.stopping = true
    if (c.status === 'running') {
      if (c.proc && c.sessionId) c.proc.rpc.notify('session/cancel', { sessionId: c.sessionId })
    }
    if (c.permission) answer(c, { outcome: 'cancelled' })
    if (c.status !== 'running') c.proc = null
    return null
  }

  function permit(p) {
    const c = find(p)
    if (!c.permission) throw S.err('not_found', 'No permission request is waiting')
    if (p.cancel === true) answer(c, { outcome: 'cancelled' })
    else if (c.permission.options.some((o) => o.optionId === p.optionId)) answer(c, { outcome: 'selected', optionId: p.optionId })
    else throw bad('optionId must be one of the offered options')
    return null
  }

  // After settings.set: an agent that was removed or whose command changed is stopped and forgotten.
  function settingsChanged() {
    for (const agent of [...agents.values()]) {
      if (configured().find((a) => a.name === agent.name)?.command === agent.command) continue
      revokeAccess({ owner: agent.name })
      log.info('agent removed or changed', { agent: agent.name })
      if (agent.proc) down(agent, agent.proc, 'Agent stopped')
      for (const c of chats.values()) {
        if (c.agent !== agent.name) continue
        c.stopping = true
        release(c)
        if (c.permission) answer(c, { outcome: 'cancelled' })
        const reply = openOf(c)
        if (reply) finish(reply, 'cancelled')
        Object.assign(c, { proc: null, status: 'error', error: 'Agent configuration changed' })
        touch(c)
      }
      agents.delete(agent.name)
    }
    pushAgents()
  }

  function stop() {
    halted = true
    log.info('stop', { chats: chats.size, agents: agents.size })
    for (const c of chats.values()) {
      release(c)
      c.stopping = true
      clearTimeout(c.timer)
      c.timer = null
      journal(c, true)
    }
    for (const agent of agents.values()) if (agent.proc) down(agent, agent.proc, '')
  }

  for (const configuredAgent of configured()) agentOf(configuredAgent.name)
  return { agents: list, warm, ask, chat, prompt, configure, cancel, permit, settingsChanged, stop }
}

// Tool discovery and execution share the owned command registry with the UI and CLI.
function browserTools({ registry, call }) {
  return registry.list().filter((definition) => definition.tool).map((definition) => ({
    name: definition.tool.name || definition.name,
    command: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    run: (input = {}, context = {}) => {
      const params = { ...input }
      if (params.tabId !== undefined && definition.owner === 'core' && definition.name.startsWith('tabs.') && definition.name !== 'tabs.create') {
        if (params.id !== undefined && params.id !== params.tabId) throw bad('id and tabId must identify the same tab')
        params.id = params.tabId
        delete params.tabId
      }
      if (definition.name.startsWith('components.') && !call) throw S.err('forbidden', 'Component customization requires the host consent dispatcher')
      const dispatch = call || registry.call.bind(registry)
      return dispatch(definition.name, params, context.grantId ? { ...context, accessContext: context, owner: `agent.${Buffer.from(context.owner).toString('hex')}`, agentOwner: context.owner } : context)
    }
  }))
}

// One MCP JSON-RPC message or a batch; resolves to the reply, or null when nothing is owed (notifications, responses).
async function handleMcp(message, { tools, version }) {
  if (Array.isArray(message)) {
    const replies = (await Promise.all(message.map((m) => handleMcp(m, { tools, version })))).filter(Boolean)
    return replies.length ? replies : null
  }
  if (!S.isObject(message) || message.id === undefined || message.id === null) return null
  const { id, method, params } = message
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  const error = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } })
  if (method === 'initialize') return ok({ protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'skiff', version } })
  if (method === 'ping') return ok({})
  if (method === 'tools/list') return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  if (method !== 'tools/call') return typeof method === 'string' ? error(-32601, `Method not found: ${method}`) : null
  const tool = tools.find((t) => t.name === params?.name)
  if (!tool) return error(-32602, `Unknown tool: ${params?.name}`)
  try {
    const t = Date.now()
    const result = await tool.run(S.isObject(params.arguments) ? params.arguments : {})
    log.debug('mcp tool call', { tool: tool.name, ms: Date.now() - t })
    return ok({ content: [{ type: 'text', text: JSON.stringify(result ?? null) }] })
  } catch (e) {
    log.warn('mcp tool failed', { tool: params.name, err: e.message })
    return ok({ content: [{ type: 'text', text: String(e.message || e) }], isError: true })
  }
}

module.exports = { createAi, browserTools, handleMcp }

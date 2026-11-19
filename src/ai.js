'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const S = require('./state')
const { connect } = require('./acp')

const TURNS = 200
const LONG = 200000
const TOOL_TEXT = 4000
const PAGE_TEXT = 12000
const READ_TEXT = 20000
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
// favicon: the icon of chat tabs; api(): {port, token} of the local API or null; pageText(tabId): {title, url, selection, text} of a loaded non-incognito web tab, or null;
// push(name, data): 'ai-agents' with the agents list, or 'chat' with one chat object (at most once per 30 ms per chat).
function createAi({ dir, version, state, changed, favicon, api, pageText, push }) {
  const agents = new Map()
  const chats = new Map()

  const configured = () => state().settings.ai.agents
  function agentOf(name) {
    const conf = configured().find((a) => a.name === name)
    if (!conf) return null
    if (!agents.has(name)) agents.set(name, { name, command: conf.command, status: 'idle', error: '', info: null, models: null, model: null, efforts: null, effort: null, loadSession: false, proc: null, ready: null, spare: null })
    return agents.get(name)
  }
  const entry = (a) => ({ name: a.name, command: a.command, status: a.status, error: a.error, info: a.info, models: a.models, model: a.model, efforts: a.efforts, effort: a.effort, loadSession: a.loadSession })
  const list = () => configured().map((a) => entry(agentOf(a.name)))
  const pushAgents = () => push('ai-agents', list())

  const shape = (c) => ({ id: c.id, tabId: c.tabId, agent: c.agent, status: c.status, error: c.error, pending: c.pending, sessionId: c.sessionId, models: c.models, model: c.model, efforts: c.efforts, effort: c.effort, permission: c.permission, turns: c.turns })
  const touch = (c) => {
    c.timer ??= setTimeout(() => {
      c.timer = null
      push('chat', shape(c))
    }, 30)
  }
  function newChat(id, tabId, agent, sessionId) {
    const c = { id, tabId, agent, status: 'ready', error: '', pending: '', sessionId, models: null, model: null, efforts: null, effort: null, permission: null, turns: [], count: 0, timer: null, proc: null, asker: null, config: {}, replay: null, stopping: false, want: {} }
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
    const result = await p.rpc.request(method, params).catch(async (e) => {
      if (e.closed) await within(2000, p.exited, '').catch(() => {})
      throw e
    })
    if (agent.proc !== p) throw stopped()
    return result
  }

  // Ends the agent's process. With a message, every chat running on it or holding a session in it ends in that error and keeps its session id for session/load.
  function down(agent, p, message) {
    if (agent.proc !== p) return
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
    const p = { child, sessions: new Map(), http: false, auth: [] }
    let tail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data) => {
      tail = (tail + data).slice(-2000)
    })
    child.on('error', (e) => down(agent, p, `Agent could not start: ${e.message}`))
    child.on('close', (code, signal) => down(agent, p, `Agent exited with code ${code ?? signal}${tail.trim() && `\n${tail.trim()}`}`))
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
      agent.status = 'ready'
      pushAgents()
      return p
    })()
    agent.ready.catch((e) => e.closed || down(agent, p, `The agent could not start: ${e.message}`))
    return agent.ready
  }
  const start = (agent) => agent.ready || launch(agent)

  // session/new or session/load, signing in with the agent's first method when it asks for that.
  function open(agent, p, method, extra) {
    const local = api()
    const mcpServers = p.http && local ? [{ type: 'http', name: 'skiff', url: `http://127.0.0.1:${local.port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${local.token}` }] }] : []
    const params = { ...extra, cwd: dir, mcpServers }
    return rpc(agent, p, method, params).catch(async (e) => {
      if (e.code !== -32000 || !p.auth.length) throw e
      await rpc(agent, p, 'authenticate', { methodId: p.auth[0]?.id })
      return rpc(agent, p, method, params)
    })
  }

  async function newSession(agent, p) {
    const created = await open(agent, p, 'session/new', {})
    if (typeof created?.sessionId !== 'string') throw new Error('session/new returned no sessionId')
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
    p.sessions.set(c.sessionId, c)
    c.replay = mode
    try {
      const result = await open(agent, p, 'session/load', { sessionId: c.sessionId })
      Object.assign(c, parse(agent, result?.configOptions), { proc: p })
    } catch (e) {
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
    const { sessionId, configOptions } = spare?.p === p ? spare : await newSession(agent, p)
    Object.assign(c, parse(agent, configOptions), { sessionId, proc: p })
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

  async function readPage(tabId) {
    const raw = await within(2000, Promise.resolve().then(() => pageText(tabId)), 'The page did not answer').catch(() => null)
    return S.isObject(raw) ? { title: str(raw.title, 300), url: str(raw.url, 2000), selection: str(raw.selection, PAGE_TEXT), text: str(raw.text, PAGE_TEXT) } : null
  }

  async function run(c, user, reply, text, pageTab) {
    const agent = agentOf(c.agent)
    try {
      const page = pageTab ? await readPage(pageTab) : null
      if (page) user.context = { url: page.url, title: page.title }
      const p = await start(agent)
      if (c.proc !== p) await attach(c, agent, p, user)
      for (const kind of ['model', 'effort']) {
        const value = c.want[kind]
        delete c.want[kind]
        if (value && value !== c[kind]) {
          await choose(c, agent, p, kind, value).catch((e) => {
            if (e.closed) throw e
            add(c, { kind: 'notice', text: `${KINDS[kind]} ${value} is not available` }, user)
          })
        }
      }
      if (c.stopping) {
        finish(reply, 'cancelled')
        c.status = 'ready'
        return touch(c)
      }
      touch(c)
      const result = await rpc(agent, p, 'session/prompt', { sessionId: c.sessionId, prompt: [...(page ? [{ type: 'text', text: contextBlock(page) }] : []), { type: 'text', text }] })
      finish(openOf(c) || reply, str(result?.stopReason, 50) || 'end_turn')
      c.status = 'ready'
    } catch (e) {
      // A closed connection means the process went down, and down() ends the turn.
      const open = openOf(c)
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
    const user = add(c, { kind: 'user', text, context: null })
    const reply = add(c, { kind: 'assistant', text: '', thought: '', done: false })
    run(c, user, reply, text, pageTab)
    touch(c)
    return reply
  }

  function update(c, u) {
    if (!S.isObject(u) || c.replay === 'ignore') return
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
    if (!c) return p.rpc.respond(id, method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : Object.assign(new Error(`Method not found: ${method}`), { code: -32601 }))
    if (c.permission) answer(c, { outcome: 'cancelled' })
    const call = S.isObject(params?.toolCall) ? params.toolCall : {}
    const options = (Array.isArray(params?.options) ? params.options : []).filter(S.isObject).slice(0, 20).map((o) => ({ optionId: str(o.optionId, 200), name: str(o.name, 200), kind: str(o.kind, 50) }))
    c.permission = { id, title: str(call.title, 500) || toolTurn(c, call.toolCallId)?.title || 'The agent asks for permission', options }
    c.asker = p
    touch(c)
  }

  function answer(c, outcome) {
    const { id } = c.permission
    c.permission = null
    c.asker?.rpc.respond(id, { outcome })
    touch(c)
  }

  async function restore(c) {
    const agent = agentOf(c.agent)
    c.status = 'restoring'
    try {
      if (!agent) throw new Error(`No agent named ${c.agent}`)
      const p = await start(agent)
      if (!agent.loadSession) throw new Error('The agent cannot load sessions')
      await load(c, agent, p, 'rebuild')
      c.status = 'ready'
    } catch {
      if (c.status !== 'restoring') return
      add(c, { kind: 'notice', text: UNRESTORED })
      Object.assign(c, { status: 'ready', sessionId: null })
      saveTab(c, { sessionId: null })
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
    if (c.status === 'running' || c.status === 'restoring') throw bad('The agent is still working.')
    const name = agentOf(c.agent) ? c.agent : defaultAgent()
    if (!name) throw bad('No agent configured.')
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
      const spare = start(agent).then(async (proc) => {
        const made = await newSession(agent, proc)
        parse(agent, made.configOptions)
        return made
      })
      agent.spare = spare
      spare.catch((e) => {
        if (agent.spare === spare) agent.spare = null
        if (e.closed || agent.proc === null) return
        Object.assign(agent, { status: 'error', error: e.message })
        pushAgents()
      })
    }
    return agent.spare.then(() => entry(agent), () => entry(agent))
  }

  function cancel(p) {
    const c = find(p)
    if (c.status === 'running') {
      c.stopping = true
      if (c.proc && c.sessionId) c.proc.rpc.notify('session/cancel', { sessionId: c.sessionId })
    }
    if (c.permission) answer(c, { outcome: 'cancelled' })
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
      if (agent.proc) down(agent, agent.proc, 'Agent stopped')
      agents.delete(agent.name)
    }
    pushAgents()
  }

  function stop() {
    for (const agent of agents.values()) if (agent.proc) down(agent, agent.proc, '')
  }

  return { agents: list, warm, ask, chat, prompt, configure, cancel, permit, settingsChanged, stop }
}

// state(): the browser state; call(method, params): runs a command; readTab(tab): {title, url, text} once the tab's page has loaded.
function browserTools({ state, call, readTab }) {
  const tabOf = (id, required, web) => {
    if (required && typeof id !== 'string') throw bad('tabId is required')
    const s = state()
    const tab = id === undefined ? S.activeTab(s) : S.findTab(s, id)
    if (!tab || S.isIncognito(s, tab.spaceId)) throw bad(id === undefined ? 'No active tab' : `No tab ${id}`)
    if (web && tab.chat) throw bad('That tab is a conversation, not a web page.')
    return tab
  }
  const schema = (properties, required = []) => ({ type: 'object', properties, required })
  const tabId = { type: 'string', description: 'A tab id from browser_list_tabs' }
  const url = { type: 'string', description: 'An http or https address' }
  return [
    {
      name: 'browser_list_tabs',
      description: 'List the open browser tabs (id, title, url, space name, favorite, pinned, and chat: true for a conversation with an agent) and the id of the active tab',
      inputSchema: schema({}),
      run: () => {
        const s = state()
        const active = S.activeTab(s)
        const spaces = new Map(s.spaces.filter((x) => !x.incognito).map((x) => [x.id, x.name]))
        return { activeTabId: active && spaces.has(active.spaceId) ? active.id : null, tabs: s.tabs.filter((t) => spaces.has(t.spaceId)).map((t) => ({ id: t.id, title: t.title, url: t.url, space: spaces.get(t.spaceId), favorite: !!t.favorite, pinned: !!t.pinned, ...(t.chat && { chat: true }) })) }
      }
    },
    {
      name: 'browser_open_tab',
      description: 'Open an address in a new tab of the active space',
      inputSchema: schema({ url, activate: { type: 'boolean', description: 'Show the new tab (default true)' } }, ['url']),
      run: async (a) => {
        const s = state()
        const space = s.spaces.find((x) => x.id === s.activeSpaceId && !x.incognito) || s.spaces.find((x) => !x.incognito)
        const tab = await call('tabs.create', { url: S.webUrl(a.url), spaceId: space.id, activate: a.activate !== false })
        return { id: tab.id, url: tab.url }
      }
    },
    {
      name: 'browser_navigate',
      description: 'Load an address in a tab, the active tab by default; not in a conversation tab',
      inputSchema: schema({ url, tabId }, ['url']),
      run: async (a) => {
        const tab = await call('tabs.navigate', { id: tabOf(a.tabId, false, true).id, url: S.webUrl(a.url) })
        return { id: tab.id, url: tab.url }
      }
    },
    {
      name: 'browser_activate_tab',
      description: 'Show a tab, switching to its space',
      inputSchema: schema({ tabId }, ['tabId']),
      run: async (a) => {
        const { id } = tabOf(a.tabId, true)
        await call('tabs.activate', { id })
        return { id }
      }
    },
    {
      name: 'browser_close_tab',
      description: 'Close a tab into the archive; favorites and pinned tabs are only unloaded',
      inputSchema: schema({ tabId }, ['tabId']),
      run: async (a) => call('tabs.close', { id: tabOf(a.tabId, true).id })
    },
    {
      name: 'browser_read_page',
      description: `Read the title, address and visible text (first ${READ_TEXT} characters) of a tab, the active tab by default; a tab that is not loaded is loaded in the background first; not a conversation tab`,
      inputSchema: schema({ tabId }),
      run: async (a) => {
        const tab = tabOf(a.tabId, false, true)
        const page = await within(15000, readTab(tab), 'The page did not load within 15 seconds')
        return { id: tab.id, title: str(page?.title, 300), url: str(page?.url, 2000), text: str(page?.text, READ_TEXT) }
      }
    }
  ]
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
    const result = await tool.run(S.isObject(params.arguments) ? params.arguments : {})
    return ok({ content: [{ type: 'text', text: JSON.stringify(result ?? null) }] })
  } catch (e) {
    return ok({ content: [{ type: 'text', text: String(e.message || e) }], isError: true })
  }
}

module.exports = { createAi, browserTools, handleMcp }

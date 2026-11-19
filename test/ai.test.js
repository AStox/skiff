'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createAi, browserTools, handleMcp } = require('../src/ai')
const S = require('../src/state')

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
const AGENT = `${quote(process.execPath)} ${quote(path.join(__dirname, '..', 'e2e', 'fake-agent.js'))}`
const PAGE = { title: 'Example page', url: 'https://example.com/a', selection: '', text: 'Hello from the example page, which goes on and on.' }
const ICON = '../favicons/0123456789abcdef01234567.svg'
const FOOT = '\nModel: fake-small Effort: low'

function setup({ agents = [{ name: 'Fake', command: AGENT }], page = PAGE, api = () => null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-ai-'))
  const s = S.load({ settings: { ai: { agents } } })
  const web = S.createTab(s, { url: PAGE.url }, 0)
  const pushes = { chat: [], agents: [] }
  const reads = []
  const live = []
  const make = () => {
    const ai = createAi({
      dir: path.join(dir, 'ai'), version: '0.0.0', state: () => s, changed: () => {}, favicon: ICON, api,
      pageText: (tabId) => {
        reads.push(tabId)
        return page
      },
      push: (name, data) => pushes[name === 'chat' ? 'chat' : 'agents'].push(JSON.parse(JSON.stringify(data)))
    })
    live.push(ai)
    return ai
  }
  test.after(() => {
    for (const ai of live) ai.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { ai: make(), make, s, web, pushes, reads, dir: path.join(dir, 'ai') }
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${fn}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const settled = (ai, chatId) => until(() => {
  const c = ai.chat({ chatId })
  return !['running', 'restoring'].includes(c.status) && c
})
const last = (ai, chatId, kind = 'assistant') => ai.chat({ chatId }).turns.findLast((t) => t.kind === kind)
const kinds = (c, kind) => c.turns.filter((t) => t.kind === kind)
const stored = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'fake-sessions.json'), 'utf8'))

test('ask opens a chat tab under the page, sends the page only when asked and streams the reply', async () => {
  const { ai, s, web, reads, pushes } = setup()
  const { tabId, chatId } = ai.ask({ text: '  What is this?  ', includePage: true })
  assert.match(chatId, /^c[0-9a-f]{12}$/)
  const tab = S.findTab(s, tabId)
  assert.deepEqual({ url: tab.url, title: tab.title, favicon: tab.favicon, chat: tab.chat, parentId: tab.parentId, active: S.activeTab(s) === tab }, { url: `skiff://chat/${chatId}`, title: 'What is this?', favicon: ICON, chat: { agent: 'Fake', sessionId: null }, parentId: web.id, active: true })
  assert.equal(ai.chat({ chatId }).status, 'running')
  const c = await settled(ai, chatId)
  assert.deepEqual(reads, [web.id])
  const reply = last(ai, chatId)
  assert.equal(reply.text, `You said:   What is this?  \nPage title: Example page\nPage text starts: Hello from the example page, which goes ${FOOT}`)
  assert.deepEqual({ thought: reply.thought, done: reply.done, stopReason: reply.stopReason }, { thought: 'Looking at this.', done: true, stopReason: 'end_turn' })
  assert.deepEqual(kinds(c, 'user')[0].context, { url: PAGE.url, title: PAGE.title })
  assert.deepEqual({ status: c.status, model: c.model, effort: c.effort, models: c.models.map((m) => m.name), efforts: c.efforts.map((e) => e.value) }, { status: 'ready', model: 'fake-small', effort: 'low', models: ['Fake Small', 'Fake Large'], efforts: ['low', 'high'] })
  assert.match(c.sessionId, /^fake-session-/)
  assert.equal(tab.chat.sessionId, c.sessionId)
  assert.deepEqual(s.settings.ai, { agents: [{ name: 'Fake', command: AGENT }], agent: 'Fake', model: '', effort: '' })
  const [agent] = ai.agents()
  assert.deepEqual({ ...agent, models: agent.models.length, efforts: agent.efforts.length }, { name: 'Fake', command: AGENT, status: 'ready', error: '', info: { name: 'Fake agent', version: '1' }, models: 2, model: 'fake-small', efforts: 2, effort: 'low', loadSession: true })
  await until(() => pushes.chat.at(-1)?.status === 'ready' && pushes.chat.at(-1).turns.at(-1).done)
  assert.equal(pushes.chat.at(-1).id, chatId)
  assert.ok(pushes.agents.some((list) => list[0].status === 'ready'))

  const follow = ai.prompt({ chatId, text: 'No page' })
  assert.match(follow.turnId, /^t\d+$/)
  await settled(ai, chatId)
  assert.equal(last(ai, chatId).text, `You said: No page${FOOT}`)
  assert.equal(last(ai, chatId, 'user').context, null)

  const plain = ai.ask({ text: 'Without the page' })
  await settled(ai, plain.chatId)
  assert.equal(last(ai, plain.chatId).text, `You said: Without the page${FOOT}`)
  assert.deepEqual(reads, [web.id])
})

test('a page that does not answer within 2 seconds is left out', async () => {
  const { ai } = setup({ page: new Promise(() => {}) })
  const started = Date.now()
  const { chatId } = ai.ask({ text: 'hi', includePage: true })
  await settled(ai, chatId)
  assert.ok(Date.now() - started >= 1900)
  assert.equal(last(ai, chatId).text, `You said: hi${FOOT}`)
})

test('ask applies and saves the model and effort; an unknown one is skipped with a notice', async () => {
  const { ai, s } = setup()
  const first = ai.ask({ text: 'hi', model: 'fake-large', effort: 'high' })
  const c = await settled(ai, first.chatId)
  assert.equal(last(ai, first.chatId).text, 'You said: hi\nModel: fake-large Effort: high')
  assert.deepEqual([c.model, c.effort], ['fake-large', 'high'])
  assert.deepEqual([s.settings.ai.model, s.settings.ai.effort], ['fake-large', 'high'])
  const again = ai.ask({ text: 'defaults' })
  await settled(ai, again.chatId)
  assert.equal(last(ai, again.chatId).text, 'You said: defaults\nModel: fake-large Effort: high')
  const odd = ai.ask({ text: 'odd', model: 'nope' })
  const o = await settled(ai, odd.chatId)
  assert.deepEqual(o.turns.map((t) => t.kind), ['notice', 'user', 'assistant'])
  assert.equal(o.turns[0].text, 'Model nope is not available')
  assert.equal(last(ai, odd.chatId).text, 'You said: odd\nModel: fake-small Effort: high')
  assert.throws(() => ai.ask({ text: 'x', agent: 'Other' }), { code: 'bad_params', message: 'No agent named Other' })
  assert.throws(() => ai.ask({ text: '  ' }), { code: 'bad_params' })
  assert.throws(() => ai.ask({ text: 'x', model: 3 }), { code: 'bad_params' })
})

test('two chats share one agent process without crosstalk', async () => {
  const { ai, pushes, dir } = setup()
  const a = ai.ask({ text: 'be slow' })
  const b = ai.ask({ text: 'hello' })
  const [ca, cb] = [await settled(ai, a.chatId), await settled(ai, b.chatId)]
  assert.notEqual(ca.sessionId, cb.sessionId)
  assert.equal(last(ai, b.chatId).text, `You said: hello${FOOT}`)
  assert.match(last(ai, a.chatId).text, new RegExp(`^\\.{60}You said: be slow${FOOT}$`))
  assert.equal(pushes.agents.filter((list) => list[0].status === 'starting').length, 1)
  assert.deepEqual(Object.keys(stored(dir)).sort(), [ca.sessionId, cb.sessionId].sort())
})

test('warm opens a spare session that the next ask uses', async () => {
  const { ai, dir } = setup()
  assert.throws(() => ai.warm({ agent: 'Other' }), { code: 'bad_params' })
  const warming = ai.warm({ agent: 'Fake' })
  assert.equal(ai.warm({ agent: 'Fake' }) instanceof Promise, true)
  const agent = await warming
  assert.deepEqual({ status: agent.status, models: agent.models, effort: agent.effort }, { status: 'ready', models: [{ value: 'fake-small', name: 'Fake Small' }, { value: 'fake-large', name: 'Fake Large' }], effort: 'low' })
  const spare = Object.keys(stored(dir))
  assert.equal(spare.length, 1)
  const { chatId } = ai.ask({ text: 'hi' })
  const c = await settled(ai, chatId)
  assert.equal(c.sessionId, spare[0])
  assert.equal(Object.keys(stored(dir)).length, 1)
})

test('a permission request goes to its chat, and the agent then calls the MCP server it was given', async () => {
  const calls = []
  const tools = [{ name: 'browser_open_tab', description: 'Open', inputSchema: { type: 'object' }, run: (a) => ({ id: 'tNew', url: a.url }) }]
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks))
      calls.push({ url: req.url, auth: req.headers.authorization, method: body.method, params: body.params })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(await handleMcp(body, { tools, version: '0.0.0' })))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  test.after(() => server.close())
  const { ai } = setup({ api: () => ({ port: server.address().port, token: 'secret' }) })
  const other = ai.ask({ text: 'hello' })
  await settled(ai, other.chatId)
  const { chatId } = ai.ask({ text: 'please open https://example.org/x' })
  const permission = await until(() => ai.chat({ chatId }).permission)
  assert.equal(permission.title, 'Open https://example.org/x')
  assert.deepEqual(permission.options, [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }])
  assert.throws(() => ai.permit({ chatId: other.chatId, optionId: 'allow' }), { code: 'not_found' })
  const [pending] = kinds(ai.chat({ chatId }), 'tool')
  assert.deepEqual({ ...pending, id: undefined }, { id: undefined, kind: 'tool', toolCallId: pending.toolCallId, title: 'Open https://example.org/x', status: 'pending', toolKind: 'fetch', text: '' })
  assert.throws(() => ai.permit({ chatId, optionId: 'nope' }), { code: 'bad_params' })
  ai.permit({ chatId, optionId: 'allow' })
  assert.equal(ai.chat({ chatId }).permission, null)
  const c = await settled(ai, chatId)
  assert.equal(last(ai, chatId).text, `You said: please open https://example.org/x${FOOT}`)
  const [tool] = kinds(c, 'tool')
  assert.equal(tool.status, 'completed')
  assert.equal(tool.text, '{"id":"tNew","url":"https://example.org/x"}')
  assert.deepEqual(c.turns.map((t) => [t.kind, t.kind === 'tool' ? t.title : t.thought || t.text]).slice(-4), [['user', 'please open https://example.org/x'], ['assistant', 'Looking at this.'], ['tool', 'Open https://example.org/x'], ['assistant', `You said: please open https://example.org/x${FOOT}`]])
  assert.deepEqual(calls.map((x) => [x.url, x.auth, x.method]), [['/mcp', 'Bearer secret', 'initialize'], ['/mcp', 'Bearer secret', 'tools/call']])
  assert.deepEqual(calls[1].params, { name: 'browser_open_tab', arguments: { url: 'https://example.org/x' } })
  assert.equal(kinds(ai.chat({ chatId: other.chatId }), 'tool').length, 0)

  ai.prompt({ chatId, text: 'open https://example.org/y' })
  await until(() => ai.chat({ chatId }).permission)
  ai.permit({ chatId, cancel: true })
  await settled(ai, chatId)
  assert.equal(kinds(ai.chat({ chatId }), 'tool')[1].status, 'cancelled')
  assert.equal(calls.length, 2)
})

test('cancel stops a slow turn; a second prompt is refused while it runs', async () => {
  const { ai } = setup()
  const { chatId } = ai.ask({ text: 'be slow' })
  assert.throws(() => ai.prompt({ chatId, text: 'again' }), { code: 'bad_params', message: 'The agent is still working.' })
  await until(() => last(ai, chatId).text.length >= 3)
  assert.equal(ai.chat({ chatId }).status, 'running')
  assert.equal(ai.cancel({ chatId }), null)
  await settled(ai, chatId)
  const reply = last(ai, chatId)
  assert.equal(reply.stopReason, 'cancelled')
  assert.ok(reply.text.length < 60)
  assert.equal(ai.chat({ chatId }).status, 'ready')
  assert.equal(ai.cancel({ chatId }), null)
  assert.throws(() => ai.cancel({ chatId: 'c000000000000' }), { code: 'not_found' })
})

test('a crash ends both chats; the next prompt loads the old session, or starts a new one when it is gone', async () => {
  const { ai, dir } = setup()
  const slow = ai.ask({ text: 'be slow' })
  await until(() => last(ai, slow.chatId).text.length >= 1)
  const crash = ai.ask({ text: 'crash now' })
  const [a, b] = [await settled(ai, slow.chatId), await settled(ai, crash.chatId)]
  for (const c of [a, b]) {
    assert.deepEqual({ status: c.status, error: c.error, stopReason: last(ai, c.id).stopReason }, { status: 'error', error: 'Agent exited with code 3\nFake agent crashed', stopReason: 'error' })
    assert.deepEqual(kinds(c, 'notice').map((t) => t.text), ['Agent exited with code 3'])
    assert.match(c.sessionId, /^fake-session-/)
  }
  assert.equal(ai.agents()[0].status, 'error')
  const session = a.sessionId
  ai.prompt({ chatId: slow.chatId, text: 'hello again' })
  const again = await settled(ai, slow.chatId)
  assert.equal(last(ai, slow.chatId).text, `You said: hello again${FOOT}`)
  assert.deepEqual({ status: again.status, error: again.error, sessionId: again.sessionId }, { status: 'ready', error: '', sessionId: session })
  assert.deepEqual(again.turns.map((t) => t.kind), ['user', 'assistant', 'notice', 'user', 'assistant'])

  fs.rmSync(path.join(dir, 'fake-sessions.json'))
  ai.prompt({ chatId: crash.chatId, text: 'fresh' })
  const fresh = await settled(ai, crash.chatId)
  assert.equal(last(ai, crash.chatId).text, `You said: fresh${FOOT}`)
  assert.notEqual(fresh.sessionId, b.sessionId)
  assert.deepEqual(kinds(fresh, 'notice').map((t) => t.text), ['Agent exited with code 3', 'Started a new session'])
  assert.deepEqual(fresh.turns.map((t) => t.kind), ['user', 'assistant', 'notice', 'notice', 'user', 'assistant'])
})

test('after a restart a chat is restored from its tab with session/load, from the archive too', async () => {
  const { ai, make, s } = setup()
  const { tabId, chatId } = ai.ask({ text: 'remember me', includePage: true })
  await settled(ai, chatId)
  ai.prompt({ chatId, text: 'second' })
  const before = await settled(ai, chatId)
  ai.stop()
  S.closeTab(s, { id: tabId }, 1)
  assert.deepEqual(s.archive[0].chat, { agent: 'Fake', sessionId: before.sessionId })

  const next = make()
  assert.equal(next.chat({ chatId }).status, 'restoring')
  assert.throws(() => next.prompt({ chatId, text: 'too soon' }), { code: 'bad_params', message: 'The agent is still working.' })
  const c = await settled(next, chatId)
  assert.deepEqual({ status: c.status, sessionId: c.sessionId, tabId: c.tabId, model: c.model }, { status: 'ready', sessionId: before.sessionId, tabId, model: 'fake-small' })
  assert.deepEqual(c.turns.map((t) => [t.kind, t.text]), before.turns.map((t) => [t.kind, t.text]))
  assert.deepEqual(c.turns[0].context, { url: PAGE.url, title: PAGE.title })
  assert.deepEqual(c.turns.filter((t) => t.kind === 'assistant').map((t) => [t.done, t.stopReason]), [[true, 'end_turn'], [true, 'end_turn']])
  next.prompt({ chatId, text: 'third' })
  const after = await settled(next, chatId)
  assert.equal(last(next, chatId).text, `You said: third${FOOT}`)
  assert.equal(kinds(after, 'notice').length, 0)

  next.stop()
  S.setSettings(s, { ai: { agents: [{ name: 'Other', command: AGENT }] } })
  const gone = make()
  const lost = await settled(gone, chatId)
  assert.deepEqual(kinds(lost, 'notice').map((t) => t.text), ['This conversation could not be restored. New messages start a fresh session.'])
  assert.equal(lost.sessionId, null)
  assert.equal(s.archive[0].chat.sessionId, null)
  assert.throws(() => gone.chat({ chatId: 'c000000000000' }), { code: 'not_found' })
})

test('with no agent the chat waits in setup, and its text goes once an agent is configured', async () => {
  const { ai, s } = setup({ agents: [] })
  assert.deepEqual(s.settings.ai, { agents: [], agent: '', model: '', effort: '' })
  const { tabId, chatId } = ai.ask({ text: 'hello there' })
  assert.deepEqual(S.findTab(s, tabId).chat, { agent: '', sessionId: null })
  assert.equal(S.findTab(s, tabId).title, 'hello there')
  assert.deepEqual(ai.chat({ chatId }), { id: chatId, tabId, agent: '', status: 'setup', error: '', pending: 'hello there', sessionId: null, models: null, model: null, efforts: null, effort: null, permission: null, turns: [] })
  assert.throws(() => ai.prompt({ chatId, text: 'hello there' }), { code: 'bad_params', message: 'No agent configured.' })
  const empty = ai.ask({ text: '' })
  assert.equal(S.findTab(s, empty.tabId).title, 'New chat')
  assert.deepEqual(ai.agents(), [])

  S.setSettings(s, { ai: { agents: [{ name: 'Fake', command: AGENT }] } })
  ai.settingsChanged()
  assert.equal(s.settings.ai.agent, 'Fake')
  ai.prompt({ chatId, text: 'hello there' })
  const c = await settled(ai, chatId)
  assert.deepEqual({ agent: c.agent, pending: c.pending, text: last(ai, chatId).text }, { agent: 'Fake', pending: '', text: `You said: hello there${FOOT}` })
  assert.equal(S.findTab(s, tabId).chat.agent, 'Fake')
  const blank = ai.ask({ text: '', agent: '' })
  assert.equal(ai.chat({ chatId: blank.chatId }).status, 'setup')

  S.setSettings(s, { ai: { agents: [{ name: 'Fake', command: `${AGENT} --changed` }] } })
  ai.settingsChanged()
  assert.deepEqual(ai.agents().map((a) => [a.status, a.command]), [['idle', `${AGENT} --changed`]])
})

test('configure changes the model mid-chat and saves it', async () => {
  const { ai, s } = setup()
  const { chatId } = ai.ask({ text: 'hi' })
  await settled(ai, chatId)
  const c = await ai.configure({ chatId, model: 'fake-large' })
  assert.deepEqual([c.model, c.effort], ['fake-large', 'low'])
  assert.equal(s.settings.ai.model, 'fake-large')
  await assert.rejects(ai.configure({ chatId, effort: 'extreme' }), { code: 'bad_params', message: 'Effort extreme is not available' })
  ai.prompt({ chatId, text: 'again' })
  await settled(ai, chatId)
  assert.equal(last(ai, chatId).text, 'You said: again\nModel: fake-large Effort: low')
})

test('an agent that requires sign in is authenticated once with its first method', async () => {
  const { ai } = setup({ agents: [{ name: 'Fake', command: `FAKE_AUTH=1 ${AGENT}` }] })
  const { chatId } = ai.ask({ text: 'hi' })
  await settled(ai, chatId)
  assert.equal(last(ai, chatId).text, `You said: hi${FOOT}`)
})

test('a command that is not found ends in an error with its stderr', async () => {
  const { ai } = setup({ agents: [{ name: 'Nope', command: 'skiff-no-such-agent-command' }] })
  const { chatId } = ai.ask({ text: 'hi' })
  const c = await settled(ai, chatId)
  assert.equal(c.status, 'error')
  assert.match(c.error, /^Agent exited with code 127\n.*not found/s)
  assert.match(ai.agents()[0].error, /^Agent exited with code 127/)
  assert.deepEqual((await ai.warm({ agent: 'Nope' })).status, 'error')
})

test('handleMcp answers initialize, ping, tools/list, tools/call and refuses unknown methods', async () => {
  const tools = [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} }, run: (a) => ({ got: a }) },
    { name: 'boom', description: 'Fails', inputSchema: { type: 'object' }, run: () => { throw S.err('bad_params', 'No tab x') } }
  ]
  const mcp = (message) => handleMcp(message, { tools, version: '1.2.3' })
  assert.deepEqual(await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'skiff', version: '1.2.3' } } })
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result.protocolVersion, '2025-03-26')
  assert.deepEqual(await mcp({ jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} })
  assert.deepEqual((await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools, tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))
  assert.deepEqual((await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })).result, { content: [{ type: 'text', text: '{"got":{"a":1}}' }] })
  assert.deepEqual((await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } })).result, { content: [{ type: 'text', text: 'No tab x' }], isError: true })
  assert.equal((await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602)
  assert.deepEqual(await mcp({ jsonrpc: '2.0', id: 7, method: 'resources/list' }), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: resources/list' } })
  assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.deepEqual((await mcp([{ jsonrpc: '2.0', id: 8, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])).map((r) => r.id), [8])
})

test('the browser tools see and touch only non-incognito tabs, and do not read or navigate chats', async () => {
  const s = S.load()
  const tab = S.createTab(s, { url: 'https://a.example/' }, 0)
  const chat = S.createTab(s, { activate: false }, 0, { id: 'c0123456789ab', agent: 'Fake', title: 'Hi', favicon: '' })
  S.openIncognito(s)
  const secret = S.createTab(s, { url: 'https://secret.example/' }, 0)
  const calls = []
  const tools = browserTools({ state: () => s, call: async (method, params) => { calls.push([method, params]); return { id: 'tNew', url: params.url } }, readTab: async (t) => ({ title: 'A', url: t.url, text: 'x'.repeat(30000) }) })
  const run = (name, args = {}) => tools.find((t) => t.name === name).run(args)
  assert.deepEqual(await run('browser_list_tabs'), { activeTabId: null, tabs: [{ id: tab.id, title: tab.title, url: tab.url, space: 'Home', favorite: false, pinned: false }, { id: chat.id, title: 'Hi', url: 'skiff://chat/c0123456789ab', space: 'Home', favorite: false, pinned: false, chat: true }] })
  await run('browser_open_tab', { url: 'https://b.example/' })
  assert.deepEqual(calls, [['tabs.create', { url: 'https://b.example/', spaceId: s.spaces[0].id, activate: true }]])
  await assert.rejects(run('browser_open_tab', { url: 'javascript:alert(1)' }), { code: 'bad_params' })
  await assert.rejects(run('browser_read_page'), { code: 'bad_params', message: 'No active tab' })
  await assert.rejects(run('browser_read_page', { tabId: secret.id }), { code: 'bad_params' })
  await assert.rejects(run('browser_close_tab', {}), { code: 'bad_params' })
  for (const name of ['browser_read_page', 'browser_navigate']) await assert.rejects(run(name, { tabId: chat.id, url: 'https://c.example/' }), { code: 'bad_params', message: 'That tab is a conversation, not a web page.' })
  const page = await run('browser_read_page', { tabId: tab.id })
  assert.deepEqual({ ...page, text: page.text.length }, { id: tab.id, title: 'A', url: tab.url, text: 20000 })
})

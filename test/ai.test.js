'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createAi, browserTools, handleMcp } = require('../src/ai')
const { createAccess } = require('../src/access')
const { createRegistry } = require('../src/commands')
const { createTranscripts } = require('../src/transcripts')
const S = require('../src/state')

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
const AGENT = `${quote(process.execPath)} ${quote(path.join(__dirname, '..', 'e2e', 'fake-agent.js'))}`
const PAGE = { title: 'Example page', url: 'https://example.com/a', selection: '', text: 'Hello from the example page, which goes on and on.' }
const ICON = '../favicons/0123456789abcdef01234567.svg'
const FOOT = '\nModel: fake-small Effort: low'

function setup({ agents = [{ name: 'Fake', command: AGENT }], page = PAGE, api = () => null, revokeAccess, pageGeneration, transcriptRecovery = false, watching, machines } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-ai-'))
  const s = S.load({ settings: { ai: { agents } } })
  s.settings.transcriptRecovery = transcriptRecovery
  const web = S.createTab(s, { url: PAGE.url }, 0)
  const pushes = { chat: [], agents: [] }
  const reads = []
  const live = []
  const make = () => {
    const ai = createAi({
      dir: path.join(dir, 'ai'), version: '0.0.0', state: () => s, changed: () => {}, favicon: ICON, api, revokeAccess, pageGeneration, watching, machines,
      transcripts: createTranscripts({ dir: path.join(dir, 'journal'), state: () => s }),
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
  assert.deepEqual(s.settings.ai, { agents: [{ name: 'Fake', command: AGENT }], agent: 'Fake', model: '', effort: '', machine: '' })
  const [agent] = ai.agents()
  assert.deepEqual({ ...agent, models: agent.models.length, efforts: agent.efforts.length }, { name: 'Fake', command: AGENT, status: 'ready', error: '', info: { name: 'Fake agent', version: '1' }, models: 2, model: 'fake-small', efforts: 2, effort: 'low', loadSession: true, skill: null })
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
  assert.deepEqual(s.settings.ai, { agents: [], agent: '', model: '', effort: '', machine: '' })
  const { tabId, chatId } = ai.ask({ text: 'hello there' })
  assert.deepEqual(S.findTab(s, tabId).chat, { agent: '', sessionId: null })
  assert.equal(S.findTab(s, tabId).title, 'hello there')
  assert.deepEqual(ai.chat({ chatId }), { id: chatId, tabId, agent: '', machine: '', status: 'setup', error: '', pending: 'hello there', sessionId: null, models: null, model: null, efforts: null, effort: null, permission: null, turns: [] })
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
  assert.deepEqual((await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } })).result, { content: [{ type: 'text', text: 'bad_params: No tab x' }], isError: true })
  assert.equal((await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602)
  assert.deepEqual(await mcp({ jsonrpc: '2.0', id: 7, method: 'resources/list' }), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: resources/list' } })
  assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.deepEqual((await mcp([{ jsonrpc: '2.0', id: 8, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])).map((r) => r.id), [8])
})

test('handleMcp puts a known error code in front of the message and shows nothing else of an unexpected error', async () => {
  const failing = (error) => ({ name: 'x', inputSchema: { type: 'object' }, run: () => { throw error } })
  const text = async (error) => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }, { tools: [failing(error)], version: '0' })).result.content[0].text
  for (const code of ['user_has_control', 'forbidden', 'timeout', 'bad_params', 'not_found']) assert.equal(await text(S.err(code, 'why')), `${code}: why`)
  assert.equal(await text(new Error('plain')), 'plain')
  assert.equal(await text(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })), 'ENOENT: no such file')
})

test('handleMcp sends a picture as an image block, also from a screenshot step inside a chain, and keeps the base64 out of the text', async () => {
  const shot = { do: 'screenshot', tabId: 't1', mime: 'image/jpeg', width: 2, height: 1, data: '/9j/AA==' }
  const tools = [
    { name: 'one', inputSchema: { type: 'object' }, run: () => ({ ...shot, do: undefined }) },
    { name: 'chain', inputSchema: { type: 'object' }, run: () => ({ failed: { step: 3, do: 'click' }, results: [{ do: 'snapshot', text: 'e1' }, shot] }) }
  ]
  const call = async (name) => (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }, { tools, version: '0' })).result.content
  const [single, text] = await call('one')
  assert.deepEqual([single.type, text.type], ['image', 'text'])
  const [body, ...images] = await call('chain')
  assert.deepEqual(images, [{ type: 'image', data: '/9j/AA==', mimeType: 'image/jpeg' }])
  assert.deepEqual(JSON.parse(body.text), { failed: { step: 3, do: 'click' }, results: [{ do: 'snapshot', text: 'e1' }, { do: 'screenshot', tabId: 't1', mime: 'image/jpeg', width: 2, height: 1 }] })
})

test('browser tools use the owned registry and selected grant boundary rather than a second dispatcher', async () => {
  const s = S.load()
  const tab = S.createTab(s, { url: 'https://a.example/' }, 0)
  const chat = S.createTab(s, { activate: false }, 0, { id: 'c0123456789ab', agent: 'Fake', title: 'Hi', favicon: '' })
  const registry = createRegistry()
  const definition = (name, tool, properties, run) => registry.register('core', { name, description: name, tool: { name: tool }, inputSchema: { type: 'object', properties, additionalProperties: false }, run })
  definition('tabs.list', 'browser_list_tabs', {}, () => ({ tabs: s.tabs, activeTabId: S.activeTab(s)?.id }))
  definition('tabs.read', 'browser_read_page', { id: { type: 'string' } }, ({ id }) => ({ id, text: S.findTab(s, id).url }))
  definition('tabs.create', 'browser_open_tab', { url: { type: 'string' }, spaceId: { type: 'string' }, agent: { type: 'string' } }, (params) => S.createTab(s, params, 1))
  definition('tabs.navigate', 'browser_navigate', { id: { type: 'string' }, url: { type: 'string' } }, (params) => S.navigateTab(s, params, 2))
  const access = createAccess({ state: () => s })
  const grant = access.issue({ owner: 'Fake Agent', spaceIds: [tab.spaceId], read: true, mutate: true })
  const context = access.authorize(grant.token, { route: '/mcp', method: 'POST' })
  S.openIncognito(s)
  const secret = S.createTab(s, { url: 'https://secret.example/' }, 0)
  const tools = access.tools(context, browserTools({ registry }))
  const run = (name, params = {}) => tools.find((tool) => tool.name === name).run(params)
  assert.deepEqual((await run('browser_list_tabs')).tabs.map((item) => item.id), [tab.id, chat.id])
  assert.equal((await run('browser_open_tab', { url: 'https://b.example/' })).spaceId, tab.spaceId)
  await assert.rejects(run('browser_open_tab', { url: 'javascript:alert(1)' }), { code: 'bad_params' })
  await assert.rejects(run('browser_read_page', { tabId: secret.id }), { code: 'forbidden' })
  for (const name of ['browser_read_page', 'browser_navigate']) await assert.rejects(run(name, { tabId: chat.id, url: 'https://c.example/' }), { code: 'forbidden' })
  assert.equal((await run('browser_read_page', { tabId: tab.id })).text, tab.url)
  await assert.rejects(run('browser_read_page', { id: tab.id, tabId: secret.id }), { code: 'forbidden' })
  registry.dispose('core')
  await assert.rejects(run('browser_read_page', { tabId: tab.id }))
})

test('session credentials carry chat identity, are absent from warm sessions, and are revoked on cancel and stop', async () => {
  const issued = []
  const revoked = []
  const { ai, web } = setup({ api: (identity) => {
    issued.push(identity)
    const token = `session-token-${issued.length}`
    return { port: 1, token, revoke: () => revoked.push(token) }
  } })
  await ai.warm({ agent: 'Fake' })
  assert.deepEqual(issued, [])
  const first = ai.ask({ text: 'first', includePage: true })
  await settled(ai, first.chatId)
  assert.equal(issued[0].chatId, first.chatId)
  assert.equal(issued[0].tabId, web.id)
  assert.equal(issued[0].agent, 'Fake')
  const second = ai.ask({ text: 'second' })
  await settled(ai, second.chatId)
  assert.equal(issued[1].chatId, second.chatId)
  assert.equal(issued[1].tabId, null)
  ai.cancel({ chatId: first.chatId })
  assert.deepEqual(revoked, ['session-token-1'])
  ai.prompt({ chatId: first.chatId, text: 'again' })
  await settled(ai, first.chatId)
  assert.equal(issued.length, 3)
  ai.stop()
  assert.deepEqual(new Set(revoked), new Set(['session-token-1', 'session-token-2', 'session-token-3']))
})

test('local recovery is read-only when ACP cannot restore and only an explicit fresh prompt starts a new session', async () => {
  const { ai, make, dir } = setup({ transcriptRecovery: true })
  const { chatId } = ai.ask({ text: 'remember this locally' })
  const before = await settled(ai, chatId)
  ai.stop()
  fs.rmSync(path.join(dir, 'fake-sessions.json'))
  const next = make()
  const recovered = await settled(next, chatId)
  assert.deepEqual(recovered.recovery, { source: 'local', readOnly: true, requiresFresh: true, transcriptId: chatId })
  assert.ok(recovered.turns.some((turn) => turn.kind === 'user' && turn.text === 'remember this locally'))
  assert.throws(() => next.prompt({ chatId, text: 'do not silently replay' }), { code: 'bad_params' })
  next.prompt({ chatId, text: 'new context only', fresh: true })
  const fresh = await settled(next, chatId)
  assert.notEqual(fresh.sessionId, before.sessionId)
  assert.equal(fresh.recovery, undefined)
  const remote = stored(dir)[fresh.sessionId]
  assert.equal(JSON.stringify(remote).includes('remember this locally'), false)
  assert.equal(JSON.stringify(remote).includes('new context only'), true)
})

test('ACP session/load remains primary over an available local recovery journal', async () => {
  const { ai, make } = setup({ transcriptRecovery: true })
  const { chatId } = ai.ask({ text: 'remote context' })
  const before = await settled(ai, chatId)
  ai.stop()
  const next = make()
  const after = await settled(next, chatId)
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.recovery, undefined)
  assert.deepEqual(after.turns.map((turn) => [turn.kind, turn.text]), before.turns.map((turn) => [turn.kind, turn.text]))
})

test('cancel during credential acquisition revokes the late credential before any session can use it', async () => {
  let deliver
  let revoked = 0
  const { ai } = setup({ api: () => new Promise((resolve) => { deliver = resolve }) })
  const { chatId } = ai.ask({ text: 'cancel before opening session' })
  await until(() => deliver)
  ai.cancel({ chatId })
  deliver({ port: 1, token: 'late-token', revoke: () => { revoked++ } })
  const chat = await settled(ai, chatId)
  assert.equal(revoked, 1)
  assert.equal(chat.sessionId, null)
  assert.equal(last(ai, chatId).stopReason, 'cancelled')
})

test('a newly selected grant is attached on the next turn without replaying local history', async () => {
  let enabled = false
  const identities = []
  const { ai } = setup({ api: (identity) => {
    identities.push(identity)
    return enabled ? { port: 1, token: 'newly-selected', revoke() {} } : null
  } })
  const { chatId } = ai.ask({ text: 'no browser grant yet' })
  const first = await settled(ai, chatId)
  enabled = true
  ai.prompt({ chatId, text: 'grant now available' })
  const second = await settled(ai, chatId)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(identities.length, 2)
  assert.equal(identities[1].sessionId, first.sessionId)
  assert.equal(last(ai, chatId).text, `You said: grant now available${FOOT}`)
  assert.equal(kinds(second, 'user').length, 2)
})

test('replacing or removing an agent command revokes its owner grant even before it launches', () => {
  const revoked = []
  const { ai, s } = setup({ revokeAccess: (selector) => revoked.push(selector) })
  S.setSettings(s, { ai: { agents: [{ name: 'Fake', command: `${AGENT} --replaced` }] } })
  ai.settingsChanged()
  assert.deepEqual(revoked, [{ owner: 'Fake' }])
  S.setSettings(s, { ai: { agents: [] } })
  ai.settingsChanged()
  assert.deepEqual(revoked, [{ owner: 'Fake' }, { owner: 'Fake' }])
})

test('removing or replacing an agent while page extraction waits cannot launch the obsolete command', async () => {
  for (const replace of [false, true]) {
    let resolvePage
    const page = new Promise((resolve) => { resolvePage = resolve })
    const { ai, s, dir, reads, pushes } = setup({ page })
    const { chatId } = ai.ask({ text: 'must never reach the old agent', includePage: true })
    await until(() => reads.length === 1)
    S.setSettings(s, { ai: { agents: replace ? [{ name: 'Fake', command: `${AGENT} --replacement` }] : [] } })
    ai.settingsChanged()
    resolvePage(PAGE)
    await new Promise(setImmediate)
    const chat = await settled(ai, chatId)
    assert.equal(chat.status, 'error')
    assert.equal(chat.sessionId, null)
    assert.equal(last(ai, chatId).done, true)
    assert.equal(fs.existsSync(dir), false, 'the obsolete command must not even create its working directory')
    assert.equal(pushes.agents.some((entries) => entries.some((agent) => agent.status === 'starting')), false)
  }
})

test('explicit page context excludes peeks and retained private partitions before extraction', async () => {
  for (const excluded of [{ userPeek: true }, { sessionPartition: 'incognito-retained' }]) {
    const { ai, web, reads } = setup()
    Object.assign(web, excluded)
    const { chatId } = ai.ask({ text: 'no excluded page', tabId: web.id, includePage: true })
    const chat = await settled(ai, chatId)
    assert.deepEqual(reads, [])
    assert.equal(kinds(chat, 'user')[0].context, null)
    assert.equal(last(ai, chatId).text, `You said: no excluded page${FOOT}`)
  }
})

test('page eligibility is rechecked after extraction rather than trusting its original status', async () => {
  for (const excluded of [{ userPeek: true }, { agent: 'Other' }, { sessionPartition: 'incognito-late' }]) {
    let resolvePage
    const page = new Promise((resolve) => { resolvePage = resolve })
    const { ai, web, reads } = setup({ page })
    const { chatId } = ai.ask({ text: 'do not attach excluded text', tabId: web.id, includePage: true })
    await until(() => reads.length === 1)
    Object.assign(web, excluded)
    resolvePage(PAGE)
    const chat = await settled(ai, chatId)
    assert.equal(kinds(chat, 'user')[0].context, null)
    assert.equal(last(ai, chatId).text, `You said: do not attach excluded text${FOOT}`)
  }
})

test('page context is dropped if navigation, removal, space, document generation or privacy changes during ACP attachment', async () => {
  for (const change of ['navigate', 'remove', 'move', 'reload', 'private']) {
    let continueSession
    let generation = 1
    const { ai, s, web } = setup({ pageGeneration: () => generation, api: () => new Promise((resolve) => { continueSession = resolve }) })
    const { chatId } = ai.ask({ text: 'only this prompt', tabId: web.id, includePage: true })
    await until(() => continueSession)
    if (change === 'navigate') S.navigateTab(s, { id: web.id, url: 'https://new.example/' }, 1)
    if (change === 'reload') generation++
    if (change === 'remove') S.closeTab(s, { id: web.id }, 1)
    if (change === 'move') {
      const space = S.createSpace(s, { name: 'Destination' })
      S.moveTab(s, { id: web.id, spaceId: space.id }, 1)
    }
    if (change === 'private') web.sessionPartition = 'incognito-during-startup'
    continueSession(null)
    const chat = await settled(ai, chatId)
    assert.equal(kinds(chat, 'user')[0].context, null, change)
    assert.equal(last(ai, chatId).text, `You said: only this prompt${FOOT}`, change)
  }
})

test('a thread is in progress while it works, then active when watched and unread when not', async () => {
  let watched = false
  const { ai, s } = setup({ watching: () => watched })
  const bucket = (tabId) => S.bucketOf(S.findTab(s, tabId))
  const quiet = ai.ask({ text: 'hello' })
  assert.equal(bucket(quiet.tabId), 'progress')
  await settled(ai, quiet.chatId)
  assert.equal(bucket(quiet.tabId), 'unread')
  watched = true
  const seen = ai.ask({ text: 'hello again' })
  assert.equal(bucket(seen.tabId), 'progress')
  await settled(ai, seen.chatId)
  assert.equal(bucket(seen.tabId), 'active')
  watched = false
  ai.prompt({ chatId: seen.chatId, text: 'and again' })
  assert.equal(bucket(seen.tabId), 'progress')
  await settled(ai, seen.chatId)
  assert.equal(bucket(seen.tabId), 'unread')
  S.activateTab(s, { id: seen.tabId }, 1)
  assert.equal(bucket(seen.tabId), 'active')
})

test('a permission request ends the progress wait and the answer starts it again', async () => {
  let watched = false
  const { ai, s } = setup({ watching: () => watched })
  const bucket = (tabId) => S.bucketOf(S.findTab(s, tabId))
  const { tabId, chatId } = ai.ask({ text: 'please open https://example.org/x' })
  assert.equal(bucket(tabId), 'progress')
  await until(() => ai.chat({ chatId }).permission)
  assert.equal(ai.chat({ chatId }).status, 'running')
  assert.equal(bucket(tabId), 'unread')
  ai.permit({ chatId, optionId: 'allow' })
  assert.equal(bucket(tabId), 'progress')
  await settled(ai, chatId)
  assert.equal(bucket(tabId), 'unread')

  watched = true
  ai.prompt({ chatId, text: 'open https://example.org/y' })
  await until(() => ai.chat({ chatId }).permission)
  assert.equal(bucket(tabId), 'active')
  ai.permit({ chatId, cancel: true })
  await settled(ai, chatId)
  assert.equal(bucket(tabId), 'active')
})

test('a restored thread is in progress while it restores, then unread or active', async () => {
  let watched = false
  const { ai, make, s } = setup({ watching: () => watched })
  const { tabId, chatId } = ai.ask({ text: 'remember me' })
  await settled(ai, chatId)
  ai.stop()
  S.setBucket(s, { id: tabId, bucket: 'done' }, 5)
  const next = make()
  assert.equal(next.chat({ chatId }).status, 'restoring')
  assert.equal(S.bucketOf(S.findTab(s, tabId)), 'progress')
  assert.equal(S.findTab(s, tabId).doneAt, undefined)
  await settled(next, chatId)
  assert.equal(S.bucketOf(S.findTab(s, tabId)), 'unread')
  next.stop()
  S.setBucket(s, { id: tabId, bucket: 'done' }, 6)
  watched = true
  const again = make()
  again.chat({ chatId })
  await settled(again, chatId)
  assert.equal(S.bucketOf(S.findTab(s, tabId)), 'active')
})

test('a favorite or pinned thread keeps its bucket, and a thread moved by hand stays where it was put', async () => {
  const { ai, s } = setup()
  const bucket = (tabId) => S.bucketOf(S.findTab(s, tabId))
  const fav = ai.ask({ text: 'hello' })
  await settled(ai, fav.chatId)
  S.setFavorite(s, { id: fav.tabId, favorite: true }, 1)
  ai.prompt({ chatId: fav.chatId, text: 'more' })
  assert.equal(bucket(fav.tabId), 'favorites')
  await settled(ai, fav.chatId)
  assert.equal(bucket(fav.tabId), 'favorites')
  S.setPinned(s, { id: fav.tabId, pinned: true }, 2)
  ai.prompt({ chatId: fav.chatId, text: 'more again' })
  await settled(ai, fav.chatId)
  assert.deepEqual([bucket(fav.tabId), S.findTab(s, fav.tabId).status], ['later', undefined])

  const slow = ai.ask({ text: 'be slow' })
  assert.equal(bucket(slow.tabId), 'progress')
  S.setBucket(s, { id: slow.tabId, bucket: 'done' }, 3)
  await until(() => last(ai, slow.chatId).text.length >= 3)
  assert.equal(bucket(slow.tabId), 'done')
  ai.cancel({ chatId: slow.chatId })
  await settled(ai, slow.chatId)
  assert.equal(bucket(slow.tabId), 'done')
})

test('a chat waiting for an agent is active and does not move', () => {
  const { ai, s } = setup({ agents: [] })
  const { tabId } = ai.ask({ text: 'hello there' })
  assert.equal(S.bucketOf(S.findTab(s, tabId)), 'active')
})

test('a chat on another machine runs its own agent over ssh without Skiff tools, and moving a chat starts a fresh session there', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-ssh-'))
  const remote = path.join(fs.realpathSync(scratch), 'remote')
  fs.mkdirSync(remote)
  const bin = path.join(scratch, 'bin')
  fs.mkdirSync(bin)
  const logFile = path.join(scratch, 'ssh.log')
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> ${quote(logFile)}\nwhile [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done\nalias=$1\nshift\ncd ${quote(remote)}\nexport HOME=${quote(remote)} SHELL=/bin/sh FAKE_HOST="$alias"\nexec /bin/sh -c "$1"\n`, { mode: 0o755 })
  // A login shell that finds the stub ssh whatever the profile does to PATH.
  const shell = path.join(scratch, 'shell')
  fs.writeFileSync(shell, `#!/bin/sh\nPATH=${quote(bin)}:"$PATH" exec /bin/sh -c "$2"\n`, { mode: 0o755 })
  const saved = process.env.SHELL
  process.env.SHELL = shell
  test.after(() => {
    if (saved === undefined) delete process.env.SHELL
    else process.env.SHELL = saved
    fs.rmSync(scratch, { recursive: true, force: true })
  })
  const grants = []
  const machines = { list: async () => [{ id: '', name: 'This Mac' }, { id: 'host_box', name: 'Box' }], normalize: (id) => id || '', find: async (id) => (id === 'host_box' ? { id, name: 'Box', alias: 'box' } : null) }
  const { ai, s } = setup({ machines, api: () => { grants.push(1); return { port: 1, token: 'x' } } })

  const far = ai.ask({ text: 'where-fixture', machine: 'host_box' })
  await settled(ai, far.chatId)
  const near = ai.ask({ text: 'where-fixture', machine: '' })
  await settled(ai, near.chatId)
  assert.match(last(ai, far.chatId).text, new RegExp(`Host: box Cwd: ${remote} Mcp: none`))
  assert.match(last(ai, near.chatId).text, /Host: local Cwd: \S+\/ai Mcp: skiff/)
  assert.deepEqual(grants, [1])
  assert.deepEqual([ai.chat({ chatId: far.chatId }).machine, ai.chat({ chatId: near.chatId }).machine, S.findTab(s, far.tabId).chat.machine, S.findTab(s, near.tabId).chat.machine, s.settings.ai.machine], ['host_box', '', 'host_box', undefined, ''])
  assert.deepEqual(fs.readFileSync(logFile, 'utf8').trim().split('\n').sort(), [
    '-T -o BatchMode=yes -o ConnectTimeout=15 box printf %s "$HOME"',
    `-T -o BatchMode=yes -o ServerAliveInterval=30 box exec "\${SHELL:-/bin/sh}" -lc ${quote(AGENT)}`
  ].sort())

  // The same agent runs on both machines at once: moving the remote chat here keeps the local process and the old session id is gone.
  const before = ai.chat({ chatId: far.chatId }).sessionId
  await assert.rejects(() => ai.configure({ chatId: far.chatId, machine: 'x'.repeat(201) }), { code: 'bad_params' })
  const moved = await ai.configure({ chatId: far.chatId, machine: '' })
  assert.deepEqual([moved.machine, moved.sessionId, S.findTab(s, far.tabId).chat.sessionId, s.settings.ai.machine], ['', null, null, ''])
  assert.match(kinds(moved, 'notice').at(-1).text, /^Moved to This Mac\. The next message starts a fresh session there/)
  ai.prompt({ chatId: far.chatId, text: 'where-fixture' })
  await settled(ai, far.chatId)
  assert.match(last(ai, far.chatId).text, /Host: local .*Mcp: skiff/)
  assert.notEqual(ai.chat({ chatId: far.chatId }).sessionId, before)
  ai.prompt({ chatId: near.chatId, text: 'slow' })
  await assert.rejects(() => ai.configure({ chatId: near.chatId, machine: 'host_box' }), { code: 'bad_params', message: 'The agent is still working.' })
  ai.cancel({ chatId: near.chatId })
  await settled(ai, near.chatId)

  // A machine bb does not list is an error in the chat, not a hang.
  const gone = ai.ask({ text: 'hi', machine: 'host_gone' })
  await until(() => ai.chat({ chatId: gone.chatId }).status === 'error')
  assert.match(ai.chat({ chatId: gone.chatId }).error, /Machine host_gone is not in bb's machine list/)
})

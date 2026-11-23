'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAccess } = require('../src/access')
const { createRegistry, schemaFor } = require('../src/commands')
const { browserTools } = require('../src/ai')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createComponents } = require('../src/components')
const S = require('../src/state')

function setup() {
  const state = S.load()
  const a = S.createTab(state, { url: 'https://one.example/' }, 1)
  const b = S.createTab(state, { url: 'https://two.example/' }, 2)
  const registry = createRegistry()
  const access = createAccess({ state: () => state, registry })
  const authorize = (grant) => access.authorize(grant.token, { route: '/mcp', method: 'POST' })
  return { state, a, b, access, authorize, registry }
}

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('grants require explicit normal scope and permissions and never authorize owner routes', () => {
  const { state, a, access, authorize } = setup()
  assert.throws(() => access.issue({ owner: 'Agent', read: true }), { code: 'bad_params' })
  assert.throws(() => access.issue({ owner: 'Agent', tabIds: [a.id] }), { code: 'bad_params' })
  const privateSpace = S.openIncognito(state)
  const secret = S.createTab(state, { url: 'https://private.example/' }, 3)
  assert.throws(() => access.issue({ owner: 'Agent', spaceIds: [privateSpace.id], read: true }), { code: 'bad_params' })
  assert.throws(() => access.issue({ owner: 'Agent', tabIds: [secret.id], read: true }), { code: 'bad_params' })
  const grant = access.issue({ owner: 'Agent', tabIds: [a.id], read: true })
  for (const route of ['/rpc', '/events', '/mcp/', '/mcp?method=rpc', '/mcp/../rpc']) assert.throws(() => access.authorize(grant.token, { route, method: 'POST' }), { code: 'forbidden' })
  assert.throws(() => access.authorize(grant.token, { route: '/mcp', method: 'GET' }), { code: 'forbidden' })
  assert.throws(() => access.authorize(grant.token, { route: '/mcp', method: 'POST', params: { method: 'resources/read' } }), { code: 'forbidden' })
  assert.equal(authorize(grant).owner, 'Agent')
  assert.equal(JSON.stringify(access.list()).includes(grant.token), false)
  assert.throws(() => access.assert({ ...authorize(grant) }), { code: 'forbidden' })
})

test('owner MCP contexts restrict browsing without issuing or selecting an agent grant', async () => {
  const { state, a, b, access } = setup()
  const privateSpace = S.openIncognito(state)
  const secret = S.createTab(state, { url: 'https://private.example/' }, 3)
  const peek = { ...a, id: 'temporary-peek', userPeek: true }
  const agent = { ...a, id: 'hidden-agent', agent: 'Worker' }
  const orphan = { ...a, id: 'orphan', spaceId: 'removed-space' }
  const privatePartition = { ...a, id: 'private-partition', sessionPartition: 'incognito-test' }
  const chat = { ...a, id: 'conversation', chat: { agent: 'Worker' } }
  state.tabs.push(peek, agent, orphan, privatePartition, chat)
  const context = access.ownerBrowserContext()
  assert.equal(Object.isFrozen(context), true)
  assert.deepEqual(access.list(), [])
  assert.equal(access.selected({ owner: context.owner }), null)
  assert.throws(() => access.authorize(context.grantId, { route: '/mcp', method: 'POST' }), { code: 'forbidden' })
  assert.throws(() => access.assert({ ...context }), { code: 'forbidden' })
  assert.deepEqual(access.listNormalTabs().map((tab) => tab.id), [a.id, b.id, chat.id])
  let reads = 0
  const tools = access.tools(context, [
    { name: 'browser_list_tabs', run: () => ({ tabs: state.tabs, activeTabId: secret.id }) },
    { name: 'browser_read_page', run: ({ tabId, id }) => { reads++; return { id: tabId || id, text: 'Normal browser content' } } },
    { name: 'browser_open_tab', run: (params) => S.createTab(state, params, 4) },
    { name: 'components.source.write', run: () => assert.fail('owner MCP must not gain customization authority') },
    { name: 'settings.set', run: () => assert.fail('owner MCP must not gain host management authority') },
    { name: 'custom.tool', run: () => assert.fail('owner MCP must not gain unselected component tools') }
  ])
  assert.deepEqual(tools.map((tool) => tool.name), ['browser_list_tabs', 'browser_read_page', 'browser_open_tab'])
  assert.deepEqual(await tools[0].run(), { tabs: [a, b, chat], activeTabId: null })
  for (const excluded of [secret, peek, agent, orphan, privatePartition]) {
    await assert.rejects(tools[1].run({ tabId: excluded.id }), { code: 'forbidden', message: `No tab ${excluded.id}` })
    await assert.rejects(tools[1].run({ id: excluded.id }), { code: 'forbidden' })
  }
  await assert.rejects(tools[1].run({ tabId: chat.id }), { code: 'forbidden' })
  assert.equal(reads, 0)
  assert.equal((await tools[1].run({ tabId: a.id })).text, 'Normal browser content')
  await assert.rejects(tools[2].run({ spaceId: privateSpace.id, url: 'https://must-not-open.example/' }), { code: 'forbidden' })
  const created = await tools[2].run({ url: 'https://normal.example/' })
  assert.equal(created.spaceId, a.spaceId, 'An active private space cannot become the default creation target')
  assert.deepEqual(access.list(), [], 'Browser use never creates a selectable grant')
})

test('owner MCP privacy context reaches registry host dispatch and cannot authorize nested private reads', async () => {
  const { state, a, access, registry } = setup()
  S.openIncognito(state)
  const secret = S.createTab(state, { url: 'https://private.example/' }, 3)
  registry.register('core', { name: 'tabs.read', description: 'Read browser page', tool: { name: 'browser_read_page' }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, run: ({ id }) => ({ id, text: 'Public page' }) })
  const context = access.ownerBrowserContext()
  const tools = browserTools({ registry, call: (command, params, hostContext) => {
    assert.equal(hostContext.accessContext, context)
    access.assert(hostContext.accessContext, { command, params })
    assert.throws(() => access.assert(hostContext.accessContext, { command: 'tabs.read', params: { id: secret.id } }), { code: 'forbidden' })
    assert.throws(() => access.assert(hostContext.accessContext, { command: 'grants.issue', params: { owner: 'Escalated' } }), { code: 'forbidden' })
    return registry.call(command, params, hostContext)
  } })
  assert.deepEqual(await access.tools(context, tools)[0].run({ tabId: a.id }), { id: a.id, text: 'Public page' })
})

test('owner MCP revalidates page and list results after awaits, including late errors and stop', async () => {
  for (const command of ['browser_read_page', 'tabs.capture']) for (const invalidation of ['removed-space', 'private-space', 'private-partition']) for (const rejects of [false, true]) {
    const { state, a, access } = setup()
    let resolve, reject
    const pending = new Promise((yes, no) => { resolve = yes; reject = no })
    const context = access.ownerBrowserContext()
    const read = access.tools(context, [{ name: command, run: () => pending }])[0]
    const result = read.run({ tabId: a.id })
    if (invalidation === 'removed-space') state.spaces = state.spaces.filter((space) => space.id !== a.spaceId)
    else if (invalidation === 'private-space') a.spaceId = S.openIncognito(state).id
    else a.sessionPartition = 'incognito-during-read'
    if (rejects) reject(new Error('Sensitive late page content'))
    else resolve({ text: 'Sensitive late page content' })
    await assert.rejects(result, { code: 'forbidden', message: `No tab ${a.id}` })
  }
  const { state, a, access } = setup()
  const pending = deferred()
  const context = access.ownerBrowserContext()
  const tools = access.tools(context, [
    { name: 'browser_list_tabs', run: () => pending.promise },
    { name: 'browser_read_page', run: () => pending.promise }
  ])
  const listed = tools[0].run()
  a.userPeek = true
  pending.resolve({ tabs: [a], activeTabId: a.id })
  assert.deepEqual(await listed, { tabs: [], activeTabId: null })
  const other = access.ownerBrowserContext()
  access.stop()
  assert.equal(context.signal.aborted, true)
  assert.equal(other.signal.aborted, true)
  await assert.rejects(tools[1].run({ tabId: a.id }), { code: 'forbidden' })
  assert.throws(() => access.ownerBrowserContext(), { code: 'forbidden' })
})

test('read tool discovery and tab listing are narrowed, including active tab metadata', async () => {
  const { state, a, b, access, authorize } = setup()
  const grant = access.issue({ owner: 'Agent', tabIds: [a.id], read: true })
  const tools = access.tools(authorize(grant), [
    { name: 'browser_list_tabs', run: () => ({ tabs: state.tabs, activeTabId: b.id }) },
    { name: 'browser_read_page', run: ({ tabId }) => ({ id: tabId, text: 'Visible page' }) },
    { name: 'browser_close_tab', run: () => { throw new Error('mutation must not run') } },
    { name: 'settings.set', run: () => { throw new Error('global command must not run') } },
    { name: '__proto__', run: () => { throw new Error('inherited property must not run') } }
  ])
  assert.deepEqual(tools.map((tool) => tool.name), ['browser_list_tabs', 'browser_read_page'])
  const listed = await tools[0].run()
  assert.deepEqual(listed.tabs.map((tab) => tab.id), [a.id])
  assert.equal(listed.activeTabId, null)
  await assert.rejects(tools[1].run(), { code: 'forbidden' })
  await assert.rejects(tools[1].run({ tabId: b.id }), { code: 'forbidden' })
  assert.equal((await tools[1].run({ tabId: a.id })).text, 'Visible page')
})

test('mutation cannot create outside selected spaces or inject private partitions', async () => {
  const { state, a, access, authorize } = setup()
  const grant = access.issue({ owner: 'Agent', spaceIds: [a.spaceId], mutate: true })
  const tool = access.tools(authorize(grant), [{ name: 'browser_open_tab', run: (params) => S.createTab(state, params, 3) }])[0]
  const created = await tool.run({ url: 'https://new.example/' })
  assert.equal(created.spaceId, a.spaceId)
  await assert.rejects(tool.run({ url: 'https://new.example/', sessionPartition: 'incognito-other' }), { code: 'forbidden' })
  await assert.rejects(tool.run({ url: 'file:///etc/passwd' }), { code: 'bad_params' })
  const selectedOnly = access.issue({ owner: 'Agent', tabIds: [a.id], mutate: true })
  const selectedTool = access.tools(authorize(selectedOnly), [{ name: 'browser_open_tab', run: (params) => S.createTab(state, params, 3) }])[0]
  await assert.rejects(selectedTool.run({ url: 'https://new.example/' }), { code: 'forbidden' })
})

test('nested MCP and host scoping creates tabs without injecting an active-tab id', async () => {
  const { state, a, access, authorize, registry } = setup()
  registry.register('core', {
    name: 'tabs.create', description: 'Open browser tab', tool: { name: 'browser_open_tab' }, inputSchema: schemaFor('tabs.create'),
    run: (params) => {
      assert.equal(Object.hasOwn(params, 'id'), false)
      assert.equal(Object.hasOwn(params, 'tabId'), false)
      return S.createTab(state, params, 3)
    }
  })
  const grant = access.issue({ owner: 'Agent', spaceIds: [a.spaceId], mutate: true, commands: ['tabs.create'] })
  const child = access.issue({ owner: 'Agent', parentId: grant.id, sessionId: 'chat', spaceIds: [a.spaceId], mutate: true, commands: ['tabs.create'] })
  const available = browserTools({ registry, call: (command, params, context) => {
    // Main dispatch rechecks the same opaque scope after the MCP adapter resolves defaults.
    const [permitted] = access.tools(context.accessContext, [{ name: command, command, run: (bounded) => registry.call(command, bounded, context) }])
    return permitted.run(params)
  } })
  for (const context of [authorize(child), access.ownerBrowserContext()]) {
    const [open] = access.tools(context, available)
    for (const explicit of [false, true]) {
      const created = await open.run({ url: 'https://opened.example/', ...(explicit && { spaceId: a.spaceId }) })
      assert.equal(created.spaceId, a.spaceId)
      assert.equal(created.url, 'https://opened.example/')
      assert.notEqual(created.id, a.id)
    }
    await assert.rejects(open.run({ url: 'https://invalid.example/', spaceId: a.spaceId, id: a.id }), { code: 'bad_params' })
  }
})

test('revoking a parent cancels its session child and suppresses pending read output', async () => {
  const { a, access, authorize } = setup()
  const grant = access.issue({ owner: 'Agent', tabIds: [a.id], read: true, commands: ['tabs.read'] })
  const child = access.issue({ owner: 'Agent', parentId: grant.id, sessionId: 'session-a', tabIds: [a.id], read: true, commands: ['tabs.read'] })
  assert.throws(() => access.issue({ owner: 'Agent', parentId: grant.id, tabIds: [a.id], read: true, mutate: true, commands: ['tabs.read'] }), { code: 'forbidden' })
  const context = authorize(child)
  const pending = deferred()
  const tool = access.tools(context, [{ name: 'browser_read_page', run: () => pending.promise }])[0]
  const result = tool.run({ tabId: a.id })
  assert.deepEqual(access.revoke({ id: grant.id }).revoked, [grant.id, child.id])
  assert.equal(context.signal.aborted, true)
  pending.resolve({ text: 'MUST NOT LEAK' })
  await assert.rejects(result, { code: 'forbidden' })
  assert.throws(() => authorize(child), { code: 'forbidden' })
})

test('scope and private status are rechecked after the page await; stop revokes all tokens', async () => {
  const { state, a, access, authorize } = setup()
  const grant = access.issue({ owner: 'Agent', tabIds: [a.id], read: true })
  const pending = deferred()
  const tool = access.tools(authorize(grant), [{ name: 'browser_read_page', run: () => pending.promise }])[0]
  const result = tool.run({ tabId: a.id })
  state.spaces.find((space) => space.id === a.spaceId).incognito = true
  pending.resolve({ text: 'NOW PRIVATE' })
  await assert.rejects(result, { code: 'forbidden' })
  access.stop()
  assert.deepEqual(access.list(), [])
  assert.throws(() => authorize(grant), { code: 'forbidden' })
})

test('revocation suppresses sensitive late errors as well as successful page results', async () => {
  const { a, access, authorize } = setup()
  const grant = access.issue({ owner: 'Agent', tabIds: [a.id], read: true })
  let reject
  const waiting = new Promise((_resolve, no) => { reject = no })
  const tool = access.tools(authorize(grant), [{ name: 'browser_read_page', run: () => waiting }])[0]
  const result = tool.run({ tabId: a.id })
  access.revoke({ owner: 'Agent' })
  reject(new Error('Private page data in a backend error'))
  await assert.rejects(result, (error) => error.code === 'forbidden' && !error.message.includes('Private page data'))
})

test('custom tools require exact live component consent and preserve arbitrary tool schemas', async () => {
  const { a, access, authorize, registry } = setup()
  registry.register('tabs', {
    name: 'tabs.compare', description: 'Compare two caller-provided strings', tool: { name: 'compare_strings' },
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, tabId: { type: 'string' } }, required: ['id', 'tabId'], additionalProperties: false },
    run: ({ id, tabId }) => ({ equal: id === tabId, lengthDifference: id.length - tabId.length })
  })
  registry.register('notes', {
    name: 'notes.count', description: 'Count words', tool: true,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    run: ({ text }) => ({ words: text.trim().split(/\s+/).filter(Boolean).length })
  })
  registry.register('core', { name: 'settings.get', description: 'Global settings', tool: true, inputSchema: { type: 'object' }, run: () => ({ secret: true }) })
  registry.register('notes', { name: 'notes.hidden', description: 'Not a tool', tool: false, inputSchema: { type: 'object' }, run: () => null })
  const browserOnly = access.issue({ owner: 'Agent', tabIds: [a.id], read: true })
  assert.deepEqual(access.tools(authorize(browserOnly), browserTools({ registry })), [])
  for (const name of ['settings.get', 'notes.hidden', 'notes.missing']) assert.throws(() => access.issue({ owner: 'Agent', tools: [name] }), { code: 'bad_params' })
  const grant = access.issue({ owner: 'Agent', tools: ['tabs.compare', 'notes.count'] })
  assert.equal(grant.read, false)
  assert.equal(grant.mutate, false)
  assert.deepEqual(grant.tabIds, [])
  const tools = access.tools(authorize(grant), browserTools({ registry }))
  assert.deepEqual(await tools.find((tool) => tool.command === 'tabs.compare').run({ id: 'longer', tabId: 'x' }), { equal: false, lengthDifference: 5 })
  assert.deepEqual(await tools.find((tool) => tool.command === 'notes.count').run({ text: 'one two three' }), { words: 3 })
  const child = access.issue({ owner: 'Agent', parentId: grant.id, sessionId: 'session-one', tools: ['notes.count'] })
  assert.deepEqual(child.tools, ['notes.count'])
  assert.throws(() => access.issue({ owner: 'Agent', parentId: child.id, tools: ['tabs.compare'] }), { code: 'forbidden' })
  const shown = access.list().find((item) => item.id === child.id)
  shown.tools.push('tabs.compare')
  assert.deepEqual(access.list().find((item) => item.id === child.id).tools, ['notes.count'])
})

test('custom tools revalidate revocation and live registrations across asynchronous work', async () => {
  const { access, authorize, registry } = setup()
  const gate = deferred()
  registry.register('notes', { name: 'notes.wait', description: 'Wait for local work', tool: true, inputSchema: { type: 'object', additionalProperties: false }, run: () => gate.promise })
  const parent = access.issue({ owner: 'Agent', tools: ['notes.wait'] })
  const child = access.issue({ owner: 'Agent', parentId: parent.id, sessionId: 'session-one', tools: ['notes.wait'] })
  const tool = access.tools(authorize(child), browserTools({ registry }))[0]
  const waiting = tool.run({})
  await Promise.resolve()
  access.revoke({ id: parent.id })
  gate.resolve({ secret: 'late custom result' })
  await assert.rejects(waiting, { code: 'forbidden' })
  const next = access.issue({ owner: 'Agent', tools: ['notes.wait'] })
  const cached = access.tools(authorize(next), browserTools({ registry }))[0]
  registry.dispose('notes')
  await assert.rejects(cached.run({}), { code: 'forbidden' })
  assert.deepEqual(access.tools(authorize(next), browserTools({ registry })), [])
})

test('custom tools retain the opaque caller context and cannot escape its nested browser scope', async () => {
  const { state, a, b, access, authorize, registry } = setup()
  const schema = { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }
  registry.register('core', { name: 'tabs.read', description: 'Read a selected page', tool: { name: 'browser_read_page' }, inputSchema: schema, run: ({ id }) => ({ id, text: S.findTab(state, id).url }) })
  registry.register('core', { name: 'tabs.list', description: 'List pages', tool: { name: 'browser_list_tabs' }, inputSchema: { type: 'object', additionalProperties: false }, run: () => ({ tabs: state.tabs, activeTabId: b.id }) })
  registry.register('core', { name: 'tabs.close', description: 'Close a selected page', tool: { name: 'browser_close_tab' }, inputSchema: schema, run: (params) => S.closeTab(state, params, 4) })
  const nested = (context, command, params) => {
    access.assert(context.accessContext)
    const tool = access.tools(context.accessContext, browserTools({ registry })).find((candidate) => candidate.command === command)
    if (!tool) throw Object.assign(new Error('Nested command is not granted'), { code: 'forbidden' })
    return tool.run(params)
  }
  registry.register('notes', { name: 'notes.read', description: 'Measure a page URL', tool: true, inputSchema: schema, run: async (params, context) => ({ length: (await nested(context, 'tabs.read', params)).text.length }) })
  registry.register('notes', { name: 'notes.pages', description: 'Count selected pages', tool: true, inputSchema: { type: 'object', additionalProperties: false }, run: async (_params, context) => ({ count: (await nested(context, 'tabs.list', {})).tabs.length }) })
  registry.register('notes', { name: 'notes.close', description: 'Close a page', tool: true, inputSchema: schema, run: (params, context) => nested(context, 'tabs.close', params) })
  const grant = access.issue({ owner: 'Agent With Spaces', tools: ['notes.read', 'notes.pages', 'notes.close'], tabIds: [a.id], read: true })
  const tools = access.tools(authorize(grant), browserTools({ registry }))
  const read = tools.find((tool) => tool.command === 'notes.read')
  assert.deepEqual(await read.run({ id: a.id }), { length: a.url.length })
  await assert.rejects(read.run({ id: b.id }), { code: 'forbidden' })
  assert.deepEqual(await tools.find((tool) => tool.command === 'notes.pages').run({}), { count: 1 })
  await assert.rejects(tools.find((tool) => tool.command === 'notes.close').run({ id: a.id }), { code: 'forbidden' })
  assert.ok(state.tabs.includes(a), 'a custom tool grant cannot upgrade read-only browser permission')
  S.openIncognito(state)
  const secret = S.createTab(state, { url: 'https://private.example/' }, 3)
  await assert.rejects(read.run({ id: secret.id }), { code: 'forbidden' })
  const customOnly = access.issue({ owner: 'Agent', tools: ['notes.read'] })
  const isolated = access.tools(authorize(customOnly), browserTools({ registry }))[0]
  await assert.rejects(isolated.run({ id: a.id }), { code: 'forbidden' })
  assert.throws(() => access.assert({ ...authorize(grant) }), { code: 'forbidden' })
})

test('grant selection is explicit, independent per conversation, and never falls back after revocation', () => {
  const { a, b, access, authorize } = setup()
  const first = access.issue({ owner: 'Agent', tabIds: [a.id], read: true })
  const second = access.issue({ owner: 'Agent', tabIds: [b.id], read: true })
  const customize = access.issue({ owner: 'Agent', components: ['owned.layout'] })
  assert.equal(access.selected({ owner: 'Agent', sessionId: 'chat-a' }), null)
  access.select({ id: first.id })
  const aChild = access.issue({ owner: 'Agent', parentId: first.id, sessionId: 'chat-a', tabIds: [a.id], read: true })
  const aGrandchild = access.issue({ owner: 'Agent', parentId: aChild.id, sessionId: 'chat-a', tabIds: [a.id], read: true })
  const bChild = access.issue({ owner: 'Agent', parentId: first.id, sessionId: 'chat-b', tabIds: [a.id], read: true })
  assert.throws(() => access.select({ id: aChild.id }), { code: 'bad_params' })
  access.select({ id: second.id, sessionId: 'chat-b' })
  assert.throws(() => authorize(bChild), { code: 'forbidden' })
  access.assert(authorize(aChild))
  const replacement = access.issue({ owner: 'Agent', parentId: second.id, sessionId: 'chat-b', tabIds: [b.id], read: true })
  access.select({ id: customize.id })
  assert.throws(() => authorize(aChild), { code: 'forbidden' })
  assert.throws(() => authorize(aGrandchild), { code: 'forbidden' })
  access.assert(authorize(replacement))
  assert.equal(access.selected({ owner: 'Agent', sessionId: 'chat-a' }).id, customize.id)
  assert.equal(access.selected({ owner: 'Agent', sessionId: 'chat-b' }).id, second.id)
  assert.deepEqual(access.selected({ owner: 'Agent' }).components, ['owned.layout'])
  assert.equal(access.selected({ owner: 'Agent' }).read, false, 'selecting customization does not silently merge browser authority')
  access.revoke({ id: second.id })
  assert.equal(access.selected({ owner: 'Agent', sessionId: 'chat-b' }), null, 'revocation must not inherit the global grant')
  assert.throws(() => authorize(replacement), { code: 'forbidden' })
  assert.deepEqual(access.list().find((grant) => grant.id === customize.id).selectedFor, [null])
  const restricted = access.issue({ owner: 'Agent', sessionId: 'chat-c', components: ['owned.other'] })
  assert.throws(() => access.select({ id: restricted.id, sessionId: 'chat-d' }), { code: 'bad_params' })
  assert.throws(() => access.issue({ owner: 'Agent', parentId: restricted.id, sessionId: 'chat-d', components: ['owned.other'] }), { code: 'forbidden' })
})

test('customization scope operates on real owned source and adopts only authorized namespace copies', async (t) => {
  const { state, a, access, authorize, registry } = setup()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-customization-access-'))
  const components = createComponents({ dir: path.join(root, 'components'), registry, state: () => state })
  t.after(async () => { await components.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  await components.start()
  components.register(registry)
  await components.create({ id: 'owned.layout', role: 'launcher' })
  const other = await components.create({ id: 'other.layout', role: 'launcher' })
  const grant = access.issue({ owner: 'Agent', components: ['owned.layout'] })
  const child = access.issue({ owner: 'Agent', sessionId: 'chat-customize', parentId: grant.id, components: ['owned.layout'] })
  const context = authorize(child)
  const dispatched = []
  const hostCall = (name, params, caller) => {
    assert.equal(caller.accessContext, context, 'host receives the authenticated object, not a reconstructed grant id')
    access.assert(caller.accessContext, { command: name, params })
    dispatched.push(name)
    if (['components.apply', 'components.enable', 'components.revert'].includes(name)) throw Object.assign(new Error('Native consent declined'), { code: 'forbidden' })
    return registry.call(name, params, caller)
  }
  const available = browserTools({ registry, call: hostCall })
  const checkSchema = access.tools(context, available).find((item) => item.command === 'components.check').inputSchema
  assert.ok(checkSchema.required.includes('id'))
  assert.equal(checkSchema.properties.path, undefined, 'scoped discovery must not advertise arbitrary source paths')
  const run = (name, params = {}) => {
    const tool = access.tools(context, available).find((item) => item.command === name)
    assert.ok(tool, name)
    return tool.run(params)
  }
  assert.deepEqual((await run('components.list')).map((item) => item.id), ['owned.layout'])
  await assert.rejects(run('components.inspect', { id: 'other.layout' }), { code: 'forbidden' })
  await assert.rejects(run('components.inspect'), { code: 'forbidden' })
  await assert.rejects(run('components.check', { id: 'owned.layout', path: other.path }), { code: 'forbidden' })
  await run('components.source.write', { id: 'owned.layout', file: 'index.html', content: '<!doctype html><main>Scoped source edit</main>' })
  assert.match((await run('components.source.read', { id: 'owned.layout', file: 'index.html' })).content, /Scoped source edit/)
  assert.equal((await run('components.check', { id: 'owned.layout' })).ok, true)
  const copyId = `${grant.componentNamespace}.copy`
  await assert.rejects(run('components.create', { id: copyId, from: 'other.layout' }), { code: 'forbidden' })
  await assert.rejects(run('components.create', { id: 'unapproved.copy', from: 'owned.layout' }), { code: 'forbidden' })
  await assert.rejects(run('components.create', { id: 'stock.copy', from: 'owned.layout' }), { code: 'forbidden' })
  const copy = await run('components.create', { id: copyId, from: 'owned.layout' })
  assert.equal(copy.id, copyId)
  assert.match((await run('components.source.read', { id: copyId, file: 'index.html' })).content, /Scoped source edit/)
  assert.ok(access.list().find((item) => item.id === grant.id).components.includes(copyId))
  assert.ok(access.list().find((item) => item.id === child.id).components.includes(copyId))
  assert.deepEqual(new Set((await run('components.list')).map((item) => item.id)), new Set(['owned.layout', copyId]))
  assert.equal(access.tools(context, available).some((item) => ['components.stage', 'components.remove', 'components.storage.read'].includes(item.command)), false)
  await assert.rejects(run('components.apply', { id: copyId }), { code: 'forbidden', message: 'Native consent declined' })
  assert.equal(components.inspect({ id: copyId }).revision, null, 'MCP must reach the consent dispatcher, not call the registry activation directly')
  const withoutHost = access.tools(context, browserTools({ registry })).find((item) => item.command === 'components.apply')
  await assert.rejects(withoutHost.run({ id: copyId }), { code: 'forbidden', message: 'Component customization requires the host consent dispatcher' })
  const browserOnly = access.issue({ owner: 'Browser', tabIds: [a.id], read: true })
  assert.equal(access.tools(authorize(browserOnly), available).some((item) => item.command.startsWith('components.')), false)
  assert.ok(dispatched.includes('components.source.write'))
  const privateSpace = S.openIncognito(state)
  await assert.rejects(run('components.bind', { id: copyId, role: 'launcher', spaceId: privateSpace.id }), { code: 'forbidden' })
})

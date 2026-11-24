'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRegistry, schemaFor, validateSchema } = require('../src/commands')
const settings = require('../src/settings-catalog')

const empty = { type: 'object', properties: {}, additionalProperties: false }
const definition = (name, run = () => null, extra = {}) => ({ name, description: `Run ${name}`, inputSchema: empty, run, ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

// These tests exercise public behavior; no Electron or source-string assertions.
test('typed input rejects before execution and typed output rejects bad results', async () => {
  const registry = createRegistry()
  let calls = 0
  registry.register('stock.test', definition('sample.add', ({ count, options }) => { calls++; return count + options.offset }, {
    inputSchema: { type: 'object', required: ['count', 'options'], additionalProperties: false, properties: {
      count: { type: 'integer', minimum: 1, maximum: 9 },
      options: { type: 'object', required: ['offset'], additionalProperties: false, properties: { offset: { type: 'number' } } }
    } },
    outputSchema: { type: 'number' }
  }))
  for (const params of [null, [], { count: '2', options: { offset: 1 } }, { count: 2 }, { count: 2, options: { offset: NaN } }, { count: 10, options: { offset: 0 } }, { count: 2, options: { offset: 1, surprise: true } }, { count: 2, options: { offset: 1 }, surprise: true }]) {
    await assert.rejects(registry.call('sample.add', params), { code: 'bad_params' })
  }
  assert.equal(calls, 0)
  assert.equal(await registry.call('sample.add', { count: 2, options: { offset: 0.5 } }), 2.5)
  registry.register('stock.test', definition('sample.broken', () => 'not a number', { outputSchema: { type: 'number' } }))
  await assert.rejects(registry.call('sample.broken'), { code: 'bad_result' })
  await assert.rejects(registry.call('toString'), { code: 'unknown_method' })
})

test('dispatch uses a validated snapshot even when callers mutate inputs before execution', async () => {
  const registry = createRegistry()
  const seen = []
  registry.register('core', definition('sample.snapshot', (params, context) => {
    seen.push({ id: params.id, count: params.nested.count, owner: context.owner })
    params.nested.count = 99
    return params.id
  }, { inputSchema: { type: 'object', required: ['id', 'nested'], additionalProperties: false, properties: {
    id: { type: 'string' },
    nested: { type: 'object', required: ['count'], additionalProperties: false, properties: { count: { type: 'integer' } } }
  } } }))
  const params = { id: 'approved', nested: { count: 1 } }
  const context = { owner: 'component.original' }
  const pending = registry.call('sample.snapshot', params, context)
  params.id = 'different-target'
  params.nested.count = 'invalid'
  context.owner = 'component.changed'
  assert.equal(await pending, 'approved')
  assert.deepEqual(seen, [{ id: 'approved', count: 1, owner: 'component.original' }])
  assert.equal(params.nested.count, 'invalid')
  await assert.rejects(registry.call('sample.snapshot', { id: 'approved', nested: { count: () => 1 } }), { code: 'bad_params' })
})

test('core movement schemas reject negative indexes and undersized desk windows before execution', async () => {
  const registry = createRegistry()
  const calls = []
  for (const name of ['tabs.move', 'desk.place']) registry.register('core', definition(name, (params) => { calls.push({ name, params }); return params }, { inputSchema: schemaFor(name) }))
  await assert.rejects(registry.call('tabs.move', { id: 'tab', index: -1 }), { code: 'bad_params' })
  await assert.rejects(registry.call('desk.place', { id: 'tab', x: 0, y: 0, width: 239, height: 160 }), { code: 'bad_params' })
  await assert.rejects(registry.call('desk.place', { id: 'tab', x: 0, y: 0, width: 240, height: 159 }), { code: 'bad_params' })
  assert.equal(calls.length, 0)
  await registry.call('tabs.move', { id: 'tab', index: 0 })
  await registry.call('desk.place', { id: 'tab', x: 0, y: 0, width: 240, height: 160 })
  assert.equal(calls.length, 2)
})

test('registration rejects unsupported schemas and leaves no partial aliases', () => {
  const registry = createRegistry()
  assert.throws(() => registry.register('stock.test', definition('bad.schema', () => null, { inputSchema: { type: 'object', patternProperties: { '^a': { type: 'string' } } } })), { code: 'bad_schema' })
  assert.throws(() => registry.register('stock.test', definition('bad.pattern', () => null, { inputSchema: { type: 'string', pattern: '[' } })), { code: 'bad_schema' })
  assert.throws(() => registry.register('stock.test', definition('bad.missing', () => null, { inputSchema: undefined })), { code: 'bad_schema' })
  assert.deepEqual(registry.list(), [])
})

test('names and aliases collide deterministically without replacing either owner', async () => {
  const registry = createRegistry()
  const first = registry.register('core', definition('tabs.read', () => 'first', { aliases: ['read-page'] }))
  for (const [name, aliases] of [['tabs.read', []], ['other.read', ['read-page']], ['read-page', []], ['same.alias', ['same.alias']]]) {
    assert.throws(() => registry.register('component.test', definition(name, () => 'second', { aliases })), { code: 'command_collision' })
  }
  assert.equal(registry.has('other.read'), false)
  assert.equal(await registry.call('read-page'), 'first')
  assert.equal(registry.list().length, 1)
  assert.equal(first(), true)
  assert.equal(first(), false)
  assert.equal(registry.has('read-page'), false)
  registry.register('component.test', definition('tabs.read', () => 'new'))
  assert.equal(first(), false)
  assert.equal(await registry.call('tabs.read'), 'new')
})

test('public tool names reject core and custom collisions without reserving command aliases', async () => {
  const registry = createRegistry()
  registry.register('core', definition('tabs.read', () => 'core', { tool: { name: 'browser_read_page' } }))
  registry.register('component.one', definition('one.read', () => 'custom', { tool: { name: 'custom_read_page' } }))
  for (const name of ['browser_read_page', 'custom_read_page']) {
    assert.throws(() => registry.register('component.two', definition('two.read', () => 'shadow', { aliases: ['two.alias'], tool: { name } })), { code: 'command_collision' })
    assert.equal(registry.has('two.read'), false)
    assert.equal(registry.has('two.alias'), false)
  }
  registry.register('component.two', definition('browser_read_page', () => 'command only'))
  assert.equal(await registry.call('browser_read_page'), 'command only')
  assert.equal(await registry.call('tabs.read'), 'core')
  assert.deepEqual(registry.list({ tool: true }).map((entry) => entry.tool.name).sort(), ['browser_read_page', 'custom_read_page'])
  registry.register('component.three', definition('three.read', () => null, { tool: true }))
  assert.throws(() => registry.register('component.two', definition('two.read', () => null, { tool: { name: 'three.read' } })), { code: 'command_collision' })
  registry.register('component.four', definition('four.read', () => null, { tool: {} }))
  assert.throws(() => registry.register('component.two', definition('two.read', () => null, { tool: { name: 'four.read' } })), { code: 'command_collision' })
})

test('malformed public tool names fail atomically', () => {
  const registry = createRegistry()
  for (const name of ['', 'has spaces', 'bad/name', 12, null, false, {}]) {
    assert.throws(() => registry.register('component.test', definition('test.read', () => null, { aliases: ['test.alias'], tool: { name } })), { code: 'bad_params' })
    assert.deepEqual(registry.list(), [])
  }
})

test('individual and owner disposal release tool names without stale disposers removing replacements', async () => {
  const registry = createRegistry()
  const remove = registry.register('component.first', definition('first.read', () => 'first', { tool: { name: 'public_read' } }))
  remove()
  registry.register('component.second', definition('second.read', () => 'second', { tool: { name: 'public_read' } }))
  remove()
  assert.throws(() => registry.register('component.third', definition('third.read', () => null, { tool: { name: 'public_read' } })), { code: 'command_collision' })
  registry.dispose('component.second')
  registry.register('component.third', definition('third.read', () => 'third', { tool: { name: 'public_read' } }))
  assert.equal(await registry.call('third.read'), 'third')
})

test('metadata is detached, serializable, sorted and never implies tool exposure', () => {
  const registry = createRegistry()
  const inputSchema = { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false }
  registry.register('stock.tools', definition('z.hidden', () => null, { visible: false }))
  registry.register('core', definition('a.visible', () => null, { inputSchema, title: 'Visible action', aliases: ['quick'], tool: { name: 'visible_action', readOnly: true } }))
  inputSchema.properties.label.type = 'number'
  const metadata = registry.get('quick')
  assert.equal(metadata.name, 'a.visible')
  assert.equal(metadata.run, undefined)
  assert.equal(metadata.inputSchema.properties.label.type, 'string')
  metadata.inputSchema.properties.label.type = 'boolean'
  assert.equal(registry.get('quick').inputSchema.properties.label.type, 'string')
  assert.deepEqual(registry.list().map((entry) => entry.name), ['a.visible', 'z.hidden'])
  assert.deepEqual(registry.list({ visible: true }).map((entry) => entry.name), ['a.visible'])
  assert.deepEqual(registry.list({ tool: true }).map((entry) => entry.name), ['a.visible'])
  assert.deepEqual(registry.list({ owner: 'stock.tools' }).map((entry) => entry.name), ['z.hidden'])
  assert.deepEqual(JSON.parse(JSON.stringify(registry.list())), registry.list())
  assert.equal(registry.get('z.hidden').tool, false)
})

test('disposing owner cancels a running generation and ignores a late result', async () => {
  const registry = createRegistry()
  const old = deferred()
  let signal, oldGeneration
  registry.register('component.clock', definition('clock.read', (_p, context) => { signal = context.signal; oldGeneration = context.generation; return old.promise }))
  const pending = registry.call('clock.read')
  await Promise.resolve()
  const rejection = assert.rejects(pending, { code: 'cancelled' })
  assert.equal(registry.dispose('component.clock'), 1)
  assert.equal(signal.aborted, true)
  registry.register('component.clock', definition('clock.read', (_p, context) => ({ value: 'current', generation: context.generation })))
  old.resolve('stale')
  await rejection
  const current = await registry.call('clock.read')
  assert.equal(current.value, 'current')
  assert.notEqual(current.generation, oldGeneration)
})

test('caller disposal and caller AbortSignal cancel without disposing the service', async () => {
  const registry = createRegistry()
  let received
  registry.register('core', definition('service.wait', (_p, context) => { received = context.signal; return new Promise(() => {}) }))
  const pending = registry.call('service.wait', {}, { owner: 'component.client' })
  await Promise.resolve()
  const rejection = assert.rejects(pending, { code: 'cancelled' })
  registry.dispose('component.client')
  await rejection
  assert.equal(received.aborted, true)
  assert.equal(registry.has('service.wait'), true)
  const controller = new AbortController()
  const another = registry.call('service.wait', {}, { signal: controller.signal })
  const aborted = assert.rejects(another, { code: 'cancelled' })
  controller.abort()
  await aborted
  await assert.rejects(registry.call('service.wait', {}, { signal: controller.signal }), { code: 'cancelled' })
})

test('registration disposal cancels only that command; lifecycle callbacks unsubscribe and run once', async () => {
  let notifications = 0
  const registry = createRegistry({ changed: () => notifications++ })
  const events = []
  const remove = registry.register('component.test', definition('test.wait', () => new Promise(() => {}), { dispose: () => events.push('command') }))
  registry.register('component.test', definition('test.keep', () => 'keep'))
  registry.onDispose('component.test', () => events.push('owner'))
  const unsubscribe = registry.onDispose('component.test', () => events.push('unsubscribed'))
  unsubscribe()
  const pending = registry.call('test.wait')
  const rejection = assert.rejects(pending, { code: 'cancelled' })
  remove()
  await rejection
  assert.equal(await registry.call('test.keep'), 'keep')
  assert.deepEqual(events, ['command'])
  assert.equal(registry.dispose('component.test'), 1)
  assert.equal(registry.dispose('component.test'), 0)
  assert.deepEqual(events, ['command', 'owner'])
  assert.equal(notifications, 4)
})

test('throwing disposal callbacks cannot leave live commands or skip other cleanup', async () => {
  const registry = createRegistry()
  let cleaned = false
  registry.register('component.test', definition('test.one', () => null, { dispose: () => { throw new Error('cleanup failed') } }))
  registry.register('component.test', definition('test.two', () => null))
  registry.onDispose('component.test', () => { cleaned = true })
  assert.throws(() => registry.dispose('component.test'), AggregateError)
  assert.deepEqual(registry.list(), [])
  assert.equal(cleaned, true)
  await assert.rejects(registry.call('test.two'), { code: 'unknown_method' })
})

test('abort reentrancy can register a fresh generation without the old disposer removing it', async () => {
  const registry = createRegistry()
  registry.register('component.test', definition('test.reentrant', (_p, { signal }) => {
    signal.addEventListener('abort', () => registry.register('component.test', definition('test.reentrant', () => 'replacement', { tool: { name: 'reentrant_tool' } })), { once: true })
    return new Promise(() => {})
  }, { tool: { name: 'reentrant_tool' } }))
  const pending = registry.call('test.reentrant')
  await Promise.resolve()
  const rejection = assert.rejects(pending, { code: 'cancelled' })
  registry.dispose('component.test')
  await rejection
  assert.equal(await registry.call('test.reentrant'), 'replacement')
  assert.throws(() => registry.register('component.other', definition('other.reentrant', () => null, { tool: { name: 'reentrant_tool' } })), { code: 'command_collision' })
})

test('explicit core schemas handle nested settings, null resets, payloads and unions', () => {
  validateSchema(schemaFor('settings.set'), { memorySaver: true, memorySaverMinutes: 12, ai: { agents: [{ name: 'Local', command: 'agent --acp' }] }, shortcuts: { 'Ctrl+T': { method: 'tabs.create', params: { url: 'example.com' } } } })
  validateSchema(schemaFor('tabs.navigate'), { url: 'example.com', browserIdentity: null })
  validateSchema(schemaFor('ui.setDesk'), { preview: null, only: null, capture: false })
  validateSchema(schemaFor('ui.emit'), { name: 'custom-event', data: { arbitrary: [null, true, 1] } })
  validateSchema(schemaFor('ai.permit'), { chatId: 'chat', cancel: true })
  validateSchema(schemaFor('ai.permit'), { chatId: 'chat', optionId: 'allow' })
  for (const bucket of ['favorites', 'later', 'active', 'unread', 'done']) validateSchema(schemaFor('tabs.setBucket'), { id: 't1', bucket })
  for (const params of [{ bucket: 'progress' }, { bucket: 'nope' }, { id: 't1' }]) assert.throws(() => validateSchema(schemaFor('tabs.setBucket'), params), { code: 'bad_params' })
  for (const params of [{ chatId: 'chat' }, { chatId: 'chat', cancel: false }, { chatId: 'chat', cancel: true, optionId: 'allow' }]) assert.throws(() => validateSchema(schemaFor('ai.permit'), params), { code: 'bad_params' })
  assert.throws(() => validateSchema(schemaFor('settings.set'), { ai: { agents: [{ name: 'Local', command: 1 }] } }), { code: 'bad_params' })
  assert.throws(() => validateSchema(schemaFor('ui.emit'), { name: 'state' }), { code: 'bad_params' })
  assert.throws(() => schemaFor('new.command'), { code: 'bad_schema' })
  const first = schemaFor('tabs.create')
  first.properties.url.type = 'number'
  assert.equal(schemaFor('tabs.create').properties.url.type, 'string')
})

test('settings catalog searches aliases, filters scopes and rejects invalid scalar values', () => {
  assert.deepEqual(settings.search('sleep minutes').map((entry) => entry.id), ['memorySaverMinutes'])
  assert.deepEqual(settings.list({ section: 'downloads' }).map((entry) => entry.id), ['downloadAskWhere', 'downloadDirectory'])
  assert.deepEqual(settings.list({ scope: 'space' }), [])
  assert.equal(settings.validate('memorySaver', false), false)
  assert.equal(settings.validate('historyRetentionDays', 0), 0)
  assert.equal(settings.validate('searchUrl', 'https://search.example/?q=%s'), 'https://search.example/?q=%s')
  for (const [id, value, options] of [['memorySaver', 'true'], ['memorySaver', true, { scope: 'space' }], ['memorySaverMinutes', 0], ['memorySaverMinutes', 1.5], ['historyRetentionDays', 3651], ['transcriptRetentionDays', 0], ['downloadDirectory', 'bad\u0000path'], ['searchUrl', 'javascript:alert("%s")'], ['searchUrl', 'https://example.com/'], ['autoArchiveHours', Infinity], ['ai', {}], ['unknown', true]]) assert.throws(() => settings.validate(id, value, options), { code: 'bad_params' })
  const entry = settings.get('memorySaver')
  entry.aliases.push('mutated')
  assert.equal(settings.get('memorySaver').aliases.includes('mutated'), false)
  for (const entry of settings.catalog.filter((item) => item.type !== 'action')) {
    assert.equal(settings.validate(entry.id, entry.default, { scope: entry.scope }), entry.default)
    validateSchema(settings.schemaForSetting(entry.id), entry.default)
  }
})

test('settings catalog quick-panel entries carry values and action status, omit unsupported actions and run', async () => {
  assert.deepEqual(settings.list({ quickPanel: true }).map((entry) => entry.id), ['autoArchiveHours', 'tabLayout', 'defaultBrowser', 'update'])
  assert.equal(settings.list({ quickPanel: false }).some((entry) => entry.id === 'defaultBrowser'), false)
  let done = false, supported = true, runs = 0
  const actions = { defaultBrowser: { supported: () => supported, status: () => ({ text: done ? 'Skiff is your default browser.' : '', available: !done }), run: () => { runs++; done = true } } }
  const draw = (values = { autoArchiveHours: 5 }) => settings.present(settings.list({ quickPanel: true }), { values, actions })
  const [hours, layout, action] = draw()
  assert.equal(hours.value, 5)
  assert.deepEqual([draw({})[0].value, layout.value, layout.enum[0]], [12, 'free', 'free'])
  assert.deepEqual([action.type, action.title, action.actionLabel, action.status, action.available, 'value' in action], ['action', 'Default browser', 'Make Skiff your default browser', '', true, false])
  assert.deepEqual(draw().map((entry) => entry.id), ['autoArchiveHours', 'tabLayout', 'defaultBrowser'])
  const ran = await settings.run('defaultBrowser', actions)
  assert.deepEqual([runs, ran.status, ran.available], [1, 'Skiff is your default browser.', false])
  await assert.rejects(settings.run('defaultBrowser', actions), { code: 'bad_params' })
  assert.equal(runs, 1)
  supported = false
  assert.deepEqual(draw().map((entry) => entry.id), ['autoArchiveHours', 'tabLayout'])
  await assert.rejects(settings.run('defaultBrowser', actions), { code: 'bad_params' })
  assert.deepEqual(draw().map((entry) => entry.id), ['autoArchiveHours', 'tabLayout'])
  assert.deepEqual(settings.present(settings.list({ quickPanel: true }), { actions: {} }).map((entry) => entry.id), ['autoArchiveHours', 'tabLayout'])
  for (const id of ['memorySaver', 'unknown']) await assert.rejects(settings.run(id, actions), { code: 'bad_params', message: /Unknown action/ })
  assert.throws(() => settings.validate('defaultBrowser', true), { code: 'bad_params' })
  assert.throws(() => validateSchema(schemaFor('settings.set'), { defaultBrowser: true }), { code: 'bad_params' })
  const future = { id: 'tabBar', owner: 'core', type: 'string', enum: ['top', 'side'], default: 'side', scope: 'global', title: 'Tab bar', description: 'Where tabs sit.', aliases: [], section: 'tabs', quickPanel: true }
  assert.deepEqual(settings.present([future], { values: { tabBar: 'top' } }), [{ ...future, value: 'top' }])
})

test('component scalars reuse host validation while allowing declared normal-space overrides', () => {
  const entry = { id: 'component.cards.columns', key: 'columns', owner: 'component.cards', type: 'integer', default: 2, scope: 'space', title: 'Columns', description: 'Number of columns', aliases: ['layout'], section: 'components', minimum: 1, maximum: 4, enum: [1, 2, 4] }
  assert.equal(settings.validateEntry(entry, 4), 4)
  assert.equal(settings.validateEntry(entry, 1, { scope: 'space' }), 1)
  for (const value of [0, 3, 5, 1.5, '2', Infinity]) assert.throws(() => settings.validateEntry(entry, value), { code: 'bad_params' })
  assert.throws(() => settings.validateEntry({ ...entry, scope: 'global' }, 2, { scope: 'space' }), { code: 'bad_params' })
  assert.throws(() => settings.validateEntry(entry, 2, { scope: 'private' }), { code: 'bad_params' })
  const schema = settings.schemaForEntry(entry)
  validateSchema(schema, 2)
  assert.throws(() => validateSchema(schema, 3), { code: 'bad_params' })
  schema.enum.push(3)
  assert.deepEqual(entry.enum, [1, 2, 4])
  const label = { ...entry, id: 'component.cards.label', type: 'string', default: 'A', minimum: undefined, maximum: undefined, enum: undefined, pattern: '^[A-Z]+$', maxLength: 4 }
  assert.equal(settings.validateEntry(label, 'ABCD'), 'ABCD')
  for (const value of ['abc', 'ABCDE']) assert.throws(() => settings.validateEntry(label, value), { code: 'bad_params' })
})

test('combined catalog search uses provenance and scope and returns detached entries', () => {
  const component = { id: 'component.cards.columns', owner: 'component.cards', type: 'integer', default: 2, scope: 'space', title: 'Columns', description: 'Number of columns', aliases: ['layout'], section: 'components', enum: [1, 2, 4], value: 4, source: 'space' }
  const entries = [...settings.list(), component]
  assert.deepEqual(settings.searchEntries(entries, 'component.cards space layout').map((entry) => entry.id), [component.id])
  assert.deepEqual(settings.searchEntries(entries, '', { scope: 'space', section: 'components', owner: 'component.cards' }), [component])
  assert.deepEqual(settings.searchEntries(entries, 'memory', { owner: 'core' }).map((entry) => entry.id), ['memorySaver', 'memorySaverMinutes'])
  assert.deepEqual(settings.searchEntries(entries, '', { owner: 'unknown' }), [])
  const result = settings.searchEntries(entries, '', { scope: 'space' })[0]
  result.enum.push(8)
  result.aliases.push('changed')
  assert.deepEqual(component.enum, [1, 2, 4])
  assert.deepEqual(component.aliases, ['layout'])
})

test('component scalar schema declarations reject malformed constraints', () => {
  const entry = { id: 'component.test.value', type: 'number', default: 1, scope: 'global' }
  for (const invalid of [
    { type: 'object' }, { scope: 'private' }, { minimum: Infinity }, { maximum: '2' },
    { minimum: 3, maximum: 2 }, { maxLength: 2 }, { pattern: '.*' },
    { enum: [] }, { enum: [1, 1] }, { enum: [1, '2'] },
    { type: 'string', pattern: '[' }, { type: 'string', maxLength: -1 }
  ]) assert.throws(() => settings.schemaForEntry({ ...entry, ...invalid }), { code: 'bad_params' })
})

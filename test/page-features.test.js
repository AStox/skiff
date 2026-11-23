'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const S = require('../src/state')
const { createRegistry } = require('../src/commands')
const { createPageFeatures } = require('../src/page-features')

const pending = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
let nextContents = 0
class Contents extends EventEmitter {
  constructor(url) {
    super()
    this.id = ++nextContents
    this.url = url
    this.loading = false
    this.destroyed = false
    this.audible = false
    this.searches = []
    this.stops = []
    this.scripts = []
    this.reloads = 0
    this.captures = 0
    this.frameMessages = []
    this.mainFrame = { processId: this.id, routingId: 1, url, detached: false, send: (...args) => this.frameMessages.push(args) }
    this.mainFrame.top = this.mainFrame
    this.mainFrame.framesInSubtree = [this.mainFrame]
    this.execute = () => ({ title: 'Test', url: this.url, text: 'A useful document.', selection: '' })
    this.image = { width: 320, height: 200 }
    this.capture = () => this.image
  }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
  isLoading() { return this.loading }
  isCurrentlyAudible() { return this.audible }
  stopFindInPage(action) { this.stops.push(action) }
  findInPage(query, options) { this.searches.push({ query, ...options }); return this.searches.length }
  executeJavaScriptInIsolatedWorld(world, scripts) { this.scripts.push({ world, scripts }); return this.execute() }
  capturePage() { this.captures++; return this.capture() }
  reload() { this.reloads++ }
  navigate(url = this.url, inPlace = false) {
    this.loading = !inPlace
    this.url = url
    this.mainFrame.url = url
    this.emit('did-start-navigation', {}, url, inPlace, true)
  }
  ready() { this.loading = false; this.emit('did-stop-loading') }
  close() { this.destroyed = true; this.emit('destroyed') }
}

function setup(t, create = createPageFeatures) {
  const state = S.load()
  const views = new Map(), runtime = new Map(), shown = new Set(), hosts = new Map()
  const registry = createRegistry()
  const events = []
  let features
  const createView = (tab) => {
    const view = { webContents: new Contents(tab.url) }
    views.set(tab.id, view)
    features?.attach(tab, view)
    return view
  }
  const destroyView = (id) => {
    features.beforeDestroy(id)
    const view = views.get(id)
    views.delete(id)
    runtime.delete(id)
    view?.webContents.close()
  }
  features = create({ state: () => state, views, runtime, createView, destroyView, isShown: (view) => shown.has(view), getWindow: (tab) => hosts.get(tab.id), emit: (name, data) => events.push({ name, data }) })
  features.register(registry)
  const add = (extra = {}) => {
    const tab = S.createTab(state, { url: 'https://example.test/article', activate: false, ...extra }, 0)
    const view = createView(tab)
    return { tab, view, wc: view.webContents }
  }
  const report = (entry, overrides = {}, frame = entry.wc.mainFrame) => features.report(entry.tab.id, { document: `doc-${frame.processId}-${frame.routingId}`, generation: runtime.get(entry.tab.id).generation, timeOrigin: 1, url: frame.url, dirty: false, media: false, ...overrides }, { sender: entry.wc, senderFrame: frame })
  t.after(() => features.stop())
  return { features, state, views, runtime, shown, hosts, events, add, report, call: (name, params, context) => registry.call(name, params, context), registry }
}

test('native find is independent per tab, steps both ways, and ignores superseded request/document results', async (t) => {
  const h = setup(t)
  const a = h.add(), b = h.add()
  const first = await h.call('find.update', { id: a.tab.id, query: 'café 東京', matchCase: true })
  a.wc.emit('found-in-page', {}, { requestId: first.requestId, matches: 3, activeMatchOrdinal: 1 })
  assert.equal(h.runtime.get(a.tab.id).find.count, 3)
  const second = await h.call('find.next', { id: a.tab.id, forward: false })
  assert.deepEqual(a.wc.searches.at(-1), { query: 'café 東京', matchCase: true, forward: false, findNext: true })
  a.wc.emit('found-in-page', {}, { requestId: second.requestId, matches: 3, activeMatchOrdinal: 3 })
  a.wc.emit('found-in-page', {}, { requestId: first.requestId, matches: 900, activeMatchOrdinal: 900 })
  assert.equal(h.runtime.get(a.tab.id).find.current, 3)
  await h.call('find.update', { id: b.tab.id, query: 'other' })
  assert.equal(h.runtime.get(a.tab.id).find.query, 'café 東京')
  a.wc.navigate()
  a.wc.emit('found-in-page', {}, { requestId: second.requestId, matches: 7, activeMatchOrdinal: 7 })
  assert.equal(h.runtime.get(a.tab.id).find.count, 0)
  assert.equal(h.runtime.get(a.tab.id).find.active, false)
  assert.equal(h.runtime.get(b.tab.id).find.query, 'other')
  await h.call('find.close', { id: b.tab.id })
  assert.equal(b.wc.stops.at(-1), 'clearSelection')
  assert.equal(h.runtime.get(b.tab.id).find.active, false)
  await assert.rejects(h.call('find.update', { id: b.tab.id, query: 'x'.repeat(1001) }), { code: 'bad_params' })
})

test('loading reads have a real deadline and remove only their own listeners', async (t) => {
  const h = setup(t), entry = h.add()
  entry.wc.loading = true
  const before = entry.wc.listenerCount('did-stop-loading')
  await assert.rejects(h.features.read(entry.tab, { timeout: 15 }), { code: 'timeout' })
  assert.equal(entry.wc.listenerCount('did-stop-loading'), before)
  assert.equal(entry.wc.scripts.length, 0)
  entry.wc.ready()
  assert.equal(h.runtime.get(entry.tab.id).lifecycle, 'live')
  const value = await h.features.read(entry.tab)
  assert.equal(value.text, 'A useful document.')
  assert.equal(entry.wc.scripts[0].world, 999)
})

test('initial navigation can complete a cold read, but later main-frame and in-page navigations cancel it', async (t) => {
  const h = setup(t)
  const entry = h.add()
  h.features.beforeDestroy(entry.tab.id)
  entry.wc.url = 'about:blank'
  entry.wc.loading = true
  h.features.attach(entry.tab, entry.view)
  const cold = h.features.read(entry.tab)
  entry.wc.navigate('https://example.test/first')
  entry.wc.ready()
  assert.equal((await cold).url, 'https://example.test/first')
  for (const inPlace of [false, true]) {
    const deferred = pending()
    entry.wc.execute = () => deferred.promise
    const result = h.features.read(entry.tab)
    const rejected = assert.rejects(result, { code: 'stale_document' })
    await tick()
    entry.wc.emit('did-start-navigation', {}, 'https://iframe.test/', false, false)
    assert.equal(entry.wc.listenerCount('did-stop-loading'), 2)
    entry.wc.navigate('https://example.test/next', inPlace)
    await rejected
    deferred.resolve({ text: 'old secret document', url: 'https://example.test/first' })
    entry.wc.ready()
    assert.equal(entry.wc.listenerCount('did-stop-loading'), 1)
  }
})

test('abort, crash, close, and stop discard late page data and clean listeners', async (t) => {
  for (const reason of ['abort', 'crash', 'close', 'stop']) {
    const h = setup(t), entry = h.add(), deferred = pending(), controller = new AbortController()
    entry.wc.execute = () => deferred.promise
    const result = h.features.read(entry.tab, { signal: controller.signal })
    const code = { abort: 'aborted', crash: 'page_crashed', close: 'page_closed', stop: 'page_closed' }[reason]
    const rejected = assert.rejects(result, { code })
    await tick()
    if (reason === 'abort') controller.abort()
    if (reason === 'crash') entry.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    if (reason === 'close') entry.wc.close()
    if (reason === 'stop') h.features.stop()
    await rejected
    deferred.resolve({ title: 'late', text: 'secret', url: entry.tab.url })
    assert.equal(entry.wc.listenerCount('did-stop-loading'), ['close', 'stop'].includes(reason) ? 0 : 1)
    if (reason === 'crash') {
      entry.wc.ready()
      assert.equal(h.runtime.get(entry.tab.id).lifecycle, 'crashed')
      await h.call('tabs.recover', { id: entry.tab.id })
      assert.equal(entry.wc.reloads, 1)
      assert.equal(h.views.get(entry.tab.id), entry.view)
      assert.equal(h.runtime.get(entry.tab.id).lifecycle, 'loading')
    }
  }
})

test('captures reject detached pages, enforce deadlines, and allow an actually attached hidden agent page', async (t) => {
  const h = setup(t), entry = h.add()
  await assert.rejects(h.features.capture(entry.tab), { code: 'page_hidden' })
  assert.equal(entry.wc.captures, 0)
  h.shown.add(entry.view)
  entry.wc.capture = () => new Promise(() => {})
  await assert.rejects(h.features.capture(entry.tab, { timeout: 15 }), { code: 'timeout' })
  assert.equal(entry.wc.listenerCount('did-stop-loading'), 1)
  const controller = new AbortController()
  const capture = h.features.capture(entry.tab, { signal: controller.signal })
  const rejected = assert.rejects(capture, { code: 'aborted' })
  controller.abort()
  await rejected
  const agent = h.add({ agent: 'Assistant' })
  h.hosts.set(agent.tab.id, { isDestroyed: () => false, contentView: { children: [agent.view] } })
  assert.equal(await h.features.capture(agent.tab), agent.wc.image)
  h.hosts.get(agent.tab.id).contentView.children = []
  await assert.rejects(h.features.capture(agent.tab), { code: 'page_hidden' })
})

test('reader returns only bounded semantic text, is reversible, and never reloads the original view', async (t) => {
  const h = setup(t), entry = h.add()
  entry.wc.execute = () => ({ title: '<img src=x onerror=attack()>', url: entry.tab.url, byline: 'Author', content: '<script>attack()</script>', blocks: [
    { type: 'heading', level: 300, text: 'Title', onclick: 'attack()' },
    { type: 'script', text: 'attack()' },
    { type: 'paragraph', text: 'Useful article '.repeat(30000), html: '<iframe />' }
  ] })
  const before = { tab: { ...entry.tab }, view: entry.view }
  const result = await h.call('reader.open', { id: entry.tab.id })
  assert.equal(result.active, true)
  assert.equal(result.loading, false)
  assert.equal(result.article.blocks.length, 2)
  assert.deepEqual(Object.keys(result.article.blocks[0]).sort(), ['level', 'text', 'type'])
  assert.equal(result.article.blocks[0].level, 6)
  const size = result.article.blocks.reduce((sum, block) => sum + block.text.length, 0)
  assert.ok(size > 199900 && size <= 200000)
  assert.equal(Object.hasOwn(result.article, 'content'), false)
  assert.equal(result.article.title, '<img src=x onerror=attack()>')
  assert.equal(h.runtime.get(entry.tab.id).reader.active, true)
  assert.equal((await h.call('reader.get', { id: entry.tab.id })).article.text, result.article.text)
  assert.equal((await h.call('reader.close', { id: entry.tab.id })).article, null)
  assert.equal(h.views.get(entry.tab.id), before.view)
  assert.deepEqual(entry.tab, before.tab)
  assert.equal(entry.wc.reloads, 0)
})

test('reader and page scalars are bounded inside the isolated world before reaching the host', async (t) => {
  // Substitute only the parser result: execute the real renderer serialization,
  // and inspect its raw return before the host normalization can hide an overflow.
  const readabilityPath = require.resolve('@mozilla/readability/Readability.js')
  const module = { exports: {} }
  const load = (name) => {
    if (name === './state') return S
    if (name === 'node:fs') return { readFileSync: (file, ...args) => file === readabilityPath ? 'function Readability() {}; Readability.prototype.parse = () => globalThis.articleFixture;' : fs.readFileSync(file, ...args) }
    throw new Error(`Unexpected dependency: ${name}`)
  }
  load.resolve = require.resolve
  vm.compileFunction(fs.readFileSync(path.join(__dirname, '../src/page-features.js'), 'utf8'), ['module', 'require'], { filename: path.join(__dirname, '../src/page-features.js') })(module, load)
  const h = setup(t, module.exports.createPageFeatures), entry = h.add()
  const huge = 'x'.repeat(1000000)
  const url = `https://example.test/${huge}`
  const content = { nodeType: 1, tagName: 'P', textContent: 'Readable article.', childNodes: [] }
  let articleFixture = { title: huge, byline: huge, excerpt: huge, siteName: huge, content }
  let raw
  entry.wc.execute = () => {
    raw = vm.runInNewContext(entry.wc.scripts.at(-1).scripts[0].code, {
      articleFixture, document: { cloneNode: () => ({}), title: huge, body: { innerText: huge } },
      location: { href: url }, getSelection: () => huge
    })
    assert.equal(raw.url.length, 8192)
    assert.equal(raw.title.length, raw.blocks && articleFixture.title === 42 ? 2 : 1000)
    if (raw.blocks) {
      assert.equal(raw.byline.length, articleFixture.byline === null ? 0 : 1000)
      assert.equal(raw.excerpt.length, 2000)
      assert.equal(raw.siteName.length, articleFixture.siteName === false ? 5 : 300)
    } else {
      assert.equal(raw.selection.length, 20000)
      assert.equal(raw.text.length, 20000)
    }
    return raw
  }
  await h.call('reader.open', { id: entry.tab.id })
  articleFixture = { title: 42, byline: null, excerpt: { toString: () => huge }, siteName: false, content }
  await h.call('reader.open', { id: entry.tab.id })
  assert.equal(raw.title, '42')
  assert.equal(raw.byline, '')
  assert.equal(raw.siteName, 'false')
  await h.features.read(entry.tab)
})

test('closing a pending reader cancels immediately and cannot reopen from a late extraction', async (t) => {
  const h = setup(t), entry = h.add(), deferred = pending()
  entry.wc.execute = () => deferred.promise
  const opening = h.call('reader.open', { id: entry.tab.id })
  const rejected = assert.rejects(opening, { code: 'aborted' })
  await tick()
  assert.equal(entry.wc.listenerCount('did-stop-loading'), 2)
  await h.call('reader.close', { id: entry.tab.id })
  await rejected
  deferred.resolve({ title: 'Late', blocks: [{ type: 'paragraph', text: 'Old content' }] })
  await tick()
  assert.equal(entry.wc.listenerCount('did-stop-loading'), 1)
  assert.equal((await h.call('reader.get', { id: entry.tab.id })).active, false)
})

test('IPC safety reports validate sender, frame, URL and document generation; draft protection is sticky', async (t) => {
  const h = setup(t), entry = h.add()
  assert.equal(h.report(entry, { generation: null }), false)
  assert.deepEqual(entry.wc.frameMessages.at(-1), ['skiff:page-state-generation', h.runtime.get(entry.tab.id).generation])
  assert.equal(h.report(entry, { dirty: true }), true)
  assert.equal(h.report(entry, { dirty: false }), true)
  assert.equal(h.runtime.get(entry.tab.id).protections.dirty, true)
  assert.equal(h.report(entry, { url: 'https://attacker.test/' }), false)
  const other = h.add()
  const payload = { document: 'fake', generation: h.runtime.get(entry.tab.id).generation, timeOrigin: 1, url: entry.tab.url, dirty: false, media: false }
  assert.equal(h.features.report(entry.tab.id, payload, { sender: other.wc, senderFrame: entry.wc.mainFrame }), false)
  const child = { processId: 20, routingId: 2, url: 'https://forms.test/', top: entry.wc.mainFrame, send: () => {} }
  entry.wc.mainFrame.framesInSubtree.push(child)
  assert.equal(h.report(entry, { media: true }, child), true)
  assert.equal(h.runtime.get(entry.tab.id).protections.media, true)
  entry.wc.navigate()
  entry.wc.ready()
  assert.equal(h.report(entry), false, 'old document token is invalid even if supplied with new generation')
  assert.equal(h.report(entry, { document: 'new-document' }), true)
  assert.equal(h.runtime.get(entry.tab.id).protections.dirty, false)
})

test('memory saving defaults off and never discards any visible Layer view, even a nonselected one', async (t) => {
  const h = setup(t), first = h.add(), second = h.add(), hidden = h.add()
  for (const entry of [first, second, hidden]) h.report(entry)
  h.shown.add(first.view)
  h.shown.add(second.view)
  h.state.activeTabBySpace[h.state.activeSpaceId] = first.tab.id
  const later = Date.now() + 3600000
  assert.deepEqual(h.features.sweep(later), { discarded: [] })
  h.state.settings.memorySaver = true
  h.state.settings.memorySaverMinutes = 1
  assert.deepEqual(h.features.sweep(later), { discarded: [hidden.tab.id] })
  assert.equal(h.views.get(first.tab.id), first.view)
  assert.equal(h.views.get(second.tab.id), second.view)
  assert.equal(h.runtime.get(hidden.tab.id).lifecycle, 'sleeping')
  const oldPartition = hidden.tab.sessionPartition
  await h.call('tabs.recover', { id: hidden.tab.id })
  assert.notEqual(h.views.get(hidden.tab.id), hidden.view)
  assert.equal(S.findTab(h.state, hidden.tab.id), hidden.tab)
  assert.equal(hidden.tab.sessionPartition, oldPartition)
})

test('drafts, media, calls, downloads, agents, permissions, and unknown frames all block discard', async (t) => {
  const h = setup(t)
  for (const reason of ['dirty', 'media', 'calls', 'downloads', 'agent', 'permissions', 'audible', 'unknown']) {
    const entry = h.add()
    if (reason !== 'unknown') h.report(entry)
    if (reason === 'dirty' || reason === 'media') h.report(entry, { [reason]: true })
    else if (reason === 'audible') entry.wc.audible = true
    else if (reason !== 'unknown') h.features.protect(entry.tab.id, reason, true)
    await assert.rejects(h.call('tabs.discard', { id: entry.tab.id }), { code: 'page_protected' })
    assert.equal(h.views.get(entry.tab.id), entry.view, reason)
  }
})

function preloadFixture(url = 'https://frame.test/') {
  const listeners = new Map(), ipc = new EventEmitter(), sent = []
  ipc.send = (channel, payload) => sent.push({ channel, payload })
  class Element { matches() { return true } }
  class HTMLMediaElement extends Element {}
  const field = new Element()
  field.value = 'private unsent draft'
  const window = { top: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload-page.js'), 'utf8'), {
    require: (name) => { assert.equal(name, 'electron'); return { ipcRenderer: ipc, webFrame: { insertCSS() {} } } },
    window, location: { protocol: 'https:', href: url }, performance: { timeOrigin: 10 },
    document: { readyState: 'complete', querySelectorAll: () => [] }, Element, HTMLMediaElement, queueMicrotask,
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) }
  })
  const fire = (name, event) => { for (const fn of listeners.get(name) || []) fn(event) }
  return { sent, ipc, field, HTMLMediaElement, fire }
}

test('preload reports only safety booleans from trusted edits, including subframes, with no field contents', async () => {
  const { sent, ipc, field, HTMLMediaElement, fire } = preloadFixture()
  await tick()
  fire('input', { isTrusted: false, composedPath: () => [field] })
  await tick()
  assert.equal(sent.at(-1).payload.dirty, false)
  ipc.emit('skiff:page-state-generation', {}, 4)
  fire('input', { isTrusted: true, composedPath: () => [field] })
  await tick()
  assert.equal(sent.at(-1).payload.generation, 4)
  assert.equal(sent.at(-1).payload.dirty, true)
  assert.equal(JSON.stringify(sent).includes(field.value), false)
  assert.deepEqual([...new Set(sent.map((item) => item.channel))], ['skiff:page-state'])
  const media = new HTMLMediaElement()
  media.paused = false
  media.ended = false
  fire('playing', { target: media })
  await tick()
  assert.equal(sent.at(-1).payload.media, true)
  media.paused = true
  fire('pause', { target: media })
  await tick()
  assert.equal(sent.at(-1).payload.media, false)
  assert.equal(sent.at(-1).payload.dirty, true)
})

test('modifier shortcuts in custom editors protect drafts without trusting synthetic input', async () => {
  for (const [modifier, key] of [['ctrlKey', 'd'], ['metaKey', 'd'], ['altKey', 'ArrowUp']]) {
    const { sent, field, fire } = preloadFixture()
    await tick()
    const event = { isTrusted: false, key, [modifier]: true, composedPath: () => [field] }
    fire('keydown', event)
    fire('input', { isTrusted: false, composedPath: () => [field] })
    await tick()
    assert.equal(sent.at(-1).payload.dirty, false)
    fire('keydown', { ...event, isTrusted: true, key: 'Control' })
    await tick()
    assert.equal(sent.at(-1).payload.dirty, false)
    fire('keydown', { ...event, isTrusted: true })
    fire('input', { isTrusted: false, composedPath: () => [field] })
    await tick()
    assert.equal(sent.at(-1).payload.dirty, true, `${modifier}+${key}`)
    assert.equal(JSON.stringify(sent).includes(field.value), false)
  }
})

test('preload bounds page-controlled URLs before sending safety reports', async () => {
  const { sent } = preloadFixture(`https://frame.test/${'x'.repeat(100000)}`)
  await tick()
  assert.equal(sent.at(-1).payload.url.length, 8192)
})

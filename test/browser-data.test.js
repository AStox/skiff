'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createBrowserData } = require('../src/browser-data')
const { createRegistry } = require('../src/commands')

class FakeContents extends EventEmitter {
  constructor(url = 'https://example.test/page') { super(); this.url = url; this.factor = 1; this.destroyed = false }
  getURL() { return this.url }
  getTitle() { return 'Source page' }
  setZoomFactor(factor) { this.factor = factor }
  getZoomFactor() { return this.factor }
  isDestroyed() { return this.destroyed }
  navigate(url) { this.emit('did-start-navigation', {}, url, false, true); this.url = url }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
class FakeSession extends EventEmitter {
  setPermissionCheckHandler(handler) { this.check = handler }
  setPermissionRequestHandler(handler) { this.request = handler }
  downloadURL(url) { this.requestedURL = url; this.emit('will-download', {}, new FakeDownload(url), null) }
}
class FakeDownload extends EventEmitter {
  constructor(url = 'https://files.test/report.pdf') { super(); this.url = url; this.bytes = 0; this.total = 100; this.file = ''; this.paused = false }
  getURL() { return this.url }
  getFilename() { return 'report.pdf' }
  getSavePath() { return this.file }
  setSavePath(file) { this.file = file }
  setSaveDialogOptions(options) { this.options = options }
  getReceivedBytes() { return this.bytes }
  getTotalBytes() { return this.total }
  isPaused() { return this.paused }
  cancel() { this.emit('done', {}, 'cancelled') }
  update(bytes) { this.bytes = bytes; this.emit('updated', {}, 'progressing') }
  complete(file) { this.file = file; this.bytes = this.total; this.emit('done', {}, 'completed') }
}
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-browser-data-'))
  const state = {
    settings: { historyRetentionDays: 90, downloadAskWhere: true },
    spaces: [{ id: 'home' }, { id: 'work', sessionPartition: 'persist:work' }, { id: 'private', incognito: true, sessionPartition: 'incognito-one' }],
    tabs: []
  }
  const opened = [], events = [], managers = []
  const dialog = { showMessageBox: async () => ({ response: 0 }) }
  const config = { dir, state: () => state, changed: () => {}, emit: (name, payload) => events.push({ name, payload }), openTab: (args) => { opened.push(args); return { id: 'opened', ...args } }, dialog, shell: { openPath: async () => '', showItemInFolder() {} }, ...overrides }
  const start = () => {
    const manager = createBrowserData(config), registry = createRegistry()
    manager.register(registry)
    managers.push(manager)
    return { manager, registry, call: (name, args = {}) => registry.call(name, args) }
  }
  t.after(() => { for (const manager of managers) manager.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { ...start(), start, state, dir, opened, events, dialog, config }
}
const tab = (id, sessionPartition = 'persist:main', extra = {}) => ({ id, sessionPartition, spaceId: sessionPartition === 'persist:work' ? 'work' : 'home', url: 'https://example.test/page', ...extra })
const grant = (partition = 'persist:main', extra = {}) => ({ partition, origin: 'https://example.test', permission: 'geolocation', decision: 'allow', lifetime: 'remember', ...extra })
const request = (session, wc, permission = 'geolocation', details = {}) => new Promise((resolve) => session.request(wc, permission, resolve, { requestingUrl: wc.getURL(), ...details }))
const turn = () => new Promise((resolve) => setImmediate(resolve))

test('history preserves visit identity and original partition, bounds retention, and excludes private/agent/peek visits', async (t) => {
  const f = fixture(t), now = Date.now()
  const first = f.manager.recordVisit(tab('work-tab', 'persist:work'), { url: 'https://example.test/report', title: 'Quarterly Report', time: now })
  const updated = f.manager.recordVisit(tab('work-tab', 'persist:work'), { url: first.url, title: 'Revised report', time: now })
  assert.equal(updated.id, first.id)
  f.manager.recordVisit(tab('home-tab'), { url: first.url, title: 'Personal report', time: now + 1 })
  for (const excluded of [tab('secret', 'incognito-one'), tab('agent', 'persist:main', { agent: 'omp' }), tab('preview', 'persist:main', { userPeek: true }), tab('chat', 'persist:main', { chat: {} })]) {
    assert.equal(f.manager.recordVisit(excluded, { url: 'https://private.test/never-store', title: 'secret' }), null)
  }
  assert.equal(f.manager.recordVisit(tab('old'), { url: first.url, time: now - 91 * 86400000 }), null)
  assert.equal(f.manager.recordVisit(tab('internal'), { url: 'skiff:new' }), null)
  assert.equal((await f.call('history.search', { query: 'REPORT' })).total, 2)
  const work = await f.call('history.search', { partition: 'persist:work', limit: 1 })
  assert.equal(work.entries[0].title, 'Revised report')
  await f.call('history.open', { id: first.id })
  assert.deepEqual(f.opened[0], { url: first.url, sessionPartition: 'persist:work', spaceId: 'work', activate: true })
  assert.deepEqual(await f.call('history.delete', { ids: [first.id] }), { deleted: 1 })
  await assert.rejects(f.call('history.open', { id: first.id }), { code: 'not_found' })
  f.manager.stop()
  assert.equal(fs.readFileSync(path.join(f.dir, 'browser-data.json'), 'utf8').includes('never-store'), false)
  const again = f.start()
  assert.equal((await again.call('history.search')).total, 1)
  assert.deepEqual(await again.call('history.clear'), { deleted: 1 })
  f.state.settings.historyRetentionDays = 0
  assert.equal(again.manager.recordVisit(tab('off'), { url: first.url }), null)
})

test('history paging and clearing one profile leave other profile visits intact', async (t) => {
  const f = fixture(t), now = Date.now()
  for (let i = 0; i < 3; i++) f.manager.recordVisit(tab(`t${i}`, i ? 'persist:work' : 'persist:main'), { url: `https://example.test/${i}`, time: now + i })
  assert.equal((await f.call('history.search', { offset: 1, limit: 1 })).entries[0].url, 'https://example.test/1')
  assert.deepEqual(await f.call('history.clear', { partition: 'persist:work' }), { deleted: 2 })
  assert.equal((await f.call('history.search')).entries[0].partition, 'persist:main')
  await assert.rejects(f.call('history.search', { limit: -1 }))
  await assert.rejects(f.call('history.delete', { ids: 'not-an-array' }))
})

test('downloads capture immutable source identity, progress, cancel and restart using their original session', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  f.manager.attachSession(session, 'persist:work')
  f.manager.attachSession(session, 'persist:work')
  assert.equal(session.listenerCount('will-download'), 1)
  f.manager.applyZoom(wc, tab('source', 'persist:work'))
  const item = new FakeDownload()
  session.emit('will-download', {}, item, wc)
  const original = (await f.call('downloads.list')).entries[0]
  assert.equal(original.sourceUrl, 'https://example.test/page')
  assert.equal(original.sourceTitle, 'Source page')
  assert.equal(original.tabId, 'source')
  assert.ok(item.options)
  wc.navigate('https://elsewhere.test/changed')
  item.update(45)
  assert.deepEqual(f.manager.snapshot().activeDownloads, ['source'])
  const progressed = (await f.call('downloads.list')).entries[0]
  assert.equal(progressed.receivedBytes, 45)
  assert.equal(progressed.sourceUrl, original.sourceUrl)
  await f.call('downloads.cancel', { id: original.id })
  assert.deepEqual(f.manager.snapshot().activeDownloads, [])
  assert.equal((await f.call('downloads.retry', { id: original.id })).restartRequested, true)
  assert.equal(session.requestedURL, original.url)
  const retried = (await f.call('downloads.list')).entries[0]
  assert.equal(retried.retryOf, original.id)
  assert.equal(retried.partition, 'persist:work')
  assert.equal(retried.tabId, 'source')
  assert.equal(retried.sourceUrl, original.sourceUrl)
  await assert.rejects(f.call('downloads.retry', { id: retried.id }), { code: 'bad_params' })
  assert.deepEqual(await f.call('downloads.clear'), { deleted: 1 })
  f.manager.stop()
  assert.equal(session.listenerCount('will-download'), 0)
  assert.equal(session.check, null)
  const restarted = f.start()
  assert.equal((await restarted.call('downloads.list')).entries[0].state, 'interrupted')
})

test('completed files open/reveal and survive clearing; private metadata never persists', async (t) => {
  const opened = [], revealed = []
  const f = fixture(t, { shell: { openPath: async (file) => { opened.push(file); return '' }, showItemInFolder: (file) => revealed.push(file) } })
  const session = new FakeSession(), wc = new FakeContents('https://private.test/download')
  f.manager.attachSession(session, 'incognito-one')
  f.manager.applyZoom(wc, tab('private-tab', 'incognito-one'))
  const item = new FakeDownload('https://private.test/sensitive.pdf')
  session.emit('will-download', {}, item, wc)
  assert.match(item.options.title, /saved files remain/)
  assert.equal((await f.call('downloads.list')).entries.length, 0)
  const entry = (await f.call('downloads.list', { includePrivate: true })).entries[0]
  const saved = path.join(f.dir, 'explicit-private-save.pdf')
  fs.writeFileSync(saved, 'download bytes')
  item.complete(saved)
  await f.call('downloads.open', { id: entry.id })
  await f.call('downloads.reveal', { id: entry.id })
  assert.deepEqual(opened, [saved])
  assert.deepEqual(revealed, [saved])
  f.manager.stop()
  assert.equal(fs.readFileSync(path.join(f.dir, 'browser-data.json'), 'utf8').includes('sensitive'), false)
  assert.equal(fs.existsSync(saved), true)
  const again = f.start()
  assert.equal((await again.call('downloads.list', { includePrivate: true })).entries.length, 0)
})

test('configured destination avoids overwriting existing and simultaneous downloads', async (t) => {
  const f = fixture(t), session = new FakeSession()
  f.state.settings.downloadAskWhere = false
  f.state.settings.downloadDirectory = f.dir
  fs.writeFileSync(path.join(f.dir, 'report.pdf'), 'keep')
  f.manager.attachSession(session, 'persist:main')
  const a = new FakeDownload(), b = new FakeDownload()
  session.emit('will-download', {}, a, null)
  session.emit('will-download', {}, b, null)
  assert.equal(a.getSavePath(), path.join(f.dir, 'report (1).pdf'))
  assert.equal(b.getSavePath(), path.join(f.dir, 'report (2).pdf'))
  assert.equal(fs.readFileSync(path.join(f.dir, 'report.pdf'), 'utf8'), 'keep')
  const row = (await f.call('downloads.list')).entries[0]
  await assert.rejects(f.call('downloads.open', { id: row.id }), { code: 'not_found' })
})

test('permissions isolate exact origin and profile; once is consumed and only remembered grants persist', async (t) => {
  const f = fixture(t), main = new FakeSession(), work = new FakeSession(), privateSession = new FakeSession(), wc = new FakeContents()
  f.manager.attachSession(main, 'persist:main')
  f.manager.attachSession(work, 'persist:work')
  f.manager.attachSession(privateSession, 'incognito-one')
  await f.call('permissions.set', grant('persist:main', { lifetime: 'once' }))
  assert.equal(await request(main, wc), true)
  assert.equal(await request(main, wc), false)
  await f.call('permissions.set', grant())
  await f.call('permissions.set', grant('persist:work', { lifetime: 'session' }))
  assert.equal(main.check(wc, 'geolocation', 'https://example.test'), true)
  assert.equal(main.check(wc, 'geolocation', 'https://sub.example.test'), false)
  assert.equal(main.check(wc, 'geolocation', 'http://example.test'), false)
  assert.equal(work.check(wc, 'notifications', 'https://example.test'), false)
  const privateGrant = await f.call('permissions.set', grant('incognito-one'))
  assert.equal(privateGrant.lifetime, 'session')
  await assert.rejects(f.call('permissions.set', grant('persist:main', { origin: 'https://example.test/path' })), { code: 'bad_params' })
  await f.call('permissions.set', grant('persist:main', { permission: 'fullscreen', decision: 'block' }))
  assert.equal(main.check(wc, 'fullscreen', 'https://example.test'), false)
  f.manager.stop()
  const again = f.start()
  const entries = (await again.call('permissions.list')).entries
  assert.equal(entries.length, 2)
  assert.ok(entries.every((r) => r.partition === 'persist:main' && r.lifetime === 'remember'))
  assert.deepEqual(await again.call('permissions.revoke', { partition: 'persist:main', origin: 'https://example.test', permission: 'geolocation' }), { deleted: 1 })
  assert.deepEqual(await again.call('permissions.reset', { partition: 'persist:main', origin: 'https://example.test' }), { deleted: 1 })
})

test('native permission prompts persist explicit decisions and protect calls without leaking source URLs in events', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  f.dialog.showMessageBox = async () => ({ response: 3 })
  f.manager.attachSession(session, 'persist:main')
  f.manager.applyZoom(wc, tab('calling'))
  assert.equal(await request(session, wc, 'media'), true)
  assert.equal((await f.call('permissions.list')).entries[0].lifetime, 'remember')
  assert.deepEqual(f.events.find((e) => e.name === 'browser-permission-granted').payload, { tabId: 'calling', permission: 'media' })
  assert.ok(f.events.every((e) => !JSON.stringify(e).includes('https://')))
  assert.equal(wc.listenerCount('did-start-navigation'), 0)
})

test('late permission replies cannot grant after navigation, revocation, shutdown or destruction', async (t) => {
  for (const action of ['navigate', 'revoke', 'stop', 'destroy']) {
    const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
    let answer
    f.dialog.showMessageBox = () => new Promise((resolve) => { answer = resolve })
    f.manager.attachSession(session, 'persist:main')
    f.manager.applyZoom(wc, tab('pending'))
    const decision = request(session, wc)
    await turn()
    assert.equal(f.manager.snapshot().pendingPermissions[0].tabId, 'pending')
    if (action === 'navigate') wc.navigate('https://other.test/')
    if (action === 'revoke') await f.call('permissions.revoke', { partition: 'persist:main', origin: 'https://example.test' })
    if (action === 'stop') f.manager.stop()
    if (action === 'destroy') wc.destroy()
    answer({ response: 3 })
    assert.equal(await decision, false)
    await turn()
    assert.equal(f.manager.snapshot().pendingPermissions.length, 0)
    if (action !== 'stop') assert.equal((await f.call('permissions.list')).entries.length, 0)
  }
})

test('zoom is profile-origin scoped, updates sibling tabs and remembers only nonprivate origins', async (t) => {
  const f = fixture(t), a = new FakeContents(), b = new FakeContents(), work = new FakeContents(), privateWC = new FakeContents()
  f.manager.applyZoom(a, tab('a'))
  f.manager.applyZoom(b, tab('b'))
  f.manager.applyZoom(work, tab('work', 'persist:work'))
  f.manager.applyZoom(privateWC, tab('private', 'incognito-one'))
  a.setZoomFactor(1.5)
  f.manager.rememberZoom(a, tab('a'))
  assert.equal(b.getZoomFactor(), 1.5)
  assert.equal(work.getZoomFactor(), 1)
  privateWC.setZoomFactor(2)
  f.manager.rememberZoom(privateWC, tab('private', 'incognito-one'))
  a.navigate('https://elsewhere.test/')
  assert.equal(f.manager.applyZoom(a, tab('a')), 1)
  await assert.rejects(f.call('zoom.set', { partition: 'persist:main', origin: 'https://example.test', factor: 10 }))
  f.manager.stop()
  const again = f.start(), fresh = new FakeContents()
  assert.equal(again.manager.applyZoom(fresh, tab('fresh')), 1.5)
  assert.equal((await again.call('zoom.list')).entries.length, 1)
  assert.deepEqual(await again.call('zoom.reset', { partition: 'persist:main', origin: 'https://example.test' }), { deleted: 1 })
  assert.equal(fresh.getZoomFactor(), 1)
})

test('private-close forgets grants and download metadata but leaves explicitly saved files', async (t) => {
  const f = fixture(t), session = new FakeSession(), item = new FakeDownload()
  f.manager.attachSession(session, 'incognito-one')
  session.emit('will-download', {}, item, null)
  await f.call('permissions.set', grant('incognito-one'))
  await f.call('zoom.set', { partition: 'incognito-one', origin: 'https://example.test', factor: 2 })
  const saved = path.join(f.dir, 'private.pdf')
  fs.writeFileSync(saved, 'keep')
  item.complete(saved)
  f.manager.forgetPartition('incognito-one')
  assert.equal((await f.call('downloads.list', { includePrivate: true })).entries.length, 0)
  assert.equal((await f.call('permissions.list')).entries.length, 0)
  assert.equal((await f.call('zoom.list')).entries.length, 0)
  assert.equal(fs.existsSync(saved), true)
  assert.throws(() => f.manager.forgetPartition('persist:main'), { code: 'bad_params' })
})

test('iframe permissions never inherit the top-level grant and opaque origins fail closed', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  Object.defineProperty(session, 'webRequest', { get() { throw new Error('Must not replace extension request hooks') } })
  f.manager.attachSession(session, 'persist:main')
  await f.call('permissions.set', grant())
  assert.equal(await request(session, wc, 'geolocation', { requestingUrl: 'https://third-party.test/frame', isMainFrame: false }), false)
  for (const requestingUrl of ['', 'null', 'data:text/html,opaque', 'about:blank']) {
    assert.equal(await request(session, wc, 'geolocation', { requestingUrl }), false)
    assert.equal(session.check(null, 'geolocation', requestingUrl), false)
  }
  assert.equal(session.check(null, 'geolocation', 'https://example.test'), true)
  f.dialog.showMessageBox = async () => ({ response: 3 })
  assert.equal(await request(session, wc, 'notifications', { requestingUrl: 'https://third-party.test/frame', isMainFrame: false }), true)
  assert.equal(session.check(wc, 'notifications', 'https://third-party.test'), true)
  assert.equal(session.check(wc, 'notifications', 'https://example.test'), false)
})

test('iframe navigation invalidates its pending native permission prompt', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  let answer
  f.dialog.showMessageBox = () => new Promise((resolve) => { answer = resolve })
  f.manager.attachSession(session, 'persist:main')
  const decision = request(session, wc, 'geolocation', { requestingUrl: 'https://frame.test/one', isMainFrame: false })
  await turn()
  wc.emit('did-start-navigation', {}, 'https://frame.test/two', false, false)
  answer({ response: 3 })
  assert.equal(await decision, false)
  await turn()
  assert.deepEqual((await f.call('permissions.list')).entries, [])
})

test('an unusable download directory cancels with an actionable error instead of crashing the session callback', async (t) => {
  const f = fixture(t), session = new FakeSession()
  const notDirectory = path.join(f.dir, 'not-a-directory')
  fs.writeFileSync(notDirectory, 'keep')
  f.state.settings.downloadDirectory = notDirectory
  f.state.settings.downloadAskWhere = false
  f.manager.attachSession(session, 'persist:main')
  session.emit('will-download', {}, new FakeDownload(), null)
  const row = (await f.call('downloads.list')).entries[0]
  assert.equal(row.state, 'cancelled')
  assert.match(row.error, /Could not prepare download destination/)
  assert.deepEqual(f.manager.snapshot().activeDownloads, [])
  assert.equal(fs.readFileSync(notDirectory, 'utf8'), 'keep')
})

test('remembered media and session screen-capture checks protect their source tab without a new prompt', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  f.manager.attachSession(session, 'persist:main')
  f.manager.applyZoom(wc, tab('capture-source'))
  for (const [permission, lifetime] of [['media', 'remember'], ['display-capture', 'session']]) {
    await f.call('permissions.set', grant('persist:main', { permission, lifetime }))
    const before = f.events.filter((event) => event.name === 'browser-permission-granted').length
    assert.equal(session.check(wc, permission, 'https://example.test'), true)
    const events = f.events.filter((event) => event.name === 'browser-permission-granted')
    assert.equal(events.length, before + 1)
    assert.deepEqual(events.at(-1).payload, { tabId: 'capture-source', permission })
    assert.equal(session.check(wc, permission, 'https://other.test'), false)
    assert.equal(f.events.filter((event) => event.name === 'browser-permission-granted').length, events.length)
  }
})

test('allow-once survives preflight checks but is consumed by exactly one request', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  f.manager.attachSession(session, 'persist:main')
  f.manager.applyZoom(wc, tab('one-call'))
  await f.call('permissions.set', grant('persist:main', { permission: 'media', lifetime: 'once' }))
  for (let i = 0; i < 2; i++) assert.equal(session.check(wc, 'media', 'https://example.test'), false)
  assert.equal((await f.call('permissions.list')).entries.length, 1)
  assert.equal(f.events.some((event) => event.name === 'browser-permission-granted'), false)
  const chromiumRequest = () => session.check(wc, 'media', 'https://example.test') ? Promise.resolve(true) : request(session, wc, 'media')
  assert.equal(await chromiumRequest(), true)
  assert.equal((await f.call('permissions.list')).entries.length, 0)
  assert.equal(await chromiumRequest(), false)
  assert.equal(f.events.filter((event) => event.name === 'browser-permission-granted').length, 1)
})

test('download source is its initiating iframe, with origin-only and opaque initiator fallbacks preserved on retry', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  f.manager.attachSession(session, 'persist:work')
  f.manager.applyZoom(wc, tab('iframe-host', 'persist:work'))
  const frame = { url: 'https://embedded.test/download-page' }, item = new FakeDownload()
  item.getInitiatorOrigin = () => 'https://embedded.test'
  session.emit('will-download', {}, item, wc, frame)
  const row = (await f.call('downloads.list')).entries[0]
  frame.url = 'https://navigated.test/'
  wc.navigate('https://new-top-level.test/')
  assert.equal(row.sourceUrl, 'https://embedded.test/download-page')
  assert.equal(row.sourceOrigin, 'https://embedded.test')
  assert.equal(row.topLevelUrl, 'https://example.test/page')
  await f.call('downloads.cancel', { id: row.id })
  await f.call('downloads.retry', { id: row.id })
  const retry = (await f.call('downloads.list')).entries[0]
  assert.equal(retry.sourceUrl, row.sourceUrl)
  assert.equal(retry.sourceOrigin, row.sourceOrigin)
  assert.equal(retry.topLevelUrl, row.topLevelUrl)
  for (const origin of ['https://detached.test', 'null']) {
    const detached = new FakeDownload()
    detached.getInitiatorOrigin = () => origin
    session.emit('will-download', {}, detached, wc, null)
    const entry = (await f.call('downloads.list')).entries[0]
    assert.equal(entry.sourceOrigin, origin)
    assert.equal(entry.sourceUrl, origin)
    assert.notEqual(entry.sourceUrl, wc.getURL())
  }
})

test('unrelated iframe navigation leaves a top-level permission prompt pending', async (t) => {
  const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
  let answer
  f.dialog.showMessageBox = () => new Promise((resolve) => { answer = resolve })
  f.manager.attachSession(session, 'persist:main')
  const decision = request(session, wc, 'geolocation', { isMainFrame: true })
  await turn()
  wc.emit('did-start-navigation', { isSameDocument: false, isMainFrame: false, url: 'https://ads.test/new', frame: { url: 'https://ads.test/old' } })
  assert.equal(f.manager.snapshot().pendingPermissions.length, 1)
  answer({ response: 1 })
  assert.equal(await decision, true)
})

test('iframe prompt tracks URL-matched frame candidates and ignores sibling navigation', async (t) => {
  for (const navigateRequestFrame of [false, true]) {
    const f = fixture(t), session = new FakeSession(), wc = new FakeContents()
    const own = { url: 'https://frame.test/request', processId: 10, routingId: 20 }
    const sibling = { url: 'https://frame.test/sibling', processId: 10, routingId: 21 }
    wc.mainFrame = { url: wc.getURL(), framesInSubtree: [own, sibling] }
    let answer
    f.dialog.showMessageBox = () => new Promise((resolve) => { answer = resolve })
    f.manager.attachSession(session, 'persist:main')
    const decision = request(session, wc, 'geolocation', { requestingUrl: own.url, isMainFrame: false })
    await turn()
    wc.emit('did-start-navigation', { isSameDocument: false, isMainFrame: false, url: 'https://different.test/sibling', frame: sibling })
    assert.equal(f.manager.snapshot().pendingPermissions.length, 1)
    if (navigateRequestFrame) wc.emit('did-start-navigation', { isSameDocument: false, isMainFrame: false, url: 'https://different.test/request', frame: own })
    answer({ response: 3 })
    assert.equal(await decision, !navigateRequestFrame)
    assert.equal((await f.call('permissions.list')).entries.length, navigateRequestFrame ? 0 : 1)
  }
})

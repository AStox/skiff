'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { test, expect } = require('./fixtures')
const { execFileSync } = require('node:child_process')

test.use({ fixtureOptions: { componentConsent: 1, legacyShell: process.env.SKIFF_POINTER_LEGACY_SOURCE, nativeScale: process.env.SKIFF_POINTER_NATIVE_SCALE === '1' } })

const shellsDir = path.join(__dirname, '..', 'shells')
const manifest = (name) => { try { return JSON.parse(fs.readFileSync(path.join(shellsDir, name, 'shell.json'), 'utf8')) } catch { return {} } }

// The app or desk window is the one showing the shell's index.html; a float overlay is a window of its own.
const windowInfo = (skiff) => skiff.app.evaluate(({ BrowserWindow, screen }) => {
  const all = BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('/index.html'))
  const win = all[0]
  return { count: all.length, id: win.id, bounds: win.getBounds(), content: win.getContentBounds(), size: win.getContentSize(), area: screen.getDisplayMatching(win.getBounds()).workArea, resizable: win.isResizable() }
})
const pageIds = (skiff) => skiff.app.evaluate(({ webContents }) => Object.fromEntries(webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith('http')).map((wc) => [new URL(wc.getURL()).pathname, wc.id])))
// Page views of the window, back to front.
const views = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children.filter((view) => view.webContents?.getURL().startsWith('http')).map((view) => ({ path: new URL(view.webContents.getURL()).pathname, ...view.getBounds() })))
// Every child view of the window, back to front: pages by path, frames by tab id, other shell pages by file.
const children = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children.map((view) => {
  const url = URL.canParse(view.webContents?.getURL()) ? new URL(view.webContents.getURL()) : null
  const kind = !url ? 'other' : url.protocol.startsWith('http') ? 'page' : url.pathname.endsWith('/frame.html') ? 'frame' : 'file'
  return { kind, name: kind === 'page' ? url.pathname : kind === 'frame' ? url.searchParams.get('tab') : url?.pathname.split('/').pop(), ...view.getBounds() }
}))
const liveFrames = (skiff) => skiff.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.getURL()).filter((url) => url.includes('/frame.html?tab=')).map((url) => new URL(url).searchParams.get('tab')).sort())
const shellPage = async (skiff, suffix) => {
  await expect.poll(() => skiff.app.context().pages().some((page) => page.url().endsWith(suffix))).toBe(true)
  return skiff.app.context().pages().find((page) => page.url().endsWith(suffix))
}
// Playwright emulates document focus in every page, so ask the main process.
const hasFocus = (skiff, page) => skiff.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((wc) => wc.getURL() === url).isFocused(), page.url())
const floats = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().endsWith('/index.html')).map((w) => ({ id: w.id, file: w.webContents.getURL().split('/').pop(), bounds: w.getBounds(), visible: w.isVisible() })))
const isFocused = (skiff, id) => skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isFocused(), id)
// A float overlay's window: frameless, transparent, out of the taskbar, above normal windows and on every desktop, full-screen ones too.
async function expectFloating(skiff, id) {
  const audit = await skiff.audit()
  expect(audit.windows.find((w) => w.id === id)).toMatchObject({ show: false, frame: false, transparent: true, hasShadow: false, resizable: false, skipTaskbar: true, hiddenInMissionControl: true, acceptFirstMouse: true })
  expect(audit.alwaysOnTop.filter((call) => call.id === id)).toEqual([{ id, flag: true, level: 'floating' }])
  expect(audit.allWorkspaces.filter((call) => call.id === id)).toEqual([{ id, visible: true, visibleOnFullScreen: true, skipTransformProcessType: true }])
}
// setIgnoreMouseEvents calls of one window, or of all of them.
const ignoreCalls = async (skiff, id) => (await skiff.audit()).ignoreMouse.filter((call) => id === undefined || call.id === id).map(({ ignore, forward }) => ({ ignore, forward }))
const ignoring = async (skiff, id) => (await ignoreCalls(skiff, id)).at(-1)
const cursor = (skiff, point) => skiff.app.evaluate((_electron, point) => { global.__skiffVisualCursor = point }, point)
const tabOf = async (skiff, id) => (await skiff.state()).tabs.find((t) => t.id === id)

const INSET = { top: 30, right: 8, bottom: 8, left: 8 }
const grow = (r) => ({ x: r.x - INSET.left, y: r.y - INSET.top, width: r.width + INSET.left + INSET.right, height: r.height + INSET.top + INSET.bottom })
const recorder = "<script>window.events = []; for (const name of ['look-through', 'ping', 'desk-activated']) window.skiff.on(name, (data) => window.events.push([name, data])); window.skiff.on('state', (s) => { window.lastState = s })</script>"
// Copy the selected desk into an owned component, make its UI inert, and select
// every copied surface explicitly so independent stock frame/overlay code stops.
async function inertShell(skiff, script) {
  const selected = await skiff.rpc('ui.inspectSource', { role: 'shell' })
  const copy = await skiff.rpc('components.create', { id: 'custom.inert-desk', from: selected.id })
  const pages = new Set([...copy.files.filter((file) => file.endsWith('.html') && file !== 'index.html'), 'frame.html', 'a.html', 'b.html', 'f.html'])
  for (const file of pages) await skiff.rpc('components.source.write', { id: copy.id, file, content: `<!doctype html><title>${file}</title>${script}` })
  await skiff.rpc('components.source.write', { id: copy.id, file: 'shell.json', content: JSON.stringify({ window: 'desk', frame: { file: 'frame.html', ...INSET } }) })
  await skiff.rpc('components.source.write', { id: copy.id, file: 'index.html', content: `<!doctype html><title>Desk test</title>${script}` })
  await skiff.rpc('components.apply', { id: copy.id })
  for (const role of Object.keys(copy.manifest.surfaces)) {
    const bound = await skiff.rpc('components.bind', { id: copy.id, role })
    expect(bound.owner).toBe(copy.id)
  }
  await expect(skiff.shell).toHaveTitle('Desk test')
}
// webContents ids of the frame views by tab id.
const frameIds = (skiff) => skiff.app.evaluate(({ webContents }) => Object.fromEntries(webContents.getAllWebContents().filter((wc) => wc.getURL().includes('/frame.html?tab=')).map((wc) => [new URL(wc.getURL()).searchParams.get('tab'), wc.id])))
// View moves recorded by the entry, from startMoves to takeMoves; xs lists one webContents' x positions in order.
const startMoves = (skiff) => skiff.app.evaluate(() => { global.__skiffVisualMoves = [] })
const takeMoves = (skiff) => skiff.app.evaluate(() => { const list = global.__skiffVisualMoves; global.__skiffVisualMoves = null; return list })
const xs = (log, id) => log.filter((move) => move.id === id).map((move) => move.x)
const falling = (list) => list.every((x, i) => !i || x <= list[i - 1])
const rising = (list) => list.every((x, i) => !i || x >= list[i - 1])
// Isolate native Mac hits from any real app underneath a transparent desk.
const guardNativeDesk = (skiff, wcId) => process.platform === 'darwin' ? skiff.app.evaluate(async ({ BrowserWindow, screen, webContents }, id) => {
  const wc = webContents.fromId(id)
  const desk = BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents === wc))
  const area = screen.getDisplayMatching(desk.getBounds()).workArea
  const guard = new BrowserWindow({ ...area, show: false, frame: false, transparent: false, backgroundColor: '#202020', hasShadow: false, skipTaskbar: true, movable: false, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await guard.loadURL('data:text/html,<html><body style="margin:0;background:%23202020"></body></html>')
  guard.setIgnoreMouseEvents(false)
  guard.setAlwaysOnTop(true, 'floating')
  guard.showInactive()
  desk.setAlwaysOnTop(true, 'floating', 1)
  desk.focus()
  // Existing fixture teardown destroys both owned windows on failure too.
  return guard.getContentBounds()
}, wcId) : null

test('background page drag regions cannot block native modal and media controls', async ({ skiff }, testInfo) => {
  if (process.env.SKIFF_POINTER_LEGACY_SOURCE) expect((await skiff.rpc('ui.shellPath')).owner).toBe('legacy.shell')
  const peer = await skiff.rpc('tabs.create', { url: skiff.origin + '/drag-region-fixture' })
  const peerPage = await skiff.page('/drag-region-fixture')
  const peerBounds = { x: 220, y: 120, width: 720, height: 500 }
  await skiff.rpc('desk.place', { id: peer.id, ...peerBounds })
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/pointer-fixture' })
  const page = await skiff.page('/pointer-fixture')
  const bounds = { x: 300, y: 160, width: 720, height: 500 }
  await skiff.rpc('desk.place', { id: tab.id, ...bounds })
  const identity = await page.evaluate(() => performance.timeOrigin)
  const wcId = (await pageIds(skiff))['/pointer-fixture']
  const overflow = await peerPage.locator('#overflow').evaluate((el) => el.getBoundingClientRect().toJSON())
  const dragDocument = await peerPage.content()
  const protectedArea = await guardNativeDesk(skiff, wcId)
  await cursor(skiff, null)
  let stage
  const hit = async (selector, { click = false, at, dx = 0 } = {}) => {
    const rect = await page.locator(selector).evaluate((el) => el.getBoundingClientRect().toJSON())
    const geometry = await skiff.app.evaluate(({ BrowserWindow, webContents }, id) => {
      const wc = webContents.fromId(id)
      const win = BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents === wc))
      const view = win.contentView.children.find((v) => v.webContents === wc)
      return { content: win.getContentBounds(), bounds: view.getBounds(), zoom: wc.getZoomFactor() }
    }, wcId)
    const css = at || { x: rect.x + rect.width / 2 + dx, y: rect.y + rect.height / 2 }
    const point = { x: Math.round(geometry.content.x + geometry.bounds.x + css.x * geometry.zoom), y: Math.round(geometry.content.y + geometry.bounds.y + css.y * geometry.zoom), click }
    if (protectedArea) {
      expect(point.x).toBeGreaterThanOrEqual(protectedArea.x)
      expect(point.y).toBeGreaterThanOrEqual(protectedArea.y)
      expect(point.x).toBeLessThan(protectedArea.x + protectedArea.width)
      expect(point.y).toBeLessThan(protectedArea.y + protectedArea.height)
    }
    await page.evaluate(() => { window.pointerEvents = [] })
    execFileSync('python3', [path.join(__dirname, 'native-pointer.py'), JSON.stringify(point)], { timeout: 5000 })
    let event
    try {
      await expect.poll(async () => {
        event = await page.evaluate(({ point, type }) => window.pointerEvents.findLast((event) => event.type === type && Math.abs(event.screenX - point.x) <= 1 && Math.abs(event.screenY - point.y) <= 1), { point, type: click ? 'click' : 'mousemove' })
        return Boolean(event)
      }).toBe(true)
      expect(event).toMatchObject({ target: selector.slice(1), trusted: true })
      expect(Math.abs(event.x - css.x)).toBeLessThanOrEqual(2)
      expect(Math.abs(event.y - css.y)).toBeLessThanOrEqual(2)
    } finally {
      const events = await page.evaluate(() => ({ pointer: window.pointerEvents, hover: window.hoverEvents }))
      await testInfo.attach('native-pointer-coordinates', { body: JSON.stringify({ stage, selector, rect, geometry, css, point, event, events }, null, 2), contentType: 'application/json' })
    }
  }
  for (const [index, name] of ['author-important', 'navigation', 'dynamic-closed-shadow', 'iframe'].entries()) {
    stage = name
    if (stage === 'navigation') {
      const previous = await peerPage.evaluate(() => performance.timeOrigin)
      await peerPage.goto(skiff.origin + '/drag-region-fixture?navigation=1')
      expect(await peerPage.evaluate(() => performance.timeOrigin)).not.toBe(previous)
    }
    if (stage === 'dynamic-closed-shadow') await peerPage.evaluate(() => window.addClosedDragShadow())
    if (stage === 'iframe') {
      // An opaque-origin child document uses the real browser-session preload.
      await peerPage.evaluate((html) => {
        document.querySelector('style')?.remove()
        const frame = document.createElement('iframe')
        frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0'
        frame.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
        document.body.replaceChildren(frame)
      }, dragDocument)
      await expect.poll(() => peerPage.frames().some((frame) => frame.url().startsWith('data:text/html'))).toBe(true)
      await expect(peerPage.frames().find((frame) => frame.url().startsWith('data:text/html')).locator('#overflow')).toBeAttached()
    }
    const layout = await children(skiff)
    expect(layout.filter((view) => view.kind === 'page').map((view) => view.name)).toEqual(['/drag-region-fixture', '/pointer-fixture'])
    expect(layout.find((view) => view.name === '/pointer-fixture')).toMatchObject(bounds)
    expect(layout.find((view) => view.name === '/drag-region-fixture')).toMatchObject(peerBounds)
    const peerFrame = layout.find((view) => view.kind === 'frame' && view.name === peer.id)
    // The second video point is outside the peer frame but inside its overflow.
    expect(bounds.x + 690).toBeGreaterThan(peerFrame.x + peerFrame.width)
    expect(bounds.x + 690).toBeGreaterThan(peerBounds.x + overflow.x)
    expect(bounds.x + 690).toBeLessThan(peerBounds.x + overflow.right)
    expect(bounds.y + 175).toBeGreaterThan(peerBounds.y + overflow.y)
    expect(bounds.y + 175).toBeLessThan(peerBounds.y + overflow.bottom)
    // Native drag-region updates reach the compositor asynchronously.
    await page.waitForTimeout(150)
    await hit('#close', { click: true })
    expect(await page.evaluate(() => window.closedImages)).toBe(index + 1)
    await hit('#video')
    await hit('#video', { at: { x: 690, y: 175 } })
    await hit('#play', { click: true })
    await expect.poll(() => page.locator('video').evaluate((video) => video.paused)).toBe(index % 2 === 1)
    const leaves = await page.evaluate(() => { window.hoverEvents = []; return window.playerLeaves })
    await hit('#volume')
    await hit('#volume', { click: true, dx: 4 })
    expect(await page.evaluate(() => window.volumeClicks)).toBe(index + 1)
    expect(await page.locator('#controls').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible')
    expect(await page.evaluate(() => window.playerLeaves)).toBe(leaves)
    expect(await page.evaluate(() => window.hoverEvents.filter((event) => event.target === 'player' && ['mouseleave', 'pointerleave'].includes(event.type)))).toEqual([])
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(identity)
  }
})

test('native wheel and scrollbar drags scroll pages without moving the root window or tab', async ({ skiff }, testInfo) => {
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/scroll-fixture' })
  const page = await skiff.page('/scroll-fixture')
  await skiff.rpc('desk.place', { id: tab.id, x: 160, y: 120, width: 640, height: 520 })
  const wcId = (await pageIds(skiff))['/scroll-fixture']
  const protectedArea = await guardNativeDesk(skiff, wcId)
  await cursor(skiff, null)
  const geometry = () => skiff.app.evaluate(({ BrowserWindow, webContents }, id) => {
    const wc = webContents.fromId(id)
    const win = BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents === wc))
    const view = win.contentView.children.find((v) => v.webContents === wc)
    return { root: win.getBounds(), content: win.getContentBounds(), tab: view.getBounds(), zoom: wc.getZoomFactor() }
  }, wcId)
  const original = await geometry()
  const originalDesk = (await tabOf(skiff, tab.id)).desk
  const native = (at, action) => {
    const screen = ({ x, y }) => ({ x: Math.round(original.content.x + original.tab.x + x * original.zoom), y: Math.round(original.content.y + original.tab.y + y * original.zoom) })
    const point = { ...screen(at), ...action }
    if (action.drag) point.drag = screen(action.drag)
    for (const position of [point, ...(point.drag ? [point.drag] : [])]) {
      if (!protectedArea) continue
      expect(position.x).toBeGreaterThanOrEqual(protectedArea.x)
      expect(position.y).toBeGreaterThanOrEqual(protectedArea.y)
      expect(position.x).toBeLessThan(protectedArea.x + protectedArea.width)
      expect(position.y).toBeLessThan(protectedArea.y + protectedArea.height)
    }
    execFileSync('python3', [path.join(__dirname, 'native-pointer.py'), JSON.stringify(point)], { timeout: 5000 })
  }
  for (const selector of [null, '#nested']) {
    const offset = () => page.evaluate((selector) => (selector ? document.querySelector(selector) : document.scrollingElement).scrollTop, selector)
    const metrics = await page.evaluate((selector) => {
      const el = selector ? document.querySelector(selector) : document.scrollingElement
      const rect = selector ? el.getBoundingClientRect() : { x: 0, y: 0, width: innerWidth, height: innerHeight }
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }
    }, selector)
    expect(metrics.width - metrics.clientWidth).toBeGreaterThan(0)
    const center = { x: metrics.x + (selector ? metrics.clientWidth / 2 : metrics.clientWidth - 64), y: metrics.y + metrics.clientHeight / 2 }
    try {
      await page.evaluate(() => { window.nativeScrollEvents = [] })
      // OS-generated discrete wheel input is not proof of physical trackpad behavior.
      native(center, { wheel: 3 })
      await expect.poll(offset).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(() => window.nativeScrollEvents.some((event) => event.type === 'wheel' && event.trusted && event.deltaY > 0))).toBe(true)
      // Wait for native wheel animation to finish before locating the thumb.
      let previous = -1
      let stable = 0
      await expect.poll(async () => {
        const current = await offset()
        stable = current === previous ? stable + 1 : 0
        previous = current
        return stable
      }, { intervals: [50] }).toBeGreaterThanOrEqual(2)
      expect(await geometry()).toEqual(original)
      expect((await tabOf(skiff, tab.id)).desk).toEqual(originalDesk)
      await page.evaluate((selector) => { (selector ? document.querySelector(selector) : document.scrollingElement).scrollTop = 0 }, selector)
      await expect.poll(offset).toBe(0)
      const thumb = { x: metrics.x + metrics.clientWidth + (metrics.width - metrics.clientWidth) / 2, y: metrics.y + metrics.clientHeight * metrics.clientHeight / metrics.scrollHeight / 2 }
      native(thumb, { drag: { x: thumb.x, y: thumb.y + 90 } })
      await expect.poll(offset).toBeGreaterThan(100)
      expect(await geometry()).toEqual(original)
      expect((await tabOf(skiff, tab.id)).desk).toEqual(originalDesk)
    } finally {
      await testInfo.attach('native-scroll-result', { body: JSON.stringify({
        scroller: selector || 'document', metrics, original, final: await geometry(),
        originalDesk, finalDesk: (await tabOf(skiff, tab.id)).desk, scrollTop: await offset(),
        events: await page.evaluate(() => window.nativeScrollEvents)
      }, null, 2), contentType: 'application/json' })
    }
  }
})

test('a desk shell gets a transparent window over the work area that shows every ordinary tab as a framed window', async ({ skiff }) => {
  const one = (await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })).id
  const two = (await skiff.rpc('tabs.create', { url: skiff.origin + '/two' })).id
  const three = (await skiff.rpc('tabs.create', { url: skiff.origin + '/three', activate: false })).id
  const four = (await skiff.rpc('tabs.create', { url: skiff.origin + '/four', activate: false })).id
  await skiff.page('/one')
  await skiff.page('/two')
  const ids = await pageIds(skiff)

  // Somewhere no desk window will be, so the pointer stays passed through until the test moves it.
  const empty = { x: 1300, y: 800 }
  await cursor(skiff, empty)
  const desk = await windowInfo(skiff)
  expect(desk.count).toBe(1)
  // The desk shell floats its Buoy in a window of its own, on the desk window's display.
  await expect.poll(async () => (await floats(skiff)).map((f) => [f.file, f.visible])).toEqual([['buoy.html', true]])
  const [buoy] = await floats(skiff)
  await expectFloating(skiff, buoy.id)
  expect(buoy.bounds.x).toBeGreaterThanOrEqual(desk.content.x)
  expect(buoy.bounds.y + buoy.bounds.height).toBeLessThanOrEqual(desk.content.y + desk.content.height)
  expect((await skiff.audit()).windows.at(-1)).toMatchObject({ frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, backgroundColor: '#00000000' })
  expect(desk.resizable).toBe(false)
  // Frameless: no title bar between the window edge and the content.
  expect(desk.content).toEqual(desk.bounds)
  // Xvfb with no window manager opens a window exactly the screen's size 1px short, so allow that pixel.
  for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(desk.bounds[key] - desk.area[key])).toBeLessThanOrEqual(1)
  expect(await pageIds(skiff)).toMatchObject(ids)

  // Every shell page made inert, plus a frame page and two overlay pages, so only this test calls ui.setDesk, desk.* and overlays.
  await inertShell(skiff, recorder)
  // A shell reload closes the float window with the rest of the shell's views.
  await expect.poll(() => floats(skiff)).toEqual([])
  const { deskSize } = await skiff.state()
  expect(deskSize).toEqual({ width: desk.size[0], height: desk.size[1] })
  const paths = { [one]: '/one', [two]: '/two' }
  // Frames named by their tab's page path, so a layout reads as one list.
  const layout = async () => (await children(skiff)).map((c) => ({ ...c, name: c.kind === 'frame' ? paths[c.name] : c.name }))
  const order = async () => (await layout()).map((c) => `${c.kind} ${c.name}`)
  const windows = (...list) => list.flatMap((p) => [`frame ${p}`, `page ${p}`])
  const zOf = async (id) => (await tabOf(skiff, id)).desk.z
  const z0 = Math.max(0, ...(await skiff.state()).tabs.filter((t) => t.desk).map((t) => t.desk.z))

  const rects = { [one]: { x: 40, y: 60, width: 500, height: 400 }, [two]: { x: 300, y: 200, width: 600, height: 450 } }
  await skiff.rpc('desk.place', { id: one, ...rects[one] })
  await skiff.rpc('desk.place', { id: two, ...rects[two] })
  expect((await tabOf(skiff, one)).desk).toEqual({ ...rects[one], z: z0 + 1 })
  expect((await tabOf(skiff, two)).desk).toEqual({ ...rects[two], z: z0 + 2 })

  // Windows opened in the background stay behind the placed ones, in tab order.
  Object.assign(paths, { [three]: '/three', [four]: '/four' })
  for (const id of [three, four]) rects[id] = (({ x, y, width, height }) => ({ x, y, width, height }))((await tabOf(skiff, id)).desk)
  // Each frame sits directly under its own page, at the window rect grown by the shell's insets.
  const expected = (...list) => list.flatMap((p) => {
    const id = Object.keys(paths).find((key) => paths[key] === p)
    return [{ kind: 'frame', name: p, ...grow(rects[id]) }, { kind: 'page', name: p, ...rects[id] }]
  })
  await expect.poll(layout).toEqual(expected('/three', '/four', '/one', '/two'))
  expect(Object.keys(await pageIds(skiff)).sort()).toEqual(['/four', '/one', '/three', '/two'])
  expect(await liveFrames(skiff)).toEqual([one, two, three, four].sort())
  // A frame page gets the shell bridge and state pushes.
  const frameOf = (id) => shellPage(skiff, `/frame.html?tab=${id}`)
  expect((await (await frameOf(two)).evaluate(() => window.skiff.call('state.get'))).deskSize).toEqual(deskSize)

  await skiff.rpc('tabs.activate', { id: one })
  expect(await zOf(one)).toBe(z0 + 3)
  expect(await order()).toEqual(windows('/three', '/four', '/two', '/one'))
  // A tab placed while another is active goes on top of the others, under the active one.
  rects[three] = { x: 700, y: 100, width: 400, height: 300 }
  await skiff.rpc('desk.place', { id: three, ...rects[three] })
  expect(await zOf(three)).toBe(z0 + 4)
  await expect.poll(layout).toEqual(expected('/four', '/two', '/three', '/one'))

  const placed = async () => (await skiff.state()).tabs.map((t) => [t.id, t.desk])
  const before = await placed()
  const moved = { x: 10, y: 20, width: 300, height: 200 }
  await skiff.rpc('ui.setDesk', { preview: { id: two, ...moved } })
  const previewed = await layout()
  expect(previewed.filter((c) => c.name === '/two')).toEqual([{ kind: 'frame', name: '/two', ...grow(moved) }, { kind: 'page', name: '/two', ...moved }])
  expect(previewed.findIndex((c) => c.kind === 'page' && c.name === '/two')).toBe(previewed.findIndex((c) => c.kind === 'frame' && c.name === '/two') + 1)
  expect(await placed()).toEqual(before)
  await skiff.rpc('ui.setDesk', { preview: null })
  expect(await layout()).toEqual(expected('/four', '/two', '/three', '/one'))
  expect(await skiff.shell.evaluate(() => window.skiff.call('ui.setDesk', { preview: { id: 'nope', x: 0, y: 0, width: 10, height: 10 } }).catch((e) => e.code))).toBe('not_found')
  expect(await skiff.shell.evaluate(() => window.skiff.call('desk.place', { x: 0, y: 0, width: 239, height: 400 }).catch((e) => e.code))).toBe('bad_params')

  // Hiding the active window detaches its page and frame, both still loaded; the frontmost window left becomes active.
  await skiff.rpc('desk.hide', { id: one })
  let after = await skiff.state()
  expect(after.tabs.find((t) => t.id === one).desk).toEqual({ ...rects[one], z: z0 + 3, hidden: true })
  expect(after.activeTabBySpace[after.activeSpaceId]).toBe(three)
  expect(await order()).toEqual(windows('/four', '/two', '/three'))
  expect((await pageIds(skiff))['/one']).toBe(ids['/one'])
  expect(await liveFrames(skiff)).toContain(one)
  // Showing it brings page and frame back in front, active.
  await skiff.rpc('desk.show', { id: one })
  after = await skiff.state()
  expect(after.tabs.find((t) => t.id === one).desk).toEqual({ ...rects[one], z: z0 + 5 })
  expect(after.activeTabBySpace[after.activeSpaceId]).toBe(one)
  expect(await order()).toEqual(windows('/four', '/two', '/three', '/one'))
  expect((await pageIds(skiff))['/one']).toBe(ids['/one'])
  // A hidden window keeps its rect; closing a tab drops its page and frame.
  await skiff.rpc('desk.hide', { id: four })
  expect((await tabOf(skiff, four)).desk).toEqual({ ...rects[four], z: expect.any(Number), hidden: true })
  await skiff.rpc('desk.hide', { id: one })
  expect(await order()).toEqual(windows('/two', '/three'))
  await skiff.rpc('tabs.close', { id: four })
  await expect.poll(() => liveFrames(skiff)).toEqual([one, two, three].sort())
  expect(Object.keys(await pageIds(skiff)).sort()).toEqual(['/one', '/three', '/two'])

  // Named overlays sit above every window, 'main' on top; focus: false leaves keyboard focus where it was.
  await skiff.rpc('ui.showOverlay', { file: 'a.html' })
  const a = await shellPage(skiff, '/a.html')
  await expect.poll(() => hasFocus(skiff, a)).toBe(true)
  await skiff.rpc('ui.showOverlay', { file: 'b.html', name: 'side', bounds: { x: 1200, y: 20, width: 200, height: 100 }, focus: false })
  const b = await shellPage(skiff, '/b.html')
  expect((await order()).slice(-2)).toEqual(['file b.html', 'file a.html'])
  expect((await layout()).at(-2)).toMatchObject({ x: 1200, y: 20, width: 200, height: 100 })
  expect(await hasFocus(skiff, a)).toBe(true)
  expect(await hasFocus(skiff, b)).toBe(false)
  await skiff.rpc('ui.showOverlay', { file: 'a.html', bounds: { x: 0, y: 0, width: 400, height: 300 } })
  expect((await order()).slice(-2)).toEqual(['file b.html', 'file a.html'])
  // float: true puts an overlay in a window of its own, never a view of the desk window, at its bounds on the screen.
  const [, deskHeight] = desk.size
  const floatAt = (b) => ({ x: desk.content.x + b.x, y: desk.content.y + (b.y < 0 ? deskHeight + b.y : b.y), width: b.width, height: b.height })
  const first = { x: 400, y: -140, width: 240, height: 64 }
  await skiff.rpc('ui.showOverlay', { file: 'f.html', name: 'buoy', float: true, bounds: first, focus: false })
  await expect.poll(() => floats(skiff)).toEqual([{ id: expect.any(Number), file: 'f.html', bounds: floatAt(first), visible: true }])
  const floatId = (await floats(skiff))[0].id
  await expectFloating(skiff, floatId)
  expect((await order()).filter((c) => c.includes('f.html'))).toEqual([])
  const fPage = await shellPage(skiff, '/f.html')
  expect(await hasFocus(skiff, a)).toBe(true)
  const placedFloat = { x: 420, y: -150, width: 260, height: 64 }
  await skiff.rpc('ui.showOverlay', { file: 'f.html', name: 'buoy', float: true, bounds: placedFloat, hit: [{ x: 16, y: 16, width: 228, height: 32 }], focus: false })
  await expect.poll(() => floats(skiff)).toEqual([{ id: floatId, file: 'f.html', bounds: floatAt(placedFloat), visible: true }])
  expect(await skiff.shell.evaluate(() => window.skiff.call('ui.showOverlay', { file: 'f.html', name: 'x', float: 'yes' }).catch((e) => e.code))).toBe('bad_params')
  expect(await skiff.shell.evaluate(() => window.skiff.call('ui.showOverlay', { file: 'f.html', name: 'x', hit: [] }).catch((e) => e.code))).toBe('bad_params')
  // ui.emit reaches every shell page; focus: false keeps the page focused.
  await skiff.rpc('ui.focusPage')
  const threePage = await skiff.page('/three')
  await expect.poll(() => hasFocus(skiff, threePage)).toBe(true)
  await skiff.rpc('ui.emit', { name: 'ping', data: 1, focus: false })
  for (const page of [skiff.shell, a, b, fPage, await frameOf(two), await frameOf(three)]) await expect.poll(() => page.evaluate(() => window.events)).toContainEqual(['ping', 1])
  expect(await hasFocus(skiff, threePage)).toBe(true)
  expect(await hasFocus(skiff, a)).toBe(false)
  await skiff.rpc('ui.emit', { name: 'ping', data: 2 })
  await expect.poll(() => hasFocus(skiff, a)).toBe(true)
  await skiff.rpc('ui.hideOverlay')
  expect((await order()).at(-1)).toBe('file b.html')
  expect(await skiff.shell.evaluate(() => window.skiff.call('ui.showOverlay', { file: 'a.html', name: '' }).catch((e) => e.code))).toBe('bad_params')
  expect(await skiff.shell.evaluate(() => window.skiff.call('ui.emit', { name: 'ping', focus: 'no' }).catch((e) => e.code))).toBe('bad_params')
  // An overlay shown from the float window, as the Buoy opens the panel while another window is in front, brings the desk window forward first.
  await skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), floatId)
  await expect.poll(() => isFocused(skiff, desk.id)).toBe(false)
  const focusedBefore = (await skiff.audit()).focused.length
  await fPage.evaluate(() => window.skiff.call('ui.showOverlay', { file: 'a.html' }))
  await expect.poll(() => isFocused(skiff, desk.id)).toBe(true)
  expect((await skiff.audit()).focused.slice(focusedBefore)).toEqual([{ id: desk.id }])
  await expect.poll(() => hasFocus(skiff, a)).toBe(true)
  await skiff.rpc('ui.hideOverlay')

  // Clicks reach Skiff over a page, a frame, an overlay, a hit rect, or anywhere during a drag; elsewhere they pass to the apps below.
  const [, height] = desk.size
  const at = (x, y) => ({ x: desk.content.x + x, y: desk.content.y + y })
  expect(desk.content).toMatchObject({ x: 0, y: 0 })
  const expectIgnore = async (point, ignore, id = desk.id) => {
    if (point) await cursor(skiff, at(point.x, point.y))
    await expect.poll(() => ignoring(skiff, id)).toEqual({ ignore, forward: ignore })
  }
  // The float window takes clicks on its hit rectangle only; its margin passes them on, and so does the desk window under it.
  const overFloat = { x: placedFloat.x + 40, y: height + placedFloat.y + 30 }
  const floatMargin = { x: placedFloat.x + 4, y: height + placedFloat.y + 4 }
  const overPage = { x: rects[two].x + 5, y: rects[two].y + 5 }
  const overFrame = { x: rects[three].x + 350, y: rects[three].y - 15 }
  const overOverlay = { x: 1250, y: 50 }
  const overHit = { x: 30, y: height - 50 }
  await skiff.rpc('ui.setDesk', { hit: [{ x: 20, y: height - 60, width: 200, height: 40 }] })
  await expectIgnore(empty, true)
  await expectIgnore(overPage, false)
  await expectIgnore(empty, true)
  await expectIgnore(overFrame, false)
  await expectIgnore(empty, true)
  await expectIgnore(overOverlay, false)
  await expectIgnore(empty, true)
  await expectIgnore(overHit, false)
  await expectIgnore(empty, true)
  await expectIgnore(empty, true, floatId)
  await expectIgnore(overFloat, false, floatId)
  await expectIgnore(null, true)
  await expectIgnore(floatMargin, true, floatId)
  await expectIgnore(null, true)
  await expectIgnore(empty, true, floatId)
  await skiff.rpc('ui.setDesk', { capture: true })
  await expectIgnore(null, false)
  await expectIgnore(null, false, floatId)
  await cursor(skiff, at(empty.x, empty.y))
  await skiff.rpc('ui.setDesk', { capture: false })
  await expectIgnore(null, true)
  await expectIgnore(null, true, floatId)
  await skiff.rpc('ui.hideOverlay', { name: 'side' })
  await cursor(skiff, at(empty.x, empty.y))
  await expectIgnore(null, true)
  await expectIgnore(null, true, floatId)
  // Only changes are sent.
  for (const id of [desk.id, floatId]) (await ignoreCalls(skiff, id)).forEach((call, i) => expect(call.ignore).toBe(i % 2 === 0))

  // Holding Option sends the shell nothing.
  const key = (type, keyCode) => skiff.app.evaluate(({ BrowserWindow }, [type, keyCode]) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).webContents.sendInputEvent({ type, keyCode }), [type, keyCode])
  await key('keyDown', 'Alt')
  await skiff.shell.waitForTimeout(350)
  await key('keyUp', 'Alt')
  await skiff.shell.waitForTimeout(100)
  for (const page of [skiff.shell, await frameOf(two)]) expect(await page.evaluate(() => window.events.filter(([name]) => name === 'look-through'))).toEqual([])

  // A click on a page behind the active one brings that tab forward.
  await skiff.app.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id)
    for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: 20, y: 20, button: 'left', clickCount: 1 })
  }, ids['/two'])
  await expect.poll(order).toEqual(windows('/three', '/two'))
  expect((await skiff.state()).activeTabBySpace[after.activeSpaceId]).toBe(two)
  expect(await zOf(two)).toBe(z0 + 6)

  // only shows just those windows of the space; every other page and frame stays loaded but off the desk, and clicks there pass on.
  const pagesShown = async () => (await order()).filter((c) => !c.startsWith('file'))
  const deskOnly = async () => (await skiff.state()).deskOnly
  const pushedOnly = (page) => page.evaluate(() => window.lastState?.deskOnly)
  const overThree = { x: rects[three].x + rects[three].width - 20, y: rects[three].y + 40 }
  expect(await deskOnly()).toBeNull()
  await skiff.rpc('ui.setDesk', { only: [two] })
  expect(await pagesShown()).toEqual(windows('/two'))
  expect(await deskOnly()).toEqual([two])
  for (const page of [skiff.shell, fPage, await frameOf(two)]) await expect.poll(() => pushedOnly(page)).toEqual([two])
  expect(Object.keys(await pageIds(skiff)).sort()).toEqual(['/one', '/three', '/two'])
  expect(await liveFrames(skiff)).toEqual([one, two, three].sort())
  await expectIgnore(overPage, false)
  await expectIgnore(overThree, true)
  await expectIgnore(overFrame, true)
  await expectIgnore(empty, true)
  for (const only of [[], 'x', [1]]) expect(await skiff.shell.evaluate((only) => window.skiff.call('ui.setDesk', { only }).catch((e) => e.code), only)).toMatch(/bad_params|not_found/)
  expect(await skiff.shell.evaluate(() => window.skiff.call('ui.setDesk', { only: ['nope'] }).catch((e) => e.code))).toBe('not_found')
  expect(await deskOnly()).toEqual([two])
  // Activating another window adds it; moving one keeps the set.
  await skiff.rpc('tabs.activate', { id: three })
  expect(await deskOnly()).toEqual([two, three])
  expect(await pagesShown()).toEqual(windows('/two', '/three'))
  await expectIgnore(overThree, false)
  await skiff.rpc('ui.setDesk', { preview: { id: three, ...moved } })
  await skiff.rpc('ui.setDesk', { preview: null })
  await skiff.rpc('desk.place', { id: three, ...rects[three] })
  expect(await deskOnly()).toEqual([two, three])
  // Hiding a window drops it from the set; once none is left every window comes back.
  await skiff.rpc('ui.setDesk', { only: [three] })
  expect(await pagesShown()).toEqual(windows('/three'))
  await skiff.rpc('desk.hide', { id: three })
  expect(await deskOnly()).toBeNull()
  await expect.poll(() => pushedOnly(skiff.shell)).toBeNull()
  expect(await pagesShown()).toEqual(windows('/two'))
  await skiff.rpc('desk.show', { id: three })
  await skiff.rpc('tabs.activate', { id: two })
  expect(await pagesShown()).toEqual(windows('/three', '/two'))
  // A space switch ends it.
  await skiff.rpc('ui.setDesk', { only: [two] })
  const other = (await skiff.rpc('spaces.create', { name: 'Other' })).id
  await skiff.rpc('spaces.activate', { id: other })
  expect(await deskOnly()).toBeNull()
  await skiff.rpc('spaces.activate', { id: after.activeSpaceId })
  await expect.poll(pagesShown).toEqual(windows('/three', '/two'))

  // The desk window gaining focus from outside tells the shell desk-activated; ui.raise, a floating overlay or a click on a window does not.
  const activations = () => skiff.shell.evaluate(() => window.events.filter(([name]) => name === 'desk-activated').length)
  const front = async () => (await skiff.rpc('ui.inFront')).front
  const focusDesk = () => skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), desk.id)
  const away = async () => {
    await skiff.app.evaluate(({ BrowserWindow }) => {
      global.__away = new BrowserWindow({ x: 1200, y: 600, width: 200, height: 200 })
      global.__away.focus()
    })
    await expect.poll(() => isFocused(skiff, desk.id)).toBe(false)
    await expect.poll(front).toBe(false)
  }
  const home = () => skiff.app.evaluate(() => { global.__away?.destroy(); global.__away = null })
  await cursor(skiff, at(empty.x, empty.y))
  await focusDesk()
  await expect.poll(front).toBe(true)
  let seen = await activations()
  await away()
  await focusDesk()
  await expect.poll(activations).toBe(seen + 1)
  expect(await front()).toBe(true)
  seen++
  await home()
  await away()
  await skiff.rpc('ui.raise')
  await expect.poll(() => isFocused(skiff, desk.id)).toBe(true)
  await skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), floatId)
  await expect.poll(() => isFocused(skiff, desk.id)).toBe(false)
  await skiff.shell.waitForTimeout(250)
  expect(await front()).toBe(true)
  await focusDesk()
  await home()
  await away()
  await cursor(skiff, at(overPage.x, overPage.y))
  await focusDesk()
  await expect.poll(front).toBe(true)
  await skiff.shell.waitForTimeout(200)
  expect(await activations()).toBe(seen)
  await home()
  await cursor(skiff, at(empty.x, empty.y))

  // A display change refits the window to the work area.
  await skiff.app.evaluate(({ BrowserWindow, screen }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).setBounds({ x: 50, y: 40, width: 900, height: 700 })
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea'])
  })
  const refit = await windowInfo(skiff)
  for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(refit.bounds[key] - refit.area[key])).toBeLessThanOrEqual(1)
  await expect.poll(async () => (await floats(skiff))[0].bounds).toEqual({ x: refit.content.x + placedFloat.x, y: refit.content.y + refit.size[1] + placedFloat.y, width: placedFloat.width, height: placedFloat.height })
})

test('a space switch slides the old space out and the new one in, retargets mid-slide, and is instant without animation', async ({ skiff }) => {
  const first = (await skiff.state()).activeSpaceId
  const second = (await skiff.rpc('spaces.create', { name: 'Second' })).id
  const tabs = {}
  for (const name of ['a1', 'a2']) tabs[name] = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/${name}` })).id
  for (const name of ['b1', 'b2']) tabs[name] = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/${name}`, spaceId: second, activate: false })).id
  await inertShell(skiff, "<script>window.events = []; window.states = []; window.skiff.on('drag-cancel', () => window.events.push('drag-cancel')); window.skiff.on('state', (s) => window.states.push(s.activeSpaceId))</script>")
  const rects = { a1: { x: 40, y: 60, width: 500, height: 400 }, a2: { x: 620, y: 120, width: 520, height: 420 }, b1: { x: 100, y: 80, width: 600, height: 450 }, b2: { x: 760, y: 200, width: 400, height: 300 } }
  for (const [name, rect] of Object.entries(rects)) await skiff.rpc('desk.place', { id: tabs[name], ...rect })
  // The other space's pages and frames load in the background before the first switch to it.
  await expect.poll(async () => Object.keys(await pageIds(skiff)).sort()).toEqual(['/a1', '/a2', '/b1', '/b2'])
  await expect.poll(() => liveFrames(skiff)).toEqual(Object.values(tabs).sort())
  const pages = await pageIds(skiff)
  const frameOf = await frameIds(skiff)
  const [width] = (await windowInfo(skiff)).size
  const showing = async () => (await children(skiff)).filter((c) => c.kind === 'page').map((c) => c.name).sort()
  expect(await showing()).toEqual(['/a1', '/a2'])

  // Next space: the old windows leave to the left a frame at a time while the new ones come in from the right to their rects, frames with their pages.
  await startMoves(skiff)
  await skiff.rpc('spaces.cycle', { delta: 1 })
  expect(await showing()).toEqual(['/a1', '/a2', '/b1', '/b2'])
  await expect.poll(showing).toEqual(['/b1', '/b2'])
  let log = await takeMoves(skiff)
  const out = xs(log, pages['/a1'])
  const into = xs(log, pages['/b1'])
  expect(out.length).toBeGreaterThanOrEqual(4)
  expect(out[0]).toBeLessThan(rects.a1.x)
  expect(out.at(-1)).toBeLessThan(rects.a1.x - width / 2)
  expect(falling(out)).toBe(true)
  expect(into[0]).toBeGreaterThan(rects.b1.x + width / 2)
  expect(falling(into)).toBe(true)
  expect(log.filter((move) => move.id === pages['/b1']).at(-1)).toMatchObject(rects.b1)
  expect(new Set(log.filter((move) => move.id === pages['/a1']).map((move) => move.y))).toEqual(new Set([rects.a1.y]))
  expect(xs(log, frameOf[tabs.a1])).toEqual(out.map((x) => x - INSET.left))
  expect(xs(log, frameOf[tabs.b1])).toEqual(into.map((x) => x - INSET.left))
  expect((await children(skiff)).filter((c) => c.kind === 'frame').map((c) => c.name).sort()).toEqual([tabs.b1, tabs.b2].sort())

  // An earlier space by order comes in from the left.
  await startMoves(skiff)
  await skiff.rpc('spaces.activate', { id: first })
  await expect.poll(showing).toEqual(['/a1', '/a2'])
  log = await takeMoves(skiff)
  expect(xs(log, pages['/a1'])[0]).toBeLessThan(rects.a1.x - width / 2)
  expect(xs(log, pages['/b1'])[0]).toBeGreaterThan(rects.b1.x)

  // Switching back mid-slide turns every window around where it is, at once, with no jump.
  await startMoves(skiff)
  await skiff.rpc('spaces.cycle', { delta: 1 })
  await skiff.shell.waitForTimeout(80)
  const turned = await skiff.app.evaluate(() => performance.now())
  await skiff.rpc('spaces.cycle', { delta: -1 })
  await expect.poll(showing).toEqual(['/a1', '/a2'])
  log = await takeMoves(skiff)
  for (const id of [pages['/a1'], pages['/b1']]) {
    const moves = log.filter((move) => move.id === id)
    const path = moves.map((move) => move.x)
    const turn = path.indexOf(Math.min(...path))
    expect(turn).toBeGreaterThan(0)
    expect(turn).toBeLessThan(path.length - 1)
    expect(falling(path.slice(0, turn + 1))).toBe(true)
    expect(rising(path.slice(turn))).toBe(true)
    expect(moves[turn + 1].t - turned).toBeLessThan(60)
    path.forEach((x, i) => i && expect(Math.abs(x - path[i - 1])).toBeLessThan(width / 4))
  }
  expect(xs(log, pages['/a1']).at(-1)).toBe(rects.a1.x)

  // animate: false switches at once: the new windows are placed once at their rects and the old ones never move.
  await skiff.rpc('ui.setDesk', { animate: false })
  await startMoves(skiff)
  await skiff.rpc('spaces.cycle', { delta: 1 })
  expect(await showing()).toEqual(['/b1', '/b2'])
  log = await takeMoves(skiff)
  expect(new Set(xs(log, pages['/b1']))).toEqual(new Set([rects.b1.x]))
  expect(new Set(xs(log, frameOf[tabs.b1]))).toEqual(new Set([rects.b1.x - INSET.left]))
  expect(xs(log, pages['/a1'])).toEqual([])
  await skiff.rpc('ui.setDesk', { animate: true })

  // Only shown frames hear about state; a frame that shows again gets the state it missed.
  const aFrame = await shellPage(skiff, `/frame.html?tab=${tabs.a1}`)
  const bFrame = await shellPage(skiff, `/frame.html?tab=${tabs.b1}`)
  const heard = await aFrame.evaluate(() => window.states.length)
  const bHeard = await bFrame.evaluate(() => window.states.length)
  await skiff.rpc('spaces.update', { id: second, name: 'Renamed' })
  await expect.poll(() => bFrame.evaluate(() => window.states.length)).toBeGreaterThan(bHeard)
  expect(await aFrame.evaluate(() => window.states.length)).toBe(heard)

  // A switch during a drag ends the drag; the dragged window keeps its saved rect.
  await skiff.rpc('ui.setDesk', { capture: true, preview: { id: tabs.b1, x: 300, y: 300, width: 500, height: 400 } })
  expect((await children(skiff)).find((c) => c.kind === 'page' && c.name === '/b1')).toMatchObject({ x: 300, y: 300 })
  await skiff.rpc('spaces.cycle', { delta: 1 })
  await expect.poll(() => bFrame.evaluate(() => window.events)).toEqual(['drag-cancel'])
  await expect.poll(() => aFrame.evaluate(() => window.states.at(-1))).toBe(first)
  await skiff.rpc('ui.setDesk', { capture: false, animate: false })
  await skiff.rpc('spaces.cycle', { delta: 1 })
  expect((await children(skiff)).find((c) => c.kind === 'page' && c.name === '/b1')).toMatchObject(rects.b1)
})

// A trackpad swipe at 60 Hz as [ms, dx]: the fingers speed up, then macOS momentum decays after they lift; tail cuts the momentum short.
const trackpad = (dir, { at = 0, tail = 22 } = {}) => [2, 6, 13, 22, 30, ...Array.from({ length: tail }, (_, k) => Math.max(1, Math.round(30 * 0.86 ** (k + 1))))].map((v, i) => [at + i * 16, dir * v])
const after = (stream, gap = 16) => stream.at(-1)[0] + gap

test('a two finger swipe on the Buoy switches one space per gesture, through momentum, uneven speed, a new touch and reversals', async ({ skiff }) => {
  await skiff.rpc('spaces.create', { name: 'Second' })
  await skiff.rpc('spaces.create', { name: 'Third' })
  const buoy = await shellPage(skiff, '/buoy.html')
  await expect(buoy.locator('#buoy-name')).not.toBeEmpty()

  // The recogniser alone, on exact timelines.
  const one = trackpad(1)
  const cut = trackpad(1, { tail: 8 })
  const jitter = one.map(([t, x], i) => [t + (i % 2 ? 6 : -6), x])
  const coalesced = [...one.slice(0, 7), ...one.slice(7).flatMap(([t, x], i, all) => (i % 2 ? [[t, x + all[i - 1][1]]] : []))]
  const short = trackpad(1, { tail: 6 })
  const alternating = [1, -1, 1, -1, 1].flatMap((dir, i) => trackpad(dir, { at: i * 300, tail: 13 }))
  const streams = {
    one: [one, [1]],
    'jittery timestamps': [jitter, [1]],
    'coalesced momentum': [coalesced, [1]],
    'uneven speed in one gesture': [[2, 6, 13, 3, 2, 25, 40, 4, 30, 45, 20, 10, 5, 2].map((v, i) => [i * 16, v]), [1]],
    'a new touch that stops the momentum': [[...cut, ...trackpad(1, { at: after(cut, 140) })], [1, 1]],
    'a slow second touch': [[...cut, ...[1, 2, 3, 4, 5, 6, 8, 10, 12].map((v, i) => [after(cut, 140) + i * 16, v])], [1, 1]],
    'the same way with no pause': [[...cut, ...trackpad(1, { at: after(cut) })], [1]],
    'a reversal during momentum': [[...short, ...trackpad(-1, { at: after(short) })], [1, -1]],
    'five alternating swipes in 1.5 s': [alternating, [1, -1, 1, -1, 1]],
    'the same way after a pause': [[...one, ...trackpad(1, { at: after(one, 300) })], [1, 1]],
    'a mostly vertical scroll': [one.map(([t, x]) => [t, x / 4, x]), []],
    'the other way': [trackpad(-1), [-1]]
  }
  const fired = await buoy.evaluate((streams) => Object.fromEntries(Object.entries(streams).map(([name, [events]]) => {
    const swipe = swipeTracker()
    return [name, events.flatMap(([t, x, y = 0]) => swipe.step(t, x, y) || [])]
  })), streams)
  expect(fired).toEqual(Object.fromEntries(Object.entries(streams).map(([name, [, want]]) => [name, want])))

  // Real wheel input on the Buoy, in real time, as the trackpad would send it.
  const pill = await buoy.evaluate(() => { const r = document.getElementById('buoy').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })
  const play = (events, modifiers = []) => skiff.app.evaluate(({ BrowserWindow }, { events, pill, modifiers }) => new Promise((resolve) => {
    const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/buoy.html')).webContents
    const start = performance.now()
    const next = (i) => {
      if (i === events.length) return setTimeout(resolve, 400)
      const [t, x, y = 0] = events[i]
      setTimeout(() => {
        // Chromium reports a wheel delta the other way round from the DOM's deltaX.
        wc.sendInputEvent({ type: 'mouseWheel', ...pill, deltaX: -x, deltaY: -y, modifiers, canScroll: true, hasPreciseScrollingDeltas: true })
        next(i + 1)
      }, Math.max(0, start + t - performance.now()))
    }
    next(0)
  }), { events, pill, modifiers })
  const calls = async () => (await skiff.audit()).spaceCalls.map((call) => call.params.delta)
  const expectSwitches = async (events, want, modifiers) => {
    const before = (await calls()).length
    await play(events, modifiers)
    expect((await calls()).slice(before)).toEqual(want)
  }
  // With another window in front, a swipe brings the desk forward.
  const deskId = await skiff.app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows()
    all.find((w) => w.webContents.getURL().endsWith('/buoy.html')).focus()
    return all.find((w) => w.webContents.getURL().endsWith('/index.html')).id
  })
  const focusedBefore = (await skiff.audit()).focused.length
  await expectSwitches(one, [1])
  expect((await skiff.audit()).focused.slice(focusedBefore)).toContainEqual({ id: deskId })
  await expectSwitches([...cut, ...trackpad(1, { at: after(cut, 140) })], [1, 1])
  await expectSwitches(streams['uneven speed in one gesture'][0], [1])
  await expectSwitches(streams['a reversal during momentum'][0], [1, -1])
  await expectSwitches(alternating, [1, -1, 1, -1, 1])
  await expectSwitches(streams['a mostly vertical scroll'][0], [])
  await expectSwitches(one, [], ['control'])
  expect((await skiff.audit()).spaceCalls.every((call) => call.method === 'spaces.cycle')).toBe(true)
})

test('an ear sits as far left on its top edge as it can and still be seen, past windows, ears and the Buoy in front of it', async ({ skiff }) => {
  const buoy = await shellPage(skiff, '/buoy.html')
  const got = await buoy.evaluate(() => {
    const at = (s) => s && [s.x, s.width, s.room]
    const win = (id, x, y, width, natural) => ({ id, rect: { x, y, width, height: 400 }, natural })
    const layout = (windows, b, w) => Object.fromEntries(Object.entries(earLayout(windows, b ? [b] : [], w)).map(([id, s]) => [id, at(s)]))
    return {
      constants: [EAR_RIM, EAR_GAP, EAR_MIN],
      free: at(earSlot([100, 700], [], 150)),
      // The front window covers the back one's top-left corner, so its ear sits just past the front window and its ear.
      covered: layout([win('back', 100, 100, 600, 150), win('front', 50, 90, 300, 120)], null),
      gap: at(earSlot([0, 1000], [[100, 300], [500, 700]], 150)),
      shrunk: at(earSlot([0, 500], [[0, 100], [200, 300]], 300)),
      hidden: [earSlot([0, 500], [[-50, 600]], 100), earSlot([0, 500], [[0, 470]], 100)],
      // A front window lower down, whose page clears the back ear's row but whose ear does not.
      frontEar: layout([win('back', 100, 100, 600, 150), win('front', 80, 115, 500, 120)], null),
      buoy: layout([win('w', 100, 100, 600, 150)], { x: 90, y: 70, width: 200, height: 30 }),
      narrow: layout([win('w', 100, 100, 100, 150)], null),
      offDesk: layout([win('w', 1300, 100, 600, 150)], null, 1440),
      dragged: layout([win('back', 100, 100, 600, 150), { ...win('front', 50, 90, 300, 120), slot: { x: 250, width: 90, room: 90 } }], null)
    }
  })
  const [RIM, GAP, MIN] = got.constants
  expect(got.free).toEqual([100, 150, 600])
  expect(got.covered.front).toEqual([60, 120, 280])
  expect(got.covered.back).toEqual([50 + 300 + RIM + GAP, 150, 690 - (50 + 300 + RIM + GAP)])
  expect(got.gap).toEqual([300 + GAP, 150, 500 - 300 - 2 * GAP])
  expect(got.shrunk).toEqual([300 + GAP, 500 - 300 - GAP, 500 - 300 - GAP])
  expect(got.hidden).toEqual([null, null])
  expect(500 - 470 - GAP).toBeLessThan(MIN)
  expect(got.frontEar.front).toEqual([90, 120, 480])
  expect(got.frontEar.back).toEqual([90 + 120 + GAP, 150, 690 - 90 - 120 - GAP])
  expect(got.buoy.w).toEqual([90 + 200 + RIM + GAP, 150, 690 - 90 - 200 - RIM - GAP])
  expect(got.narrow.w).toEqual([110, 80, 80])
  expect(got.offDesk.w).toEqual([1310, 130, 130])
  expect(got.dragged).toEqual({ front: [250, 90, 90], back: [50 + 300 + RIM + GAP, 150, 690 - 50 - 300 - RIM - GAP] })
})

// Mouse input to a page view as the pointer would send it: points are page CSS pixels where the view was when the gesture began, so they stay put on the screen while the window moves.
const pointer = (skiff, url, steps) => skiff.app.evaluate(async ({ webContents, BrowserWindow }, { url, steps }) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
  const view = win.contentView.children.find((v) => v.webContents === wc)
  const origin = () => ({ x: win.getContentBounds().x + view.getBounds().x, y: win.getContentBounds().y + view.getBounds().y })
  const start = origin()
  for (const [type, x, y] of steps) {
    if (type === 'keyDown') wc.sendInputEvent({ type, keyCode: x })
    else wc.sendInputEvent({ type, x: start.x + x - origin().x, y: start.y + y - origin().y, globalX: start.x + x, globalY: start.y + y, button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] })
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return start
}, { url, steps })
const press = (from, by, n = 4) => [['mouseDown', ...from], ...Array.from({ length: n }, (_, i) => ['mouseMove', from[0] + by[0] * (i + 1) / n, from[1] + by[1] * (i + 1) / n]), ['mouseUp', from[0] + by[0], from[1] + by[1]]]
// Where things are on the fixture page: an empty stretch of its main block, the body margin, a heading, a link, an input and the page's scrollbar.
const spots = (page) => page.evaluate(() => {
  const r = (selector) => document.querySelector(selector).getBoundingClientRect()
  const mid = (b, dx) => [Math.round(b.left + dx), Math.round(b.top + b.height / 2)]
  return { empty: [Math.round(r('main').left + 400), Math.round(r('main').top + 120)], margin: [12, 12], text: mid(r('h1'), 30), link: mid(r('a'), 10), input: mid(r('input'), 20), scrollbar: [document.documentElement.clientWidth + 5, 200] }
})

test('a press and drag on a desk page\'s empty background never moves its window, and over text it selects', async ({ skiff }) => {
  const id = (await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })).id
  const rect = { x: 300, y: 200, width: 700, height: 500 }
  await skiff.rpc('desk.place', { id, ...rect })
  const page = await skiff.page('/one')
  await page.waitForLoadState()
  const frame = await shellPage(skiff, `/frame.html?tab=${id}`)
  await frame.waitForLoadState()
  await expect(frame.locator('#ear')).toBeVisible()
  const { empty, text } = await spots(page)
  const unmoved = async () => {
    await page.waitForTimeout(300)
    expect((await tabOf(skiff, id)).desk).toMatchObject(rect)
    expect((await views(skiff)).find((v) => v.path === '/one')).toMatchObject(rect)
  }
  await pointer(skiff, page.url(), press(empty, [120, 80], 8))
  await unmoved()
  await pointer(skiff, page.url(), press(text, [80, 0]))
  expect(await page.evaluate(() => getSelection().toString())).toMatch(/\w{3}/)
  await unmoved()
})

test('desk.layouts names the window rects of the desk, desk.tile and the tiling keys put a window there', async ({ skiff }) => {
  const id = (await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })).id
  const mod = process.platform === 'darwin' ? 'Ctrl+Alt' : 'Ctrl+Super'
  await inertShell(skiff, '')
  const { deskSize: { width: W, height: H } } = await skiff.state()
  const layouts = await skiff.rpc('desk.layouts')
  const third = (W - 32) / 3
  const half = (H - 24 - 60) / 2
  const box = (l, t, r, b) => ({ x: Math.round(l), y: Math.round(t), width: Math.round(r) - Math.round(l), height: Math.round(b) - Math.round(t) })
  expect(layouts).toEqual({
    fill: box(8, 38, W - 8, H - 8),
    center: box((W - W * 0.6) / 2, 30 + (H - 30 - H * 0.75) / 2, (W + W * 0.6) / 2, 30 + (H - 30 + H * 0.75) / 2),
    left: box(8, 38, (W - 8) / 2, H - 8),
    right: box((W + 8) / 2, 38, W - 8, H - 8),
    top: box(8, 38, W - 8, 38 + half),
    bottom: box(8, H - 8 - half, W - 8, H - 8),
    'left-third': box(8, 38, 8 + third, H - 8),
    'center-third': box(16 + third, 38, 16 + 2 * third, H - 8),
    'right-third': box(24 + 2 * third, 38, W - 8, H - 8),
    'left-two-thirds': box(8, 38, 16 + 2 * third, H - 8),
    'right-two-thirds': box(16 + third, 38, W - 8, H - 8),
    'top-left': box(8, 38, (W - 8) / 2, 38 + half),
    'top-right': box((W + 8) / 2, 38, W - 8, 38 + half),
    'bottom-left': box(8, H - 8 - half, (W - 8) / 2, H - 8),
    'bottom-right': box((W + 8) / 2, H - 8 - half, W - 8, H - 8)
  })
  const other = (await skiff.rpc('tabs.create', { url: skiff.origin + '/two' })).id
  await skiff.rpc('desk.tile', { id, layout: 'bottom-right' })
  const tab = await tabOf(skiff, id)
  expect(tab.desk).toMatchObject(layouts['bottom-right'])
  expect(tab.desk.z).toBeGreaterThan((await tabOf(skiff, other)).desk.z)
  expect(await skiff.shell.evaluate(() => window.skiff.call('desk.tile', { layout: 'middle' }).catch((e) => e.code))).toBe('bad_params')

  // The keys tile the active window.
  for (const [key, name] of [['Left', 'left'], ['Right', 'right'], ['Up', 'top'], ['Down', 'bottom'], ['Enter', 'fill'], ['C', 'center']]) {
    await skiff.shortcut(`${mod}+${key}`)
    await expect.poll(async () => (await tabOf(skiff, other)).desk).toMatchObject(layouts[name])
  }
  await expect.poll(async () => (await children(skiff)).find((c) => c.kind === 'page' && c.name === '/two')).toMatchObject(layouts.center)
})

test('a new desk window goes where its host was last put, else into the largest free part of the desk', async ({ skiff }) => {
  await inertShell(skiff, '')
  const { deskSize: { width: W, height: H } } = await skiff.state()
  const layouts = await skiff.rpc('desk.layouts')
  // An empty desk: all of it.
  const a = (await skiff.rpc('tabs.create', { url: skiff.origin + '/a' })).id
  expect((await tabOf(skiff, a)).desk).toMatchObject(layouts.fill)
  await skiff.rpc('desk.tile', { id: a, layout: 'left-third' })
  // Another host fills the room right of it, less the margin and its frame's top.
  const l = layouts['left-third']
  const b = (await skiff.rpc('tabs.create', { url: skiff.origin.replace('127.0.0.1', 'localhost') + '/b' })).id
  expect((await tabOf(skiff, b)).desk).toMatchObject({ x: l.x + l.width + 8, y: 38, width: W - l.x - l.width - 16, height: H - 46 })
  // The same host again: its last rect, 28px down and right while a window shows there, cut to the desk.
  const c = (await skiff.rpc('tabs.create', { url: skiff.origin + '/c' })).id
  const stepped = (n) => ({ x: l.x + 28 * n, y: l.y + 28 * n, width: l.width, height: H - l.y - 28 * n })
  expect((await tabOf(skiff, c)).desk).toMatchObject(stepped(1))
  // A link opened in a new tab is placed the same way.
  const page = await skiff.page('/c')
  await page.locator('a[target=_blank]').click()
  await expect.poll(async () => (await skiff.state()).tabs.find((t) => t.url.endsWith('/next/c'))?.desk).toMatchObject(stepped(2))
  await expect.poll(async () => (await children(skiff)).find((ch) => ch.kind === 'page' && ch.name === '/next/c')).toMatchObject(stepped(2))
  // The memory is saved with the state.
  const { deskHosts } = await skiff.state()
  expect(deskHosts).toEqual({ [new URL(skiff.origin).host]: l })
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(skiff.data, 'state.json'), 'utf8')).deskHosts).toEqual(deskHosts)
})

test.describe('stacking when the front window closes', () => {
  const pagesBackToFront = async (skiff) => (await children(skiff)).filter((c) => c.kind === 'page').map((c) => c.name)
  async function setup(skiff, opened) {
    await inertShell(skiff, '')
    const focused = (await skiff.rpc('tabs.create', { url: skiff.origin + '/focused' })).id
    const five = []
    for (const n of [1, 2, 3, 4, 5]) five.push((await skiff.rpc('tabs.create', { url: `${skiff.origin}/bg${n}`, activate: false })).id)
    // A background window never takes a place above the focused one.
    const z = async (id) => (await tabOf(skiff, id)).desk.z
    for (const id of five) expect(await z(id)).toBeLessThan(await z(focused))
    expect((await skiff.state()).activeTabBySpace[(await skiff.state()).activeSpaceId]).toBe(focused)
    const a = (await skiff.rpc('tabs.create', { url: skiff.origin + '/a' })).id
    await expect.poll(async () => (await pagesBackToFront(skiff)).slice(-1)).toEqual(['/a'])
    const b = (await skiff.rpc('tabs.create', { url: skiff.origin + '/b', ...(opened === 'child' && { parentId: a }) })).id
    await expect.poll(async () => (await pagesBackToFront(skiff)).slice(-1)).toEqual(['/b'])
    return { five, a, b, before: (await pagesBackToFront(skiff)).filter((p) => p !== '/b') }
  }
  for (const opened of ['child', 'command bar']) {
    test(`closing B opened as ${opened} from A brings back A and leaves the other windows' order`, async ({ skiff }) => {
      const { a, b, before } = await setup(skiff, opened)
      const stateBefore = (await skiff.state()).tabs.filter((t) => t.id !== b).map((t) => [t.id, t.desk.z])
      await skiff.rpc('tabs.close', { id: b })
      await expect.poll(async () => (await pagesBackToFront(skiff)).includes('/b')).toBe(false)
      expect(await pagesBackToFront(skiff)).toEqual(before)
      expect((await pagesBackToFront(skiff)).at(-1)).toBe('/a')
      expect((await skiff.state()).tabs.filter((t) => t.desk).sort((x, y) => x.desk.z - y.desk.z).map((t) => t.id).at(-1)).toBe(a)
      expect((await skiff.state()).tabs.filter((t) => t.id !== b).map((t) => [t.id, t.desk.z]).sort()).toEqual(stateBefore.sort())
    })
  }
})

test.describe('layer panel and Buoy', () => {
  // The expanded Buoy: the pill grown into the card. Settled open has the class and no morph left; settled home is the pill at its place.
  const isOpen = (buoy) => buoy.locator('#buoy').evaluate((el) => el.classList.contains('open') && !el.classList.contains('morphing'))
  const isHome = (buoy) => buoy.evaluate(() => {
    const el = document.getElementById('buoy')
    const r = el.getBoundingClientRect()
    const p = buoyRect(state, place)
    return !el.classList.contains('open') && !el.classList.contains('morphing') && Math.abs(r.x - p.x) < 1 && Math.abs(r.y - p.y) < 1 && Math.abs(r.width - p.width) < 1 && Math.abs(r.height - p.height) < 1
  })
  const cardRect = (buoy) => buoy.evaluate(() => { const r = document.getElementById('buoy').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
  const buoyHit = async (skiff) => (await skiff.audit()).calls.filter((c) => c.method === 'ui.showOverlay' && c.params.name === 'buoy').at(-1).params.hit
  // Real wheel input to one shell view in real time: events [ms, dx, dy?] at a point in its CSS pixels.
  const wheel = (skiff, url, at, events, modifiers = []) => skiff.app.evaluate(({ webContents }, { url, at, events, modifiers }) => new Promise((resolve) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
    const start = performance.now()
    const next = (i) => {
      if (i === events.length) return setTimeout(resolve, 400)
      const [t, x, y = 0] = events[i]
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.sendInputEvent({ type: 'mouseWheel', ...at, deltaX: -x, deltaY: -y, modifiers, canScroll: true, hasPreciseScrollingDeltas: true })
        next(i + 1)
      }, Math.max(0, start + t - performance.now()))
    }
    next(0)
  }), { url, at, events, modifiers })
  const switches = async (skiff, play) => {
    const before = (await skiff.audit()).spaceCalls.length
    await play()
    return (await skiff.audit()).spaceCalls.slice(before).map((call) => [call.method, call.params.delta])
  }
  const centre = (page, selector) => page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })

  test('the Buoy opens into the command bar in the middle of the desk, with the keyboard, and a pick, Escape, a second press, a press outside or the keyboard leaving close it back into the pill', async ({ skiff }) => {
    await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
    const two = (await skiff.rpc('tabs.create', { url: skiff.origin + '/two' })).id
    const one = (await skiff.state()).tabs.find((t) => t.url.endsWith('/one')).id
    const buoy = await shellPage(skiff, '/buoy.html')
    await expect(buoy.locator('#buoy-name')).not.toBeEmpty()
    await expect.poll(() => isHome(buoy)).toBe(true)
    // The pill alone shows; the card is there, laid out, and hidden.
    await expect(buoy.locator('#card')).toBeHidden()
    await expect(buoy.locator('#buoy-main')).toHaveAttribute('aria-expanded', 'false')
    const pageTwo = await skiff.page('/two')
    const closed = () => expect.poll(() => isHome(buoy)).toBe(true)
    const opened = () => expect.poll(() => isOpen(buoy)).toBe(true)

    // The name opens it: the input has the keyboard, the card is centred on the desk and takes the clicks, and below the input is the panel's content.
    await buoy.locator('#buoy-main').click()
    await opened()
    await expect(buoy.locator('#palette-input')).toBeFocused()
    await expect.poll(() => hasFocus(skiff, buoy)).toBe(true)
    await expect(buoy.locator('#buoy-main')).toHaveAttribute('aria-expanded', 'true')
    const { deskSize } = await skiff.state()
    const card = await cardRect(buoy)
    expect(card.width).toBe(560)
    expect(Math.abs(card.x + card.width / 2 - deskSize.width / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(card.y + card.height / 2 - deskSize.height / 2)).toBeLessThanOrEqual(1)
    expect(await buoyHit(skiff)).toEqual([{ ...card, height: Math.round(card.height) }])
    await expect(buoy.locator(`#list [data-tab-id="${one}"]`)).toBeVisible()
    await expect(buoy.locator('#palette-results')).toBeHidden()
    await expect(buoy.locator('footer #settings-toggle')).toBeVisible()
    // A query shows the bar's rows instead, and clearing it brings the content back.
    await buoy.keyboard.type('zz')
    await expect(buoy.locator('#palette-results li').first()).toBeVisible()
    await expect(buoy.locator('#sidebar')).toBeHidden()
    await buoy.keyboard.press('Backspace')
    await buoy.keyboard.press('Backspace')
    await expect(buoy.locator('#sidebar')).toBeVisible()
    await expect(buoy.locator('#palette-results')).toBeHidden()

    // Escape closes it into the pill's place and gives the keyboard back to the page.
    await buoy.keyboard.press('Escape')
    await closed()
    expect(await buoyHit(skiff)).toEqual([await buoy.evaluate(() => buoyRect(state, place))])
    await expect.poll(() => hasFocus(skiff, pageTwo)).toBe(true)

    // Cmd+T and Cmd+S open it, and the same key again closes it; so does the plus.
    for (const key of ['CmdOrCtrl+T', 'CmdOrCtrl+S']) {
      await skiff.shortcut(key)
      await opened()
      await expect(buoy.locator('#palette-input')).toBeFocused()
      await skiff.shortcut(key)
      await closed()
      await expect.poll(() => hasFocus(skiff, pageTwo)).toBe(true)
    }
    await buoy.locator('#buoy-new').click()
    await opened()
    await expect(buoy.locator('#palette-input')).toBeFocused()
    // A press on the desk outside the card closes it.
    await buoy.mouse.click(5, 5)
    await closed()
    // The keyboard leaving it, as for another app, closes it too, but not a blur that is already over.
    await buoy.locator('#buoy-main').click()
    await opened()
    await buoy.evaluate(() => { dispatchEvent(new Event('blur')); dispatchEvent(new Event('focus')) })
    await buoy.waitForTimeout(250)
    expect(await isOpen(buoy)).toBe(true)
    await buoy.evaluate(() => dispatchEvent(new Event('blur')))
    await closed()
    // A pick closes it too and shows that window with the keyboard.
    await buoy.locator('#buoy-main').click()
    await opened()
    await buoy.locator(`#list [data-tab-id="${one}"] .row-main`).click()
    await closed()
    await expect.poll(async () => (await skiff.state()).activeTabBySpace[(await skiff.state()).activeSpaceId]).toBe(one)
    const pageOne = await skiff.page('/one')
    await expect.poll(() => hasFocus(skiff, pageOne)).toBe(true)
    expect(two).not.toBe(one)
  })

  test('a real Escape key in the Buoy closes the card and leaves its window, so Cmd+T opens it again', async ({ skiff }) => {
    const buoy = await shellPage(skiff, '/buoy.html')
    await expect(buoy.locator('#buoy-name')).not.toBeEmpty()
    await expect.poll(() => isHome(buoy)).toBe(true)
    await skiff.shortcut('CmdOrCtrl+T')
    await expect.poll(() => isOpen(buoy)).toBe(true)
    await expect(buoy.locator('#palette-input')).toBeFocused()
    // Playwright's keyboard arrives as rawKeyDown, which the main process ignores; a real key is keyDown.
    await skiff.app.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL() === url)
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    }, buoy.url())
    await expect.poll(() => isHome(buoy)).toBe(true)
    expect(buoy.isClosed()).toBe(false)
    await skiff.shortcut('CmdOrCtrl+T')
    await expect.poll(() => isOpen(buoy)).toBe(true)
  })

  test('the command bar has one Ask row and no duplicate command, and the arrows move the highlight one row at a time, scrolling it into view', async ({ skiff }) => {
    await skiff.rpc('settings.set', { ai: { agents: [{ name: 'Fake', command: `'${process.execPath}' '${path.join(__dirname, 'fake-agent.js')}' '${skiff.root}'` }] } })
    await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
    const buoy = await shellPage(skiff, '/buoy.html')
    await expect(buoy.locator('#buoy-name')).not.toBeEmpty()
    await expect.poll(() => isHome(buoy)).toBe(true)
    await buoy.locator('#buoy-main').click()
    await expect(buoy.locator('#palette-input')).toBeFocused()
    const labels = () => buoy.locator('#palette-results .label').allTextContents()
    await buoy.keyboard.type('ask')
    await expect.poll(labels).toContain('Ask Fake')
    await buoy.waitForTimeout(400)
    expect(await labels()).not.toContain('ai.ask')
    // A short list: only some rows show, and the highlight must follow the arrows into and out of view.
    await buoy.keyboard.press('Control+A')
    await buoy.keyboard.type('c')
    await expect.poll(async () => (await labels()).length).toBeGreaterThan(7)
    await buoy.evaluate(() => { document.getElementById('palette-results').style.maxHeight = '150px' })
    const where = () => buoy.evaluate(() => {
      const list = document.getElementById('palette-results').getBoundingClientRect()
      const rows = [...document.querySelectorAll('#palette-results li')]
      const at = rows.findIndex((li) => li.classList.contains('pick'))
      const box = rows[at].getBoundingClientRect()
      return { at, inView: box.top >= list.top - 1 && box.bottom <= list.bottom + 1, count: rows.length }
    })
    const first = await where()
    expect(first.at).toBe(0)
    for (let i = 1; i < first.count; i++) {
      await buoy.keyboard.press('ArrowDown')
      expect(await where(), `ArrowDown to ${i}`).toEqual({ at: i, inView: true, count: first.count })
    }
    for (let i = first.count - 2; i >= 0; i--) {
      await buoy.keyboard.press('ArrowUp')
      expect(await where(), `ArrowUp to ${i}`).toEqual({ at: i, inView: true, count: first.count })
    }
  })

  test('a window created while the card is open is placed clear of it', async ({ skiff }) => {
    const buoy = await shellPage(skiff, '/buoy.html')
    await expect(buoy.locator('#buoy-name')).not.toBeEmpty()
    await expect.poll(() => isHome(buoy)).toBe(true)
    await buoy.locator('#buoy-main').click()
    await expect.poll(() => isOpen(buoy)).toBe(true)
    const card = await buoy.evaluate(() => cardRect())
    await expect.poll(async () => JSON.stringify((await skiff.state()).deskAvoid)).toBe(JSON.stringify(card))
    const touches = (r) => r.x < card.x + card.width && card.x < r.x + r.width && r.y - 30 < card.y + card.height && card.y < r.y + r.height
    for (const name of ['a', 'b']) {
      const id = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/${name}`, activate: name === 'a' })).id
      const desk = (await tabOf(skiff, id)).desk
      expect(touches(desk), `${name} ${JSON.stringify(desk)} under ${JSON.stringify(card)}`).toBe(false)
    }
    // Closed, the card no longer matters.
    await buoy.keyboard.press('Escape')
    await expect.poll(() => isHome(buoy)).toBe(true)
    await expect.poll(async () => (await skiff.state()).deskAvoid).toBeUndefined()
  })

  test('every trigger that opened the panel or the bar opens the card in its own state, or moves an open card there', async ({ skiff }) => {
    await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
    const buoy = await shellPage(skiff, '/buoy.html')
    await expect(buoy.locator('#buoy-name')).not.toBeEmpty()
    const closed = () => expect.poll(() => isHome(buoy)).toBe(true)
    const opened = () => expect.poll(() => isOpen(buoy)).toBe(true)
    const emit = (name, data) => skiff.rpc('ui.emit', { name, data })
    const head = () => buoy.locator('#space-head h1')
    const reset = async () => {
      await buoy.keyboard.press('Escape')
      await closed()
    }

    // Each view of the panel.
    await emit('toggle-settings')
    await opened()
    await expect(buoy.locator('#chips .chip[aria-pressed="true"]')).toHaveText('This space')
    await expect(buoy.locator('#space-head')).toBeHidden()
    await expect(buoy.locator('#panel')).toBeVisible()
    // A second one toggles the view off, not the card.
    await emit('toggle-settings')
    await expect(buoy.locator('#panel')).toBeHidden()
    expect(await isOpen(buoy)).toBe(true)
    await reset()
    await emit('toggle-archive')
    await opened()
    await expect(head()).toHaveText('Archive')
    await reset()
    // The card starts from the tab list again, whatever it showed when it closed.
    await buoy.locator('#buoy-main').click()
    await opened()
    await expect(head()).toHaveText(/\S/)
    await expect(head()).not.toHaveText(/Settings|Archive/)
    await reset()

    // A bar mode opens it, and moves an open card there without closing it.
    await emit('focus-address')
    await opened()
    await expect(buoy.locator('#palette-input')).toBeFocused()
    await expect(buoy.locator('#palette-input')).toHaveValue(skiff.origin + '/one')
    await emit('ask-agent')
    await expect(buoy.locator('#palette-ask')).toBeVisible()
    expect(await isOpen(buoy)).toBe(true)
    await reset()
    await emit('ask-agent')
    await opened()
    await expect(buoy.locator('#palette-ask')).toBeVisible()
    // While the bar is in a mode, a view of the panel clears it, since it shows only with the bar empty.
    await emit('toggle-settings')
    await expect(buoy.locator('#palette-ask')).toBeHidden()
    await expect(buoy.locator('#chips .chip[aria-pressed="true"]')).toHaveText('This space')
    await reset()
    await emit('new-tab')
    await opened()
    await emit('new-tab')
    await closed()
    await emit('toggle-sidebar')
    await opened()
    await emit('toggle-sidebar')
    await closed()

    // The Arc import opens inside the card, as a dialog over the whole desk, and closing it leaves the card.
    await emit('import-arc')
    await opened()
    await expect(buoy.locator('#arc-import')).toBeVisible()
    const { deskSize } = await skiff.state()
    expect(await buoyHit(skiff)).toEqual([{ x: 0, y: 0, width: deskSize.width, height: deskSize.height }])
    await buoy.locator('#arc-cancel').click()
    await expect(buoy.locator('#arc-import')).toBeHidden()
    await expect.poll(async () => (await buoyHit(skiff))[0].width).toBe(560)
    expect(await isOpen(buoy)).toBe(true)
    // Escape in the dialog closes only the dialog.
    await emit('import-arc')
    await expect(buoy.locator('#arc-import')).toBeVisible()
    await buoy.keyboard.press('Escape')
    await expect(buoy.locator('#arc-import')).toBeHidden()
    expect(await isOpen(buoy)).toBe(true)
  })

  test('opening is one motion: the pill itself grows into the card and shrinks back, never with both showing, in a window that never moves, and with reduced motion it fades', async ({ skiff }) => {
    await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
    const buoy = await shellPage(skiff, '/buoy.html')
    await expect(buoy.locator('#buoy-name')).not.toBeEmpty()
    await expect.poll(() => isHome(buoy)).toBe(true)
    const record = () => buoy.evaluate(() => {
      window.__frames = []
      const tick = (t) => {
        const el = document.getElementById('buoy')
        const r = el.getBoundingClientRect()
        const row = getComputedStyle(document.getElementById('buoy-row'))
        const card = getComputedStyle(document.getElementById('card'))
        const dot = document.getElementById('buoy-dot').getBoundingClientRect()
        const style = getComputedStyle(el)
        window.__frames.push({ t, x: r.x, y: r.y, width: r.width, height: r.height, pill: row.visibility === 'visible' ? Number(row.opacity) : 0, card: card.visibility === 'visible' ? Number(card.opacity) : 0, shape: Number(style.opacity), dx: dot.x - r.x, dy: dot.y - r.y, radius: parseFloat(style.borderTopLeftRadius), morphing: el.classList.contains('morphing') })
        window.__tick = requestAnimationFrame(tick)
      }
      window.__tick = requestAnimationFrame(tick)
    })
    const frames = () => buoy.evaluate(() => { cancelAnimationFrame(window.__tick); return window.__frames })
    const shown = (f) => f.pill * f.shape > 0.02 && f.card * f.shape > 0.02
    const pill = await buoy.evaluate(() => buoyRect(state, place))
    const bounds = async () => (await skiff.audit()).calls.filter((c) => c.method === 'ui.showOverlay' && c.params.name === 'buoy').map((c) => JSON.stringify(c.params.bounds))

    await record()
    await skiff.shortcut('CmdOrCtrl+T')
    await expect.poll(() => isOpen(buoy)).toBe(true)
    await buoy.waitForTimeout(150)
    const target = await cardRect(buoy)
    await skiff.shortcut('CmdOrCtrl+T')
    await expect.poll(() => isHome(buoy)).toBe(true)
    await buoy.waitForTimeout(150)
    const run = await frames()

    // Never the pill's content and the card's together, and one shape throughout.
    expect(run.filter(shown)).toEqual([])
    const opening = run.slice(0, run.findIndex((f, i) => i > 0 && f.width === target.width && f.height === target.height) + 1)
    const closing = run.slice(run.indexOf(opening.at(-1)) + 1)
    const moving = (list) => list.filter((f, i, all) => i && (f.x !== all[i - 1].x || f.y !== all[i - 1].y || f.width !== all[i - 1].width || f.height !== all[i - 1].height))
    // From the pill's rect to the card's, steadily, in about a quarter of a second, and no frame in it is further from the end than the one before.
    const grown = moving(opening)
    expect(grown.length).toBeGreaterThan(6)
    expect(grown.at(-1).t - grown[0].t).toBeGreaterThan(150)
    expect(grown.at(-1).t - grown[0].t).toBeLessThan(450)
    const gap = (list) => Math.max(...list.slice(1).map((f, i) => f.t - list[i].t))
    expect(gap(grown)).toBeLessThan(60)
    expect(opening[0]).toMatchObject({ x: expect.closeTo(pill.x, 0), y: expect.closeTo(pill.y, 0), width: expect.closeTo(pill.width, 0), height: 30 })
    const order = (key, up) => grown.every((f, i) => !i || (up ? f[key] >= grown[i - 1][key] - 0.5 : f[key] <= grown[i - 1][key] + 0.5))
    expect(order('width', true) && order('height', true)).toBe(true)
    expect(order('x', true) === (target.x >= pill.x) || order('x', false)).toBe(true)
    expect(order('y', false) || order('y', true)).toBe(true)
    // The radius goes from the pill's to the card's, and the dot stays inside the shape from the first frame to the last.
    expect(opening[0].radius).toBeCloseTo(15, 0)
    expect(opening.at(-1).radius).toBeCloseTo(18, 0)
    expect(run.filter((f) => f.pill * f.shape > 0.02 || f.card * f.shape > 0.02).every((f) => f.dx >= 0 && f.dy >= 0 && f.dx <= f.width && f.dy <= f.height)).toBe(true)
    // The card takes over once the shape is most of the way there, and the pill's content is gone before.
    const cardFrom = opening.find((f) => f.card * f.shape > 0.02)
    expect(cardFrom.width).toBeGreaterThan(pill.width + (target.width - pill.width) * 0.6)
    expect(opening.find((f) => f.pill * f.shape === 0).t).toBeLessThanOrEqual(cardFrom.t)
    // Closing runs it back to where it came from.
    const shrunk = moving(closing)
    expect(shrunk.length).toBeGreaterThan(6)
    expect(closing.at(-1)).toMatchObject({ x: expect.closeTo(pill.x, 0), y: expect.closeTo(pill.y, 0), width: expect.closeTo(pill.width, 0), height: 30 })
    expect(shrunk.every((f, i) => !i || f.width <= shrunk[i - 1].width + 0.5)).toBe(true)
    // The window never moved or changed size.
    expect(new Set(await bounds()).size).toBe(1)

    // With reduced motion there is no travel: it fades in at the card's place and out again.
    await buoy.emulateMedia({ reducedMotion: 'reduce' })
    await record()
    await skiff.shortcut('CmdOrCtrl+T')
    await expect.poll(() => isOpen(buoy)).toBe(true)
    await buoy.waitForTimeout(250)
    await skiff.shortcut('CmdOrCtrl+T')
    await expect.poll(() => isHome(buoy)).toBe(true)
    await buoy.waitForTimeout(250)
    const reduced = await frames()
    expect(reduced.some((f) => f.morphing)).toBe(false)
    expect(reduced.filter(shown)).toEqual([])
    expect(reduced.some((f) => f.shape < 1 && f.shape > 0)).toBe(true)
    const places = new Set(reduced.filter((f) => f.shape > 0.02).map((f) => `${f.x},${f.y},${f.width}`))
    expect(places.size).toBeLessThanOrEqual(2)
    expect(new Set(await bounds()).size).toBe(1)
  })

  test('the Buoy shows the space\'s favorites: a click brings that window forward, a drag from one moves the Buoy, and too many end in +N', async ({ skiff }) => {
    const first = (await skiff.state()).activeSpaceId
    const favorite = async (path) => {
      const id = (await skiff.rpc('tabs.create', { url: skiff.origin + path })).id
      await skiff.rpc('tabs.setFavorite', { id, favorite: true })
      return id
    }
    const plain = (await skiff.rpc('tabs.create', { url: skiff.origin + '/plain' })).id
    const favs = [await favorite('/fa'), await favorite('/fb'), await favorite('/fc')]
    const second = (await skiff.rpc('spaces.create', { name: 'Second' })).id
    await skiff.rpc('spaces.activate', { id: second })
    const other = await favorite('/fd')
    await skiff.rpc('spaces.activate', { id: first })
    await skiff.rpc('tabs.activate', { id: plain })
    const buoy = await shellPage(skiff, '/buoy.html')
    const shownIds = () => buoy.locator('.buoy-fav[data-tab-id]').evaluateAll((els) => els.map((el) => el.dataset.tabId))
    const order = async (spaceId) => (await skiff.state()).tabs.filter((t) => t.favorite && t.spaceId === spaceId).map((t) => t.id)
    await expect.poll(shownIds).toEqual(await order(first))
    expect(await order(first)).toEqual(favs)
    // Each a favicon (the page's icon, or its letter), titled, between the space and the buttons.
    await expect(buoy.locator('.buoy-fav .favicon')).toHaveCount(3)
    await expect(buoy.locator('.buoy-fav').first()).toHaveAttribute('title', /\S/)
    const xs = await buoy.evaluate(() => ['#buoy-main', '#buoy-favs', '#buoy-tabs'].map((s) => document.querySelector(s).getBoundingClientRect().x))
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
    await expect(buoy.locator('.buoy-fav.current')).toHaveCount(0)
    // They follow the space.
    await skiff.rpc('spaces.activate', { id: second })
    await expect.poll(shownIds).toEqual([other])
    await skiff.rpc('spaces.activate', { id: first })
    await expect.poll(shownIds).toEqual(favs)

    // The Buoy window is as big as the desk, and takes clicks on the wider pill.
    const fits = async () => {
      const pill = await buoy.evaluate(() => { const r = document.getElementById('buoy').getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, width: r.width, height: r.height, vw: innerWidth } })
      const win = (await floats(skiff)).find((f) => f.file === 'buoy.html').bounds
      const [hit] = await buoyHit(skiff)
      return pill.right <= pill.vw && win.width >= pill.width && hit.width === Math.round(pill.width) && hit.x === pill.x && hit.y === pill.y
    }
    await expect.poll(fits).toBe(true)

    // A click activates that tab, ringed in the space colour, and does not open the card.
    await buoy.locator(`.buoy-fav[data-tab-id="${favs[1]}"]`).click()
    await expect.poll(async () => (await skiff.state()).activeTabBySpace[first]).toBe(favs[1])
    await expect(buoy.locator('.buoy-fav.current')).toHaveAttribute('data-tab-id', favs[1])
    const st = await skiff.state()
    const accent = st.spaces.find((s) => s.id === first).color
    const ring = await buoy.locator('.buoy-fav.current').evaluate((el) => getComputedStyle(el).boxShadow)
    const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16))
    expect(ring).toContain(`rgb(${rgb.join(', ')})`)
    await buoy.waitForTimeout(300)
    await expect(buoy.locator('#buoy-main')).toHaveAttribute('aria-expanded', 'false')

    // A drag that starts on a favicon moves the Buoy and picks nothing.
    const from = await centre(buoy, `.buoy-fav[data-tab-id="${favs[2]}"]`)
    const where = () => buoy.evaluate(() => buoyRect(state, place))
    const before = await where()
    await skiff.app.evaluate(async ({ BrowserWindow }, { from, by }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/buoy.html'))
      const o = win.getContentBounds()
      const start = { x: o.x + from.x, y: o.y + from.y }
      const send = (type, dx, dy) => {
        const b = win.getContentBounds()
        win.webContents.sendInputEvent({ type, x: start.x + dx - b.x, y: start.y + dy - b.y, globalX: start.x + dx, globalY: start.y + dy, button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] })
      }
      const wait = () => new Promise((resolve) => setTimeout(resolve, 40))
      send('mouseDown', 0, 0)
      await wait()
      for (let i = 1; i <= 8; i++) { send('mouseMove', by.x * i / 8, by.y * i / 8); await wait() }
      send('mouseUp', by.x, by.y)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }, { from, by: { x: 300, y: -300 } })
    await expect.poll(async () => { const b = await where(); return [b.x - before.x, b.y - before.y] }).toEqual([300, -300])
    await buoy.waitForTimeout(200)
    expect((await skiff.state()).activeTabBySpace[first]).toBe(favs[1])
    expect(await isOpen(buoy)).toBe(false)

    // Too many for 60% of the desk: as many as fit, then +N, which opens the card.
    const more = []
    for (let i = 0; i < 37; i++) more.push(await favorite(`/many${i}`))
    await skiff.rpc('tabs.activate', { id: favs[1] })
    const all = [...favs, ...more]
    await expect(buoy.locator('#buoy-more')).toBeVisible()
    const { deskSize } = await skiff.state()
    const counted = async () => {
      const ids = await shownIds()
      const n = Number((await buoy.locator('#buoy-more').textContent()).slice(1))
      const width = await buoy.locator('#buoy').evaluate((el) => el.getBoundingClientRect().width)
      return { ids, n, width }
    }
    await expect.poll(async () => { const c = await counted(); return c.ids.length + c.n }).toBe(all.length)
    const c = await counted()
    expect(c.ids).toEqual(all.slice(0, c.ids.length))
    expect(c.ids.length).toBeGreaterThan(10)
    expect(c.width).toBeLessThanOrEqual(deskSize.width * 0.6)
    await expect.poll(fits).toBe(true)
    await buoy.locator('#buoy-more').click()
    await expect.poll(() => isOpen(buoy)).toBe(true)
    await expect(buoy.locator('#sidebar')).toBeVisible()
  })

  test('a two finger swipe anywhere on the card or on an ear switches one space per gesture; vertical scrolling scrolls the list', async ({ skiff }) => {
    const first = (await skiff.state()).activeSpaceId
    const one = (await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })).id
    // Enough pinned rows that the list scrolls.
    for (let i = 0; i < 25; i++) {
      const id = (await skiff.rpc('tabs.create', { url: skiff.origin + `/row${i}` })).id
      await skiff.rpc('tabs.setPinned', { id, pinned: true })
    }
    await skiff.rpc('tabs.activate', { id: one })
    await skiff.rpc('spaces.create', { name: 'Second' })
    await skiff.rpc('spaces.create', { name: 'Third' })
    await skiff.rpc('spaces.activate', { id: first })
    const panel = await shellPage(skiff, '/buoy.html')
    await panel.locator('#buoy-main').click()
    await expect.poll(() => isOpen(panel)).toBe(true)
    await expect(panel.locator('#list .row').nth(20)).toBeAttached()
    const back = () => skiff.rpc('spaces.activate', { id: first })

    // Over the list, the chips and the footer: one switch per stream.
    for (const selector of ['#list .row-main', '#chips', 'footer']) {
      const at = await centre(panel, selector)
      expect(await switches(skiff, () => wheel(skiff, panel.url(), at, trackpad(1))), selector).toEqual([['spaces.cycle', 1]])
      await back()
      expect(await switches(skiff, () => wheel(skiff, panel.url(), at, trackpad(-1, { tail: 30 }))), selector).toEqual([['spaces.cycle', -1]])
      await back()
    }
    // Vertical scrolling over the list scrolls it and switches nothing.
    const at = await centre(panel, '#list .row-main')
    const scrolled = () => panel.locator('#list').evaluate((el) => el.scrollTop)
    expect(await panel.locator('#list').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    const top = await scrolled()
    const down = Array.from({ length: 12 }, (_, i) => [i * 16, 0, 20])
    expect(await switches(skiff, () => wheel(skiff, panel.url(), at, down))).toEqual([])
    expect(await scrolled()).toBeGreaterThan(top)

    // On an ear; a pinch there stays a resize.
    const rect = { x: 500, y: 150, width: 700, height: 450 }
    await skiff.rpc('desk.place', { id: one, ...rect })
    const frame = await shellPage(skiff, `/frame.html?tab=${one}`)
    await expect.poll(() => frame.evaluate(() => mine()?.rect)).toEqual(rect)
    const ear = await centre(frame, '#ear-title')
    expect(await switches(skiff, () => wheel(skiff, frame.url(), ear, trackpad(1)))).toEqual([['spaces.cycle', 1]])
    await back()
    await expect.poll(() => frame.evaluate(() => mine()?.rect)).toEqual(rect)
    expect(await switches(skiff, () => wheel(skiff, frame.url(), ear, trackpad(-1)))).toEqual([['spaces.cycle', -1]])
    await back()
    await expect.poll(() => frame.evaluate(() => mine()?.rect)).toEqual(rect)
    expect(await switches(skiff, () => wheel(skiff, frame.url(), ear, Array.from({ length: 6 }, (_, i) => [i * 16, 0, -5]), ['control']))).toEqual([])
    await expect.poll(async () => (await tabOf(skiff, one)).desk.width).toBeGreaterThan(rect.width)
    // Off the ear (the frame's side band), a swipe does nothing.
    const side = { x: 4, y: 200 }
    expect(await switches(skiff, () => wheel(skiff, frame.url(), side, trackpad(1)))).toEqual([])
  })

  test('the Buoy counts the space\'s tabs by the plus; the count lists them without bringing anything forward, and a pick from behind another app shows only that window', async ({ skiff }) => {
    const first = (await skiff.state()).activeSpaceId
    const one = (await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })).id
    const two = (await skiff.rpc('tabs.create', { url: skiff.origin + '/two' })).id
    const three = (await skiff.rpc('tabs.create', { url: skiff.origin + '/three' })).id
    const fav = (await skiff.rpc('tabs.create', { url: skiff.origin + '/fa' })).id
    await skiff.rpc('tabs.setFavorite', { id: fav, favorite: true })
    await skiff.rpc('desk.hide', { id: fav })
    const second = (await skiff.rpc('spaces.create', { name: 'Second' })).id
    await skiff.rpc('spaces.activate', { id: first })
    await skiff.rpc('tabs.activate', { id: one })
    const buoy = await shellPage(skiff, '/buoy.html')
    await skiff.rpc('desk.hide', { id: three })
    const { deskSize } = await skiff.state()
    const empty = { x: deskSize.width - 20, y: 40 }
    await cursor(skiff, empty)
    const deskId = (await windowInfo(skiff)).id
    const deskOnly = async () => (await skiff.state()).deskOnly
    const pagesShown = async () => (await views(skiff)).map((v) => v.path).sort()
    const framesShown = async () => (await children(skiff)).filter((c) => c.kind === 'frame').map((c) => c.name).sort()
    const listFloat = async () => (await floats(skiff)).find((f) => f.file === 'tablist.html')
    // Each opening is a new window, so the page of the last one, not one that is closing.
    const listPage = async () => {
      await expect.poll(async () => Boolean(await listFloat())).toBe(true)
      const open = () => skiff.app.context().pages().filter((p) => p.url().endsWith('/tablist.html') && !p.isClosed())
      await expect.poll(() => open().length).toBe(1)
      const page = open()[0]
      await expect(page.locator('#tablist .row')).toHaveCount(4)
      return page
    }
    const listClosed = () => expect.poll(async () => Boolean(await listFloat())).toBe(false)
    const away = async () => {
      await skiff.app.evaluate(({ BrowserWindow }) => {
        global.__away?.destroy()
        global.__away = new BrowserWindow({ x: 1200, y: 600, width: 200, height: 200 })
        global.__away.focus()
      })
      await expect.poll(async () => (await skiff.rpc('ui.inFront')).front).toBe(false)
    }
    const home = () => skiff.app.evaluate(() => { global.__away?.destroy(); global.__away = null })

    // The count: the space's ordinary tabs, the hidden one too, labelled, between the favorites and the plus; no eye and no window count.
    const count = buoy.locator('#buoy-tabs')
    await expect(count).toHaveText('3')
    await expect(count).toHaveAttribute('aria-label', '3 tabs')
    await expect(count).toHaveAttribute('title', /3 tabs/)
    await expect(buoy.locator('#buoy-look')).toHaveCount(0)
    await expect(buoy.locator('#buoy-main')).not.toContainText('window')
    const xs = await buoy.evaluate(() => ['#buoy-main', '#buoy-favs', '#buoy-tabs', '#buoy-new'].map((s) => document.querySelector(s).getBoundingClientRect().x))
    xs.forEach((x, i) => i && expect(x).toBeGreaterThan(xs[i - 1]))

    // A click opens the list in a floating window of its own, without ui.raise, focus or any change to the desk.
    expect(await skiff.rpc('ui.inFront')).toEqual({ front: true })
    const before = await skiff.audit()
    const layout = await children(skiff)
    const tabsBefore = JSON.stringify((await skiff.state()).tabs.map((t) => [t.id, t.desk]))
    await count.click()
    let list = await listPage()
    await expectFloating(skiff, (await listFloat()).id)
    await expect(count).toHaveAttribute('aria-expanded', 'true')
    const calls = (await skiff.audit()).calls.slice(before.calls.length)
    expect(calls.filter((c) => c.method !== 'ui.showOverlay' && c.method !== 'ui.inFront')).toEqual([])
    expect(calls.filter((c) => c.method === 'ui.showOverlay').every((c) => c.params.focus === false)).toBe(true)
    expect(calls.filter((c) => c.method === 'ui.showOverlay' && c.params.name === 'tabs').every((c) => c.params.float === true)).toBe(true)
    expect((await skiff.audit()).focused.slice(before.focused.length)).toEqual([])
    expect(await children(skiff)).toEqual(layout)
    expect(JSON.stringify((await skiff.state()).tabs.map((t) => [t.id, t.desk]))).toBe(tabsBefore)
    expect(await isFocused(skiff, deskId)).toBe(true)
    // Rows as the card's, the loaded favorite first: favicon and title, the active one marked, the hidden ones dimmed.
    expect(await list.locator('#tablist .row').evaluateAll((rows) => rows.map((r) => r.dataset.tabId))).toEqual([fav, one, two, three])
    await expect(list.locator('#tablist .row .favicon')).toHaveCount(4)
    await expect(list.locator('#tablist .row.current')).toHaveAttribute('data-tab-id', one)
    expect(await list.locator('#tablist .row.hidden-win').evaluateAll((rows) => rows.map((r) => r.dataset.tabId))).toEqual([fav, three])
    // Above the Buoy in the lower half of the desk, and only its card takes clicks.
    await list.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
    const card = await list.evaluate(() => { const r = document.getElementById('tablist').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    const pill = await buoy.evaluate(() => buoyRect(state, place))
    const at = (await listFloat()).bounds
    const content = (await windowInfo(skiff)).content
    expect(at.y - content.y + card.y + card.height).toBeLessThanOrEqual(pill.y)
    const hit = (await skiff.audit()).calls.filter((c) => c.method === 'ui.showOverlay' && c.params.name === 'tabs').at(-1).params.hit
    expect(hit).toEqual([{ x: card.x, y: card.y, width: card.width, height: card.height }])

    // The count again closes it, Escape in it closes it, and so does any other press on the Buoy.
    await count.click()
    await listClosed()
    await expect(count).toHaveAttribute('aria-expanded', 'false')
    await count.click()
    list = await listPage()
    // The key down closes the window, so the key up finds no page.
    await list.keyboard.press('Escape').catch(() => {})
    await listClosed()

    // A two finger swipe over it switches spaces, as on the card.
    await count.click()
    list = await listPage()
    const centre = await list.locator('#tablist').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 20) } })
    expect(await switches(skiff, () => wheel(skiff, list.url(), centre, trackpad(1)))).toEqual([['spaces.cycle', 1]])
    await skiff.rpc('spaces.activate', { id: first })
    await count.click()
    await listClosed()

    // With Skiff in front a pick only brings that window forward; the whole desk stays.
    await count.click()
    list = await listPage()
    await list.locator(`[data-tab-id="${two}"] .row-main`).click()
    await listClosed()
    await expect.poll(async () => (await skiff.state()).activeTabBySpace[first]).toBe(two)
    expect(await deskOnly()).toBeNull()
    expect(await pagesShown()).toEqual(['/one', '/two'])

    // With another app in front a pick shows only that window, hidden or not, and raises the desk with it alone.
    await away()
    const raised = (await skiff.audit()).calls.length
    await count.click()
    list = await listPage()
    await list.locator(`[data-tab-id="${three}"] .row-main`).click()
    await listClosed()
    await expect.poll(deskOnly).toEqual([three])
    await expect.poll(pagesShown).toEqual(['/three'])
    expect(await framesShown()).toEqual([three])
    expect((await skiff.state()).activeTabBySpace[first]).toBe(three)
    expect((await tabOf(skiff, three)).desk?.hidden).toBeFalsy()
    await expect.poll(async () => (await skiff.audit()).calls.slice(raised).map((c) => c.method)).toContain('ui.raise')
    await expect.poll(() => isFocused(skiff, deskId)).toBe(true)
    await home()
    // The ears follow: the frames see only the windows shown.
    const frame = await shellPage(skiff, `/frame.html?tab=${three}`)
    await expect.poll(() => frame.evaluate(() => deskWindows(state).map((w) => w.tab.id))).toEqual([three])
    // A second pick, Skiff now in front, adds its window.
    await count.click()
    list = await listPage()
    await list.locator(`[data-tab-id="${one}"] .row-main`).click()
    await expect.poll(deskOnly).toEqual([three, one])
    await expect.poll(pagesShown).toEqual(['/one', '/three'])
    await expect.poll(() => frame.evaluate(() => deskWindows(state).map((w) => w.tab.id).sort())).toEqual([one, three].sort())

    const onlyThree = async () => {
      await away()
      await count.click()
      list = await listPage()
      await list.locator(`[data-tab-id="${three}"] .row-main`).click()
      await expect.poll(deskOnly).toEqual([three])
      await home()
    }
    const everyWindow = async () => {
      await expect.poll(deskOnly).toBeNull()
      await expect.poll(pagesShown).toEqual(expect.arrayContaining(['/one', '/three', '/two']))
    }
    // The whole desk comes back from a click on the Buoy's name (which opens the card),
    await buoy.locator('#buoy-main').click()
    await everyWindow()
    await expect.poll(() => isOpen(buoy)).toBe(true)
    await buoy.keyboard.press('Escape')
    await expect.poll(() => isHome(buoy)).toBe(true)
    // a space switch,
    await onlyThree()
    await skiff.rpc('spaces.activate', { id: second })
    await expect.poll(deskOnly).toBeNull()
    await skiff.rpc('spaces.activate', { id: first })
    await everyWindow()
    // Skiff brought forward from outside,
    await onlyThree()
    await away()
    // Past the 400ms in which a focus still counts as the pick's own ui.raise.
    await buoy.waitForTimeout(450)
    await skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), deskId)
    await everyWindow()
    await home()
    // a favorite in the Buoy, which also closes an open list,
    await onlyThree()
    await count.click()
    await listPage()
    await buoy.locator(`.buoy-fav[data-tab-id="${fav}"]`).click()
    await listClosed()
    await everyWindow()
    // and a pick in the card.
    await onlyThree()
    await buoy.locator('#buoy-main').click()
    await expect.poll(() => isOpen(buoy)).toBe(true)
    await buoy.locator(`#list [data-tab-id="${two}"] .row-main`).click()
    await everyWindow()
    await expect.poll(() => isHome(buoy)).toBe(true)
    // Exposé, which shows every window, ends it too.
    await onlyThree()
    await skiff.rpc('ui.emit', { name: 'expose', focus: false })
    await expect.poll(deskOnly).toBeNull()
    await expect.poll(async () => (await children(skiff)).some((c) => c.name === 'expose.html')).toBe(true)
  })
})

test.describe('layer frame sizing', () => {
  // Mouse input to a frame view at desk points (window content pixels), wherever the view has moved to by each step.
  const atDesk = (skiff, url, steps) => skiff.app.evaluate(async ({ webContents, BrowserWindow }, { url, steps }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
    const view = win.contentView.children.find((v) => v.webContents === wc)
    for (const [type, x, y] of steps) {
      const content = win.getContentBounds()
      const at = view.getBounds()
      wc.sendInputEvent({ type, x: x - at.x, y: y - at.y, globalX: content.x + x, globalY: content.y + y, button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] })
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }, { url, steps })
  const frameSetup = async (skiff) => {
    const one = (await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })).id
    await skiff.page('/one')
    const inset = manifest('layer').frame
    const frame = await shellPage(skiff, `/frame.html?tab=${one}`)
    const { deskSize } = await skiff.state()
    const layouts = await skiff.rpc('desk.layouts')
    const place = async (rect) => {
      await skiff.rpc('desk.place', { id: one, ...rect })
      await expect.poll(() => frame.evaluate(() => mine()?.rect)).toEqual(rect)
    }
    const rectOfTab = async () => { const { x, y, width, height } = (await tabOf(skiff, one)).desk; return { x, y, width, height } }
    // Press on the ear; `to` moves the held pointer to a desk point in a few steps, `drop` lets go there.
    const grabEar = async () => {
      const rect = await rectOfTab()
      const ear = await frame.locator('#ear').boundingBox()
      let at = { x: rect.x - inset.left + ear.x + 12, y: rect.y - inset.top + ear.y + ear.height / 2 }
      await atDesk(skiff, frame.url(), [['mouseDown', at.x, at.y]])
      const to = async (p, n = 6) => {
        const from = at
        at = p
        await atDesk(skiff, frame.url(), Array.from({ length: n }, (_, i) => ['mouseMove', from.x + (p.x - from.x) * (i + 1) / n, from.y + (p.y - from.y) * (i + 1) / n]))
      }
      const drop = () => atDesk(skiff, frame.url(), [['mouseUp', at.x, at.y]])
      return { to, drop, start: at }
    }
    const zone = () => skiff.shell.evaluate(() => {
      const z = document.querySelector('#desk .zone')
      return z && { label: z.dataset.label, x: parseFloat(z.style.left), y: parseFloat(z.style.top), width: parseFloat(z.style.width), height: parseFloat(z.style.height) }
    })
    const stripShown = async () => (await children(skiff)).some((c) => c.kind === 'file' && c.name === 'layouts.html')
    return { one, frame, inset, deskSize, layouts, place, rectOfTab, grabEar, zone, stripShown }
  }

  test('a frame lights the edge a press would resize, in the space colour, with the matching cursor', async ({ skiff }) => {
    const { one, frame, inset, place } = await frameSetup(skiff)
    const rect = { x: 300, y: 200, width: 600, height: 400 }
    await place(rect)
    const fw = rect.width + inset.left + inset.right
    const fh = rect.height + inset.top + inset.bottom
    expect(inset).toMatchObject({ top: 30, right: 12, bottom: 12, left: 12 })
    const lit = () => frame.evaluate(() => document.documentElement.dataset.lit || '')
    const cursorAt = (x, y) => frame.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [x, y])
    // Each edge band, and 22px squares at all four corners, the top ones included.
    for (const [x, y, edge, cursor] of [
      [fw / 2, fh - 6, 's', 'ns-resize'], [fw - 6, fh / 2, 'e', 'ew-resize'], [6, fh / 2, 'w', 'ew-resize'], [fw / 2, inset.top - 6, 'n', 'ns-resize'],
      [fw - 6, fh - 6, 'se', 'nwse-resize'], [fw - 20, fh - 6, 'se', 'nwse-resize'], [6, fh - 20, 'sw', 'nesw-resize'],
      [6, inset.top + 8, 'nw', 'nwse-resize'], [20, inset.top - 6, 'nw', 'nwse-resize'], [fw - 6, inset.top - 4, 'ne', 'nesw-resize']
    ]) {
      await frame.mouse.move(x, y)
      await expect.poll(lit, `${edge} at ${x},${y}`).toBe(edge)
      expect(await cursorAt(x, y)).toBe(cursor)
    }
    // The lit edge is 3px of the space colour just outside the page (the active ring is the middle one of them); the other edges stay clear.
    const id = (await frameIds(skiff))[one]
    const pixel = (x, y) => skiff.app.evaluate(async ({ webContents }, [id, x, y]) => {
      const bitmap = (await webContents.fromId(id).capturePage({ x, y, width: 1, height: 1 })).toBitmap()
      return [bitmap[2], bitmap[1], bitmap[0], bitmap[3]]
    }, [id, x, y])
    const st = await skiff.state()
    const space = st.spaces.find((s) => s.id === st.activeSpaceId).color
    const rgb = [1, 3, 5].map((i) => parseInt(space.slice(i, i + 2), 16))
    const lit3 = async (x, y, dx, dy) => (await Promise.all([0, 1, 2].map((i) => pixel(x + dx * i, y + dy * i)))).every((p) => p[3] > 240 && p.slice(0, 3).every((v, i) => Math.abs(v - rgb[i]) <= 6))
    await frame.mouse.move(fw / 2, fh - 6)
    await expect.poll(() => lit3(fw / 2, inset.top + rect.height, 0, 1)).toBe(true)
    expect(await lit3(inset.left - 3, fh / 2, 1, 0)).toBe(false)
    expect((await pixel(inset.left - 3, fh / 2))[3]).toBeLessThan(100)
    // Off the bands nothing is lit.
    await frame.mouse.move(fw / 2, fh / 2)
    await expect.poll(lit).toBe('')
  })

  test('dragging the ear to the bottom edge tiles the bottom half, and the top middle opens the layout strip', async ({ skiff }) => {
    const { frame, deskSize, layouts, place, rectOfTab, grabEar, zone, stripShown } = await frameSetup(skiff)
    const W = deskSize.width
    const H = deskSize.height
    await place({ x: 300, y: 200, width: 600, height: 400 })

    // The bottom edge away from the corners shows the bottom half and drops there.
    let { to, drop } = await grabEar()
    await to({ x: W / 2, y: H / 2 })
    await to({ x: W / 2, y: H - 4 })
    await expect.poll(zone).toEqual({ label: 'Bottom half', ...layouts.bottom })
    await drop()
    await expect.poll(rectOfTab).toEqual(layouts.bottom)
    await expect.poll(zone).toBe(null)

    // The top edge outside its middle third still fills, and opens no strip.
    ;({ to, drop } = await grabEar())
    await to({ x: W / 2, y: H / 2 })
    await to({ x: W / 6, y: 4 })
    await expect.poll(zone).toEqual({ label: 'Fill', ...layouts.fill })
    expect(await stripShown()).toBe(false)

    // Its middle third opens the strip; each cell previews its layout on the desk and lights in the strip.
    const strip = await frame.evaluate(() => layoutStrip(state))
    const cell = (name) => { const c = strip.cells.find((c) => c.name === name); return { x: c.x + c.width / 2, y: c.y + c.height / 2 } }
    expect(strip.cells.map((c) => c.name).sort()).toEqual(Object.keys(layouts).sort())
    await to({ x: W / 2, y: 4 })
    await expect.poll(stripShown).toBe(true)
    const stripPage = await shellPage(skiff, '/layouts.html')
    await expect(stripPage.locator('.cell')).toHaveCount(15)
    await to(cell('left-third'))
    await expect.poll(zone).toEqual({ label: 'Left third', ...layouts['left-third'] })
    await expect(stripPage.locator('.cell.on')).toHaveAttribute('data-layout', 'left-third')
    await expect(stripPage.locator('#strip-label')).toHaveText('Left third')
    // Leaving the strip without dropping closes it; coming back opens it again.
    await to({ x: W / 2, y: H / 2 })
    await expect.poll(stripShown).toBe(false)
    await expect.poll(zone).toBe(null)
    await to({ x: W / 2, y: 4 })
    await expect.poll(stripShown).toBe(true)
    await to(cell('right-two-thirds'))
    await expect(stripPage.locator('.cell.on')).toHaveAttribute('data-layout', 'right-two-thirds')
    await expect.poll(zone).toEqual({ label: 'Right two thirds', ...layouts['right-two-thirds'] })
    await drop()
    await expect.poll(rectOfTab).toEqual(layouts['right-two-thirds'])
    await expect.poll(stripShown).toBe(false)
  })

  test('a pinch on the ear resizes the window around its centre and commits once it stops', async ({ skiff }) => {
    const { frame, place, rectOfTab } = await frameSetup(skiff)
    const rect = { x: 300, y: 200, width: 600, height: 400 }
    await place(rect)
    const ear = await frame.locator('#ear').boundingBox()
    await frame.mouse.move(ear.x + 12, ear.y + ear.height / 2)
    const centre = (r) => [r.x + r.width / 2, r.y + r.height / 2]
    const pageView = async () => (await children(skiff)).find((c) => c.kind === 'page' && c.name === '/one')
    await frame.keyboard.down('Control')
    for (let i = 0; i < 4; i++) await frame.mouse.wheel(0, -5)
    // Mid-pinch: the whole ring lit and the window previewed larger around the same centre, not yet saved.
    const mid = await frame.evaluate(() => [document.documentElement.dataset.lit, pinch && { ...pinch.rect }])
    expect(mid[0]).toBe('nesw')
    expect(mid[1].width).toBeGreaterThan(rect.width)
    expect(mid[1].height).toBeGreaterThan(rect.height)
    // Then it settles and saves.
    await expect.poll(() => frame.evaluate(() => pinch)).toBe(null)
    await frame.keyboard.up('Control')
    const grown = await rectOfTab()
    expect(grown.width).toBeGreaterThan(rect.width)
    expect(grown.width / grown.height).toBeCloseTo(rect.width / rect.height, 1)
    centre(grown).forEach((v, i) => expect(Math.abs(v - centre(rect)[i])).toBeLessThanOrEqual(1))
    await expect.poll(pageView).toMatchObject(grown)
    expect(await frame.evaluate(() => document.documentElement.dataset.lit || '')).toBe('')
    // Pinching in stops at the minimum size.
    const box = await frame.locator('#ear').boundingBox()
    await frame.mouse.move(box.x + 12, box.y + box.height / 2)
    await frame.keyboard.down('Control')
    for (let i = 0; i < 60; i++) await frame.mouse.wheel(0, 100)
    await frame.keyboard.up('Control')
    await expect.poll(async () => { const r = await rectOfTab(); return [r.width, r.height] }).toEqual([340, 200])
  })
  test('dragging the ear far past the right or bottom desk edge shrinks the window from that side', async ({ skiff }) => {
    const { deskSize: { width: W, height: H }, place, rectOfTab, grabEar } = await frameSetup(skiff)
    const start = { x: 300, y: 200, width: 700, height: 500 }
    const drag = async (dx, dy) => {
      const { to, drop, start: from } = await grabEar()
      await to({ x: from.x + dx, y: from.y + dy }, 4)
      await drop()
    }
    // The right edge: the window keeps its left edge and its right one follows the pointer.
    await place(start)
    await drag(W - 900, 0)
    await expect.poll(rectOfTab).toEqual({ x: W - 600, y: 200, width: 600, height: 500 })
    // The bottom edge.
    await place(start)
    await drag(0, H - 600)
    await expect.poll(rectOfTab).toEqual({ x: 300, y: H - 400, width: 700, height: 400 })
  })

  test('a press on the clear top edge beside the ear goes to the window behind, or to the apps when nothing is', async ({ skiff }) => {
    const { one, frame, inset, place } = await frameSetup(skiff)
    const two = (await skiff.rpc('tabs.create', { url: skiff.origin + '/two' })).id
    const page = await skiff.page('/two')
    await skiff.rpc('desk.place', { id: two, x: 300, y: 100, width: 700, height: 500 })
    const rect = { x: 250, y: 300, width: 900, height: 400 }
    await place(rect)
    await skiff.rpc('tabs.activate', { id: one })
    await expect.poll(() => frame.evaluate(() => JSON.parse(sentHit).length)).toBeGreaterThan(8)
    await page.evaluate(() => {
      window.got = []
      for (const type of ['mousedown', 'mousemove', 'mouseup']) addEventListener(type, (e) => window.got.push([type, e.clientX, e.clientY, e.buttons]))
    })
    const active = async () => { const st = await skiff.state(); return st.activeTabBySpace[st.activeSpaceId] }
    const band = rect.y - inset.top + 8
    const ear = await frame.locator('#ear').boundingBox()
    // Beside the ear, over the page behind, that page gets the press and the drag that follows, and comes forward.
    await atDesk(skiff, frame.url(), [['mouseDown', 650, band], ['mouseMove', 700, band], ['mouseMove', 750, band], ['mouseUp', 750, band]])
    await expect.poll(active).toBe(two)
    const y = band - 100
    expect(await page.evaluate(() => window.got)).toEqual([['mousedown', 350, y, 1], ['mousemove', 400, y, 1], ['mousemove', 450, y, 1], ['mouseup', 450, y, 0]])
    // Beside it over the empty desk, clicks pass to the apps below; on the ear and the resize edge they stay.
    await skiff.rpc('tabs.activate', { id: one })
    const { id: deskId, content } = await windowInfo(skiff)
    const over = async (x, y) => {
      await cursor(skiff, { x: content.x + x, y: content.y + y })
      await expect.poll(() => ignoring(skiff, deskId)).toEqual(expect.objectContaining({ ignore: true }))
    }
    await over(1100, band)
    await cursor(skiff, { x: content.x + rect.x - inset.left + ear.x + 10, y: content.y + band })
    await expect.poll(() => ignoring(skiff, deskId)).toEqual(expect.objectContaining({ ignore: false }))
    await over(1100, band)
    await cursor(skiff, { x: content.x + 1100, y: content.y + rect.y - 6 })
    await expect.poll(() => ignoring(skiff, deskId)).toEqual(expect.objectContaining({ ignore: false }))
  })
})

'use strict'
const { test, expect } = require('./fixtures')

test.use({ fixtureOptions: { componentConsent: 1 } })

const shellPage = async (skiff, suffix) => {
  const at = (page) => page.url().endsWith(suffix)
  await expect.poll(() => skiff.app.context().pages().some(at)).toBe(true)
  const page = skiff.app.context().pages().find(at)
  await page.emulateMedia({ colorScheme: 'light' })
  return page
}
// Page views of the desk window, back to front.
const views = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children
  .filter((view) => view.webContents?.getURL().startsWith('http')).map((view) => ({ path: new URL(view.webContents.getURL()).pathname, ...view.getBounds() })))
const showing = async (skiff) => (await views(skiff)).map((v) => v.path)
const startMoves = (skiff) => skiff.app.evaluate(() => { global.__skiffVisualMoves = [] })
const takeMoves = (skiff) => skiff.app.evaluate(() => { const list = global.__skiffVisualMoves; global.__skiffVisualMoves = null; return list })
const pageId = (skiff, path) => skiff.app.evaluate(({ webContents }, path) => webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('http') && new URL(wc.getURL()).pathname === path).id, path)

// A real click on a page view: the main process sees it as the user's press, as it does for any window on the desk.
const click = (skiff, path) => skiff.app.evaluate(async ({ webContents, BrowserWindow }, path) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http') && new URL(w.getURL()).pathname === path)
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
  const view = win.contentView.children.find((v) => v.webContents === wc)
  const at = { x: 60, y: 60, globalX: win.getContentBounds().x + view.getBounds().x + 60, globalY: win.getContentBounds().y + view.getBounds().y + 60, button: 'left', clickCount: 1 }
  for (const type of ['mouseDown', 'mouseUp']) {
    wc.sendInputEvent({ type, ...at })
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}, path)

const GREEN = 'rgb(47, 158, 91)'
// The colour of a resting ear in a space's colour, light theme.
const tint = (page, color) => page.evaluate((color) => { const el = document.createElement('span'); el.style.background = `color-mix(in srgb, ${color} 20%, #fbfaf7)`; document.body.append(el); const c = getComputedStyle(el).backgroundColor; el.remove(); return c }, color)
const RECTS = { a: { x: 40, y: 80, width: 520, height: 420 }, b: { x: 640, y: 120, width: 520, height: 420 } }

// Home holds /a, Dev holds /b, both placed side by side; Home is the active space.
async function twoSpaces(skiff) {
  const home = (await skiff.state()).activeSpaceId
  const dev = (await skiff.rpc('spaces.create', { name: 'Dev', color: '#2f9e5b' })).id
  const a = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/a`, spaceId: home })).id
  const b = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/b`, spaceId: dev, activate: false })).id
  await skiff.rpc('spaces.activate', { id: home })
  await skiff.rpc('desk.place', { id: a, ...RECTS.a })
  await skiff.rpc('desk.place', { id: b, ...RECTS.b })
  await skiff.rpc('tabs.activate', { id: a })
  return { home, dev, a, b }
}

test('two ordinary spaces share the desk: both attached, a click on the other space\'s window makes its space active and nothing leaves', async ({ skiff }) => {
  const { home, dev, a, b } = await twoSpaces(skiff)
  await expect.poll(() => showing(skiff)).toEqual(['/b', '/a'])
  expect((await skiff.state()).activeSpaceId).toBe(home)

  await startMoves(skiff)
  await click(skiff, '/b')
  await expect.poll(async () => { const s = await skiff.state(); return [s.activeSpaceId, s.activeTabBySpace[dev], s.activeTabBySpace[home]] }).toEqual([dev, b, a])
  expect(await showing(skiff)).toEqual(['/a', '/b'])
  const moves = await takeMoves(skiff)
  for (const path of ['/a', '/b']) {
    const id = await pageId(skiff, path)
    expect(new Set(moves.filter((m) => m.id === id).map((m) => m.x)), `${path} stayed at its x`).toEqual(new Set([RECTS[path.slice(1)].x]))
  }

  await startMoves(skiff)
  await skiff.rpc('spaces.activate', { id: home })
  await expect.poll(async () => (await skiff.state()).activeSpaceId).toBe(home)
  await expect.poll(() => showing(skiff)).toEqual(['/b', '/a'])
  await skiff.rpc('spaces.cycle', { delta: 1 })
  await expect.poll(() => showing(skiff)).toEqual(['/a', '/b'])
  const after = await takeMoves(skiff)
  for (const id of new Set(after.map((m) => m.id))) expect(new Set(after.filter((m) => m.id === id).map((m) => m.x)).size, `view ${id} never moved sideways`).toBe(1)
  const state = await skiff.state()
  expect(state.tabs.filter((t) => t.desk?.hidden)).toEqual([])
})

test('a tab layout arranges the windows of both spaces together', async ({ skiff }) => {
  await twoSpaces(skiff)
  await skiff.rpc('settings.set', { tabLayout: 'split' })
  await expect.poll(async () => (await views(skiff)).length).toBe(2)
  await expect.poll(async () => {
    const [x, y] = await views(skiff)
    return [x.width > 400, y.width > 400, x.x + x.width <= y.x || y.x + y.width <= x.x, x.y === y.y]
  }).toEqual([true, true, true, true])
  await skiff.rpc('settings.set', { tabLayout: 'free' })
  await expect.poll(async () => JSON.stringify((await views(skiff)).map(({ path, x, y, width, height }) => [path, x, y, width, height]).sort())).toBe(JSON.stringify([['/a', ...Object.values(RECTS.a)], ['/b', ...Object.values(RECTS.b)]]))
})

test('exposé lists the windows of both spaces and marks each with its space', async ({ skiff }) => {
  const { dev, a, b } = await twoSpaces(skiff)
  await skiff.rpc('ui.emit', { name: 'expose', focus: false })
  const expose = await shellPage(skiff, '/expose.html')
  await expect(expose.locator('.slot')).toHaveCount(2)
  const ear = (id) => expose.locator(`.slot[data-tab-id="${id}"] .ear`).evaluate((el) => getComputedStyle(el).backgroundColor)
  // The active window's ear is solid in its own space's colour; the other window's is tinted with its own, not the active space's.
  expect(await ear(a)).not.toBe(GREEN)
  expect(await ear(b)).toBe(await tint(expose, '#2f9e5b'))
  await expose.locator(`.slot[data-tab-id="${b}"]`).click()
  await expect.poll(async () => (await skiff.state()).activeSpaceId).toBe(dev)
  await expect.poll(() => showing(skiff)).toEqual(['/a', '/b'])
})

test('each window wears its own space\'s colour, whichever space is active', async ({ skiff }) => {
  const { a, b } = await twoSpaces(skiff)
  const earOf = async (id) => (await shellPage(skiff, `frame.html?tab=${id}`)).locator('#ear').evaluate((el) => getComputedStyle(el).backgroundColor)
  // Home is active, and the Dev window keeps Dev's tint.
  await expect.poll(() => earOf(b)).toBe(await tint(await shellPage(skiff, `frame.html?tab=${b}`), '#2f9e5b'))
  await skiff.rpc('tabs.activate', { id: b })
  await expect.poll(() => earOf(b)).toBe(GREEN)
  await expect.poll(() => earOf(a)).not.toBe(GREEN)
})

test('incognito shows only its own windows, and the ordinary windows of every space return with it leaving', async ({ skiff }) => {
  const { home, a, b } = await twoSpaces(skiff)
  await expect.poll(() => showing(skiff)).toEqual(['/b', '/a'])
  const space = await skiff.rpc('incognito.open')
  const secret = await skiff.rpc('tabs.create', { url: `${skiff.origin}/private`, spaceId: space.id })
  await expect.poll(() => showing(skiff)).toEqual(['/private'])
  await skiff.rpc('spaces.activate', { id: home })
  await expect.poll(() => showing(skiff)).toEqual(['/b', '/a'])
  const state = await skiff.state()
  expect(state.tabs.find((t) => t.id === secret.id)).toBeTruthy()
  expect([a, b].every((id) => state.tabs.find((t) => t.id === id && !t.desk?.hidden))).toBe(true)
})

test('a foreground set can hold windows of both spaces, and a click on one of them keeps the set', async ({ skiff }) => {
  const { home, dev, a, b } = await twoSpaces(skiff)
  const c = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/c`, spaceId: home, activate: false })).id
  await skiff.rpc('desk.place', { id: c, x: 300, y: 500, width: 400, height: 300 })
  await skiff.rpc('tabs.activate', { id: a })
  await expect.poll(() => showing(skiff)).toEqual(['/b', '/c', '/a'])
  await skiff.rpc('ui.setDesk', { only: [a, b] })
  await expect.poll(() => showing(skiff)).toEqual(['/b', '/a'])
  await click(skiff, '/b')
  await expect.poll(async () => (await skiff.state()).activeSpaceId).toBe(dev)
  expect((await skiff.state()).deskOnly).toEqual([a, b])
  expect(await showing(skiff)).toEqual(['/a', '/b'])
  await skiff.rpc('spaces.activate', { id: home })
  await expect.poll(async () => (await skiff.state()).deskOnly).toBeNull()
  await expect.poll(() => showing(skiff)).toEqual(['/c', '/b', '/a'])
})

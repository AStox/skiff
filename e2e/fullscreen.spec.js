'use strict'
const { test, expect } = require('./fixtures')

test.use({ fixtureOptions: { componentConsent: 1 } })

const PLACED = { x: 300, y: 160, width: 600, height: 400 }

const state = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
  const view = win.contentView.children.find((v) => v.webContents?.getURL().includes('fullscreen-fixture'))
  return {
    full: win.isFullScreen(), content: win.getContentBounds(), view: view.getBounds(), children: win.contentView.children.length,
    floats: BrowserWindow.getAllWindows().filter((w) => w !== win && !w.webContents.getURL().includes('fullscreen')).map((w) => w.isVisible())
  }
})
// The keyboard lands where the test says, then a real Escape key from the main process.
const escape = (skiff, where) => skiff.app.evaluate(({ BrowserWindow }, where) => {
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
  const wc = where === 'page' ? win.contentView.children.find((v) => v.webContents?.getURL().includes('fullscreen-fixture')).webContents : win.webContents
  wc.focus()
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
}, where)

async function open(skiff, hash = '') {
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/fullscreen-fixture' + hash })
  const page = await skiff.page('/fullscreen-fixture')
  await skiff.rpc('desk.place', { id: tab.id, ...PLACED })
  await expect.poll(async () => (await state(skiff)).view).toEqual(PLACED)
  return { tab, page }
}

async function enter(skiff, page) {
  const before = await state(skiff)
  await page.click('#enter')
  await expect.poll(() => page.evaluate(() => window.events.at(-1))).toBe('enter')
  const during = await expect.poll(async () => (await state(skiff)).view).toEqual({ x: 0, y: 0, width: before.content.width, height: before.content.height }).then(() => state(skiff))
  return { before, during }
}

test('a page in full screen covers the whole window, bare, and comes back exactly', async ({ skiff }) => {
  const { page } = await open(skiff)
  const before = await state(skiff)
  expect(before.floats.some(Boolean)).toBe(true)
  const { during } = await enter(skiff, page)
  expect(during.full).toBe(true)
  expect(during.children).toBe(1)
  expect(during.floats.some(Boolean)).toBe(false)
  // The page's own exit button, with the video paused.
  expect(await page.evaluate(() => document.getElementById('video').paused)).toBe(true)
  await page.evaluate(() => document.exitFullscreen())
  await expect.poll(() => state(skiff)).toEqual({ ...before, full: false })
})

for (const playing of [false, true]) {
  test(`Escape ends full screen with the video ${playing ? 'playing' : 'paused'}`, async ({ skiff }) => {
    const { page } = await open(skiff)
    const before = await state(skiff)
    if (playing) await page.evaluate(() => document.getElementById('video').play())
    await enter(skiff, page)
    expect(await page.evaluate(() => document.getElementById('video').paused)).toBe(!playing)
    await escape(skiff, 'page')
    await expect.poll(() => state(skiff)).toEqual({ ...before, full: false })
  })
}

test('Escape ends full screen when the keyboard is with the shell', async ({ skiff }) => {
  const { page } = await open(skiff)
  const before = await state(skiff)
  await enter(skiff, page)
  await escape(skiff, 'shell')
  await expect.poll(() => state(skiff)).toEqual({ ...before, full: false })
  await expect.poll(() => page.evaluate(() => window.events.join())).toBe('enter,leave')
})

test('an element inside the page covers the window as well, and bringing another tab forward ends it', async ({ skiff }) => {
  const { page } = await open(skiff, '#stage')
  const before = await state(skiff)
  await enter(skiff, page)
  const other = await skiff.rpc('tabs.create', { url: skiff.origin + '/second' })
  await skiff.rpc('desk.place', { id: other.id, x: 20, y: 20, width: 300, height: 200 })
  await skiff.rpc('tabs.activate', { id: other.id })
  await expect.poll(() => page.evaluate(() => window.events.join())).toBe('enter,leave')
  await expect.poll(async () => (await state(skiff)).full).toBe(false)
  expect((await state(skiff)).view).toEqual(before.view)
})

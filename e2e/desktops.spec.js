'use strict'
const { test, expect } = require('./fixtures')

// Linux has no macOS desktops, so the entry fakes two: ids 3 and 1, Desktop 1 and Desktop 2, the first current.
test.use({ fixtureOptions: { desktops: [3, 1] } })

async function useLayer(skiff) {
  const old = skiff.shell
  const closed = old.waitForEvent('close')
  await old.evaluate(() => { window.skiff.call('ui.setShell', { name: 'layer' }) })
  await closed
  await expect.poll(() => !skiff.shell.isClosed()).toBe(true)
  await skiff.shell.waitForLoadState()
}
const shellPage = async (skiff, suffix) => {
  const at = (page) => page.url().endsWith(suffix) && !page.isClosed()
  await expect.poll(() => skiff.app.context().pages().some(at)).toBe(true)
  const page = skiff.app.context().pages().find(at)
  await page.emulateMedia({ colorScheme: 'light' })
  return page
}
const children = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children.map((view) => {
  if (!view.webContents.getURL()) return ''
  const url = new URL(view.webContents.getURL())
  return url.protocol.startsWith('http') ? url.pathname : url.pathname.split('/').pop()
}))
const exposed = async (skiff) => (await children(skiff)).includes('expose.html')
const pages = async (skiff) => (await children(skiff)).filter((name) => name.startsWith('/')).sort()
const switchTo = async (skiff, id) => {
  await skiff.app.evaluate((_, id) => global.__skiffDesktops.switchTo(id), id)
  await expect.poll(async () => (await skiff.state()).desktops.current).toBe(id)
}
const byPath = async (skiff) => Object.fromEntries((await skiff.state()).tabs.map((t) => [new URL(t.url).pathname, t]))

test('tabs belong to the desktop they open on, the desk shows only that desktop\'s pages, and a tab from another desktop moves here when picked', async ({ skiff }) => {
  await useLayer(skiff)
  expect((await skiff.state()).desktops).toEqual({ current: 3, list: [{ id: 3, number: 1 }, { id: 1, number: 2 }] })
  // The desk window is on every desktop, but not over full-screen apps.
  expect((await skiff.audit()).allWorkspaces.filter((call) => !call.visibleOnFullScreen)).toEqual([{ id: expect.any(Number), visible: true, skipTransformProcessType: true }])
  const one = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one` })).id
  const two = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/two` })).id
  await expect.poll(() => pages(skiff)).toEqual(['/one', '/two'])

  // Desktop 2: nothing of Desktop 1 shows, and a tab opened now belongs to Desktop 2.
  await switchTo(skiff, 1)
  await expect.poll(() => pages(skiff)).toEqual([])
  let state = await skiff.state()
  expect(state.activeTabBySpace[state.activeSpaceId]).toBeUndefined()
  const three = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/three` })).id
  await expect.poll(() => pages(skiff)).toEqual(['/three'])
  state = await skiff.state()
  expect(state.tabs.map((t) => [t.id, t.desktopId])).toEqual([[one, 3], [two, 3], [three, 1]])
  const listed = (await skiff.rpc('tabs.list')).tabs
  expect(listed.map((t) => [t.id, t.desktop])).toEqual([[one, 1], [two, 1], [three, 2]])

  // Back on Desktop 1 the tab left active there shows again, and Ctrl+Tab order stays on this desktop.
  await switchTo(skiff, 3)
  await expect.poll(() => pages(skiff)).toEqual(['/one', '/two'])
  state = await skiff.state()
  expect(state.activeTabBySpace[state.activeSpaceId]).toBe(two)
  expect((await skiff.rpc('tabs.select', { index: -1 })).id).toBe(two)
  expect((await skiff.rpc('tabs.cycle', { delta: 1 })).id).toBe(one)
  expect((await skiff.rpc('tabs.cycle', { delta: 1 })).id).toBe(two)

  // Picking a tab of Desktop 2 by the API brings it here; Skiff never changes desktops.
  await skiff.rpc('tabs.activate', { id: three })
  await expect.poll(() => pages(skiff)).toEqual(['/one', '/three', '/two'])
  expect((await byPath(skiff))['/three'].desktopId).toBe(3)
  expect((await skiff.state()).desktops.current).toBe(3)
})

test('the tab list and exposé show the space\'s tabs of every desktop under their desktop, and picking one from the other desktop moves it here', async ({ skiff }) => {
  await useLayer(skiff)
  const one = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one` })).id
  const two = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/two` })).id
  await switchTo(skiff, 1)
  const three = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/three` })).id
  await switchTo(skiff, 3)
  await expect.poll(() => pages(skiff)).toEqual(['/one', '/two'])

  // The tab list: a heading per desktop in desktop order, this one marked, each tab under its own.
  const buoy = await shellPage(skiff, '/buoy.html')
  await buoy.locator('#buoy-tabs').click()
  await expect.poll(() => skiff.app.context().pages().filter((p) => p.url().endsWith('/tablist.html') && !p.isClosed()).length).toBe(1)
  const list = await shellPage(skiff, '/tablist.html')
  await expect(list.locator('#tablist .desk-head')).toHaveText(['Desktop 1 · this desktop', 'Desktop 2'])
  expect(await list.locator('#tablist-rows > li').evaluateAll((items) => items.map((li) => li.dataset.tabId || li.textContent))).toEqual(['Desktop 1 · this desktop', one, two, 'Desktop 2', three])
  await list.keyboard.press('Escape').catch(() => {})
  await expect.poll(() => skiff.app.context().pages().filter((p) => p.url().endsWith('/tablist.html') && !p.isClosed()).length).toBe(0)

  // Exposé: this desktop's windows as ever, the other desktop's tab in a labelled tray group with no picture.
  await skiff.rpc('ui.emit', { name: 'expose', focus: false })
  await expect.poll(() => exposed(skiff)).toBe(true)
  const expose = await shellPage(skiff, '/expose.html')
  await expect(expose.locator('.slot')).toHaveCount(3)
  await expect(expose.locator('.slot:not(.shelved)')).toHaveCount(2)
  await expect(expose.locator('.tray-group .tray-label')).toHaveText('Desktop 2')
  const other = expose.locator(`.slot[data-tab-id="${three}"]`)
  await expect(other).toHaveClass(/shelved/)
  await expect(other).toHaveAttribute('aria-label', 'Fixture reading, Desktop 2')
  await expect(other.locator('img.shot')).toHaveCount(0)
  await expect(other.locator('.blank')).toHaveText('Fixture reading')
  await expect(expose.locator('html')).toHaveClass(/\bsettled\b/)
  await other.click()
  await expect.poll(() => exposed(skiff)).toBe(false)
  await expect.poll(() => pages(skiff)).toEqual(['/one', '/three', '/two'])
  const state = await skiff.state()
  expect(state.activeTabBySpace[state.activeSpaceId]).toBe(three)
  expect(state.tabs.map((t) => t.desktopId)).toEqual([3, 3, 3])
  expect(state.desktops.current).toBe(3)

  // With every tab here, Desktop 2 has none and its group and heading are gone.
  await skiff.rpc('ui.emit', { name: 'expose', focus: false })
  await expect.poll(() => exposed(skiff)).toBe(true)
  const again = await shellPage(skiff, '/expose.html')
  await expect(again.locator('.slot')).toHaveCount(3)
  await expect(again.locator('.tray-group')).toHaveCount(0)
  await skiff.rpc('ui.emit', { name: 'expose', focus: false })
  await expect.poll(() => exposed(skiff)).toBe(false)
})

test('tabs on a desktop that no longer exists join the current one, and with one desktop nothing is labelled', async ({ skiff }) => {
  await useLayer(skiff)
  await skiff.rpc('tabs.create', { url: `${skiff.origin}/one` })
  await switchTo(skiff, 1)
  await skiff.rpc('tabs.create', { url: `${skiff.origin}/two` })
  await skiff.app.evaluate(() => { global.__skiffDesktops.ids = [1] })
  await skiff.app.evaluate(() => global.__skiffDesktops.switchTo(1))
  await expect.poll(async () => (await skiff.state()).desktops.list.length).toBe(1)
  const state = await skiff.state()
  expect(state.tabs.map((t) => t.desktopId)).toEqual([1, 1])
  await expect.poll(() => pages(skiff)).toEqual(['/one', '/two'])
  const buoy = await shellPage(skiff, '/buoy.html')
  await buoy.locator('#buoy-tabs').click()
  const list = await shellPage(skiff, '/tablist.html')
  await expect(list.locator('#tablist .row')).toHaveCount(2)
  await expect(list.locator('#tablist .desk-head')).toHaveCount(0)
})

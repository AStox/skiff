'use strict'
const { test, expect } = require('./fixtures')

const shellPage = async (skiff, suffix) => {
  await expect.poll(() => skiff.app.context().pages().some((page) => page.url().endsWith(suffix) && !page.isClosed())).toBe(true)
  return skiff.app.context().pages().find((page) => page.url().endsWith(suffix) && !page.isClosed())
}
const floatOpen = (skiff, file) => skiff.app.context().pages().some((page) => page.url().endsWith(file) && !page.isClosed())
const tabsAction = (skiff) => skiff.rpc('ui.emit', { name: 'buoy', data: { action: 'tabs' }, focus: false })
const deskId = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).id)

test('two tabs of one URL at the same place on the desk both show in the tab list, the card, exposé and the pill', async ({ skiff }) => {
  const ids = []
  for (let i = 0; i < 2; i++) {
    ids.push((await skiff.rpc('tabs.create', { url: `${skiff.origin}/one` })).id)
    await skiff.rpc('desk.place', { id: ids[i], x: 100, y: 100, width: 600, height: 400 })
  }
  await expect.poll(async () => (await skiff.state()).tabs.filter((t) => t.title === 'Fixture reading').length).toBe(2)
  const space = (await skiff.state()).activeSpaceId
  const mine = async () => (await skiff.state()).tabs.filter((t) => t.spaceId === space && !t.favorite && !t.pinned).map((t) => t.id)
  expect((await mine()).sort()).toEqual([...ids].sort())

  // Each window's ear is where its title shows; stacked exactly, the back one's stands beside the front one's.
  for (const id of ids) await expect(async () => {
    const frame = await shellPage(skiff, `frame.html?tab=${id}`)
    expect(await frame.evaluate(() => document.documentElement.classList.contains('earless'))).toBe(false)
  }).toPass()

  const buoy = await shellPage(skiff, '/buoy.html')
  for (const id of ids) await expect(buoy.locator(`.buoy-tab[data-tab-id="${id}"]`)).toBeVisible()

  await tabsAction(skiff)
  const list = await shellPage(skiff, '/tablist.html')
  await expect(list.locator('#tablist .row')).toHaveCount(2)
  expect(await list.locator('#tablist .row').evaluateAll((rows) => rows.map((r) => r.dataset.tabId))).toEqual(ids)
  await tabsAction(skiff)
  await expect.poll(() => floatOpen(skiff, '/tablist.html')).toBe(false)

  await buoy.locator('#buoy-main').click()
  await expect(buoy.locator('#buoy.open:not(.morphing)')).toHaveCount(1)
  expect(await buoy.locator('#list .row[data-tab-id]').evaluateAll((rows) => rows.map((r) => r.dataset.tabId))).toEqual(ids)
  await buoy.keyboard.press('Escape')

  await skiff.rpc('ui.emit', { name: 'expose' })
  const expose = await shellPage(skiff, '/expose.html')
  await expect.poll(() => expose.evaluate(() => (typeof shown !== 'undefined' && shown ? shown.cards.map((c) => c.tab.id) : []))).toEqual(expect.arrayContaining(ids))
  expect(await expose.evaluate(() => shown.cards.length)).toBe(2)
  await expect(expose.locator('.card')).toHaveCount(2)
})

test('the tab list closes on a click anywhere outside it', async ({ skiff }) => {
  const one = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one` })).id
  await skiff.rpc('desk.place', { id: one, x: 100, y: 100, width: 600, height: 400 })
  const two = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/two` })).id
  await skiff.rpc('desk.place', { id: two, x: 760, y: 100, width: 500, height: 400 })
  await expect.poll(async () => (await skiff.state()).tabs.filter((t) => t.title === 'Fixture reading').length).toBe(2)
  await skiff.rpc('tabs.activate', { id: one })
  const buoy = await shellPage(skiff, '/buoy.html')
  const open = async () => {
    await tabsAction(skiff)
    await shellPage(skiff, '/tablist.html')
    await expect.poll(() => floatOpen(skiff, '/tablist.html')).toBe(true)
  }
  const closed = () => expect.poll(() => floatOpen(skiff, '/tablist.html')).toBe(false)
  const click = (point) => skiff.app.evaluate(({ BrowserWindow }, point) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }, point)
  const pageClick = (path, point) => skiff.app.evaluate(({ webContents }, { path, point }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith(path))
    wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }, { path, point })
  const { deskSize } = await skiff.state()

  // On the page that is already active: no tab change, so only the click itself can close it.
  await open()
  await pageClick('/one', { x: 100, y: 100 })
  await closed()

  // On a window that is not active.
  await open()
  await pageClick('/two', { x: 100, y: 100 })
  await closed()

  // On the empty desk.
  await open()
  await click({ x: Math.round(deskSize.width / 2), y: deskSize.height - 40 })
  await closed()

  // Another app coming in front.
  await open()
  await skiff.app.evaluate(({ BrowserWindow }) => {
    global.__away = new BrowserWindow({ x: 1200, y: 600, width: 200, height: 200 })
    global.__away.focus()
  })
  await closed()
  await skiff.app.evaluate(() => { global.__away?.destroy(); global.__away = null })
})

test('the open card never scrolls its favorites; the tab list takes what is left and scrolls', async ({ skiff }) => {
  for (let i = 0; i < 70; i++) {
    const id = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one?f=${i}`, activate: false })).id
    await skiff.rpc('tabs.setFavorite', { id, favorite: true })
  }
  for (let i = 0; i < 25; i++) await skiff.rpc('tabs.create', { url: `${skiff.origin}/two?t=${i}`, activate: false })
  const buoy = await shellPage(skiff, '/buoy.html')
  await buoy.locator('#buoy-main').click()
  await expect(buoy.locator('#buoy.open:not(.morphing)')).toHaveCount(1)
  await expect(buoy.locator('#favorites .tile')).toHaveCount(70)
  const m = await buoy.evaluate(() => {
    const f = document.getElementById('favorites')
    const l = document.getElementById('list')
    const card = f.closest('#buoy').getBoundingClientRect()
    return { fs: f.scrollHeight, fc: f.clientHeight, overflow: getComputedStyle(f).overflowY, ls: l.scrollHeight, lc: l.clientHeight, fb: f.getBoundingClientRect().bottom, lt: l.getBoundingClientRect().top, lb: l.getBoundingClientRect().bottom, cb: card.bottom }
  })
  expect(m.fs).toBe(m.fc)
  expect(m.overflow).not.toBe('auto')
  expect(m.lc).toBeGreaterThan(40)
  expect(m.ls).toBeGreaterThan(m.lc)
  expect(m.lb).toBeLessThanOrEqual(m.cb)
})

test('the tab list shows every space\'s open tabs, loaded favorites included, and a pick from another space switches to it', async ({ skiff }) => {
  const first = (await skiff.state()).activeSpaceId
  const plain = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one` })).id
  const second = (await skiff.rpc('spaces.create', { name: 'Dev' })).id
  const fav = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/two`, spaceId: second })).id
  await skiff.rpc('tabs.setFavorite', { id: fav, favorite: true })
  await skiff.rpc('tabs.activate', { id: fav })
  const later = (await skiff.rpc('spaces.create', { name: 'Later' })).id
  const open = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/three`, spaceId: later })).id
  const cold = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/four`, spaceId: later, activate: false })).id
  await skiff.rpc('tabs.setFavorite', { id: cold, favorite: true })
  await skiff.rpc('desk.hide', { id: cold })
  await skiff.rpc('spaces.activate', { id: first })
  // After a restart a favorite hidden from the desk has no page until it is used.
  await skiff.restart()
  const lifecycle = async (id) => (await skiff.state()).tabs.find((t) => t.id === id).lifecycle
  expect(await lifecycle(cold)).toBeUndefined()
  await skiff.rpc('tabs.activate', { id: fav })
  await expect.poll(() => lifecycle(fav)).toBe('live')
  await skiff.rpc('spaces.activate', { id: first })
  expect(await lifecycle(cold)).toBeUndefined()

  const buoy = await shellPage(skiff, '/buoy.html')
  await expect(async () => {
    if (!floatOpen(skiff, '/tablist.html')) await tabsAction(skiff)
    const list = await shellPage(skiff, '/tablist.html')
    await expect(list.locator('#tablist-rows > li')).toHaveCount(6, { timeout: 1500 })
  }).toPass()
  const list = await shellPage(skiff, '/tablist.html')
  const items = () => list.locator('#tablist-rows > li').evaluateAll((lis) => lis.map((li) => li.dataset.tabId || li.textContent))
  const firstName = (await skiff.state()).spaces.find((s) => s.id === first).name
  expect(await items()).toEqual([`${firstName} · this space`, plain, 'Dev', fav, 'Later', open])
  await expect(list.locator('#tablist .row.current')).toHaveAttribute('data-tab-id', plain)

  await list.locator(`[data-tab-id="${fav}"] .row-main`).click()
  await expect.poll(async () => { const s = await skiff.state(); return [s.activeSpaceId, s.activeTabBySpace[second]] }).toEqual([second, fav])
  // With another app in front only that tab's window comes over it.
  await skiff.rpc('spaces.activate', { id: first })
  await skiff.app.evaluate(({ BrowserWindow }) => {
    global.__away = new BrowserWindow({ x: 1200, y: 600, width: 200, height: 200 })
    global.__away.focus()
  })
  await expect.poll(async () => (await skiff.rpc('ui.inFront')).front).toBe(false)
  await tabsAction(skiff)
  const again = await shellPage(skiff, '/tablist.html')
  await again.locator(`[data-tab-id="${fav}"] .row-main`).click()
  await expect.poll(async () => { const s = await skiff.state(); return [s.activeSpaceId, s.activeTabBySpace[second], s.deskOnly] }).toEqual([second, fav, [fav]])
  await expect.poll(async () => (await skiff.rpc('ui.inFront')).front).toBe(true)
  await skiff.app.evaluate(() => { global.__away?.destroy(); global.__away = null })
})

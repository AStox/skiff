'use strict'
const { test, expect } = require('./fixtures')

const shellPage = async (skiff, suffix) => {
  await expect.poll(() => skiff.app.context().pages().some((page) => page.url().endsWith(suffix) && !page.isClosed())).toBe(true)
  return skiff.app.context().pages().find((page) => page.url().endsWith(suffix) && !page.isClosed())
}
const floatOpen = (skiff, file) => skiff.app.context().pages().some((page) => page.url().endsWith(file) && !page.isClosed())

test('the card lists Favorites, then Open Tabs by space with the status sections, then Pinned; another space\'s rows switch to it and close', async ({ skiff }) => {
  const home = (await skiff.state()).activeSpaceId
  const fav = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one?fav` })).id
  await skiff.rpc('tabs.setFavorite', { id: fav, favorite: true })
  const pin = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one?pin` })).id
  await skiff.rpc('tabs.setPinned', { id: pin, pinned: true })
  const done = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one?done` })).id
  await skiff.rpc('tabs.setBucket', { id: done, bucket: 'done' })
  const active = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one?active` })).id

  const dev = (await skiff.rpc('spaces.create', { name: 'Dev' })).id
  const devFav = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/two?fav`, spaceId: dev })).id
  await skiff.rpc('tabs.setFavorite', { id: devFav, favorite: true })
  await skiff.rpc('tabs.activate', { id: devFav })
  const devPin = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/two?pin`, spaceId: dev, activate: false })).id
  await skiff.rpc('tabs.setPinned', { id: devPin, pinned: true })
  const devPlain = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/two?plain`, spaceId: dev, activate: false })).id
  await skiff.rpc('spaces.activate', { id: home })
  await expect.poll(async () => (await skiff.state()).tabs.find((t) => t.id === devFav)?.lifecycle).toBe('live')

  const card = await skiff.card()
  await expect(card.locator('#favorites .tile')).toHaveCount(1)
  // Favorites sit above the list, whose rows run: Open Tabs, this space's status sections, each other space with its loaded favorites and pinned tabs, then Pinned.
  const heads = (id) => `#list > [data-tab-id="${id}"]`
  await expect(card.locator('#list > li[data-tab-id]')).toHaveCount(6)
  const order = () => card.locator('#list > li').evaluateAll((lis) => lis.map((li) => li.dataset.tabId || li.querySelector('.label')?.textContent))
  // Status sections follow their own order, not the order the tabs were made in.
  expect(await order()).toEqual(['Open Tabs', 'Home · this space', 'Active', active, 'Done', done, 'Dev', devFav, devPin, 'Unread', devPlain, 'Pinned', pin, 'New tab'])
  // The open space's rows move; another space's do not.
  await expect(card.locator(heads(active))).toHaveAttribute('draggable', 'true')
  await expect(card.locator(heads(devPlain))).not.toHaveAttribute('draggable', 'true')
  await expect(card.locator('#favorites .tile')).toHaveAttribute('data-tab-id', fav)

  // Closing another space's row closes that tab only.
  await card.locator(heads(devPlain)).hover()
  await card.locator(`${heads(devPlain)} [aria-label="Close tab"]`).click()
  await expect.poll(async () => (await skiff.state()).tabs.some((t) => t.id === devPlain)).toBe(false)
  expect((await skiff.state()).activeSpaceId).toBe(home)
  await expect(card.locator(heads(devPlain))).toHaveCount(0)

  // Picking one switches to its space with that tab active.
  await card.locator(`${heads(devFav)} .row-main`).click()
  await expect.poll(async () => { const s = await skiff.state(); return [s.activeSpaceId, s.activeTabBySpace[dev]] }).toEqual([dev, devFav])
})

test('a tab playing sound shows a speaker in the card, its favorite tile, the Buoy list and the pill, and loses it when the sound stops', async ({ skiff }) => {
  const fav = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/tone-fixture?fav` })).id
  await skiff.rpc('tabs.setFavorite', { id: fav, favorite: true })
  const plain = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/tone-fixture?plain` })).id
  const quiet = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/one` })).id
  const tone = async (query, call) => (await skiff.page(`/tone-fixture?${query}`)).evaluate(call)
  const audible = async (id) => (await skiff.state()).tabs.find((t) => t.id === id).protections?.audible
  expect(await tone('fav', () => window.tone.start())).toBe('running')
  expect(await tone('plain', () => window.tone.start())).toBe('running')
  await expect.poll(() => audible(fav)).toBe(true)
  await expect.poll(() => audible(plain)).toBe(true)
  expect(Boolean(await audible(quiet))).toBe(false)

  const card = await skiff.card()
  const speaker = (box, id) => card.locator(`${box}[data-tab-id="${id}"] .speaker`)
  await expect(speaker('#list li.row', plain)).toHaveCount(1)
  await expect(speaker('#list li.row', quiet)).toHaveCount(0)
  await expect(speaker('#favorites .tile', fav)).toHaveCount(1)
  await expect(speaker('#buoy-favs .buoy-fav', fav)).toHaveCount(1)
  await tone('plain', () => window.tone.stop())
  await expect(speaker('#list li.row', plain)).toHaveCount(0)
  await expect(speaker('#favorites .tile', fav)).toHaveCount(1)
  await card.keyboard.press('Escape')
  await expect.poll(() => skiff.barOpen()).toBe(false)

  // The Buoy's list follows the sound live while it is open.
  await expect(card.locator('#buoy-favs .buoy-fav .speaker')).toHaveCount(1)
  await tone('plain', () => window.tone.start())
  await expect.poll(() => audible(plain)).toBe(true)
  await expect(async () => {
    if (!floatOpen(skiff, '/tablist.html')) await card.locator('#buoy-tabs').click()
    const list = await shellPage(skiff, '/tablist.html')
    await expect(list.locator(`#tablist [data-tab-id="${plain}"] .speaker`)).toHaveCount(1, { timeout: 1500 })
  }).toPass()
  const list = await shellPage(skiff, '/tablist.html')
  await expect(list.locator(`#tablist [data-tab-id="${fav}"] .speaker`)).toHaveCount(1)
  await expect(list.locator(`#tablist [data-tab-id="${quiet}"] .speaker`)).toHaveCount(0)
  await tone('plain', () => window.tone.stop())
  await tone('fav', () => window.tone.stop())
  await expect(list.locator('#tablist .speaker')).toHaveCount(0)
})

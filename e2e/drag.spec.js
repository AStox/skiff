'use strict'
const { test, expect, snapshot, dragStart, dragOver } = require('./fixtures')

async function seed(skiff, names) {
  const space = (await skiff.state()).activeSpaceId
  const ids = {}
  for (const [name, fields] of Object.entries(names)) {
    const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/${name}`, spaceId: fields.spaceId || space, activate: false })
    if (fields.favorite) await skiff.rpc('tabs.setFavorite', { id: tab.id, favorite: true })
    ids[name] = tab.id
  }
  // The startup prefetch saves the fixture origin's icon for every tab, so screenshots are stable.
  await skiff.restart()
  await expect.poll(async () => (await skiff.state()).tabs.every((tab) => tab.favicon)).toBe(true)
  return { space, card: await skiff.card(), ...ids }
}

const helpers = (skiff, card, space) => ({
  row: (id) => card.locator(`#list [data-tab-id="${id}"]`),
  tile: (id) => card.locator(`#favorites [data-tab-id="${id}"]`),
  ghosts: () => card.locator('.ghost'),
  // What the favorites row shows right now: visible items in order, the preview as 'ghost'.
  drawn: () => card.locator('#favorites > *').evaluateAll((items) => items.filter((item) => item.offsetParent).map((item) => item.classList.contains('ghost') ? 'ghost' : item.dataset.tabId || item.dataset.zone)),
  order: async (where) => (await skiff.state()).tabs.filter((tab) => tab.spaceId === space && where(tab)).map((tab) => tab.id),
  bucketOf: async (id) => (await skiff.state()).tabs.find((tab) => tab.id === id).bucket
})
const favorite = (tab) => tab.bucket === 'favorites'
const mask = (card) => ({ mask: [card.locator('#list li.row[data-tab-id] .label'), card.locator('#list li.row[data-tab-id] .when')] })

test('dragging previews the exact favorite slot, holds still, drops there and reorders or unfavorites tiles', async ({ skiff }) => {
  const s = await seed(skiff, { f1: { favorite: true }, f2: { favorite: true }, t1: {}, t2: {} })
  const { card } = s
  const { row, tile, ghosts, drawn, order, bucketOf } = helpers(skiff, card, s.space)

  await dragStart(card, row(s.t1))
  const point = await dragOver(card, tile(s.f2), { x: 6 })
  await expect.poll(drawn).toEqual([s.f1, 'ghost', s.f2])
  await expect(ghosts()).toHaveCount(1)
  expect(await ghosts().textContent()).toBe('')
  await expect(row(s.t1)).toHaveClass(/drag-dim/)
  await expect(card.locator('#space-status')).toHaveText('Drop to move to Favorites, position 2.')
  for (let i = 0; i < 4; i++) {
    await card.mouse.move(point.x, point.y)
    await card.waitForTimeout(30)
  }
  expect(await drawn()).toEqual([s.f1, 'ghost', s.f2])
  await snapshot(card.locator('#sidebar'), 'drag-to-favorites.png', mask(card))
  await card.mouse.up()
  await expect.poll(() => order(favorite)).toEqual([s.f1, s.t1, s.f2])
  await expect(ghosts()).toHaveCount(0)
  await expect.poll(drawn).toEqual([s.f1, s.t1, s.f2])

  // Within its own section the original is hidden, so the tab never shows twice.
  await dragStart(card, tile(s.f1))
  await dragOver(card, tile(s.f2), { x: 40 })
  await expect.poll(drawn).toEqual([s.t1, s.f2, 'ghost'])
  await expect(tile(s.f1)).toBeHidden()
  await card.mouse.up()
  await expect.poll(() => order(favorite)).toEqual([s.t1, s.f2, s.f1])

  await dragStart(card, tile(s.f2))
  await dragOver(card, row(s.t2), { y: 4 })
  await expect(ghosts()).toHaveCount(1)
  await expect(tile(s.f2)).toHaveClass(/drag-dim/)
  await expect(card.locator('#space-status')).toHaveText(/^Drop to move to (Unread|Active), position 1\.$/)
  await card.mouse.up()
  await expect.poll(() => bucketOf(s.f2)).toMatch(/^(unread|active)$/)
  await expect.poll(() => order(favorite)).toEqual([s.t1, s.f1])

  await skiff.restart()
  const reopened = await skiff.card()
  await expect(reopened.locator('#favorites > .tile')).toHaveCount(2)
  expect(await order(favorite)).toEqual([s.t1, s.f1])
})

test('empty sections offer drop areas, Escape cancels a drag and a release in the preview moves the tab', async ({ skiff }) => {
  const s = await seed(skiff, { w1: {}, w2: {}, w3: {} })
  const { card } = s
  const { row, tile, ghosts, drawn, bucketOf } = helpers(skiff, card, s.space)
  const zone = (name) => card.locator(`.drop-zone[data-zone="${name}"]`)

  await expect(zone('favorites')).toHaveCount(0)
  await dragStart(card, row(s.w1))
  await expect(zone('favorites')).toBeVisible()
  await expect(zone('later')).toBeVisible()
  await expect(zone('done')).toBeVisible()
  await dragOver(card, zone('later'))
  await expect(ghosts()).toHaveCount(1)
  await expect(zone('later')).toBeHidden()
  await expect(card.locator('#space-status')).toHaveText('Drop to move to Later, position 1.')
  await card.mouse.up()
  await expect.poll(() => bucketOf(s.w1)).toBe('later')
  await expect(card.locator('.drop-zone')).toHaveCount(0)

  await dragStart(card, row(s.w2))
  await expect(zone('favorites')).toBeVisible()
  await expect(zone('later')).toHaveCount(0)
  await dragOver(card, zone('favorites'))
  await expect.poll(drawn).toEqual(['ghost'])
  await card.mouse.up()
  await expect.poll(() => bucketOf(s.w2)).toBe('favorites')

  const before = (await skiff.state()).tabs
  await dragStart(card, row(s.w3))
  await dragOver(card, tile(s.w2))
  await expect(ghosts()).toHaveCount(1)
  await card.keyboard.press('Escape')
  await expect(ghosts()).toHaveCount(0)
  await expect(card.locator('.drop-zone, .drag-dim, .drag-hide')).toHaveCount(0)
  await card.mouse.up()
  await card.waitForTimeout(200)
  expect((await skiff.state()).tabs).toEqual(before)
})

test('a space button names its target and a dropped tab moves to that space', async ({ skiff }) => {
  const work = await skiff.rpc('spaces.create', { name: 'Work', color: '#2f9e5b' })
  const s = await seed(skiff, { w1: {}, w2: {}, other: { spaceId: work.id } })
  const { card } = s
  const { row, ghosts } = helpers(skiff, card, s.space)
  const dot = card.locator(`#dots [data-space-id="${work.id}"]`)

  await dragStart(card, row(s.w1))
  await dragOver(card, dot)
  await expect(card.locator('#drag-caption')).toHaveText('Move to Work')
  await expect(dot).toHaveClass(/drop-target/)
  await expect(ghosts()).toHaveCount(0)
  await snapshot(card.locator('#sidebar'), 'drag-to-space.png', mask(card))
  await card.mouse.up()
  await expect.poll(async () => (await skiff.state()).tabs.find((tab) => tab.id === s.w1).spaceId).toBe(work.id)
  await expect(card.locator('#drag-caption')).toBeHidden()
})

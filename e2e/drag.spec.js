'use strict'
const { test, expect, snapshot, dragStart, dragOver, dragTo } = require('./fixtures')

async function seed(skiff, names) {
  const space = (await skiff.state()).activeSpaceId
  const ids = {}
  for (const [name, fields] of Object.entries(names)) {
    const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/${name}`, spaceId: fields.spaceId || space, activate: false })
    if (fields.favorite) await skiff.rpc('tabs.setFavorite', { id: tab.id, favorite: true })
    if (fields.pinned) await skiff.rpc('tabs.setPinned', { id: tab.id, pinned: true, folder: fields.folder })
    ids[name] = tab.id
  }
  // The startup prefetch saves the fixture origin's icon for every tab, so screenshots are stable.
  await skiff.restart()
  await expect.poll(async () => (await skiff.state()).tabs.every((tab) => tab.favicon)).toBe(true)
  return { space, ...ids }
}

const helpers = (skiff, space) => ({
  row: (id) => skiff.shell.locator(`#list [data-tab-id="${id}"]`),
  tile: (id) => skiff.shell.locator(`#favorites [data-tab-id="${id}"]`),
  ghosts: () => skiff.shell.locator('.ghost'),
  // What the sidebar shows right now: visible items in order, the preview as 'ghost'.
  drawn: (box) => skiff.shell.locator(`#${box} > *`).evaluateAll((items) => items.filter((item) => item.offsetParent)
    .map((item) => item.classList.contains('ghost') ? 'ghost' : item.dataset.tabId || (item.dataset.folderHead && `folder:${item.dataset.folderHead}`) || item.dataset.zone || (item.hasAttribute('data-new-tab') ? 'new' : 'divider'))),
  order: async (where) => (await skiff.state()).tabs.filter((tab) => tab.spaceId === space && where(tab)).map((tab) => tab.id)
})
const plain = (tab) => !tab.favorite && !tab.pinned
const mask = (skiff) => ({ mask: [skiff.shell.locator('#address'), skiff.shell.locator('#list .label')] })

test('dragging previews the exact favorite slot, holds still, drops there and reorders or unfavorites tiles', async ({ skiff }) => {
  const s = await seed(skiff, { f1: { favorite: true }, f2: { favorite: true }, t1: {}, t2: {} })
  const { row, tile, ghosts, drawn, order } = helpers(skiff, s.space)
  const shell = skiff.shell

  await dragStart(skiff, row(s.t1))
  const point = await dragOver(skiff, tile(s.f2), { x: 6 })
  await expect.poll(() => drawn('favorites')).toEqual([s.f1, 'ghost', s.f2])
  await expect(ghosts()).toHaveCount(1)
  expect(await ghosts().textContent()).toBe('')
  await expect(row(s.t1)).toHaveClass(/drag-dim/)
  await expect(shell.locator('#space-status')).toHaveText('Drop to add to favorites, position 2.')
  for (let i = 0; i < 4; i++) {
    await shell.mouse.move(point.x, point.y)
    await shell.waitForTimeout(30)
  }
  expect(await drawn('favorites')).toEqual([s.f1, 'ghost', s.f2])
  await snapshot(shell.locator('#sidebar'), 'drag-to-favorites.png', mask(skiff))
  await shell.mouse.up()
  await expect.poll(() => order((tab) => tab.favorite)).toEqual([s.f1, s.t1, s.f2])
  await expect(ghosts()).toHaveCount(0)
  await expect.poll(() => drawn('favorites')).toEqual([s.f1, s.t1, s.f2])

  // Within its own section the original is hidden, so the tab never shows twice.
  await dragStart(skiff, tile(s.f1))
  await dragOver(skiff, tile(s.f2), { x: 40 })
  await expect.poll(() => drawn('favorites')).toEqual([s.t1, s.f2, 'ghost'])
  await expect(tile(s.f1)).toBeHidden()
  await shell.mouse.up()
  await expect.poll(() => order((tab) => tab.favorite)).toEqual([s.t1, s.f2, s.f1])

  await dragStart(skiff, tile(s.f2))
  await dragOver(skiff, row(s.t2), { y: 4 })
  await expect.poll(() => drawn('list')).toEqual(['pinned', 'ghost', s.t2, 'new'])
  await expect(tile(s.f2)).toHaveClass(/drag-dim/)
  await expect(shell.locator('#space-status')).toHaveText('Drop to remove from favorites, position 1.')
  await shell.mouse.up()
  await expect.poll(() => order(plain)).toEqual([s.f2, s.t2])
  await expect.poll(() => order((tab) => tab.favorite)).toEqual([s.t1, s.f1])

  await skiff.restart()
  await expect.poll(() => drawn('favorites')).toEqual([s.t1, s.f1])
  expect(await order(plain)).toEqual([s.f2, s.t2])
})

test('pinning by drag previews rows, joins folders, unpins, survives state pushes and cancels with Escape', async ({ skiff }) => {
  const s = await seed(skiff, { p1: { pinned: true }, p2: { pinned: true }, r1: { pinned: true, folder: 'Ref' }, f1: { favorite: true }, t1: {}, t2: {}, t3: {}, t4: {} })
  const { row, tile, ghosts, drawn, order } = helpers(skiff, s.space)
  const shell = skiff.shell
  const head = shell.locator('#list [data-folder-head="Ref"]')
  await expect(head.locator('.label')).toHaveText('Ref')
  await expect(head.locator('.when')).toHaveText('1')
  await expect(head.locator('.row-main .icon')).toBeVisible()

  await dragStart(skiff, row(s.t1))
  await dragOver(skiff, row(s.p2), { y: 4 })
  await expect.poll(() => drawn('list')).toEqual([s.p1, 'ghost', s.p2, 'folder:Ref', s.r1, 'divider', s.t1, s.t2, s.t3, s.t4, 'new'])
  await expect(shell.locator('#space-status')).toHaveText('Drop to pin, position 2.')
  // A state push during the drag must not lose the preview or the drop.
  const late = await skiff.rpc('tabs.create', { url: `${skiff.origin}/late`, activate: false })
  await shell.waitForTimeout(100)
  await expect(ghosts()).toHaveCount(1)
  await snapshot(shell.locator('#sidebar'), 'drag-to-pinned.png', mask(skiff))
  await shell.mouse.up()
  await expect.poll(() => order((tab) => tab.pinned && !tab.folder)).toEqual([s.p1, s.t1, s.p2])
  await expect(row(late.id)).toBeVisible()

  await dragStart(skiff, row(s.t2))
  await dragOver(skiff, head)
  await expect.poll(() => drawn('list')).toEqual([s.p1, s.t1, s.p2, 'folder:Ref', s.r1, 'ghost', 'divider', s.t2, s.t3, s.t4, late.id, 'new'])
  await expect(ghosts()).toHaveClass(/nested/)
  await shell.mouse.up()
  await expect.poll(() => order((tab) => tab.folder === 'Ref')).toEqual([s.r1, s.t2])

  await head.locator('.row-main').click()
  await expect(row(s.r1)).toHaveCount(0)
  await dragStart(skiff, row(s.t3))
  await dragOver(skiff, head)
  await expect(head).toHaveClass(/drop-target/)
  await expect(shell.locator('#drag-caption')).toHaveText('Add to Ref')
  await expect(ghosts()).toHaveCount(0)
  await shell.mouse.up()
  await expect.poll(() => order((tab) => tab.folder === 'Ref')).toEqual([s.r1, s.t2, s.t3])

  await dragStart(skiff, row(s.p1))
  await dragOver(skiff, row(s.t4), { y: 30 })
  await expect.poll(() => drawn('list')).toEqual([s.p1, s.t1, s.p2, 'folder:Ref', 'divider', s.t4, 'ghost', late.id, 'new'])
  await expect(shell.locator('#space-status')).toHaveText('Drop to unpin, position 2.')
  await shell.mouse.up()
  await expect.poll(() => order(plain)).toEqual([s.t4, s.p1, late.id])

  const before = (await skiff.state()).tabs
  await dragStart(skiff, row(s.t4))
  await dragOver(skiff, tile(s.f1))
  await expect(ghosts()).toHaveCount(1)
  await shell.keyboard.press('Escape')
  await expect(ghosts()).toHaveCount(0)
  await expect(shell.locator('.drop-zone, .drag-dim, .drag-hide')).toHaveCount(0)
  await shell.mouse.up()
  await shell.waitForTimeout(200)
  expect((await skiff.state()).tabs).toEqual(before)
})

test('empty sections offer drop areas, a space button names its target, and the keyboard crosses sections', async ({ skiff }) => {
  const work = await skiff.rpc('spaces.create', { name: 'Work', color: '#2f9e5b' })
  const s = await seed(skiff, { w1: {}, w2: {}, other: { spaceId: work.id } })
  const { row, tile, ghosts, drawn, order } = helpers(skiff, s.space)
  const shell = skiff.shell
  const zone = (name) => shell.locator(`.drop-zone[data-zone="${name}"]`)

  await expect(zone('favorites')).toHaveCount(0)
  await dragStart(skiff, row(s.w1))
  await expect(zone('favorites')).toBeVisible()
  await expect(zone('pinned')).toBeVisible()
  await dragOver(skiff, zone('pinned'))
  await expect.poll(() => drawn('list')).toEqual(['ghost', s.w1, s.w2, 'new'])
  await expect(zone('pinned')).toBeHidden()
  await shell.mouse.up()
  await expect.poll(() => order((tab) => tab.pinned)).toEqual([s.w1])
  await expect(shell.locator('.drop-zone')).toHaveCount(0)

  await dragStart(skiff, row(s.w2))
  await expect(zone('favorites')).toBeVisible()
  await expect(zone('pinned')).toHaveCount(0)
  await dragOver(skiff, zone('favorites'))
  await expect.poll(() => drawn('favorites')).toEqual(['ghost'])
  await shell.mouse.up()
  await expect.poll(() => order((tab) => tab.favorite)).toEqual([s.w2])

  await dragStart(skiff, row(s.w1))
  await dragOver(skiff, shell.locator(`#dots [data-space-id="${work.id}"]`))
  await expect(shell.locator('#drag-caption')).toHaveText('Move to Work')
  await expect(shell.locator(`#dots [data-space-id="${work.id}"]`)).toHaveClass(/drop-target/)
  await expect(ghosts()).toHaveCount(0)
  await snapshot(shell.locator('#sidebar'), 'drag-to-space.png', mask(skiff))
  await shell.mouse.up()
  await expect.poll(async () => (await skiff.state()).tabs.find((tab) => tab.id === s.w1).spaceId).toBe(work.id)
  await expect(shell.locator('#drag-caption')).toBeHidden()

  // Keyboard path: Alt+Shift+Up/Down steps a top-level tab across favorites, pinned and tabs.
  const third = await skiff.rpc('tabs.create', { url: `${skiff.origin}/third`, activate: false })
  await row(third.id).locator('.row-main').focus()
  await shell.keyboard.press('Alt+Shift+ArrowUp')
  await expect.poll(() => order((tab) => tab.pinned)).toEqual([third.id])
  await expect(row(third.id).locator('.row-main')).toBeFocused()
  await shell.keyboard.press('Alt+Shift+ArrowUp')
  await expect.poll(() => order((tab) => tab.favorite)).toEqual([s.w2, third.id])
  await expect(tile(third.id).locator('.tile-main')).toBeFocused()
  await expect(shell.locator('#space-status')).toHaveText(/Added .* to favorites\./)
  await shell.keyboard.press('Alt+Shift+ArrowUp')
  await expect.poll(() => order((tab) => tab.favorite)).toEqual([third.id, s.w2])
  await shell.keyboard.press('Alt+Shift+ArrowDown')
  await shell.keyboard.press('Alt+Shift+ArrowDown')
  await expect.poll(() => order((tab) => tab.pinned)).toEqual([third.id])
  await expect(row(third.id).locator('.row-main')).toBeFocused()
  await shell.keyboard.press('Alt+Shift+ArrowDown')
  await expect.poll(() => order((tab) => tab.pinned)).toEqual([])
  await expect(row(third.id).locator('.row-main')).toBeFocused()
  expect(await order(plain)).toEqual([third.id])
  await dragTo(skiff, tile(s.w2), row(third.id), { y: 30 })
  await expect.poll(() => order(plain)).toEqual([third.id, s.w2])
})

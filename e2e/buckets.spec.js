'use strict'
const path = require('node:path')
const { test, expect } = require('./fixtures')

const bucketOf = async (skiff, id) => (await skiff.state()).tabs.find((t) => t.id === id)?.bucket

test('a page leaves progress when it loads, one never loaded settles unread until shown, and buckets move by hand', async ({ skiff }) => {
  const shown = await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
  await skiff.page('/one')
  await expect.poll(() => bucketOf(skiff, shown.id)).toMatch(/^(active|unread)$/)

  const first = await skiff.rpc('tabs.create', { url: skiff.origin + '/two', activate: false })
  expect(await bucketOf(skiff, first.id)).toBe('progress')
  expect((await skiff.rpc('archive.sweep')).settled).toEqual([first.id])
  expect(await bucketOf(skiff, first.id)).toBe('unread')
  await skiff.rpc('tabs.activate', { id: first.id })
  await expect.poll(() => bucketOf(skiff, first.id)).toBe('active')

  await skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'done' })
  expect(await bucketOf(skiff, first.id)).toBe('done')
  expect((await skiff.state()).tabs.find((t) => t.id === first.id).doneAt).toBeGreaterThan(0)
  await expect(skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'progress' })).rejects.toThrow(/bucket/)
  await skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'later' })
  expect(await bucketOf(skiff, first.id)).toBe('later')
  await skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'favorites' })
  expect(await bucketOf(skiff, first.id)).toBe('favorites')
  expect((await skiff.rpc('tabs.list')).tabs.find((t) => t.id === first.id).bucket).toBe('favorites')
  await skiff.rpc('tabs.setFavorite', { id: first.id, favorite: false })
  expect(await bucketOf(skiff, first.id)).toBe('active')
  expect(await skiff.rpc('archive.sweep')).toEqual({ archived: [], done: [], settled: [] })
})

const fakeAgent = path.join(__dirname, 'fake-agent.js')

async function useLayer(skiff) {
  const closed = skiff.shell.waitForEvent('close')
  await skiff.shell.evaluate(() => { window.skiff.call('ui.setShell', { name: 'layer' }) })
  await closed
  await expect.poll(() => !skiff.shell.isClosed()).toBe(true)
  await skiff.shell.waitForLoadState()
  await expect.poll(() => skiff.app.context().pages().some((page) => page.url().endsWith('/buoy.html'))).toBe(true)
  return skiff.app.context().pages().find((page) => page.url().endsWith('/buoy.html'))
}

const isOpen = (buoy) => buoy.locator('#buoy').evaluate((el) => el.classList.contains('open') && !el.classList.contains('morphing'))
async function openCard(buoy) {
  await buoy.locator('#buoy-main').click()
  await expect.poll(() => isOpen(buoy)).toBe(true)
}
const centre = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
// A real pointer drag: the drop areas appear after dragstart, so the target is measured after the first frames.
async function dragRow(buoy, source, target) {
  const from = await centre(source)
  await buoy.mouse.move(from.x, from.y)
  await buoy.mouse.down()
  await buoy.mouse.move(from.x + 4, from.y + 4, { steps: 2 })
  await buoy.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const to = await centre(target)
  await buoy.mouse.move(to.x, to.y)
  await expect(buoy.locator('.ghost')).toHaveCount(1)
  await buoy.mouse.up()
}

test('the Layer card lists tabs and threads in six sections that follow their buckets, and the pill counts what is unread', async ({ skiff }) => {
  await skiff.rpc('settings.set', { ai: { agents: [{ name: 'Fake', command: `'${process.execPath}' '${fakeAgent}' '${skiff.root}'` }] } })
  const home = await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
  await skiff.page('/one')
  const buoy = await useLayer(skiff)
  const row = (id) => buoy.locator(`#list li.row[data-tab-id="${id}"]`)
  const sections = () => buoy.locator('#list [data-bucket]').evaluateAll((heads) => heads.map((head) => head.dataset.bucket))
  const unread = buoy.locator('#buoy-unread')
  await expect(unread).toBeHidden()

  // A page that finishes in the background lands in Unread and the pill shows the count.
  const page = await skiff.rpc('tabs.create', { url: skiff.origin + '/two', activate: false })
  await expect.poll(() => bucketOf(skiff, page.id)).toBe('unread')
  await expect(unread).toHaveText('1')
  await openCard(buoy)
  await expect(row(page.id)).toHaveAttribute('data-section', 'unread')
  await expect(buoy.locator('#list [data-bucket="unread"]')).toHaveText(/Unread\s*1/)
  expect(await sections()).toEqual(['unread', 'active'])
  await expect(row(page.id).locator('.label')).toHaveCSS('font-weight', '600')

  // Opening it moves it to Active and the dot goes.
  await row(page.id).locator('.row-main').click()
  await expect.poll(() => isOpen(buoy)).toBe(false)
  await expect.poll(() => bucketOf(skiff, page.id)).toBe('active')
  await expect(unread).toBeHidden()
  await openCard(buoy)
  await expect(row(page.id)).toHaveAttribute('data-section', 'active')
  expect(await sections()).toEqual(['active'])

  // A drag to an empty section drops on its dashed area; Later and Done need no row of their own first.
  await dragRow(buoy, row(page.id), buoy.locator('#list [data-zone="later"]'))
  await expect.poll(() => bucketOf(skiff, page.id)).toBe('later')
  await expect(row(page.id)).toHaveAttribute('data-section', 'later')
  expect(await sections()).toEqual(['active', 'later'])
  await dragRow(buoy, row(page.id), buoy.locator('#list [data-zone="done"]'))
  await expect.poll(() => bucketOf(skiff, page.id)).toBe('done')
  await expect(row(page.id)).toHaveAttribute('data-section', 'done')
  await expect(row(page.id).locator('.when')).toHaveText('archives in 24 h')
  expect(await sections()).toEqual(['active', 'done'])

  // A thread runs in In Progress beside the pages, then lands in Unread among them while the card is open.
  const later = await skiff.rpc('tabs.create', { url: skiff.origin + '/three', activate: false })
  await expect.poll(() => bucketOf(skiff, later.id)).toBe('unread')
  const { tabId } = await skiff.rpc('ai.ask', { text: 'slow reply please', agent: 'Fake' })
  await skiff.rpc('tabs.activate', { id: home.id })
  await expect(row(tabId)).toHaveAttribute('data-section', 'progress')
  await expect(row(tabId).locator('.spinner')).toBeVisible()
  await expect(row(tabId).locator('.when')).toHaveText('Fake')
  await expect(row(tabId).locator('.favicon')).toBeVisible()
  // In Progress is not a drop target: no preview over it, and a release changes nothing.
  const from = await centre(row(page.id))
  await buoy.mouse.move(from.x, from.y)
  await buoy.mouse.down()
  await buoy.mouse.move(from.x + 4, from.y + 4, { steps: 2 })
  await buoy.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const over = await centre(row(tabId))
  await buoy.mouse.move(over.x, over.y)
  await buoy.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(buoy.locator('.ghost')).toHaveCount(0)
  await buoy.mouse.up()
  expect(await bucketOf(skiff, page.id)).toBe('done')
  await expect(row(tabId)).toHaveAttribute('data-section', 'unread', { timeout: 20_000 })
  await expect(buoy.locator('#list [data-bucket="unread"]')).toHaveText(/Unread\s*2/)
  await expect(unread).toHaveText('2')
  expect(await buoy.locator('#list li.row[data-section="unread"]').evaluateAll((rows) => rows.map((r) => r.dataset.tabId).sort())).toEqual([later.id, tabId].sort())

  // The keyboard steps a row into the next section, never into In Progress.
  await row(home.id).locator('.row-main').focus()
  await buoy.keyboard.press('Alt+Shift+ArrowDown')
  await expect.poll(() => bucketOf(skiff, home.id)).toBe('later')
})

'use strict'
const { test, expect } = require('./fixtures')

const shellPage = async (skiff, suffix) => {
  await expect.poll(() => skiff.app.context().pages().some((page) => page.url().endsWith(suffix))).toBe(true)
  const page = skiff.app.context().pages().find((p) => p.url().endsWith(suffix))
  await page.emulateMedia({ colorScheme: 'light' })
  return page
}
const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, clipped: el.scrollWidth > el.clientWidth } })

test('an ear shows the page host after its title, dimmer and plain, with the full URL as its tooltip; a long title gives way before the host', async ({ skiff }) => {
  const id = (await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })).id
  const rect = { x: 200, y: 200, width: 420, height: 300 }
  await skiff.rpc('desk.place', { id, ...rect })
  const page = await skiff.page('/one')
  const frame = await shellPage(skiff, `/frame.html?tab=${id}`)
  const ear = frame.locator('#ear')
  const host = frame.locator('#ear-host')
  await expect(host).toHaveText(new URL(skiff.origin).hostname)
  await expect(ear).toHaveAttribute('title', skiff.origin + '/one')
  expect(await host.evaluate((el) => el.tagName)).toBe('SPAN')
  expect(await frame.evaluate(() => Number(getComputedStyle(document.getElementById('ear-host')).opacity))).toBeLessThan(1)
  const order = await frame.evaluate(() => [...document.getElementById('ear').children].map((el) => el.id))
  expect(order.slice(0, 3)).toEqual(['ear-fav', 'ear-title', 'ear-host'])

  // A title far wider than the window: the title is cut, the host stays whole, and the ear stays inside its window.
  await page.evaluate(() => { document.title = 'A very long title '.repeat(20) })
  await expect(frame.locator('#ear-title')).toContainText('A very long title')
  await expect.poll(async () => (await box(frame.locator('#ear-title'))).clipped).toBe(true)
  const [title, hostBox, earBox] = await Promise.all([box(frame.locator('#ear-title')), box(host), box(ear)])
  expect(hostBox.clipped).toBe(false)
  expect(title.right).toBeLessThanOrEqual(hostBox.left)
  expect(hostBox.right).toBeLessThanOrEqual(earBox.right)
  expect(earBox.right - earBox.left).toBeLessThanOrEqual(rect.width)

  // Exposé measures the same text: a host makes the natural width wider by its own width and the gap.
  const widths = await frame.evaluate(() => [earNatural({ title: 'Docs', url: 'https://example.com/a' }), earNatural({ title: 'Docs', url: '' }), earNatural({ title: 'Docs', url: 'skiff-chat://x' })])
  expect(widths[0]).toBeGreaterThan(widths[1] + 40)
  expect(widths[2]).toBe(widths[1])
  expect(await frame.evaluate(() => [earHost({ url: 'https://www.example.com/a' }), earHost({ url: 'about:blank' }), earHost({ url: 'skiff-chat://x' })])).toEqual(['example.com', '', ''])
})

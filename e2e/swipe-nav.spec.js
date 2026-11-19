'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { test, expect } = require('./fixtures')

const shellsDir = path.join(__dirname, '..', 'shells')
const manifest = (name) => { try { return JSON.parse(fs.readFileSync(path.join(shellsDir, name, 'shell.json'), 'utf8')) } catch { return {} } }
const deskShell = (fs.existsSync(shellsDir) ? fs.readdirSync(shellsDir) : []).sort().find((name) => manifest(name).window === 'desk')

// A trackpad swipe at 60 Hz as [ms, dx, dy] in DOM deltas (negative dx swipes back): the fingers speed up, then macOS momentum decays.
const trackpad = (dir, { speed = 1, tail = 22 } = {}) => [2, 6, 13, 22, 30, ...Array.from({ length: tail }, (_, k) => Math.max(1, Math.round(30 * 0.86 ** (k + 1))))].map((v, i) => [i * 16, dir * Math.round(v * speed), 0])
// Fast fingers and a long momentum tail that keeps flowing after the swipe has navigated.
const flick = (dir) => [4, 12, 26, 44, 60, ...Array.from({ length: 40 }, (_, k) => Math.max(1, Math.round(60 * 0.9 ** (k + 1))))].map((v, i) => [i * 16, dir * v, 0])

// Real wheel input into the page view, in real time; hold keeps the gesture alive with vertical nudges while capturing the page.
const play = (skiff, page, events, point, { hold = false } = {}) => skiff.app.evaluate(({ webContents }, { url, events, point, hold }) => new Promise((resolve) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
  // Chromium reports a wheel delta the other way round from the DOM's.
  const wheel = (x, y) => wc.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: -x, deltaY: -y, canScroll: true, hasPreciseScrollingDeltas: true })
  const start = performance.now()
  const next = (i) => {
    if (i < events.length) {
      const [t, x, y] = events[i]
      return setTimeout(() => { wheel(x, y); next(i + 1) }, Math.max(0, start + t - performance.now()))
    }
    if (!hold) return setTimeout(resolve, 400)
    let k = 0
    const nudge = setInterval(() => wheel(0, k++ % 2 ? 1 : -1), 16)
    setTimeout(() => wc.capturePage().then((image) => { clearInterval(nudge); resolve(image.toPNG().toString('base64')) }), 150)
  }
  next(0)
}), { url: page.url(), events, point, hold })

// ui.setShell replaces the window that runs the call, so the call is not awaited.
async function switchWindow(skiff, name) {
  const old = skiff.shell
  const closed = old.waitForEvent('close')
  await old.evaluate((name) => { window.skiff.call('ui.setShell', { name }) }, name)
  await closed
  await expect.poll(() => !skiff.shell.isClosed()).toBe(true)
  await skiff.shell.waitForLoadState()
}

async function swipeScenario(skiff, testInfo) {
  const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/first` })
  const page = await skiff.page('/first')
  await skiff.app.evaluate(({ webContents }, url) => {
    global.__swipeNavs = []
    webContents.getAllWebContents().find((w) => w.getURL() === url).on('did-navigate', (_e, to) => global.__swipeNavs.push(new URL(to).pathname))
  }, page.url())
  const navs = () => skiff.app.evaluate(() => global.__swipeNavs)
  const go = async (where) => {
    await skiff.rpc('tabs.navigate', { id: tab.id, url: `${skiff.origin}${where}` })
    await expect(page).toHaveURL(`${skiff.origin}${where}`)
  }
  // Counts the bubbles this document has shown; the host is the one element the swipe adds to the page.
  const watchBubbles = () => page.evaluate(() => {
    window.__bubbles = 0
    new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => { if (n.localName === 'skiff-swipe') window.__bubbles++ }))).observe(document.documentElement, { childList: true })
  })
  const bubbles = () => page.evaluate(() => ({ shown: window.__bubbles, left: document.querySelectorAll('skiff-swipe').length }))
  // A new page is told its history as it loads; a swipe also blocks the next page's first gesture for a moment.
  const settle = async () => {
    await page.waitForLoadState('load')
    await page.waitForTimeout(1300)
    await watchBubbles()
  }
  await go('/second')
  await go('/third')
  await settle()
  const point = await page.evaluate(() => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }))
  const edge = () => page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth)
  expect(await edge()).toBeGreaterThan(150)

  // Vertical scrolling is the page's own.
  await play(skiff, page, trackpad(1).map(([t, v]) => [t, 0, v]), point)
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(150)
  expect(await navs()).toEqual(['/second', '/third'])
  expect(await bubbles()).toEqual({ shown: 0, left: 0 })
  await page.evaluate(() => scrollTo(0, 0))

  // No forward history: a forward swipe at the right edge does nothing.
  await page.evaluate(() => scrollTo(document.scrollingElement.scrollWidth, 0))
  await page.waitForTimeout(200)
  await play(skiff, page, trackpad(1), point)
  expect(await navs()).toEqual(['/second', '/third'])
  expect(await bubbles()).toEqual({ shown: 0, left: 0 })
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(200)

  // A short swipe back that reverses before the threshold shows the bubble and takes it away again.
  await play(skiff, page, [...trackpad(-1, { tail: 0 }), ...[10, 25, 30, 12].map((v, i) => [96 + i * 16, v, 0])], point)
  expect(await navs()).toEqual(['/second', '/third'])
  expect(await bubbles()).toEqual({ shown: 1, left: 0 })
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(200)

  // A page that takes the wheel keeps it.
  await page.evaluate(() => addEventListener('wheel', window.__take = (e) => e.preventDefault(), { passive: false }))
  await play(skiff, page, trackpad(-1), point)
  expect(await navs()).toEqual(['/second', '/third'])
  expect((await bubbles()).shown).toBe(1)
  await page.evaluate(() => removeEventListener('wheel', window.__take, { passive: false }))
  await page.waitForTimeout(200)

  // A horizontal scroller under the pointer scrolls to its edge, and only the next gesture swipes back, once, through a long momentum tail.
  await page.evaluate(() => {
    const strip = document.createElement('div')
    strip.id = 'strip'
    strip.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:300px;height:120px;overflow-x:auto;background:#e8eefc'
    strip.append(Object.assign(document.createElement('div'), { style: 'width:1200px;height:100px' }))
    document.body.append(strip)
    strip.scrollLeft = 150
  })
  await play(skiff, page, trackpad(-1), point)
  expect(await page.evaluate(() => document.getElementById('strip').scrollLeft)).toBe(0)
  expect(await navs()).toEqual(['/second', '/third'])
  await play(skiff, page, flick(-1), point)
  await expect(page).toHaveURL(`${skiff.origin}/second`)
  await page.waitForTimeout(600)
  expect(await navs()).toEqual(['/second', '/third', '/second'])

  // Mid-swipe the bubble sits at the left edge, partly filled; lifting short of the threshold cancels it.
  await settle()
  await page.evaluate(() => scrollTo(0, 400))
  const shot = await play(skiff, page, [2, 6, 13, 22, 30, 17].map((v, i) => [i * 16, -v, 0]), point, { hold: true })
  const png = Buffer.from(shot, 'base64')
  await testInfo.attach('swipe-bubble', { body: png, contentType: 'image/png' })
  fs.writeFileSync(testInfo.outputPath('swipe-bubble.png'), png)
  const blue = await page.evaluate(async (data) => {
    const img = new Image()
    img.src = `data:image/png;base64,${data}`
    await img.decode()
    const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height })
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const count = (x0, x1) => {
      const { data: px } = ctx.getImageData(x0, img.height / 2 - 30, x1 - x0, 60)
      let n = 0
      for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 200 && px[i + 2] - px[i] > 25) n++
      return n
    }
    return { left: count(0, 60), right: count(img.width - 60, img.width) }
  }, shot)
  expect(blue.left).toBeGreaterThan(80)
  expect(blue.right).toBe(0)
  await page.waitForTimeout(500)
  expect(await bubbles()).toEqual({ shown: 1, left: 0 })
  expect(await navs()).toEqual(['/second', '/third', '/second'])

  // Forward: the wide page scrolls right first, and at its right edge the swipe goes forward.
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(200)
  await play(skiff, page, trackpad(1), point)
  expect(await page.evaluate(() => scrollX)).toBeGreaterThan(100)
  expect(await navs()).toEqual(['/second', '/third', '/second'])
  await page.evaluate(() => scrollTo(document.scrollingElement.scrollWidth, 0))
  await page.waitForTimeout(200)
  await play(skiff, page, trackpad(1), point)
  await expect(page).toHaveURL(`${skiff.origin}/third`)
  expect(await navs()).toEqual(['/second', '/third', '/second', '/third'])
}

test('a two finger swipe on a page goes back and forward in the default shell', async ({ skiff }, testInfo) => {
  await swipeScenario(skiff, testInfo)
})

test('a two finger swipe on a page goes back and forward in the desk shell', async ({ skiff }, testInfo) => {
  test.skip(!deskShell, 'No bundled shell asks for a desk window')
  await switchWindow(skiff, deskShell)
  await swipeScenario(skiff, testInfo)
})

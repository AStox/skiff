'use strict'
const { test, expect, snapshot } = require('./fixtures')

async function useLayer(skiff) {
  const old = skiff.shell
  const closed = old.waitForEvent('close')
  await old.evaluate(() => { window.skiff.call('ui.setShell', { name: 'layer' }) })
  await closed
  await expect.poll(() => !skiff.shell.isClosed()).toBe(true)
  await skiff.shell.waitForLoadState()
}
const shellPage = async (skiff, suffix) => {
  const at = (page) => page.url().endsWith(suffix)
  await expect.poll(() => skiff.app.context().pages().some(at)).toBe(true)
  const page = skiff.app.context().pages().find(at)
  await page.emulateMedia({ colorScheme: 'light' })
  return page
}
// Views of the desk window, back to front: pages by path, other shell pages by file.
const children = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children.map((view) => {
  const url = new URL(view.webContents.getURL())
  return url.protocol.startsWith('http') ? url.pathname : url.pathname.split('/').pop()
}))
const exposed = async (skiff) => (await children(skiff)).includes('expose.html')
const pages = async (skiff) => (await children(skiff)).filter((name) => name.startsWith('/'))
const spaceCalls = async (skiff) => (await skiff.audit()).spaceCalls.length
const activeId = async (skiff) => { const s = await skiff.state(); return s.activeTabBySpace[s.activeSpaceId] }

// A two finger swipe at 60 Hz as [ms, dx, dy] in DOM wheel deltas: the fingers speed up, then macOS momentum decays.
// With natural scrolling, fingers moving up send a positive deltaY.
const swipe = (dx, dy) => [2, 6, 13, 22, 30, ...Array.from({ length: 14 }, (_, k) => Math.max(1, Math.round(30 * 0.86 ** (k + 1))))].map((v, i) => [i * 16, dx * v, dy * v])
const UP = swipe(0, 1)
const DOWN = swipe(0, -1)
const SIDEWAYS = swipe(1, 0.2)

// Real wheel input, in real time, to the web contents whose URL contains match, at a point in its CSS pixels.
const play = (skiff, match, point, events) => skiff.app.evaluate(({ webContents }, { match, point, events }) => new Promise((resolve) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(match))
  const start = performance.now()
  const next = (i) => {
    if (i === events.length) return setTimeout(resolve, 400)
    const [t, x, y] = events[i]
    setTimeout(() => {
      // Chromium hands the page both wheel deltas the other way round.
      wc.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: -x, deltaY: -y, canScroll: true, hasPreciseScrollingDeltas: true })
      next(i + 1)
    }, Math.max(0, start + t - performance.now()))
  }
  next(0)
}), { match, point, events })
const centre = (page, selector) => page.evaluate((selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }, selector)
const onBuoy = async (skiff, events) => play(skiff, '/buoy.html', await centre(await shellPage(skiff, '/buoy.html'), '#buoy'), events)
const onEar = async (skiff, id, events) => play(skiff, `frame.html?tab=${id}`, await centre(await shellPage(skiff, `frame.html?tab=${id}`), '#ear'), events)

// Four windows of mixed sizes, the fourth hidden, the first in front.
async function desk(skiff) {
  await useLayer(skiff)
  const rects = { one: [80, 90, 620, 420], two: [460, 240, 700, 480], three: [180, 420, 420, 300], four: [700, 60, 520, 360] }
  const ids = {}
  for (const [name, [x, y, width, height]] of Object.entries(rects)) {
    ids[name] = (await skiff.rpc('tabs.create', { url: `${skiff.origin}/${name}` })).id
    await skiff.rpc('desk.place', { id: ids[name], x, y, width, height })
  }
  await expect.poll(async () => (await skiff.state()).tabs.filter((t) => t.title === 'Fixture reading').length).toBe(4)
  await skiff.rpc('desk.hide', { id: ids.four })
  await skiff.rpc('tabs.activate', { id: ids.one })
  await expect.poll(async () => { const list = await pages(skiff); return list.length === 3 && list.at(-1) }).toBe('/one')
  return { ids, order: await pages(skiff) }
}

test('a two finger swipe up on the Buoy spreads the windows out with live pictures, a swipe down puts them back, and sideways still switches spaces', async ({ skiff }) => {
  await skiff.rpc('spaces.create', { name: 'Second' })
  const { ids, order } = await desk(skiff)
  const buoy = await shellPage(skiff, '/buoy.html')

  // The recogniser alone: one fire per gesture, up or down by the sign of deltaY, sideways only when mostly sideways.
  const fired = await buoy.evaluate((streams) => streams.map((events) => {
    const swipe = swipeTracker(true)
    return events.flatMap(([t, x, y]) => swipe.step(t, x, y) || [])
  }), [UP, DOWN, SIDEWAYS, [...UP, ...swipe(1, 0).map(([t, x, y]) => [t + 500, x, y])], [...UP, ...swipe(1, 0).map(([t, x, y]) => [t + 300, x, y])], UP.map(([t, x, y]) => [t, y, y]),
    [...UP, ...DOWN.map(([t, x, y]) => [t + 300, x, y])], [...UP, ...Array.from({ length: 12 }, (_, i) => [300 + i * 16, 0, -2])], [...UP, ...UP.map(([t, x, y]) => [t + 300, x, y])]])
  // A reversal while a tail still runs is a new touch, as sideways ever was; a few stray pixels the other way and a second swipe straight on are not.
  expect(fired).toEqual([['up'], ['down'], [1], ['up', 1], ['up'], [], ['up', 'down'], ['up'], ['up']])
  // Chromium hands the page both deltas of sendInputEvent the other way round, so play() flips them.
  await buoy.evaluate(() => { window.seen = []; addEventListener('wheel', (e) => window.seen.push([e.deltaX, e.deltaY]), { capture: true }) })
  await onBuoy(skiff, [[0, 3, 7]])
  expect(await buoy.evaluate(() => window.seen)).toEqual([[3, 7]])

  const before = await skiff.state()
  const switches = await spaceCalls(skiff)
  // Loaded with the shell, so the first exposé never waits for its page; its first frame of cards is each window exactly where it is, picture drawn, with the ear its frame shows.
  const expose = await shellPage(skiff, '/expose.html')
  const ears = {}
  for (const name of ['one', 'two', 'three']) ears[ids[name]] = await (await shellPage(skiff, `frame.html?tab=${ids[name]}`)).evaluate(() => !document.documentElement.classList.contains('earless'))
  await expose.evaluate(() => {
    new MutationObserver((_, watch) => {
      const slots = [...document.querySelectorAll('.slot:not(.shelved)')]
      if (!slots.length) return
      watch.disconnect()
      window.firstFrame = Object.fromEntries(slots.map((slot) => {
        const win = slot.querySelector('.win')
        const r = win.getBoundingClientRect()
        const img = win.querySelector('img.shot')
        const ear = win.querySelector('.ear')
        return [slot.dataset.tabId, { rect: [r.x, r.y, r.width, r.height].map(Math.round), picture: Boolean(img?.complete && img.naturalWidth), ear: !ear.hidden && getComputedStyle(ear).opacity === '1' }]
      }))
    }).observe(document.getElementById('stage'), { childList: true })
  })
  const calls = (await skiff.audit()).overlayCalls.length
  await onBuoy(skiff, UP)
  await expect.poll(() => exposed(skiff)).toBe(true)
  await expect(expose.locator('.slot')).toHaveCount(4)
  await expect(expose.locator('.slot:not(.shelved)')).toHaveCount(3)
  await expect(expose.locator('.slot.shelved')).toHaveAttribute('data-tab-id', ids.four)
  await expect(expose.locator('.slot.shelved')).toHaveAttribute('aria-label', 'Fixture reading, hidden')
  for (const name of ['one', 'two', 'three']) await expect(expose.locator(`.slot[data-tab-id="${ids[name]}"] img.shot`)).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
  await expect(expose.locator(`.slot[data-tab-id="${ids.one}"]`)).toBeFocused()
  const tabs = Object.fromEntries(before.tabs.map((t) => [t.id, t.desk]))
  expect(await expose.evaluate(() => window.firstFrame)).toEqual(Object.fromEntries(['one', 'two', 'three'].map((name) => {
    const { x, y, width, height } = tabs[ids[name]]
    return [ids[name], { rect: [x, y, width, height], picture: true, ear: ears[ids[name]] }]
  })))
  expect(ears[ids.one]).toBe(true)
  // A hidden window is not drawn, so it has no picture, only its icon and title.
  await expect(expose.locator('.slot.shelved .blank')).toHaveText('Fixture reading')
  await expect(expose.locator('.slot.shelved img.shot')).toHaveCount(0)
  // It is laid out as the window it is, scaled into its tile, so it can grow into the window; its tile corners stay 7px on screen.
  const tile = await expose.locator('.slot.shelved').evaluate((slot) => {
    const win = slot.querySelector('.win')
    const k = Number(win.style.getPropertyValue('--k'))
    return { size: [win.style.width, win.style.height], k, radius: parseFloat(getComputedStyle(win.querySelector('.card')).borderRadius), width: slot.getBoundingClientRect().width, parts: ['.ear', '.ring', '.glow'].map((part) => Boolean(win.querySelector(part))) }
  })
  expect(tile.size).toEqual([`${tabs[ids.four].width}px`, `${tabs[ids.four].height}px`])
  expect(tile.k).toBeCloseTo(tabs[ids.four].width / tile.width, 1)
  expect(tile.radius).toBeCloseTo(7 * tile.k, 3)
  expect(tile.parts).toEqual([true, true, true])
  await expect(expose.locator('#empty')).toBeHidden()
  // The cards stand in for the windows, which leave until exposé closes.
  await expect.poll(() => pages(skiff)).toEqual([])
  const opened = (await skiff.audit()).overlayCalls.slice(calls).map(({ method, params }) => [method, params.name ?? params.visible]).filter(([method, value]) => value === 'expose' || method === 'ui.setPageVisible')
  expect(opened).toEqual([['ui.showOverlay', 'expose'], ['ui.setPageVisible', false]])
  expect(await spaceCalls(skiff), 'A vertical swipe never switches spaces').toBe(switches)
  // The Buoy stays above exposé, as the Dock does over Mission Control, and no card lies under it.
  const pill = await expose.evaluate(() => buoyRect(state))
  for (const box of await expose.locator('.slot').evaluateAll((slots) => slots.map((s) => s.getBoundingClientRect().toJSON()))) {
    expect(box.x >= pill.x + pill.width || box.x + box.width <= pill.x || box.y + box.height <= pill.y || box.y >= pill.y + pill.height).toBe(true)
  }
  await expect(expose.locator('html')).toHaveClass(/\bsettled\b/)
  // Once the windows are gone the veil is a plain fill: a masked full-screen layer is dear to fade.
  await expect(expose.locator('#veil .fill')).not.toHaveAttribute('mask', /./)
  await expose.mouse.move(2, 2)
  await snapshot(expose.locator('body'), 'expose.png', { mask: [expose.locator('img.shot')] })

  await onBuoy(skiff, DOWN)
  await expect.poll(() => exposed(skiff)).toBe(false)
  await expect.poll(() => pages(skiff)).toEqual(order)
  const after = await skiff.state()
  expect(after.activeTabBySpace).toEqual(before.activeTabBySpace)
  expect(after.tabs.map((t) => t.desk)).toEqual(before.tabs.map((t) => t.desk))
  expect(await spaceCalls(skiff)).toBe(switches)

  // Sideways on the Buoy switches spaces and never opens exposé.
  await onBuoy(skiff, SIDEWAYS)
  await expect.poll(() => spaceCalls(skiff)).toBe(switches + 1)
  expect(await exposed(skiff)).toBe(false)
  expect((await skiff.state()).activeSpaceId).not.toBe(before.activeSpaceId)
})

test('on an ear the swipe up opens exposé too, and Escape, the backdrop, a swipe down over it and the gesture again close it without a change', async ({ skiff }) => {
  const { ids, order } = await desk(skiff)
  const before = await skiff.state()
  const unchanged = async () => {
    await expect.poll(() => exposed(skiff)).toBe(false)
    await expect.poll(() => pages(skiff)).toEqual(order)
    const s = await skiff.state()
    expect(s.activeTabBySpace).toEqual(before.activeTabBySpace)
    expect(s.tabs.map((t) => t.desk)).toEqual(before.tabs.map((t) => t.desk))
  }
  const open = async (how) => {
    await how()
    await expect.poll(() => exposed(skiff)).toBe(true)
    const expose = await shellPage(skiff, '/expose.html')
    await expect(expose.locator('.slot')).toHaveCount(4)
    return expose
  }
  const switches = await spaceCalls(skiff)

  const expose = await open(() => onEar(skiff, ids.one, UP))
  await expose.keyboard.press('Escape')
  await unchanged()

  await open(() => onEar(skiff, ids.two, UP))
  await expose.mouse.click(8, 8)
  await unchanged()

  await open(() => onBuoy(skiff, UP))
  await play(skiff, '/expose.html', { x: 640, y: 400 }, DOWN)
  await unchanged()

  await open(() => onEar(skiff, ids.one, UP))
  await onBuoy(skiff, UP)
  await unchanged()
  expect(await spaceCalls(skiff)).toBe(switches)
})

test('on a page the swipe up opens exposé only when it has nothing left to scroll, and never mid-scroll or the other way', async ({ skiff }) => {
  await desk(skiff)
  const page = await skiff.page('/one')
  const onPage = (events) => play(skiff, '/one', { x: 200, y: 200 }, events)
  // Fingers up with natural scrolling scrolls the page down, so it scrolls while there is more page below.
  await onPage(UP)
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)
  expect(await exposed(skiff)).toBe(false)
  await page.evaluate(() => scrollTo(0, document.scrollingElement.scrollHeight))
  await page.waitForTimeout(200)
  // Fingers down at the bottom scrolls back up; at the top it has nothing to scroll but is not the gesture.
  await onPage(DOWN)
  expect(await exposed(skiff)).toBe(false)
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(200)
  await onPage(DOWN)
  expect(await exposed(skiff)).toBe(false)
  await page.evaluate(() => scrollTo(0, document.scrollingElement.scrollHeight))
  await page.waitForTimeout(200)
  await onPage(UP)
  await expect.poll(() => exposed(skiff)).toBe(true)
  const expose = await shellPage(skiff, '/expose.html')
  await expect(expose.locator('.slot')).toHaveCount(4)
  await expose.keyboard.press('Escape')
  await expect.poll(() => exposed(skiff)).toBe(false)
})

test('a window picked in exposé comes to the front, a hidden one is shown, and the arrows with Enter pick by keyboard', async ({ skiff }) => {
  const { ids, order } = await desk(skiff)
  const open = async () => {
    await onBuoy(skiff, UP)
    await expect.poll(() => exposed(skiff)).toBe(true)
    const expose = await shellPage(skiff, '/expose.html')
    await expect(expose.locator('.slot')).toHaveCount(4)
    return expose
  }

  let expose = await open()
  await expose.locator(`.slot[data-tab-id="${ids.three}"]`).click()
  await expect.poll(() => exposed(skiff)).toBe(false)
  await expect.poll(() => pages(skiff)).toEqual([...order.filter((p) => p !== '/three'), '/three'])
  expect(await activeId(skiff)).toBe(ids.three)

  expose = await open()
  // The tile grows into the window's corners and gives way to the page once it is drawn, with no blank or hard-cornered card at the end.
  await expose.evaluate(() => {
    window.landing = []
    const sample = () => {
      const slot = document.querySelector('.slot.shelved')
      if (!slot) return
      const win = slot.querySelector('.win')
      window.landing.push({ radius: parseFloat(getComputedStyle(win.querySelector('.card')).borderRadius), k: Number(win.style.getPropertyValue('--k')), ring: Number(getComputedStyle(win.querySelector('.ring')).opacity), ear: Number(getComputedStyle(win.querySelector('.ear')).opacity), card: Number(getComputedStyle(slot).opacity) })
      requestAnimationFrame(sample)
    }
    document.querySelector('.slot.shelved').addEventListener('click', () => requestAnimationFrame(sample))
  })
  await expose.locator('.slot.shelved').click()
  await expect.poll(() => exposed(skiff)).toBe(false)
  await expect.poll(() => pages(skiff)).toEqual([...order.filter((p) => p !== '/three'), '/three', '/four'])
  expect(await activeId(skiff)).toBe(ids.four)
  expect((await skiff.state()).tabs.find((t) => t.id === ids.four).desk.hidden).toBeFalsy()
  const landing = await expose.evaluate(() => window.landing)
  expect(landing.length).toBeGreaterThan(5)
  // On screen the corners go from the tile's 7px to the window's 10px, whatever the scale on the way.
  expect(landing[0].radius).toBeGreaterThan(10)
  expect(landing.at(-1).radius).toBeLessThanOrEqual(10 + 0.01)
  expect(Math.max(...landing.map((s) => s.ring))).toBe(1)
  expect(Math.max(...landing.map((s) => s.ear))).toBe(1)
  expect(Math.min(...landing.map((s) => s.card)), 'The card fades off the page').toBeLessThan(1)

  expose = await open()
  await expect(expose.locator(`.slot[data-tab-id="${ids.four}"]`)).toBeFocused()
  await expect(expose.locator('.slot.shelved')).toHaveCount(0)
  await expose.keyboard.press('ArrowLeft')
  const picked = await expose.evaluate(() => document.activeElement.dataset.tabId)
  expect(picked).not.toBe(ids.four)
  // The arrows mark the card they reach and show its title, as the pointer does.
  await expect(expose.locator('html')).toHaveClass(/\bkeyed\b/)
  await expect.poll(() => expose.evaluate(() => getComputedStyle(document.activeElement.querySelector('.label')).opacity)).toBe('1')
  await expose.keyboard.press('Enter')
  await expect.poll(() => exposed(skiff)).toBe(false)
  expect(await activeId(skiff)).toBe(picked)
  await expect.poll(async () => (await pages(skiff)).at(-1)).toBe(`/${Object.keys(ids).find((name) => ids[name] === picked)}`)
})

test('a click glides the window home at once, before the core has brought it forward, and a tab picked elsewhere while exposé is open is picked there', async ({ skiff }) => {
  const { ids, order } = await desk(skiff)
  const open = async () => {
    await onBuoy(skiff, UP)
    await expect.poll(() => exposed(skiff)).toBe(true)
    const expose = await shellPage(skiff, '/expose.html')
    await expect(expose.locator('html')).toHaveClass(/\bsettled\b/)
    return expose
  }
  const transform = (expose, id) => expose.evaluate((id) => getComputedStyle(document.querySelector(`.slot[data-tab-id="${id}"] .win`)).transform, id)

  let expose = await open()
  const placed = await transform(expose, ids.three)
  await skiff.app.evaluate(() => { global.__skiffVisualDelay = { 'tabs.activate': 1500 } })
  const clicked = (await skiff.audit()).overlayCalls.length
  await expose.locator(`.slot[data-tab-id="${ids.three}"]`).click()
  await expect.poll(() => transform(expose, ids.three), { timeout: 600 }).not.toBe(placed)
  expect(await activeId(skiff), 'The card moves while the core still has the old window in front').toBe(ids.one)
  await expect.poll(() => exposed(skiff)).toBe(false)
  await skiff.app.evaluate(() => { global.__skiffVisualDelay = null })
  expect(await activeId(skiff)).toBe(ids.three)
  // The pages come back under the cards before the overlay goes, and only once the window is in front.
  const after = (await skiff.audit()).overlayCalls.slice(clicked).map(({ method, params }) => [method, params])
  expect(after).toEqual([['tabs.activate', { id: ids.three }], ['ui.setPageVisible', { visible: true }], ['ui.hideOverlay', { name: 'expose' }]])
  await expect.poll(() => pages(skiff)).toEqual([...order.filter((p) => p !== '/three'), '/three'])

  expose = await open()
  await skiff.rpc('tabs.activate', { id: ids.two })
  await expect.poll(() => exposed(skiff)).toBe(false)
  await expect.poll(async () => (await pages(skiff)).at(-1)).toBe('/two')

  // A swipe up that lands while the windows are still going home is not lost: exposé opens again once it has gone.
  expose = await open()
  const shows = async () => (await skiff.audit()).overlayCalls.filter(({ method, params }) => method === 'ui.showOverlay' && params.name === 'expose').length
  const count = await shows()
  await expose.keyboard.press('Escape')
  await skiff.rpc('ui.emit', { name: 'expose', focus: false })
  await expect.poll(shows).toBe(count + 1)
  await expect.poll(() => exposed(skiff)).toBe(true)
  await expect(expose.locator('.slot')).toHaveCount(4)
  await expect(expose.locator('html')).toHaveClass(/\bsettled\b/)
  await expose.keyboard.press('Escape')
  await expect.poll(() => exposed(skiff)).toBe(false)
})

test('exposé in a space with no windows says so, and in the incognito space shows its own windows', async ({ skiff }) => {
  await useLayer(skiff)
  const empty = await skiff.rpc('spaces.create', { name: 'Empty' })
  await skiff.rpc('spaces.activate', { id: empty.id })
  await onBuoy(skiff, UP)
  await expect.poll(() => exposed(skiff)).toBe(true)
  const expose = await shellPage(skiff, '/expose.html')
  await expect(expose.locator('#empty')).toBeVisible()
  await expect(expose.locator('#empty')).toHaveText('No windows in this space')
  await expect(expose.locator('.slot')).toHaveCount(0)
  await expose.keyboard.press('Escape')
  await expect.poll(() => exposed(skiff)).toBe(false)

  const space = await skiff.rpc('incognito.open')
  const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/private`, spaceId: space.id })
  await expect.poll(async () => (await skiff.state()).tabs.find((t) => t.id === tab.id)?.title).toBe('Fixture reading')
  await expect.poll(() => pages(skiff)).toEqual(['/private'])
  await onBuoy(skiff, UP)
  await expect.poll(() => exposed(skiff)).toBe(true)
  await expect(expose.locator('html')).toHaveClass(/\bincognito\b/)
  await expect(expose.locator('#empty')).toBeHidden()
  await expect(expose.locator('.slot')).toHaveCount(1)
  await expect(expose.locator(`.slot[data-tab-id="${tab.id}"] img.shot`)).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
  await expose.locator(`.slot[data-tab-id="${tab.id}"]`).click()
  await expect.poll(() => exposed(skiff)).toBe(false)
  await expect.poll(() => pages(skiff)).toEqual(['/private'])
})

test('with reduced motion exposé fades instead of gliding, and the pages are back under the cards before the cards go', async ({ skiff }) => {
  const { ids, order } = await desk(skiff)
  const expose = await shellPage(skiff, '/expose.html')
  await expose.emulateMedia({ reducedMotion: 'reduce' })
  await onBuoy(skiff, UP)
  await expect.poll(() => exposed(skiff)).toBe(true)
  await expect(expose.locator('html')).toHaveClass(/\bsettled\b/)
  await expect(expose.locator('.slot')).toHaveCount(4)
  expect(await expose.evaluate(() => [...document.querySelectorAll('.slot .win')].map((win) => win.getAnimations().length))).toEqual([0, 0, 0, 0])
  const calls = (await skiff.audit()).overlayCalls.length
  await expose.locator('.slot.shelved').click()
  await expect.poll(() => exposed(skiff)).toBe(false)
  const after = (await skiff.audit()).overlayCalls.slice(calls).map(({ method, params }) => [method, params])
  expect(after).toEqual([['tabs.activate', { id: ids.four }], ['ui.setPageVisible', { visible: true }], ['ui.hideOverlay', { name: 'expose' }]])
  await expect.poll(() => pages(skiff)).toEqual([...order, '/four'])
})

test('Escape while the pictures are still being taken leaves at once, and the windows never go', async ({ skiff }) => {
  const { order } = await desk(skiff)
  const expose = await shellPage(skiff, '/expose.html')
  await skiff.app.evaluate(() => { global.__skiffVisualDelay = { 'tabs.thumbnails': 1200 } })
  const calls = (await skiff.audit()).overlayCalls.length
  await skiff.rpc('ui.emit', { name: 'expose', focus: false })
  await expect.poll(() => exposed(skiff)).toBe(true)
  // The desk has dimmed around the windows, which are still real.
  await expect.poll(() => expose.evaluate(() => document.getElementById('holes').children.length)).toBeGreaterThan(0)
  await expose.keyboard.press('Escape')
  await expect.poll(() => exposed(skiff)).toBe(false)
  expect(await pages(skiff)).toEqual(order)
  await skiff.app.evaluate(() => { global.__skiffVisualDelay = null })
  // The pictures that arrive afterwards open nothing.
  await skiff.shell.waitForTimeout(1500)
  expect(await exposed(skiff)).toBe(false)
  expect(await pages(skiff)).toEqual(order)
  expect((await skiff.audit()).overlayCalls.slice(calls).filter(({ method }) => method === 'ui.setPageVisible')).toEqual([])
})

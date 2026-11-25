'use strict'
const { test, expect } = require('./fixtures')

const floatOpen = (skiff, file) => skiff.app.context().pages().some((page) => page.url().endsWith(file) && !page.isClosed())
const icon = (buoy, id) => buoy.locator(`.buoy-tab[data-tab-id="${id}"]`)
const tabOf = async (skiff, id) => (await skiff.state()).tabs.find((t) => t.id === id)
const createTab = async (skiff, path, params = {}) => (await skiff.rpc('tabs.create', { url: `${skiff.origin}${path}`, ...params })).id

test('a favorite is grey until its page is open and in colour after; an ordinary tab has an icon that brings it forward', async ({ skiff }) => {
  const space = (await skiff.state()).activeSpaceId
  const fav = await createTab(skiff, '/one?fav')
  await skiff.rpc('tabs.setFavorite', { id: fav, favorite: true })
  await skiff.rpc('desk.hide', { id: fav })
  const other = await createTab(skiff, '/two')
  const here = await createTab(skiff, '/one?here')
  // After a restart a favorite hidden from the desk has no page until it is used.
  await skiff.restart()
  expect((await tabOf(skiff, fav)).lifecycle).toBeUndefined()
  const buoy = await skiff.bar()
  const closed = icon(buoy, fav)
  await expect(closed).toHaveClass(/buoy-fav/)
  await expect(closed).toHaveClass(/closed/)
  await expect(closed.locator('.favicon')).toHaveCSS('filter', 'grayscale(1)')
  await expect(closed.locator('.favicon')).toHaveCSS('opacity', '0.42')

  await skiff.rpc('tabs.activate', { id: fav })
  await expect.poll(async () => (await tabOf(skiff, fav)).lifecycle).toBe('live')
  await expect(closed).not.toHaveClass(/closed/)
  await expect(closed.locator('.favicon')).toHaveCSS('filter', 'none')
  await expect(closed.locator('.favicon')).toHaveCSS('opacity', '1')
  await expect(closed).toHaveClass(/current/)

  // An ordinary open tab is an icon after the favorites, titled and labelled, and a click picks it.
  const tab = icon(buoy, other)
  await expect(tab).not.toHaveClass(/buoy-fav/)
  await expect(tab).toHaveAttribute('aria-label', 'Fixture reading')
  await expect(tab).toHaveAttribute('title', 'Fixture reading')
  expect(await buoy.locator('.buoy-tab[data-tab-id]').evaluateAll((els) => els.map((el) => el.dataset.tabId))).toEqual([fav, other, here])
  await tab.click()
  await expect.poll(async () => (await skiff.state()).activeTabBySpace[space]).toBe(other)
  await expect(tab).toHaveClass(/current/)
  await expect(closed).not.toHaveClass(/current/)
  expect((await skiff.state()).activeSpaceId).toBe(space)
})

test('an agent tab\'s icon shows working, idle, done and unseen, then done and seen, with the words in its label', async ({ skiff }) => {
  const id = await createTab(skiff, '/one?agent', { agent: 'omp' })
  const buoy = await skiff.bar()
  const tab = icon(buoy, id)
  const dot = tab.locator('.agent-dot')
  const title = 'Fixture reading'
  await expect(dot).toHaveAttribute('data-state', 'working')
  await expect(tab).toHaveAttribute('aria-label', `${title}, omp working`)
  await expect(tab).toHaveAttribute('title', `${title}, omp working`)
  await expect(dot).toHaveCSS('background-color', 'rgb(122, 90, 248)')

  await skiff.rpc('agent.giveBack', { id })
  await expect(dot).toHaveAttribute('data-state', 'idle')
  await expect(tab).toHaveAttribute('aria-label', `${title}, omp idle`)
  await expect(dot).toHaveCSS('background-color', 'rgb(122, 90, 248)')
  await expect(dot).toHaveCSS('animation-name', 'none')

  await skiff.rpc('agent.finish', { tabId: id, agent: 'omp', summary: 'done' })
  await expect(dot).toHaveAttribute('data-state', 'done')
  await expect(dot).toHaveAttribute('data-unseen', '')
  await expect(tab).toHaveAttribute('aria-label', `${title}, omp done`)
  await expect(dot).toHaveCSS('background-color', 'rgb(47, 158, 91)')
  const unseenRing = await dot.evaluate((el) => getComputedStyle(el).boxShadow)

  // Looking at it clears the unseen ring; it keeps its dot for as long as it has an agent.
  await skiff.rpc('tabs.activate', { id })
  await expect(dot).not.toHaveAttribute('data-unseen', '')
  await expect(dot).toHaveAttribute('data-state', 'done')
  await expect(tab).toHaveAttribute('aria-label', `${title}, omp done`)
  expect(await dot.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe(unseenRing)
})

test('a working dot pulses, steady under reduced motion, and a tab an agent asks for shows a red dot with the words', async ({ skiff }) => {
  const user = await createTab(skiff, '/one?asked')
  const agentTab = await createTab(skiff, '/two', { agent: 'omp' })
  const buoy = await skiff.bar()
  const working = icon(buoy, agentTab).locator('.agent-dot')
  await expect(working).toHaveAttribute('data-state', 'working')
  const ring = () => working.evaluate((el) => getComputedStyle(el, '::after').animationName)
  await expect.poll(ring).toBe('agent-ping')
  await buoy.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(ring).toBe('none')
  await buoy.emulateMedia({ reducedMotion: 'no-preference' })

  const asking = skiff.http('agent.requestTab', { id: user, agent: 'bb' })
  await expect(icon(buoy, user).locator('.agent-dot')).toHaveAttribute('data-state', 'asking')
  await expect(icon(buoy, user)).toHaveAttribute('aria-label', 'Fixture reading, bb asks for this tab')
  await expect(icon(buoy, user).locator('.agent-dot')).toHaveCSS('background-color', 'rgb(229, 72, 77)')
  await skiff.rpc('agent.answerTab', { id: user, allow: false })
  await asking.catch(() => {})
  await expect(icon(buoy, user).locator('.agent-dot')).toHaveCount(0)
  await expect(icon(buoy, user)).toHaveAttribute('aria-label', 'Fixture reading')
})

test('an unread tab shows a dot on its icon, and an icon carries one mark: the agent dot, else the speaker, else the dot', async ({ skiff }) => {
  const buoy = await skiff.bar()
  const id = await createTab(skiff, '/two', { activate: false })
  await expect.poll(async () => (await tabOf(skiff, id)).bucket).toBe('unread')
  const dot = icon(buoy, id).locator('.buoy-unread')
  await expect(dot).toBeVisible()
  const box = await dot.boundingBox()
  expect([box.width, box.height]).toEqual([6, 6])
  await expect(dot).toHaveCSS('background-color', await buoy.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()).then((hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`))

  await skiff.rpc('tabs.activate', { id })
  await expect(icon(buoy, id).locator('.buoy-unread')).toHaveCount(0)

  // An icon carries one mark, the first that applies.
  const marks = await buoy.evaluate(() => {
    const tab = { id: 'x', url: 'https://example.com', bucket: 'unread', protections: { audible: true } }
    const kinds = (t) => dockMark(t)?.className
    return [kinds({ ...tab, agent: 'omp', agentState: 'working' }), kinds({ ...tab, agentRequest: { agent: 'omp' } }), kinds(tab), kinds({ ...tab, protections: {} }), kinds({ ...tab, bucket: 'active', protections: {} })]
  })
  expect(marks).toEqual(['agent-dot', 'agent-dot', 'speaker', 'buoy-unread', undefined])
})

test('agent tabs of other spaces follow after a hairline, picking one switches to its space, and one that is done and seen is not shown', async ({ skiff }) => {
  const first = (await skiff.state()).activeSpaceId
  const agentTab = await createTab(skiff, '/one?far', { agent: 'omp' })
  const second = (await skiff.rpc('spaces.create', { name: 'Second' })).id
  await skiff.rpc('spaces.activate', { id: second })
  const fav = await createTab(skiff, '/two?fav')
  await skiff.rpc('tabs.setFavorite', { id: fav, favorite: true })
  const mine = await createTab(skiff, '/two?mine')
  const buoy = await skiff.bar()
  const ids = () => buoy.locator('.buoy-tab[data-tab-id]').evaluateAll((els) => els.map((el) => el.dataset.tabId))
  await expect.poll(ids).toEqual([fav, mine, agentTab])
  await expect(icon(buoy, agentTab).locator('.agent-dot')).toHaveAttribute('data-state', 'working')
  // A hairline between favorites and open tabs, and another before the agent tabs of other spaces.
  expect(await buoy.locator('#buoy-dock').evaluate((box) => [...box.children].map((el) => (el.classList.contains('buoy-sep') ? '|' : el.dataset.tabId)))).toEqual([fav, '|', mine, '|', agentTab])

  await skiff.rpc('agent.finish', { tabId: agentTab, agent: 'omp', summary: 'done' })
  await expect(icon(buoy, agentTab).locator('.agent-dot')).toHaveAttribute('data-unseen', '')
  await icon(buoy, agentTab).click()
  await expect.poll(async () => (await skiff.state()).activeSpaceId).toBe(first)
  await expect.poll(async () => (await skiff.state()).activeTabBySpace[first]).toBe(agentTab)
  // Seen and done, it is only in its own space's row of tabs, and the other space's pill no longer lists it.
  await expect.poll(async () => (await tabOf(skiff, agentTab)).agentUnseen).toBeUndefined()
  await skiff.rpc('spaces.activate', { id: second })
  await expect.poll(ids).toEqual([fav, mine])
  expect(await buoy.locator('#buoy-dock .buoy-sep').count()).toBe(1)
})

test('the space\'s name shows beside the dot after a space switch, then goes; its text is set all the while', async ({ skiff }) => {
  const first = (await skiff.state()).activeSpaceId
  const buoy = await skiff.bar()
  const name = buoy.locator('#buoy-name')
  await expect(name).not.toBeEmpty()
  await expect(name).toBeHidden()
  const firstName = await name.textContent()
  const second = (await skiff.rpc('spaces.create', { name: 'Second' })).id
  await skiff.rpc('spaces.activate', { id: second })
  await expect(name).toBeVisible()
  await expect(name).toHaveText('Second')
  const [dot, label] = await buoy.evaluate(() => ['#buoy-dot', '#buoy-name'].map((s) => document.querySelector(s).getBoundingClientRect().x))
  expect(dot).toBeLessThan(label)
  await expect(buoy.locator('#buoy-main')).toHaveAttribute('aria-label', 'Second. Open the command bar')
  await expect(name).toBeHidden({ timeout: 4000 })
  await expect(name).toHaveText('Second')

  await skiff.rpc('spaces.activate', { id: first })
  await expect(name).toBeVisible()
  await expect(name).toHaveText(firstName)
  await expect(name).toBeHidden({ timeout: 4000 })
})

test('with more tabs than fit the last quiet tabs fold into +N, which opens the tab list', async ({ skiff }) => {
  const space = (await skiff.state()).activeSpaceId
  const agentTab = await createTab(skiff, '/one?agent', { agent: 'omp' })
  const { deskSize } = await skiff.state()
  const total = Math.ceil(deskSize.width * 0.6 / 24) + 4
  const ids = []
  for (let i = 0; i < total; i++) ids.push(await createTab(skiff, `/many${i}`))
  const current = ids[5]
  await skiff.rpc('tabs.activate', { id: current })
  const buoy = await skiff.bar()
  const more = buoy.locator('#buoy-more')
  await expect(more).toBeVisible()
  const ordinary = (await skiff.state()).tabs.filter((t) => t.spaceId === space && !t.favorite && !t.pinned).map((t) => t.id)
  const shown = () => buoy.locator('.buoy-tab[data-tab-id]').evaluateAll((els) => els.map((el) => el.dataset.tabId))
  await expect.poll(async () => { const n = Number((await more.textContent()).slice(1)); return (await shown()).length + n }).toBe(ordinary.length)
  const n = Number((await more.textContent()).slice(1))
  expect(n).toBeGreaterThan(0)
  await expect(more).toHaveAttribute('aria-label', `${n} more tabs. Show the tab list`)
  // The agent tab and the current one stay; of the others the first ones stay and the last ones fold.
  const kept = await shown()
  expect(kept).toContain(agentTab)
  expect(kept).toContain(current)
  const rest = ordinary.filter((id) => id !== agentTab && id !== current)
  const restShown = kept.filter((id) => id !== agentTab && id !== current)
  expect(restShown).toEqual(rest.slice(0, restShown.length))
  expect((await buoy.locator('#buoy').evaluate((el) => el.getBoundingClientRect().width))).toBeLessThanOrEqual(deskSize.width * 0.6)

  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect.poll(() => floatOpen(skiff, '/tablist.html')).toBe(true)
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  const list = skiff.app.context().pages().find((page) => page.url().endsWith('/tablist.html') && !page.isClosed())
  await expect(list.locator('#tablist .row')).toHaveCount(ordinary.length)
  await skiff.rpc('ui.emit', { name: 'buoy', data: { action: 'tabs' }, focus: false })
  await expect.poll(() => floatOpen(skiff, '/tablist.html')).toBe(false)
  await expect(more).toHaveAttribute('aria-expanded', 'false')
})

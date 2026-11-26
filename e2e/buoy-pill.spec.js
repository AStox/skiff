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
  // The whole icon carries a ring while the agent acts: an arc that circles it, a steady ring with reduced motion, gone once it is idle.
  const tile = icon(buoy, agentTab)
  const arc = () => tile.evaluate((el) => getComputedStyle(el, '::before').animationName)
  const ringColour = () => tile.evaluate((el) => getComputedStyle(el, '::before').backgroundColor)
  await expect(tile).toHaveClass(/agent-working/)
  await expect.poll(arc).toBe('agent-ring')
  await buoy.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(arc).toBe('none')
  await expect.poll(ringColour).toBe('rgb(122, 90, 248)')
  await buoy.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(ringColour).toBe('rgb(155, 130, 251)')
  await buoy.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
  await skiff.rpc('agent.giveBack', { id: agentTab })
  await expect(tile).not.toHaveClass(/agent-working/)

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

test('a page whose title starts with an unread count marks its icon, favorites included, and a bracketed number elsewhere does not', async ({ skiff }) => {
  const buoy = await skiff.bar()
  const fav = await createTab(skiff, '/one')
  await skiff.rpc('tabs.setFavorite', { id: fav, favorite: true })
  const plain = await createTab(skiff, '/two')
  const favPage = await skiff.page('/one')
  const plainPage = await skiff.page('/two')
  await expect(icon(buoy, fav).locator('.buoy-unread')).toHaveCount(0)

  await favPage.evaluate(() => { document.title = '(3) WhatsApp' })
  await expect(icon(buoy, fav).locator('.buoy-unread')).toBeVisible()
  await expect(icon(buoy, fav)).toHaveAttribute('aria-label', '(3) WhatsApp, 3 unread')
  await plainPage.evaluate(() => { document.title = 'Movie (2024) - IMDb' })
  await expect(icon(buoy, plain)).toHaveAttribute('aria-label', 'Movie (2024) - IMDb')
  await expect(icon(buoy, plain).locator('.buoy-unread')).toHaveCount(0)
  await plainPage.evaluate(() => { document.title = 'Inbox (12) - me@example.com - Gmail' })
  await expect(icon(buoy, plain).locator('.buoy-unread')).toBeVisible()

  await favPage.evaluate(() => { document.title = 'WhatsApp' })
  await expect(icon(buoy, fav).locator('.buoy-unread')).toHaveCount(0)

  const counts = await buoy.evaluate(() => ['(3) WhatsApp', '(12) Messenger', '(9+) Chat', 'Inbox (3) - a@b.c - Gmail', 'Movie (2024)', 'Movie (2024) - IMDb', 'Docs (3) - notes', '(0) Idle', '(2024) Film', '(3)x', ''].map((title) => siteNotice({ title })))
  expect(counts).toEqual(['3', '12', '9+', '3', '', '', '', '', '', '', ''])
  // An icon carries one mark: the agent's dot and the speaker come before the notice.
  const marks = await buoy.evaluate(() => {
    const tab = { id: 'x', url: 'https://example.com', title: '(2) Chat', bucket: 'active' }
    return [dockMark({ ...tab, agent: 'omp', agentState: 'idle' })?.className, dockMark({ ...tab, protections: { audible: true } })?.className, dockMark(tab)?.className]
  })
  expect(marks).toEqual(['agent-dot', 'speaker', 'buoy-unread'])
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

// A favorite whose page is not open: after a restart a favorite hidden from the desk has no page until it is used.
const closedFavorite = async (skiff, path) => {
  const id = await createTab(skiff, path)
  await skiff.rpc('tabs.setFavorite', { id, favorite: true })
  await skiff.rpc('desk.hide', { id })
  await skiff.restart()
  expect((await tabOf(skiff, id)).lifecycle).toBeUndefined()
  return id
}
const dockIds = (buoy) => buoy.locator('.buoy-tab[data-tab-id]').evaluateAll((els) => els.map((el) => el.dataset.tabId))
const active = async (skiff) => (await skiff.state()).activeTabBySpace[(await skiff.state()).activeSpaceId]

test('an agent tab on the host of one favorite rides on its icon: colour, the agent dot and words, a click that brings the agent tab forward until it is seen', async ({ skiff }) => {
  const fav = await closedFavorite(skiff, '/one?fav')
  const other = await createTab(skiff, '/two')
  const buoy = await skiff.bar()
  await expect(icon(buoy, fav)).toHaveClass(/closed/)

  const agentTab = await createTab(skiff, '/one?agent', { agent: 'bb' })
  const site = icon(buoy, fav)
  const dot = site.locator('.agent-dot')
  await expect(dot).toHaveAttribute('data-state', 'working')
  await expect(site).not.toHaveClass(/closed/)
  await expect(site.locator('.favicon')).toHaveCSS('filter', 'none')
  await expect(site).toHaveAttribute('data-agent-tab-id', agentTab)
  await expect(site).toHaveAttribute('aria-label', 'Fixture reading, bb working')
  await expect(site).toHaveAttribute('title', 'Fixture reading, bb working')
  await expect(site.locator('.agent-dot, .speaker, .buoy-unread')).toHaveCount(1)
  await expect(dot).toHaveCSS('background-color', 'rgb(122, 90, 248)')
  await expect(icon(buoy, agentTab)).toHaveCount(0)
  expect(await dockIds(buoy)).toEqual([fav, other])
  expect((await tabOf(skiff, fav)).lifecycle).toBeUndefined()

  await skiff.rpc('tabs.activate', { id: other })
  await expect.poll(() => active(skiff)).toBe(other)
  await expect(site).not.toHaveClass(/current/)
  await site.click()
  await expect.poll(() => active(skiff)).toBe(agentTab)
  await expect(site).toHaveClass(/current/)
  await expect(site).toHaveAttribute('aria-current', 'true')
  expect((await tabOf(skiff, fav)).lifecycle).toBeUndefined()

  // Finished while another tab is in front: done, unseen, and the click still brings the agent's tab.
  await skiff.rpc('tabs.activate', { id: other })
  await skiff.rpc('agent.finish', { tabId: agentTab, agent: 'bb', summary: 'done' })
  await expect(dot).toHaveAttribute('data-state', 'done')
  await expect(dot).toHaveAttribute('data-unseen', '')
  await expect(site).toHaveAttribute('aria-label', 'Fixture reading, bb done')
  await expect(site).not.toHaveClass(/closed/)
  await site.click()
  await expect.poll(() => active(skiff)).toBe(agentTab)
  await expect(dot).not.toHaveAttribute('data-unseen', '')
  expect((await tabOf(skiff, fav)).lifecycle).toBeUndefined()

  // Its tab closed, the favorite goes back to its own look.
  await skiff.rpc('tabs.close', { id: agentTab })
  await expect(site).toHaveClass(/closed/)
  await expect(site.locator('.agent-dot')).toHaveCount(0)
  await expect(site).not.toHaveAttribute('data-agent-tab-id', /.+/)
  await expect(site).toHaveAttribute('aria-label', 'Fixture reading')
})

test('when the agent tab is done and seen a click on the favorite goes to the favorite', async ({ skiff }) => {
  const fav = await closedFavorite(skiff, '/one?fav')
  const other = await createTab(skiff, '/two')
  const agentTab = await createTab(skiff, '/one?agent', { agent: 'bb' })
  const buoy = await skiff.bar()
  const site = icon(buoy, fav)
  await skiff.rpc('agent.finish', { tabId: agentTab, agent: 'bb', summary: 'done' })
  await skiff.rpc('tabs.activate', { id: agentTab })
  await skiff.rpc('tabs.activate', { id: other })
  await expect(site.locator('.agent-dot')).toHaveAttribute('data-state', 'done')
  await expect(site.locator('.agent-dot')).not.toHaveAttribute('data-unseen', '')
  await site.click()
  await expect.poll(() => active(skiff)).toBe(fav)
  await expect.poll(async () => (await tabOf(skiff, fav)).lifecycle).toBe('live')
  await expect(site).toHaveClass(/current/)
})

test('with several agent tabs on one favorite the most urgent one is the mark, the words and the click', async ({ skiff }) => {
  const fav = await closedFavorite(skiff, '/one?fav')
  const other = await createTab(skiff, '/two')
  const finished = await createTab(skiff, '/one?a', { agent: 'omp' })
  const working = await createTab(skiff, '/one?b', { agent: 'bb' })
  await skiff.rpc('tabs.activate', { id: other })
  await skiff.rpc('agent.finish', { tabId: finished, agent: 'omp', summary: 'done' })
  const buoy = await skiff.bar()
  const site = icon(buoy, fav)
  await expect(site).toHaveAttribute('data-agent-tab-id', working)
  await expect(site).toHaveAttribute('aria-label', 'Fixture reading, bb working')
  await expect(site.locator('.agent-dot')).toHaveAttribute('data-state', 'working')
  expect(await dockIds(buoy)).toEqual([fav, other])
  await site.click()
  await expect.poll(() => active(skiff)).toBe(working)

  await skiff.rpc('tabs.close', { id: working })
  await expect(site).toHaveAttribute('data-agent-tab-id', finished)
  await expect(site).toHaveAttribute('aria-label', 'Fixture reading, omp done')
  await expect(site.locator('.agent-dot')).toHaveAttribute('data-unseen', '')
})

test('an agent tab keeps its own icon when two favorites share its host or when its host is another', async ({ skiff }) => {
  const first = await createTab(skiff, '/one?first')
  await skiff.rpc('tabs.setFavorite', { id: first, favorite: true })
  const second = await createTab(skiff, '/two?second')
  await skiff.rpc('tabs.setFavorite', { id: second, favorite: true })
  const agentTab = await createTab(skiff, '/one?agent', { agent: 'bb' })
  const buoy = await skiff.bar()
  await expect(icon(buoy, agentTab).locator('.agent-dot')).toHaveAttribute('data-state', 'working')
  expect(await dockIds(buoy)).toEqual([first, second, agentTab])
  for (const fav of [first, second]) {
    await expect(icon(buoy, fav).locator('.agent-dot')).toHaveCount(0)
    await expect(icon(buoy, fav)).not.toHaveAttribute('data-agent-tab-id', /.+/)
  }

  // Down to one favorite on the host, the agent tab rides on it.
  await skiff.rpc('tabs.setFavorite', { id: second, favorite: false })
  await expect(icon(buoy, first)).toHaveAttribute('data-agent-tab-id', agentTab)
  await expect(icon(buoy, agentTab)).toHaveCount(0)

  // An agent tab on another host is its own icon.
  const far = (await skiff.rpc('tabs.create', { url: `${skiff.origin.replace('127.0.0.1', 'localhost')}/one?far`, agent: 'bb' })).id
  await expect(icon(buoy, far).locator('.agent-dot')).toHaveAttribute('data-state', 'working')
  await expect(icon(buoy, first)).toHaveAttribute('data-agent-tab-id', agentTab)
})

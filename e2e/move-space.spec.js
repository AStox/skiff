'use strict'
const { test, expect } = require('./fixtures')

test.use({ fixtureOptions: { componentConsent: 1 } })

// Opens the page's right-click menu in the main process (its popup is captured, not shown) and clicks the named space.
async function pick(skiff, url, space) {
  return skiff.app.evaluate(async ({ Menu, webContents }, { url, space }) => {
    const wc = webContents.getAllWebContents().find((c) => c.getURL().startsWith(url))
    const popup = Menu.prototype.popup
    let menu
    Menu.prototype.popup = function () { menu = this }
    try { wc.emit('context-menu', {}, {}) } finally { Menu.prototype.popup = popup }
    const parent = menu.items.find((item) => item.label === 'Move to Space')
    const labels = parent?.submenu.items.map((item) => item.label)
    if (space) await parent.submenu.items.find((item) => item.label === space).click()
    return labels
  }, { url, space })
}

const cookies = (skiff, partition) => skiff.app.evaluate(({ session }, partition) => session.fromPartition(partition).cookies.get({}).then((list) => list.map((c) => `${c.name}=${c.value}`).sort()), partition)

async function twoProfiles(skiff) {
  const main = (await skiff.state()).spaces[0]
  const profile = await skiff.rpc('profiles.create', { name: 'Dev' })
  const dev = await skiff.rpc('spaces.create', { name: 'Dev', color: '#2f9e5b' })
  await skiff.rpc('profiles.assign', { spaceId: dev.id, profileId: profile.id })
  const state = await skiff.state()
  return [state.spaces.find((s) => s.id === main.id), state.spaces.find((s) => s.id === dev.id)]
}

test('Move to Space and tabs.move rehome a tab into the destination profile and reload it there', async ({ skiff }) => {
  const [home, dev] = await twoProfiles(skiff)
  expect(home.sessionPartition).not.toBe(dev.sessionPartition)
  await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/b`, spaceId: dev.id })
  const devPage = await skiff.page('/agent/b')
  await devPage.evaluate(() => { document.cookie = 'who=dev; Path=/' })
  const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/a`, spaceId: home.id })
  const page = await skiff.page('/agent/a')
  await page.evaluate(() => { document.cookie = 'who=home; Path=/' })
  await expect.poll(() => cookies(skiff, home.sessionPartition)).toEqual(['who=home'])
  expect(await cookies(skiff, dev.sessionPartition)).toEqual(['who=dev'])

  // The context-menu path
  expect(await pick(skiff, `${skiff.origin}/agent/a`, 'Dev')).toEqual(['Dev'])
  await expect.poll(async () => { const s = await skiff.state(); return [s.activeSpaceId, s.activeTabBySpace[dev.id], s.tabs.find((t) => t.id === tab.id).sessionPartition] }).toEqual([dev.id, tab.id, dev.sessionPartition])
  await expect.poll(async () => (await skiff.page('/agent/a')).locator('#cookie').textContent()).toBe('cookie: who=dev')

  // The command path, back again; a same-profile move keeps the live page
  await skiff.rpc('tabs.move', { id: tab.id, spaceId: home.id })
  await skiff.rpc('tabs.activate', { id: tab.id })
  await expect.poll(async () => (await skiff.page('/agent/a')).locator('#cookie').textContent()).toBe('cookie: who=home')
  const same = await skiff.rpc('spaces.create', { name: 'Same profile', color: '#7c5ce0' })
  const live = await (await skiff.page('/agent/a')).evaluate(() => { window.marker = 1; return true })
  await skiff.rpc('tabs.move', { id: tab.id, spaceId: same.id })
  expect(live).toBe(true)
  expect(await (await skiff.page('/agent/a')).evaluate(() => window.marker)).toBe(1)
})

test('moving a link peek to a space makes it a tab there, in that space\'s session', async ({ skiff }) => {
  const [home, dev] = await twoProfiles(skiff)
  await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/b`, spaceId: dev.id })
  await (await skiff.page('/agent/b')).evaluate(() => { document.cookie = 'who=dev; Path=/' })
  await skiff.rpc('spaces.activate', { id: home.id })
  const source = await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/a`, spaceId: home.id })
  const open = async (name) => {
    const peek = await skiff.rpc('peek.open', { url: `${skiff.origin}/agent/${name}`, sourceId: source.id })
    await skiff.page(`/agent/${name}`)
    return peek
  }
  const first = await open('own')
  expect((await skiff.state()).userPeek).toBe(first.id)
  expect(await pick(skiff, `${skiff.origin}/agent/own`, home.name)).toEqual([home.name, 'Dev'])
  await expect.poll(async () => { const s = await skiff.state(); const t = s.tabs.find((x) => x.id === first.id); return [s.userPeek, t.userPeek, t.spaceId, s.activeTabBySpace[home.id]] }).toEqual([null, undefined, home.id, first.id])

  const second = await open('away')
  await pick(skiff, `${skiff.origin}/agent/away`, 'Dev')
  await expect.poll(async () => { const s = await skiff.state(); const t = s.tabs.find((x) => x.id === second.id); return [s.userPeek, t.userPeek, t.spaceId, t.sessionPartition, s.activeSpaceId, s.activeTabBySpace[dev.id]] }).toEqual([null, undefined, dev.id, dev.sessionPartition, dev.id, second.id])
  await expect.poll(async () => (await skiff.page('/agent/away')).locator('#cookie').textContent()).toBe('cookie: who=dev')
})

test('Move to Space works from a desk window in Layer', async ({ skiff }) => {
  const [home, dev] = await twoProfiles(skiff)
  const old = skiff.shell
  const closed = old.waitForEvent('close')
  await old.evaluate(() => { window.skiff.call('ui.setShell', { name: 'layer' }) })
  await closed
  await expect.poll(() => !skiff.shell.isClosed()).toBe(true)
  const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/a`, spaceId: home.id })
  await (await skiff.page('/agent/a')).evaluate(() => { document.cookie = 'who=home; Path=/' })
  await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/b`, spaceId: dev.id, activate: false })
  await (await skiff.page('/agent/b')).evaluate(() => { document.cookie = 'who=dev; Path=/' })
  await skiff.rpc('tabs.activate', { id: tab.id })
  await pick(skiff, `${skiff.origin}/agent/a`, 'Dev')
  await expect.poll(async () => { const s = await skiff.state(); return [s.activeSpaceId, s.activeTabBySpace[dev.id]] }).toEqual([dev.id, tab.id])
  await expect.poll(async () => (await skiff.page('/agent/a')).locator('#cookie').textContent()).toBe('cookie: who=dev')
})

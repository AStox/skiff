'use strict'
const { test, expect } = require('./fixtures')
const fs = require('node:fs')
const path = require('node:path')
const S = require('../src/state')
const { createSync } = require('../src/sync')

async function openSync(skiff) {
  await skiff.shell.getByRole('button', { name: 'Tools', exact: true }).click()
  const matches = (page) => !page.isClosed() && page.url().split('?')[0].endsWith('/browser-tools/index.html')
  await expect.poll(() => skiff.app.context().pages().some(matches)).toBe(true)
  const panel = skiff.app.context().pages().find(matches)
  await panel.getByRole('button', { name: 'Sync', exact: true }).click()
  await expect(panel.locator('#content h2').first()).toHaveText('Sync')
  await expect(panel.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible()
  return panel
}

async function syncFromUI(skiff, panel) {
  const previous = (await skiff.rpc('sync.status')).lastSync
  await panel.getByRole('button', { name: 'Sync now', exact: true }).click()
  await expect.poll(async () => {
    const status = await skiff.rpc('sync.status')
    if (status.error) throw new Error(status.error)
    return !status.busy && Boolean(status.lastSync) && status.lastSync !== previous
  }).toBe(true)
  await expect(panel.locator('#error')).toBeEmpty()
  await expect(panel.locator('#content')).toContainText('Last sync')
}

async function incomingPage(skiff, url) {
  const matches = (page) => !page.isClosed() && page.url() === url
  await expect.poll(() => skiff.app.context().pages().some(matches)).toBe(true)
  const page = skiff.app.context().pages().find(matches)
  await expect(page.getByRole('heading', { name: 'Incoming synced document' })).toBeVisible()
  await expect.poll(() => skiff.app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows().some((window) => window.contentView.children.some((view) => {
    const bounds = view.getBounds()
    return view.webContents?.getURL() === target && bounds.width > 0 && bounds.height > 0
  })), url)).toBe(true)
  return page
}

// Pairing material stays in Node memory: never reveal it in the renderer, a trace,
// an assertion, or an attachment. The existing key-export spec covers its reveal UI.
// The normal fixture cancels nonloopback URLs before CDP can fulfill the portable
// .test document. Its existing proxy-isolation mode keeps the outside network
// blocked without preempting Playwright's synthetic document response.
test.use({ fixtureOptions: { extensions: true }, trace: 'off', video: 'off' })
test('Sync UI pairs a real folder peer, opens incoming native content, and preserves archive restoration', async ({ skiff }, testInfo) => {
  test.setTimeout(120000)
  const shared = path.join(skiff.root, 'encrypted-sync-share')
  const peerDir = path.join(skiff.root, 'isolated-sync-peer')
  const url = 'https://sync.skiff.test/incoming'
  // Only the document is synthetic. Both sync instances use the actual encrypted
  // filesystem transport; no sync commands, encryption, or persistence are mocked.
  await skiff.app.context().route(url, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="en"><head><title>Incoming synced document</title></head><body><h1>Incoming synced document</h1><p>This tab arrived from the isolated encrypted sync peer.</p><label>Live document input <input></label></body></html>'
  }))

  let peer
  try {
    let panel = await openSync(skiff)
    await expect(panel.locator('#content')).toContainText('Sync is off')
    await panel.getByRole('combobox', { name: 'Transport', exact: true }).selectOption('folder')
    await panel.getByLabel('Shared directory', { exact: true }).fill(shared)
    await panel.getByRole('button', { name: 'Enable sync', exact: true }).click()
    await expect(panel.locator('#confirm')).toBeVisible()
    await panel.locator('#confirm-accept').click()
    await expect(panel.locator('#content')).toContainText('Sync is on')
    await expect(panel.locator('#error')).toBeEmpty()
    await panel.getByRole('button', { name: 'Create key', exact: true }).click()
    await panel.locator('#confirm-accept').click()
    await expect(panel.locator('#content')).toContainText('Unlocked')
    await syncFromUI(skiff, panel)

    const browser = await skiff.state()
    const home = browser.spaces.find((space) => space.id === browser.activeSpaceId)
    const peerState = S.load({ spaces: [{ ...home }], activeSpaceId: home.id })
    peer = createSync({ dir: peerDir, state: () => peerState })
    peer.start()
    peer.configure({ transport: 'folder', directory: shared })
    // Deliberate owner-only export for pairing the synthetic peer, outside renderer
    // automation so Playwright cannot record the key as an action argument/result.
    const pairing = await skiff.http('sync.key.export')
    if (!pairing.ok) throw new Error('Unable to pair the isolated sync peer')
    peer.importKey(pairing.result)
    pairing.result.key = ''
    await peer.now()
    const profile = S.createProfile(peerState, { name: 'Isolated peer profile' })
    S.assignProfile(peerState, { spaceId: home.id, profileId: profile.id })
    const incoming = S.createTab(peerState, { spaceId: home.id, url }, Date.now())
    incoming.title = 'Incoming synced document'
    await peer.now()

    await syncFromUI(skiff, panel)
    await expect.poll(async () => (await skiff.state()).tabs.some((tab) => tab.id === incoming.id)).toBe(true)
    const received = (await skiff.state()).tabs.find((tab) => tab.id === incoming.id)
    expect(received.sessionPartition).not.toBe(incoming.sessionPartition)
    expect(received.profileId).toBe(profile.id)
    expect(fs.readdirSync(shared).filter((file) => file.endsWith('.skiff-sync'))).toHaveLength(2)
    expect(await panel.getByLabel('Encryption key', { exact: true }).evaluate((input) => input.value === '')).toBe(true)
    await testInfo.attach('Encrypted folder sync configured in the real tools UI', {
      body: await panel.screenshot({ mask: [panel.locator('input[data-secret]')] }),
      contentType: 'image/png'
    })
    await panel.getByRole('button', { name: 'Close', exact: true }).click()

    const row = () => skiff.shell.locator(`#list [data-tab-id="${incoming.id}"]`)
    await expect(row()).toBeVisible()
    await row().locator('.row-main').click()
    const page = await incomingPage(skiff, url)
    await page.getByRole('textbox', { name: 'Live document input' }).fill('A real live native view')
    await expect(page.getByRole('textbox', { name: 'Live document input' })).toHaveValue('A real live native view')

    await row().hover()
    await row().getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect.poll(async () => (await skiff.state()).archive.some((tab) => tab.id === incoming.id)).toBe(true)
    await expect(row()).toHaveCount(0)
    panel = await openSync(skiff)
    await syncFromUI(skiff, panel)
    await peer.now()
    expect(peerState.tabs.some((tab) => tab.id === incoming.id)).toBe(false)
    expect(peerState.archive.find((tab) => tab.id === incoming.id).sessionPartition).toBe(incoming.sessionPartition)
    await panel.getByRole('button', { name: 'Close', exact: true }).click()

    await skiff.shell.getByRole('button', { name: 'Archive', exact: true }).click()
    await skiff.shell.locator('#list .row-main').filter({ hasText: 'Incoming synced document' }).click()
    await expect(row()).toBeVisible()
    await incomingPage(skiff, url)
    await expect.poll(async () => (await skiff.state()).archive.some((tab) => tab.id === incoming.id)).toBe(false)
    panel = await openSync(skiff)
    await syncFromUI(skiff, panel)
    await peer.now()
    await syncFromUI(skiff, panel)
    expect(peerState.tabs.find((tab) => tab.id === incoming.id).sessionPartition).toBe(incoming.sessionPartition)
    expect(peerState.archive.some((tab) => tab.id === incoming.id)).toBe(false)
    const restored = (await skiff.state()).tabs.find((tab) => tab.id === incoming.id)
    expect(restored.sessionPartition).toBe(received.sessionPartition)
    expect(restored.profileId).toBe(profile.id)
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(row()).toBeVisible()
    await incomingPage(skiff, url)
  } finally {
    peer?.stop()
    await skiff.app.context().unroute(url)
  }
})

'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { test, expect } = require('./fixtures')

test.use({ fixtureOptions: { extensions: true } })

const fixture = path.join(__dirname, 'extension')
const expected = { name: 'Skiff test extension', version: '1.0', popup: 'popup.html', options: 'options.html', builtin: false, state: 'ready', error: '' }

const list = (skiff) => skiff.rpc('extensions.list')
const callCode = (skiff, method, params) => skiff.shell.evaluate(({ method, params }) => window.skiff.call(method, params).then(() => 'ok', (error) => error.code), { method, params })
const dataset = (page) => page.evaluate(() => ({ ...document.documentElement.dataset }))
const activeTab = async (skiff) => { const state = await skiff.state(); return state.tabs.find((tab) => tab.id === state.activeTabBySpace[state.activeSpaceId]) }
const contentsId = (skiff, url) => skiff.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.id, url)
// Playwright lists every webContents, extension pages included; the popup carries a tabId query.
const pageMatching = async (skiff, pattern) => {
  await expect.poll(() => skiff.app.context().pages().some((page) => pattern.test(page.url()))).toBe(true)
  return skiff.app.context().pages().find((page) => pattern.test(page.url()))
}
// Tab events only reach listeners once the background page is up; adding resolves before that.
const backgroundReady = (skiff) => expect.poll(() => skiff.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().endsWith('/bg.html') && !wc.isLoading()))).toBe(true)

async function openFixture(skiff, query) {
  await skiff.rpc('tabs.create', { url: `${skiff.origin}/ext/page?${query}` })
  const page = await skiff.page(`/ext/page?${query}`)
  await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete')
  return page
}

test('an unpacked extension blocks, redirects, injects, reports tabs, shows its popup and options, survives a restart and leaves cleanly', async ({ skiff }) => {
  const folder = path.join(skiff.data, 'extensions')
  let id

  await test.step('add', async () => {
    expect(await list(skiff)).toEqual([])
    const entry = await skiff.rpc('extensions.add', { path: fixture })
    expect(entry).toMatchObject(expected)
    expect(path.dirname(entry.path)).toBe(folder)
    expect(fs.existsSync(path.join(entry.path, 'manifest.json'))).toBe(true)
    expect(await list(skiff)).toEqual([entry])
    id = entry.id
    await backgroundReady(skiff)
  })

  let pageUrl
  await test.step('a page under the extension', async () => {
    const page = await openFixture(skiff, 'first')
    pageUrl = page.url()
    await expect.poll(() => dataset(page)).toMatchObject({ cs: 'ran', ok: 'ran', blocked: 'error', redirect: 'stub', frameId: '0' })
    const data = await dataset(page)
    expect(data.unexpected).toBeUndefined()
    expect(data.tabId).toBe(String(await contentsId(skiff, pageUrl)))
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('hide-me')).display)).toBe('none')
    const inFrame = (candidate) => candidate.url().endsWith('/ext/frame')
    await expect.poll(() => page.frames().some(inFrame)).toBe(true)
    const frame = page.frames().find(inFrame)
    await expect.poll(() => frame.evaluate(() => ({ ...document.documentElement.dataset }))).toMatchObject({ cs: 'ran', frameId: expect.stringMatching(/^[1-9]\d*$/) })
  })

  await test.step('popup', async () => {
    expect(await skiff.rpc('extensions.closePopup')).toBeNull()
    expect(await skiff.rpc('extensions.popup', { id, bounds: { x: 300, y: 20, width: 400, height: 500 } })).toMatchObject(expected)
    const popup = await pageMatching(skiff, /\/popup\.html(\?|$)/)
    await expect(popup.locator('#events')).toContainText('"what":"committed"')
    await expect(popup.locator('#events')).toContainText(pageUrl)
    await expect(popup.locator('#events')).toContainText('"what":"activated"')
    await expect(popup.locator('#active')).toContainText('/ext/page')
    const bounds = await skiff.onDesk((win) => win.contentView.children.find((view) => /\/popup\.html/.test(view.webContents?.getURL() || '')).getBounds())
    expect(bounds.x).toBe(300)
    expect(bounds.y).toBe(20)
    expect(bounds.width).toBeLessThanOrEqual(400)
    expect(bounds.width).toBeGreaterThanOrEqual(150)
    expect(bounds.height).toBeLessThanOrEqual(500)
    await popup.locator('#open-options').click()
    await expect.poll(async () => (await activeTab(skiff))?.url).toBe(`chrome-extension://${id}/options.html`)
    await expect((await pageMatching(skiff, /\/options\.html$/)).locator('#options-title')).toBeVisible()
  })

  await test.step('options from the command', async () => {
    await skiff.rpc('tabs.create', { url: skiff.origin + '/second' })
    await expect.poll(async () => (await activeTab(skiff))?.url).toBe(skiff.origin + '/second')
    await skiff.rpc('extensions.open', { id })
    await expect.poll(async () => (await activeTab(skiff))?.url).toBe(`chrome-extension://${id}/options.html`)
    await expect((await pageMatching(skiff, /\/options\.html$/)).locator('#options-title')).toBeVisible()
  })

  await test.step('restart', async () => {
    await skiff.restart()
    expect(await list(skiff)).toEqual([expect.objectContaining(expected)])
    await backgroundReady(skiff)
    const page = await openFixture(skiff, 'again')
    await expect.poll(() => dataset(page)).toMatchObject({ cs: 'ran', blocked: 'error', redirect: 'stub' })
    expect((await dataset(page)).unexpected).toBeUndefined()
  })

  await test.step('remove', async () => {
    expect(await skiff.rpc('extensions.remove', { id })).toBeNull()
    expect(await list(skiff)).toEqual([])
    expect(fs.existsSync(folder) ? fs.readdirSync(folder) : []).toEqual([])
    const page = await openFixture(skiff, 'removed')
    await expect.poll(() => dataset(page)).toMatchObject({ ok: 'ran', blocked: 'loaded', unexpected: 'served' })
    expect((await dataset(page)).cs).toBeUndefined()
  })
})

test('extension commands reject bad input with the usual codes', async ({ skiff }) => {
  expect(await callCode(skiff, 'extensions.add', { path: path.join(skiff.root, 'missing') })).toBe('not_found')
  expect(await callCode(skiff, 'extensions.add', { path: skiff.home })).toBe('bad_params')
  expect(await callCode(skiff, 'extensions.open', { id: 'nope' })).toBe('not_found')
  expect(await callCode(skiff, 'extensions.remove', { id: 'nope' })).toBe('not_found')
  expect(await list(skiff)).toEqual([])
})

test.describe('built in', () => {
  test.use({ fixtureOptions: { extensions: true, builtin: true } })

  const BUILTIN = 'Skiff test extension'
  const entryOf = async (skiff) => (await list(skiff)).find((entry) => entry.name === BUILTIN)
  const isPopup = (page) => /\/popup\.html(\?|$)/.test(page.url())
  // The popup is reloaded for every read: its install count comes from the background page's storage.
  async function installsOf(skiff, id) {
    await skiff.rpc('extensions.closePopup')
    await expect.poll(() => skiff.app.context().pages().some(isPopup)).toBe(false)
    await skiff.rpc('extensions.popup', { id, bounds: { x: 300, y: 20, width: 400, height: 500 } })
    return (await pageMatching(skiff, /\/popup\.html(\?|$)/)).locator('#installs')
  }
  async function blockedPage(skiff, query) {
    await backgroundReady(skiff)
    const page = await openFixture(skiff, query)
    await expect.poll(() => dataset(page)).toMatchObject({ cs: 'ran', blocked: 'error' })
    expect((await dataset(page)).unexpected).toBeUndefined()
  }

  test('the built-in extension is installed at first launch, updated in place with its storage, and present at the next start without a check', async ({ skiff }) => {
    let id

    await test.step('installed at launch', async () => {
      await expect.poll(() => entryOf(skiff)).toMatchObject({ builtin: true, state: 'ready', version: '1.0', error: '', id: expect.stringMatching(/./) })
      const entry = await entryOf(skiff)
      id = entry.id
      expect(path.dirname(entry.path)).toBe(path.join(skiff.data, 'extensions'))
      expect(await list(skiff)).toEqual([entry])
      await blockedPage(skiff, 'builtin')
      await expect(await installsOf(skiff, id)).toHaveText('1')
      expect(await callCode(skiff, 'extensions.remove', { id })).toBe('bad_params')
    })

    await test.step('updated in place', async () => {
      skiff.release.version = '2.0'
      const updated = (await skiff.rpc('extensions.update')).find((entry) => entry.name === BUILTIN)
      expect(updated).toMatchObject({ id, version: '2.0', state: 'ready', error: '' })
      expect(await entryOf(skiff)).toEqual(updated)
      await blockedPage(skiff, 'updated')
      await expect(await installsOf(skiff, id)).toHaveText('2')
    })

    await test.step('a check that finds nothing newer leaves it alone', async () => {
      const same = (await skiff.rpc('extensions.update')).find((entry) => entry.name === BUILTIN)
      expect(same).toMatchObject({ id, version: '2.0', state: 'ready', error: '' })
      await expect(await installsOf(skiff, id)).toHaveText('2')
    })

    await test.step('a failed check keeps the installed copy', async () => {
      skiff.release.version = null
      const failed = (await skiff.rpc('extensions.update')).find((entry) => entry.name === BUILTIN)
      expect(failed).toMatchObject({ id, version: '2.0', state: 'failed', error: expect.stringMatching(/./) })
      expect(await entryOf(skiff)).toEqual(failed)
      await blockedPage(skiff, 'failed')
    })

    await test.step('restart', async () => {
      await skiff.restart()
      await expect.poll(() => entryOf(skiff)).toMatchObject({ id, version: '2.0', state: 'ready', error: '' })
      await blockedPage(skiff, 'restarted')
    })
  })

  const requested = (skiff, query) => skiff.requests.some((url) => url.includes(query))
  const killBackground = (skiff) => skiff.app.evaluate(({ webContents }) => {
    process.kill(webContents.getAllWebContents().find((wc) => wc.getType() === 'backgroundPage').getOSProcessId(), 'SIGKILL')
  })
  const stateOf = async (skiff) => (await entryOf(skiff))?.state
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  test('page loads wait until the built-in is ready; a killed background page is reloaded by itself and no open tab reloads', async ({ skiff }) => {
    await expect.poll(() => stateOf(skiff)).toBe('ready')
    const { id, path: folder } = await entryOf(skiff)
    await blockedPage(skiff, 'first')
    await expect(await installsOf(skiff, id)).toHaveText('1')
    // The extension now waits 4s before it says it listens for navigations: the window to watch the gate in.
    fs.writeFileSync(path.join(folder, 'hold.json'), '{"ms": 4000}')

    await test.step('a killed background page', async () => {
      const open = await skiff.page('/ext/page?first')
      const origin = await open.evaluate(() => performance.timeOrigin)
      await killBackground(skiff)
      await expect.poll(() => stateOf(skiff)).toBe('restarting')
      await skiff.rpc('tabs.create', { url: `${skiff.origin}/ext/page?crash` })
      await pause(1500)
      expect(requested(skiff, 'crash')).toBe(false)
      await expect.poll(() => stateOf(skiff), { timeout: 15000 }).toBe('ready')
      await expect.poll(() => requested(skiff, 'crash')).toBe(true)
      const page = await skiff.page('/ext/page?crash')
      await expect.poll(() => dataset(page)).toMatchObject({ cs: 'ran', blocked: 'error' })
      expect(await open.evaluate(() => performance.timeOrigin)).toBe(origin)
      expect(await entryOf(skiff)).toMatchObject({ id, version: '1.0', error: '' })
      await expect(await installsOf(skiff, id)).toHaveText('2')
    })

    await test.step('startup', async () => {
      await skiff.restart()
      await skiff.rpc('tabs.create', { url: `${skiff.origin}/ext/page?start` })
      await pause(1500)
      expect(requested(skiff, 'start')).toBe(false)
      await expect.poll(() => requested(skiff, 'start'), { timeout: 15000 }).toBe(true)
      const page = await skiff.page('/ext/page?start')
      await expect.poll(() => dataset(page)).toMatchObject({ cs: 'ran', blocked: 'error' })
      expect(await stateOf(skiff)).toBe('ready')
    })
  })

  test('incognito runs the built-in extension and keeps nothing a site stored there after closing it or a restart', async ({ skiff }) => {
    await expect.poll(() => stateOf(skiff)).toBe('ready')
    const { id } = await entryOf(skiff)
    const stored = (page) => page.evaluate(async () => ({ cookie: document.cookie, local: localStorage.getItem('secret'), databases: (await indexedDB.databases()).map((d) => d.name) }))
    const plant = (page) => page.evaluate(() => new Promise((resolve, reject) => {
      document.cookie = 'secret=1; path=/'
      localStorage.setItem('secret', '1')
      const request = indexedDB.open('secret-db', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('s')
      request.onsuccess = () => { request.result.close(); resolve() }
      request.onerror = () => reject(request.error)
    }))
    async function incognitoPage(query) {
      const space = await skiff.rpc('incognito.open')
      await skiff.rpc('tabs.create', { url: `${skiff.origin}/ext/page?${query}`, spaceId: space.id })
      const page = await skiff.page(`/ext/page?${query}`)
      await expect.poll(() => dataset(page)).toMatchObject({ cs: 'ran', blocked: 'error' })
      return { space, page }
    }
    const empty = { cookie: '', local: null, databases: [] }

    const first = await incognitoPage('private-one')
    expect((await dataset(first.page)).unexpected).toBeUndefined()
    expect(await stored(first.page)).toEqual(empty)
    await plant(first.page)
    expect(await stored(first.page)).toEqual({ cookie: 'secret=1', local: '1', databases: ['secret-db'] })
    await expect(await installsOf(skiff, id)).toHaveText('1')

    await test.step('closing the space wipes the site data and leaves the extension alone', async () => {
      await skiff.rpc('spaces.remove', { id: first.space.id })
      expect(await skiff.app.evaluate(({ session }) => session.fromPartition('persist:incognito').cookies.get({}))).toEqual([])
      const again = await incognitoPage('private-two')
      expect(await stored(again.page)).toEqual(empty)
      await plant(again.page)
    })

    await test.step('a restart wipes what a missing close left, and the extension keeps its own storage', async () => {
      await skiff.restart()
      const after = await incognitoPage('private-three')
      expect(await stored(after.page)).toEqual(empty)
      await expect(await installsOf(skiff, id)).toHaveText('2')
    })
  })
})

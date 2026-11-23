'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { test, expect, barReady } = require('./fixtures')

const shellsDir = path.join(__dirname, '..', 'shells')
const shells = fs.existsSync(shellsDir) ? fs.readdirSync(shellsDir).filter((name) => fs.existsSync(path.join(shellsDir, name, 'index.html'))) : []
// A desk shell has no page box; e2e/desk.spec.js covers its window.
const isDesk = (name) => { try { return JSON.parse(fs.readFileSync(path.join(shellsDir, name, 'shell.json'), 'utf8')).window === 'desk' } catch { return false } }

async function switchShell(skiff, name) {
  const reloaded = skiff.shell.waitForEvent('load')
  await skiff.rpc('ui.setShell', { name })
  await reloaded
}

const overlayUrls = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((view) => view.webContents?.getURL() || '').filter((url) => url.endsWith('.html')))
// Overlay pages are their own webContents; the window page never holds them.
async function overlayPage(skiff, file) {
  await expect.poll(() => skiff.app.context().pages().some((page) => page.url().endsWith('/' + file))).toBe(true)
  return skiff.app.context().pages().find((page) => page.url().endsWith('/' + file))
}

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test.use({ fixtureOptions: { theme } })
    for (const name of shells.filter((name) => !isDesk(name))) {
      test(`the ${name} shell places the page and opens the command bar`, async ({ skiff }, testInfo) => {
        const errors = []
        skiff.shell.on('pageerror', (error) => errors.push(error.message))
        await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
        await skiff.page('/one')
        await switchShell(skiff, name)
        await skiff.shell.emulateMedia({ colorScheme: theme })
        expect((await skiff.state()).settings.shell).toBe(name)
        // The new shell must tell the core where the page goes; the native view then sits on its #page box, at most a 1px frame inside it.
        await expect.poll(async () => {
          const box = await skiff.shell.locator('#page').boundingBox()
          const view = await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith('http'))?.getBounds())
          if (!box || !view) return false
          const edges = [view.x - box.x, view.y - box.y, box.x + box.width - view.x - view.width, box.y + box.height - view.y - view.height]
          return edges.every((gap) => gap >= -0.5 && gap <= 1.5)
        }).toBe(true)
        await testInfo.attach(`${name}-${theme}`, { body: await skiff.shell.screenshot(), contentType: 'image/png' })
        await skiff.shortcut('CmdOrCtrl+T')
        const bar = await barReady(skiff)
        await bar.keyboard.type('exa')
        await expect(bar.locator('#palette-results li').first()).toBeVisible()
        await testInfo.attach(`${name}-${theme}-bar`, { body: await skiff.shell.screenshot(), contentType: 'image/png' })
        await bar.keyboard.press('Escape')
        await expect.poll(() => skiff.barOpen()).toBe(false)
        expect(errors).toEqual([])
      })
    }
  })
}

test('switching shells from Settings closes old overlays and survives a restart', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
  await skiff.page('/one')
  expect((await skiff.state()).shells).toEqual(['default', ...shells.sort()])
  await switchShell(skiff, 'quiet')
  // The quiet shell rests on a pill overlay over the page and opens its sidebar as another; a switch while it is up must drop that overlay with the shell.
  await expect.poll(() => overlayUrls(skiff)).toEqual([expect.stringMatching(/\/pill\.html$/)])
  const pillView = await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().endsWith('/pill.html')).getBounds())
  const [width, height] = await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  expect(pillView.y + pillView.height).toBe(height)
  expect(pillView.x).toBe(0)
  expect(pillView.width).toBeLessThan(width / 2)
  await (await overlayPage(skiff, 'pill.html')).locator('#pill').click()
  await expect.poll(() => overlayUrls(skiff)).toEqual([expect.stringMatching(/\/panel\.html$/)])
  await switchShell(skiff, 'default')
  await expect.poll(() => overlayUrls(skiff)).toEqual([])
  await skiff.shell.locator('#settings-toggle').click()
  const picker = skiff.shell.locator('#shell')
  await expect(picker).toHaveValue('default')
  const reloaded = skiff.shell.waitForEvent('load')
  await picker.selectOption('ledger')
  await reloaded
  // The ledger shell names each space in its strip; the default shell shows a letter.
  await expect(skiff.shell.locator('#dots .dot').first()).toHaveText(/^home$/i)
  await skiff.restart()
  expect((await skiff.state()).settings.shell).toBe('ledger')
  await expect(skiff.shell.locator('#dots .dot').first()).toHaveText(/^home$/i)
  // The menu is the way back when a shell's own settings are unreachable.
  const menuItems = () => skiff.app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === 'Shell').submenu.items.map((item) => [item.label, item.checked]))
  expect(await menuItems()).toEqual(['default', ...shells].map((name) => [name, name === 'ledger']))
  const reloadedByMenu = skiff.shell.waitForEvent('load')
  await skiff.app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === 'Shell').submenu.items.find((item) => item.label === 'lacquer').click())
  await reloadedByMenu
  expect((await skiff.state()).settings.shell).toBe('lacquer')
  expect((await menuItems()).find(([name]) => name === 'lacquer')[1]).toBe(true)
  expect(await skiff.shell.evaluate(() => window.skiff.call('ui.setShell', { name: 'nope' }).then(() => 'ok', (error) => error.message))).toMatch(/No shell named nope/)
})

test('the quiet shell keeps its pill over the page, follows a resize and hands the keyboard back', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
  const page = await skiff.page('/one')
  await switchShell(skiff, 'quiet')
  const pillBounds = () => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().endsWith('/pill.html'))?.getBounds())
  const pill = await overlayPage(skiff, 'pill.html')
  await expect(pill.locator('#pill-count')).toHaveText('1 tab')
  // The overlay rectangle is only as wide as the pill, so the page keeps the rest of its bottom edge.
  await expect.poll(async () => (await pillBounds())?.width).toBeLessThan(200)
  await skiff.resize(1000, 700)
  await expect.poll(async () => { const b = await pillBounds(); return b && [b.x, b.y + b.height] }).toEqual([0, 700])
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
  await pill.locator('#pill').click()
  const panel = await overlayPage(skiff, 'panel.html')
  await expect(panel.locator('#sidebar')).toBeVisible()
  await panel.keyboard.press('Escape')
  await expect.poll(() => overlayUrls(skiff)).toEqual([expect.stringMatching(/\/pill\.html$/)])
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
  await skiff.shortcut('CmdOrCtrl+Shift+C')
  await expect((await overlayPage(skiff, 'pill.html')).locator('#pill-count')).toHaveText('Copied URL')
  await expect((await overlayPage(skiff, 'pill.html')).locator('#pill-count')).toHaveText('1 tab', { timeout: 4000 })
  await skiff.rpc('tabs.create', { url: skiff.origin + '/two' })
  await expect((await overlayPage(skiff, 'pill.html')).locator('#pill-count')).toHaveText('2 tabs')
})

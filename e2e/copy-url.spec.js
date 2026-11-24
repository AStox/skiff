'use strict'
const { test, expect } = require('./fixtures')

test('Cmd+Shift+C copies the page address and confirms it', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/copy' })
  await skiff.page('/copy')
  const notice = (await skiff.bar()).locator('#buoy-notice')
  await skiff.app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await skiff.shortcut('CmdOrCtrl+Shift+C')
  await expect.poll(() => skiff.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(skiff.origin + '/copy')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveText('Copied URL')
  await expect(notice).toBeHidden({ timeout: 4000 })
})

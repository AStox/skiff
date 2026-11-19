'use strict'
const { test, expect } = require('./fixtures')

test('Cmd+Shift+C copies the page address and confirms it', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/copy' })
  await skiff.page('/copy')
  await skiff.app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await skiff.shortcut('CmdOrCtrl+Shift+C')
  await expect.poll(() => skiff.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(skiff.origin + '/copy')
  await expect(skiff.shell.locator('#toast')).toBeVisible()
  await expect(skiff.shell.locator('#toast')).toHaveText('Copied URL')
  await expect(skiff.shell.locator('#toast')).toBeHidden({ timeout: 4000 })
})

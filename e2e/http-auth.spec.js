'use strict'
const { test, expect } = require('./fixtures')

const dialogs = (skiff) => skiff.app.context().pages().filter((page) => page.url().includes('http-auth.html') && !page.isClosed())
const dialog = async (skiff) => {
  await expect.poll(() => dialogs(skiff).length).toBe(1)
  const page = dialogs(skiff)[0]
  await page.locator('#user').waitFor()
  return page
}
const content = async (skiff, origin) => {
  const at = (page) => page.url().startsWith(origin) && !page.isClosed()
  await expect.poll(() => skiff.app.context().pages().filter(at).length).toBeGreaterThan(0)
  return skiff.app.context().pages().find(at)
}

test('a basic-auth challenge asks for credentials and loads the page with them', async ({ skiff }) => {
  const origin = skiff.origin
  await skiff.rpc('tabs.create', { url: origin + '/basic-auth' })
  const prompt = await dialog(skiff)
  await expect(prompt.locator('#title')).toHaveText(origin.replace('http://', '') + ' is asking you to sign in')
  await expect(prompt.locator('#detail')).toHaveText('Realm: Test')
  await expect(prompt.locator('#user')).toBeFocused()
  await prompt.fill('#user', 'ada')
  await prompt.fill('#pass', 'lovelace')
  await prompt.keyboard.press('Enter').catch(() => {})
  await expect.poll(() => dialogs(skiff).length).toBe(0)
  await expect((await content(skiff, origin + '/basic-auth')).locator('#ok')).toHaveText('Welcome Ada')
})

test('Cancel and Escape leave the 401 page, and wrong credentials ask again', async ({ skiff }) => {
  const url = skiff.origin + '/basic-auth'
  await skiff.rpc('tabs.create', { url })
  let prompt = await dialog(skiff)
  await prompt.fill('#user', 'ada')
  await prompt.fill('#pass', 'wrong')
  await prompt.click('button.primary').catch(() => {})
  await expect.poll(async () => await dialogs(skiff)[0]?.locator('#pass').inputValue().catch(() => 'x')).toBe('')
  prompt = await dialog(skiff)
  await prompt.click('#cancel').catch(() => {})
  await expect.poll(() => dialogs(skiff).length).toBe(0)
  await expect((await content(skiff, url)).locator('#denied')).toHaveText('401 body')

  await skiff.rpc('tabs.navigate', { url: url + '?again' })
  prompt = await dialog(skiff)
  await prompt.keyboard.press('Escape').catch(() => {})
  await expect.poll(() => dialogs(skiff).length).toBe(0)
  await expect((await content(skiff, url + '?again')).locator('#denied')).toHaveText('401 body')
})

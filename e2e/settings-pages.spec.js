'use strict'
const path = require('node:path')
const { test, expect } = require('./fixtures')

const fakeAgent = path.join(__dirname, 'fake-agent.js')
const command = (skiff) => `'${process.execPath}' '${fakeAgent}' '${skiff.root}'`
const pressed = (card) => card.locator('#chips .chip[aria-pressed="true"]')

async function openSettings(skiff) {
  const card = await skiff.card()
  await card.locator('#settings-toggle').click()
  await expect(card.locator('#panel')).toBeVisible()
  return card
}

test('chips switch Settings between four pages, arrow keys move across them, and each opening starts at This space', async ({ skiff }) => {
  const card = await openSettings(skiff)
  await expect(card.locator('#space-head')).toBeHidden()
  await expect(card.locator('#chips .chip')).toHaveText(['This space', 'Browsing', 'Agents', 'Skiff'])
  await expect(pressed(card)).toHaveText('This space')
  await expect(card.locator('#space-name')).toBeVisible()
  await expect(card.locator('#delete-space')).toBeDisabled()
  await expect(card.getByText('Keep at least one space.')).toBeVisible()
  await expect(card.locator('#search-engine')).toHaveCount(0)

  await card.locator('#settings-page-browsing').click()
  await expect(pressed(card)).toHaveText('Browsing')
  await expect(card.locator('#search-engine')).toBeVisible()
  await expect(card.locator('#setting-autoArchiveHours')).toBeVisible()
  await expect(card.locator('#space-name')).toHaveCount(0)

  await card.locator('#settings-page-agents').click()
  await expect(card.locator('#agents-section')).toBeVisible()
  await expect(card.locator('#agent-add-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(card.locator('#agent-preset')).toHaveCount(0)

  await card.locator('#settings-page-agents').focus()
  await card.keyboard.press('ArrowLeft')
  await expect(card.locator('#settings-page-browsing')).toBeFocused()
  await card.keyboard.press('ArrowRight')
  await card.keyboard.press('ArrowRight')
  await expect(card.locator('#settings-page-skiff')).toBeFocused()
  await card.keyboard.press('Enter')
  await expect(pressed(card)).toHaveText('Skiff')
  await expect(card.locator('#import-arc')).toBeVisible()
  await expect(card.locator('#fill-password')).toBeVisible()
  await expect(card.locator('#setting-revealLogs')).toBeVisible()

  await card.locator('#settings-toggle').click()
  await expect(card.locator('#panel')).toBeHidden()
  await card.locator('#settings-toggle').click()
  await expect(pressed(card)).toHaveText('This space')
})

test('a Browsing setting writes the setting, and the search engine menu changes searchUrl', async ({ skiff }) => {
  const card = await openSettings(skiff)
  await card.locator('#settings-page-browsing').click()
  const hours = card.locator('#setting-autoArchiveHours')
  await expect(hours).toHaveValue('12')
  await expect(card.locator('#setting-autoArchiveHours + .set-unit')).toHaveText('hours')
  await hours.fill('7')
  await hours.press('Tab')
  await expect.poll(async () => (await skiff.state()).settings.autoArchiveHours).toBe(7)

  await card.locator('#search-engine').selectOption({ label: 'DuckDuckGo' })
  await expect.poll(async () => (await skiff.state()).settings.searchUrl).toBe('https://duckduckgo.com/?q=%s')

  await card.locator('#setting-tabLayout').selectOption('full')
  await expect.poll(async () => (await skiff.state()).settings.tabLayout).toBe('full')
})

test('Add agent expands in place, the added agent becomes the default, and the form folds away', async ({ skiff }) => {
  const card = await openSettings(skiff)
  await card.locator('#settings-page-agents').click()
  await expect(card.locator('#agents-list li[data-agent]')).toHaveCount(0)
  await card.locator('#agent-add-toggle').click()
  await expect(card.locator('#agent-add-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(card.locator('#agent-preset')).toBeFocused()
  await card.locator('#agent-name').fill('Fake')
  await card.locator('#agent-command').fill(command(skiff))
  await card.locator('#agent-add').click()
  await expect.poll(async () => (await skiff.state()).settings.ai).toMatchObject({ agents: [{ name: 'Fake', command: command(skiff) }], agent: 'Fake' })
  const row = card.locator('#agents-list li[data-agent="Fake"]')
  await expect(row.locator('.agent-default')).toHaveText('Default')
  await expect(card.locator('#agent-preset')).toHaveCount(0)
  await expect(card.locator('#agent-add-toggle')).toHaveAttribute('aria-expanded', 'false')

  await row.locator('.set-main').click()
  await expect(row.locator('code')).toHaveText(command(skiff))
  await expect(row.getByRole('button', { name: 'Remove Fake' })).toBeVisible()
  await row.locator('.set-main').click()
  await expect(row.locator('code')).toHaveCount(0)
})

test('Incognito has no This space page and opens on Browsing', async ({ skiff }) => {
  await (await skiff.bar()).waitForLoadState()
  const space = await skiff.rpc('incognito.open')
  await skiff.rpc('tabs.create', { url: `${skiff.origin}/private`, spaceId: space.id })
  await expect.poll(() => skiff.barOpen()).toBe(true)
  const card = await skiff.bar()
  await expect.poll(() => card.locator('#buoy').evaluate((el) => el.classList.contains('open') && !el.classList.contains('morphing'))).toBe(true)
  await card.locator('#settings-toggle').click()
  await expect(card.locator('#chips .chip')).toHaveText(['Browsing', 'Agents', 'Skiff'])
  await expect(pressed(card)).toHaveText('Browsing')
  await expect(card.locator('#search-engine')).toBeVisible()
})

'use strict'
const { test, expect, snapshot, openImport, next } = require('./fixtures')

async function contrast(shell, selectors) {
  const results = await shell.evaluate((selectors) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value)
    }
    const over = (front, back) => [0, 1, 2].map((index) => front[index] * front[3] + back[index] * (1 - front[3])).concat(1)
    const luminance = (color) => color.slice(0, 3).map((value) => {
      const channel = value / 255
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    return selectors.flatMap((selector) => {
      const placeholder = selector.endsWith('::placeholder')
      const elements = document.querySelectorAll(placeholder ? selector.replace('::placeholder', '') : selector)
      return [...elements].filter((element) => element.getBoundingClientRect().height && !element.closest('[hidden]')).map((element) => {
        const ancestors = []
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor)
        let background = [255, 255, 255, 1]
        for (const ancestor of ancestors) background = over(rgba(getComputedStyle(ancestor).backgroundColor), background)
        const style = getComputedStyle(element, placeholder ? '::placeholder' : null)
        const foreground = rgba(style.color)
        foreground[3] *= Number(style.opacity)
        const a = luminance(over(foreground, background))
        const b = luminance(background)
        return { selector, text: placeholder ? element.placeholder : element.textContent.trim().slice(0, 50), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
      })
    })
  }, selectors)
  expect(results.length, 'Contrast targets must exist').toBeGreaterThan(0)
  for (const result of results) expect(result.ratio, `${result.selector}: ${result.text}`).toBeGreaterThanOrEqual(4.5)
}

async function inViewport(locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  const size = await locator.page().evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1)
}

for (const theme of ['light', 'dark']) {
  test.describe(`${theme} appearance`, () => {
    test.use({ fixtureOptions: { theme, count: 14 } })
    test('the import dialog keeps long content scrollable, readable, reachable and keyboard-contained on the card', async ({ skiff }) => {
      const card = await openImport(skiff)
      expect(await card.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
      await expect(card.locator('input[name="arc-profile"]')).toHaveCount(14)
      await contrast(card, ['#arc-title', '#arc-description', '#arc-content .import-note', '#arc-next'])
      for (const id of ['arc-next', 'arc-cancel']) await inViewport(card.locator(`#${id}`))
      await card.locator('#arc-content').hover()
      await card.mouse.wheel(0, 1400)
      await expect.poll(() => card.locator('#arc-content').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await inViewport(card.locator('#arc-next'))
      await inViewport(card.locator('#arc-cancel'))
      await snapshot(card.locator('#arc-import'), `${theme}-import-minimum.png`)
      await expect(card.locator('#arc-title')).toBeFocused()
      for (let index = 0; index < 20; index++) {
        await card.keyboard.press('Tab')
        expect(await card.evaluate(() => document.querySelector('#arc-import').contains(document.activeElement))).toBe(true)
      }
      await card.locator('#arc-cancel').focus()
      await card.keyboard.press('Shift+Tab')
      expect(await card.evaluate(() => document.querySelector('#arc-import').contains(document.activeElement))).toBe(true)
      await next(skiff)
      await inViewport(card.locator('#arc-back'))
      await inViewport(card.locator('#arc-next'))
      await expect(card.locator('input[name="passwords"]')).not.toBeChecked()
      await expect(card.locator('input[name="logins"]')).not.toBeChecked()
      await snapshot(card.locator('#arc-import'), `${theme}-items-minimum.png`)
      await card.keyboard.press('Escape')
      await expect(card.locator('#import-arc')).toBeFocused()
    })
  })
}

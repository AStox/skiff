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
    test('long content, contrast, responsive import footer and keyboard focus', async ({ skiff }) => {
      const shell = skiff.shell
      expect(await shell.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
      for (let index = 1; index <= 13; index++) await skiff.rpc('spaces.create', { name: `Research ${index}: a deliberately long workspace label`, color: index % 2 ? '#2f9e5b' : '#7c5ce0' })
      await skiff.rpc('spaces.update', { id: (await skiff.state()).activeSpaceId, name: 'A long workspace label that should truncate without overlap' })
      await contrast(shell, ['#space-head h1', '#address'])
      await shell.locator('#settings-toggle').click()
      await expect(shell.locator('#setting-autoArchiveHours')).toBeVisible()
      await contrast(shell, ['#panel label', '#space-name', '#setting-autoArchiveHours'])
      await snapshot(shell.locator('#sidebar'), `${theme}-settings.png`)
      await shell.locator('#settings-toggle').click()
      for (const [width, height] of [[1280, 800], [800, 600], [560, 360]]) {
        await skiff.resize(width, height)
        await expect.poll(() => shell.evaluate(() => innerWidth)).toBe(width)
        await inViewport(shell.locator('#settings-toggle'))
        await inViewport(shell.locator('#add-space'))
        expect(await shell.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await snapshot(shell, `${theme}-shell-${width}.png`)
      }
      await openImport(skiff)
      await expect(shell.locator('input[name="arc-profile"]')).toHaveCount(14)
      await contrast(shell, ['#arc-title', '#arc-description', '#arc-content .import-note', '#arc-next'])
      for (const id of ['arc-next', 'arc-cancel']) await inViewport(shell.locator(`#${id}`))
      await shell.locator('#arc-content').hover()
      await shell.mouse.wheel(0, 1400)
      await expect.poll(() => shell.locator('#arc-content').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await inViewport(shell.locator('#arc-next'))
      await inViewport(shell.locator('#arc-cancel'))
      await snapshot(shell.locator('#arc-import'), `${theme}-import-minimum.png`)
      await expect(shell.locator('#arc-title')).toBeFocused()
      for (let index = 0; index < 20; index++) {
        await shell.keyboard.press('Tab')
        expect(await shell.evaluate(() => document.querySelector('#arc-import').contains(document.activeElement))).toBe(true)
      }
      await shell.locator('#arc-cancel').focus()
      await shell.keyboard.press('Shift+Tab')
      expect(await shell.evaluate(() => document.querySelector('#arc-import').contains(document.activeElement))).toBe(true)
      await next(skiff)
      await inViewport(shell.locator('#arc-back'))
      await inViewport(shell.locator('#arc-next'))
      await expect(shell.locator('input[name="passwords"]')).not.toBeChecked()
      await expect(shell.locator('input[name="logins"]')).not.toBeChecked()
      await snapshot(shell.locator('#arc-import'), `${theme}-items-minimum.png`)
      await shell.keyboard.press('Escape')
      await expect(shell.locator('#import-arc')).toBeFocused()
      await skiff.resize(800, 600)
      // Open directly from the already-open Settings panel.
      await shell.locator('#import-arc').click()
      await snapshot(shell.locator('#arc-import'), `${theme}-profiles-narrow.png`)
    })
  })
}

test('200 percent zoom and reduced motion keep modal actions reachable', async ({ skiff }) => {
  await skiff.shell.emulateMedia({ reducedMotion: 'reduce' })
  await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
  await expect.poll(() => skiff.shell.evaluate(() => innerWidth)).toBe(640)
  await expect.poll(() => skiff.shell.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await openImport(skiff)
  await next(skiff)
  for (const id of ['arc-next', 'arc-back', 'arc-cancel']) await inViewport(skiff.shell.locator(`#${id}`))
  const capture = await skiff.app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
    return { size: image.getSize(), png: image.toPNG().toString('base64') }
  })
  expect(capture.size).toEqual({ width: 1280, height: 800 })
  expect(Buffer.from(capture.png, 'base64')).toMatchSnapshot('zoom-200-reduced-motion.png', { maxDiffPixels: 0 })
  await skiff.shell.keyboard.press('Escape')
  await expect(skiff.shell.locator('#import-arc')).toBeFocused()
})

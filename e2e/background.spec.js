'use strict'
const { test, expect, openImport, next } = require('./fixtures')

// Two real Arc space themes as Skiff stores them. Colors only.
const DEV = {
  color: '#cf2e52',
  light: { color: '#f6e9ec', colors: ['#cf2e52', '#c9782c'], overlayColors: ['#00000000', '#cf2eaf'], intensity: 0.601529048039363 },
  dark: { color: '#330b14', colors: ['#cf2e52', '#c9782c'], overlayColors: ['#00000000', '#cf2eaf'], intensity: 0.601529048039363 }
}
const WORK = {
  color: '#4b79f8',
  light: { color: '#e4ecfd', colors: ['#4b79f8', '#f7cc35'], overlayColors: [], intensity: 0.37948843149038464 },
  dark: { color: '#001447', colors: ['#4b79f8', '#f7cc35'], overlayColors: [], intensity: 0.37948843149038464 }
}
const TEXT = '#space-head h1, #list .label'

const hue = ([r, g, b]) => {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  return ((max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360
}
const chroma = (rgb) => Math.max(...rgb) - Math.min(...rgb)

// Reads a real screenshot of the open card: three points in its margins that show the bare background, and the worst contrast of each label against the pixels behind it.
async function measure(skiff, testInfo, name) {
  const card = await skiff.card()
  await expect.poll(() => card.evaluate(() => getComputedStyle(document.getElementById('buoy'), '::before').opacity)).toBe('1')
  const image = await card.screenshot()
  await testInfo.attach(name, { body: image, contentType: 'image/png' })
  const labels = await card.locator(TEXT).evaluateAll((elements) => elements.map((element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect()
    const ink = getComputedStyle(element).color.match(/[\d.]+/g).slice(0, 3).map(Number)
    element.style.setProperty('color', 'transparent')
    return { text: element.textContent, ink, box: [left, top, right, bottom].map(Math.round) }
  }))
  const behind = await card.screenshot()
  await card.locator(TEXT).evaluateAll((elements) => elements.forEach((element) => element.style.removeProperty('color')))
  const surface = await card.locator('#buoy').evaluate((element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect()
    return [left, top, right, bottom].map(Math.round)
  })
  return skiff.app.evaluate(({ nativeImage }, { png, labels, surface: [left, top, right, bottom] }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
    const { width } = image.getSize()
    const bitmap = image.toBitmap()
    const at = (x, y) => [2, 1, 0].map((channel) => bitmap[(y * width + x) * 4 + channel])
    const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    return {
      topLeft: at(left + 3, top + 20), topRight: at(right - 3, top + 20), bottomLeft: at(left + 3, bottom - 20),
      labels: labels.map(({ text, ink, box: [l, t, r, b] }) => {
        let contrast = Infinity
        for (let y = t; y < b; y++) {
          for (let x = l; x < r; x++) {
            const [a, b] = [luminance(ink), luminance(at(x, y))]
            contrast = Math.min(contrast, (Math.max(a, b) + .05) / (Math.min(a, b) + .05))
          }
        }
        return { text, contrast }
      })
    }
  }, { png: behind.toString('base64'), labels, surface })
}

for (const theme of ['light', 'dark']) {
  test.describe(`imported backgrounds in ${theme} appearance`, () => {
    test.use({ fixtureOptions: { theme, themes: [DEV, WORK] } })
    test('real Arc themes keep their hue and readable labels through restart, appearance changes and a manual override', async ({ skiff }, testInfo) => {
      const card = await openImport(skiff)
      await next(skiff)
      await next(skiff)
      await next(skiff)
      await expect(card.locator('.import-profile-result')).toHaveCount(2)
      await card.locator('#arc-cancel').click()
      await card.locator('#settings-toggle').click()
      const seen = {}
      for (const [name, source] of [['Personal', DEV], ['Work', WORK]]) {
        await card.getByRole('button', { name, exact: true }).click()
        await expect(card.locator('html')).toHaveClass(/imported-background/)
        const space = (await skiff.state()).spaces.find((item) => item.name === name)
        expect(space).toMatchObject({ color: source.color, background: { light: source.light, dark: source.dark } })
        await expect(card.locator('#list .row:not([data-static]) .label', { hasText: 'Fixture reading' })).toHaveCount(1)
        await expect.poll(async () => (await skiff.state()).tabs.some((tab) => tab.loading)).toBe(false)
        seen[name] = await measure(skiff, testInfo, `imported-background-${name}-${theme}`)
        expect(seen[name].labels.length).toBeGreaterThan(2)
        for (const label of seen[name].labels) expect(label.contrast, label.text).toBeGreaterThanOrEqual(4.5)
        expect(chroma(seen[name].topLeft), 'no washout').toBeGreaterThanOrEqual(40)
      }
      const dev = seen.Personal
      expect((hue(dev.topLeft) + 30) % 360, 'red-pink on the left').toBeLessThanOrEqual(45)
      expect(hue(dev.topRight), 'orange on the right').toBeGreaterThanOrEqual(10)
      expect(hue(dev.topRight)).toBeLessThanOrEqual(45)
      const magenta = ([, g, b]) => b - g
      expect(magenta(dev.bottomLeft) - magenta(dev.topLeft), 'overlay grows toward the bottom').toBeGreaterThanOrEqual(30)
      const work = seen.Work
      expect(hue(work.topLeft), 'blue on the left').toBeGreaterThanOrEqual(205)
      expect(hue(work.topLeft)).toBeLessThanOrEqual(245)
      expect(work.topRight[2] - work.topRight[0], 'yellow end on the right').toBeLessThanOrEqual(15)
      for (const channel of [0, 1, 2]) expect(Math.abs(work.bottomLeft[channel] - work.topLeft[channel]), 'base colors do not run downward').toBeLessThanOrEqual(3)

      const space = (await skiff.state()).spaces.find((item) => item.name === 'Work')
      const paint = (page) => () => page.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        return { image: style.getPropertyValue('--space-background'), base: style.getPropertyValue('--bg'), ink: style.getPropertyValue('--ink') }
      })
      const before = await paint(card)()
      expect(before.image).not.toContain('url(')
      expect(before.image).not.toBe('')
      await card.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' })
      await expect.poll(async () => (await paint(card)()).image).not.toBe(before.image)
      await skiff.restart()
      expect((await skiff.state()).spaces.find((item) => item.id === space.id).background).toEqual(space.background)
      let again = await skiff.card()
      await expect.poll(paint(again)).toEqual(before)
      await again.locator('#settings-toggle').click()
      await again.getByRole('button', { name: 'Green', exact: true }).click()
      await expect(again.locator('html')).not.toHaveClass(/imported-background/)
      expect((await paint(again)()).image).toBe('')
      await again.locator('#import-arc').click()
      await next(skiff)
      await next(skiff)
      await next(skiff)
      await expect(again.locator('.import-profile-result')).toHaveCount(2)
      await again.locator('#arc-cancel').click()
      await skiff.restart()
      const edited = (await skiff.state()).spaces.find((item) => item.id === space.id)
      expect(edited.background).toBeNull()
      expect(edited.color).toBe('#2f9e5b')
      again = await skiff.card()
      expect((await paint(again)()).image).toBe('')
      expect((await skiff.audit()).protectedReads).toEqual([])
    })
  })
}

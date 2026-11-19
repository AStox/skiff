'use strict'
const { test, expect, openImport, next, openInBar } = require('./fixtures')

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

// Reads a real screenshot: the three shell corners that show the bare background, and the worst contrast of each label against the pixels behind it.
async function measure(skiff, testInfo, name) {
  const shell = skiff.shell
  const image = await shell.screenshot()
  await testInfo.attach(name, { body: image, contentType: 'image/png' })
  const labels = await shell.locator(TEXT).evaluateAll((elements) => elements.map((element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect()
    const ink = getComputedStyle(element).color.match(/[\d.]+/g).slice(0, 3).map(Number)
    element.style.setProperty('color', 'transparent')
    return { text: element.textContent, ink, box: [left, top, right, bottom].map(Math.round) }
  }))
  const behind = await shell.screenshot()
  await shell.locator(TEXT).evaluateAll((elements) => elements.forEach((element) => element.style.removeProperty('color')))
  return skiff.app.evaluate(({ nativeImage }, { png, labels }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    const at = (x, y) => [2, 1, 0].map((channel) => bitmap[(y * width + x) * 4 + channel])
    const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    return {
      topLeft: at(4, 4), topRight: at(width - 4, 4), bottomLeft: at(4, height - 4),
      labels: labels.map(({ text, ink, box: [left, top, right, bottom] }) => {
        let contrast = Infinity
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const [a, b] = [luminance(ink), luminance(at(x, y))]
            contrast = Math.min(contrast, (Math.max(a, b) + .05) / (Math.min(a, b) + .05))
          }
        }
        return { text, contrast }
      })
    }
  }, { png: behind.toString('base64'), labels })
}

for (const theme of ['light', 'dark']) {
  test.describe(`imported backgrounds in ${theme} appearance`, () => {
    test.use({ fixtureOptions: { theme, themes: [DEV, WORK] } })
    test('real Arc themes keep their hue and readable labels through restart, appearance changes and a manual override without moving the page', async ({ skiff }, testInfo) => {
      await skiff.shell.locator('#empty-new-tab').click()
      await openInBar(skiff, `${skiff.origin}/existing`)
      await expect.poll(() => skiff.attached()).toBeGreaterThan(0)
      const bounds = await skiff.shell.locator('#page').boundingBox()
      const nativeBounds = () => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((view) => view.getBounds()))
      const native = await nativeBounds()
      await openImport(skiff)
      await next(skiff)
      await next(skiff)
      await next(skiff)
      await expect(skiff.shell.locator('.import-profile-result')).toHaveCount(2)
      await skiff.shell.locator('#arc-cancel').click()
      await skiff.shell.locator('#settings-toggle').click()
      const seen = {}
      for (const [name, source] of [['Personal', DEV], ['Work', WORK]]) {
        await skiff.shell.getByRole('button', { name, exact: true }).click()
        await expect(skiff.shell.locator('html')).toHaveClass(/imported-background/)
        const space = (await skiff.state()).spaces.find((item) => item.name === name)
        expect(space).toMatchObject({ color: source.color, background: { light: source.light, dark: source.dark } })
        await skiff.shell.getByRole('button', { name: `${name} reading`, exact: true }).click()
        await expect(skiff.shell.locator('#list .row.current .label')).toHaveText('Fixture reading')
        await expect.poll(async () => (await skiff.state()).tabs.some((tab) => tab.loading)).toBe(false)
        expect(await skiff.shell.locator('#page').boundingBox()).toEqual(bounds)
        expect(await nativeBounds()).toEqual(native)
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
      const paint = () => skiff.shell.evaluate(() => ({ image: getComputedStyle(document.body).backgroundImage, base: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color }))
      const before = await paint()
      expect(before.image).not.toContain('url(')
      await skiff.shell.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' })
      await expect.poll(async () => (await paint()).image).not.toBe(before.image)
      await skiff.restart()
      expect((await skiff.state()).spaces.find((item) => item.id === space.id).background).toEqual(space.background)
      await expect.poll(paint).toEqual(before)
      await skiff.shell.locator('#settings-toggle').click()
      await skiff.shell.getByRole('button', { name: 'Green', exact: true }).click()
      await expect(skiff.shell.locator('html')).not.toHaveClass(/imported-background/)
      expect((await paint()).image).toBe('none')
      await skiff.shell.locator('#import-arc').click()
      await next(skiff)
      await next(skiff)
      await next(skiff)
      await expect(skiff.shell.locator('.import-profile-result')).toHaveCount(2)
      await skiff.shell.locator('#arc-cancel').click()
      await skiff.restart()
      const edited = (await skiff.state()).spaces.find((item) => item.id === space.id)
      expect(edited.background).toBeNull()
      expect(edited.color).toBe('#2f9e5b')
      expect((await paint()).image).toBe('none')
      expect((await skiff.audit()).protectedReads).toEqual([])
    })
  })
}

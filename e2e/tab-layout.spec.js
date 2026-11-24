'use strict'
const fs = require('node:fs')
const { test, expect } = require('./fixtures')
const { execFileSync } = require('node:child_process')

test.use({ fixtureOptions: { componentConsent: 1 } })

const MODES = ['free', 'full', 'sections', 'split', 'grid', 'main-stack', 'spiral', 'cascade']
const views = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children.filter((view) => view.webContents?.getURL().startsWith('http')).map((view) => ({ path: new URL(view.webContents.getURL()).pathname, ...view.getBounds() })))
const rectOf = (t) => ({ x: t.desk.x, y: t.desk.y, width: t.desk.width, height: t.desk.height })
const tabs = async (skiff) => (await skiff.state()).tabs.filter((t) => t.desk && !t.desk.hidden)

// SKIFF_LAYOUT_SHOTS=<dir> also saves a composited X11 frame of each mode there.
async function grab(skiff, mode) {
  const dir = process.env.SKIFF_LAYOUT_SHOTS
  if (!dir || !process.env.DISPLAY) return
  // Without a compositor the full-desk transparent floats grab as opaque black, so they are hidden for the grab.
  const floats = (hide) => skiff.app.evaluate(({ BrowserWindow }, hide) => {
    for (const w of BrowserWindow.getAllWindows().filter((x) => !x.webContents.getURL().endsWith('/index.html'))) hide ? w.hide() : w.showInactive()
  }, hide)
  const bounds = await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).getContentBounds())
  await floats(true)
  await new Promise((resolve) => setTimeout(resolve, 800))
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${bounds.width}x${bounds.height}`, '-i', `${process.env.DISPLAY}+${bounds.x},${bounds.y}`, '-frames:v', '1', '-threads', '1', '-y', `${dir}/${mode}.png`], { timeout: 10000 })
  await floats(false)
}

test('the Tab layout setting arranges the shown windows without touching their own rects, and free brings them back', async ({ skiff }) => {
  const closed = skiff.shell.waitForEvent('close')
  await skiff.shell.evaluate(() => { window.skiff.call('ui.setShell', { name: 'layer' }) })
  await closed
  await expect.poll(() => !skiff.shell.isClosed()).toBe(true)
  await skiff.shell.waitForLoadState()
  const created = []
  for (const name of ['one', 'two', 'three', 'four']) created.push(await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/${name}` }))
  await expect.poll(async () => (await views(skiff)).length).toBe(4)
  const own = Object.fromEntries((await tabs(skiff)).map((t) => [t.id, rectOf(t)]))
  const state = await skiff.state()
  const { width, height } = state.deskSize
  const catalog = await skiff.rpc('settings.catalog', { quickPanel: true, owner: 'core' })
  expect(catalog.find((entry) => entry.id === 'tabLayout')).toMatchObject({ value: 'free', title: 'Tab layout (experimental)', enum: MODES })

  for (const mode of MODES) {
    await skiff.rpc('settings.set', { tabLayout: mode })
    await expect.poll(async () => JSON.stringify((await views(skiff)).map((v) => [v.path, v.x, v.y, v.width, v.height]).sort()) === JSON.stringify((await tabs(skiff)).map((t) => [new URL(t.url).pathname, ...Object.values(rectOf(t))]).sort())).toBe(true)
    const shown = await tabs(skiff)
    const byPath = Object.fromEntries((await views(skiff)).map((v) => [v.path, v]))
    for (const t of shown) {
      const bounds = byPath[new URL(t.url).pathname]
      expect(bounds, `${mode} view of ${t.url}`).toMatchObject(rectOf(t))
      if (mode === 'free') expect(rectOf(t)).toEqual(own[t.id])
    }
    if (mode !== 'free') {
      for (const a of shown) for (const b of shown) {
        if (a === b || ['full', 'cascade'].includes(mode)) continue
        const r = rectOf(a)
        const o = rectOf(b)
        expect(r.x < o.x + o.width && o.x < r.x + r.width && r.y < o.y + o.height && o.y < r.y + r.height, `${mode} overlap`).toBe(false)
      }
      for (const t of shown) expect(rectOf(t).x + rectOf(t).width).toBeLessThanOrEqual(width)
      expect(height).toBeGreaterThan(0)
    }
    await grab(skiff, mode)
  }

  await skiff.rpc('settings.set', { tabLayout: 'free' })
  await expect.poll(async () => JSON.stringify((await tabs(skiff)).map(rectOf))).toBe(JSON.stringify(created.map((t) => own[t.id])))
  await grab(skiff, 'free-restored')

  // Opening, hiding and closing a window re-arranges at once: n columns fill the desk width.
  const columns = (n) => async () => {
    const list = await views(skiff)
    return list.length === n && Math.abs(list.reduce((sum, v) => sum + v.width, 0) + (n + 1) * 8 - width) <= n
  }
  await skiff.rpc('settings.set', { tabLayout: 'split' })
  await expect.poll(columns(4)).toBe(true)
  const fifth = await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/five` })
  await expect.poll(columns(5)).toBe(true)
  await skiff.rpc('desk.hide', { id: fifth.id })
  await expect.poll(columns(4)).toBe(true)
  await skiff.rpc('desk.show', { id: fifth.id })
  await expect.poll(columns(5)).toBe(true)
  await skiff.rpc('tabs.close', { id: fifth.id })
  await expect.poll(columns(4)).toBe(true)

  // Dragging a window in a non-Free layout snaps it back; the saved rect is untouched.
  await skiff.rpc('desk.place', { id: created[0].id, x: 300, y: 300, width: 400, height: 300 })
  await skiff.rpc('settings.set', { tabLayout: 'free' })
  await expect.poll(async () => rectOf((await tabs(skiff)).find((t) => t.id === created[0].id))).toEqual(own[created[0].id])
})

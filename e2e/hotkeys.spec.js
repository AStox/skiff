'use strict'
const { test, expect } = require('./fixtures')

const back = process.platform === 'darwin' ? 'Cmd+Left' : 'Alt+Left'
// The first page view on the desk and the desk shell's own webContents; these tests keep one tab open at a time.
const zoom = (skiff) => skiff.onDesk((win) => {
  const page = win.contentView.children.find((view) => view.webContents?.getURL().startsWith('http'))
  return { page: page.webContents.getZoomFactor(), shell: win.webContents.getZoomFactor() }
})
const pageContents = (skiff, fn, arg) => skiff.onDesk((win, { source, arg }) => {
  const page = win.contentView.children.find((view) => view.webContents?.getURL().startsWith('http'))
  return new Function(`return (${source})`)()(page.webContents, arg)
}, { source: fn.toString(), arg })

test('browser keys zoom the page, go back and pick tabs; pinch and Ctrl+wheel zoom', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
  await skiff.page('/one')
  await skiff.rpc('tabs.navigate', { url: skiff.origin + '/two' })
  const page = await skiff.page('/two')
  await expect.poll(() => pageContents(skiff, (wc) => wc.navigationHistory.canGoBack())).toBe(true)

  await skiff.shortcut('CmdOrCtrl+=')
  await expect.poll(() => zoom(skiff)).toEqual({ page: 1.1, shell: 1 })
  await skiff.shortcut('CmdOrCtrl+0')
  await expect.poll(() => zoom(skiff)).toEqual({ page: 1, shell: 1 })

  // Ctrl+wheel reaches the core as zoom-changed only for events with wheel ticks; one notch is one step.
  await pageContents(skiff, (wc) => wc.sendInputEvent({ type: 'mouseWheel', deltaY: 120, wheelTicksY: 1, modifiers: ['control'], x: 100, y: 100, canScroll: true }))
  await expect.poll(async () => (await zoom(skiff)).page).toBe(1.1)
  await skiff.shortcut('CmdOrCtrl+0')
  await expect.poll(async () => (await zoom(skiff)).page).toBe(1)

  // Pinch is a visual zoom inside the page.
  await pageContents(skiff, async (wc) => {
    wc.debugger.attach('1.3')
    try {
      await wc.debugger.sendCommand('Input.synthesizePinchGesture', { x: 100, y: 100, scaleFactor: 2 })
    } finally {
      wc.debugger.detach()
    }
  })
  await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBeGreaterThan(1)

  await skiff.shortcut(back)
  await skiff.page('/one')
  await expect.poll(async () => (await skiff.rpc('state.get')).tabs.find((t) => t.url.endsWith('/one'))).toBeTruthy()

  await skiff.rpc('tabs.create', { url: skiff.origin + '/three' })
  await skiff.page('/three')
  const last = await skiff.rpc('tabs.create', { url: skiff.origin + '/four', activate: false })
  await skiff.shortcut('CmdOrCtrl+9')
  await expect.poll(async () => (await skiff.rpc('state.get')).activeTabBySpace).toEqual(expect.objectContaining({ [last.spaceId]: last.id }))
})

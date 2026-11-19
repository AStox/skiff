'use strict'
const { test, expect } = require('./fixtures')

const back = process.platform === 'darwin' ? 'Cmd+Left' : 'Alt+Left'
// The page view of the active tab and the shell's own webContents.
const zoom = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  return { page: win.contentView.children[0].webContents.getZoomFactor(), shell: win.webContents.getZoomFactor() }
})

test('browser keys zoom the page, go back and pick tabs; pinch and Ctrl+wheel zoom', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
  await skiff.page('/one')
  await skiff.rpc('tabs.navigate', { url: skiff.origin + '/two' })
  const page = await skiff.page('/two')
  await expect.poll(() => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.navigationHistory.canGoBack())).toBe(true)

  await skiff.shortcut('CmdOrCtrl+=')
  await expect.poll(() => zoom(skiff)).toEqual({ page: 1.1, shell: 1 })
  await skiff.shortcut('CmdOrCtrl+0')
  await expect.poll(() => zoom(skiff)).toEqual({ page: 1, shell: 1 })

  // Ctrl+wheel reaches the core as zoom-changed only for events with wheel ticks; one notch is one step.
  await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.sendInputEvent({ type: 'mouseWheel', deltaY: 120, wheelTicksY: 1, modifiers: ['control'], x: 100, y: 100, canScroll: true }))
  await expect.poll(async () => (await zoom(skiff)).page).toBe(1.1)
  await skiff.shortcut('CmdOrCtrl+0')
  await expect.poll(async () => (await zoom(skiff)).page).toBe(1)

  // Pinch is a visual zoom inside the page.
  await skiff.app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents
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

'use strict'
const { test, expect } = require('./fixtures')

// Another app in front: a plain window that has the keyboard, as under Xvfb (no window manager) is the closest thing to bb.
const putOtherAppInFront = async (skiff, deskId) => {
  await skiff.app.evaluate(({ BrowserWindow }) => {
    global.__away = new BrowserWindow({ x: 1200, y: 600, width: 200, height: 200 })
    global.__away.focus()
  })
  await expect.poll(() => skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isFocused(), deskId)).toBe(false)
}
const deskFocused = (skiff, deskId) => skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isFocused(), deskId)

test('a link another app opens brings Skiff in front; an agent tab stays behind', async ({ skiff }) => {
  const deskId = await skiff.onDesk((win) => win.id)
  await putOtherAppInFront(skiff, deskId)

  // An agent opens a tab in the background: nothing comes forward.
  const agent = await skiff.rpc('tabs.create', { url: `${skiff.origin}/agent/one`, agent: 'omp', activate: false })
  await skiff.shell.waitForTimeout(500)
  expect(await deskFocused(skiff, deskId)).toBe(false)
  expect((await skiff.state()).tabs.some((t) => t.id === agent.id)).toBe(true)

  // open-url, the way macOS hands a link to the default browser.
  await skiff.app.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), `${skiff.origin}/from-open-url`)
  await expect.poll(() => skiff.state().then((s) => s.tabs.some((t) => t.url === `${skiff.origin}/from-open-url`))).toBe(true)
  await expect.poll(() => deskFocused(skiff, deskId)).toBe(true)
  const opened = (await skiff.state()).tabs.find((t) => t.url === `${skiff.origin}/from-open-url`)
  const state = await skiff.state()
  expect(state.activeTabBySpace[state.activeSpaceId]).toBe(opened.id)

  // A second launch with a URL argument takes the same path.
  await skiff.app.evaluate(({ BrowserWindow }) => { global.__away.destroy(); global.__away = null })
  await putOtherAppInFront(skiff, deskId)
  await skiff.app.evaluate(({ app }, url) => app.emit('second-instance', {}, [process.execPath, url], process.cwd()), `${skiff.origin}/from-second`)
  await expect.poll(() => skiff.state().then((s) => s.tabs.some((t) => t.url === `${skiff.origin}/from-second`))).toBe(true)
  await expect.poll(() => deskFocused(skiff, deskId)).toBe(true)
})

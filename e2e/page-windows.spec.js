'use strict'
const { test, expect } = require('./fixtures')

const mainErrors = (skiff) => skiff.app.evaluate(() => {
  global.__pageWindowErrors ??= []
  if (!global.__pageWindowErrorsOn) {
    global.__pageWindowErrorsOn = true
    process.on('uncaughtException', (error) => global.__pageWindowErrors.push(String(error)))
  }
})

test('window.open with features is a real popup that keeps its opener, and target=_blank is still a tab', async ({ skiff }) => {
  const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/opener` })
  const page = await skiff.page('/opener')
  const tabsBefore = (await skiff.state()).tabs.length

  const result = await page.evaluate((url) => {
    window.messages = []
    addEventListener('message', (e) => window.messages.push(e.data))
    const popup = window.open(url, 'auth', 'width=500,height=600')
    return { opened: popup !== null }
  }, `${skiff.origin}/popup`)
  expect(result.opened).toBe(true)

  const popup = await skiff.page('/popup')
  expect(await popup.evaluate(() => window.opener !== null && window.name)).toBe('auth')
  await popup.evaluate(() => window.opener.postMessage('signed-in', '*'))
  await expect.poll(() => page.evaluate(() => window.messages)).toEqual(['signed-in'])
  expect((await skiff.state()).tabs).toHaveLength(tabsBefore)

  await page.evaluate((url) => { window.open(url, '_blank') }, `${skiff.origin}/blank-tab`)
  await expect.poll(async () => (await skiff.state()).tabs.some((t) => t.url.endsWith('/blank-tab'))).toBe(true)
  expect((await skiff.state()).tabs.find((t) => t.id === tab.id)).toBeTruthy()
})

test('a page that closes itself closes its tab without errors', async ({ skiff }) => {
  await mainErrors(skiff)
  const closing = await skiff.rpc('tabs.create', { url: `${skiff.origin}/closing` })
  const other = await skiff.rpc('tabs.create', { url: `${skiff.origin}/other` })
  const page = await skiff.page('/closing')
  await page.evaluate(() => { setTimeout(() => window.close(), 0) }).catch(() => {})

  await expect.poll(async () => (await skiff.state()).tabs.some((t) => t.id === closing.id)).toBe(false)
  expect((await skiff.state()).tabs.some((t) => t.id === other.id)).toBe(true)
  // The next tab operation walks every live view; it would throw on a tab whose page is gone.
  const third = await skiff.rpc('tabs.create', { url: `${skiff.origin}/third` })
  await skiff.page('/third')
  await skiff.rpc('tabs.activate', { id: third.id })
  expect(await skiff.app.evaluate(() => global.__pageWindowErrors)).toEqual([])
})

const openTabs = async (skiff) => {
  const ids = []
  for (const name of ['one', 'two', 'three']) ids.push((await skiff.rpc('tabs.create', { url: `${skiff.origin}/${name}` })).id)
  for (const name of ['one', 'two', 'three']) await skiff.page(`/${name}`)
  return ids
}
const stillOpen = async (skiff, ids) => {
  await expect.poll(async () => (await skiff.state()).tabs.filter((t) => ids.includes(t.id)).length).toBe(ids.length)
  const state = await skiff.state()
  expect(state.archive.filter((entry) => ids.includes(entry.id))).toEqual([])
}

test('quitting keeps every open tab open, not archived', async ({ skiff }) => {
  const ids = await openTabs(skiff)
  await skiff.restart()
  await stillOpen(skiff, ids)
})

test('closing the main window keeps every open tab open, not archived', async ({ skiff }) => {
  const ids = await openTabs(skiff)
  const child = skiff.app.process()
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await skiff.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))?.close() }).catch(() => {})
  await exited
  await skiff.restart()
  await stillOpen(skiff, ids)
})

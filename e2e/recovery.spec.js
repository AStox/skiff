'use strict'
const { test, expect } = require('./fixtures')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const bundled = path.join(__dirname, '..', 'shells', 'layer')

const editedShell = ({ data }) => {
  const live = path.join(data, 'shell')
  fs.cpSync(bundled, live, { recursive: true })
  const index = path.join(live, 'index.html')
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<title>Skiff</title>', '<title>Edited live shell</title>'))
}
const shellTitle = (skiff) => expect.poll(() => skiff.shell.title().catch(() => ''))

test('an edited live shell is used normally, and restart or live safe mode shows the bundled Layer with tabs and profile untouched', async ({ skiff }) => {
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
  await skiff.page('/article')
  const profile = await skiff.rpc('profiles.create', { name: 'Kept profile' })
  await skiff.restart({ beforeLaunch: editedShell })
  await shellTitle(skiff).toBe('Edited live shell')
  expect((await skiff.rpc('ui.shellPath')).owner).toBe('legacy.shell')
  const before = await skiff.state()
  const untouched = async () => {
    const state = await skiff.state()
    expect(state.tabs.map((item) => item.id)).toEqual(before.tabs.map((item) => item.id))
    expect(state.tabs.some((item) => item.id === tab.id)).toBe(true)
    expect(state.profiles).toEqual(before.profiles)
    expect(state.profiles.some((item) => item.id === profile.id)).toBe(true)
  }
  const bundledLayer = async () => {
    await shellTitle(skiff).toBe('Skiff')
    expect(skiff.shell.url()).toBe(pathToFileURL(path.join(bundled, 'index.html')).href)
    const state = await skiff.state()
    expect(state.safeMode).toBe(true)
    expect(state.shells).toBeUndefined()
    await untouched()
    const card = await skiff.card()
    expect(card.url()).toBe(pathToFileURL(path.join(bundled, 'buoy.html')).href)
    await expect(card.locator(`#list [data-tab-id="${tab.id}"]`)).toBeVisible()
  }
  await skiff.restart({ safeMode: true })
  await bundledLayer()
  await skiff.restart()
  await shellTitle(skiff).toBe('Edited live shell')
  expect((await skiff.state()).safeMode).toBe(false)
  await skiff.rpc('ui.safeMode')
  await bundledLayer()
})

test('a profile saved on another shell opens in Layer and forgets the old choice', async ({ skiff }) => {
  await skiff.restart({ beforeLaunch: ({ data }) => fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ settings: { shell: 'quiet' } })) })
  expect(skiff.shell.url()).toBe(pathToFileURL(path.join(bundled, 'index.html')).href)
  expect((await skiff.state()).settings.shell).toBeUndefined()
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/first' })
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(skiff.data, 'state.json'), 'utf8')).tabs?.some((item) => item.id === tab.id)).toBe(true)
  expect(JSON.parse(fs.readFileSync(path.join(skiff.data, 'state.json'), 'utf8')).settings.shell).toBeUndefined()
})

test('resetting the shell backs up the live copy and selects the bundled Layer', async ({ skiff }) => {
  await skiff.restart({ beforeLaunch: editedShell })
  await shellTitle(skiff).toBe('Edited live shell')
  const { backup } = await skiff.rpc('ui.resetShell')
  expect(path.dirname(backup)).toBe(skiff.data)
  expect(path.basename(backup)).toMatch(/^shell\.bak-\d+$/)
  expect(fs.readFileSync(path.join(backup, 'index.html'), 'utf8')).toContain('Edited live shell')
  expect(fs.existsSync(path.join(skiff.data, 'shell'))).toBe(false)
  expect(await skiff.rpc('ui.shellPath')).toEqual({ path: bundled, owner: 'stock.shell', readOnly: true })
  await shellTitle(skiff).toBe('Skiff')
  expect(skiff.shell.url()).toBe(pathToFileURL(path.join(bundled, 'index.html')).href)
})

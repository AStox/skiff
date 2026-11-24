'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { test, expect } = require('./fixtures')
const { writeArc } = require('./arc-fixture')

// Where a page's view lives: the user's window (the one showing the shell) or the hidden agent window, and how that window stands.
const where = (skiff, path) => skiff.app.evaluate(({ BrowserWindow }, url) => {
  for (const w of BrowserWindow.getAllWindows()) {
    const pages = w.contentView.children.filter((v) => v.webContents?.getURL().startsWith('http'))
    const view = pages.find((v) => v.webContents.getURL() === url)
    if (view) return { user: w.webContents.getURL().endsWith('/index.html'), front: view === pages.at(-1), bounds: view.getBounds(), visible: w.isVisible(), focused: w.isFocused(), focusable: w.isFocusable(), pageFocused: view.webContents.isFocused() }
  }
  return null
}, skiff.origin + path)
// Runs in the page through the main process, so Playwright's focus emulation plays no part.
const inPage = (skiff, path, code, gesture = false) => skiff.app.evaluate(({ webContents }, [url, code, gesture]) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
  return wc ? wc.executeJavaScript(code, gesture) : null
}, [skiff.origin + path, code, gesture])
const pageFocused = (skiff, path) => skiff.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url).isFocused(), skiff.origin + path)
const userWindow = (skiff) => skiff.app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/index.html'))
  return { focused: w.isFocused(), pages: w.contentView.children.filter((v) => v.webContents?.getURL().startsWith('http')).map((v) => ({ path: new URL(v.webContents.getURL()).pathname, ...v.getBounds() })) }
})
const counters = (skiff, path) => inPage(skiff, path, '[window.ticks || 0, window.rafs || 0, document.visibilityState]')
// A hidden page that keeps repainting gets about one animation frame a second (see README), so frames only need to advance.
async function keepsRunning(skiff, path) {
  await expect.poll(async () => (await counters(skiff, path))?.[1] || 0).toBeGreaterThan(0)
  const [ticks, rafs] = await counters(skiff, path)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const [ticks2, rafs2, visibility] = await counters(skiff, path)
  expect(ticks2 - ticks, 'interval ticks in 2.5s').toBeGreaterThan(20)
  expect(rafs2 - rafs, 'animation frames in 2.5s').toBeGreaterThan(0)
  return visibility
}
// The PNG's size, and how many sampled pixels show the page's green background or anything else.
const pixels = (skiff, png) => skiff.app.evaluate(({ nativeImage }, png) => {
  const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
  const bitmap = image.toBitmap()
  let green = 0
  let other = 0
  for (let i = 0; i < bitmap.length; i += 4 * 97) {
    const [b, g, r] = [bitmap[i], bitmap[i + 1], bitmap[i + 2]]
    if (Math.abs(r - 0x2f) < 12 && Math.abs(g - 0x9e) < 12 && Math.abs(b - 0x5b) < 12) green++
    else other++
  }
  return { ...image.getSize(), green, other }
}, png)
async function expectCaptured(skiff, id) {
  const shot = await skiff.rpc('ui.capture', { target: 'page', id })
  const seen = await pixels(skiff, shot.png)
  expect([seen.width, seen.height, shot.width, shot.height]).toEqual([1280, 800, 1280, 800])
  expect(seen.green / (seen.green + seen.other), 'the page background fills most of the capture').toBeGreaterThan(0.8)
  expect(seen.other, 'the heading and link show too').toBeGreaterThan(0)
}
const requested = (skiff, path) => skiff.requests.filter((url) => url === path).length

// ui.setShell replaces the window that runs the call, so the call is not awaited.
async function switchWindow(skiff, name) {
  const old = skiff.shell
  const closed = old.waitForEvent('close')
  await old.evaluate((name) => { window.skiff.call('ui.setShell', { name }) }, name)
  await closed
  await expect.poll(() => !skiff.shell.isClosed()).toBe(true)
  await skiff.shell.waitForLoadState()
}
const shellPage = async (skiff, suffix) => {
  await expect.poll(() => skiff.app.context().pages().some((page) => page.url().endsWith(suffix))).toBe(true)
  return skiff.app.context().pages().find((page) => page.url().endsWith(suffix))
}

test('an agent tab is an ordinary tab that loads parked, never takes focus, keeps running, and the agent can capture and read it', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/user' })
  const page = await skiff.page('/user')
  await page.waitForLoadState()
  await skiff.rpc('ui.focusPage')
  await page.locator('input').focus()
  await expect.poll(() => pageFocused(skiff, '/user')).toBe(true)
  const before = await skiff.state()
  const windowFocused = (await userWindow(skiff)).focused

  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/one', agent: 'omp', activate: true })
  expect(tab).toMatchObject({ agent: 'omp', agentState: 'working', agentControl: 'agent', spaceId: before.activeSpaceId, sessionPartition: 'persist:main' })
  await expect.poll(() => where(skiff, '/agent/one')).toMatchObject({ user: false, bounds: { x: 0, y: 0, width: 1280, height: 800 }, visible: false, focused: false, focusable: false, pageFocused: false })
  expect(await keepsRunning(skiff, '/agent/one')).toBe('visible')

  // It is a tab of the space like any other, and nothing else changed: the user's tab stays the active one.
  const after = await skiff.state()
  expect(after.tabs.map((t) => t.id).sort()).toEqual([...before.tabs.map((t) => t.id), tab.id].sort())
  expect(after.tabs.find((t) => t.id === tab.id)).toMatchObject({ spaceId: before.activeSpaceId, agent: 'omp', agentState: 'working', agentControl: 'agent', loading: false })
  expect(after.tabs.filter((t) => t.spaceId === before.activeSpaceId && t.agent).map((t) => t.id)).toEqual([tab.id])
  expect(after).not.toHaveProperty('agentTabs')
  expect(after).not.toHaveProperty('peek')
  expect([after.activeSpaceId, after.activeTabBySpace]).toEqual([before.activeSpaceId, before.activeTabBySpace])
  expect((await userWindow(skiff)).pages.map((p) => p.path)).toEqual(['/user'])
  // The keyboard stays where the user left it.
  expect(await pageFocused(skiff, '/user')).toBe(true)
  expect((await userWindow(skiff)).focused).toBe(windowFocused)
  await page.keyboard.type('still mine')
  await expect(page.locator('input')).toHaveValue('still mine')
  expect(await pageFocused(skiff, '/user')).toBe(true)
  expect((await where(skiff, '/agent/one')).pageFocused).toBe(false)

  await expectCaptured(skiff, tab.id)
  const read = await skiff.rpc('tabs.read', { id: tab.id })
  expect(read).toMatchObject({ title: 'Agent one', url: skiff.origin + '/agent/one', selection: '' })
  expect(read.text).toContain('Agent fixture /agent/one')
  // Saved like any tab: after a restart it is back, still omp's but idle, with no page and no hidden window.
  await skiff.restart()
  expect((await skiff.state()).tabs.filter((t) => t.agent).map((t) => [t.id, t.agent, t.agentState, t.agentControl])).toEqual([[tab.id, 'omp', 'idle', 'agent']])
  expect(await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('activating an agent tab shows its live page in the window without a reload, showing another tab parks it where the agent keeps working, and closing it archives it', async ({ skiff }) => {
  const user = (await skiff.rpc('tabs.create', { url: skiff.origin + '/user' })).id
  await skiff.page('/user')
  await expect.poll(async () => (await userWindow(skiff)).pages.length).toBe(1)
  const [pageArea] = (await userWindow(skiff)).pages
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/one', agent: 'omp' })
  await keepsRunning(skiff, '/agent/one')
  await inPage(skiff, '/agent/one', 'window.__mark = 42')
  const loads = requested(skiff, '/agent/one')
  expect(loads).toBe(1)
  const before = await skiff.state()

  await skiff.rpc('tabs.activate', { id: tab.id })
  const { path, ...bounds } = pageArea
  await expect.poll(() => where(skiff, '/agent/one')).toMatchObject({ user: true, front: true, bounds })
  expect((await userWindow(skiff)).pages.map((p) => p.path)).toEqual(['/agent/one'])
  expect(await inPage(skiff, '/agent/one', 'window.__mark')).toBe(42)
  expect(requested(skiff, '/agent/one')).toBe(loads)
  const shown = await skiff.state()
  expect(shown.activeTabBySpace[before.activeSpaceId]).toBe(tab.id)
  expect(shown.tabs.map((t) => t.id).sort()).toEqual(before.tabs.map((t) => t.id).sort())
  // ui.capture without an id follows what the window shows.
  expect(await skiff.rpc('ui.capture', { target: 'page' })).toMatchObject({ width: bounds.width, height: bounds.height })

  // Showing the user's tab parks the same page again.
  await skiff.rpc('tabs.activate', { id: user })
  await expect.poll(() => where(skiff, '/agent/one')).toMatchObject({ user: false, bounds: { x: 0, y: 0, width: 1280, height: 800 }, visible: false })
  expect((await skiff.state()).activeTabBySpace[before.activeSpaceId]).toBe(user)
  expect((await userWindow(skiff)).pages.map((p) => p.path)).toEqual(['/user'])
  expect(await inPage(skiff, '/agent/one', 'window.__mark')).toBe(42)
  expect(requested(skiff, '/agent/one')).toBe(loads)
  await keepsRunning(skiff, '/agent/one')

  // The agent keeps driving it: navigate, read, capture.
  await skiff.rpc('tabs.navigate', { id: tab.id, url: skiff.origin + '/agent/two' })
  await expect.poll(() => where(skiff, '/agent/two')).toMatchObject({ user: false, visible: false })
  await keepsRunning(skiff, '/agent/two')
  expect(await skiff.rpc('tabs.read', { id: tab.id })).toMatchObject({ title: 'Agent two', url: skiff.origin + '/agent/two' })
  await expectCaptured(skiff, tab.id)
  // A link it opens in a new tab is another tab of the same agent, parked; the user's active tab and focus stay as they were.
  await inPage(skiff, '/agent/two', "document.querySelector('a[target]').click()", true)
  await expect.poll(async () => (await skiff.state()).tabs.filter((t) => t.agent).map((t) => [t.agent, new URL(t.url).pathname]).sort()).toEqual([['omp', '/agent/opened'], ['omp', '/agent/two']])
  await expect.poll(() => where(skiff, '/agent/opened')).toMatchObject({ user: false, visible: false })
  const opened = await skiff.state()
  expect(opened.activeTabBySpace).toEqual(before.activeTabBySpace)
  expect(opened.tabs.find((t) => t.url.endsWith('/agent/opened'))).toMatchObject({ agent: 'omp' })

  // Closing it while it shows archives it like any tab, as a plain one to restore; closing the last agent tab takes the hidden window with it.
  await skiff.rpc('tabs.activate', { id: tab.id })
  await expect.poll(() => where(skiff, '/agent/two')).toMatchObject({ user: true })
  expect(await skiff.rpc('tabs.close', { id: tab.id })).toEqual({ archived: tab.id })
  const closed = await skiff.state()
  const rest = closed.tabs.filter((t) => t.agent)
  expect([closed.archive.length, rest.length]).toEqual([before.archive.length + 1, 1])
  expect(closed.tabs.some((t) => t.id === tab.id)).toBe(false)
  expect(closed.archive[0]).not.toHaveProperty('agent')
  await skiff.rpc('tabs.close', { id: rest[0].id })
  expect((await skiff.state()).archive.length).toBe(before.archive.length + 2)
  await expect.poll(async () => (await userWindow(skiff)).pages.map((p) => p.path)).toEqual(['/user'])
  await expect.poll(() => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  const restored = await skiff.rpc('archive.restore', { id: tab.id })
  expect(restored.agent).toBeUndefined()
})

test('an agent tab shares its space\'s session and never opens in the incognito space', async ({ skiff }) => {
  await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/set-cookie' })
  await skiff.page('/agent/set-cookie')
  await expect.poll(() => inPage(skiff, '/agent/set-cookie', 'document.cookie')).toBe('agent-session=shared')

  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/one', agent: 'omp' })
  await expect.poll(async () => (await skiff.rpc('tabs.read', { id: tab.id })).text).toContain('cookie: agent-session=shared')
  expect(skiff.cookied).toContain('/agent/one')

  const home = (await skiff.state()).activeSpaceId
  const incognito = await skiff.rpc('incognito.open')
  const refused = await skiff.shell.evaluate((p) => window.skiff.call('tabs.create', p).then(() => null, (e) => ({ code: e.code, message: e.message })), { url: skiff.origin + '/agent/two', agent: 'omp', spaceId: incognito.id })
  expect(refused).toEqual({ code: 'bad_params', message: 'Agent tabs cannot open in the incognito space' })
  // Without a space it goes to the first normal one, not the incognito space the user is in.
  const second = await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/three', agent: 'omp' })
  expect(second).toMatchObject({ spaceId: home, sessionPartition: 'persist:main' })
  const agents = (await skiff.state()).tabs.filter((t) => t.agent)
  expect(agents.map((t) => t.id).sort()).toEqual([tab.id, second.id].sort())
  expect(agents.every((t) => t.spaceId === home)).toBe(true)
})

test('Layer: an agent tab starts as a hidden desk window with a badge and dot, and picking its row puts it on the desk in front with its frame', async ({ skiff }) => {
  await switchWindow(skiff, 'layer')
  const user = (await skiff.rpc('tabs.create', { url: skiff.origin + '/user' })).id
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/one', agent: 'omp' })
  await keepsRunning(skiff, '/agent/one')
  await inPage(skiff, '/agent/one', 'window.__mark = 42')
  const loads = requested(skiff, '/agent/one')
  // Created in Layer it starts as a hidden desk window, so its page is parked.
  expect(await where(skiff, '/agent/one')).toMatchObject({ user: false, visible: false })
  expect(await inPage(skiff, '/agent/one', 'window.__mark')).toBe(42)

  const hidden = await skiff.state()
  expect(hidden.tabs.find((t) => t.id === tab.id).desk.hidden).toBe(true)
  const buoy = await shellPage(skiff, '/buoy.html')
  const chip = buoy.locator('#buoy-agents')
  await expect(chip).toHaveText('omp working')

  // The card's tab list shows it like any tab, marked as the agent's and as a window that is not on the desk.
  await buoy.locator('#buoy-main').click()
  const row = buoy.locator(`#list [data-tab-id="${tab.id}"]`)
  await expect(row.locator('.label')).toHaveText('Agent one')
  await expect(row.locator('.agent-badge')).toHaveText('omp')
  await expect(row.locator('.agent-dot')).toHaveAttribute('data-state', 'working')
  await expect(row).toHaveClass(/hidden-win/)

  await row.locator('.row-main').click()
  await expect.poll(async () => (await skiff.state()).activeTabBySpace[hidden.activeSpaceId]).toBe(tab.id)
  const shown = await skiff.state()
  const rect = shown.tabs.find((t) => t.id === tab.id).desk
  expect(rect.hidden).toBeFalsy()
  await expect.poll(() => where(skiff, '/agent/one')).toMatchObject({ user: true, front: true, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
  await expect(buoy.locator('#buoy')).not.toHaveClass(/open/)
  expect(await inPage(skiff, '/agent/one', 'window.__mark')).toBe(42)
  expect(requested(skiff, '/agent/one')).toBe(loads)
  // Its frame lies right under it and names it.
  const stack = () => skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children.map((v) => v.webContents.getURL()))
  const order = await stack()
  const at = order.indexOf(skiff.origin + '/agent/one')
  expect(order[at - 1]).toContain(`/frame.html?tab=${tab.id}`)
  expect(order.slice(0, at).filter((url) => url.startsWith('http'))).toEqual([skiff.origin + '/user'])
  const frame = await shellPage(skiff, `/frame.html?tab=${tab.id}`)
  await expect(frame.locator('#ear-title')).toHaveText('Agent one')

  // Hidden again it is parked and keeps working; desk.show brings it back in front.
  await skiff.rpc('desk.hide', { id: tab.id })
  await expect.poll(() => where(skiff, '/agent/one')).toMatchObject({ user: false, visible: false })
  expect((await skiff.state()).tabs.find((t) => t.id === tab.id).desk.hidden).toBe(true)
  await keepsRunning(skiff, '/agent/one')
  await skiff.rpc('desk.show', { id: tab.id })
  await expect.poll(() => where(skiff, '/agent/one')).toMatchObject({ user: true, front: true })
  expect(await inPage(skiff, '/agent/one', 'window.__mark')).toBe(42)
  expect(requested(skiff, '/agent/one')).toBe(loads)

  // The chip follows agent tabs as they open and close, across agents.
  const more = [
    await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/two', agent: 'omp' }),
    await skiff.rpc('tabs.create', { url: skiff.origin + '/agent/three', agent: 'claude' })
  ]
  await expect(chip).toHaveText('omp, claude working')
  await skiff.rpc('tabs.close', { id: more[1].id })
  await expect(chip).toHaveText('omp working')
  for (const t of [tab, more[0]]) await skiff.rpc('tabs.close', { id: t.id })
  await expect(chip).toBeHidden()
  expect((await skiff.state()).tabs.map((t) => t.id)).toEqual([user])
})

// Playwright's debugger connection keeps a hidden page rendering by itself, so this runs a second Skiff with nothing attached and checks it over the command API only.
test('without a debugger attached, a hidden agent page keeps its timers and animation frames running and can be captured', async ({ skiff }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-visual-'))
  const home = path.join(root, 'home')
  const data = path.join(root, 'data')
  for (const dir of [home, data, path.join(home, 'app-data')]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(root, '.skiff-visual-fixture'), 'owned by this test')
  writeArc(home, skiff.origin)
  const port = new URL(skiff.origin).port
  const env = { ...process.env, HOME: home, USERPROFILE: home, SKIFF_DATA: data, SKIFF_VISUAL_ROOT: root, SKIFF_VISUAL_PORT: port, SKIFF_VISUAL_CONSENT: '0', SKIFF_VISUAL_THEME: 'light', SKIFF_VISUAL_EXTENSIONS: '0', SKIFF_BUILTIN_EXTENSIONS: '[]', XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [path.join(__dirname, 'electron-entry.js'), '--force-device-scale-factor=1'], { env, detached: true, stdio: 'ignore' })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    const file = path.join(data, 'api.json')
    await expect.poll(() => fs.existsSync(file) && fs.statSync(file).size > 0, { timeout: 20_000 }).toBe(true)
    const api = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: api.port, path: '/rpc', method: 'POST', headers: { Authorization: `Bearer ${api.token}` } }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const out = JSON.parse(Buffer.concat(chunks))
          if (out.ok) resolve(out.result)
          else reject(Object.assign(new Error(out.error.message), out.error))
        })
      })
      req.on('error', reject)
      req.end(JSON.stringify({ method, params }))
    })
    await expect.poll(() => rpc('state.get').then((s) => s.spaces.length).catch(() => 0)).toBeGreaterThan(0)
    const tab = await rpc('tabs.create', { url: skiff.origin + '/agent/live', agent: 'omp' })
    const sample = async () => {
      const match = /ticks (\d+) frames (\d+)/.exec((await rpc('tabs.read', { id: tab.id })).text)
      return match ? [Number(match[1]), Number(match[2])] : [0, 0]
    }
    await expect.poll(async () => (await sample())[0], { timeout: 10_000 }).toBeGreaterThan(0)
    const runs = async (what) => {
      const [ticks, frames] = await sample()
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const [ticks2, frames2] = await sample()
      expect(ticks2 - ticks, `${what}: interval ticks in 2.5s`).toBeGreaterThan(20)
      expect(frames2 - frames, `${what}: animation frames in 2.5s`).toBeGreaterThan(0)
      const shot = await rpc('ui.capture', { target: 'page', id: tab.id })
      const seen = await pixels(skiff, shot.png)
      expect([seen.width, seen.height]).toEqual([1280, 800])
      expect(seen.green / (seen.green + seen.other), what).toBeGreaterThan(0.8)
    }
    await runs('hidden')
    // Shown like any tab, then parked again by showing another one.
    await rpc('tabs.activate', { id: tab.id })
    expect((await rpc('state.get')).activeTabBySpace[(await rpc('state.get')).activeSpaceId]).toBe(tab.id)
    const user = await rpc('tabs.create', { url: skiff.origin + '/user' })
    await runs('after being shown')
    const state = await rpc('state.get')
    expect(state.tabs.map((t) => t.id).sort()).toEqual([tab.id, user.id].sort())
    expect(state.tabs.find((t) => t.id === tab.id)).toMatchObject({ agent: 'omp' })
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000)
    await exited
    clearTimeout(timer)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

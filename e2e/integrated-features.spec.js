'use strict'
const { test, expect } = require('./fixtures')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

async function composited(skiff, testInfo, name) {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return
  const bounds = await skiff.app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds)
  const file = testInfo.outputPath(`composited-${name}.png`)
  // X11 captures the actual native composition, including page/frame views.
  await new Promise((resolve) => setTimeout(resolve, 100))
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${bounds.width}x${bounds.height}`, '-i', `${process.env.DISPLAY}+${bounds.x},${bounds.y}`, '-frames:v', '1', '-threads', '1', '-y', file], { timeout: 10000 })
  await testInfo.attach(`Composited ${name}`, { path: file, contentType: 'image/png' })
}

async function surface(skiff, filename) {
  const matches = (page) => page !== skiff.shell && !page.isClosed() && page.url().split('?')[0].endsWith('/' + filename)
  await expect.poll(() => skiff.app.context().pages().some(matches)).toBe(true)
  return skiff.app.context().pages().findLast(matches)
}

for (const shell of ['default', 'layer']) test.describe(`integrated daily features: ${shell}`, () => {
  test('native find, reader, split divider, peek and history retain the live page', async ({ skiff }, testInfo) => {
    if (shell !== 'default') await skiff.rpc('ui.setShell', { name: shell })
    const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    const page = await skiff.page('/article')
    await expect(page.locator('article h1')).toHaveText('A useful local article')
    await page.evaluate(() => { window.retainedIdentity = 'same-document' })
    await skiff.shortcut('CmdOrCtrl+F')
    const find = await surface(skiff, 'find.html')
    await find.locator('#find-query').fill('Needle')
    await expect.poll(async () => (await skiff.state()).tabs.find((t) => t.id === tab.id).find?.count).toBe(12)
    await composited(skiff, testInfo, 'find')
    await find.getByRole('button', { name: 'Next match' }).click()
    await find.locator('#find-close').click()
    await skiff.rpc('ui.openReader', { id: tab.id })
    const reader = await surface(skiff, 'reader.html')
    await expect(reader.locator('#article')).toContainText('Skiff keeps live pages')
    await composited(skiff, testInfo, 'reader')
    await reader.locator('#reader-close').click()
    expect(await page.evaluate(() => window.retainedIdentity)).toBe('same-document')
    expect(await page.evaluate(() => document.cookie)).toContain('fixture-session=signed-in')

    const other = await skiff.rpc('tabs.create', { url: skiff.origin + '/second' })
    await skiff.rpc('split.set', { ids: [tab.id, other.id], ratio: .5 })
    const divider = await surface(skiff, 'split.html')
    await divider.getByRole('separator').focus()
    await divider.keyboard.press('ArrowRight')
    await expect.poll(async () => (await skiff.state()).splitBySpace[tab.spaceId].ratio).toBeGreaterThan(.5)
    await composited(skiff, testInfo, 'split')
    const geometry = await skiff.app.evaluate(({ BrowserWindow }, origin) => {
      const host = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
      return host.contentView.children.filter((v) => v.webContents?.getURL().startsWith(origin)).map((v) => ({ url: v.webContents.getURL(), bounds: v.getBounds() }))
    }, skiff.origin)
    const left = geometry.find((x) => x.url.endsWith('/article')).bounds
    const right = geometry.find((x) => x.url.endsWith('/second')).bounds
    expect(left.x + left.width).toBeLessThanOrEqual(right.x)
    expect(left.height).toBe(right.height)
    const peek = await skiff.rpc('peek.open', { sourceId: tab.id, url: skiff.origin + '/peek-only' })
    await skiff.page('/peek-only')
    expect((await skiff.rpc('history.search', { query: 'peek-only' })).entries).toEqual([])
    await skiff.rpc('peek.promote', { id: peek.id })
    expect((await skiff.state()).tabs.find((t) => t.id === peek.id).sessionPartition).toBe(tab.sessionPartition)
    await skiff.rpc('split.clear')
    expect((await skiff.rpc('history.search', { query: 'Local Reading Article' })).entries.some((entry) => entry.url === skiff.origin + '/article')).toBe(true)
    expect(await page.evaluate(() => window.retainedIdentity)).toBe('same-document')
  })
})

test.describe('local component lifecycle', () => {
  test.use({ fixtureOptions: { componentConsent: 1 } })
  test('custom UI and worker replacement/revert preserve native page identity and partition', async ({ skiff }, testInfo) => {
    await skiff.rpc('ui.setShell', { name: 'layer' })
    const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    const page = await skiff.page('/article')
    await page.evaluate(() => { window.retainedIdentity = crypto.randomUUID() })
    const identity = await page.evaluate(() => window.retainedIdentity)
    const component = path.join(skiff.root, 'custom-component')
    fs.mkdirSync(component)
    fs.writeFileSync(path.join(component, 'manifest.json'), JSON.stringify({ apiVersion: 1, id: 'custom.fixture', version: '1.0.0', surfaces: { launcher: 'palette.html', inspector: 'inspector.html' }, backend: 'backend.js', capabilities: ['ui', 'backend', 'commands.register', 'storage', 'call:state.get', 'call:ui.hideOverlay'] }))
    fs.writeFileSync(path.join(component, 'palette.html'), '<!doctype html><title>Custom launcher</title><h1>Owned launcher</h1>')
    fs.writeFileSync(path.join(component, 'inspector.html'), '<!doctype html><title>Custom inspector</title><h1>Independent inspector</h1>')
    const backend = (version) => `exports.activate = async api => { const prior = await api.storage.read('counter'); const count = (prior || 0) + 1; await api.storage.write('counter',count); api.register({name:api.id+'.version',description:'Working backend version',inputSchema:{type:'object',properties:{},additionalProperties:false},run:async()=>({version:${version},count})}); api.register({name:api.id+'.crash',description:'Crash fixture worker',inputSchema:{type:'object',properties:{},additionalProperties:false},run:()=>process.exit(7)}); }`
    fs.writeFileSync(path.join(component, 'backend.js'), backend(1))
    await skiff.rpc('components.stage', { path: component })
    await skiff.rpc('components.apply', { id: 'custom.fixture' })
    await skiff.rpc('components.bind', { role: 'launcher', id: 'custom.fixture' })
    await skiff.rpc('ui.showOverlay', { file: 'palette.html' })
    await expect((await surface(skiff, 'palette.html')).getByRole('heading', { name: 'Owned launcher' })).toBeVisible()
    await composited(skiff, testInfo, 'custom-launcher')
    await skiff.rpc('ui.hideOverlay')
    await skiff.rpc('ui.showSurface', { id: 'custom.fixture', surface: 'inspector', name: 'inspector', bounds: { x: 100, y: 100, width: 320, height: 180 } })
    await expect((await surface(skiff, 'inspector.html')).getByRole('heading')).toHaveText('Independent inspector')
    await composited(skiff, testInfo, 'custom-inspector')
    expect((await skiff.rpc('custom.fixture.version')).version).toBe(1)
    const inspector = await surface(skiff, 'inspector.html')
    await inspector.evaluate(() => skiff.storage.write('from-ui', { kept: true }))
    expect(await skiff.rpc('components.storage.read', { id: 'custom.fixture', key: 'from-ui' })).toEqual({ kept: true })
    for (const operation of ['read', 'write', 'remove']) {
      const code = await inspector.evaluate(async (operation) => {
        try {
          if (operation === 'write') await skiff.storage.write('private-ui', { secret: 'must not persist' }, { private: true })
          else await skiff.storage[operation]('private-ui', { private: true })
          return 'unexpected-success'
        } catch (error) { return error.code }
      }, operation)
      expect(code).toBe('forbidden')
    }
    expect(await skiff.rpc('components.storage.read', { id: 'custom.fixture', key: 'private-ui' })).toBeNull()
    expect(fs.existsSync(path.join(skiff.data, 'components', 'data', 'custom.fixture', 'v1', 'global', 'private-ui.json'))).toBe(false)
    await inspector.evaluate(() => addEventListener('keydown', (event) => { event.preventDefault(); event.stopImmediatePropagation() }, true))
    expect(await skiff.nativeKey(inspector, 'Escape')).toEqual({ key: 'Escape', prevented: true })
    expect(await skiff.app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().some((window) => window.contentView.children.some((view) => view.webContents?.getURL() === url)), inspector.url())).toBe(false)
    await expect.poll(() => skiff.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.isFocused(), page.url())).toBe(true)
    await skiff.rpc('ui.openTools', { section: 'components', id: 'custom.fixture' })
    await expect((await surface(skiff, 'index.html')).getByText('Local components can change the browser interface and run their own code.', { exact: false })).toBeVisible()
    await composited(skiff, testInfo, 'component-tools')
    await skiff.rpc('ui.closeTools')
    const preview = await skiff.rpc('components.preview', { id: 'custom.fixture' })
    expect(preview.backend).toBe(false)
    expect(preview.pid).toBeGreaterThan(0)
    expect(preview.profile).not.toBe(skiff.data)
    const previewApi = JSON.parse(fs.readFileSync(path.join(preview.profile, 'api.json'), 'utf8'))
    const previewCall = async (method, params = {}) => {
      const response = await fetch(`http://127.0.0.1:${previewApi.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${previewApi.token}` }, body: JSON.stringify({ method, params }) })
      return response.json()
    }
    expect((await previewCall('state.get')).result.tabs).toEqual([])
    expect((await previewCall('components.apply', { id: 'custom.fixture' })).ok).toBe(false)
    expect((await previewCall('settings.set', { ai: { agents: [{ name: 'No execution', command: 'false' }] } })).ok).toBe(false)
    expect((await skiff.rpc('custom.fixture.version')).count).toBe(1)
    await skiff.rpc('components.preview.stop', { pid: preview.pid })
    expect(await skiff.rpc('components.preview.list')).toEqual([])
    expect(fs.existsSync(preview.profile)).toBe(false)
    await skiff.rpc('components.source.write', { id: 'custom.fixture', file: 'backend.js', content: "exports.activate = () => { throw new Error('fixture activation failure') }" })
    expect((await skiff.http('components.apply', { id: 'custom.fixture' })).ok).toBe(false)
    expect((await skiff.rpc('custom.fixture.version')).version).toBe(1)
    await skiff.rpc('components.source.write', { id: 'custom.fixture', file: 'backend.js', content: backend(2) })
    await skiff.rpc('components.apply', { id: 'custom.fixture' })
    expect((await skiff.rpc('custom.fixture.version')).version).toBe(2)
    await skiff.rpc('components.revert', { id: 'custom.fixture' })
    expect((await skiff.rpc('custom.fixture.version')).version).toBe(1)
    expect(await page.evaluate(() => window.retainedIdentity)).toBe(identity)
    expect(await page.evaluate(() => document.cookie)).toContain('fixture-session=signed-in')
    expect((await skiff.state()).tabs.find((t) => t.id === tab.id).sessionPartition).toBe(tab.sessionPartition)
    await skiff.rpc('components.disable', { id: 'custom.fixture' })
    expect((await skiff.http('custom.fixture.version')).ok).toBe(false)
    expect(await page.evaluate(() => window.retainedIdentity)).toBe(identity)
    await skiff.rpc('components.enable', { id: 'custom.fixture' })
    expect((await skiff.http('custom.fixture.crash')).ok).toBe(false)
    await expect.poll(async () => (await skiff.rpc('commands.list')).some((entry) => entry.name === 'custom.fixture.version')).toBe(false)
    expect(await page.evaluate(() => window.retainedIdentity)).toBe(identity)
    await skiff.app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === 'Recovery').submenu.items.find((item) => item.label.startsWith('Use Safe Mode')).click())
    await expect.poll(async () => (await skiff.http('state.get')).result.safeMode).toBe(true)
    expect(await page.evaluate(() => window.retainedIdentity)).toBe(identity)
    expect(await page.evaluate(() => document.cookie)).toContain('fixture-session=signed-in')
  })
})

test('profiles, folders, downloads and revocable HTTP grants are real host boundaries', async ({ skiff }, testInfo) => {
  const original = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
  await skiff.page('/article')
  const profile = await skiff.rpc('profiles.create', { name: 'Separate profile' })
  await skiff.rpc('profiles.assign', { spaceId: original.spaceId, profileId: profile.id })
  const isolated = await skiff.rpc('tabs.create', { url: skiff.origin + '/isolated' })
  expect(isolated.sessionPartition).not.toBe(original.sessionPartition)
  expect(await (await skiff.page('/isolated')).evaluate(() => document.cookie)).not.toContain('fixture-session')
  const folder = await skiff.rpc('folders.create', { name: 'Parent' })
  const nested = await skiff.rpc('folders.create', { name: 'Child', parentId: folder.id })
  await skiff.rpc('tabs.setPinned', { id: isolated.id, pinned: true, folderId: nested.id })
  expect((await skiff.state()).tabs.find((t) => t.id === isolated.id).folderId).toBe(nested.id)
  await skiff.rpc('settings.set', { downloadAskWhere: false, downloadDirectory: skiff.root })
  await skiff.rpc('tabs.navigate', { id: isolated.id, url: skiff.origin + '/download' })
  await expect.poll(async () => (await skiff.rpc('downloads.list')).entries.some((d) => d.state === 'completed')).toBe(true)
  expect(fs.readFileSync(path.join(skiff.root, 'skiff-fixture.txt'), 'utf8')).toContain('real isolated fixture')
  await skiff.rpc('ui.openTools', { section: 'profiles' })
  const tools = await surface(skiff, 'index.html')
  const profileRow = tools.locator('.row').filter({ has: tools.getByRole('heading', { name: 'Separate profile', exact: true }) })
  await expect(profileRow).toContainText(isolated.sessionPartition)
  await tools.getByRole('button', { name: 'Downloads', exact: true }).click()
  const downloadRow = tools.locator('.row').filter({ has: tools.getByRole('heading', { name: 'skiff-fixture.txt', exact: true }) })
  await expect(downloadRow).toContainText('completed')
  await expect(downloadRow.getByRole('button', { name: 'Show in folder', exact: true })).toBeVisible()
  await composited(skiff, testInfo, 'downloads')
  await tools.getByRole('button', { name: 'Close', exact: true }).click()
  const grant = await skiff.rpc('grants.issue', { owner: 'Synthetic agent', tabIds: [original.id], read: true })
  const api = skiff.api()
  const mcp = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${api.port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    return { status: response.status, body: await response.json() }
  }
  const read = await mcp('browser_read_page', { id: original.id })
  expect(JSON.stringify(read.body)).toContain('Skiff keeps live pages')
  expect((await skiff.http('state.get', {}, grant.token)).ok).toBe(false)
  const events = await fetch(`http://127.0.0.1:${api.port}/events`, { headers: { Authorization: `Bearer ${grant.token}` } })
  expect(events.status).toBe(403)
  const outside = await mcp('browser_read_page', { id: isolated.id })
  expect(JSON.stringify(outside.body)).not.toContain('Local fixture page')
  await skiff.rpc('grants.revoke', { id: grant.id })
  expect((await mcp('browser_read_page', { id: original.id })).status).toBe(401)
})

test('sleeping and renderer crash recovery keep the tab profile without discarding drafts', async ({ skiff }) => {
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
  const page = await skiff.page('/article')
  await page.getByRole('textbox', { name: 'Draft' }).fill('Unsaved work')
  await skiff.rpc('tabs.create', { url: skiff.origin + '/second' })
  await expect.poll(async () => (await skiff.state()).tabs.find((t) => t.id === tab.id).protections?.dirty).toBe(true)
  expect((await skiff.http('tabs.discard', { id: tab.id })).ok).toBe(false)
  await skiff.rpc('tabs.activate', { id: tab.id })
  await page.getByRole('textbox', { name: 'Draft' }).fill('')
  await skiff.rpc('tabs.navigate', { id: tab.id, url: skiff.origin + '/article?clean=1' })
  await expect(page.locator('article')).toBeVisible()
  const other = (await skiff.state()).tabs.find((t) => t.id !== tab.id)
  await skiff.rpc('tabs.activate', { id: other.id })
  await skiff.rpc('tabs.discard', { id: tab.id })
  expect((await skiff.state()).tabs.find((t) => t.id === tab.id).lifecycle).toBe('sleeping')
  await skiff.rpc('tabs.activate', { id: tab.id })
  const restored = await skiff.page('/article')
  await expect(restored.locator('article')).toBeVisible()
  expect(await restored.evaluate(() => document.cookie)).toContain('fixture-session=signed-in')
  const crashed = await skiff.app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url))
    const identity = { id: wc.id, pid: wc.getOSProcessId() }
    wc.forcefullyCrashRenderer()
    return identity
  }, skiff.origin + '/article')
  await expect.poll(async () => (await skiff.state()).tabs.find((t) => t.id === tab.id).lifecycle).toBe('crashed')
  await skiff.rpc('tabs.recover', { id: tab.id })
  await expect.poll(async () => (await skiff.state()).tabs.find((entry) => entry.id === tab.id).lifecycle).toBe('live')
  // Inspect Electron's renderer directly instead of reusing Playwright's crashed target.
  const recovered = await skiff.app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) throw new Error('Recovery replaced or destroyed the original webContents')
    const document = await wc.executeJavaScript(`(() => {
      const article = document.querySelector('article')
      const rect = article?.getBoundingClientRect()
      const style = article && getComputedStyle(article)
      return { title: article?.querySelector('h1')?.textContent, visible: Boolean(rect?.width && rect?.height && style.display !== 'none' && style.visibility !== 'hidden'), cookie: document.cookie }
    })()`)
    return { id: wc.id, pid: wc.getOSProcessId(), loading: wc.isLoading(), url: wc.getURL(), ...document }
  }, crashed.id)
  expect(recovered).toMatchObject({ id: crashed.id, loading: false, url: skiff.origin + '/article?clean=1', title: 'A useful local article', visible: true })
  expect(recovered.pid).toBeGreaterThan(0)
  expect(recovered.pid).not.toBe(crashed.pid)
  expect(recovered.cookie).toContain('fixture-session=signed-in')
  expect((await skiff.state()).tabs.find((t) => t.id === tab.id).sessionPartition).toBe(tab.sessionPartition)
})

test.describe('explicit native site consent', () => {
  test.use({ fixtureOptions: { permissionConsent: 3 } })
  test('remembered permission belongs to the exact profile and can be revoked', async ({ skiff }, testInfo) => {
    const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    const page = await skiff.page('/article')
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('granted')
    const permissions = await skiff.rpc('permissions.list', { partition: tab.sessionPartition, origin: skiff.origin })
    expect(permissions.entries.some((p) => p.permission === 'notifications' && p.lifetime === 'remember')).toBe(true)
    await skiff.rpc('ui.openTools', { section: 'sites', id: tab.id })
    const tools = await surface(skiff, 'index.html')
    const rule = tools.locator('.row').filter({ has: tools.getByRole('heading', { name: skiff.origin, exact: true }) }).filter({ hasText: 'notifications:' })
    await expect(rule).toContainText('allow · remember')
    await expect(rule).toContainText(tab.sessionPartition)
    await composited(skiff, testInfo, 'remembered-permission')
    await rule.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect.poll(async () => (await skiff.rpc('permissions.list', { partition: tab.sessionPartition, origin: skiff.origin })).entries).toEqual([])
    await expect(tools.getByText('No saved site permissions.', { exact: true })).toBeVisible()
    expect((await skiff.audit()).decisions.some((d) => d.message.startsWith(skiff.origin))).toBe(true)
    await tools.getByRole('button', { name: 'Page', exact: true }).click()
    await tools.getByRole('button', { name: 'Site settings', exact: true }).click()
    await expect(tools.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible()
    await expect(tools.locator('#error')).toBeEmpty()
    const zoom = tools.locator('form').filter({ has: tools.getByRole('heading', { name: 'Remember zoom', exact: true }) })
    await zoom.getByLabel('Zoom factor (1 = 100%)', { exact: true }).fill('1.25')
    await zoom.getByRole('button', { name: 'Save', exact: true }).click()
    const nativeZoom = () => skiff.app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(origin + '/article'))?.getZoomFactor(), skiff.origin)
    await expect.poll(nativeZoom).toBeCloseTo(1.25, 5)
    expect((await skiff.rpc('zoom.list', { partition: tab.sessionPartition })).entries).toContainEqual({ partition: tab.sessionPartition, origin: skiff.origin, factor: 1.25 })
    await tools.getByRole('button', { name: 'Close', exact: true }).click()
    const destination = skiff.origin + '/article?remembered-zoom=1'
    await skiff.rpc('tabs.navigate', { id: tab.id, url: destination })
    await page.waitForURL(destination)
    await expect.poll(nativeZoom).toBeCloseTo(1.25, 5)
    await composited(skiff, testInfo, 'remembered-zoom')
  })
})

async function stageBackend(skiff, id, backend, capabilities, surfaces = {}) {
  const directory = path.join(skiff.root, id)
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ apiVersion: 1, id, version: '1.0.0', backend: 'backend.js', surfaces, capabilities }))
  fs.writeFileSync(path.join(directory, 'backend.js'), backend)
  for (const file of Object.values(surfaces)) fs.writeFileSync(path.join(directory, file), '<!doctype html><title>Synthetic component</title><h1>Synthetic component surface</h1>')
  await skiff.rpc('components.stage', { path: directory })
  await skiff.rpc('components.apply', { id })
  return directory
}

async function mcpRequest(skiff, token, method, params) {
  const api = skiff.api()
  const response = await fetch(`http://127.0.0.1:${api.port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: response.status, body: await response.json() }
}

test.describe('host trust and lifecycle interleavings', () => {
  test.use({ fixtureOptions: { componentConsent: 1 } })

  test('explicit custom tools preserve scoped nested browser authority and revocation', async ({ skiff }) => {
    const allowed = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    await skiff.page('/article')
    const outside = await skiff.rpc('tabs.create', { url: skiff.origin + '/second' })
    await skiff.page('/second')
    await stageBackend(skiff, 'custom.agent', `
      exports.activate = api => {
        let release, pending = false;
        const define = (name, run, properties = {}, required = [], tool = true) => api.register({name:api.id+'.'+name,description:name,tool,inputSchema:{type:'object',properties,required,additionalProperties:false},run});
        define('message', () => ({message:'explicit custom tool'}));
        define('read', p => api.call('tabs.read',p), {id:{type:'string'}}, ['id']);
        define('list', () => api.call('tabs.list'));
        define('waitRead', async p => { pending=true; await new Promise(resolve=>release=resolve); pending=false; return api.call('tabs.read',p) }, {id:{type:'string'}}, ['id']);
        define('waitNavigate', async p => { pending=true; await new Promise(resolve=>release=resolve); pending=false; return api.call('tabs.navigate',p) }, {id:{type:'string'},url:{type:'string'}}, ['id','url']);
        define('pending', () => pending, {}, [], false);
        define('release', () => { release?.(); return true }, {}, [], false);
      };
    `, ['backend', 'commands.register', 'call:tabs.read', 'call:tabs.list', 'call:tabs.navigate'])
    const browserOnly = await skiff.rpc('grants.issue', { owner: 'Browser only', tabIds: [allowed.id], read: true })
    const tools = await mcpRequest(skiff, browserOnly.token, 'tools/list', {})
    expect(tools.body.result.tools.some((tool) => tool.name.startsWith('custom.agent.'))).toBe(false)
    const undeclared = await mcpRequest(skiff, browserOnly.token, 'tools/call', { name: 'custom.agent.message', arguments: {} })
    expect(JSON.stringify(undeclared.body)).not.toContain('explicit custom tool')
    const toolOnly = await skiff.rpc('grants.issue', { owner: 'Tool only', tools: ['custom.agent.message', 'custom.agent.read'] })
    expect(JSON.stringify((await mcpRequest(skiff, toolOnly.token, 'tools/call', { name: 'custom.agent.message', arguments: {} })).body)).toContain('explicit custom tool')
    expect(JSON.stringify((await mcpRequest(skiff, toolOnly.token, 'tools/call', { name: 'custom.agent.read', arguments: { id: allowed.id } })).body)).not.toContain('Skiff keeps live pages')
    const combined = await skiff.rpc('grants.issue', { owner: 'Scoped custom tools', tabIds: [allowed.id], read: true, tools: ['custom.agent.read', 'custom.agent.list', 'custom.agent.waitRead'] })
    expect(JSON.stringify((await mcpRequest(skiff, combined.token, 'tools/call', { name: 'custom.agent.read', arguments: { id: allowed.id } })).body)).toContain('Skiff keeps live pages')
    expect(JSON.stringify((await mcpRequest(skiff, combined.token, 'tools/call', { name: 'custom.agent.read', arguments: { id: outside.id } })).body)).not.toContain('Local fixture page')
    const listed = JSON.stringify((await mcpRequest(skiff, combined.token, 'tools/call', { name: 'custom.agent.list', arguments: {} })).body)
    expect(listed).toContain(allowed.id)
    expect(listed).not.toContain(outside.id)
    const pending = mcpRequest(skiff, combined.token, 'tools/call', { name: 'custom.agent.waitRead', arguments: { id: allowed.id } })
    await expect.poll(() => skiff.rpc('custom.agent.pending')).toBe(true)
    await skiff.rpc('grants.revoke', { id: combined.id })
    await skiff.rpc('custom.agent.release')
    const revoked = await pending
    expect(revoked.status).toBe(403)
    expect(JSON.stringify(revoked.body)).not.toContain('Skiff keeps live pages')
    const spaceGrant = await skiff.rpc('grants.issue', { owner: 'Space bounded', spaceIds: [allowed.spaceId], mutate: true, tools: ['custom.agent.waitNavigate'] })
    const navigation = mcpRequest(skiff, spaceGrant.token, 'tools/call', { name: 'custom.agent.waitNavigate', arguments: { id: allowed.id, url: skiff.origin + '/must-not-open' } })
    await expect.poll(() => skiff.rpc('custom.agent.pending')).toBe(true)
    const newSpace = await skiff.rpc('spaces.create', { name: 'Outside grant' })
    await skiff.rpc('tabs.move', { id: allowed.id, spaceId: newSpace.id })
    await skiff.rpc('custom.agent.release')
    await navigation
    expect((await skiff.state()).tabs.find((tab) => tab.id === allowed.id).url).toBe(skiff.origin + '/article')
    expect(skiff.requests).not.toContain('/must-not-open')
  })

  test('native activation consent never executes source edited during confirmation', async ({ skiff }) => {
    const backend = (version) => `exports.activate=api=>api.register({name:api.id+'.version',description:'version',inputSchema:{type:'object',properties:{},additionalProperties:false},run:()=>${version}})`
    await stageBackend(skiff, 'custom.consent', backend(1), ['backend', 'commands.register'])
    await skiff.rpc('components.source.write', { id: 'custom.consent', file: 'backend.js', content: backend(2) })
    await skiff.app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox
      global.__restoreConsent = () => { dialog.showMessageBox = original }
      dialog.showMessageBox = async (...args) => {
        if (args[1]?.message === 'Trust component custom.consent?') await new Promise((resolve) => { global.__releaseConsent = resolve })
        return original(...args)
      }
    })
    const applying = skiff.http('components.apply', { id: 'custom.consent' })
    try {
      await expect.poll(() => skiff.app.evaluate(() => Boolean(global.__releaseConsent))).toBe(true)
      const info = await skiff.rpc('components.inspect', { id: 'custom.consent' })
      fs.writeFileSync(path.join(info.path, 'backend.js'), backend(3))
      await skiff.app.evaluate(() => global.__releaseConsent())
      expect((await applying).ok).toBe(false)
      expect(await skiff.rpc('custom.consent.version')).toBe(1)
    } finally {
      await skiff.app.evaluate(() => { global.__releaseConsent?.(); global.__restoreConsent() })
    }
  })

  test('disposed or dismissed reader requests cannot show late native surfaces', async ({ skiff }) => {
    const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    await skiff.page('/article')
    await stageBackend(skiff, 'custom.reader', `exports.activate=api=>api.register({name:api.id+'.open',description:'open reader',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},run:p=>api.call('ui.openReader',p)})`, ['backend', 'commands.register', 'call:ui.openReader'])
    for (const { phase, action } of [{ phase: 'extraction', action: 'disable' }, { phase: 'surface', action: 'disable' }, { phase: 'surface', action: 'close' }]) {
      await skiff.app.evaluate(({ webContents }, { url, phase }) => {
        global.__releaseReader = null
        global.__readerEntered = new Promise((resolve) => { global.__enterReader = resolve })
        const page = webContents.getAllWebContents().find((wc) => wc.getURL() === url)
        if (phase === 'extraction') {
          const original = page.executeJavaScriptInIsolatedWorld
          global.__restoreReader = () => { page.executeJavaScriptInIsolatedWorld = original }
          page.executeJavaScriptInIsolatedWorld = function (...args) {
            page.executeJavaScriptInIsolatedWorld = original
            return new Promise((resolve, reject) => {
              global.__releaseReader = () => { global.__releaseReader = null; original.apply(page, args).then(resolve, reject) }
              global.__enterReader()
            })
          }
        } else {
          const proto = Object.getPrototypeOf(page)
          const original = proto.loadFile
          global.__restoreReader = () => { proto.loadFile = original }
          proto.loadFile = function (file, ...args) {
            if (!file.endsWith('/reader.html')) return original.call(this, file, ...args)
            proto.loadFile = original
            return new Promise((resolve, reject) => {
              global.__releaseReader = () => { global.__releaseReader = null; original.call(this, file, ...args).then(resolve, reject) }
              global.__enterReader()
            })
          }
        }
      }, { url: skiff.origin + '/article', phase })
      const opening = skiff.http('custom.reader.open', { id: tab.id })
      try {
        await Promise.race([
          skiff.app.evaluate(() => global.__readerEntered),
          opening.then((result) => { throw new Error(`Reader ${phase}/${action} completed before its semantic barrier: ${JSON.stringify(result)}`) })
        ])
        if (action === 'disable') await skiff.rpc('components.disable', { id: 'custom.reader' })
        else await skiff.rpc('ui.closeTools')
        await skiff.app.evaluate(() => { global.__releaseReader(); global.__restoreReader() })
        const result = await opening
        if (action === 'disable') expect(result.ok).toBe(false)
        else if (result.ok) expect(result.result).toBeNull()
        await expect.poll(async () => (await skiff.state()).tabs.find((item) => item.id === tab.id).reader.active, { message: `Reader must remain inactive after ${phase}/${action}` }).toBe(false)
        expect(await skiff.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.contentView.children.some((view) => view.webContents?.getURL().includes('/reader.html'))))).toBe(false)
      } finally {
        await skiff.app.evaluate(() => { global.__releaseReader?.(); global.__restoreReader?.() })
      }
      if (action === 'disable') await skiff.rpc('components.enable', { id: 'custom.reader' })
    }
  })

  test('closing generic tools clears find and reader state for their original tab', async ({ skiff }) => {
    const original = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    await skiff.page('/article')
    await skiff.rpc('ui.openFind', { id: original.id })
    await skiff.rpc('find.update', { id: original.id, query: 'Needle' })
    await skiff.rpc('ui.openReader', { id: original.id })
    const other = await skiff.rpc('tabs.create', { url: skiff.origin + '/second' })
    await skiff.rpc('ui.closeTools')
    const state = await skiff.state()
    expect(state.tabs.find((tab) => tab.id === original.id).find.active).toBe(false)
    expect(state.tabs.find((tab) => tab.id === original.id).reader.active).toBe(false)
    expect(state.activeTabBySpace[original.spaceId]).toBe(other.id)
  })

  test('safe mode quarantines malformed composition and still opens stock recovery', async ({ skiff }) => {
    const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    await skiff.page('/article')
    await skiff.restart({ safeMode: true, beforeLaunch: ({ data }) => fs.writeFileSync(path.join(data, 'components', 'composition.json'), '{damaged component state') })
    expect((await skiff.state()).safeMode).toBe(true)
    expect((await skiff.state()).tabs.some((item) => item.id === tab.id)).toBe(true)
    expect(await skiff.app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.some((item) => item.label === 'Recovery'))).toBe(true)
    const inspected = await skiff.rpc('components.inspect')
    expect(inspected.recovery.error).toBeTruthy()
    expect(fs.readFileSync(inspected.recovery.backup, 'utf8')).toBe('{damaged component state')
  })
})

test.describe('shutdown failure containment', () => {
  test.use({ fixtureOptions: { componentConsent: 1, stopFailure: true } })
  test('an early stop rejection still disposes detached workers, closes previews and flushes state', async ({ skiff }) => {
    const marker = path.join(skiff.root, 'disposed.txt')
    await stageBackend(skiff, 'custom.shutdown', `exports.activate=api=>{api.register({name:api.id+'.pid',description:'owned pid',inputSchema:{type:'object',properties:{},additionalProperties:false},run:()=>process.pid});return ()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'disposed')}`, ['backend', 'commands.register', 'ui'], { inspector: 'inspector.html' })
    const pid = await skiff.rpc('custom.shutdown.pid')
    const preview = await skiff.rpc('components.preview', { id: 'custom.shutdown' })
    const space = await skiff.rpc('spaces.create', { name: 'Flush despite failure' })
    await skiff.close()
    expect(fs.readFileSync(marker, 'utf8')).toBe('disposed')
    expect(() => process.kill(pid, 0)).toThrow()
    expect(fs.existsSync(preview.profile)).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(skiff.data, 'state.json'), 'utf8')).spaces.some((item) => item.id === space.id)).toBe(true)
    await skiff.restart()
  })
})

test.describe('owned source provenance and public management parity', () => {
  test.use({ fixtureOptions: { componentConsent: 1 } })

  test('bundled defaults stay bundled while shell changes preserve owned role copies', async ({ skiff }) => {
    const initial = await skiff.rpc('ui.shellPath')
    expect(initial).toEqual({ path: path.join(__dirname, '..', 'shell'), owner: 'stock.shell', readOnly: true })
    expect(fs.existsSync(path.join(skiff.data, 'shell'))).toBe(false)
    const launcher = await skiff.rpc('ui.inspectSource', { role: 'launcher' })
    expect(launcher.id).toBe('stock.shell')
    expect(launcher.resolution.file).toBe(path.join(__dirname, '..', 'shell', 'palette.html'))
    const stock = await skiff.rpc('components.inspect', { id: 'stock.browser-tools' })
    expect(stock.manifest.surfaces).toMatchObject({ find: 'find.html', reader: 'reader.html', split: 'split.html' })
    const copy = await skiff.rpc('components.create', { id: 'custom.retained-launcher', from: 'stock.shell', role: 'launcher' })
    const before = await skiff.rpc('components.source.read', { id: copy.id, file: 'palette.html' })
    await skiff.rpc('components.apply', { id: copy.id })
    await skiff.rpc('components.bind', { id: copy.id, role: 'launcher' })
    await skiff.rpc('ui.setShell', { name: 'layer' })
    expect((await skiff.rpc('ui.shellPath')).path).toBe(path.join(__dirname, '..', 'shells', 'layer'))
    expect((await skiff.rpc('ui.inspectSource', { role: 'launcher' })).id).toBe(copy.id)
    expect((await skiff.rpc('components.source.read', { id: copy.id, file: 'palette.html' })).content).toBe(before.content)
    await skiff.restart()
    expect((await skiff.rpc('ui.shellPath')).path).toBe(path.join(__dirname, '..', 'shells', 'layer'))
    expect((await skiff.rpc('ui.inspectSource', { role: 'launcher' })).id).toBe(copy.id)
    await skiff.rpc('ui.safeMode')
    const recovered = await skiff.rpc('ui.inspectSource', { role: 'launcher' })
    expect(recovered.id).toBe('stock.shell')
    expect(recovered.resolution.source).toBe('default')
    expect(recovered.resolution.file).toBe(path.join(__dirname, '..', 'shell', 'palette.html'))
    expect((await skiff.rpc('components.inspect')).bindings.global.launcher).toBe(copy.id)
  })

  test('existing legacy shell migrates to a selected owned copy without rewriting its source', async ({ skiff }) => {
    await skiff.restart({ beforeLaunch: ({ data }) => {
      const legacy = path.join(data, 'shell')
      fs.cpSync(path.join(__dirname, '..', 'shell'), legacy, { recursive: true })
      fs.appendFileSync(path.join(legacy, 'index.html'), '\n<!-- preserved legacy edit -->')
      fs.unlinkSync(path.join(data, 'components', 'composition.json'))
    } })
    const selected = await skiff.rpc('ui.inspectSource', { role: 'shell' })
    expect(selected.id).toBe('legacy.shell')
    expect(selected.kind).toBe('user')
    expect((await skiff.rpc('components.source.read', { id: selected.id, file: 'index.html' })).content).toContain('preserved legacy edit')
    const original = fs.readFileSync(path.join(skiff.data, 'shell', 'index.html'), 'utf8')
    expect(fs.readFileSync(path.join(selected.origin.backup, 'index.html'), 'utf8')).toBe(original)
    await skiff.rpc('ui.setShell', { name: 'layer' })
    expect((await skiff.rpc('ui.inspectSource', { role: 'shell' })).id).toBe('stock.shell')
    expect(fs.readFileSync(path.join(skiff.data, 'shell', 'index.html'), 'utf8')).toBe(original)
    expect((await skiff.rpc('components.source.read', { id: selected.id, file: 'index.html' })).content).toBe(original)
  })

  test('a consented copy of browser tools edits settings and manages another component through its actual UI', async ({ skiff }) => {
    await stageBackend(skiff, 'custom.managed', 'exports.activate=()=>{}', ['backend', 'ui'], { inspector: 'inspector.html' })
    await skiff.rpc('components.create', { id: 'custom.manager', from: 'stock.browser-tools' })
    await skiff.rpc('components.apply', { id: 'custom.manager' })
    await skiff.rpc('components.bind', { id: 'custom.manager', role: 'settings' })
    await skiff.rpc('components.bind', { id: 'custom.manager', role: 'components' })
    await skiff.rpc('ui.openTools', { section: 'settings' })
    let panel = await surface(skiff, 'index.html')
    expect(panel.url()).toContain('/custom.manager/')
    await panel.getByLabel('Search this section').fill('history retention')
    const settingRows = panel.locator('#content > .row')
    await expect(settingRows).toHaveCount(1)
    const retention = settingRows.filter({ has: panel.getByRole('heading', { name: 'History retention', exact: true }) })
    await expect(retention).toHaveCount(1)
    await retention.getByRole('spinbutton', { name: 'History retention', exact: true }).fill('23')
    await retention.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await skiff.state()).settings.historyRetentionDays).toBe(23)
    await skiff.rpc('ui.openTools', { section: 'components', id: 'custom.managed' })
    panel = await surface(skiff, 'index.html')
    await expect(panel.getByRole('heading', { name: 'Source: custom.managed', exact: true })).toBeVisible()
    await panel.getByRole('combobox', { name: /^Source file\b/ }).selectOption('inspector.html')
    await expect(panel.getByLabel('Component source')).toHaveValue('<!doctype html><title>Synthetic component</title><h1>Synthetic component surface</h1>')
    const source = '<!doctype html><h1>Edited through a copied component manager</h1>'
    await panel.getByLabel('Component source').fill(source)
    await panel.getByRole('button', { name: 'Save source', exact: true }).click()
    await expect.poll(async () => (await skiff.rpc('components.source.read', { id: 'custom.managed', file: 'inspector.html' })).content).toBe(source)
    const managed = panel.locator('.row').filter({ has: panel.getByRole('heading', { name: 'custom.managed', exact: true }) })
    const previousRevision = (await skiff.rpc('components.inspect', { id: 'custom.managed' })).revision
    await managed.getByRole('button', { name: 'Apply trusted changes', exact: true }).click()
    await panel.locator('#confirm').getByRole('button', { name: 'Apply trusted changes', exact: true }).click()
    await expect.poll(async () => (await skiff.rpc('components.inspect', { id: 'custom.managed' })).revision).not.toBe(previousRevision)
    await managed.getByRole('button', { name: 'Disable', exact: true }).click()
    await expect.poll(async () => (await skiff.rpc('components.inspect', { id: 'custom.managed' })).enabled).toBe(false)
    expect((await skiff.audit()).decisions.some((entry) => entry.message === 'Trust component custom.manager?' && entry.detail.includes('host.manage'))).toBe(true)
    await expect(panel.locator('#error')).toBeEmpty()
  })

  test('an administrative component tool cannot launder a scoped agent into host authority', async ({ skiff }) => {
    await stageBackend(skiff, 'custom.admin', `exports.activate=api=>{for(const [name,command,params] of [['grant','grants.issue',{owner:'Escalated',components:['custom.admin']}],['source','components.source.read',{id:'stock.chat',file:'chat.html'}]])api.register({name:api.id+'.'+name,description:name,tool:true,inputSchema:{type:'object',properties:{},additionalProperties:false},run:()=>api.call(command,params)})}`, ['backend', 'commands.register', 'host.manage', 'call:*'])
    const grant = await skiff.rpc('grants.issue', { owner: 'Scoped administrator', tools: ['custom.admin.grant', 'custom.admin.source'] })
    for (const name of grant.tools) {
      const result = await mcpRequest(skiff, grant.token, 'tools/call', { name, arguments: {} })
      expect(result.body.result?.isError || result.body.error).toBeTruthy()
    }
    expect((await skiff.rpc('grants.list')).some((entry) => entry.owner === 'Escalated')).toBe(false)
  })

  test('a real ACP session customizes only its selected component grant through preview, native apply and revert', async ({ skiff }, testInfo) => {
    test.setTimeout(90_000)
    const directory = path.join(skiff.root, 'acp-source')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ apiVersion: 1, id: 'custom.acp-source', version: '1.0.0', surfaces: { launcher: 'palette.html' }, capabilities: ['ui'] }))
    fs.writeFileSync(path.join(directory, 'palette.html'), '<!doctype html><h1>ACP owned launcher</h1>')
    await skiff.rpc('components.stage', { path: directory })
    await skiff.rpc('components.apply', { id: 'custom.acp-source' })
    await skiff.rpc('settings.set', { ai: { agents: [{ name: 'Fixture customizer', command: `'${process.execPath}' '${path.join(__dirname, 'fake-agent.js')}'` }] } })
    const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
    const page = await skiff.page('/article')
    await page.evaluate(() => { window.acpRetained = 'live' })
    const unrelated = await skiff.rpc('grants.issue', { owner: 'Fixture customizer', tabIds: [tab.id], read: true })
    const grant = await skiff.rpc('grants.issue', { owner: 'Fixture customizer', components: ['custom.acp-source'] })
    await skiff.rpc('grants.select', { id: grant.id })
    const copyId = grant.componentNamespace + '.launcher'
    const asked = await skiff.rpc('ai.ask', { agent: 'Fixture customizer', includePage: false, text: 'customize-fixture ' + JSON.stringify({ id: 'custom.acp-source', copyId }) })
    await expect.poll(async () => (await skiff.rpc('ai.chat', { chatId: asked.chatId })).status, { timeout: 60_000 }).toBe('ready')
    const chat = await skiff.rpc('ai.chat', { chatId: asked.chatId })
    const text = chat.turns.find((turn) => turn.kind === 'assistant' && turn.text?.startsWith('CUSTOMIZE_RESULT '))?.text
    expect(text, JSON.stringify(chat)).toBeTruthy()
    const result = JSON.parse(text.slice('CUSTOMIZE_RESULT '.length))
    expect(result).toMatchObject({ copyId, deniedSource: true, deniedBrowser: true })
    expect(result.first).not.toBe(result.second)
    expect(result.reverted).toBe(result.first)
    const grants = await skiff.rpc('grants.list')
    expect(grants.find((entry) => entry.id === grant.id).components).toContain(copyId)
    expect(grants.find((entry) => entry.id === unrelated.id).selectedFor).toEqual([])
    expect(grants.filter((entry) => entry.parentId === grant.id).every((entry) => !entry.read && !entry.mutate && entry.tabIds.length === 0)).toBe(true)
    expect((await skiff.audit()).decisions.filter((entry) => entry.message === `Trust component ${copyId}?`)).toHaveLength(3)
    await skiff.rpc('tabs.activate', { id: tab.id })
    await skiff.rpc('ui.showOverlay', { file: 'palette.html' })
    const launcher = await surface(skiff, 'palette.html')
    await expect(launcher.getByText('ACP fixture revision one', { exact: true })).toBeVisible()
    await expect(launcher.getByText('ACP fixture revision two', { exact: true })).toHaveCount(0)
    await composited(skiff, testInfo, 'acp-customized-launcher')
    expect(await page.evaluate(() => window.acpRetained)).toBe('live')
    await skiff.rpc('components.preview.stop', { pid: result.preview.pid })
    expect(fs.existsSync(result.preview.profile)).toBe(false)
  })
})

test('shell replacement waits for the new native surface before closing the old window or replying', async ({ skiff }) => {
  const tab = await skiff.rpc('tabs.create', { url: skiff.origin + '/article' })
  const page = await skiff.page('/article')
  await page.evaluate(() => { window.transitionIdentity = 'retained' })
  const oldId = await skiff.app.evaluate(({ BrowserWindow }, url) => {
    const old = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)
    const proto = Object.getPrototypeOf(old.webContents)
    const original = proto.loadFile
    global.__releaseShellLoad = null
    global.__restoreShellLoad = () => { proto.loadFile = original }
    proto.loadFile = function (file, ...args) {
      if (!file.endsWith('/shells/layer/index.html')) return original.call(this, file, ...args)
      proto.loadFile = original
      return new Promise((resolve, reject) => {
        global.__releaseShellLoad = () => { global.__releaseShellLoad = null; original.call(this, file, ...args).then(resolve, reject) }
      })
    }
    return old.id
  }, skiff.shell.url())
  let replied = false
  const switching = skiff.http('ui.setShell', { name: 'layer' }).then((result) => { replied = true; return result })
  try {
    await expect.poll(() => skiff.app.evaluate(() => Boolean(global.__releaseShellLoad))).toBe(true)
    expect(replied).toBe(false)
    expect(await skiff.app.evaluate(({ BrowserWindow }, id) => Boolean(BrowserWindow.fromId(id)), oldId)).toBe(true)
    expect(await page.evaluate(() => window.transitionIdentity)).toBe('retained')
    await skiff.app.evaluate(() => { global.__releaseShellLoad(); global.__restoreShellLoad() })
    expect((await switching).ok).toBe(true)
    expect(await skiff.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id), oldId)).toBeNull()
    await expect.poll(() => skiff.shell.url()).toContain('/shells/layer/index.html')
    expect((await skiff.state()).tabs.some((entry) => entry.id === tab.id)).toBe(true)
    expect(await page.evaluate(() => window.transitionIdentity)).toBe('retained')
  } finally {
    await skiff.app.evaluate(() => { global.__releaseShellLoad?.(); global.__restoreShellLoad?.() })
  }
})

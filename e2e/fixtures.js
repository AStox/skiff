'use strict'
const { test: base, expect, _electron } = require('@playwright/test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { writeArc } = require('./arc-fixture')

const test = base.extend({
  fixtureOptions: [{}, { option: true }],
  skiff: async ({ fixtureOptions }, use, testInfo) => {
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Visual tests currently support macOS and Linux')
    if (process.platform === 'darwin' && process.env.SKIFF_VISUAL_DESKTOP !== '1') throw new Error('Mac visual tests open desktop windows. Use a Linux virtual display, or explicitly set SKIFF_VISUAL_DESKTOP=1 only when the desktop is available for testing.')
    if (process.platform === 'linux' && process.getuid?.() === 0) throw new Error('Run visual tests as an unprivileged user with DISPLAY (for example xvfb-run -a npm run test:visual). Never disable the Electron sandbox.')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-visual-'))
    const home = path.join(root, 'home')
    const data = path.join(root, 'data')
    fs.mkdirSync(home)
    fs.mkdirSync(data)
    fs.mkdirSync(path.join(home, 'app-data'))
    fs.writeFileSync(path.join(root, '.skiff-visual-fixture'), 'owned by this test')
    // A supplied source-only legacy shell exercises the same startup migration
    // as an installed custom UI, inside this fixture's disposable profile.
    if (fixtureOptions.legacyShell) fs.cpSync(fixtureOptions.legacyShell, path.join(data, 'shell'), { recursive: true })
    const requests = []
    const identities = new Map()
    const cookied = []
    // The built-in extension's release, when fixtureOptions.builtin is set: `skiff.release.version` is what the
    // release page announces and the zip ships; null makes the release page answer 500.
    const release = { version: '1.0' }
    const releaseZip = () => {
      const stage = fs.mkdtempSync(path.join(root, 'release-'))
      const folder = path.join(stage, 'skiff-test')
      fs.cpSync(path.join(__dirname, 'extension'), folder, { recursive: true })
      const manifest = path.join(folder, 'manifest.json')
      fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: release.version }, null, 2))
      execFileSync('zip', ['-qr', 'release.zip', 'skiff-test'], { cwd: stage })
      const zip = fs.readFileSync(path.join(stage, 'release.zip'))
      fs.rmSync(stage, { recursive: true, force: true })
      return zip
    }
    const server = http.createServer((request, response) => {
      requests.push(request.url)
      identities.set(request.url, { userAgent: request.headers['user-agent'], clientHints: request.headers['sec-ch-ua'], platform: request.headers['sec-ch-ua-platform'] })
      if (request.headers.cookie) cookied.push(request.url)
      if (request.url === '/icon.png') {
        response.setHeader('Content-Type', 'image/png')
        response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4ZpxDEmIY1TCqYfhqAAC2hXUQMWFT7AAAAABJRU5ErkJggg==', 'base64'))
        return
      }
      const route = request.url.split('?')[0]
      if (['/pointer-fixture', '/drag-region-fixture', '/scroll-fixture', '/agent-form', '/tone-fixture', '/fullscreen-fixture'].includes(route)) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        return response.end(fs.readFileSync(path.join(__dirname, route.slice(1) + '.html')))
      }
      // The form, after its first byte comes late: an agent that opens it must wait for it, not answer with a blank tab.
      if (route === '/agent-slow') {
        return setTimeout(() => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fs.readFileSync(path.join(__dirname, 'agent-form.html'))) }, 1200)
      }
      if (route === '/download') {
        response.setHeader('Content-Type', 'text/plain')
        response.setHeader('Content-Disposition', 'attachment; filename="skiff-fixture.txt"')
        return response.end('A real isolated fixture download.\n')
      }
      if (route === '/article') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Set-Cookie', 'fixture-session=signed-in; Path=/; SameSite=Lax')
        return response.end(`<!doctype html><html lang="en"><head><title>Local Reading Article</title></head><body><nav>Fixture navigation</nav><article><h1>A useful local article</h1>${Array.from({ length: 12 }, (_, i) => `<p>Chapter ${i + 1}. Skiff keeps live pages and their sign-in sessions intact while browser tools change around them. This readable article contains enough real sentences for article extraction, native find, and reader tests. Needle appears in this paragraph.</p>`).join('')}</article><a href="/second" id="peek-link">Peek this link</a><a href="/download" id="download-link">Download fixture</a><input aria-label="Draft"></body></html>`)
      }
      if (route === '/identity/redirect') {
        response.writeHead(302, { Location: '/identity/target' })
        return response.end()
      }
      if (route.startsWith('/basic-auth')) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        if (request.headers.authorization === 'Basic ' + Buffer.from('ada:lovelace').toString('base64')) return response.end('<!doctype html><title>Secret page</title><h1 id="ok">Welcome Ada</h1>')
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Test"' })
        return response.end('<!doctype html><title>Denied</title><h1 id="denied">401 body</h1>')
      }

      if (route.startsWith('/ext/')) {
        if (route === '/ext/release') {
          if (release.version === null) { response.statusCode = 500; return response.end('no release') }
          response.setHeader('Content-Type', 'application/json')
          return response.end(JSON.stringify({ tag_name: release.version, assets: [{ name: 'skiff-test.chromium.zip', browser_download_url: `http://127.0.0.1:${server.address().port}/ext/release.zip` }] }))
        }
        if (route === '/ext/release.zip') {
          response.setHeader('Content-Type', 'application/zip')
          return response.end(releaseZip())
        }
        const script = (body) => { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(body) }
        // Only the extension's blocking webRequest listener keeps these two scripts away from the page.
        if (route === '/ext/blocked.js' || route === '/ext/redirect-me.js') return script("document.documentElement.dataset.unexpected = 'served'")
        if (route === '/ext/ok.js') return script("document.documentElement.dataset.ok = 'ran'")
        if (route === '/ext/hop') { response.statusCode = 302; response.setHeader('Location', '/ext/page?hopped'); return response.end() }
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'")
        if (route === '/ext/frame') return response.end('<!doctype html><p id="in-frame">frame</p>')
        return response.end('<!doctype html><html lang="en"><head><title>Extension fixture</title></head><body><h1>Extension fixture</h1><div id="hide-me">hide me</div><iframe src="/ext/frame"></iframe><script src="/ext/ok.js"></script><script src="/ext/blocked.js" onerror="document.documentElement.dataset.blocked=\'error\'" onload="document.documentElement.dataset.blocked=\'loaded\'"></script><script src="/ext/redirect-me.js" onerror="document.documentElement.dataset.redirect=\'error\'"></script></body></html>')
      }
      // Agent pages count interval ticks and animation frames on the page, show their cookies and open a link in a new tab.
      if (route.startsWith('/agent/')) {
        if (route === '/agent/set-cookie') response.setHeader('Set-Cookie', 'agent-session=shared; Path=/')
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
        return response.end(`<!doctype html><html lang="en"><head><title>Agent ${route.slice(7)}</title><style>body{margin:0;background:#2f9e5b;color:#fff;font:24px system-ui}h1{margin:40px}</style></head><body><h1>Agent fixture ${route}</h1><p id="cookie"></p><p id="counters"></p><a href="/agent/opened" target="_blank">Open in new tab</a><script>window.ticks = 0; window.rafs = 0; setInterval(() => { ticks++; document.getElementById('counters').textContent = 'ticks ' + ticks + ' frames ' + rafs }, 50); (function frame() { rafs++; requestAnimationFrame(frame) })(); document.getElementById('cookie').textContent = 'cookie: ' + document.cookie</script></body></html>`)
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:")
      response.end(`<!doctype html><html lang="en"><head><title>${request.url.startsWith('/second') ? 'Second fixture' : 'Fixture reading'}</title><link rel="icon" href="/icon.png"><style>body{font:18px system-ui;margin:36px;background:#fff;color:#172029}main{height:4000px;width:1600px}a{display:block;margin:24px 0}</style></head><body><h1>Local fixture page</h1><a href="/second">Continue reading</a><a href="/next${request.url}" target="_blank">Open in new tab</a><input aria-label="Page text" placeholder="Type here"><main>Scrollable fixture content</main></body></html>`)
    })
    let app
    let child
    let shell
    let stopping = null
    let closing = false
    const close = async () => {
      if (!app) return
      closing = true
      const owned = app
      const groupExists = () => {
        return execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' }).trim().split('\n').some((line) => {
          const [group, status] = line.trim().split(/\s+/)
          return Number(group) === child.pid && !status.startsWith('Z')
        })
      }
      let timer
      try {
        await Promise.race([owned.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron close timed out')), 10_000) })])
      } catch {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      } finally { clearTimeout(timer) }
      const deadline = Date.now() + 3000
      while (groupExists() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
      if (groupExists()) throw new Error(`Owned Electron process group ${child.pid} did not exit; preserving ${root}`)
      app = null
    }
    const cleanup = () => stopping ||= (async () => {
      let stopped = false
      try { await close(); stopped = true } finally {
        server.closeAllConnections()
        if (server.listening) await new Promise((resolve) => server.close(resolve))
        if (stopped) fs.rmSync(root, { recursive: true, force: true })
      }
    })()
    const interrupt = () => { void cleanup().finally(() => process.exit(130)) }
    const terminate = () => { void cleanup().finally(() => process.exit(143)) }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const port = server.address().port
      const origin = `http://127.0.0.1:${port}`
      writeArc(home, origin, fixtureOptions)
      // Identify the main native window, not a particular bundled or owned source filename.
      let shellUrl = ''
      const isShell = (page) => page.url() === shellUrl && !page.isClosed()
      const discoverShell = async () => {
        const url = await app.evaluate(({ BrowserWindow }) => {
          const candidates = global.__skiffVisualAudit.windows.filter((entry) => !entry.skipTaskbar)
          return candidates.map((entry) => BrowserWindow.fromId(entry.id)).filter(Boolean).findLast((window) => window.webContents.getURL().startsWith('file:'))?.webContents.getURL()
        })
        if (url) shellUrl = url
        return app.windows().some(isShell)
      }
      const useShell = (page) => {
        shell = page
        shell.setDefaultTimeout(8000)
        shell.setDefaultNavigationTimeout(15_000)
      }
      const launch = async (extraArgs = []) => {
        closing = false
        const env = { ...process.env, HOME: home, USERPROFILE: home, SKIFF_DATA: data, SKIFF_VISUAL_ROOT: root,
          SKIFF_VISUAL_PORT: String(port), SKIFF_VISUAL_CONSENT: String(fixtureOptions.consent || 0), SKIFF_VISUAL_THEME: fixtureOptions.theme || 'light',
          SKIFF_VISUAL_EXTENSIONS: fixtureOptions.extensions ? '1' : '0',
          // The real bb stays out of every run; a spec that wants machines puts a stub bb on the login shell's PATH and sets fixtureOptions.bb.
          SKIFF_BB: fixtureOptions.bb ? 'bb' : 'skiff-no-bb',
          // Built-ins are off unless a test asks for the fixture one, so no run contacts GitHub.
          SKIFF_BUILTIN_EXTENSIONS: fixtureOptions.builtin ? JSON.stringify([{ name: 'Skiff test extension', release: `${origin}/ext/release` }]) : '[]',
          LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC', XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') }
        delete env.SKIFF_VISUAL_COMPONENT_CONSENT
        delete env.SKIFF_VISUAL_PERMISSION_CONSENT
        delete env.SKIFF_VISUAL_STOP_FAILURE
        delete env.SKIFF_VISUAL_DESKTOPS
        if (fixtureOptions.desktops) env.SKIFF_VISUAL_DESKTOPS = fixtureOptions.desktops.join(',')
        if (fixtureOptions.stopFailure) env.SKIFF_VISUAL_STOP_FAILURE = '1'
        if (fixtureOptions.componentConsent !== undefined) env.SKIFF_VISUAL_COMPONENT_CONSENT = String(fixtureOptions.componentConsent)
        if (fixtureOptions.permissionConsent !== undefined) env.SKIFF_VISUAL_PERMISSION_CONSENT = String(fixtureOptions.permissionConsent)
        delete env.ELECTRON_RUN_AS_NODE
        app = await _electron.launch({ args: [path.join(__dirname, 'electron-entry.js'), ...(fixtureOptions.nativeScale ? [] : ['--force-device-scale-factor=1']), ...extraArgs], env, chromiumSandbox: true, timeout: 20_000 })
        app.on('window', (page) => page.on('domcontentloaded', () => {
          if (!closing && app && child?.exitCode === null) void discoverShell().catch((error) => { if (!closing) console.error('Unable to refresh fixture shell identity', error) })
        }))
        child = app.process()
        await app.firstWindow({ timeout: 15_000 })
        shellUrl = ''
        await expect.poll(discoverShell, { timeout: 15_000 }).toBe(true)
        useShell(app.windows().find(isShell))
        await shell.waitForLoadState('load')
        await shell.emulateMedia({ colorScheme: fixtureOptions.theme || 'light' })
        await expect.poll(async () => Boolean(await shell.evaluate(() => window.skiff?.call('state.get')))).toBe(true)
      }
      await launch()
      const driver = {
        get app() { return app }, root,
        // A switch between app and desk shells replaces the window, and with it the shell page.
        get shell() {
          const next = !isShell(shell) && app.windows().find(isShell)
          if (next) useShell(next)
          return shell
        }, home, data, origin, requests, identities, cookied, release,
        rpc: async (method, params) => {
          // Source activation can replace the invoking renderer before IPC resolves.
          if (['ui.resetShell', 'ui.safeMode', 'components.apply', 'components.enable', 'components.revert', 'components.bind'].includes(method)) {
            const out = await driver.http(method, params)
            if (!out.ok) throw new Error(`${method} [${out.error?.code || 'unknown'}]: ${out.error?.message || JSON.stringify(out.error)}`)
            await expect.poll(discoverShell, { timeout: 15_000 }).toBe(true)
            return out.result
          }
          // A desk shell has one window per macOS desktop, and one that goes takes its page with it.
          for (let attempt = 0; ; attempt++) {
            try {
              return await driver.shell.evaluate(async ({ method, params }) => {
                try { return await window.skiff.call(method, params) }
                catch (error) { throw new Error(`${method} [${error?.code || 'unknown'}]: ${error?.message || JSON.stringify(error)}`) }
              }, { method, params })
            } catch (error) {
              if (attempt >= 20 || !/Target page, context or browser has been closed/.test(error.message)) throw error
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          }
        },
        state: () => driver.rpc('state.get'),
        api: () => JSON.parse(fs.readFileSync(path.join(data, 'api.json'), 'utf8')),
        http: async (method, params = {}, token) => {
          const api = driver.api()
          const response = await fetch(`http://127.0.0.1:${api.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token || api.token}` }, body: JSON.stringify({ method, params }) })
          return response.json()
        },
        audit: () => app.evaluate(() => global.__skiffVisualAudit),
        close,
        restart: async ({ safeMode = false, beforeLaunch } = {}) => {
          await close()
          await beforeLaunch?.({ data, root })
          await launch(safeMode ? ['--safe-mode'] : [])
        },
        // The desk window is the one showing index.html; getAllWindows()[0] is the Buoy float.
        onDesk: (fn, arg) => app.evaluate(({ BrowserWindow }, { source, arg }) => {
          const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))
          return new Function(`return (${source})`)()(win, arg)
        }, { source: fn.toString(), arg }),
        attached: () => driver.onDesk((win) => win.contentView.children.length),
        page: async (path = '') => {
          const at = (page) => page.url().startsWith(origin + path)
          await expect.poll(() => app.context().pages().filter(at).length).toBeGreaterThan(0)
          return app.context().pages().find(at)
        },
        // The command bar is its own transparent page over the window, or the card of Layer's Buoy; it stays loaded after it closes.
        bar: async () => {
          const at = (page) => !page.isClosed() && /\/(palette|buoy)\.html$/.test(page.url())
          await expect.poll(() => app.context().pages().filter(at).length).toBeGreaterThan(0)
          const bar = app.context().pages().find(at)
          await bar.emulateMedia({ colorScheme: fixtureOptions.theme || 'light' })
          return bar
        },
        // Layer's card: the Buoy page with the card open (opened from the pill when it is shut); it holds the tab list, space strip, Settings and the Arc import dialog.
        card: async () => {
          const buoy = await driver.bar()
          const open = () => buoy.locator('#buoy').evaluate((el) => el.classList.contains('open') && !el.classList.contains('morphing'))
          if (!await open()) {
            await buoy.locator('#buoy-main').click()
            await expect.poll(open).toBe(true)
          }
          return buoy
        },
        // A desk shell replaces the app window, so the window is the one showing the shell; Layer's card is open once the Buoy has grown into it.
        barOpen: () => app.context().pages().find((page) => !page.isClosed() && page.url().endsWith('/buoy.html'))?.evaluate(() => document.getElementById('buoy').classList.contains('open')) ?? app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html')).contentView.children.some((view) => view.webContents?.getURL().endsWith('/palette.html'))),
        // A conversation tab is the bundled chat page in its own view; it stays loaded while its tab is hidden.
        chat: async (chatId) => {
          const at = (page) => page.url().includes(`/chat/chat.html?id=${chatId}`)
          await expect.poll(() => app.context().pages().filter(at).length).toBeGreaterThan(0)
          const page = app.context().pages().find(at)
          await page.emulateMedia({ colorScheme: fixtureOptions.theme || 'light' })
          return page
        },
        nativeKey: (page, key) => app.evaluate(({ webContents }, { url, key }) => {
          const wc = webContents.getAllWebContents().find((contents) => contents.getURL() === url)
          if (!wc) throw new Error(`No native surface for ${url}`)
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { wc.removeListener('before-input-event', received); reject(new Error(`Native ${key} did not reach before-input-event`)) }, 5000)
            const received = (event, input) => {
              if (input.type !== 'keyDown') return
              clearTimeout(timer)
              wc.removeListener('before-input-event', received)
              resolve({ key: input.key, prevented: event.defaultPrevented })
            }
            wc.on('before-input-event', received)
            wc.focus()
            wc.sendInputEvent({ type: 'keyDown', keyCode: key })
            wc.sendInputEvent({ type: 'keyUp', keyCode: key })
          })
        }, { url: page.url(), key }),
        // Clicking the menu item is what the accelerator does; synthetic key events never reach the native menu.
        shortcut: (accelerator) => app.evaluate(({ Menu }, accelerator) => Menu.getApplicationMenu().items.flatMap((menu) => menu.submenu?.items || []).find((item) => item.accelerator === accelerator).click(), accelerator),
        repairArc: (options = {}) => writeArc(home, origin, options)
      }
      await use(driver)
      const audit = await driver.audit()
      expect(audit.keychainAttempts, 'No test may attempt a real Keychain read').toEqual([])
    } finally {
      if (app && shell && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('shell-failure', { body: await shell.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' }).catch(() => {})
      }
      try { await cleanup() } finally {
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', terminate)
      }
    }
  }
})

async function snapshot(locator, name, options = {}) {
  // WebContentsView is a separate native surface, absent from shell screenshots.
  // Page navigation, input and scrolling are asserted separately, never faked.
  await expect(locator).toHaveScreenshot(name, options)
}
async function openImport(skiff) {
  const card = await skiff.card()
  await card.locator('#settings-toggle').click()
  await card.locator('#settings-page-skiff').click()
  await card.locator('#import-arc').click()
  await expect(card.locator('#arc-import')).toBeVisible()
  return card
}
async function next(skiff) { await (await skiff.bar()).locator('#arc-next').click() }
// The command bar is a separate page; typing must wait for its input to take focus.
async function barReady(skiff) {
  const bar = await skiff.bar()
  await expect(bar.locator('#palette-input')).toBeFocused()
  return bar
}
async function openInBar(skiff, url) {
  const bar = await barReady(skiff)
  await bar.keyboard.type(url)
  await bar.keyboard.press('Enter')
  await expect.poll(() => skiff.barOpen()).toBe(false)
}
async function wheel(page, dx, dy, selector = '#chips') {
  await page.locator(selector).hover()
  await page.mouse.wheel(dx, dy)
}
// Real elapsed time is intentional: gesture idle/inertia gates use event timing.
async function settleGesture(page) { await page.waitForTimeout(700) }

// Real pointer drags on a page (the Layer card): press on the source and start moving, so drop areas that appear after dragstart can be targeted.
async function dragStart(page, source) {
  // hover waits until the row stops moving; state pushes rebuild and shift rows while a page loads.
  await source.hover()
  const box = await source.evaluate((el) => el.getBoundingClientRect().toJSON())
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2 + 4, { steps: 2 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function dragOver(page, target, position = {}) {
  await expect(target).toBeVisible()
  const box = await target.evaluate((el) => el.getBoundingClientRect().toJSON())
  const point = { x: box.x + (position.x ?? box.width / 2), y: box.y + (position.y ?? box.height / 2) }
  // One straight move: passing other rows on the way leaves the preview where it first appeared, as it does for a person.
  await page.mouse.move(point.x, point.y)
  return point
}
async function dragTo(page, source, target, position) {
  await dragStart(page, source)
  await dragOver(page, target, position)
  await page.mouse.up()
}

module.exports = { test, expect, snapshot, openImport, next, wheel, settleGesture, dragStart, dragOver, dragTo, barReady, openInBar }

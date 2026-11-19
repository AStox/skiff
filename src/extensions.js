'use strict'
// Unpacked Chrome extensions, loaded into every persistent session from <data>/extensions.
// Electron implements webRequest, storage, content scripts and messaging itself; the APIs it lacks
// (tab and navigation events, windows, browserAction, privacy) are shimmed by preload-extension.js
// over IPC, with this module as the other end.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { net, webContents, webFrameMain, ipcMain, WebContentsView } = require('electron')

const err = (code, message) => Object.assign(new Error(message), { code })
const WINDOW_ID = 1
const MIN_POPUP = { width: 150, height: 60 }
// Built-in extensions are installed from their release page when missing and updated from it while Skiff runs.
const BUILTIN = [{ name: 'uBlock Origin', release: 'https://api.github.com/repos/gorhill/uBlock/releases/latest' }]
const CHECK_DELAY = 60e3
const CHECK_EVERY = 6 * 3600e3
const RETRY_MISSING = 5 * 60e3

function createExtensions({ dataDir, hooks, builtin = BUILTIN }) {
  const dir = path.join(dataDir, 'extensions')
  const preload = path.join(__dirname, 'preload-extension.js')
  const sessions = new Map()
  const loading = new Map()
  const css = new Map()
  let popup = null
  let popupOwner = null
  let timer = null
  let updating = null
  const builtins = builtin.map((b) => ({ name: b.name, release: b.release, state: 'installing', error: '' }))
  const builtinOf = (name) => builtins.find((b) => b.name === name)
  const folders = () => fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('.')).map((name) => path.join(dir, name)).filter((folder) => fs.existsSync(path.join(folder, 'manifest.json'))).sort() : []
  const manifestOf = (folder) => JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
  const info = (ext) => {
    const m = ext.manifest
    const action = m.browser_action || m.action || {}
    const b = builtinOf(ext.name)
    return { id: ext.id, name: ext.name, version: ext.version, description: m.description || '', path: ext.path, popup: action.default_popup || '', options: m.options_ui?.page || m.options_page || '', builtin: Boolean(b), state: b ? b.state : 'ready', error: b ? b.error : '' }
  }
  const mainSession = () => [...sessions].find(([, partition]) => partition === 'persist:main')?.[0] || [...sessions.keys()][0]
  const partitionOf = (ses) => sessions.get(ses) || ''
  const find = (id) => mainSession()?.extensions.getExtension(id)
  const byName = (name) => mainSession()?.extensions.getAllExtensions().find((x) => x.name === name) || null
  const listChanged = () => hooks.listChanged?.()

  async function load(ses, folder) {
    try {
      return await ses.extensions.loadExtension(folder, { allowFileAccess: false })
    } catch (e) {
      console.error(`Extension at ${folder} did not load: ${e.message}`)
      return null
    }
  }

  // Called for every persistent session Skiff creates; extensions are per session, so each gets its own copy.
  function attach(ses, partition) {
    if (!partition.startsWith('persist:') || sessions.has(ses)) return ready(ses)
    sessions.set(ses, partition)
    ses.registerPreloadScript({ type: 'frame', filePath: preload })
    const done = (async () => { for (const folder of folders()) await load(ses, folder) })()
    loading.set(ses, done)
    return done
  }
  // Resolves once the session's extensions are loaded; at once for sessions that have none.
  const ready = (ses) => loading.get(ses) || Promise.resolve()

  const extensionPages = (ses) => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === ses && wc.getURL().startsWith('chrome-extension://'))
  function emit(ses, name, ...args) {
    for (const wc of extensionPages(ses)) wc.send('skiff:extension-event', name, ...args)
  }

  const frameIdOf = (frame) => (frame && frame.parent ? frame.frameTreeNodeId : 0)
  const frameDetails = (wc, frame) => ({ tabId: wc.id, frameId: frameIdOf(frame), parentFrameId: frame?.parent ? frameIdOf(frame.parent) : -1, url: frame?.url || wc.getURL(), timeStamp: Date.now() })

  // Wires one tab's webContents to the event stream the extension pages of its session listen to.
  function watchTab(wc) {
    const ses = wc.session
    const tab = (extra = {}) => ({ ...hooks.tabInfo(wc.id), ...extra })
    emit(ses, 'tabs.onCreated', tab())
    wc.on('did-start-navigation', (event) => {
      if (!event.isMainFrame || event.isSameDocument) return
      emit(ses, 'webNavigation.onBeforeNavigate', { tabId: wc.id, frameId: 0, parentFrameId: -1, url: event.url, timeStamp: Date.now() })
      emit(ses, 'tabs.onUpdated', wc.id, { status: 'loading', url: event.url }, tab({ status: 'loading', url: event.url }))
    })
    wc.on('did-frame-navigate', (_e, url, _code, _text, isMainFrame, processId, routingId) => {
      const frame = isMainFrame ? wc.mainFrame : webFrameMain.fromId(processId, routingId)
      emit(ses, 'webNavigation.onCommitted', { ...frameDetails(wc, frame), url, transitionType: 'link', transitionQualifiers: [] })
      if (isMainFrame) emit(ses, 'tabs.onUpdated', wc.id, { url }, tab({ url }))
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame, processId, routingId) => {
      const frame = isMainFrame ? wc.mainFrame : webFrameMain.fromId(processId, routingId)
      emit(ses, 'webNavigation.onHistoryStateUpdated', { ...frameDetails(wc, frame), url, transitionType: 'link', transitionQualifiers: [] })
    })
    wc.on('dom-ready', () => emit(ses, 'webNavigation.onDOMContentLoaded', frameDetails(wc, wc.mainFrame)))
    wc.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
      const frame = isMainFrame ? wc.mainFrame : webFrameMain.fromId(processId, routingId)
      emit(ses, 'webNavigation.onCompleted', frameDetails(wc, frame))
      if (isMainFrame) emit(ses, 'tabs.onUpdated', wc.id, { status: 'complete' }, tab())
    })
    wc.on('page-title-updated', (_e, title) => emit(ses, 'tabs.onUpdated', wc.id, { title }, tab({ title })))
    wc.once('destroyed', () => {
      for (const key of [...css.keys()]) if (key.startsWith(`${wc.id}:`)) css.delete(key)
      emit(ses, 'tabs.onRemoved', wc.id, { windowId: WINDOW_ID, isWindowClosing: false })
    })
  }

  const activated = (wc) => emit(wc.session, 'tabs.onActivated', { tabId: wc.id, windowId: WINDOW_ID })
  const windowFocus = (focused) => { for (const ses of sessions.keys()) emit(ses, 'windows.onFocusChanged', focused ? WINDOW_ID : -1) }

  const windowInfo = () => ({ id: WINDOW_ID, focused: hooks.windowFocused(), incognito: false, type: 'normal', state: 'normal', alwaysOnTop: false, top: 0, left: 0, width: hooks.windowSize()[0], height: hooks.windowSize()[1] })
  function matchesUrl(patterns, url) {
    return [].concat(patterns).some((pattern) => {
      if (pattern === '<all_urls>') return /^(https?|file|ftp|chrome-extension):/.test(url)
      const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      return re.test(url)
    })
  }
  function queryTabs(query = {}) {
    const all = hooks.liveTabs().map((wc) => hooks.tabInfo(wc.id))
    return all.filter((t) => (query.active === undefined || t.active === query.active) && (query.url === undefined || matchesUrl(query.url, t.url)) && (query.windowId === undefined || query.windowId === WINDOW_ID || query.windowId === -2) && (query.title === undefined || matchesUrl(query.title, t.title)))
  }
  const framesOf = (wc) => [wc.mainFrame, ...wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame)]
  const frameInfo = (wc, frame) => ({ tabId: wc.id, frameId: frameIdOf(frame), parentFrameId: frame.parent ? frameIdOf(frame.parent) : -1, url: frame.url, errorOccurred: false, documentId: frame.frameTreeNodeId })
  const frameByKey = (wc, frameId) => (frameId ? framesOf(wc).find((f) => f.frameTreeNodeId === frameId) : wc.mainFrame)

  async function insertCSS(wc, details) {
    const frameId = details.frameId || 0
    const key = `${wc.id}:${frameId}:${details.code}`
    if (css.has(key)) return null
    if (frameId === 0) {
      css.set(key, await wc.insertCSS(details.code, { cssOrigin: details.cssOrigin || 'author' }))
      return null
    }
    const frame = frameByKey(wc, frameId)
    if (!frame) return null
    const token = `skiff-css-${css.size}-${Date.now()}`
    await frame.executeJavaScript(`(() => { const s = document.createElement('style'); s.dataset.skiff = ${JSON.stringify(token)}; s.textContent = ${JSON.stringify(details.code)}; (document.head || document.documentElement).append(s) })()`, true)
    css.set(key, token)
    return null
  }
  async function removeCSS(wc, details) {
    const frameId = details.frameId || 0
    const key = `${wc.id}:${frameId}:${details.code}`
    const token = css.get(key)
    css.delete(key)
    if (token === undefined) return null
    if (frameId === 0) await wc.removeInsertedCSS(token)
    else await frameByKey(wc, frameId)?.executeJavaScript(`document.querySelector('style[data-skiff=${JSON.stringify(token)}]')?.remove()`, true)
    return null
  }

  // The shim's IPC endpoint: only pages of a loaded extension may call it.
  ipcMain.handle('skiff:extension', (event, method, args) => {
    const from = event.senderFrame?.url || ''
    const id = from.startsWith('chrome-extension://') ? from.slice(19).split('/')[0] : ''
    if (!id || !event.sender.session.extensions.getExtension(id)) throw err('forbidden', 'Not an extension page')
    // Unknown tab ids answer null, as Chrome answers with lastError; extensions ask about their own pages too.
    const wcOf = (tabId) => { const wc = webContents.fromId(tabId); return wc && hooks.liveTabs().includes(wc) ? wc : null }
    const withTab = (tabId, fn) => { const wc = wcOf(tabId); return wc ? fn(wc) : null }
    switch (method) {
      case 'tabs.get': return withTab(args[0], (wc) => hooks.tabInfo(wc.id))
      case 'tabs.query': return queryTabs(args[0])
      case 'tabs.create': return hooks.createTab(args[0] || {}, event.sender)
      case 'tabs.remove': { for (const tabId of [].concat(args[0])) withTab(tabId, (wc) => hooks.closeTab(wc.id)); return null }
      case 'tabs.update': {
        const [tabId, props] = typeof args[0] === 'number' ? args : [queryTabs({ active: true })[0]?.id, args[0]]
        return withTab(tabId, (wc) => {
          if (props?.url) hooks.navigateTab(wc.id, props.url)
          if (props?.active) hooks.activateTab(wc.id)
          return hooks.tabInfo(wc.id)
        })
      }
      case 'tabs.insertCSS': return withTab(args[0], (wc) => insertCSS(wc, args[1] || {}))
      case 'tabs.removeCSS': return withTab(args[0], (wc) => removeCSS(wc, args[1] || {}))
      case 'webNavigation.getFrame': return withTab(args[0]?.tabId, (wc) => { const frame = frameByKey(wc, args[0].frameId || 0); return frame ? frameInfo(wc, frame) : null })
      case 'webNavigation.getAllFrames': return withTab(args[0]?.tabId, (wc) => framesOf(wc).map((frame) => frameInfo(wc, frame)))
      case 'windows.get': case 'windows.getCurrent': case 'windows.getLastFocused': case 'windows.update': return windowInfo()
      case 'windows.getAll': return [windowInfo()]
      case 'windows.create': { if (args[0]?.url) hooks.createTab({ url: args[0].url, active: true }, event.sender); return windowInfo() }
      case 'browserAction.getBadgeText': return ''
      default: return null
    }
  })

  // Built-ins come first, as a placeholder while one is not installed yet.
  function list() {
    const ses = mainSession()
    const loaded = ses ? ses.extensions.getAllExtensions().map(info) : []
    const placeholder = (b) => ({ id: '', name: b.name, version: '', description: '', path: '', popup: '', options: '', builtin: true, state: b.state, error: b.error })
    return [...builtins.map((b) => loaded.find((e) => e.name === b.name) || placeholder(b)), ...loaded.filter((e) => !e.builtin)]
  }

  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'extension'
  const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout))))
  const findManifest = (root) => {
    if (fs.existsSync(path.join(root, 'manifest.json'))) return root
    const inner = fs.readdirSync(root).map((name) => path.join(root, name)).filter((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'manifest.json')))
    if (inner.length !== 1) throw err('bad_params', 'No manifest.json in the extension folder')
    return inner[0]
  }

  // Copies an unpacked folder or a zip into <data>/extensions and loads it everywhere. An extension with the same name is
  // replaced under the same folder, which keeps its id and storage; the old copy comes back if the new one fails to load.
  async function add(source) {
    if (typeof source !== 'string' || !source) throw err('bad_params', 'path must name an unpacked extension folder or a zip file')
    const stat = fs.statSync(source, { throwIfNoEntry: false })
    if (!stat) throw err('not_found', `No such file: ${source}`)
    let scratch = null
    try {
      let unpacked = source
      if (stat.isFile()) {
        if (!/\.zip$/i.test(source)) throw err('bad_params', 'A file must be a .zip of an unpacked extension')
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-extension-'))
        await run('unzip', ['-q', '-o', source, '-d', scratch])
        unpacked = findManifest(scratch)
      } else unpacked = findManifest(source)
      const manifest = manifestOf(unpacked)
      if (typeof manifest.name !== 'string' || !manifest.name) throw err('bad_params', 'The manifest has no name')
      const target = path.join(dir, slug(manifest.name))
      const previous = path.join(dir, `.${slug(manifest.name)}.previous`)
      unload(target)
      fs.mkdirSync(dir, { recursive: true })
      fs.rmSync(previous, { recursive: true, force: true })
      if (fs.existsSync(target)) fs.renameSync(target, previous)
      fs.cpSync(unpacked, target, { recursive: true })
      const loadAll = async () => { let loaded = null; for (const ses of sessions.keys()) loaded = (await load(ses, target)) || loaded; return loaded }
      const loaded = await loadAll()
      if (!loaded) {
        fs.rmSync(target, { recursive: true, force: true })
        if (fs.existsSync(previous)) {
          fs.renameSync(previous, target)
          await loadAll()
        }
        throw err('bad_params', 'The extension did not load; see the log')
      }
      fs.rmSync(previous, { recursive: true, force: true })
      const b = builtinOf(loaded.name)
      if (b) Object.assign(b, { state: 'ready', error: '' })
      listChanged()
      return info(loaded)
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  function unload(folder) {
    for (const ses of sessions.keys()) {
      const loaded = ses.extensions.getAllExtensions().find((x) => x.path === folder)
      if (loaded) ses.extensions.removeExtension(loaded.id)
    }
    if (popupOwner === folder) closePopup()
  }

  // Unloads an extension from every session and deletes its folder.
  async function remove(id) {
    const ext = find(id)
    if (!ext) throw err('not_found', `No extension ${id}`)
    if (builtinOf(ext.name)) throw err('bad_params', `${ext.name} is built in`)
    unload(ext.path)
    if (ext.path.startsWith(dir + path.sep)) fs.rmSync(ext.path, { recursive: true, force: true })
    listChanged()
    return null
  }

  function fetch(url, { redirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
      const request = net.request({ url, partition: 'favicon-fetch', credentials: 'omit' })
      request.setHeader('User-Agent', 'Skiff')
      request.setHeader('Accept', 'application/octet-stream, application/vnd.github+json, */*')
      request.on('response', (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.on('data', () => {})
          response.on('end', () => (redirects ? fetch(new URL([].concat(response.headers.location)[0], url).href, { redirects: redirects - 1 }).then(resolve, reject) : reject(err('internal', 'Too many redirects'))))
          return
        }
        if (response.statusCode !== 200) return reject(err('not_found', `${url} answered ${response.statusCode}`))
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve(Buffer.concat(chunks)))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
  }

  // A release page (GitHub's "latest release" JSON) names its Chromium zip asset and version; any other address is the zip itself.
  async function resolve(url) {
    if (typeof url !== 'string' || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/.test(url)) throw err('bad_params', 'url must be an https address of a zip file or a release page')
    const body = await fetch(url)
    if (body[0] === 0x50 && body[1] === 0x4b) return { zip: body, version: '' }
    let release
    try { release = JSON.parse(body.toString('utf8')) } catch { throw err('bad_params', `${url} is neither a zip nor a release page`) }
    const assets = release.assets || []
    const asset = assets.find((a) => /chromium.*\.zip$/i.test(a.name)) || assets.find((a) => /\.zip$/i.test(a.name))
    if (!asset) throw err('not_found', 'The release has no zip asset')
    return { zipUrl: asset.browser_download_url, version: String(release.tag_name || '').replace(/^v/, '') }
  }

  async function install(resolved) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-extension-'))
    try {
      const file = path.join(scratch, 'extension.zip')
      fs.writeFileSync(file, resolved.zip || await fetch(resolved.zipUrl))
      return await add(file)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  // Downloads a zip and adds it; a release page resolves to its zip asset.
  const download = async (url) => install(await resolve(url))

  const newer = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number)
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
    return false
  }

  // Installs missing built-ins and replaces installed ones whose release page names a newer version; a release that
  // carries no version only installs. The folder path, and so the extension id and its storage, stay the same across versions.
  function update() {
    if (updating) return updating
    updating = (async () => {
      await ready(mainSession())
      for (const b of builtins) {
        const current = byName(b.name)
        try {
          const resolved = await resolve(b.release)
          if (!current || (resolved.version && newer(resolved.version, current.version))) {
            b.state = current ? 'updating' : 'installing'
            listChanged()
            await install(resolved)
          }
          b.state = 'ready'
          b.error = ''
        } catch (e) {
          b.state = 'failed'
          b.error = e.message
          console.warn(`${b.name}: ${e.message}`)
        }
        listChanged()
      }
      updating = null
      schedule()
      return list()
    })()
    return updating
  }

  function schedule(delay = builtins.some((b) => !byName(b.name)) ? RETRY_MISSING : CHECK_EVERY) {
    clearTimeout(timer)
    timer = setTimeout(update, delay)
  }

  // Called once the main session exists: a missing built-in is installed at once, present ones are checked after startup settles.
  function start() {
    if (!builtins.length) return
    ready(mainSession()).then(() => {
      const missing = builtins.some((b) => !byName(b.name))
      for (const b of builtins) b.state = byName(b.name) ? 'ready' : 'installing'
      schedule(missing ? 0 : CHECK_DELAY)
    })
  }

  // Opens one of the extension's own pages as a tab; the options page when none is named.
  function open(id, page) {
    const ext = find(id)
    if (!ext) throw err('not_found', `No extension ${id}`)
    const target = page || info(ext).options
    if (typeof target !== 'string' || !target) throw err('bad_params', 'This extension has no options page; pass page')
    return hooks.createTab({ url: new URL(target, ext.url).href, active: true }, null)
  }

  function closePopup() {
    if (!popup) return null
    const view = popup
    popup = null
    popupOwner = null
    hooks.detachView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    return null
  }

  // Shows the extension's action popup for the active tab in its own view, sized to its content inside bounds.
  async function showPopup(id, bounds) {
    const ext = find(id)
    if (!ext) throw err('not_found', `No extension ${id}`)
    const page = info(ext).popup
    const active = hooks.activeTabWebContents()
    if (!active) throw err('not_found', 'No active tab')
    const partition = partitionOf(active.session)
    if (!partition) throw err('not_found', 'Extensions do not run in the incognito space')
    if (!page) {
      emit(active.session, 'browserAction.onClicked', hooks.tabInfo(active.id))
      return null
    }
    closePopup()
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: false, nodeIntegration: false } })
    popup = view
    popupOwner = ext.path
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) hooks.createTab({ url, active: true }, null); return { action: 'deny' } })
    wc.on('blur', () => { if (popup === view) closePopup() })
    // Chrome sizes a popup to its content. Measured the same way: lay the page out narrow to learn the width it
    // needs, then at that width to learn its height, each clamped to the box the shell allowed.
    const width = 'document.documentElement.scrollWidth'
    const height = "Math.max(document.body.scrollHeight, ...[...document.body.children].map((e) => e.getBoundingClientRect().bottom + scrollY))"
    const measure = (what) => wc.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => resolve(${what})))`, true)
    const place = async () => {
      if (popup !== view || wc.isDestroyed()) return
      hooks.placeView(view, { ...bounds, width: MIN_POPUP.width })
      const w = Math.max(MIN_POPUP.width, Math.min(bounds.width, Math.ceil(await measure(width).catch(() => bounds.width))))
      if (popup !== view) return
      hooks.placeView(view, { ...bounds, width: w })
      const h = Math.max(MIN_POPUP.height, Math.min(bounds.height, Math.ceil(await measure(height).catch(() => bounds.height))))
      if (popup !== view) return
      hooks.placeView(view, { ...bounds, width: w, height: h })
    }
    wc.on('did-finish-load', place)
    hooks.attachView(view)
    hooks.placeView(view, { ...bounds, width: MIN_POPUP.width, height: MIN_POPUP.height })
    const url = new URL(page, ext.url)
    url.searchParams.set('tabId', String(active.id))
    await wc.loadURL(url.href).catch(() => {})
    wc.focus()
    setTimeout(place, 400)
    return info(ext)
  }

  return { dir, attach, ready, start, update, list, add, download, remove: (id) => remove(id), open, showPopup, closePopup, watchTab, activated, windowFocus, popupView: () => popup, tabInfoOf: (wcId) => hooks.tabInfo(wcId), partitionOf }
}

module.exports = { createExtensions }

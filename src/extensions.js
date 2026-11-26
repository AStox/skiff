'use strict'
// Unpacked Chrome extensions, loaded into every persistent session from <data>/extensions.
// Electron implements webRequest, storage, content scripts and messaging itself; the APIs it lacks
// (tab and navigation events, windows, browserAction, privacy) are shimmed by preload-extension.js
// over IPC, with this module as the other end.
const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { app, net, webContents, webFrameMain, ipcMain, WebContentsView } = require('electron')
const log = require('./log').scope('extensions')

const err = (code, message) => Object.assign(new Error(message), { code })
const WINDOW_ID = 1
const MIN_POPUP = { width: 150, height: 60 }
// Built-in extensions are installed from their release page when missing and updated from it while Skiff runs.
const BUILTIN = [{ name: 'uBlock Origin', release: 'https://api.github.com/repos/gorhill/uBlock/releases/latest' }]
const CHECK_DELAY = 60e3
const CHECK_EVERY = 6 * 3600e3
const RETRY_MISSING = 5 * 60e3
// A built-in extension's pages wait this long for its background page to start filtering, so a broken one never blocks browsing for good.
const READY_CAP = 15e3
// A page's first script waits this long for the background pages to take its navigation event.
const ACK_CAP = 300
const CRASH_WINDOW = 120e3
const CRASH_LIMIT = 5

function createExtensions({ dataDir, hooks, builtin = BUILTIN }) {
  const dir = path.join(dataDir, 'extensions')
  const preload = path.join(__dirname, 'preload-extension.js')
  const sessions = new Map()
  // Per session and extension folder: { state: starting | down | ready | failed, release, crashes }. Only built-ins hold page loads until ready.
  const running = new Map()
  const pending = new Map()
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
    const live = statusOf(ext.path)
    return { id: ext.id, name: ext.name, version: ext.version, description: m.description || '', path: ext.path, popup: action.default_popup || '', options: m.options_ui?.page || m.options_page || '', builtin: Boolean(b), state: live === 'failed' ? 'failed' : live === 'down' ? 'restarting' : b ? b.state : 'ready', error: live === 'failed' ? 'The background page keeps crashing' : b ? b.error : '' }
  }
  const mainSession = () => [...sessions].find(([, partition]) => partition === 'persist:main')?.[0] || [...sessions.keys()][0]
  const partitionOf = (ses) => sessions.get(ses) || ''
  const find = (id) => mainSession()?.extensions.getExtension(id)
  const byName = (name) => mainSession()?.extensions.getAllExtensions().find((x) => x.name === name) || null
  const listChanged = () => hooks.listChanged?.()

  const instancesOf = (ses) => { let m = running.get(ses); if (!m) running.set(ses, m = new Map()); return m }
  const statusOf = (folder) => { let worst = ''; for (const m of running.values()) { const s = m.get(folder)?.state; if (s === 'failed') return s; if (s === 'down') worst = s } return worst }
  function hold(ses, promise) {
    let set = pending.get(ses)
    if (!set) pending.set(ses, set = new Set())
    set.add(promise)
    promise.then(() => set.delete(promise))
  }
  function markReady(ses, folder) {
    const inst = running.get(ses)?.get(folder)
    if (!inst || inst.state === 'ready') return
    inst.state = 'ready'
    inst.release?.()
    listChanged()
  }
  function forget(ses, folder) {
    const inst = running.get(ses)?.get(folder)
    if (!inst) return
    running.get(ses).delete(folder)
    inst.release?.()
  }

  // Loads one folder into a session. A built-in holds the session's page loads until its background page reports it is
  // filtering (or READY_CAP passes); any other extension is ready once loaded.
  async function load(ses, folder, { crashes = [], crashed = false } = {}) {
    let name = ''
    try { name = manifestOf(folder).name } catch { /* load reports it */ }
    forget(ses, folder)
    const inst = { state: crashed ? 'down' : 'starting', crashes, release: null }
    instancesOf(ses).set(folder, inst)
    if (builtinOf(name)) {
      hold(ses, new Promise((resolve) => {
        const timer = setTimeout(() => { console.warn(`${name} did not report ready in ${READY_CAP / 1000}s in ${partitionOf(ses)}; loading pages anyway`); markReady(ses, folder) }, READY_CAP)
        inst.release = () => { clearTimeout(timer); inst.release = null; resolve() }
      }))
    }
    const t = Date.now()
    try {
      const loaded = await ses.extensions.loadExtension(folder, { allowFileAccess: false })
      log.info('extension loaded', { name: loaded.name, id: loaded.id, version: loaded.version, partition: partitionOf(ses), ms: Date.now() - t })
      if (!builtinOf(name) && running.get(ses)?.get(folder) === inst) markReady(ses, folder)
      return loaded
    } catch (e) {
      log.error('extension load failed', { folder: path.basename(folder), partition: partitionOf(ses), err: e.stack })
      console.error(`Extension at ${folder} did not load: ${e.message}`)
      if (running.get(ses)?.get(folder) === inst) forget(ses, folder)
      return null
    }
  }

  // Called for every persistent session Skiff creates; extensions are per session, so each gets its own copy.
  function attach(ses, partition) {
    if (!partition.startsWith('persist:') || sessions.has(ses)) return ready(ses)
    sessions.set(ses, partition)
    ses.registerPreloadScript({ type: 'frame', filePath: preload })
    log.debug('attach session', { partition })
    const done = (async () => { const t = Date.now(); const found = folders(); for (const folder of found) await load(ses, folder); log.info('extensions ready', { partition, folders: found.length, loaded: ses.extensions.getAllExtensions().length, ms: Date.now() - t }) })()
    hold(ses, done)
    return done
  }
  // Resolves once the session's extensions are loaded and the built-in ones filter; at once for sessions that have none.
  async function ready(ses) {
    while (pending.get(ses)?.size) await Promise.all([...pending.get(ses)])
  }

  // Electron never restarts a crashed or killed background page, and the session then filters nothing; reload that
  // extension in that session only (same folder, so the id and its storage stay) and hold page loads until it is back.
  function crashed(wc, reason) {
    const ses = wc.session
    const url = wc.getURL()
    if (!sessions.has(ses) || !url.startsWith('chrome-extension://')) return
    const ext = ses.extensions.getExtension(url.slice(19).split('/')[0])
    const inst = ext && running.get(ses)?.get(ext.path)
    if (!inst || inst.state === 'down' || inst.state === 'failed') return
    const now = Date.now()
    const crashes = [...inst.crashes.filter((t) => now - t < CRASH_WINDOW), now]
    console.error(`${ext.name} background page in ${partitionOf(ses)} is gone (${reason})`)
    ses.extensions.removeExtension(ext.id)
    if (popupOwner === ext.path) closePopup()
    if (crashes.length > CRASH_LIMIT) {
      forget(ses, ext.path)
      instancesOf(ses).set(ext.path, { state: 'failed', crashes, release: null })
      listChanged()
      return
    }
    load(ses, ext.path, { crashes, crashed: true }).then(listChanged)
    listChanged()
  }
  app.on('web-contents-created', (_e, wc) => {
    wc.on('render-process-gone', (_ev, details) => { if (wc.getType() === 'backgroundPage' && details.reason !== 'clean-exit') crashed(wc, details.reason) })
  })

  const extensionPages = (ses) => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === ses && wc.getURL().startsWith('chrome-extension://'))
  function emit(ses, name, ...args) {
    for (const wc of extensionPages(ses)) wc.send('skiff:extension-event', name, ...args)
  }
  // Sessions whose background pages missed an ack deadline: frames there stop waiting until one answers again, so a busy or hung extension costs one wait, not one per frame.
  const slow = new Set()
  // Like emit; the background pages also acknowledge, and the promise resolves once each has run its listeners, or after ACK_CAP.
  let ackSeq = 0
  const acks = new Map()
  function emitAcked(ses, name, details) {
    const all = extensionPages(ses)
    const pages = all.filter((wc) => wc.getType() === 'backgroundPage')
    for (const wc of all) if (!pages.includes(wc)) wc.send('skiff:extension-event', name, details)
    if (!pages.length) return Promise.resolve()
    return new Promise((resolve) => {
      const token = ++ackSeq
      let left = pages.length
      const finish = () => { clearTimeout(timer); acks.delete(token); resolve() }
      const timer = setTimeout(() => { slow.add(ses); finish() }, ACK_CAP)
      acks.set(token, () => { if (--left === 0) finish() })
      for (const wc of pages) wc.send('skiff:extension-event-acked', name, token, details)
    })
  }
  const frameStates = new WeakMap()
  const frameStateOf = (wc) => { let st = frameStates.get(wc); if (!st) frameStates.set(wc, st = { frames: new Map(), waiting: new Map() }); return st }

  const frameIdOf = (frame) => (frame && frame.parent ? frame.frameTreeNodeId : 0)
  const frameDetails = (wc, frame) => ({ tabId: wc.id, frameId: frameIdOf(frame), parentFrameId: frame?.parent ? frameIdOf(frame.parent) : -1, url: frame?.url || wc.getURL(), timeStamp: Date.now() })

  // Wires one tab's webContents to the event stream the extension pages of its session listen to.
  function watchTab(wc) {
    const ses = wc.session
    const tab = (extra = {}) => ({ ...hooks.tabInfo(wc.id), ...extra })
    emit(ses, 'tabs.onCreated', tab())
    // Chrome fires onBeforeNavigate for every frame and again for each redirect target. uBlock Origin builds a host's
    // scriptlets from it, so a redirect (youtube.com to www.youtube.com) or an iframe would commit with none.
    const beforeNavigate = (event) => {
      if (event.isSameDocument) return
      const frame = event.isMainFrame ? wc.mainFrame : event.frame
      if (frame) emit(ses, 'webNavigation.onBeforeNavigate', { ...frameDetails(wc, frame), url: event.url })
    }
    wc.on('did-redirect-navigation', beforeNavigate)
    wc.on('did-start-navigation', (event) => {
      beforeNavigate(event)
      if (!event.isMainFrame || event.isSameDocument) return
      emit(ses, 'tabs.onUpdated', wc.id, { status: 'loading', url: event.url }, tab({ status: 'loading', url: event.url }))
    })
    wc.on('did-frame-navigate', (_e, url, _code, _text, isMainFrame, processId, routingId) => {
      const frame = isMainFrame ? wc.mainFrame : webFrameMain.fromId(processId, routingId)
      const done = emitAcked(ses, 'webNavigation.onCommitted', { ...frameDetails(wc, frame), url, transitionType: 'link', transitionQualifiers: [] })
      const key = `${processId}:${routingId}`
      const st = frameStateOf(wc)
      st.frames.set(key, { url, done })
      for (const wake of st.waiting.get(key) || []) wake()
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
  // An extension sees the tabs of its own session only: its filters must not meet another profile's or the incognito space's pages.
  function queryTabs(query = {}, ses) {
    const all = hooks.liveTabs().filter((wc) => wc.session === ses).map((wc) => hooks.tabInfo(wc.id))
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

  ipcMain.on('skiff:extension-ack', (event, token) => {
    slow.delete(event.sender.session)
    acks.get(token)?.()
  })
  ipcMain.on('skiff:extension-ready', (event) => {
    const ses = event.sender.session
    const url = event.senderFrame?.url || ''
    const ext = event.sender.getType() === 'backgroundPage' && url.startsWith('chrome-extension://') ? ses.extensions.getExtension(url.slice(19).split('/')[0]) : null
    if (ext) markReady(ses, ext.path)
  })
  // A web page's first script waits here (sendSync from the frame preload) until the extensions' background pages have
  // taken the frame's webNavigation.onCommitted, so the scriptlets a blocker injects from it land before the page's own scripts.
  ipcMain.on('skiff:frame-start', (event, url) => {
    const wc = event.sender
    const reply = () => { event.returnValue = null }
    if (slow.has(wc.session) || !sessions.has(wc.session) || !extensionPages(wc.session).some((p) => p.getType() === 'backgroundPage')) return reply()
    const key = `${event.processId}:${event.frameId}`
    const st = frameStateOf(wc)
    const known = st.frames.get(key)
    if (known?.url === url) return void known.done.then(reply)
    const wake = () => {
      const entry = st.frames.get(key)
      if (entry?.url !== url) return
      cancel()
      entry.done.then(reply)
    }
    const cancel = () => { clearTimeout(timer); st.waiting.set(key, (st.waiting.get(key) || []).filter((fn) => fn !== wake)) }
    const timer = setTimeout(() => { cancel(); reply() }, ACK_CAP)
    st.waiting.set(key, [...(st.waiting.get(key) || []), wake])
  })

  // The shim's IPC endpoint: only pages of a loaded extension may call it.
  ipcMain.handle('skiff:extension', (event, method, args) => {
    const from = event.senderFrame?.url || ''
    const id = from.startsWith('chrome-extension://') ? from.slice(19).split('/')[0] : ''
    if (!id || !event.sender.session.extensions.getExtension(id)) throw err('forbidden', 'Not an extension page')
    // Unknown tab ids answer null, as Chrome answers with lastError; extensions ask about their own pages too.
    const wcOf = (tabId) => { const wc = webContents.fromId(tabId); return wc && wc.session === event.sender.session && hooks.liveTabs().includes(wc) ? wc : null }
    const withTab = (tabId, fn) => { const wc = wcOf(tabId); return wc ? fn(wc) : null }
    switch (method) {
      case 'tabs.get': return withTab(args[0], (wc) => hooks.tabInfo(wc.id))
      case 'tabs.query': return queryTabs(args[0], event.sender.session)
      case 'tabs.create': return hooks.createTab(args[0] || {}, event.sender)
      case 'tabs.remove': { for (const tabId of [].concat(args[0])) withTab(tabId, (wc) => hooks.closeTab(wc.id)); return null }
      case 'tabs.update': {
        const [tabId, props] = typeof args[0] === 'number' ? args : [queryTabs({ active: true }, event.sender.session)[0]?.id, args[0]]
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
    // While the main session has a crashed built-in unloaded (being reloaded, or given up on) the row stands in for it.
    const placeholder = (b) => {
      const live = statusOf(path.join(dir, slug(b.name)))
      return { id: '', name: b.name, version: '', description: '', path: '', popup: '', options: '', builtin: true, state: live === 'failed' ? 'failed' : live === 'down' ? 'restarting' : b.state, error: live === 'failed' ? 'The background page keeps crashing' : b.error }
    }
    return [...builtins.map((b) => loaded.find((e) => e.name === b.name) || placeholder(b)), ...loaded.filter((e) => !e.builtin)]
  }

  // Chromium derives an unpacked extension's id from its folder path, so its origin is known before it is loaded anywhere.
  const originOfPath = (p) => `chrome-extension://${crypto.createHash('sha256').update(p).digest('hex').slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)))}`
  // Origins of every installed extension: what a wipe of a session's site data must leave alone.
  function ownOrigins() {
    const origins = new Set()
    for (const folder of folders()) for (const p of new Set([folder, fs.realpathSync(folder)])) origins.add(originOfPath(p))
    for (const ses of sessions.keys()) for (const ext of ses.extensions.getAllExtensions()) origins.add(ext.url.replace(/\/+$/, ''))
    return [...origins]
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
    log.info('add extension', { source: path.basename(source), kind: stat.isFile() ? 'zip' : 'folder' })
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
      if (fs.existsSync(previous)) log.info('replacing extension', { name: manifest.name, version: manifest.version })
      fs.cpSync(unpacked, target, { recursive: true })
      const loadAll = async () => { const results = await Promise.all([...sessions.keys()].map((ses) => load(ses, target))); return results.find(Boolean) || null }
      const loaded = await loadAll()
      if (!loaded) {
        log.error('add failed, restoring previous', { name: manifest.name, hadPrevious: fs.existsSync(previous) })
        fs.rmSync(target, { recursive: true, force: true })
        if (fs.existsSync(previous)) {
          fs.renameSync(previous, target)
          await loadAll()
        }
        throw err('bad_params', 'The extension did not load; see the log')
      }
      fs.rmSync(previous, { recursive: true, force: true })
      await Promise.all([...sessions.keys()].map(ready))
      const b = builtinOf(loaded.name)
      if (b) Object.assign(b, { state: 'ready', error: '' })
      listChanged()
      log.info('extension added', { name: loaded.name, id: loaded.id, version: loaded.version })
      return info(loaded)
    } catch (e) {
      log.error('add extension failed', { err: e.stack })
      throw e
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  function unload(folder) {
    for (const ses of sessions.keys()) {
      const loaded = ses.extensions.getAllExtensions().find((x) => x.path === folder)
      if (loaded) ses.extensions.removeExtension(loaded.id)
      forget(ses, folder)
    }
    if (popupOwner === folder) closePopup()
  }

  // Unloads an extension from every session and deletes its folder.
  async function remove(id) {
    const ext = find(id)
    if (!ext) throw err('not_found', `No extension ${id}`)
    if (builtinOf(ext.name)) throw err('bad_params', `${ext.name} is built in`)
    log.info('remove extension', { id, name: ext.name })
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
      const t = Date.now()
      log.info('update check start', { builtins: builtins.length })
      for (const b of builtins) {
        const current = byName(b.name)
        try {
          const resolved = await resolve(b.release)
          log.debug('update check', { name: b.name, installed: current?.version ?? null, latest: resolved.version || null })
          if (!current || (resolved.version && newer(resolved.version, current.version))) {
            b.state = current ? 'updating' : 'installing'
            listChanged()
            await install(resolved)
            log.info('update installed', { name: b.name, from: current?.version ?? null, to: resolved.version || null })
          }
          b.state = 'ready'
          b.error = ''
        } catch (e) {
          b.state = 'failed'
          b.error = e.message
          console.warn(`${b.name}: ${e.message}`)
          log.warn('update failed', { name: b.name, err: e.stack })
        }
        listChanged()
      }
      log.info('update check done', { ms: Date.now() - t, states: builtins.map((b) => `${b.name}:${b.state}`) })
      updating = null
      schedule()
      return list()
    })()
    return updating
  }

  function schedule(delay = builtins.some((b) => !byName(b.name)) ? RETRY_MISSING : CHECK_EVERY) {
    clearTimeout(timer)
    log.debug('update scheduled', { delayMs: delay })
    timer = setTimeout(update, delay)
  }

  // Called once the main session exists: a missing built-in is installed at once, present ones are checked after startup settles.
  function start() {
    if (!builtins.length) return
    ready(mainSession()).then(() => {
      const missing = builtins.some((b) => !byName(b.name))
      log.info('start', { missing, builtins: builtins.length })
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
    if (!partition) throw err('not_found', 'Extensions are not available in this tab')
    if (!page) {
      emit(active.session, 'browserAction.onClicked', hooks.tabInfo(active.id))
      return null
    }
    closePopup()
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: false, nodeIntegration: false } })
    popup = view
    popupOwner = ext.path
    const wc = view.webContents
    wc.on('render-process-gone', (_e, details) => log.error('popup crashed', { id, reason: details.reason, exitCode: details.exitCode }))
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

  return { dir, attach, ready, ownOrigins, start, update, list, add, download, remove: (id) => remove(id), open, showPopup, closePopup, watchTab, activated, windowFocus, popupView: () => popup, tabInfoOf: (wcId) => hooks.tabInfo(wcId), partitionOf }
}

module.exports = { createExtensions }

'use strict'
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, dialog, safeStorage, net, clipboard, screen, systemPreferences } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { fileURLToPath, pathToFileURL } = require('node:url')
const S = require('./state')
const F = require('./favicons')
const { createImporter } = require('./importer')
const { createVault } = require('./migration')
const { watchShellFiles } = require('./watch-shell')
const { createExtensions } = require('./extensions')
const { createAi, browserTools, handleMcp } = require('./ai')

app.setName('Skiff')
if (process.env.SKIFF_DATA) app.setPath('userData', path.resolve(process.env.SKIFF_DATA))
const nativeUserAgent = app.userAgentFallback
app.userAgentFallback = nativeUserAgent.replace(new RegExp(` (Electron|${app.getName()})/\\S+`, 'gi'), '')
const compatibleUserAgent = app.userAgentFallback

const dataDir = app.getPath('userData')
const shellDir = path.join(dataDir, 'shell')
const stateFile = path.join(dataDir, 'state.json')
const faviconDir = path.join(dataDir, 'favicons')
const bundledShell = path.join(__dirname, '..', 'shell')
const bundledShells = path.join(__dirname, '..', 'shells')
const chatDir = path.join(__dirname, '..', 'chat')
const SPARKLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#8b5cf6" d="M8 0c.6 4.2 3.8 7.4 8 8-4.2.6-7.4 3.8-8 8-.6-4.2-3.8-7.4-8-8 4.2-.6 7.4-3.8 8-8z"/></svg>'
const shells = ['default', ...(fs.existsSync(bundledShells) ? fs.readdirSync(bundledShells).filter((name) => fs.existsSync(path.join(bundledShells, name, 'index.html'))).sort() : [])]
const CODES = ['unknown_method', 'bad_params', 'not_found']

let state
let browserIdentity
const identityForTab = (tab) => tab.browserIdentity || browserIdentity[tab.sessionPartition || 'persist:main'] || 'compatible'
let win = null
let deskMode = false
let attached = null
let shown = []
let pageBounds = null
let saveTimer = null
let pageVisible = true
let importer
let vault
let filling = false
let watcher = null
const overlays = new Map()
const frames = new Map()
// Frame view -> the state push it has seen.
const seen = new WeakMap()
let pushed = 0
let soonTimer = null
// A desk space switch in flight: view -> {from, to, leaving}, stepped from start.
let slide = null
let laidOutSpace = null
let heading = 0
let warmTimer = null
let frameSpec = null
const views = new Map()
const runtime = new Map()
const streams = new Set()
const chatViews = new WeakSet()
const agentViews = new WeakSet()
// Agent tabs live in this window, never shown or focused, except the one the user peeks at.
let agentWin = null
const PARKED = { x: 0, y: 0, width: 1280, height: 800 }
let popupBounds = null
const noDesk = () => ({ hit: [], capture: false, preview: null, animate: true, only: null })
let desk = noDesk()
let ignoring = false
let pointerTimer = null
// Skiff is in front while its desk window, or a floating overlay clicked after it, has the keyboard.
let inFront = false
let raisedAt = 0
let shellLoads = 0
let ai = null
let api = null

const tabOfContents = (wcId) => [...views].find(([, view]) => view.webContents.id === wcId)?.[0]
const extensions = createExtensions({
  dataDir,
  hooks: {
    liveTabs: () => [...views.values()].filter((view) => !chatViews.has(view)).map((view) => view.webContents).filter((wc) => !wc.isDestroyed()),
    activeTabWebContents: () => (attached && !chatViews.has(attached) ? attached.webContents : null),
    windowFocused: () => Boolean(win?.isFocused()),
    windowSize: () => (win ? win.getContentSize() : [0, 0]),
    tabInfo(wcId) {
      const id = tabOfContents(wcId)
      const tab = id ? S.findTab(state, id) : null
      const wc = views.get(id)?.webContents
      const peers = tab ? S.visibleTabs(state, tab.spaceId) : []
      return { id: wcId, windowId: 1, index: Math.max(0, peers.findIndex((t) => t.id === id)), active: attached?.webContents.id === wcId, highlighted: attached?.webContents.id === wcId, selected: attached?.webContents.id === wcId, pinned: Boolean(tab?.pinned || tab?.favorite), url: wc?.getURL() || tab?.url || '', title: wc?.getTitle() || tab?.title || '', status: wc?.isLoading() ? 'loading' : 'complete', incognito: Boolean(tab && S.isIncognito(state, tab.spaceId)), audible: false, discarded: false, autoDiscardable: true }
    },
    // An extension opening a page gets a tab beside the one it was called from, in that page's session.
    createTab(props, sender) {
      const opener = props.openerTabId !== undefined ? S.findTab(state, tabOfContents(props.openerTabId)) : null
      const active = S.activeTab(state)
      const partition = opener?.sessionPartition || (sender && extensions.partitionOf(sender.session)) || active?.sessionPartition || 'persist:main'
      const spaceId = opener?.spaceId || [...state.tabs].find((t) => t.sessionPartition === partition && !S.isIncognito(state, t.spaceId))?.spaceId || state.activeSpaceId
      const created = S.createTab(state, { url: props.url || 'about:blank', spaceId, parentId: opener?.id, activate: props.active !== false }, Date.now())
      created.sessionPartition = partition
      changed()
      const wc = views.get(created.id)?.webContents
      return wc ? extensions.tabInfoOf(wc.id) : { id: -1, windowId: 1, url: created.url, title: created.title, active: false }
    },
    closeTab: (wcId) => commands['tabs.close'].run({ id: tabOfContents(wcId) }),
    navigateTab: (wcId, url) => commands['tabs.navigate'].run({ id: tabOfContents(wcId), url }),
    activateTab: (wcId) => commands['tabs.activate'].run({ id: tabOfContents(wcId) }),
    attachView: (view) => win?.contentView.addChildView(view),
    detachView: (view) => win?.contentView.removeChildView(view),
    placeView: (view, bounds) => view.setBounds(edgeBounds(bounds)),
    listChanged: () => { for (const wc of shellContents()) wc.send('skiff:event', 'extensions-changed', null) }
  },
  // SKIFF_BUILTIN_EXTENSIONS, a JSON list of {name, release}, replaces the built-in set; "[]" turns it off.
  ...(process.env.SKIFF_BUILTIN_EXTENSIONS ? { builtin: JSON.parse(process.env.SKIFF_BUILTIN_EXTENSIONS) } : {})
})

function loadState() {
  if (!fs.existsSync(stateFile)) return S.load()
  try {
    return S.load(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
  } catch {
    fs.renameSync(stateFile, `${stateFile}.bad-${Date.now()}`)
    return S.load()
  }
}

function flush() {
  clearTimeout(saveTimer)
  saveTimer = null
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(S.persistable(state)))
  fs.renameSync(`${stateFile}.tmp`, stateFile)
}

function save() {
  saveTimer ??= setTimeout(flush, 500)
}

const live = (t) => ({ loading: false, canGoBack: false, canGoForward: false, ...t, ...runtime.get(t.id) })
// Whether wheel deltas follow the fingers (macOS "natural scrolling"); an absent setting is the macOS default, on.
// ponytail: read once at launch; a change in System Settings applies after a restart.
const naturalScroll = process.platform !== 'darwin' || (() => {
  try { return require('node:child_process').execFileSync('defaults', ['read', '-g', 'com.apple.swipescrolldirection'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '0' } catch { return true }
})()
const snapshot = () => ({ ...state, shells, naturalScroll, deskOnly: desk.only, tabs: state.tabs.map(live), agentTabs: state.agentTabs.map(live) })
const sseFrame = (snap) => `event: state\ndata: ${JSON.stringify(snap)}\n\n`

// Frames hear about state only while shown, so a push costs the shown windows; catchUpFrames serves one that shows again.
function pushState() {
  clearTimeout(soonTimer)
  soonTimer = null
  // ponytail: full snapshot per change; send patches if state grows past a few hundred tabs
  const snap = snapshot()
  pushed++
  for (const wc of [win?.webContents, ...[...overlays.values()].map((o) => o.host.webContents), ...chatContents()]) wc?.send('skiff:event', 'state', snap)
  for (const view of shown) {
    if (!seen.has(view)) continue
    view.webContents.send('skiff:event', 'state', snap)
    seen.set(view, pushed)
  }
  for (const res of streams) res.write(sseFrame(snap))
}

function changed() {
  save()
  syncView()
  pushState()
  if (deskMode) warmTimer ??= setTimeout(prewarm, 500)
}

// A loading page reports titles, icons and progress in bursts, so those reach the shells at most once a frame.
function changedSoon() {
  save()
  soonTimer ??= setTimeout(pushState, 16)
}

function catchUpFrames() {
  const late = shown.filter((view) => seen.has(view) && seen.get(view) !== pushed)
  if (!late.length) return
  const snap = snapshot()
  for (const view of late) {
    view.webContents.send('skiff:event', 'state', snap)
    seen.set(view, pushed)
  }
}

function unshow(view) {
  const move = slide?.moves.get(view)
  slide?.moves.delete(view)
  if (!shown.includes(view) && !move?.leaving) return
  win.contentView.removeChildView(view)
  shown = shown.filter((v) => v !== view)
}

function destroyView(id) {
  const view = views.get(id)
  views.delete(id)
  runtime.delete(id)
  unshow(view)
  if (agentViews.has(view)) agentWin?.contentView.removeChildView(view)
  if (attached === view) attached = null
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

function destroyFrame(id) {
  const view = frames.get(id)
  frames.delete(id)
  unshow(view)
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

function shellView() {
  const view = new WebContentsView({ webPreferences: { ...shellWebPreferences, transparent: true } })
  view.setBackgroundColor('#00000000')
  guardShell(view.webContents)
  return view
}

// macOS's panel type floats over full-screen apps without activating Skiff; the default process transform would hide the Dock icon.
function floatWindow() {
  const host = new BrowserWindow({
    show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hiddenInMissionControl: true, acceptFirstMouse: true, roundedCorners: false, backgroundColor: '#00000000',
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}), webPreferences: shellWebPreferences
  })
  host.setAlwaysOnTop(true, 'floating')
  host.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  guardShell(host.webContents)
  host.on('blur', focusLeft)
  return host
}

function createFrame(id) {
  const view = shellView()
  view.webContents.loadFile(path.join(shellDir, frameSpec.file), { query: { tab: id } }).catch(() => {})
  frames.set(id, view)
  // It asks for the state itself once loaded.
  seen.set(view, pushed)
  return view
}

function readFrame(shellJson) {
  const f = shellJson?.frame
  if (!S.isObject(f) || typeof f.file !== 'string' || f.file !== path.basename(f.file) || !fs.statSync(path.join(shellDir, f.file), { throwIfNoEntry: false })?.isFile()) return null
  const inset = (key) => (Number.isFinite(f[key]) && f[key] >= 0 ? f[key] : 0)
  return { file: f.file, top: inset('top'), right: inset('right'), bottom: inset('bottom'), left: inset('left') }
}

// A conversation tab shows the bundled chat page with the shell's bridge; the core owns its title and icon.
function createChatView(tab) {
  const view = new WebContentsView({ webPreferences: shellWebPreferences })
  const wc = view.webContents
  guardShell(wc)
  wc.on('before-mouse-event', (_e, mouse) => {
    if (deskMode && mouse.type === 'mouseDown' && views.get(tab.id) === view && state.peek !== tab.id && (state.peek || S.activeTab(state)?.id !== tab.id)) commands['tabs.activate'].run({ id: tab.id })
  })
  wc.loadFile(path.join(chatDir, 'chat.html'), { query: { id: tab.url.slice('skiff://chat/'.length) } }).catch(() => {})
  chatViews.add(view)
  views.set(tab.id, view)
  return view
}

function createView(tab) {
  if (tab.chat) return createChatView(tab)
  const { id } = tab
  const partition = tab.sessionPartition || 'persist:main'
  const ses = getSession(partition)
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, ...(tab.agent && { backgroundThrottling: false }) } })
  if (tab.agent) {
    agentViews.add(view)
    view.webContents.on('dom-ready', () => wake(view))
  }
  const wc = view.webContents
  wc.setUserAgent(identityForTab(tab) === 'native' ? nativeUserAgent : compatibleUserAgent)
  extensions.watchTab(wc)
  const update = (fields, live) => {
    const t = S.findTab(state, id)
    if (!t || views.get(id) !== view) return
    Object.assign(t, fields)
    runtime.set(id, { ...runtime.get(id), ...live })
    changedSoon()
  }
  const navigated = (fields) => {
    const history = { canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }
    update(/^https?:/.test(wc.getURL()) ? { url: wc.getURL(), ...fields } : {}, history)
    wc.send('skiff:swipe-page', { back: history.canGoBack, forward: history.canGoForward })
  }
  wc.on('page-title-updated', (_e, title) => update({ title: title.slice(0, 300) }))
  let origin = F.originOf(tab.url)
  wc.on('page-favicon-updated', async (_e, urls) => {
    const url = urls.find((u) => /^https?:/.test(u))
    const t = S.findTab(state, id)
    if (!url || !t) return
    const from = origin
    const fetch = (u, init) => wc.session.fetch(u, init)
    const favicon = await (S.isIncognito(state, t.spaceId) ? F.dataIcon(fetch, url, wc.getURL()) : F.saveIcon(faviconDir, fetch, url, wc.getURL())).catch(() => '')
    if (favicon && origin === from && favicon !== S.findTab(state, id)?.favicon) update({ favicon })
  })
  // Pinch is a visual zoom, as in Chrome on the Mac; Ctrl+wheel steps the page zoom.
  const pinch = () => wc.setVisualZoomLevelLimits(1, 3).catch(() => {})
  pinch()
  // A trackpad sends Ctrl+scroll as a burst of events, so one step per 150 ms.
  let zoomedAt = 0
  wc.on('zoom-changed', (_e, dir) => {
    if (Date.now() - zoomedAt < 150) return
    zoomedAt = Date.now()
    zoomStep(wc, dir === 'in' ? 1 : -1)
  })
  wc.on('did-navigate', () => {
    pinch()
    const next = F.originOf(wc.getURL())
    navigated(next === origin ? {} : { favicon: '' })
    origin = next
  })
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame && navigated())
  // A page view takes its own clicks, so the shell never sees a click on a desk window behind the active one; a click on any window but the peeked one ends a peek.
  wc.on('before-mouse-event', (_e, mouse) => {
    if (deskMode && mouse.type === 'mouseDown' && views.get(id) === view && state.peek !== id && (state.peek || S.activeTab(state)?.id !== id)) commands['tabs.activate'].run({ id })
  })
  wc.on('did-start-loading', () => update({}, { loading: true }))
  wc.on('did-stop-loading', () => update({}, { loading: false }))
  wc.on('will-navigate', (e) => {
    if (!/^(https?|chrome-extension):/.test(e.url)) e.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    const opener = S.findTab(state, id)
    if (opener?.agent && /^https?:/i.test(url)) {
      S.createTab(state, { url, spaceId: opener.spaceId, agent: opener.agent }, Date.now())
      changed()
    } else if (opener && /^https?:/i.test(url)) {
      const created = S.createTab(state, { url, spaceId: opener.spaceId, parentId: opener.id, activate: false }, Date.now())
      created.sessionPartition = opener.sessionPartition || 'persist:main'
      if (S.activeTab(state) === opener) S.activateTab(state, { id: created.id }, Date.now())
      changed()
    }
    return { action: 'deny' }
  })
  // The first page of a session waits for its extensions, so a blocker is in place before anything loads.
  extensions.ready(ses).then(() => { if (!wc.isDestroyed()) wc.loadURL(tab.url).catch(() => {}) })
  views.set(id, view)
  return view
}

const PAGE_JS = `(() => ({ title: document.title, url: location.href, selection: String(getSelection() || ''), text: document.body ? document.body.innerText.slice(0, 20000) : '' }))()`

// The agent reads a tab's page; one that is not loaded gets a view in the background, as prewarm does, and is read once it stops loading.
async function readTab(tab) {
  const wc = (views.get(tab.id) || createView(tab)).webContents
  await new Promise((resolve) => {
    const done = () => {
      if (!wc.isDestroyed() && (wc.isLoading() || !/^https?:/.test(wc.getURL()))) return
      wc.off('did-stop-loading', done)
      resolve()
    }
    wc.on('did-stop-loading', done)
    done()
  })
  return wc.executeJavaScript(PAGE_JS)
}

function pageText(tabId) {
  const tab = tabId === undefined ? S.activeTab(state) : S.findTab(state, tabId)
  const wc = tab && !S.isIncognito(state, tab.spaceId) && views.get(tab.id)?.webContents
  return wc && !wc.isDestroyed() && /^https?:/.test(wc.getURL()) ? wc.executeJavaScript(PAGE_JS) : null
}

const mcpTools = browserTools({ state: () => state, call, readTab })

function pushAi(name, data) {
  if (name === 'chat') {
    const loading = data.status === 'running'
    if (Boolean(runtime.get(data.tabId)?.loading) !== loading) {
      runtime.set(data.tabId, { ...runtime.get(data.tabId), loading })
      changedSoon()
    }
    const view = views.get(data.tabId)
    if (view && chatViews.has(view)) view.webContents.send('skiff:event', 'chat', data)
  } else {
    for (const wc of [...shellContents(), ...chatContents()]) wc.send('skiff:event', name, data)
  }
  for (const res of streams) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
function zoomStep(wc, delta) {
  const now = wc.getZoomFactor()
  const factor = delta === 0 ? 1 : delta > 0 ? ZOOMS.find((z) => z > now + 1e-3) ?? now : ZOOMS.findLast((z) => z < now - 1e-3) ?? now
  wc.setZoomFactor(factor)
  return factor
}

// session.fetch does not report the final URL after redirects, and relative icon links resolve against it.
function pageFetch(url, { signal }) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, partition: 'favicon-fetch', credentials: 'omit' })
    request.on('redirect', (_status, _method, next) => {
      url = next
    })
    request.on('response', (res) => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, url, body: res }))
    request.on('error', reject)
    signal.addEventListener('abort', () => {
      request.abort()
      reject(signal.reason)
    })
    request.end()
  })
}

const prefetchIcons = F.createPrefetch({ dir: faviconDir, fetch: pageFetch, tabs: () => S.persistable(state).tabs, changed })

function deskLayout() {
  if (!pageVisible) return []
  const tabs = S.shownTabs(state).filter((t) => !desk.only || desk.only.includes(t.id))
  const preview = desk.preview && S.findTab(state, desk.preview.id)
  const peeked = S.findTab(state, state.peek)
  if (preview && preview !== peeked && preview.spaceId === state.activeSpaceId && !tabs.includes(preview)) tabs.push(preview)
  if (peeked) {
    peeked.desk ??= { ...S.deskLayouts(state).center, z: 0 }
    tabs.push(peeked)
  }
  const radius = Math.round(10 * win.webContents.getZoomFactor())
  const f = frameSpec
  return tabs.map((t) => {
    const r = t === preview ? desk.preview : t.desk || S.defaultDesk(state, t)
    return { tab: t, bounds: toDip(r), radius, frame: f && toDip({ x: r.x - f.left, y: r.y - f.top, width: r.width + f.left + f.right, height: r.height + f.top + f.bottom }) }
  })
}

// The foreground set keeps the windows still on the desk and takes in the active one; it ends with its last window or a space switch.
function trimOnly() {
  const ids = S.shownTabs(state).map((t) => t.id)
  const kept = desk.only.filter((id) => ids.includes(id))
  const active = state.activeTabBySpace[state.activeSpaceId]
  const next = !kept.length ? null : kept.includes(active) || !ids.includes(active) ? kept : [...kept, active]
  if (JSON.stringify(next) === JSON.stringify(desk.only)) return
  desk.only = next
  soonTimer ??= setTimeout(pushState, 16)
}

// Page views sit below every other child, back to front, each desk window's frame just under its page, so overlays and popups stay on top.
function syncView() {
  for (const id of [...views.keys()]) if (!S.findTab(state, id)) destroyView(id)
  for (const id of [...frames.keys()]) if (!S.findTab(state, id)) destroyFrame(id)
  if (!win) return parkAgents()
  if (deskMode) {
    const zoom = win.webContents.getZoomFactor()
    const [width, height] = win.getContentSize()
    state.deskSize = { width: width / zoom, height: height / zoom }
    state.deskTop = frameSpec?.top || 0
  } else {
    delete state.deskSize
    delete state.deskTop
  }
  const switched = deskMode && laidOutSpace !== null && laidOutSpace !== state.activeSpaceId
  const order = (id) => state.spaces.findIndex((x) => x.id === id)
  const dir = heading || Math.sign(order(state.activeSpaceId) - order(laidOutSpace)) || 1
  heading = 0
  laidOutSpace = deskMode ? state.activeSpaceId : null
  // A drag belongs to the space it started in, so a switch ends it where it is.
  if (switched && desk.preview) {
    desk.preview = null
    for (const wc of shellContents()) wc.send('skiff:event', 'drag-cancel', null)
  }
  if (deskMode && desk.only) trimOnly()
  const tab = S.findTab(state, state.peek) || S.activeTab(state)
  const placed = deskMode ? deskLayout() : tab && pageBounds && pageVisible ? [{ tab, bounds: pageBounds, radius: pageBounds.radius }] : []
  // ponytail: hidden tabs stay live in memory; discard idle hidden views when memory matters
  const items = placed.flatMap((p) => [
    ...(p.frame ? [{ tab: p.tab, view: frames.get(p.tab.id) || createFrame(p.tab.id), bounds: p.frame }] : []),
    { tab: p.tab, view: views.get(p.tab.id) || createView(p.tab), bounds: p.bounds, radius: p.radius }
  ])
  const next = items.map((item) => item.view)
  if (switched && pageVisible && motion()) beginSlide(items, dir)
  else if (switched || !pageVisible) endSlide()
  if (next.length !== shown.length || next.some((view, i) => view !== shown[i])) {
    for (const view of shown) if (!next.includes(view) && !slide?.moves.get(view)?.leaving) win.contentView.removeChildView(view)
    next.forEach((view, i) => {
      if (agentViews.has(view)) agentWin?.contentView.removeChildView(view)
      win.contentView.addChildView(view, i)
    })
    shown = next
  }
  for (const { tab: t, view, bounds, radius } of items) {
    const move = slide?.moves.get(view)
    // A window being dragged follows the pointer, not the slide.
    if (move && desk.preview?.id === t.id) slide.moves.delete(view)
    else if (move) move.to = bounds
    if (!slide?.moves.has(view)) view.setBounds(bounds)
    if (radius !== undefined) view.setBorderRadius(radius)
  }
  if (switched && slide) stepSlide()
  if (next.some((view) => seen.has(view) && seen.get(view) !== pushed)) queueMicrotask(catchUpFrames)
  const view = tab && next.includes(views.get(tab.id)) ? views.get(tab.id) : null
  if (attached !== view) {
    attached = view
    if (view) extensions.activated(view.webContents)
  }
  parkAgents()
}

function parkAgents() {
  if (!state.agentTabs.length) {
    agentWin?.destroy()
    agentWin = null
    return
  }
  agentWin ??= new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: PARKED.width, height: PARKED.height, paintWhenInitiallyHidden: true })
  for (const tab of state.agentTabs) {
    const view = views.get(tab.id) || createView(tab)
    if (shown.includes(view) || agentWin.contentView.children.includes(view)) continue
    agentWin.contentView.addChildView(view)
    view.setBounds(PARKED)
  }
}

// A page that was never in a visible window gets no frames (no requestAnimationFrame, nothing to capture); an unpainted visit starts them.
function wake(view) {
  if (!win?.isVisible() || !agentWin?.contentView.children.includes(view)) return
  agentWin.contentView.removeChildView(view)
  win.contentView.addChildView(view, 0)
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  win.contentView.removeChildView(view)
  agentWin.contentView.addChildView(view)
  view.setBounds(PARKED)
}

const SLIDE_MS = 240
const motion = () => desk.animate && !systemPreferences.getAnimationSettings().prefersReducedMotion

// As macOS Spaces: the old space's windows leave the way the swipe went while the new space's come in from the other side; a switch mid-slide starts from wherever each window is.
function beginSlide(items, dir) {
  const [width] = win.getContentSize()
  const shift = (r, by) => ({ ...r, x: r.x + by })
  const old = slide?.moves || new Map()
  clearInterval(slide?.timer)
  const coming = new Set(items.map((item) => item.view))
  const moves = new Map()
  for (const view of [...shown, ...old.keys()]) {
    if (coming.has(view) || moves.has(view) || agentViews.has(view)) continue
    const was = old.get(view)
    moves.set(view, { from: view.getBounds(), to: was?.leaving ? was.to : shift(was?.to || view.getBounds(), -dir * width), leaving: true })
  }
  for (const { view, bounds } of items) moves.set(view, { from: shown.includes(view) || old.has(view) ? view.getBounds() : shift(bounds, dir * width), to: bounds, leaving: false })
  const frame = 1000 / (screen.getDisplayMatching(win.getBounds()).displayFrequency || 60)
  // Started a frame ago, so the step syncView takes at once already moves.
  slide = { moves, start: performance.now() - frame, timer: setInterval(stepSlide, frame) }
}

function stepSlide() {
  const t = Math.min(1, (performance.now() - slide.start) / SLIDE_MS)
  if (t === 1) return endSlide()
  const e = 1 - (1 - t) ** 3
  const at = (a, b) => Math.round(a + (b - a) * e)
  for (const [view, { from, to }] of slide.moves) view.setBounds({ x: at(from.x, to.x), y: at(from.y, to.y), width: at(from.width, to.width), height: at(from.height, to.height) })
}

function endSlide() {
  if (!slide) return
  clearInterval(slide.timer)
  const { moves } = slide
  slide = null
  for (const [view, move] of moves) {
    if (!move.leaving) view.setBounds(move.to)
    else if (win && !shown.includes(view)) win.contentView.removeChildView(view)
  }
}

// Every space's windows load in the background a few at a time, so a first switch to a space never waits for a page.
function prewarm() {
  clearTimeout(warmTimer)
  warmTimer = null
  if (!win || !deskMode) return
  const cold = state.spaces.flatMap((space) => S.shownTabs(state, space.id)).filter((t) => !views.has(t.id) || (frameSpec && !frames.has(t.id)))
  for (const t of cold.slice(0, 3)) {
    if (!views.has(t.id)) createView(t)
    if (frameSpec && !frames.has(t.id)) createFrame(t.id)
  }
  if (cold.length > 3) warmTimer = setTimeout(prewarm, 100)
}

function inDir(dir, url) {
  try {
    return fileURLToPath(url).startsWith(dir + path.sep)
  } catch {
    return false
  }
}
const inShell = (url) => inDir(shellDir, url)

const shellContents = () => [win?.webContents, ...[...overlays.values()].map((o) => o.host.webContents), ...[...frames.values()].map((view) => view.webContents)].filter(Boolean)
const chatContents = () => [...views.values()].filter((view) => chatViews.has(view)).map((view) => view.webContents)
const shellWebPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }

function guardShell(wc) {
  wc.on('will-navigate', (e) => {
    if (!inShell(e.url)) e.preventDefault()
  })
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function reloadShell() {
  for (const id of [...frames.keys()]) destroyFrame(id)
  for (const [name, o] of [...overlays]) if (o.float) hideOverlay(name)
  frameSpec = deskMode ? readFrame(manifest()) : null
  for (const wc of shellContents()) wc.reloadIgnoringCache()
}

function watchShell() {
  watcher?.close()
  watcher = watchShellFiles(shellDir, reloadShell)
}

// Copies over the live folder so the watcher keeps its handle; overlays and frames are dropped because their pages may not exist in the new shell.
function installShell(name) {
  const source = name === 'default' ? bundledShell : path.join(bundledShells, name)
  const wanted = new Set(fs.readdirSync(source, { recursive: true }).map(String))
  for (const entry of fs.readdirSync(shellDir, { recursive: true }).map(String).sort((a, b) => b.length - a.length)) {
    if (!wanted.has(entry)) fs.rmSync(path.join(shellDir, entry), { recursive: true, force: true })
  }
  fs.cpSync(source, shellDir, { recursive: true, force: true })
  state.settings.shell = name
  save()
  closeShellViews()
  setWindowButtons(true)
  watchShell()
  if (win && shellIsDesk() !== deskMode) recreateWindow()
  else reloadShell()
  buildMenu()
  changed()
}

function closeShellViews() {
  for (const name of [...overlays.keys()]) hideOverlay(name)
  for (const o of overlays.values()) o.host.webContents.close()
  overlays.clear()
  for (const id of [...frames.keys()]) destroyFrame(id)
}

function manifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(shellDir, 'shell.json'), 'utf8'))
  } catch {
    return null
  }
}

const shellIsDesk = () => manifest()?.window === 'desk'

// The new window opens before the old one goes, or the app would quit with no window left.
function recreateWindow() {
  const old = win
  if (!deskMode) state.window = old.getNormalBounds()
  extensions.closePopup()
  endSlide()
  for (const view of shown) old.contentView.removeChildView(view)
  shown = []
  attached = null
  createWindow(old.getBounds())
  old.destroy()
}

// Bounds in DIP; a negative x or y measures from the right or bottom edge, so a corner view follows resizes.
function edgeBounds(b) {
  const [width, height] = win.getContentSize()
  return { x: b.x < 0 ? Math.max(0, width + b.x) : b.x, y: b.y < 0 ? Math.max(0, height + b.y) : b.y, width: Math.min(b.width, width), height: Math.min(b.height, height) }
}
function fitOverlay(o) {
  const [width, height] = win.getContentSize()
  const b = o.bounds ? edgeBounds(o.bounds) : { x: 0, y: 0, width, height }
  if (!o.float) return o.host.setBounds(b)
  const content = win.getContentBounds()
  o.host.setBounds({ ...b, x: content.x + b.x, y: content.y + b.y })
}
function cssRect(p) {
  const given = S.isObject(p) ? ['x', 'y', 'width', 'height'].map((key) => p[key]) : []
  if (!(given.length === 4 && given.every(Number.isFinite) && given[2] > 0 && given[3] > 0)) throw S.err('bad_params', 'bounds must be {x, y, width, height} with a positive width and height')
  return { x: given[0], y: given[1], width: given[2], height: given[3] }
}
// Shell CSS pixels to DIP, as ui.setPageBounds does.
function toDip(r) {
  const zoom = win ? win.webContents.getZoomFactor() : 1
  return { x: Math.round(r.x * zoom), y: Math.round(r.y * zoom), width: Math.round(r.width * zoom), height: Math.round(r.height * zoom) }
}
const cssBounds = (p) => toDip(cssRect(p))

function setWindowButtons(visible) {
  if (process.platform === 'darwin' && !deskMode) win?.setWindowButtonVisibility(visible)
}

function hideOverlay(name = 'main') {
  const o = overlays.get(name)
  if (o?.float) {
    overlays.delete(name)
    if (!o.host.isDestroyed()) o.host.destroy()
    return
  }
  if (!o?.shown) return
  const focused = name === 'main' || o.host.webContents.isFocused()
  o.shown = false
  win?.contentView.removeChildView(o.host)
  if (focused) (attached || win)?.webContents.focus()
}

// A floating overlay can be clicked while another app is in front, so the window an overlay lives in comes forward before it takes the keyboard.
function focusShell(o) {
  const w = o?.float ? o.host : win
  if (deskMode && !w.isFocused()) {
    raisedAt = Date.now()
    if (process.platform === 'darwin') app.focus({ steal: true })
    w.focus()
  }
  (o?.host || win).webContents.focus()
}

// Focus moving from the desk window to one of its floating overlays keeps Skiff in front; anywhere else it is not.
function focusLeft() {
  setTimeout(() => {
    const focused = BrowserWindow.getFocusedWindow()
    inFront &&= Boolean(focused && (focused === win || [...overlays.values()].some((o) => o.float && o.host === focused)))
  }, 100)
}

// A Dock click or Cmd+Tab brings the desk forward; Skiff raising itself or a click on one of its windows does not count.
function deskFocused() {
  extensions.windowFocus(true)
  if (deskMode && !inFront && Date.now() - raisedAt > 400 && !overDesk(screen.getCursorScreenPoint())) {
    for (const wc of shellContents()) wc.send('skiff:event', 'desk-activated', null)
  }
  inFront = true
}

const deskArea = (near) => (['x', 'y', 'width', 'height'].every((key) => Number.isFinite(near?.[key])) ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()).workArea

function refitDesk() {
  if (win && deskMode) win.setBounds(deskArea(win.getBounds()))
}

function createWindow(near = state.window) {
  deskMode = shellIsDesk()
  frameSpec = deskMode ? readFrame(manifest()) : null
  for (const view of views.values()) view.webContents.send('skiff:desk-page', deskMode)
  laidOutSpace = null
  const w = win = new BrowserWindow(deskMode
    ? { ...deskArea(near), frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, roundedCorners: false, backgroundColor: '#00000000', webPreferences: shellWebPreferences }
    : { ...state.window, minWidth: 560, minHeight: 360, titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', webPreferences: shellWebPreferences })
  ignoring = false
  guardShell(win.webContents)
  win.webContents.on('did-start-loading', () => {
    pageVisible = true
    pageBounds = null
    shellLoads++
    desk = noDesk()
    for (const name of [...overlays.keys()]) hideOverlay(name)
    extensions.closePopup()
    setWindowButtons(true)
    syncView()
  })
  win.webContents.on('did-finish-load', () => {
    clearTimeout(warmTimer)
    warmTimer = setTimeout(prewarm, 500)
  })
  const fitOverlays = () => { for (const o of overlays.values()) if (o.shown) fitOverlay(o) }
  win.on('move', fitOverlays)
  win.on('resize', () => {
    fitOverlays()
    const popup = extensions.popupView()
    if (popup) popup.setBounds(edgeBounds(popupBounds))
    if (deskMode) syncView()
  })
  win.on('focus', () => { if (win === w) deskFocused() })
  win.on('blur', () => {
    extensions.windowFocus(false)
    focusLeft()
  })
  for (const name of ['show', 'restore']) win.on(name, watchPointer)
  win.on('close', () => {
    if (win !== w) return
    // Agent tabs outlive the window, so a peeked one goes back to the hidden window before this one is destroyed.
    for (const view of shown) if (agentViews.has(view)) w.contentView.removeChildView(view)
    shown = shown.filter((view) => !agentViews.has(view))
    if (deskMode) return
    state.window = win.getNormalBounds()
    save()
  })
  win.on('closed', () => {
    if (win !== w) return
    clearInterval(slide?.timer)
    slide = null
    clearTimeout(warmTimer)
    warmTimer = null
    win = null
    attached = null
    shown = []
    pageBounds = null
    closeShellViews()
    for (const id of [...views.keys()]) if (!agentViews.has(views.get(id))) destroyView(id)
    parkAgents()
    // The hidden agent window would keep window-all-closed from firing.
    if (process.platform !== 'darwin') app.quit()
  })
  win.loadFile(path.join(shellDir, 'index.html'))
  watchPointer()
}

function watchPointer() {
  if (deskMode && !pointerTimer) pointerTimer = setInterval(pollPointer, 16)
}

// Empty parts of the desk window pass clicks to the apps below; the cursor position decides, since a transparent pixel cannot.
function pollPointer() {
  if (!win || !deskMode || !win.isVisible() || win.isMinimized()) {
    clearInterval(pointerTimer)
    pointerTimer = null
    return
  }
  const point = screen.getCursorScreenPoint()
  const ignore = !desk.capture && !overDesk(point)
  if (ignore !== ignoring) passClicks(win, ignoring = ignore)
  for (const o of overlays.values()) {
    if (!o.float || !o.shown) continue
    const pass = !desk.capture && !overFloat(o, point)
    if (pass !== o.ignoring) passClicks(o.host, o.ignoring = pass)
  }
}

const passClicks = (w, pass) => (pass ? w.setIgnoreMouseEvents(true, { forward: true }) : w.setIgnoreMouseEvents(false))

// A floating overlay takes clicks on its hit rectangles only, so its transparent margin passes them to whatever is below.
function overFloat(o, point) {
  const b = o.host.getContentBounds()
  const x = point.x - b.x
  const y = point.y - b.y
  const inside = (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
  return (o.hit || [{ x: 0, y: 0, width: b.width, height: b.height }]).some(inside)
}

function overDesk(point) {
  const content = win.getContentBounds()
  const x = point.x - content.x
  const y = point.y - content.y
  const inside = (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
  const overlay = [...overlays.values()].some((o) => o.shown && !o.float && inside(o.host.getBounds()))
  if (desk.hit.some((r) => inside(toDip(r))) || overlay) return true
  const popup = extensions.popupView()
  return shown.some((view) => inside(view.getBounds())) || Boolean(popup && inside(popup.getBounds()))
}

function targetContents({ target, id }) {
  if (target !== 'shell' && target !== 'page') throw S.err('bad_params', "target must be 'shell' or 'page'")
  const byId = target === 'page' && id !== undefined
  const wc = target === 'shell' ? win?.webContents : byId ? views.get(S.getTab(state, id).id)?.webContents : attached?.webContents
  if (!wc) throw S.err('not_found', target === 'shell' ? 'No window is open' : byId ? 'That tab is not loaded' : 'No page is showing')
  return wc
}

function fillFields(origin, username, password) {
  if (location.origin !== origin || window !== window.top) return false
  const visible = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const fields = [...document.querySelectorAll('input[type="password"]')].filter((el) => visible(el) && el.autocomplete !== 'new-password')
  if (fields.length !== 1) return false
  const field = fields[0]
  const form = field.form
  if (form && (new URL(form.action || location.href, location.href).origin !== origin ||
      [...form.querySelectorAll('[formaction]')].some((el) => new URL(el.formAction, location.href).origin !== origin))) return false
  const root = form || document
  const user = [...root.querySelectorAll('input[autocomplete="username"], input[type="email"], input[type="text"], input:not([type])')].filter(visible).at(-1)
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  for (const [input, value] of [[user, username], [field, password]]) {
    if (!input) continue
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return true
}

async function fillPassword() {
  if (filling) throw S.err('bad_params', 'A password request is already open.')
  const tab = S.activeTab(state)
  const wc = tab && views.get(tab.id)?.webContents
  if (!win || !wc || wc.isDestroyed()) return { filled: false, reason: 'no-fields' }
  const url = new URL(wc.getURL())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw S.err('bad_params', 'Passwords can only be filled on a secure site.')
  const partition = tab.sessionPartition || 'persist:main'
  filling = true
  try {
    const accounts = vault.list(url.origin, partition)
    if (!accounts.length) return { filled: false, reason: 'no-match' }
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', message: `Fill a saved password on ${url.origin}?`,
      detail: 'Choose an account. Skiff fills this page only and will not submit the form.',
      buttons: ['Cancel', ...accounts.map((a) => a.username || '(No username)')], defaultId: 0, cancelId: 0, noLink: true
    })
    if (!response || !accounts[response - 1]) return { filled: false, cancelled: true }
    if (wc.isDestroyed() || S.activeTab(state)?.id !== tab.id || wc.getURL() !== url.href) return { filled: false, cancelled: true }
    const record = vault.get(accounts[response - 1].id, url.origin, partition)
    if (!record) return { filled: false, reason: 'no-match' }
    const args = [url.origin, record.username, record.password].map((v) => JSON.stringify(v)).join(',')
    const filled = await wc.executeJavaScript(`(${fillFields.toString()})(${args})`)
    return filled ? { filled: true } : { filled: false, reason: 'no-fields' }
  } catch {
    throw S.err('bad_params', 'The saved password could not be filled securely.')
  } finally {
    filling = false
  }
}

const commands = {}
const def = (name, params, description, run) => {
  commands[name] = { description, params, run }
}
const mutate = (fn) => (p) => {
  const result = fn(state, p, Date.now())
  changed()
  return result
}
const page = (fn) => (p) => {
  const wc = views.get(S.getTab(state, p.id).id)?.webContents
  if (wc) fn(wc)
  return null
}

def('commands.list', '', 'Every command with its description and params', () => Object.entries(commands).map(([name, c]) => ({ name, params: c.params, description: c.description })))
def('state.get', '', 'The full current state', snapshot)

def('spaces.create', '{name, color?}', 'Create a space; color is #rrggbb', mutate(S.createSpace))
def('spaces.update', '{id, name?, color?}', 'Rename or recolor a space; color overrides its imported Arc background', mutate(S.updateSpace))
def('spaces.move', '{id, index}', 'Move a space to a zero-based position; integer index is clamped to the space list', mutate(S.moveSpace))
def('spaces.remove', '{id}', 'Remove a space and archive its tabs; the last normal space is refused; removing the incognito space drops its tabs and clears its session data', async (p) => {
  const space = state.spaces.find((x) => x.id === p.id)
  S.removeSpace(state, p, Date.now())
  changed()
  if (space.incognito) {
    const ses = session.fromPartition(space.sessionPartition)
    await Promise.all([ses.clearStorageData(), ses.clearCache()])
  }
  return null
})
def('spaces.activate', '{id}', 'Switch to a space', mutate(S.activateSpace))
def('spaces.cycle', '{delta}', 'Switch to the next (1) or previous (-1) space; in a desk window the windows slide the way delta points, even when it wraps around', (p) => {
  const result = S.cycleSpace(state, p)
  heading = Math.sign(p.delta)
  changed()
  return result
})
def('incognito.open', '', 'Open the temporary incognito space, creating it if needed, and focus the address bar; nothing in it is saved', () => {
  const space = S.openIncognito(state)
  changed()
  commands['ui.emit'].run({ name: 'focus-address' })
  return space
})

def('tabs.create', '{url, spaceId?, parentId?, activate?, agent?}', 'Open a tab; url may be an address or search text; activate defaults to true; parentId nests it under a plain tab of the same space; in a desk window it gets the rect last used for its host, else the largest free part of the desk; agent (a name of at most 40 characters) opens a hidden agent tab instead: listed in agentTabs, never saved, archived or activated, loading at once in the session of spaceId (default the active space, or the first normal one when that is incognito; the incognito space is refused)', mutate(S.createTab))
def('tabs.close', '{id?}', 'Close a tab into the archive; favorites and pinned tabs are unloaded and kept; incognito and agent tabs are dropped', (p) => {
  const result = S.closeTab(state, p, Date.now())
  if (views.has(result.unloaded)) destroyView(result.unloaded)
  changed()
  return result
})
def('tabs.activate', '{id}', 'Show a tab, switching to its space; an agent tab is peeked instead: shown in front over the current space until another tab or space is shown, desk.hide or tabs.close', mutate(S.activateTab))
def('tabs.read', '{id?}', "A tab's page as {title, url, selection, text}; an unloaded tab loads in the background first", (p) => {
  const tab = S.getTab(state, p.id)
  if (tab.chat) throw S.err('bad_params', 'That tab is a conversation, not a web page.')
  return readTab(tab)
})
def('tabs.navigate', '{id?, url, browserIdentity?}', 'Load an address or search text in a tab; browserIdentity (native, compatible or null for profile default) changes this tab only and applies before loading the requested URL; changing identity recreates the view and starts fresh history. A conversation tab becomes a web tab', (p) => {
  const before = S.getTab(state, p.id)
  const wasChat = Boolean(before.chat)
  const previousIdentity = identityForTab(before)
  const tab = S.navigateTab(state, p, Date.now())
  const identityChanged = identityForTab(tab) !== previousIdentity
  if ((wasChat || identityChanged) && views.has(tab.id)) destroyView(tab.id)
  else views.get(tab.id)?.webContents.loadURL(tab.url).catch(() => {})
  changed()
  return tab
})
def('tabs.back', '{id?}', 'Go back in a tab', page((wc) => wc.navigationHistory.goBack()))
def('tabs.forward', '{id?}', 'Go forward in a tab', page((wc) => wc.navigationHistory.goForward()))
def('tabs.reload', '{id?, ignoreCache?}', 'Reload a tab; ignoreCache: true bypasses the cache', (p) => page((wc) => (p.ignoreCache === true ? wc.reloadIgnoringCache() : wc.reload()))(p))
def('tabs.zoom', '{id?, delta}', 'Zoom a page in (1), out (-1) or back to 100% (0); returns {factor}, or null when the tab is not loaded', (p) => {
  if (![1, -1, 0].includes(p.delta)) throw S.err('bad_params', 'delta must be 1, -1 or 0')
  const wc = views.get(S.getTab(state, p.id).id)?.webContents
  return wc ? { factor: zoomStep(wc, p.delta) } : null
})
def('tabs.print', '{id?}', 'Print a tab', page((wc) => wc.print()))
def('tabs.copyUrl', '{id?}', 'Copy the address of a tab to the clipboard and show a confirmation; returns {url}, or null with no active tab', (p) => {
  if (p.id === undefined && !S.activeTab(state)) return null
  const tab = S.getTab(state, p.id)
  const url = views.get(tab.id)?.webContents.getURL() || tab.url
  clipboard.writeText(url)
  for (const wc of shellContents()) wc.send('skiff:event', 'url-copied', { url })
  return { url }
})
def('tabs.move', '{id, index?, spaceId?}', 'Reorder a tab among its siblings or move it to another space as a root; not into or out of the incognito space; not an agent tab', mutate(S.moveTab))
def('tabs.setFavorite', '{id?, favorite}', 'Make a tab a favorite of its space, or turn it back into a plain tab there; not an agent tab', mutate(S.setFavorite))
def('tabs.setPinned', '{id?, pinned, folder?}', 'Pin a tab to its space, optionally in a folder, or unpin it; not an agent tab', mutate(S.setPinned))
def('tabs.cycle', '{delta}', 'Show the next (1) or previous (-1) tab of the active space', mutate(S.cycleTab))
def('tabs.select', '{index}', 'Show the index-th unpinned tab of the active space in Ctrl+Tab order; negative counts from the end; null past the end', mutate(S.selectTab))
def('tabs.thumbnails', '{ids, width?}', 'Pictures of up to 24 tabs as [{id, image}] in the order of ids, image a JPEG data URL at most width pixels wide (default 480, at most 3840; a page narrower on screen keeps its own size) at the page\'s aspect, or null when the tab is not on screen (hidden, in another space or not loaded), cannot be captured or is incognito while another space shows', async (p) => {
  const { tabs, width } = S.thumbnailTabs(state, p)
  return Promise.all(tabs.map(async (tab, i) => {
    const view = tab && views.get(tab.id)
    // A view that is not in the window draws no frames, so its capturePage never settles.
    const wc = view && shown.includes(view) && !view.webContents.isDestroyed() ? view.webContents : null
    const shot = wc ? await wc.capturePage().catch(() => null) : null
    if (!shot || shot.isEmpty()) return { id: p.ids[i], image: null }
    const fit = shot.getSize(Math.max(1, ...shot.getScaleFactors())).width > width ? shot.resize({ width, quality: 'good' }) : shot
    return { id: p.ids[i], image: `data:image/jpeg;base64,${fit.toJPEG(80).toString('base64')}` }
  }))
})

def('folders.setCollapsed', '{spaceId?, folder, collapsed}', 'Collapse or expand a folder of pinned tabs; spaceId defaults to the active space', mutate(S.setCollapsed))

def('desk.place', '{id?, x, y, width, height}', 'Put a tab on the desk of a desk shell or move or resize it there, in window CSS pixels, at least 240 by 160, show it if hidden and bring it to the front; the rect is remembered for the host of the tab, so its next new window opens there', mutate(S.placeDesk))
def('desk.layouts', '', 'The window rects of the named desk layouts for the current desk, in window CSS pixels: fill, center, left, right, top, bottom, left-third, center-third, right-third, left-two-thirds, right-two-thirds, top-left, top-right, bottom-left, bottom-right; 8px from the desk edges and each other, with the frame\'s top inset free above each', () => S.deskLayouts(state))
def('desk.tile', '{id?, layout}', 'Place a tab at one of the desk.layouts rects as desk.place does; not_found without a desk window', mutate(S.tileDesk))
def('desk.hide', '{id?}', 'Hide a desk window; the tab stays in its space and keeps its rect (the default one if it had none); if it was the active tab, the frontmost window left in the space becomes active, or none; on a peeked agent tab it ends the peek', mutate(S.hideDesk))
def('desk.show', '{id}', 'Show a hidden desk window in front and make it the active tab; an agent tab is peeked', mutate(S.showDesk))

def('archive.restore', '{id?}', 'Reopen an archived tab; without id, the most recent', mutate(S.restore))
def('archive.remove', '{id}', 'Delete one archive entry', mutate(S.removeArchived))
def('archive.clear', '', 'Delete every archive entry', mutate(S.clearArchive))
def('archive.sweep', '', 'Run auto-archive now', () => {
  const result = S.sweep(state, {}, Date.now())
  if (result.archived.length) changed()
  return result
})

def('import.arc.preview', '{profileId?}', 'List Arc profiles and tab counts without opening protected data', (p) => importer.preview(p))
def('import.arc', '{profileIds: string[], categories:{tabs,openTabs,passwords,logins}, keepSpaces}', 'Import any selected Arc profiles; passwords and sign-ins require one native confirmation', (p) => importer.run(p).finally(() => {
  prefetchIcons()
}))
def('passwords.fill', '', 'Ask which saved account to fill on the active site; never returns credentials', fillPassword)

def('settings.set', '{autoArchiveHours?, searchUrl?, shortcuts?, ai?, browserIdentity?}', 'Change settings; browserIdentity merges {persistentPartition: "native"|"compatible"} and applies only after restarting Skiff, without changing profile storage; compatible is the default. shortcuts replaces the whole map of accelerator to {method, params?}; autoArchiveHours 0 turns auto-archive off; ai {agents?, agent?, model?, effort?} merges into the agent settings: agents [{name, command}] (at most 10, unique names of at most 40 characters, commands of at most 500 run in the login shell), agent the default one, model and effort the last choices; an agent removed or whose command changed is stopped', (p) => {
  for (const s of Object.values(S.isObject(p.shortcuts) ? p.shortcuts : {})) {
    if (!Object.hasOwn(commands, s?.method)) throw S.err('bad_params', `Unknown method in shortcuts: ${s?.method}`)
  }
  const settings = S.setSettings(state, p)
  if (p.shortcuts) buildMenu()
  if (p.ai !== undefined) ai.settingsChanged()
  changed()
  return settings
})

def('ai.agents', '', 'The configured agents in settings order: name, command, status (idle, starting, ready or error), error, info {name, version}, models and efforts [{value, name}] with the current model and effort of its latest session (null until one exists), loadSession', () => ai.agents())
def('ai.warm', '{agent}', 'Start an agent and open a spare session for its next ai.ask; resolves with its ai.agents entry once its models and efforts are known or it failed', (p) => ai.warm(p))
def('ai.ask', '{text, agent?, model?, effort?, includePage?, tabId?}', "Open a conversation tab in the space of tabId (default the active tab), nested under it when it is a plain tab, and send text to the agent (default settings.ai.agent, else the first); returns {tabId, chatId} at once; model and effort default to the last ones used, and the ones used are saved; includePage: true sends the text of that tab along when it is a loaded non-incognito web page; with agent '' or none configured the tab opens in setup holding the text", (p) => ai.ask(p))
def('ai.chat', '{chatId}', 'A conversation: id, tabId, agent, status (setup, restoring, ready, running or error), error, pending, sessionId, models, model, efforts, effort, permission {id, title, options} and turns; one from an earlier run is restored with session/load when the agent supports it', (p) => ai.chat(p))
def('ai.prompt', '{chatId, text}', 'Send a follow-up in a conversation; refused while it runs; a conversation in setup adopts the default agent; returns {turnId} of the reply at once', (p) => ai.prompt(p))
def('ai.configure', '{chatId, model?, effort?}', "Change a conversation's model or effort and save them as the last choices; returns the conversation", (p) => ai.configure(p))
def('ai.cancel', '{chatId}', 'Stop the running turn of a conversation and refuse its waiting permission request', (p) => ai.cancel(p))
def('ai.permit', '{chatId, optionId} | {chatId, cancel: true}', "Answer a conversation's waiting permission request with one of its options, or refuse it", (p) => ai.permit(p))

def('ui.setPageVisible', '{visible}', 'Hide the native page while the shell shows a dialog', (p) => {
  if (typeof p.visible !== 'boolean') throw S.err('bad_params', 'visible must be true or false')
  pageVisible = p.visible
  syncView()
  return null
})

def('ui.setPageBounds', '{x, y, width, height, radius?}', 'Shell only: where the active page is drawn, in shell CSS pixels; ignored in a desk window, where tab.desk places pages', (p) => {
  if (deskMode) return null
  const zoom = win ? win.webContents.getZoomFactor() : 1
  const [x, y, width, height, radius] = [p.x, p.y, p.width, p.height, p.radius ?? 0].map((n) => Math.round(n * zoom))
  if (![x, y, width, height, radius].every((n) => Number.isFinite(n) && n >= 0)) throw S.err('bad_params', 'x, y, width, height must be non-negative numbers')
  pageBounds = { x, y, width, height, radius }
  syncView()
  return null
})
def('ui.setDesk', '{hit?, capture?, preview?, animate?, only?}', "Desk shells only, not saved: hit lists the shell's own clickable rectangles {x, y, width, height} in shell CSS pixels; capture: true keeps every click in Skiff during a drag or resize; preview {id, x, y, width, height} draws that tab (and its frame) there at once without saving it, null clears it; animate: false switches spaces without sliding the windows, as reduced motion in the system settings does; only [tabIds] shows just those windows of the active space, the active tab joining them, and leaves every other window loaded but off the desk and out of the way of clicks, until null, a space switch or the last of them closing or hiding (state.deskOnly holds the set); each field given replaces its last value", (p) => {
  const next = {}
  if (p.hit !== undefined) {
    if (!Array.isArray(p.hit)) throw S.err('bad_params', 'hit must be a list of {x, y, width, height}')
    next.hit = p.hit.map(cssRect)
  }
  for (const key of ['capture', 'animate']) {
    if (p[key] === undefined) continue
    if (typeof p[key] !== 'boolean') throw S.err('bad_params', `${key} must be true or false`)
    next[key] = p[key]
  }
  if (p.preview !== undefined) next.preview = p.preview === null ? null : { ...cssRect(p.preview), id: S.getTab(state, p.preview.id).id }
  if (p.only !== undefined) {
    if (p.only !== null && !(Array.isArray(p.only) && p.only.length)) throw S.err('bad_params', 'only must be a non-empty list of tab ids or null')
    next.only = p.only && [...new Set(p.only.map((id) => S.getTab(state, id).id))]
  }
  Object.assign(desk, next)
  syncView()
  if ('only' in next) pushState()
  if (win) pollPointer()
  return null
})
def('ui.showOverlay', '{file, bounds?, name?, focus?, float?, hit?, under?}', "Shell only: show one of the shell files as a transparent page over the live page until ui.hideOverlay; bounds {x, y, width, height} in shell CSS pixels confines it to that rectangle, a negative x or y measuring from the right or bottom edge; name (default 'main') keeps several overlays at once, 'main' above the others; under: the name of another overlay to stay below while that one is shown; showing the same file again only moves it; focus: false never takes keyboard focus, true always does, by default only when first shown; float: true (desk windows only) shows it in a window of its own at bounds on the desk window's display, above other apps, on every desktop, and hit [{x, y, width, height}] in its own CSS pixels lists where it takes clicks, the rest passing them to whatever is below", async (p) => {
  const file = typeof p.file === 'string' && p.file === path.basename(p.file) ? path.join(shellDir, p.file) : ''
  if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw S.err('bad_params', 'file must name a file in the shell folder')
  const name = p.name ?? 'main'
  if (typeof name !== 'string' || !name) throw S.err('bad_params', 'name must be a non-empty string')
  for (const key of ['focus', 'float']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw S.err('bad_params', `${key} must be true or false`)
  if (p.under !== undefined && (typeof p.under !== 'string' || !p.under)) throw S.err('bad_params', 'under must be a non-empty string')
  const float = p.float === true
  if (p.hit !== undefined && !(float && Array.isArray(p.hit))) throw S.err('bad_params', 'hit must be a list of {x, y, width, height} on a float overlay')
  const hit = p.hit?.map(cssBounds) || null
  const bounds = p.bounds === undefined ? null : cssBounds(p.bounds)
  if (!win) throw S.err('not_found', 'No window is open')
  if (float && !deskMode) throw S.err('bad_params', 'float needs a desk shell')
  let o = overlays.get(name)
  if (o && o.float !== float) {
    hideOverlay(name)
    if (!o.float) o.host.webContents.close()
    overlays.delete(name)
    o = null
  }
  if (!o) {
    overlays.set(name, o = { host: float ? floatWindow() : shellView(), float, bounds: null, hit: null, shown: false, ignoring: false })
    if (float) o.host.on('closed', () => overlays.get(name) === o && overlays.delete(name))
  }
  // The file loads before the view shows, so an event emitted right after reaches the loaded page.
  const same = o.host.webContents.getURL() === pathToFileURL(file).href
  const loads = shellLoads
  if (!same) await o.host.webContents.loadFile(file).catch((e) => { if (overlays.get(name) === o) throw e })
  // A shell that reloaded meanwhile no longer wants it.
  if (!win || overlays.get(name) !== o || loads !== shellLoads) return null
  const wasShown = o.shown
  o.bounds = bounds
  o.hit = hit
  if (!float) {
    const others = win.contentView.children.filter((view) => view !== o.host)
    const above = [name !== 'main' && 'main', p.under].map((key) => key && key !== name && overlays.get(key)).filter((x) => x?.shown && !x.float).map((x) => others.indexOf(x.host))
    if (above.length) win.contentView.addChildView(o.host, Math.min(...above))
    else win.contentView.addChildView(o.host)
  }
  o.shown = true
  fitOverlay(o)
  if (float && !wasShown) o.host.showInactive()
  if (p.focus ?? (!wasShown || !same)) focusShell(o)
  return null
})
def('ui.setWindowButtons', '{visible}', 'Shell only: show or hide the macOS window buttons; no effect elsewhere or in a desk window; a shell change or reload shows them again', (p) => {
  if (typeof p.visible !== 'boolean') throw S.err('bad_params', 'visible must be true or false')
  setWindowButtons(p.visible)
  return null
})
def('ui.hideOverlay', '{name?}', "Remove an overlay page, 'main' by default, closing a float overlay's window; hiding 'main', or one that has keyboard focus, returns focus to the page or the shell", (p) => {
  if (p.name !== undefined && (typeof p.name !== 'string' || !p.name)) throw S.err('bad_params', 'name must be a non-empty string')
  hideOverlay(p.name)
  return null
})

def('extensions.list', '', 'Extensions, built-in ones first: id, name, version, description, path, popup page, options page, builtin, state (installing, updating, ready or failed) and error; a built-in that is not installed yet is listed with an empty id', () => extensions.list())
def('extensions.add', '{path}', 'Copy an unpacked extension folder or a zip of one into the profile and load it in every space except incognito; an extension with the same name is replaced and keeps its storage', (p) => extensions.add(p.path))
def('extensions.download', '{url}', 'Download a zip of an unpacked extension over https and add it; a GitHub latest-release API URL picks its Chromium zip asset', (p) => extensions.download(p.url))
def('extensions.update', '', 'Install missing built-in extensions and update installed ones whose release page names a newer version, now; the same check runs at startup and every six hours', () => extensions.update())
def('extensions.remove', '{id}', 'Unload an extension everywhere and delete its folder; built-in ones cannot be removed', (p) => extensions.remove(p.id))
def('extensions.open', '{id, page?}', "Open one of the extension's own pages as a tab, its options page when none is named", (p) => extensions.open(p.id, p.page))
def('extensions.popup', '{id, bounds}', "Shell only: show the extension's action popup for the active tab in a view sized to its content inside bounds, in shell CSS pixels with a negative x or y measured from the right or bottom edge; it closes when it loses focus; an extension without a popup gets its onClicked event instead", async (p) => {
  if (typeof p.id !== 'string') throw S.err('bad_params', 'id must be a string')
  popupBounds = cssBounds(p.bounds)
  return extensions.showPopup(p.id, popupBounds)
})
def('extensions.closePopup', '', 'Close the extension popup', () => extensions.closePopup())
def('ui.emit', '{name, data?, focus?}', 'Send every shell page a custom event, such as new-tab or focus-address, focusing the shell (its main overlay if shown) first unless focus is false', (p) => {
  if (typeof p.name !== 'string' || !p.name || p.name === 'state') throw S.err('bad_params', 'name must be a string other than "state"')
  if (p.focus !== undefined && typeof p.focus !== 'boolean') throw S.err('bad_params', 'focus must be true or false')
  const main = overlays.get('main')
  if (p.focus !== false && win) focusShell(main?.shown ? main : null)
  for (const wc of shellContents()) wc.send('skiff:event', p.name, p.data)
  return null
})
def('ui.focusPage', '', 'Give keyboard focus to the active page', () => {
  attached?.webContents.focus()
  return null
})
def('ui.raise', '', 'Bring the Skiff window in front of other apps and give the keyboard to the active page', () => {
  if (!win) throw S.err('not_found', 'No window is open')
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  if (!win.isFocused()) {
    raisedAt = Date.now()
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.focus()
  }
  ;(attached || win).webContents.focus()
  return null
})
def('ui.inFront', '', "Whether Skiff is the app in front: {front} is true while its window, or in a desk shell a floating overlay clicked while the desk window had the keyboard, is focused", () => ({ front: deskMode ? inFront : Boolean(win?.isFocused()) }))
def('ui.reloadShell', '', 'Reload the shell from disk', () => {
  reloadShell()
  return null
})
def('ui.resetShell', '', 'Move the live shell to shell.bak-<timestamp> and restore the default shell', () => {
  const backup = path.join(dataDir, `shell.bak-${Date.now()}`)
  fs.renameSync(shellDir, backup)
  fs.mkdirSync(shellDir)
  installShell('default')
  return { backup }
})
def('ui.setShell', '{name}', 'Replace the live shell with one of state.shells; the window reloads it in place and tabs stay as they are; a switch between an app shell and a desk shell (shell.json {"window": "desk"}) opens a new window of that kind with the same pages', (p) => {
  if (!shells.includes(p.name)) throw S.err('not_found', `No shell named ${p.name}. Shells: ${shells.join(', ')}`)
  installShell(p.name)
  return { shell: p.name }
})
def('ui.shellPath', '', 'Directory of the live shell files', () => ({ path: shellDir }))
def('ui.capture', "{target: 'shell'|'page', id?}", 'Screenshot the shell, the active page, or with id the page of that tab, hidden agent tabs included, as a base64 PNG', async (p) => {
  const wc = targetContents(p)
  // A page attached moments ago has no frame yet, and capturePage rejects until it paints.
  for (let tries = 0; ; tries++) {
    try {
      const image = await wc.capturePage()
      return { ...image.getSize(), png: image.toPNG().toString('base64') }
    } catch (e) {
      if (tries === 9) throw e
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
})
def('ui.devtools', "{target: 'shell'|'page'}", 'Open devtools for the shell or the active page', (p) => {
  targetContents(p).openDevTools({ mode: 'detach' })
  return null
})

async function call(method, params = {}) {
  if (typeof method !== 'string' || !Object.hasOwn(commands, method)) throw S.err('unknown_method', `Unknown method: ${method}`)
  if (!S.isObject(params)) throw S.err('bad_params', 'params must be an object')
  return commands[method].run(params)
}

async function rpc(method, params) {
  try {
    return { ok: true, result: (await call(method, params)) ?? null }
  } catch (e) {
    if (!CODES.includes(e.code)) console.error(e)
    return { ok: false, error: { code: CODES.includes(e.code) ? e.code : 'internal', message: String(e.message || e) } }
  }
}

// Desk rects are in shell CSS pixels, so the pages move with the shell's zoom.
function zoomShell(level) {
  win.webContents.setZoomLevel(level)
  syncView()
}

function buildMenu() {
  const items = Object.entries(state.settings.shortcuts).map(([accelerator, { method, params }]) => ({
    label: [method, ...Object.values(params || {})].join(' '),
    accelerator,
    click: () => rpc(method, params)
  }))
  const mac = process.platform === 'darwin'
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    // Page zoom owns CmdOrCtrl+0/+/-; these size the shell itself, by the step the zoom roles used.
    { label: 'View', submenu: [
      { label: 'Make Interface Larger', click: () => zoomShell(win.webContents.getZoomLevel() + 0.5) },
      { label: 'Make Interface Smaller', click: () => zoomShell(win.webContents.getZoomLevel() - 0.5) },
      { label: 'Interface Actual Size', click: () => zoomShell(0) }
    ] },
    { label: 'Shell', submenu: shells.map((name) => ({ label: name, type: 'radio', checked: name === state.settings.shell, click: () => rpc('ui.setShell', { name }) })) },
    { label: 'Commands', submenu: items },
    // Off macOS the windowMenu role carries Close on CmdOrCtrl+W, which would close the window instead of the tab.
    mac ? { role: 'windowMenu' } : { label: 'Window', submenu: [{ role: 'minimize' }] }
  ]))
}

const configuredSessions = new Set()
function getSession(partition) {
  const ses = session.fromPartition(partition)
  if (configuredSessions.has(partition)) return ses
  configuredSessions.add(partition)
  if (browserIdentity[partition] === 'native') ses.setUserAgent(nativeUserAgent)
  extensions.attach(ses, partition)
  ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'preload-page.js') })
  const always = ['fullscreen', 'pointerLock', 'clipboard-sanitized-write']
  const ask = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications' }
  const originOf = (url) => (URL.canParse(url) ? new URL(url).origin : '')
  const granted = new Set()
  ses.setPermissionCheckHandler((_wc, permission, origin) => always.includes(permission) || granted.has(`${permission} ${originOf(origin)}`))
  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    const origin = originOf(details.requestingUrl)
    const key = `${permission} ${origin}`
    if (always.includes(permission) || granted.has(key)) return callback(true)
    if (!ask[permission] || !origin || !win) return callback(false)
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: `${origin} wants to ${ask[permission]}`,
      buttons: ['Deny', 'Allow'],
      defaultId: 0,
      cancelId: 0
    })
    // ponytail: grants last until quit and are not listed anywhere; persist and show them when a settings surface exists
    if (response === 1) granted.add(key)
    callback(response === 1)
  })
  return ses
}

function startApi() {
  const token = crypto.randomBytes(32).toString('hex')
  const want = Buffer.from(`Bearer ${token}`)
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const refuse = (res, status, code, message) => reply(res, status, { ok: false, error: { code, message } })
  const server = http.createServer((req, res) => {
    const { port } = server.address()
    const got = Buffer.from(req.headers.authorization || '')
    if (req.headers.origin !== undefined) return refuse(res, 403, 'forbidden', 'Requests with an Origin header are refused')
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return refuse(res, 403, 'forbidden', 'Unexpected Host header')
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return refuse(res, 401, 'unauthorized', 'Missing or wrong bearer token')
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(sseFrame(snapshot()))
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }
    if (req.url === '/mcp' && req.method !== 'POST') return refuse(res, 405, 'bad_method', 'Use POST /mcp')
    if (req.method !== 'POST' || !['/rpc', '/mcp'].includes(req.url)) return refuse(res, 404, 'not_found', 'Use POST /rpc, POST /mcp or GET /events')
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= 1e6) return chunks.push(chunk)
      req.pause()
      res.once('finish', () => req.destroy())
      refuse(res, 413, 'bad_params', 'Body is over 1 MB')
    })
    req.on('end', async () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks))
      } catch {
        if (req.url === '/mcp') return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return refuse(res, 400, 'bad_params', 'Body must be JSON: {method, params}')
      }
      if (req.url === '/mcp') {
        const out = await handleMcp(body, { tools: mcpTools, version: app.getVersion() })
        if (out) return reply(res, 200, out)
        res.writeHead(202)
        return res.end()
      }
      const out = await rpc(body?.method, body?.params ?? undefined)
      reply(res, out.ok ? 200 : 400, out)
    })
  })
  server.listen(0, '127.0.0.1', () => {
    api = { port: server.address().port, token }
    const file = path.join(dataDir, 'api.json')
    fs.rmSync(file, { force: true })
    fs.writeFileSync(file, JSON.stringify(api), { mode: 0o600 })
  })
}

function start() {
  fs.mkdirSync(dataDir, { recursive: true })
  state = loadState()
  // settings.set replaces this map; every session keeps the identity selected at startup.
  browserIdentity = state.settings.browserIdentity
  if (!fs.existsSync(shellDir)) fs.cpSync(bundledShell, shellDir, { recursive: true })
  watchShell()
  vault = createVault({ file: path.join(dataDir, 'passwords.enc'), safeStorage })
  importer = createImporter({
    home: app.getPath('home'), state, changed, getSession, vault, faviconDir,
    confirm: async (profileNames, categories) => {
      if (!win) return false
      const kinds = [categories.passwords && 'saved passwords', categories.logins && 'active website sign-ins'].filter(Boolean).join(' and ')
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', message: `Import ${kinds} from Arc?`,
        detail: `Profiles: ${profileNames.join(', ')}\nSkiff will read only the categories you selected on this Mac. macOS may ask to access Arc's Safe Storage key. Nothing is sent to a server.`,
        buttons: ['Cancel', 'Allow import'], defaultId: 0, cancelId: 0, noLink: true
      })
      return response === 1
    }
  })
  getSession('persist:main')
  ai = createAi({ dir: path.join(dataDir, 'ai'), version: app.getVersion(), state: () => state, changed, favicon: F.storeIcon(faviconDir, 'https://skiff.invalid/agent.svg', Buffer.from(SPARKLE)), api: () => api, pageText, push: pushAi })
  extensions.start()
  ipcMain.handle('skiff:call', (e, method, params) => {
    const shell = shellContents().includes(e.sender) && inShell(e.senderFrame?.url)
    const chat = chatContents().includes(e.sender) && inDir(chatDir, e.senderFrame?.url)
    if (!win || !(shell || chat)) return { ok: false, error: { code: 'forbidden', message: 'Only the shell may call' } }
    return rpc(method, params ?? undefined)
  })
  const pageTab = (e) => e.senderFrame && !e.senderFrame.parent && tabOfContents(e.sender.id)
  // A tab's page swipes back or forward. The time of its last swipe lets the page that swipe opens ignore the momentum tail.
  const swipedAt = new WeakMap()
  const canGo = (wc, way) => (way === 'back' ? wc.navigationHistory.canGoBack() : way === 'forward' && wc.navigationHistory.canGoForward())
  ipcMain.handle('skiff:swipe-page', (e) => (pageTab(e) ? { back: canGo(e.sender, 'back'), forward: canGo(e.sender, 'forward'), swipedAt: swipedAt.get(e.sender) || 0 } : null))
  ipcMain.on('skiff:swipe-nav', (e, way) => {
    const id = pageTab(e)
    if (!id || !canGo(e.sender, way)) return
    swipedAt.set(e.sender, Date.now())
    rpc(`tabs.${way}`, { id })
  })
  // A desk window's page reports drags that start on its empty background; they go to that window's frame only.
  const deskPage = (e) => deskMode && pageTab(e)
  ipcMain.handle('skiff:desk-page', (e) => Boolean(deskPage(e)))
  ipcMain.on('skiff:page-drag', (e, phase, screenX, screenY) => {
    const id = deskPage(e)
    if (!id || !['start', 'move', 'end', 'cancel'].includes(phase) || ![screenX, screenY].every(Number.isFinite)) return
    frames.get(id)?.webContents.send('skiff:event', 'page-drag', { tab: id, phase, screenX, screenY })
  })
  // A desk window's page reports a vertical swipe that had nothing to scroll; fingers up (by the Mac's scroll setting) opens exposé, and its start (warm) lets exposé take its pictures meanwhile.
  ipcMain.on('skiff:page-expose', (e, dir, warm) => {
    if (deskPage(e) && dir === (naturalScroll ? 1 : -1)) rpc('ui.emit', { name: warm === true ? 'expose-warm' : 'expose', focus: false })
  })
  buildMenu()
  startApi()
  screen.on('display-metrics-changed', refitDesk)
  screen.on('display-removed', refitDesk)
  createWindow()
  prefetchIcons()
  app.on('activate', () => win || createWindow())
  app.on('second-instance', () => {
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  rpc('archive.sweep')
  setInterval(() => rpc('archive.sweep'), 60e3)
}

if (app.requestSingleInstanceLock()) {
  app.on('window-all-closed', () => process.platform === 'darwin' || app.quit())
  app.on('will-quit', () => {
    ai?.stop()
    if (state) flush()
  })
  app.whenReady().then(start)
} else {
  app.quit()
}

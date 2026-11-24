'use strict'
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, dialog, safeStorage, net, clipboard, screen, systemPreferences, Notification, globalShortcut } = require('electron')
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
const { createAgentBrowser } = require('./agent-browser')
const { shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const { createQuit, createUpdates } = require('./updates')
const { spawn } = require('node:child_process')
const { createRegistry, schemaFor } = require('./commands')
const settingsCatalog = require('./settings-catalog')
const { createComponents } = require('./components')
const { createBrowserData } = require('./browser-data')
const { createPageFeatures } = require('./page-features')
const { createAccess } = require('./access')
const { createTranscripts } = require('./transcripts')
const { createSync } = require('./sync')
const D = require('./desktops')
const { createHttpAuth } = require('./http-auth')

app.setName('Skiff')
app.setPath('userData', process.env.SKIFF_DATA ? path.resolve(process.env.SKIFF_DATA) : path.join(app.getPath('appData'), 'Skiff'))
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
const controlDir = path.join(__dirname, '..', 'control')
const toolsDir = path.join(__dirname, '..', 'components', 'browser-tools')
let safeMode = process.argv.includes('--safe-mode')
const previewMode = process.argv.includes('--component-preview')
if (previewMode) process.on('SIGTERM', () => app.quit())
const trustedFiles = new WeakMap()
const surfaceLoads = new WeakMap()
const previews = new Map()
let commandNotice = false
const registry = createRegistry({ changed: () => {
  if (commandNotice) return
  commandNotice = true
  queueMicrotask(() => { commandNotice = false; if (state) pushAi('commands-changed', null) })
} })
let components, browserData, pageFeatures, access, transcripts, sync
const toolSections = ['settings', 'history', 'downloads', 'profiles', 'folders', 'sites', 'sync', 'components', 'grants', 'transcripts', 'page', 'commands']
let splitBounds = null
let roleSpace = null
let installingShell = false
const pendingUrls = process.argv.filter((arg) => /^https?:\/\//i.test(arg))
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!/^https?:\/\//i.test(url)) return
  if (state && win) rpc('links.open', { url })
  else pendingUrls.push(url)
})
const SPARKLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#8b5cf6" d="M8 0c.6 4.2 3.8 7.4 8 8-4.2.6-7.4 3.8-8 8-.6-4.2-3.8-7.4-8-8 4.2-.6 7.4-3.8 8-8z"/></svg>'
const shells = ['default', ...(fs.existsSync(bundledShells) ? fs.readdirSync(bundledShells).filter((name) => fs.existsSync(path.join(bundledShells, name, 'index.html'))).sort() : [])]
const CODES = ['unknown_method', 'bad_params', 'not_found', 'forbidden', 'unauthorized', 'cancelled', 'timeout', 'component_error', 'command_collision', 'bad_schema', 'bad_result', 'user_has_control', 'devtools_attached']

let state
let browserIdentity
const identityForTab = (tab) => tab.browserIdentity || browserIdentity[tab.sessionPartition || 'persist:main'] || 'compatible'
let win = null
let windowReady = Promise.resolve()
let deskMode = false
// macOS desktops (null off macOS): tabs belong to one. Each desktop has a desk window of its own, never on every desktop, so macOS slides a desktop's own pages in and out. `win`, `shown`, `attached`, `slide`, `laidOutSpace` and `ignoring` are those of the window of the current desktop, `deskId`; the windows of the other desktops wait in `parked`, each with its own values of them.
let desktops = null
let deskId = null
const parked = new Map()
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
const pageToolRequests = new Map()
const frames = new Map()
// A control layer view per agent-driven tab on screen, and where each agent cursor last was (window CSS pixels).
const controls = new Map()
const cursors = new Map()
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
// Agent tabs are parked in this window while they are not on screen, so they keep painting and a DevTools screenshot works.
let agentWin = null
const PARKED = { x: 0, y: 0, width: 1280, height: 800 }
let popupBounds = null
const noDesk = () => ({ hit: [], capture: false, preview: null, animate: true, only: null, avoid: null })
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
    closeTab: (wcId) => call('tabs.close', { id: tabOfContents(wcId) }),
    navigateTab: (wcId, url) => call('tabs.navigate', { id: tabOfContents(wcId), url }),
    activateTab: (wcId) => call('tabs.activate', { id: tabOfContents(wcId) }),
    attachView: (view) => win?.contentView.addChildView(view),
    detachView: (view) => win?.contentView.removeChildView(view),
    placeView: (view, bounds) => view.setBounds(edgeBounds(bounds)),
    listChanged: () => { for (const wc of shellContents()) sendEvent(wc, 'extensions-changed', null) }
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
// Whether the user is looking at Skiff, and at this tab in it.
const frontNow = () => (deskMode ? inFront : Boolean(win?.isFocused()))
const looking = (id) => S.activeTab(state)?.id === id && frontNow()
// Whether wheel deltas follow the fingers (macOS "natural scrolling"); an absent setting is the macOS default, on.
// ponytail: read once at launch; a change in System Settings applies after a restart.
const naturalScroll = process.platform !== 'darwin' || (() => {
  try { return require('node:child_process').execFileSync('defaults', ['read', '-g', 'com.apple.swipescrolldirection'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '0' } catch { return true }
})()
const snapshot = () => {
  const rects = S.arrange(state, state.settings.tabLayout)
  return { ...state, shells, naturalScroll, safeMode, splitBounds, update: updates.state() ?? undefined, browserData: browserData?.snapshot(), deskOnly: desk.only, tabs: state.tabs.map((t) => ({ ...live(t), bucket: S.bucketOf(t), ...(rects[t.id] && { desk: { ...t.desk, ...rects[t.id] } }) })) }
}
const sseFrame = (snap) => `event: state\ndata: ${JSON.stringify(snap)}\n\n`

// Frames hear about state only while shown, so a push costs the shown windows; catchUpFrames serves one that shows again.
function pushState() {
  clearTimeout(soonTimer)
  soonTimer = null
  // ponytail: full snapshot per change; send patches if state grows past a few hundred tabs
  const snap = snapshot()
  pushed++
  for (const wc of [win?.webContents, ...[...overlays.values()].map((o) => o.host.webContents), ...chatContents()]) sendEvent(wc, 'state', snap)
  for (const view of shown) {
    if (!seen.has(view)) continue
    sendEvent(view.webContents, 'state', snap)
    seen.set(view, pushed)
  }
  for (const res of streams) res.write(sseFrame(snap))
  components?.emit('state', snap)
}

function changed() {
  save()
  if (installingShell) return
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
    sendEvent(view.webContents, 'state', snap)
    seen.set(view, pushed)
  }
}

// A page view is in the window of its desktop only; one that moves or goes leaves a parked window.
function leaveParked(view) {
  for (const rec of parked.values()) {
    if (!rec.shown.includes(view)) continue
    rec.win.contentView.removeChildView(view)
    rec.shown = rec.shown.filter((v) => v !== view)
    if (rec.attached === view) rec.attached = null
  }
}

function unshow(view) {
  leaveParked(view)
  const move = slide?.moves.get(view)
  slide?.moves.delete(view)
  if (!shown.includes(view) && !move?.leaving) return
  win.contentView.removeChildView(view)
  shown = shown.filter((v) => v !== view)
}

function destroyView(id) {
  pageFeatures?.beforeDestroy(id)
  answerRequest(id)
  const view = views.get(id)
  if (!view) return
  views.delete(id)
  runtime.delete(id)
  unshow(view)
  if (agentViews.has(view)) agentWin?.contentView.removeChildView(view)
  if (attached === view) attached = null
  agentBrowser.release(id)
  destroyControl(id)
  cursors.delete(id)
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
  loadSurface(view.webContents, roleFile('frame', path.join(shellRoot(), frameSpec.file), S.findTab(state, id)?.spaceId), { query: { tab: id } })
  frames.set(id, view)
  view.webContents.on('before-mouse-event', (_e, mouse) => { if (mouse.type === 'mouseDown') pressOutside() })
  // It asks for the state itself once loaded.
  seen.set(view, pushed)
  return view
}

// The control layer: a transparent view over a page an agent is driving. While the agent works it draws the agent's cursor and swallows the user's mouse over the page (keys are dropped in the page's before-input-event); when the user has the tab, or an agent asks for it, it is only a strip across the top.
const STRIP = 44
function controlMode(tab) {
  if (!tab) return null
  if (tab.agentRequest) return 'request'
  if (!tab.agent) return null
  if (tab.agentControl === 'user') return 'user'
  return tab.agentState === 'working' ? 'lock' : null
}

function createControl(id) {
  const view = shellView()
  const wc = view.webContents
  loadSurface(wc, path.join(controlDir, 'control.html'), { query: { tab: id } }).catch(console.error)
  wc.on('did-finish-load', () => { if (cursors.has(id)) sendEvent(wc, 'agent-cursor', { ...cursors.get(id), ms: 0 }) })
  controls.set(id, view)
  // It asks for the state itself once loaded.
  seen.set(view, pushed)
  return view
}

function destroyControl(id) {
  const view = controls.get(id)
  if (!view) return
  controls.delete(id)
  unshow(view)
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// What the user sees of an agent's call: the cursor glides to the target before the click lands, a ripple, a highlight on the field typed into. A page nobody is looking at draws nothing and waits for nothing.
const visual = {
  async glide(id, point) {
    const zoom = views.get(id)?.webContents.getZoomFactor() ?? 1
    const to = { x: point.x * zoom, y: point.y * zoom }
    const from = cursors.get(id)
    cursors.set(id, to)
    const view = controls.get(id)
    if (!view || !shown.includes(view) || view.webContents.isLoading()) return
    const ms = from ? Math.round(Math.min(650, 200 + Math.hypot(to.x - from.x, to.y - from.y) * 0.45)) : 320
    sendEvent(view.webContents, 'agent-cursor', { ...to, ms })
    await sleep(ms + 60)
  },
  ripple(id, point) {
    const zoom = views.get(id)?.webContents.getZoomFactor() ?? 1
    sendEvent(controls.get(id)?.webContents, 'agent-ripple', { x: point.x * zoom, y: point.y * zoom })
  },
  highlight(id, rect) {
    const zoom = views.get(id)?.webContents.getZoomFactor() ?? 1
    sendEvent(controls.get(id)?.webContents, 'agent-highlight', rect && { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom })
  }
}
const agentBrowser = createAgentBrowser({ contentsOf: (id) => { const tab = S.findTab(state, id); if (!tab) return null; const view = views.get(id) || createView(tab); parkAgents(); return view.webContents }, awake: (id) => { const view = views.get(id); if (view) wake(view) }, visual })

function readFrame(shellJson) {
  const f = shellJson?.frame
  if (!S.isObject(f) || typeof f.file !== 'string' || f.file !== path.basename(f.file) || !fs.statSync(path.join(shellRoot(), f.file), { throwIfNoEntry: false })?.isFile()) return null
  const inset = (key) => (Number.isFinite(f[key]) && f[key] >= 0 ? f[key] : 0)
  return { file: f.file, top: inset('top'), right: inset('right'), bottom: inset('bottom'), left: inset('left') }
}

// A conversation tab shows the bundled chat page with the shell's bridge; the core owns its title and icon.
function createChatView(tab) {
  const view = new WebContentsView({ webPreferences: shellWebPreferences })
  const wc = view.webContents
  guardShell(wc)
  wc.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type === 'mouseDown') pressOutside()
    if (deskMode && mouse.type === 'mouseDown' && views.get(tab.id) === view && S.activeTab(state)?.id !== tab.id) call('tabs.activate', { id: tab.id }).catch(console.error)
  })
  loadSurface(wc, roleFile('chat', path.join(chatDir, 'chat.html'), tab.spaceId), { query: { id: tab.url.slice('skiff://chat/'.length) } })
  chatViews.add(view)
  views.set(tab.id, view)
  return view
}

// Picking a space moves the tab, then shows it there, so the page stays in front of the user.
function moveToSpaceMenu(id) {
  const tab = S.findTab(state, id)
  if (!tab) return []
  const targets = state.spaces.filter((space) => (space.id !== tab.spaceId || tab.userPeek) && Boolean(space.incognito) === S.isIncognito(state, tab.spaceId))
  if (!targets.length) return []
  const move = async (spaceId) => {
    await rpc('tabs.move', { id, spaceId })
    await rpc('tabs.activate', { id })
  }
  return [{ label: 'Move to Space', submenu: targets.map((space) => ({ label: space.name, click: () => move(space.id).catch(console.error) })) }]
}

function createView(tab) {
  if (tab.chat) return createChatView(tab)
  const { id } = tab
  const partition = tab.sessionPartition || 'persist:main'
  const ses = getSession(partition)
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, ...(tab.agent && { backgroundThrottling: false }) } })
  if (tab.agent) adoptAgentView(view)
  const wc = view.webContents
  wc.setUserAgent(identityForTab(tab) === 'native' ? nativeUserAgent : compatibleUserAgent)
  browserData?.applyZoom(wc, tab)
  views.set(id, view)
  pageFeatures?.attach(tab, view)
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
    browserData?.applyZoom(wc, tab)
  })
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    if (!isMainFrame) return
    navigated()
    const current = S.findTab(state, id)
    if (current) browserData?.recordVisit(current, { url: wc.getURL(), title: wc.getTitle() })
  })
  // A page view takes its own clicks, so the shell never sees a click on a desk window behind the active one.
  wc.on('before-mouse-event', (_e, mouse) => {
    // DevTools input (an agent's click) is reported here too; it is not the user pressing.
    if (agentBrowser.sent(id, mouse)) return
    if (mouse.type === 'mouseDown') pressOutside()
    if (mouse.type === 'mouseDown' && views.get(id) === view && S.activeTab(state)?.id !== id) call('tabs.activate', { id }).catch(console.error)
  })
  // The user's keys never reach a page an agent is working in. DevTools key events are reported here as well, so the agent's own are told apart by what it is sending.
  wc.on('before-input-event', (event, input) => { if (controlMode(S.findTab(state, id)) === 'lock' && !agentBrowser.sent(id, input)) event.preventDefault() })
  wc.on('did-start-loading', () => update({}, { loading: true }))
  wc.on('did-stop-loading', () => {
    if (views.get(id) === view) S.settle(state, id, looking(id))
    update({}, { loading: false })
  })
  wc.on('did-finish-load', () => {
    const current = S.findTab(state, id)
    if (current) browserData?.recordVisit(current, { url: wc.getURL(), title: wc.getTitle() })
  })
  wc.on('context-menu', (_event, info) => {
    const menu = [
      { label: 'Find in Page', click: () => rpc('ui.openFind', { id }) },
      { label: 'Read Article', click: () => rpc('ui.openReader', { id }) },
      { label: 'Site Controls', click: () => rpc('ui.openTools', { section: 'sites', id }) },
      ...moveToSpaceMenu(id),
      ...(info.linkURL && /^https?:/.test(info.linkURL) ? [
        { label: 'Peek Link', click: () => rpc('peek.open', { url: info.linkURL, sourceId: id }) },
        { label: 'Open Link in Split', click: async () => {
          const other = S.createTab(state, { url: info.linkURL, spaceId: tab.spaceId, activate: false })
          other.sessionPartition = tab.sessionPartition
          await rpc('split.set', { ids: [id, other.id] })
        } }
      ] : [])
    ]
    Menu.buildFromTemplate(menu).popup({ window: win })
  })
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
  return view
}


// The agent reads a tab's page; one that is not loaded gets a view in the background, as prewarm does, and is read once it stops loading.
async function readTab(tab, options) {
  return pageFeatures.read(tab, options)
}

function pageText(tabId) {
  const tab = tabId === undefined ? S.activeTab(state) : S.findTab(state, tabId)
  const wc = tab && !S.isIncognito(state, tab.spaceId) && views.get(tab.id)?.webContents
  return wc && !wc.isDestroyed() && /^https?:/.test(wc.getURL()) ? pageFeatures.read(tab) : null
}


// A chat's agent is done with the tabs it drove when its turn ends.
const chatStatus = new Map()
function pushAi(name, data) {
  if (name === 'chat') {
    const loading = data.status === 'running'
    if (Boolean(runtime.get(data.tabId)?.loading) !== loading) {
      runtime.set(data.tabId, { ...runtime.get(data.tabId), loading })
      changedSoon()
    }
    const was = chatStatus.get(data.id)
    chatStatus.set(data.id, data.status)
    if (was === 'running' && !loading) finishDriven(data.id, data.agent)
    const view = views.get(data.tabId)
    if (view && chatViews.has(view)) sendEvent(view.webContents, 'chat', data)
  } else {
    for (const wc of [...shellContents(), ...chatContents()]) sendEvent(wc, name, data)
  }
  for (const res of streams) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  components?.emit(name, data)
}

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
function zoomStep(wc, delta) {
  const now = wc.getZoomFactor()
  const factor = delta === 0 ? 1 : delta > 0 ? ZOOMS.find((z) => z > now + 1e-3) ?? now : ZOOMS.findLast((z) => z < now - 1e-3) ?? now
  wc.setZoomFactor(factor)
  const tab = S.findTab(state, tabOfContents(wc.id))
  if (tab) browserData?.rememberZoom(wc, tab)
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

const prefetchIcons = F.createPrefetch({ dir: faviconDir, fetch: pageFetch, tabs: () => S.storedTabs(state), changed })

function deskLayout() {
  if (!pageVisible) return []
  const tabs = S.shownTabs(state).filter((t) => !desk.only || desk.only.includes(t.id))
  const preview = desk.preview && S.findTab(state, desk.preview.id)
  if (preview && preview.spaceId === state.activeSpaceId && !tabs.includes(preview)) tabs.push(preview)
  const radius = Math.round(10 * win.webContents.getZoomFactor())
  const f = frameSpec
  const rects = S.arrange(state, state.settings.tabLayout)
  return tabs.map((t) => {
    const r = t === preview ? desk.preview : rects[t.id] || t.desk || S.defaultDesk(state, t)
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
  if (roleSpace !== state.activeSpaceId) {
    roleSpace = state.activeSpaceId
    queueMicrotask(() => replaceSurfaces({ roles: ['shell', 'launcher', 'frame', 'tablist', 'spaces', 'overview', 'chat', ...toolSections] }).catch(console.error))
  }
  for (const id of [...views.keys()]) if (!S.findTab(state, id)) destroyView(id)
  for (const id of [...frames.keys()]) if (!S.findTab(state, id)) destroyFrame(id)
  for (const [id] of [...controls]) if (controlMode(S.findTab(state, id)) === null) destroyControl(id)
  if (!win) return parkAgents()
  if (deskMode) {
    const zoom = win.webContents.getZoomFactor()
    const [width, height] = win.getContentSize()
    state.deskSize = { width: width / zoom, height: height / zoom }
    state.deskTop = frameSpec?.top || 0
    if (desk.avoid) state.deskAvoid = desk.avoid
    else delete state.deskAvoid
  } else {
    delete state.deskSize
    delete state.deskTop
    delete state.deskAvoid
  }
  const switched = deskMode && laidOutSpace !== null && laidOutSpace !== state.activeSpaceId
  const order = (id) => state.spaces.findIndex((x) => x.id === id)
  const dir = heading || Math.sign(order(state.activeSpaceId) - order(laidOutSpace)) || 1
  heading = 0
  laidOutSpace = deskMode ? state.activeSpaceId : null
  // A drag belongs to the space it started in, so a switch ends it where it is.
  if (switched && desk.preview) {
    desk.preview = null
    for (const wc of shellContents()) sendEvent(wc, 'drag-cancel', null)
  }
  if (deskMode && desk.only) trimOnly()
  const tab = S.findTab(state, state.userPeek) || S.activeTab(state)
  let placed = deskMode ? deskLayout() : tab && pageBounds && pageVisible ? [{ tab, bounds: pageBounds, radius: pageBounds.radius }] : []
  const saved = state.splitBySpace?.[state.activeSpaceId]
  const split = saved?.ids.every((id) => S.onDesktop(state, S.findTab(state, id))) ? saved : null
  splitBounds = null
  if (split && pageVisible) {
    const zoom = win.webContents.getZoomFactor()
    const [width, height] = win.getContentSize()
    const area = deskMode ? { x: 12, y: 48, width: width - 24, height: height - 72 } : pageBounds
    if (area) {
      const first = Math.round((area.width - 8) * split.ratio)
      const pair = split.ids.map((id, i) => ({ tab: S.findTab(state, id), bounds: { x: area.x + (i ? first + 8 : 0), y: area.y, width: i ? area.width - first - 8 : first, height: area.height }, radius: 8 })).filter((p) => p.tab)
      placed = [...placed.filter((p) => !split.ids.includes(p.tab.id)), ...pair]
      splitBounds = { spaceId: state.activeSpaceId, x: area.x / zoom, y: area.y / zoom, width: area.width / zoom, height: area.height / zoom, dividerX: (area.x + first) / zoom, ratio: split.ratio }
    }
  }
  const peek = S.findTab(state, state.userPeek)
  if (peek && pageVisible) {
    const [width, height] = win.getContentSize()
    placed = placed.filter((p) => p.tab.id !== peek.id)
    placed.push({ tab: peek, bounds: { x: Math.round(width * .15), y: 72, width: Math.round(width * .7), height: Math.max(160, height - 144) }, radius: 12 })
  }
  const items = placed.flatMap((p) => {
    const mode = controlMode(p.tab)
    return [
      ...(p.frame ? [{ tab: p.tab, view: frames.get(p.tab.id) || createFrame(p.tab.id), bounds: p.frame }] : []),
      { tab: p.tab, view: views.get(p.tab.id) || createView(p.tab), bounds: p.bounds, radius: p.radius },
      ...(mode ? [{ tab: p.tab, view: controls.get(p.tab.id) || createControl(p.tab.id), bounds: mode === 'lock' ? p.bounds : { ...p.bounds, height: Math.min(p.bounds.height, STRIP) }, radius: p.radius }] : [])
    ]
  })
  const next = items.map((item) => item.view)
  if (switched && pageVisible && motion()) beginSlide(items, dir)
  else if (switched || !pageVisible) endSlide()
  if (next.length !== shown.length || next.some((view, i) => view !== shown[i])) {
    for (const view of shown) if (!next.includes(view) && !slide?.moves.get(view)?.leaving) win.contentView.removeChildView(view)
    next.forEach((view, i) => {
      leaveParked(view)
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
  syncDivider()
}

// A page an agent drives is never left without a window: off screen it sits in a hidden one, painting, so DevTools screenshots and timers keep working.
function adoptAgentView(view) {
  agentViews.add(view)
  view.webContents.setBackgroundThrottling(false)
  view.webContents.on('dom-ready', () => wake(view))
}

function parkAgents() {
  // A restored idle agent tab has no page until it is shown or driven.
  const agents = state.tabs.filter((t) => t.agent && (views.has(t.id) || t.agentState === 'working'))
  if (!agents.length) {
    agentWin?.destroy()
    agentWin = null
    return
  }
  agentWin ??= new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: PARKED.width, height: PARKED.height, paintWhenInitiallyHidden: true })
  for (const tab of agents) {
    const view = views.get(tab.id) || createView(tab)
    if (!agentViews.has(view)) adoptAgentView(view)
    if (shown.includes(view) || agentWin.contentView.children.includes(view)) continue
    leaveParked(view)
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
  const cold = state.spaces.flatMap((space) => S.shownTabs(state, space.id)).filter((t) => runtime.get(t.id)?.lifecycle !== 'sleeping' && (!views.has(t.id) || (frameSpec && !frames.has(t.id))))
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
const inShell = (url) => inDir(shellRoot(), url)

const shellContents = () => [win?.webContents, ...[...overlays.values()].map((o) => o.host.webContents), ...[...frames.values()].map((view) => view.webContents)].filter(Boolean)
// A press on a page, a frame or the desk, or another app taking over, is a click outside whatever floats open (the tab list); the Buoy card keeps its own rules.
const pressOutside = () => { if (deskMode) for (const wc of shellContents()) sendEvent(wc, 'desk-press', null) }
const chatContents = () => [...views.values()].filter((view) => chatViews.has(view)).map((view) => view.webContents)
const shellWebPreferences = { preload: path.join(__dirname, 'preload.js'), get additionalArguments() { return [`--skiff-tools-url=${pathToFileURL(toolsDir + path.sep).href}`, `--skiff-icons-url=${pathToFileURL(faviconDir + path.sep).href}`, `--skiff-shell-url=${pathToFileURL(shellRoot() + path.sep).href}`] }, contextIsolation: true, sandbox: true, nodeIntegration: false }

function guardShell(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    const entry = [...overlays].find(([, overlay]) => overlay.shown && overlay.host.webContents === wc)
    if (!entry) return
    event.preventDefault()
    const [name, overlay] = entry
    const id = overlay.loadOptions?.query?.id
    hideOverlay(name)
    if (['find', 'reader'].includes(name) && id && S.findTab(state, id)) call(`${name}.close`, { id }).catch(console.error)
  })
  wc.on('will-navigate', (e) => {
    if (!trustedFiles.has(wc) || filePath(e.url) !== trustedFiles.get(wc).file) e.preventDefault()
  })
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function filePath(url) {
  try { return fileURLToPath(url) } catch { return '' }
}

function roleFile(role, fallback, spaceId = state.activeSpaceId) {
  return (!safeMode && components?.resolve(role, { spaceId }))?.file || fallback
}

function stockShellRoot(name = state?.settings.shell) {
  return !safeMode && name !== 'default' && shells.includes(name) ? path.join(bundledShells, name) : bundledShell
}

function shellRoot() {
  return (!safeMode && components?.resolve('shell', { spaceId: state.activeSpaceId }))?.path || stockShellRoot()
}

function loadSurface(wc, file, options) {
  const previous = surfaceLoads.get(wc)
  const entry = {}
  surfaceLoads.set(wc, entry)
  const start = () => {
    if (surfaceLoads.get(wc) !== entry) return null
    if (wc.isDestroyed()) throw S.err('cancelled', 'Surface closed before navigation')
    const owner = components?.ownerForFile(file) || 'host'
    trustedFiles.set(wc, { file: path.resolve(file), owner, bridge: owner === 'host' ? null : components.bridge(owner), grants: new Set(owner === 'host' ? [] : components.inspect({ id: owner }).grants) })
    return wc.loadFile(file, options)
  }
  // Electron's load promises share navigation events. Let the cancelled load
  // settle before installing the next one's listeners, or its abort can reject
  // the new load even though the new document successfully reaches the renderer.
  if (previous && !wc.isDestroyed()) wc.stop()
  const ready = entry.ready = (previous ? previous.ready.catch(() => {}) : Promise.resolve()).then(start)
  const settled = () => { if (surfaceLoads.get(wc) === entry) surfaceLoads.delete(wc) }
  ready.then(settled, settled)
  if (wc === win?.webContents) windowReady = ready
  return ready
}

function sendEvent(wc, name, data) {
  if (!wc || wc.isDestroyed()) return
  const source = trustedFiles.get(wc)
  if (!source || source.invalid) return
  if (source.owner !== 'host' && !source.grants.has('events:*') && !source.grants.has(`events:${name}`) && !(name === 'settings.changed' && source.owner === data?.owner && source.grants.has('storage'))) return
  wc.send('skiff:event', name, data)
}

function notifyHostSettings({ owner, key, spaceId } = {}) {
  for (const wc of [...shellContents(), ...chatContents()]) {
    const source = trustedFiles.get(wc)
    if (source?.owner === 'host' || source?.grants.has('host.manage')) sendEvent(wc, 'component-settings-changed', { owner, key, spaceId })
  }
}

async function replaceSurfaces({ roles = [], owner, action } = {}) {
  if (!win || installingShell) return
  const retiredOwners = new Set(action !== 'bind' && owner ? [owner] : [])
  notifyHostSettings({ owner })
  if (owner && action !== 'bind') for (const wc of [...shellContents(), ...chatContents()]) {
    const source = trustedFiles.get(wc)
    if (source?.owner === owner) source.invalid = true
  }
  const shellFile = roles.includes('shell') ? roleFile('shell', path.join(shellRoot(), 'index.html')) : null
  const shellSource = trustedFiles.get(win.webContents)
  if (shellFile && shellSource && (shellSource.invalid || shellSource.file !== path.resolve(shellFile))) retiredOwners.add(shellSource.owner)
  // A space switch can resolve to the same surface. Retire only a real source
  // transition, and never a replacement auxiliary created while its shell loads.
  const retiredAuxiliaries = new Map()
  for (const overlay of overlays.values()) {
    const source = trustedFiles.get(overlay.host.webContents)
    if (!overlay.role && !overlay.component && retiredOwners.has(source?.owner)) retiredAuxiliaries.set(overlay, source)
  }
  const loadChanged = (wc, file, options) => !trustedFiles.get(wc)?.invalid && trustedFiles.get(wc)?.file === path.resolve(file) ? Promise.resolve() : loadSurface(wc, file, options)
  if (roles.includes('shell')) {
    watchShell()
    if (shellIsDesk() !== deskMode) {
      closeShellViews()
      await recreateWindow()
      syncView()
      pushState()
      return
    }
    frameSpec = deskMode ? readFrame(manifest()) : null
    for (const [id, rec] of parked) {
      const source = trustedFiles.get(rec.win.webContents)
      if (source?.invalid || source?.file !== path.resolve(shellFile) || retiredOwners.has(source.owner)) dropParked(id)
    }
    await loadChanged(win.webContents, shellFile)
  }
  if (roles.includes('frame')) {
    for (const [id, view] of frames) await loadChanged(view.webContents, roleFile('frame', path.join(shellRoot(), frameSpec.file), S.findTab(state, id)?.spaceId), { query: { tab: id } })
  }
  if (roles.includes('chat')) {
    for (const [id, view] of views) if (chatViews.has(view)) {
      const tab = S.findTab(state, id)
      await loadChanged(view.webContents, roleFile('chat', path.join(chatDir, 'chat.html'), tab.spaceId), { query: { id: tab.url.slice('skiff://chat/'.length) } })
    }
  }
  for (const [name, overlay] of overlays) {
    if (overlay.role && roles.includes(overlay.role)) {
      const file = roleFile(overlay.role, overlay.fallback)
      await loadChanged(overlay.host.webContents, file, overlay.loadOptions)
    } else if (owner && overlay.component?.id === owner) {
      try {
        const next = components.surface(overlay.component)
        await loadChanged(overlay.host.webContents, next.file, overlay.loadOptions)
      } catch { hideOverlay(name) }
    } else if (retiredAuxiliaries.has(overlay) && retiredAuxiliaries.get(overlay) === trustedFiles.get(overlay.host.webContents)) {
      hideOverlay(name)
    }
  }
  syncView()
  pushState()
}

async function showHostSurface(file, { name = 'tools', query = {}, bounds, focus = true, role, fallback = file, component } = {}, context = {}) {
  context.signal?.throwIfAborted()
  if (!win) throw S.err('not_found', 'No window is open')
  let overlay = overlays.get(name)
  const created = !overlay
  if (!overlay) overlays.set(name, overlay = { host: shellView(), float: false, bounds: null, hit: null, shown: false, ignoring: false })
  const request = overlay.request = {}
  overlay.component = component
  overlay.role = role
  overlay.fallback = fallback
  overlay.loadOptions = { query: Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])) }
  const target = pathToFileURL(file)
  target.search = new URLSearchParams(overlay.loadOptions.query).toString()
  try {
    if (overlay.host.webContents.getURL() !== target.href) await loadSurface(overlay.host.webContents, file, overlay.loadOptions)
    context.signal?.throwIfAborted()
  } catch (error) {
    if (created && overlays.get(name) === overlay && overlay.request === request) {
      overlays.delete(name)
      if (!overlay.host.webContents.isDestroyed()) overlay.host.webContents.close()
    }
    throw error
  }
  if (!win || overlays.get(name) !== overlay || overlay.request !== request) return null
  overlay.bounds = bounds ? cssBounds(bounds) : null
  overlay.shown = true
  win.contentView.addChildView(overlay.host)
  fitOverlay(overlay)
  if (focus) focusShell(overlay)
  if (name === 'tools') sendEvent(overlay.host.webContents, 'tools-open', query)
  return { name }
}

let dividerPending = false
function syncDivider() {
  if (!splitBounds) { if (overlays.get('split-divider')?.shown) hideOverlay('split-divider'); return }
  const b = splitBounds
  const overlay = overlays.get('split-divider')
  if (overlay?.shown) {
    overlay.bounds = cssBounds({ x: b.dividerX, y: b.y, width: 8, height: b.height })
    fitOverlay(overlay)
    sendEvent(overlay.host.webContents, 'split-bounds', b)
  } else if (!dividerPending) {
    dividerPending = true
    showHostSurface(roleFile('split', path.join(toolsDir, 'split.html')), { name: 'split-divider', role: 'split', fallback: path.join(toolsDir, 'split.html'), bounds: { x: b.dividerX, y: b.y, width: 8, height: b.height }, focus: false }).then(() => {
      sendEvent(overlays.get('split-divider')?.host.webContents, 'split-bounds', splitBounds)
    }).catch(console.error).finally(() => { dividerPending = false })
  }
}

function reloadShell() {
  dropParked()
  frameSpec = deskMode ? readFrame(manifest()) : null
  for (const wc of shellContents()) if (inShell(wc.getURL())) wc.reloadIgnoringCache()
  syncView()
}

function watchShell() {
  watcher?.close()
  watcher = null
  const root = shellRoot()
  // Bundled shells inside app.asar cannot change and fs.watch fails on them.
  if (root.split(path.sep).some((part) => part.endsWith('.asar'))) return
  watcher = watchShellFiles(root, reloadShell)
}

// Stock sources always remain bundled. Switching selects them without rewriting owned copies.
async function installShell(name) {
  await windowReady
  const source = stockShellRoot(name)
  watcher?.close()
  installingShell = true
  try {
    await components.refreshStock({ id: 'stock.shell', root: source, manifest: stockShellManifest(source) })
    for (const role of ['shell', 'launcher', 'frame', 'tablist', 'spaces', 'overview']) {
      const selected = components.inspect().bindings.global[role]
      if (selected && !selected.startsWith('stock.') && selected !== 'legacy.shell') continue
      const id = stockShellManifest(source).surfaces[role] ? 'stock.shell' : `stock.${role}`
      if (components.list().some((item) => item.id === id)) await components.bind({ role, id })
    }
  } finally { installingShell = false }
  state.settings.shell = name
  save()
  closeShellViews()
  setWindowButtons(true)
  watchShell()
  dropParked()
  if (win && shellIsDesk() !== deskMode) await recreateWindow()
  else if (win) {
    frameSpec = deskMode ? readFrame(manifest()) : null
    await loadSurface(win.webContents, roleFile('shell', path.join(shellRoot(), 'index.html')))
  }
  buildMenu()
  changed()
}

function closeShellViews() {
  for (const name of [...overlays.keys()]) hideOverlay(name)
  for (const o of overlays.values()) o.host.webContents.close()
  overlays.clear()
  for (const id of [...frames.keys()]) destroyFrame(id)
  for (const id of [...controls.keys()]) destroyControl(id)
}

function manifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(shellRoot(), 'shell.json'), 'utf8'))
  } catch {
    return null
  }
}

const shellIsDesk = () => !safeMode && manifest()?.window === 'desk'

// The new window opens before the old one goes, or the app would quit with no window left.
async function recreateWindow() {
  const old = win
  dropParked()
  if (!deskMode) state.window = old.getNormalBounds()
  extensions.closePopup()
  endSlide()
  for (const view of shown) old.contentView.removeChildView(view)
  shown = []
  attached = null
  try { await createWindow(old.getBounds()) }
  finally { if (!old.isDestroyed()) old.destroy() }
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

function hideOverlay(name = 'main', refocus = true) {
  pageToolRequests.delete(name)
  const o = overlays.get(name)
  if (o) o.request = null
  if (name === 'tools' && o?.shown) sendEvent(o.host.webContents, 'tools-hidden', null)
  if (o?.float) {
    overlays.delete(name)
    if (!o.host.isDestroyed()) o.host.destroy()
    return
  }
  if (!o?.shown) return
  const focused = name === 'main' || o.host.webContents.isFocused()
  o.shown = false
  win?.contentView.removeChildView(o.host)
  if (focused && refocus) (attached || win)?.webContents.focus()
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
    const was = inFront
    inFront &&= Boolean(focused && (focused === win || parkedWin(focused) || [...overlays.values()].some((o) => o.float && o.host === focused)))
    if (was && !inFront) pressOutside()
  }, 100)
}

// A Dock click or Cmd+Tab brings the desk forward; Skiff raising itself or a click on one of its windows does not count.
function deskFocused() {
  extensions.windowFocus(true)
  if (deskMode && !inFront && Date.now() - raisedAt > 400 && !overDesk(screen.getCursorScreenPoint())) {
    for (const wc of shellContents()) sendEvent(wc, 'desk-activated', null)
  }
  inFront = true
}

const deskArea = (near) => (['x', 'y', 'width', 'height'].every((key) => Number.isFinite(near?.[key])) ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()).workArea

function refitDesk() {
  for (const w of [win, ...[...parked.values()].map((rec) => rec.win)]) if (w && deskMode) w.setBounds(deskArea(w.getBounds()))
}

// Whether the desk window feature is on: a desk shell on a Mac whose desktops can be read; reports whether anything it keeps changed.
function readDesktops() {
  const before = JSON.stringify([state.desktops, state.tabs.map((t) => t.desktopId), state.activeTabBySpace])
  let info = null
  const list = deskMode && desktops ? desktops.list() : []
  if (list.length) {
    const now = desktops.current()
    const ids = list.map((d) => d.id)
    info = { list, current: ids.includes(now) ? now : ids.includes(state.desktops?.current) ? state.desktops.current : ids[0] }
  }
  S.setDesktops(state, info, Date.now())
  return JSON.stringify([state.desktops, state.tabs.map((t) => t.desktopId), state.activeTabBySpace]) !== before
}

function desktopsChanged() {
  const moved = readDesktops()
  followDesktop()
  if (moved) changed()
}

const parkedWin = (w) => [...parked.values()].some((rec) => rec.win === w)

// Closes the parked window of one desktop, or of every one; a desktop that comes back gets a new window.
function dropParked(id) {
  for (const key of id === undefined ? [...parked.keys()] : [id]) {
    const rec = parked.get(key)
    parked.delete(key)
    if (!rec || rec.win.isDestroyed()) continue
    for (const view of rec.shown) rec.win.contentView.removeChildView(view)
    rec.win.destroy()
  }
}

// The desk follows the current desktop with that desktop's own window. The one just left stays as it is until its desktop is back; a desktop never seen gets a window now, which macOS puts on the active desktop, shown without taking the keyboard from the app in front.
function followDesktop() {
  const list = state.desktops?.list
  if (list) for (const key of [...parked.keys()]) if (!list.some((d) => d.id === key)) dropParked(key)
  const id = state.desktops?.current
  if (!win || !deskMode || id === undefined) return
  if (deskId === null) deskId = id
  if (id === deskId) return
  endSlide()
  extensions.closePopup()
  for (const [name, o] of overlays) if (o.shown && !o.float) hideOverlay(name, false)
  parked.set(deskId, { win, shown, attached, laidOutSpace, ignoring })
  const back = parked.get(id)
  parked.delete(id)
  deskId = id
  if (!back) return void createWindow(win.getBounds(), { quiet: true }).catch(console.error)
  ;({ win, shown, attached, ignoring } = back)
  laidOutSpace = null
  watchPointer()
}

function createWindow(near = state.window, { quiet = false } = {}) {
  deskMode = shellIsDesk()
  readDesktops()
  deskId = state.desktops?.current ?? null
  frameSpec = deskMode ? readFrame(manifest()) : null
  for (const view of views.values()) view.webContents.send('skiff:desk-page', deskMode)
  laidOutSpace = null
  shown = []
  attached = null
  const w = win = new BrowserWindow(deskMode
    ? { ...deskArea(near), show: !quiet, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, roundedCorners: false, backgroundColor: '#00000000', webPreferences: shellWebPreferences }
    : { ...state.window, minWidth: 560, minHeight: 360, titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', webPreferences: shellWebPreferences })
  ignoring = false
  guardShell(win.webContents)
  win.webContents.on('before-mouse-event', (_e, mouse) => { if (mouse.type === 'mouseDown') pressOutside() })
  if (quiet) w.showInactive()
  // A desktop's first window loads beside the live Buoy and tab list, which stay.
  let keepFloats = quiet
  win.webContents.on('did-start-loading', () => {
    if (win !== w) return
    pageVisible = true
    pageBounds = null
    shellLoads++
    desk = noDesk()
    const keep = keepFloats
    keepFloats = false
    for (const [name, o] of [...overlays]) if (!(keep && o.float)) hideOverlay(name)
    extensions.closePopup()
    setWindowButtons(true)
    syncView()
  })
  win.webContents.on('did-finish-load', () => {
    if (win !== w) return
    clearTimeout(warmTimer)
    warmTimer = setTimeout(prewarm, 500)
  })
  const fitOverlays = () => { if (win === w) for (const o of overlays.values()) if (o.shown) fitOverlay(o) }
  win.on('move', fitOverlays)
  win.on('resize', () => {
    if (win !== w) return
    fitOverlays()
    const popup = extensions.popupView()
    if (popup) popup.setBounds(edgeBounds(popupBounds))
    if (deskMode) {
      syncView()
      if (state.settings.tabLayout !== 'free') soonTimer ??= setTimeout(pushState, 16)
    }
  })
  win.on('focus', () => {
    if (win !== w && !parkedWin(w)) return
    deskFocused()
    if (deskMode) desktopsChanged()
    if (S.look(state)) changed()
  })
  win.on('blur', () => {
    if (win !== w) return
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
    if (win !== w) {
      for (const [key, rec] of parked) if (rec.win === w) parked.delete(key)
      return
    }
    clearInterval(slide?.timer)
    slide = null
    clearTimeout(warmTimer)
    warmTimer = null
    win = null
    deskId = null
    dropParked()
    attached = null
    shown = []
    pageBounds = null
    closeShellViews()
    for (const id of [...views.keys()]) if (!agentViews.has(views.get(id))) destroyView(id)
    parkAgents()
    // The hidden agent window would keep window-all-closed from firing.
    if (process.platform !== 'darwin') app.quit()
  })
  const ready = loadSurface(w.webContents, roleFile('shell', path.join(shellRoot(), 'index.html')))
  ready.catch(console.error)
  watchPointer()
  return ready
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

const toolNames = {
  'tabs.list': 'browser_list_tabs', 'tabs.read': 'browser_read_page', 'tabs.create': 'browser_open_tab', 'tabs.navigate': 'browser_navigate', 'tabs.activate': 'browser_activate_tab', 'tabs.close': 'browser_close_tab',
  'tabs.snapshot': 'browser_snapshot', 'tabs.click': 'browser_click', 'tabs.type': 'browser_type', 'tabs.press': 'browser_press', 'tabs.scroll': 'browser_scroll', 'tabs.screenshot': 'browser_screenshot', 'tabs.wait': 'browser_wait',
  'agent.requestTab': 'browser_request_tab', 'agent.finish': 'browser_finish'
}
const def = (name, params, description, run) => registry.register('core', { name, description, params, inputSchema: schemaFor(name), tool: toolNames[name] ? { name: toolNames[name] } : false, run })
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

def('commands.list', '', 'Every command with its description and params', () => registry.list())
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
    browserData.forgetPartition(space.sessionPartition)
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
  call('ui.emit', { name: 'focus-address' }).catch(console.error)
  return space
})

def('tabs.create', '{url, spaceId?, parentId?, activate?, agent?}', 'Open a tab using the selected search behavior; agent names an agent that opens it as its own tab: an ordinary tab of the space (never activated; saved and archived like any tab, but after a restart it is idle) that only that agent may drive with the browser tools. A scoped grant always opens its own agent tabs', async (p, context) => {
  // Scoped agents supply explicit HTTP URLs; replaceable search must not acquire their browser authority.
  const url = context.accessContext ? S.webUrl(p.url) : (await call('search.resolve', { text: p.url }, context)).url
  context.signal?.throwIfAborted()
  if (context.accessContext) access.assert(context.accessContext, { command: 'tabs.create', params: { ...p, url } })
  const tab = mutate(S.createTab)({ ...p, url })
  const chat = context.accessContext && access.sessionOf(context.accessContext)
  if (tab.agent && chat) driven.set(chat, (driven.get(chat) || new Set()).add(tab.id))
  return tab
})
def('tabs.close', '{id?}', 'Close a tab into the archive; favorites and pinned tabs are unloaded and kept; incognito tabs are dropped. An archived agent tab restores as a plain tab', (p) => {
  const result = S.closeTab(state, p, Date.now())
  if (views.has(result.unloaded)) destroyView(result.unloaded)
  changed()
  return result
})
def('tabs.activate', '{id}', 'Show a tab, switching to its space; a tab on another macOS desktop moves to the current one; a finished agent tab counts as seen once shown', mutate(S.activateTab))
def('tabs.read', '{id?}', "A tab's page as {title, url, selection, text}", (p, context) => {
  const tab = S.getTab(state, p.id)
  if (tab.chat) throw S.err('bad_params', 'That tab is a conversation, not a web page.')
  return readTab(tab, { signal: context.signal })
})
def('tabs.navigate', '{id?, url, browserIdentity?}', 'Navigate a tab using its existing profile and selected search behavior', async (p, context) => {
  const before = S.getTab(state, p.id)
  const wasChat = Boolean(before.chat)
  const previousIdentity = identityForTab(before)
  p = { ...p, url: context.accessContext ? S.webUrl(p.url) : (await call('search.resolve', { text: p.url }, context)).url }
  context.signal?.throwIfAborted()
  if (context.accessContext) access.assert(context.accessContext, { command: 'tabs.navigate', params: p })
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
  for (const wc of shellContents()) sendEvent(wc, 'url-copied', { url })
  return { url }
})
def('tabs.move', '{id, index?, spaceId?}', "Reorder a tab among its siblings or move it to another space as a root; not into or out of the incognito space. The tab takes the destination space's profile: when that differs, the page reloads at its current address in the new profile's session, and a tab-level browserIdentity is dropped (WhatsApp stays compatible); within one profile the live page is untouched. A link peek needs spaceId (its own is fine) and becomes a tab there, active", (p) => {
  const before = S.getTab(state, p.id).sessionPartition
  const tab = mutate(S.moveTab)(p)
  if (tab.sessionPartition !== before) destroyView(tab.id)
  return tab
})
def('tabs.setFavorite', '{id?, favorite}', 'Make a tab a favorite of its space, or turn it back into a plain tab there', mutate(S.setFavorite))
def('tabs.setPinned', '{id?, pinned, folder?}', 'Pin a tab to its space, optionally in a folder, or unpin it', mutate(S.setPinned))
def('tabs.setBucket', '{id?, bucket}', 'Move a tab to a bucket: favorites, later (pinned), active, unread or done; progress is set by loading pages and working chats only', mutate(S.setBucket))
def('tabs.cycle', '{delta}', 'Show the next (1) or previous (-1) tab of the active space', mutate(S.cycleTab))
def('tabs.select', '{index}', 'Show the index-th unpinned tab of the active space (and current macOS desktop) in Ctrl+Tab order; negative counts from the end; null past the end', mutate(S.selectTab))
def('tabs.thumbnails', '{ids, width?}', 'Pictures of up to 24 tabs as [{id, image}] in the order of ids, image a JPEG data URL at most width pixels wide (default 480, at most 3840; a page narrower on screen keeps its own size) at the page\'s aspect, or null when the tab is not on screen (hidden, in another space or not loaded), cannot be captured or is incognito while another space shows', async (p) => {
  const { tabs, width } = S.thumbnailTabs(state, p)
  return Promise.all(tabs.map(async (tab, i) => {
    const view = tab && views.get(tab.id)
    // A view that is not in the window draws no frames, so its capturePage never settles.
    const wc = view && shown.includes(view) && !view.webContents.isDestroyed() ? view.webContents : null
    const shot = wc ? await pageFeatures.capture(tab).catch(() => null) : null
    if (!shot || shot.isEmpty()) return { id: p.ids[i], image: null }
    const fit = shot.getSize(Math.max(1, ...shot.getScaleFactors())).width > width ? shot.resize({ width, quality: 'good' }) : shot
    return { id: p.ids[i], image: `data:image/jpeg;base64,${fit.toJPEG(80).toString('base64')}` }
  }))
})

def('folders.setCollapsed', '{spaceId?, folder, collapsed}', 'Collapse or expand a folder of pinned tabs; spaceId defaults to the active space', mutate(S.setCollapsed))

def('desk.place', '{id?, x, y, width, height}', 'Put a tab on the desk of a desk shell or move or resize it there, in window CSS pixels, at least 240 by 160, show it if hidden and bring it to the front; the rect is remembered for the host of the tab, so its next new window opens there', mutate(S.placeDesk))
def('desk.layouts', '', 'Get layouts from the selected layout component', (_p, context) => behavior('layout', { op: 'layouts' }, context))
def('desk.tile', '{id?, layout}', 'Place a tab using the selected layout component', (p, context) => behavior('layout', { ...p, op: 'tile' }, context))
def('desk.hide', '{id?}', 'Hide a desk window; the tab stays in its space and keeps its rect (the default one if it had none); if it was the active tab, the frontmost window left in the space becomes active, or none', mutate(S.hideDesk))
def('desk.show', '{id}', 'Show a hidden desk window in front and make it the active tab', mutate(S.showDesk))

def('archive.restore', '{id?}', 'Reopen an archived tab; without id, the most recent', mutate(S.restore))
def('archive.remove', '{id}', 'Delete one archive entry', mutate(S.removeArchived))
def('archive.clear', '', 'Delete every archive entry', mutate(S.clearArchive))
def('archive.sweep', '', 'Run the selected archive policy', (_p, context) => behavior('archive', {}, context))

def('import.arc.preview', '{profileId?}', 'List Arc profiles and tab counts without opening protected data', (p) => importer.preview(p))
def('import.arc', '{profileIds: string[], categories:{tabs,openTabs,passwords,logins}, keepSpaces}', 'Import any selected Arc profiles; passwords and sign-ins require one native confirmation', (p) => importer.run(p).finally(() => {
  prefetchIcons()
}))
def('passwords.fill', '', 'Ask which saved account to fill on the active site; never returns credentials', fillPassword)

const settingsActions = {
  defaultBrowser: {
    // macOS shows its own confirmation; only the packaged app can register as the browser.
    supported: () => app.isPackaged && process.platform === 'darwin',
    status: () => {
      const done = app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https')
      return { text: done ? 'Skiff is your default browser.' : '', available: !done }
    },
    run: () => { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https') }
  },
  update: {
    supported: () => Boolean(updates.state()),
    status: () => {
      const { status, version } = updates.state()
      return { text: status === 'ready' ? `Skiff ${version} is ready.` : status === 'downloading' ? `Downloading Skiff ${version}...` : '', available: status === 'ready' }
    },
    run: () => updates.install()
  }
}

def('settings.set', '{autoArchiveHours?, searchUrl?, shortcuts?, globalShortcuts?, ai?, browserIdentity?}', 'Change settings; browserIdentity merges {persistentPartition: "native"|"compatible"} and applies only after restarting Skiff, without changing profile storage; compatible is the default. shortcuts replaces the whole map of accelerator to {method, params?}; globalShortcuts does the same for system-wide accelerators that bring Skiff to the front before running their method; autoArchiveHours 0 turns auto-archive off; ai {agents?, agent?, model?, effort?} merges into the agent settings: agents [{name, command}] (at most 10, unique names of at most 40 characters, commands of at most 500 run in the login shell), agent the default one, model and effort the last choices; an agent removed or whose command changed is stopped', (p) => {
  for (const map of [p.shortcuts, p.globalShortcuts]) {
    for (const s of Object.values(S.isObject(map) ? map : {})) {
      if (!registry.has(s?.method)) throw S.err('bad_params', `Unknown method in shortcuts: ${s?.method}`)
    }
  }
  const settings = S.setSettings(state, p)
  if (p.shortcuts) buildMenu()
  if (p.globalShortcuts) registerGlobalShortcuts()
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
def('ui.setDesk', '{hit?, capture?, preview?, animate?, only?, avoid?}', "Desk shells only, not saved: avoid {x, y, width, height} (null clears it) is the open Buoy card, which a new window is placed clear of (state.deskAvoid); hit lists the shell's own clickable rectangles {x, y, width, height} in shell CSS pixels; capture: true keeps every click in Skiff during a drag or resize; preview {id, x, y, width, height} draws that tab (and its frame) there at once without saving it, null clears it; animate: false switches spaces without sliding the windows, as reduced motion in the system settings does; only [tabIds] shows just those windows of the active space, the active tab joining them, and leaves every other window loaded but off the desk and out of the way of clicks, until null, a space switch or the last of them closing or hiding (state.deskOnly holds the set); each field given replaces its last value", (p) => {
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
  if (p.avoid !== undefined) next.avoid = p.avoid === null ? null : cssRect(p.avoid)
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
def('ui.showOverlay', '{file, bounds?, name?, focus?, float?, hit?, under?}', 'Show a shell overlay, resolving independently bound component roles', async (p, context) => {
  context.signal?.throwIfAborted()
  const role = ({ 'palette.html': 'launcher', 'tablist.html': 'tablist', 'panel.html': 'spaces', 'spaces.html': 'spaces', 'expose.html': 'overview', 'settings.html': 'settings' })[p.file]
  const fallback = typeof p.file === 'string' && p.file === path.basename(p.file) ? path.join(shellRoot(), p.file) : ''
  const file = role ? roleFile(role, fallback) : fallback
  if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw S.err('bad_params', 'file must name a shell file or a bound component surface')
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
  const request = o.request = {}
  // The file loads before the view shows, so an event emitted right after reaches the loaded page.
  const same = o.host.webContents.getURL() === pathToFileURL(file).href
  const loads = shellLoads
  o.role = role
  o.fallback = fallback
  if (!same) await loadSurface(o.host.webContents, file).catch((e) => { if (overlays.get(name) === o && o.request === request) throw e })
  context.signal?.throwIfAborted()
  // Only the latest request in this slot may publish geometry or take focus.
  if (!win || overlays.get(name) !== o || o.request !== request || loads !== shellLoads) return null
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
  for (const wc of shellContents()) sendEvent(wc, p.name, p.data)
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
def('ui.resetShell', '', 'Back up the live shell and restore the default shell', async () => {
  const backup = fs.existsSync(shellDir) ? path.join(dataDir, `shell.bak-${Date.now()}`) : null
  if (backup) fs.renameSync(shellDir, backup)
  await installShell('default')
  return { backup }
})
def('ui.setShell', '{name}', 'Replace the live shell while preserving native pages and custom role bindings', async (p) => {
  if (!shells.includes(p.name)) throw S.err('not_found', `No shell named ${p.name}. Shells: ${shells.join(', ')}`)
  await installShell(p.name)
  return { shell: p.name }
})
def('ui.shellPath', '', 'Source directory and ownership of the selected shell', () => {
  const selected = components.resolve('shell', { spaceId: state.activeSpaceId })
  const source = selected && components.inspect({ id: selected.owner })
  return { path: source?.path || shellRoot(), owner: source?.id || 'stock.shell', readOnly: !source || source.kind === 'stock' }
})
def('ui.capture', "{target: 'shell'|'page', id?}", 'Capture a native surface with a bounded deadline', async (p, context) => {
  let image
  if (p.target === 'page') {
    const tab = S.getTab(state, tabOfContents(targetContents(p).id))
    if (context.accessContext) access.assert(context.accessContext, { command: 'tabs.capture', params: { id: tab.id } })
    image = await pageFeatures.capture(tab, { signal: context.signal })
    if (context.accessContext) access.assert(context.accessContext, { command: 'tabs.capture', params: { id: tab.id }, after: true })
  } else {
    if (context.accessContext) throw S.err('forbidden', 'Scoped agents cannot capture the host interface')
    const wc = targetContents(p)
    let timer
    try { image = await Promise.race([wc.capturePage(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(S.err('timeout', 'Capture timed out')), 5000) })]) }
    finally { clearTimeout(timer) }
  }
  return { ...image.getSize(), png: image.toPNG().toString('base64') }
})
def('ui.devtools', "{target: 'shell'|'page'}", 'Open devtools for the shell or the active page', (p) => {
  targetContents(p).openDevTools({ mode: 'detach' })
  return null
})

const string = { type: 'string' }, boolean = { type: 'boolean' }, number = { type: 'number' }
const strings = { type: 'array', items: string }
function command(name, description, properties, required, run) {
  registry.register('core', { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, tool: toolNames[name] ? { name: toolNames[name] } : false, run })
}
const ids = { id: string }, space = { spaceId: string }
for (const [name, fn, fields, required] of [
  ['folders.create', S.createFolder, { name: string, ...space, parentId: { type: ['string', 'null'] } }, ['name']],
  ['folders.update', S.updateFolder, { ...ids, name: string, collapsed: boolean }, ['id']],
  ['folders.move', S.moveFolder, { ...ids, ...space, parentId: { type: ['string', 'null'] }, index: { type: 'integer' } }, ['id']],
  ['folders.remove', S.removeFolder, ids, ['id']],
  ['tabs.setTrailCollapsed', S.setTrailCollapsed, { ...ids, collapsed: boolean }, ['collapsed']],
  ['profiles.create', S.createProfile, { name: string }, ['name']],
  ['profiles.update', S.updateProfile, { ...ids, name: string }, ['id', 'name']],
  ['profiles.remove', S.removeProfile, ids, ['id']],
  ['profiles.assign', S.assignProfile, { ...space, profileId: string }, ['profileId']],
  ['links.setRule', S.setLinkRule, { ...ids, host: string, ...space, profileId: string }, ['host', 'spaceId']],
  ['links.removeRule', S.removeLinkRule, ids, ['id']],
  ['split.set', S.setSplit, { ids: { type: 'array', items: string, minItems: 2, maxItems: 2 }, ratio: number, activeId: string }, ['ids']],
  ['split.resize', S.resizeSplit, { ...space, ratio: number }, ['ratio']],
  ['split.clear', S.clearSplit, space, []],
  ['peek.open', S.createPeek, { url: string, sourceId: string }, ['url']],
  ['peek.promote', S.promotePeek, ids, []],
  ['peek.dismiss', S.dismissPeek, ids, []]
]) command(name, name.replaceAll('.', ' '), fields, required, mutate(fn))
command('tabs.list', 'List normal browser tabs', {}, [], () => {
  const tabs = access.listNormalTabs().map((tab) => ({ ...tab, bucket: S.bucketOf(tab), ...(state.desktops && { desktop: S.desktopNumber(state, tab.desktopId) }) }))
  const active = S.activeTab(state)
  return { tabs, activeTabId: tabs.some((tab) => tab.id === active?.id) ? active.id : null }
})

// Agents drive tabs through these. Every call names its agent, and S.agentCall holds the one rule for the owner CLI and scoped grants alike:
// an agent drives only a tab it opened (tabs.create {agent}) or was handed, and never one the user took over. The page work is src/agent-browser.js.
const driven = new Map()
const requests = new Map()
const agentProp = { type: 'string', minLength: 1, maxLength: 40 }
const tabProps = { tabId: string, id: string, agent: agentProp }

function drive(run) {
  return async (p, context) => {
    const before = S.findTab(state, p.tabId ?? p.id)
    const steady = before?.agentState === 'working' && !before.agentUnseen
    const tab = S.agentCall(state, p, Date.now())
    const chat = context.accessContext && access.sessionOf(context.accessContext)
    if (chat) driven.set(chat, (driven.get(chat) || new Set()).add(tab.id))
    if (!steady) changed()
    context.signal?.throwIfAborted()
    return run(tab.id, p)
  }
}

// A request waiting on the user ends when it is answered, the tab goes, or the agent's call is dropped.
function answerRequest(id) {
  const asked = requests.get(id)
  if (!asked) return
  requests.delete(id)
  asked.resolve({ allowed: S.findTab(state, id)?.agent === asked.agent, agent: asked.agent })
}

function finishDriven(chatId, agent) {
  const ids = driven.get(chatId)
  driven.delete(chatId)
  let finished = false
  for (const id of ids || []) {
    const tab = S.findTab(state, id)
    if (tab?.agent !== agent || tab.agentState === 'done') continue
    S.agentFinish(state, { id, agent }, Date.now(), looking(id))
    agentBrowser.release(id)
    finished = true
  }
  if (finished) changed()
}

command('tabs.snapshot', 'An agent reads the page as an outline: its buttons, links, fields and other controls, each with a short ref like e12 for tabs.click and tabs.type, and its headings. Refs last until the next snapshot. Only a tab the agent opened or was handed', tabProps, ['agent'], drive((id) => agentBrowser.snapshot(id)))
command('tabs.click', 'An agent clicks a ref from tabs.snapshot, or x and y in the page viewport (CSS pixels), with real mouse events sent to that page only', { ...tabProps, ref: string, x: number, y: number }, ['agent'], drive((id, p) => agentBrowser.click(id, p)))
command('tabs.type', 'An agent types text whole into a ref from tabs.snapshot (focused first) or into the focused element; clear replaces what was there', { ...tabProps, ref: string, text: string, clear: boolean }, ['agent', 'text'], drive((id, p) => agentBrowser.type(id, p)))
command('tabs.press', 'An agent presses a key or shortcut such as Enter, Tab, ArrowDown or Meta+Enter in the page', { ...tabProps, key: string }, ['agent', 'key'], drive((id, p) => agentBrowser.press(id, p)))
command('tabs.scroll', 'An agent scrolls the page by dx and dy CSS pixels at x and y (default the middle) or over a ref; returns the scroll position', { ...tabProps, ref: string, x: number, y: number, dx: number, dy: number }, ['agent'], drive((id, p) => agentBrowser.scroll(id, p)))
command('tabs.screenshot', 'An agent takes a JPEG of the page viewport, at most 1280 pixels wide, as {mime, width, height, data} with base64 data', tabProps, ['agent'], drive((id) => agentBrowser.screenshot(id)))
command('tabs.wait', 'An agent waits until the page text contains text or its address contains url, for at most timeout ms (10000 by default, 60000 at most)', { ...tabProps, text: string, url: string, timeout: number }, ['agent'], drive((id, p) => agentBrowser.wait(id, p)))
command('agent.finish', 'An agent is done with a tab: it shows as done, with an unseen mark until the user looks at it; summary is one line for the user. The tab stays the agent\'s. A Skiff chat finishes the tabs it drove when its turn ends', { ...tabProps, summary: string }, ['agent'], (p) => {
  const tab = S.agentFinish(state, p, Date.now(), looking(p.tabId ?? p.id))
  agentBrowser.release(tab.id)
  changed()
  return { tabId: tab.id, state: tab.agentState }
})
command('agent.requestTab', 'An agent asks to use a tab it did not open: the tab shows an Allow and Deny strip, and this resolves {allowed, agent} once the user answers (or {allowed: true} at once for a tab the agent already has)', tabProps, ['agent'], async (p, context) => {
  const { tab, granted } = S.agentRequest(state, { ...p, id: p.tabId ?? p.id })
  if (granted) return { allowed: true, agent: p.agent }
  changed()
  return new Promise((resolve) => {
    requests.set(tab.id, { agent: p.agent, resolve })
    context.signal?.addEventListener('abort', () => {
      requests.delete(tab.id)
      if (S.findTab(state, tab.id)?.agentRequest) { delete tab.agentRequest; changed() }
    }, { once: true })
  })
})
command('agent.answerTab', 'The user answers an agent\'s request for a tab: allow hands it over, deny drops the request', { id: string, allow: boolean }, ['id', 'allow'], (p) => {
  const { agent, allowed } = mutate(S.agentAnswer)(p)
  answerRequest(p.id)
  return { agent, allowed }
})
command('tabs.handToAgent', 'Let an agent use a tab: from then on it may drive it with the browser tools (it starts idle). Replaces the agent that had it', { id: string, agent: agentProp }, ['id', 'agent'], (p) => {
  const tab = mutate(S.handToAgent)(p)
  answerRequest(tab.id)
  return { tabId: tab.id, agent: tab.agent }
})
command('agent.takeOver', 'The user takes control of a tab an agent is using: the control layer goes, and the agent\'s next call on it fails with user_has_control', ids, ['id'], (p) => ({ tabId: mutate(S.takeOver)(p).id, control: 'user' }))
command('agent.giveBack', 'The user gives a tab back to its agent', ids, ['id'], (p) => ({ tabId: mutate(S.giveBack)(p).id, control: 'agent' }))
command('profiles.list', 'List browsing profiles', {}, [], () => state.profiles)
command('links.rules', 'List external link routing rules', {}, [], () => state.linkRules)
command('links.route', 'Resolve an external link profile', { url: string }, ['url'], (p) => S.routeLink(state, p))
command('links.open', 'Open an external link in its routed profile', { url: string }, ['url'], (p) => openProfileTab(S.routeLink(state, p)))
command('settings.catalog', 'Search core and owned component settings metadata; core entries carry their current value, action entries their status text and availability (unsupported actions are omitted); quickPanel: true lists what an interface draws in its quick Settings panel', { query: string, section: string, spaceId: string, owner: string, quickPanel: boolean, scope: { enum: ['global', 'space', 'tab', 'profile'] } }, [], async (p) => settingsCatalog.searchEntries([...settingsCatalog.present(settingsCatalog.list(), { values: state.settings, actions: settingsActions }), ...await registry.call('components.settings.list', { spaceId: p.spaceId })], p.query || '', p))
command('settings.run', 'Run a settings action entry from settings.catalog (for example defaultBrowser) and return the refreshed entry', { id: string }, ['id'], (p) => settingsCatalog.run(p.id, settingsActions))
command('updates.check', 'Check for a new Skiff version now; resolves with the update state (macOS packaged app only)', {}, [], () => updates.check())
command('updates.install', 'Restart Skiff into a downloaded update: runs the normal shutdown cleanup and state flush once, then quits and relaunches (macOS packaged app only; refused unless state.update.status is ready)', {}, [], () => updates.install())
command('grants.list', 'List scoped agent grants without credentials', {}, [], () => access.list())
command('grants.issue', 'Approve explicit browser, customization, and component-tool scopes', { owner: string, sessionId: string, tabIds: strings, spaceIds: strings, read: boolean, mutate: boolean, commands: strings, tools: strings, components: strings }, ['owner'], (p) => access.issue(p))
command('grants.revoke', 'Revoke a grant and its session credentials', { ...ids, owner: string, sessionId: string }, [], (p) => access.revoke(p))
command('grants.select', 'Select exactly one approved root grant for an agent or chat', { ...ids, sessionId: string }, ['id'], (p) => access.select(p))
command('ui.assets', 'Stable local UI asset roots', {}, [], () => ({ browserTools: pathToFileURL(toolsDir + path.sep).href, favicons: pathToFileURL(faviconDir + path.sep).href, shell: pathToFileURL(shellRoot() + path.sep).href }))
command('ui.openTools', 'Open independently replaceable browser tools', { section: string, query: string, ...ids }, [], (p, context) => {
  const role = toolSections.includes(p.section) ? p.section : 'settings'
  return showHostSurface(roleFile(role, path.join(toolsDir, 'index.html')), { query: p, role, fallback: path.join(toolsDir, 'index.html') }, context)
})
command('ui.closeTools', 'Close browser tools and their native page-feature state', {}, [], async () => {
  const failures = []
  for (const name of ['tools', 'find', 'reader']) {
    const id = overlays.get(name)?.loadOptions?.query?.id
    try {
      if (id && name !== 'tools' && S.findTab(state, id)) await call(`${name}.close`, { id })
    } catch (error) { failures.push(error) } finally { hideOverlay(name) }
  }
  if (failures.length) throw new AggregateError(failures, 'Browser tool cleanup failed')
  return null
})
command('ui.openFind', 'Find text in the focused page', ids, [], async (p, context) => {
  const id = S.getTab(state, p.id).id
  return openPageTool('find', id, { x: -420, y: 50, width: 410, height: 100 }, context)
})
command('ui.openReader', 'Read the current article without navigation', ids, [], async (p, context) => {
  const id = S.getTab(state, p.id).id
  return openPageTool('reader', id, undefined, context)
})

async function openPageTool(name, id, bounds, context) {
  const request = {}
  pageToolRequests.set(name, request)
  try {
    await call(`${name}.open`, { id }, context)
    context.signal?.throwIfAborted()
    if (pageToolRequests.get(name) !== request) throw S.err('cancelled', 'A newer browser tool request replaced this one')
    const fallback = path.join(toolsDir, `${name}.html`)
    return await showHostSurface(roleFile(name, fallback), { name, role: name, fallback, query: { id, tabId: id }, bounds }, context)
  } catch (error) {
    // Tear down only an unshown feature this request opened, never a newer visible tool.
    if (pageToolRequests.get(name) === request && !overlays.get(name)?.shown && S.findTab(state, id)) await registry.call(`${name}.close`, { id }).catch((cleanupError) => console.error(`Failed to close cancelled ${name}`, cleanupError))
    throw error
  } finally {
    if (pageToolRequests.get(name) === request) pageToolRequests.delete(name)
  }
}
command('ui.showSurface', 'Show an arbitrary declared component surface', { ...ids, surface: string, name: string, bounds: { type: 'object', properties: { x: number, y: number, width: number, height: number }, required: ['x', 'y', 'width', 'height'], additionalProperties: false }, focus: boolean }, ['id', 'surface'], (p, context) => {
  const source = components.surface({ id: p.id, name: p.surface })
  return showHostSurface(source.file, { name: p.name || `component:${p.id}:${p.surface}`, bounds: p.bounds, focus: p.focus !== false, component: { id: p.id, name: p.surface } }, context)
})
command('ui.closeSurface', 'Close a custom surface', { name: string }, ['name'], (p) => { hideOverlay(p.name); return null })
command('ui.inspectSource', 'Inspect the actual source and binding for a component role', { role: string, ...ids, spaceId: { type: ['string', 'null'] } }, [], (p) => {
  const spaceId = p.spaceId === undefined ? state.activeSpaceId : p.spaceId ?? undefined
  const selected = p.id ? { id: p.id } : components.resolve(p.role || 'launcher', { spaceId })
  if (!selected) throw S.err('not_found', 'No component provides that role')
  return { ...components.inspect({ id: selected.id }), ...(!p.id && { resolution: { role: selected.role, source: selected.source, owner: selected.owner, id: selected.id, file: selected.file, spaceId: spaceId ?? null } }) }
})
command('ui.customize', 'Create an owned copy of the selected UI source', { role: string, ...ids, spaceId: { type: ['string', 'null'] } }, [], async (p, context) => {
  const selected = p.id ? { id: p.id } : components.resolve(p.role || 'launcher', { spaceId: p.spaceId === undefined ? state.activeSpaceId : p.spaceId ?? undefined })
  if (!selected) throw S.err('not_found', 'No component provides that role')
  const id = `custom.${crypto.randomBytes(5).toString('hex')}`
  const copy = await components.create({ id, from: selected.id, role: p.role }, context)
  context.signal?.throwIfAborted()
  await call('ui.openTools', { section: 'components', id }, context)
  return copy
})
command('ui.safeMode', 'Disable custom execution and recover the stock UI without closing pages', {}, [], async () => {
  safeMode = true
  await components.start({ safeMode: true })
  // Recovery renders the bundled default, so stock source discovery must name
  // that same source rather than the previously selected skin.
  installingShell = true
  try { await components.refreshStock({ id: 'stock.shell', root: bundledShell, manifest: stockShellManifest(bundledShell) }) }
  finally { installingShell = false }
  closeShellViews()
  if (deskMode) await recreateWindow()
  else await loadSurface(win.webContents, path.join(bundledShell, 'index.html'))
  changed()
  return { safeMode: true }
})
command('host.layout', 'Native layout primitives', { op: { enum: ['layouts', 'tile'] }, ...ids, layout: string }, ['op'], (p) => p.op === 'layouts' ? S.deskLayouts(state) : mutate(S.tileDesk)({ id: p.id, layout: p.layout }))
command('host.search', 'Resolve a destination with the configured search URL', { text: string }, ['text'], (p) => ({ url: S.resolveInput(p.text, state.settings.searchUrl) }))
command('host.archive', 'Apply native archive rules', {}, [], () => {
  const loading = [...runtime].filter(([, r]) => r.loading).map(([id]) => id)
  const result = S.sweep(state, { loading }, Date.now())
  if (result.archived.length || result.done.length || result.settled.length) changed()
  return result
})
command('search.resolve', 'Resolve input using the selected search component', { text: string }, ['text'], (p, context) => behavior('search', p, context))

function behavior(role, params, context) {
  const selected = !safeMode && components?.resolve(role, { spaceId: state.activeSpaceId })
  return call(selected?.command || `host.${role}`, params, context)
}

function openProfileTab({ url, spaceId, sessionPartition, activate = true }) {
  const tab = S.createTab(state, { url, spaceId, activate }, Date.now())
  if (sessionPartition) tab.sessionPartition = sessionPartition
  changed()
  return tab
}

function dataEvent(name, payload) {
  const data = browserData?.snapshot()
  if (data && pageFeatures) for (const [id] of views) {
    pageFeatures.protect(id, 'downloads', data.activeDownloads.includes(id))
    pageFeatures.protect(id, 'permissions', data.pendingPermissions.some((p) => p.tabId === id))
  }
  if (name === 'browser-permission-granted' && ['media', 'display-capture'].includes(payload?.permission)) pageFeatures?.protect(payload.tabId, 'calls', true)
  pushAi(name, payload)
}

function syncChanged() {
  for (const [id, view] of views) {
    const tab = S.findTab(state, id)
    if (tab && !tab.chat && /^https?:/.test(view.webContents.getURL()) && tab.url !== view.webContents.getURL()) view.webContents.loadURL(tab.url).catch(console.error)
  }
  changed()
}

function agentApi({ agent, chatId }) {
  if (!api) return null
  const parent = access.selected({ owner: agent, sessionId: chatId })
  if (!parent) return null
  const grant = access.issue({ owner: parent.owner, tabIds: parent.tabIds, spaceIds: parent.spaceIds, read: parent.read, mutate: parent.mutate, tools: parent.tools, components: parent.components, ...(parent.commands && { commands: parent.commands }), parentId: parent.id, sessionId: chatId })
  return { port: api.port, token: grant.token, revoke: () => access.revoke({ id: grant.id }) }
}

function stockShellManifest(root = stockShellRoot()) {
  const surfaces = { shell: 'index.html' }
  for (const [role, file] of Object.entries({ launcher: 'palette.html', frame: 'frame.html', tablist: 'tablist.html', spaces: 'panel.html', overview: 'expose.html' })) if (fs.existsSync(path.join(root, file))) surfaces[role] = file
  return { apiVersion: 1, id: 'stock.shell', version: '1.0.0', surfaces, capabilities: ['ui', 'host.manage', 'call:*', 'events:*'] }
}

function registerStockComponents() {
  const register = (id, root, surfaces) => components.registerStock({ root, manifest: { apiVersion: 1, id, version: '1.0.0', surfaces, capabilities: ['ui', 'host.manage', 'call:*', 'events:*'] } })
  register('stock.shell', stockShellRoot(), stockShellManifest().surfaces)
  for (const [role, file] of Object.entries({ frame: 'frame.html', tablist: 'tablist.html', overview: 'expose.html' })) {
    register(`stock.${role}`, path.join(bundledShells, 'layer'), { [role]: file })
  }
  register('stock.chat', chatDir, { chat: 'chat.html' })
  register('stock.browser-tools', toolsDir, { ...Object.fromEntries(toolSections.map((role) => [role, 'index.html'])), find: 'find.html', reader: 'reader.html', split: 'split.html' })
  for (const name of ['layout', 'search', 'archive']) {
    const root = path.join(__dirname, '..', 'components', name)
    components.registerStock({ root, manifest: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) })
  }
}

async function previewComponent({ id, path: source, manifest: componentManifest, backend = false }, context = {}) {
  context.signal?.throwIfAborted()
  if (backend) throw S.err('forbidden', 'Preview does not run component backends')
  const root = fs.mkdtempSync(path.join(app.getPath('temp'), 'skiff-preview-'))
  const staged = path.join(root, 'source')
  fs.cpSync(source, staged, { recursive: true })
  const clean = { ...componentManifest, id: `preview.${crypto.randomBytes(5).toString('hex')}` }
  delete clean.backend
  delete clean.commands
  clean.capabilities = ['ui', 'call:*', 'events:state']
  fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(clean))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  const environment = Object.fromEntries(['PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  Object.assign(environment, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), SKIFF_DATA: path.join(root, 'data'), SKIFF_PREVIEW_SOURCE: staged, SKIFF_BUILTIN_EXTENSIONS: '[]' })
  const child = spawn(process.execPath, [...(app.isPackaged ? [] : [path.join(__dirname, '..')]), '--component-preview'], { env: environment, stdio: 'ignore' })
  previews.set(child.pid, child)
  child.once('exit', () => { previews.delete(child.pid); fs.rmSync(root, { recursive: true, force: true }) })
  child.once('error', () => { previews.delete(child.pid); fs.rmSync(root, { recursive: true, force: true }) })
  try {
    const deadline = Date.now() + 15000
    while (!fs.existsSync(path.join(root, 'data', 'api.json'))) {
      context.signal?.throwIfAborted()
      if (child.exitCode !== null || child.signalCode !== null) throw S.err('component_error', 'Preview exited before becoming ready')
      if (Date.now() >= deadline) throw S.err('timeout', 'Preview did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    context.signal?.throwIfAborted()
  } catch (error) { await closePreview(child.pid); throw error }
  return { id, pid: child.pid, profile: path.join(root, 'data'), disposable: true, backend: false }
}

command('components.preview.stop', 'Close an owned disposable preview', { pid: { type: 'integer', minimum: 1 } }, ['pid'], (p) => closePreview(p.pid))
command('components.preview.list', 'List owned disposable previews', {}, [], () => [...previews.keys()].map((pid) => ({ pid })))
function closePreview(pid) {
  const child = previews.get(pid)
  if (!child) return Promise.resolve({ closed: false })
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => { clearTimeout(timer); resolve({ closed: true }) })
    child.kill('SIGTERM')
  })
}

async function call(method, params = {}, context = {}) {
  if (previewMode && /^(?:components\.(?:apply|enable|revert|stage|create|bind|preview)|ui\.customize|ai\.|grants\.|sync\.|extensions\.|import\.|passwords\.|settings\.(?:set|run)$)/.test(method)) throw S.err('forbidden', 'Disposable previews cannot activate executable code or credentials')
  if (context.component && !context.hostManagement && /^(?:grants\.|sync\.|import\.|passwords\.|components\.(?:apply|enable|revert|bind|stage|create|remove|disable)|ui\.customize)/.test(method)) throw S.err('forbidden', 'This operation requires the explicitly granted host.manage capability')
  if (['components.apply', 'components.enable', 'components.revert'].includes(method)) {
    if (context.accessContext) access.assert(context.accessContext, { command: method, params })
    else if (!context.trusted && !context.hostManagement) throw S.err('forbidden', 'Component activation requires a trusted local surface or explicit customization grant')
    let info = components.inspect({ id: params.id })
    const revisionKey = method === 'components.apply' ? 'staged' : method === 'components.revert' ? 'previous' : 'revision'
    if (method === 'components.apply' && !info.staged) info = await components.stage({ path: info.path }, context)
    context.signal?.throwIfAborted()
    if (context.accessContext) access.assert(context.accessContext, { command: method, params })
    const revision = info[revisionKey]
    if (!revision) throw S.err('bad_params', 'No component revision is available')
    const source = path.join(dataDir, 'components', 'revisions', params.id, revision)
    const checked = components.check({ path: source })
    if (!checked.ok) throw S.err('bad_params', checked.error)
    const { response } = await dialog.showMessageBox(win, { type: 'warning', message: `Trust component ${params.id}?`, detail: `Local component code may run with the capabilities you approve.\n${JSON.stringify(checked.manifest?.capabilities || [])}`, buttons: ['Cancel', 'Trust and activate'], defaultId: 0, cancelId: 0 })
    if (response !== 1) throw S.err('forbidden', 'Component activation cancelled')
    context.signal?.throwIfAborted()
    if (context.accessContext) access.assert(context.accessContext, { command: method, params })
    if (components.inspect({ id: params.id })[revisionKey] !== revision || components.check({ path: source }).revision !== checked.revision) throw S.err('cancelled', 'Component source changed during consent; review it again')
    params = { ...params, expectedRevision: revision, ...(method === 'components.apply' && { grants: params.grants || checked.manifest.capabilities }) }
  }
  if (context.accessContext) {
    const [permitted] = access.tools(context.accessContext, [{ name: method, command: method, run: (boundedParams) => registry.call(method, boundedParams, context) }])
    if (!permitted) throw S.err('forbidden', 'The originating agent did not grant this command')
    return permitted.run(params)
  }
  return registry.call(method, params, context)
}

async function rpc(method, params, context = {}) {
  try {
    return { ok: true, result: (await call(method, params, context)) ?? null }
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

function updateMenuItems() {
  const u = updates.state()
  if (!u) return []
  const busy = u.status === 'checking' || u.status === 'downloading'
  return [
    { type: 'separator' },
    u.status === 'ready'
      ? { label: `Restart to Update to ${u.version}`, click: () => rpc('updates.install') }
      : { label: 'Check for Updates...', enabled: !busy, click: () => rpc('updates.check') }
  ]
}

async function runGlobalShortcut(method, params) {
  if (!win) await createWindow()
  const raised = await rpc('ui.raise')
  if (!raised.ok) return console.error(`Global shortcut could not raise Skiff: ${raised.error.message}`)
  await rpc(method, params)
}

function registerGlobalShortcuts() {
  globalShortcut.unregisterAll()
  for (const [accelerator, { method, params }] of Object.entries(state.settings.globalShortcuts)) {
    try {
      if (!globalShortcut.register(accelerator, () => runGlobalShortcut(method, params).catch(console.error))) console.error(`Global shortcut ${accelerator} is taken by another app or not valid`)
    } catch (e) {
      console.error(`Global shortcut ${accelerator} failed: ${e.message}`)
    }
  }
}

function buildMenu() {
  const items = Object.entries(state.settings.shortcuts).map(([accelerator, { method, params }]) => ({
    label: [method, ...Object.values(params || {})].join(' '),
    accelerator,
    click: () => rpc(method, params)
  }))
  const mac = process.platform === 'darwin'
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: 'Skiff', submenu: [
      { role: 'about' },
      ...updateMenuItems(),
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ] }] : []),
    { role: 'editMenu' },
    // Page zoom owns CmdOrCtrl+0/+/-; these size the shell itself, by the step the zoom roles used.
    { label: 'View', submenu: [
      { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: () => rpc('ui.openFind') },
      { label: 'Browser Tools', accelerator: 'CmdOrCtrl+,', click: () => rpc('ui.openTools') },
      { label: 'History', accelerator: 'CmdOrCtrl+Y', click: () => rpc('ui.openTools', { section: 'history' }) },
      { label: 'Downloads', click: () => rpc('ui.openTools', { section: 'downloads' }) },
      { label: 'Make Interface Larger', click: () => zoomShell(win.webContents.getZoomLevel() + 0.5) },
      { label: 'Make Interface Smaller', click: () => zoomShell(win.webContents.getZoomLevel() - 0.5) },
      { label: 'Interface Actual Size', click: () => zoomShell(0) }
    ] },
    { label: 'Shell', submenu: shells.map((name) => ({ label: name, type: 'radio', checked: name === state.settings.shell, click: () => rpc('ui.setShell', { name }) })) },
    { label: 'Recovery', submenu: [
      { label: 'Use Safe Mode (keep tabs)', click: () => rpc('ui.safeMode', {}, { trusted: true }) },
      { label: 'Manage Components', click: () => showHostSurface(path.join(toolsDir, 'index.html'), { query: { section: 'components' } }) },
      { label: 'Reload Selected UI', click: reloadShell },
      { label: 'Open Component Sources', click: () => shell.openPath(path.join(dataDir, 'components')) }
    ] },
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
  browserData.attachSession(ses, partition)
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
    const owner = got.length === want.length && crypto.timingSafeEqual(got, want)
    let context
    if (!owner) {
      try { context = access.authorize(String(req.headers.authorization || '').replace(/^Bearer /, ''), { route: '/mcp', method: 'POST' }) }
      catch (error) { return refuse(res, 401, 'unauthorized', error.message) }
      if (req.url !== '/mcp' || req.method !== 'POST') return refuse(res, 403, 'forbidden', 'Browser credentials are only valid for POST /mcp')
    }
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
        try {
          if (context) context = access.authorize(String(req.headers.authorization || '').replace(/^Bearer /, ''), { route: req.url, method: req.method, params: body })
          const browserContext = context || access.ownerBrowserContext()
          const tools = browserTools({ call: (method, params, toolContext) => call(method, params, { ...toolContext, trusted: false, accessContext: browserContext }), registry })
          const out = await handleMcp(body, { tools: access.tools(browserContext, tools), version: app.getVersion() })
          access.assert(browserContext)
          if (out) return reply(res, 200, out)
        } catch (error) { return refuse(res, 403, error.code || 'forbidden', error.message) }
        res.writeHead(202)
        return res.end()
      }
      const out = await rpc(body?.method, body?.params ?? undefined, { trusted: true })
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

async function start() {
  fs.mkdirSync(dataDir, { recursive: true })
  state = loadState()
  // settings.set replaces this map; every session keeps the identity selected at startup.
  browserIdentity = state.settings.browserIdentity
  const legacyShell = fs.existsSync(shellDir) ? shellDir : undefined
  access = createAccess({ state: () => state, changed, emit: pushAi, registry })
  transcripts = createTranscripts({ dir: path.join(dataDir, 'transcripts'), state: () => state, changed, emit: pushAi })
  transcripts.register(registry)
  browserData = createBrowserData({ dir: dataDir, state: () => state, changed, emit: dataEvent, openTab: openProfileTab, dialog, shell, getWindow: () => win, getDownloadDirectory: () => app.getPath('downloads') })
  browserData.register(registry)
  pageFeatures = createPageFeatures({ state: () => state, views, runtime, changed: changedSoon, emit: pushAi, createView, destroyView, getWindow: (tab) => tab?.agent ? agentWin : win, isShown: (view) => shown.includes(view), call, registry })
  pageFeatures.register(registry)
  sync = createSync({ dir: path.join(dataDir, 'sync'), state: () => state, changed: syncChanged, safeStorage, emit: pushAi })
  sync.register(registry)
  await sync.start()
  components = createComponents({ dir: path.join(dataDir, 'components'), bundledRoot: path.join(__dirname, '..'), legacyShellDir: legacyShell, registry, call, state: () => state, changed, onReplace: replaceSurfaces, onSettingsChanged: (entry) => {
    for (const wc of [...shellContents(), ...chatContents()]) if (trustedFiles.get(wc)?.owner === entry.owner) sendEvent(wc, 'settings.changed', entry)
    notifyHostSettings(entry)
  }, preview: previewComponent, safeMode })
  registerStockComponents()
  components.register(registry)
  await components.start()
  if (process.argv.includes('--component-preview') && process.env.SKIFF_PREVIEW_SOURCE) {
    const staged = await components.stage({ path: process.env.SKIFF_PREVIEW_SOURCE })
    const id = staged.id || staged.manifest.id
    await components.apply({ id })
    const checked = components.check({ id })
    for (const role of Object.keys(checked.manifest.surfaces)) await components.bind({ role, id })
  }
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
  ai = createAi({ dir: path.join(dataDir, 'ai'), version: app.getVersion(), state: () => state, changed, favicon: F.storeIcon(faviconDir, 'https://skiff.invalid/agent.svg', Buffer.from(SPARKLE)), api: agentApi, revokeAccess: (selector) => access.revoke(selector), transcripts, pageText, pageGeneration: (id) => runtime.get(id)?.generation, push: pushAi, watching: looking })
  extensions.start()
  ipcMain.handle('skiff:call', async (e, method, params) => {
    const source = trustedFiles.get(e.sender)
    if (!win || !source || source.invalid || e.senderFrame?.parent || filePath(e.senderFrame?.url) !== source.file) return { ok: false, error: { code: 'forbidden', message: 'Only a current registered local surface may call' } }
    if (source.owner !== 'host') {
      try {
        if (components.ownerForFile(source.file) !== source.owner) throw S.err('forbidden', 'This surface generation has been replaced')
        if (/^components\.(?:storage\.(?:read|write|remove)|source\.(?:read|write)|settings\.(?:list|get|set|reset))$/.test(method)) {
          const p = params || {}
          if (p.id !== undefined && source.bridge.hasCapability('host.manage')) return { ok: true, result: (await source.bridge.call(method, p)) ?? null }
          if (p.id !== undefined && p.id !== source.owner) throw S.err('forbidden', 'Component data belongs to its owner')
          const bridge = source.bridge
          const [, group, operation] = method.split('.')
          let result
          if (group === 'source') result = await bridge.source[operation](p.file, p.content)
          else if (group === 'settings') {
            const options = { spaceId: p.spaceId, query: p.query }
            result = operation === 'list' ? await bridge.settings.list(options)
              : operation === 'set' ? await bridge.settings.set(p.key, p.value, options)
                : await bridge.settings[operation](p.key, options)
          } else result = operation === 'write' ? await bridge.storage.write(p.key, p.value, { version: p.version, spaceId: p.spaceId, private: p.private })
            : await bridge.storage[operation](p.key, { version: p.version, spaceId: p.spaceId, private: p.private })
          return { ok: true, result: result ?? null }
        }
        const result = await source.bridge.call(method, params || {})
        return { ok: true, result: result ?? null }
      } catch (error) { return { ok: false, error: { code: error.code || 'forbidden', message: error.message } } }
    }
    return rpc(method, params ?? undefined, { owner: source.owner, trusted: true })
  })
  const pageTab = (e) => e.senderFrame && !e.senderFrame.parent && tabOfContents(e.sender.id)
  ipcMain.on('skiff:page-state', (e, payload) => {
    const id = tabOfContents(e.sender.id)
    if (id) pageFeatures.report(id, payload, e)
  })
  ipcMain.on('skiff:link-peek', (e, payload) => {
    const id = pageTab(e)
    if (id && typeof payload?.url === 'string' && /^https?:/.test(payload.url)) rpc('peek.open', { url: payload.url, sourceId: id })
  })
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
    sendEvent(frames.get(id)?.webContents, 'page-drag', { tab: id, phase, screenX, screenY })
  })
  buildMenu()
  registerGlobalShortcuts()
  startApi()
  screen.on('display-metrics-changed', refitDesk)
  screen.on('display-removed', refitDesk)
  desktops = D.open({ systemPreferences })
  await createWindow()
  desktops?.subscribe(desktopsChanged)
  prefetchIcons()
  app.on('activate', () => { if (!win) createWindow().catch(console.error) })
  for (const url of pendingUrls.splice(0)) rpc('links.open', { url })
  app.on('second-instance', (_event, argv) => {
    if (!win) createWindow().catch(console.error)
    for (const url of argv.filter((arg) => /^https?:\/\//i.test(arg))) rpc('links.open', { url })
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  rpc('archive.sweep')
  setInterval(() => rpc('archive.sweep'), 60e3)
  // A working agent tab with no call for two minutes shows as idle (SKIFF_AGENT_IDLE_MS shortens that for tests).
  const idleMs = Number(process.env.SKIFF_AGENT_IDLE_MS) || undefined
  setInterval(() => { if (S.agentSweep(state, Date.now(), idleMs).length) changed() }, 5e3).unref()
  startUpdates()
}

const quitFlow = createQuit({
  quit: () => app.quit(),
  cleanup: async () => {
    const results = await Promise.allSettled([
      async () => { try { await ai?.stop() } finally { transcripts?.stop() } },
      () => browserData?.stop(),
      () => pageFeatures?.stop(),
      () => access?.stop(),
      () => sync?.stop(),
      () => components?.stop(),
      async () => {
        const previewsStopped = await Promise.allSettled([...previews.keys()].map(closePreview))
        for (const result of previewsStopped) if (result.status === 'rejected') console.error(result.reason)
      }
    ].map((stop) => Promise.resolve().then(stop)))
    try { if (state) flush() }
    finally { for (const result of results) if (result.status === 'rejected') console.error(result.reason) }
  }
})

const readyNotices = new Set()
const supportedUpdates = app.isPackaged && process.platform === 'darwin' && !previewMode
const updates = createUpdates({
  updater: supportedUpdates ? autoUpdater : { on() {} },
  supported: supportedUpdates,
  quit: quitFlow,
  onChange: () => { pushState(); buildMenu() },
  notify: (version) => {
    const notice = new Notification({ title: `Skiff ${version} is ready`, body: 'Restart Skiff to update.' })
    readyNotices.add(notice)
    notice.on('click', () => rpc('updates.install'))
    notice.on('close', () => readyNotices.delete(notice))
    notice.show()
  }
})

function startUpdates() {
  if (!updates.state()) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  const check = () => updates.check().catch(console.error)
  check()
  setInterval(check, updates.HOUR)
  app.on('browser-window-focus', () => updates.checkIfStale()?.catch(console.error))
}

app.on('login', createHttpAuth({ BrowserWindow, ipcMain, fallbackWindow: () => win }))

if (app.requestSingleInstanceLock()) {
  app.on('window-all-closed', () => process.platform === 'darwin' || app.quit())
  app.on('before-quit', quitFlow.beforeQuit)
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.whenReady().then(start).catch(console.error)
} else {
  app.quit()
}

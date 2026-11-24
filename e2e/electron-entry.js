'use strict'
// This entry is never used by production. It changes environment/consent only and records what the desk tests check;
// the real main, preload, registry, state, importer and native views run unchanged.
const electron = require('electron')
const { app, dialog, nativeTheme, screen } = electron
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const { writeDatabases } = require('./arc-fixture')

const root = process.env.SKIFF_VISUAL_ROOT
if (!root || !fs.existsSync(path.join(root, '.skiff-visual-fixture'))) throw new Error('Visual entry requires an owned fixture directory')
const home = path.join(root, 'home')
const data = path.join(root, 'data')
if (process.env.SKIFF_DATA !== data || process.env.HOME !== home) throw new Error('Refusing a non-fixture home or Skiff profile')
if (process.argv.some((arg) => arg === '--no-sandbox')) throw new Error('Sandbox must remain enabled')
app.setPath('home', home)
app.setPath('userData', data)
app.setPath('appData', path.join(home, 'app-data'))
app.setPath('logs', path.join(root, 'logs'))
app.commandLine.appendSwitch('lang', 'en-US')
app.commandLine.appendSwitch('force-color-profile', 'srgb')
nativeTheme.themeSource = process.env.SKIFF_VISUAL_THEME || 'light'
writeDatabases(home, `http://127.0.0.1:${process.env.SKIFF_VISUAL_PORT}`)

const audit = global.__skiffVisualAudit = { decisions: [], protectedReads: [], keychainAttempts: [], blockedRequests: [] }
const protectedPath = (value) => typeof value === 'string' && /(?:^|[/\\])(?:Login Data(?: For Account)?|Cookies)(?:$|[-.])/.test(value)
for (const name of ['lstatSync', 'readFileSync', 'openSync']) {
  const original = fs[name]
  fs[name] = function (file, ...args) {
    if (protectedPath(file) && String(file).includes(`${path.sep}Arc${path.sep}`)) {
      if (!path.resolve(file).startsWith(home + path.sep)) throw new Error('Refusing protected data outside fixture home')
      audit.protectedReads.push({ operation: name, file: path.relative(home, file) })
    }
    return original.call(this, file, ...args)
  }
}
const sqlite = require('node:sqlite')
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct(DatabaseSync, args) {
    const file = String(args[0])
    if (protectedPath(file)) {
      if (!path.resolve(file).startsWith(home + path.sep)) throw new Error('Refusing a protected SQLite file outside fixture home')
      audit.protectedReads.push({ operation: 'DatabaseSync', file: path.relative(home, file) })
    }
    return Reflect.construct(DatabaseSync, args)
  }
})
const execFile = childProcess.execFile
childProcess.execFile = function (file, ...args) {
  if (path.basename(String(file)) === 'security') {
    audit.keychainAttempts.push(String(file))
    throw new Error('Visual fixtures must never access Keychain')
  }
  return execFile.call(this, file, ...args)
}
dialog.showMessageBox = async (_window, options) => {
  let response
  if (options.message.startsWith('Import ') && options.message.endsWith(' from Arc?')) response = Number(process.env.SKIFF_VISUAL_CONSENT || 0)
  else if (options.message.startsWith('Trust component ') && process.env.SKIFF_VISUAL_COMPONENT_CONSENT !== undefined) response = Number(process.env.SKIFF_VISUAL_COMPONENT_CONSENT)
  else if (options.message.includes(' wants to ') && process.env.SKIFF_VISUAL_PERMISSION_CONSENT !== undefined) response = Number(process.env.SKIFF_VISUAL_PERMISSION_CONSENT)
  else throw new Error(`Unexpected native dialog: ${options.message}`)
  audit.decisions.push({ message: options.message, detail: options.detail, response })
  return { response, checkboxChecked: false }
}
app.on('session-created', (created) => {
  // A webRequest listener of our own silences every extension's chrome.webRequest listener in that session, so
  // extension runs keep the network shut with a dead proxy instead; loopback bypasses it and the fixture server still answers.
  if (process.env.SKIFF_VISUAL_EXTENSIONS === '1') {
    created.setProxy({ proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9' })
    return
  }
  created.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    const allowed = ['file:', 'data:', 'devtools:', 'about:', 'chrome:'].includes(url.protocol) ||
      (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === process.env.SKIFF_VISUAL_PORT)
    if (!allowed) audit.blockedRequests.push(details.url)
    callback({ cancel: !allowed })
  })
})
// Synthetic keys never fire a system-wide shortcut, so keep each registered callback for a spec to invoke from the main process.
const registerGlobal = electron.globalShortcut.register
global.__skiffGlobalShortcuts = new Map()
electron.globalShortcut.register = function (accelerator, callback) {
  global.__skiffGlobalShortcuts.set(accelerator, callback)
  return registerGlobal.call(this, accelerator, callback)
}
// Desk windows: the options each window is made with, the calls below with the id of the window they went to, and a cursor the test places.
// Linux ignores window levels and workspaces, and focuses a window with its web contents, so those are checked by their calls.
audit.windows = []
global.__skiffVisualCursor = null
function record(method, list, entry) {
  let windowClass = electron.BrowserWindow.prototype
  while (!Object.hasOwn(windowClass, method)) windowClass = Object.getPrototypeOf(windowClass)
  const original = windowClass[method]
  windowClass[method] = function (...args) {
    list.push({ id: this.id, ...entry(...args) })
    return original.apply(this, args)
  }
}
record('setIgnoreMouseEvents', audit.ignoreMouse = [], (ignore, options) => ({ ignore, forward: Boolean(options?.forward) }))
record('setAlwaysOnTop', audit.alwaysOnTop = [], (flag, level) => ({ flag, level }))
record('setVisibleOnAllWorkspaces', audit.allWorkspaces = [], (visible, options) => ({ visible, ...options }))
record('focus', audit.focused = [], () => ({}))
// Every view move with its webContents id and time, from when a spec sets global.__skiffVisualMoves = [], so a slide can be sampled mid-flight.
const setBounds = electron.WebContentsView.prototype.setBounds
electron.WebContentsView.prototype.setBounds = function (bounds) {
  global.__skiffVisualMoves?.push({ id: this.webContents.id, t: performance.now(), ...bounds })
  return setBounds.call(this, bounds)
}
// Space switches the shell asks for, in order, so a gesture spec can count them; desk and focus calls, for the tab list; overlay and page calls with their time, for exposé's hand-offs.
// A spec may set global.__skiffVisualDelay = {method: ms} to hold a shell call back, as a slow core would.
audit.spaceCalls = []
audit.calls = []
audit.overlayCalls = []
const DESK_CALLS = new Set(['ui.raise', 'ui.setDesk', 'ui.showOverlay', 'ui.focusPage', 'ui.inFront', 'tabs.activate'])
const OVERLAY_CALLS = new Set(['ui.showOverlay', 'ui.hideOverlay', 'ui.setPageVisible', 'tabs.activate'])
const handle = electron.ipcMain.handle.bind(electron.ipcMain)
electron.ipcMain.handle = (channel, listener) => handle(channel, channel !== 'skiff:call' ? listener : (event, method, params) => {
  if (DESK_CALLS.has(method)) audit.calls.push({ method, params })
  if (OVERLAY_CALLS.has(method)) audit.overlayCalls.push({ method, params, t: performance.now() })
  if (method === 'spaces.cycle' || method === 'spaces.activate') audit.spaceCalls.push({ method, params })
  const invoke = () => listener(event, method, params)
  const delay = global.__skiffVisualDelay?.[method]
  return delay ? new Promise((resolve) => setTimeout(resolve, delay)).then(invoke) : invoke()
})
const RecordedWindow = new Proxy(electron.BrowserWindow, {
  construct(target, args) {
    const win = Reflect.construct(target, args)
    audit.windows.push({ ...args[0], webPreferences: undefined, id: win.id })
    // A desk window belongs to the desktop that is current when it is made, as macOS puts a new window on the active desktop.
    if (global.__skiffDesktops && !args[0]?.skipTaskbar) win.desktopId = global.__skiffDesktops.current
    return win
  }
})
// macOS desktops, which Linux has none of: fixtureOptions.desktops is their ids in order, the first current; a spec calls
// global.__skiffDesktops.switchTo(id) in the main process, as moving to another desktop does, or reassigns .ids as Mission Control would.
// windows() lists the desk windows: the desktop each was made on, whether it is visible on all workspaces, and its child views (a page by its path, a shell view by its file).
const fakeDesktops = (ids) => {
  const listeners = new Set()
  const fake = global.__skiffDesktops = {
    ids, current: ids[0],
    switchTo(id) { fake.current = id; for (const listener of listeners) listener() },
    windows: () => electron.BrowserWindow.getAllWindows().filter((w) => w.desktopId !== undefined).map((w) => ({
      id: w.id, desktop: w.desktopId, allWorkspaces: audit.allWorkspaces.findLast((call) => call.id === w.id)?.visible ?? false,
      children: w.contentView.children.map((view) => {
        const href = view.webContents.getURL()
        if (!href) return ''
        const url = new URL(href)
        return url.protocol.startsWith('http') ? url.pathname : url.pathname.split('/').pop()
      })
    }))
  }
  return { open: () => ({ list: () => fake.ids.map((id, i) => ({ id, number: i + 1 })), current: () => fake.current, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } }) }
}
const mainFile = path.join(__dirname, '..', 'src', 'main.js')
const load = Module._load
Module._load = function (request, parent, ...rest) {
  const exported = load.call(this, request, parent, ...rest)
  if (request === './ai' && parent?.filename === mainFile && process.env.SKIFF_VISUAL_STOP_FAILURE === '1') {
    return { ...exported, createAi: (options) => {
      const instance = exported.createAi(options)
      const stop = instance.stop.bind(instance)
      instance.stop = async () => { await stop(); throw new Error('Fixture AI shutdown rejection') }
      return instance
    } }
  }
  if (request === './desktops' && parent?.filename === mainFile && process.env.SKIFF_VISUAL_DESKTOPS) return fakeDesktops(process.env.SKIFF_VISUAL_DESKTOPS.split(',').map(Number))
  if (request !== 'electron' || parent?.filename !== mainFile) return exported
  return new Proxy(exported, { get: (target, key) => (key === 'BrowserWindow' ? RecordedWindow : Reflect.get(target, key)) })
}
app.whenReady().then(() => {
  const cursor = screen.getCursorScreenPoint
  screen.getCursorScreenPoint = () => global.__skiffVisualCursor || cursor()
})
// Do not override the platform, safeStorage, discovery, importer, or command API.
require('../src/main')

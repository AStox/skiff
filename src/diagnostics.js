'use strict'
const log = require('./log')
const { sanitize } = log

const app = log.scope('app')
const wcLog = log.scope('wc')
const winLog = log.scope('window')
const cmd = log.scope('cmd')
const tabLog = log.scope('tab')
const rendererLog = log.scope('renderer')

// High-frequency commands (pointer, bounds, per-frame, polling) go to trace, which is off at the default debug level.
const NOISY = new Set(['ui.setPageBounds', 'ui.setDesk', 'ui.setFrame', 'ui.setPageVisible', 'ui.setWindowButtons', 'desk.place', 'split.resize', 'tabs.thumbnails', 'state.get', 'commands.list', 'logs.tail', 'logs.path', 'settings.catalog', 'extensions.list'])
// Commands whose arguments or results carry credentials or user content; log the call, never the data.
const SENSITIVE = /^(?:passwords|sync|grants|import\.arc$|ai\.(?:ask|prompt))/
const SLOW_MS = 150
const BODY_KEYS = new Set(['content', 'text', 'value', 'html', 'body'])
const RESULT = { string: 200, depth: 2, keys: 10, items: 5, budget: 600, stack: 1024 }

const redact = (params) => {
  const out = {}
  for (const [key, value] of Object.entries(params)) out[key] = typeof value === 'string' && BODY_KEYS.has(key) ? `[string ${value.length}]` : value
  return out
}

const shapeParams = (method, params) => {
  if (!params || typeof params !== 'object') return params
  if (SENSITIVE.test(method)) return { keys: Object.keys(params) }
  const out = redact(params)
  if (Array.isArray(out.steps)) out.steps = out.steps.map((step) => (step && typeof step === 'object' ? redact(step) : step))
  if (method === 'settings.set' && Array.isArray(out.ai?.agents)) out.ai = { ...out.ai, agents: out.ai.agents.map((agent) => ({ name: agent?.name })) }
  return out
}

function surfaceOf(context = {}) {
  if (context.accessContext) return `agent:${context.accessContext.owner ?? ''}/${context.accessContext.id ?? ''}`
  if (context.component) return `component:${context.component}`
  if (context.owner === 'host') return context.surface ? `shell:${context.surface}` : 'shell'
  if (context.owner) return `component:${context.owner}`
  return context.trusted ? 'api' : 'internal'
}

// Wrap one command call: log start-free, one line at the end with duration and outcome.
function commandLog(method, params, context, codes) {
  const started = performance.now()
  const surface = surfaceOf(context)
  const shaped = shapeParams(method, params)
  return (error, result) => {
    const ms = Math.round((performance.now() - started) * 10) / 10
    if (error) {
      const expected = codes.includes(error.code)
      cmd[expected ? 'warn' : 'error'](method, { surface, ms, ok: false, code: error.code ?? 'internal', message: String(error.message ?? error), ...(expected ? {} : { stack: error.stack }), params: shaped })
      return
    }
    const slow = ms >= SLOW_MS
    cmd[NOISY.has(method) && !slow ? 'trace' : 'debug'](method, { surface, ms, ok: true, params: shaped, ...(!SENSITIVE.test(method) && result !== undefined && result !== null && { result: sanitize(result, RESULT) }) })
  }
}

// Logs additions, removals, active tab and active space changes between calls.
function stateWatcher(activeTab) {
  let tabs = new Map()
  let active = null
  let space = null
  const host = (url) => { try { return new URL(url).host || url } catch { return String(url).slice(0, 80) } }
  return (state) => {
    try {
      const next = new Map(state.tabs.map((tab) => [tab.id, tab]))
      for (const [id, tab] of next) if (!tabs.has(id)) tabLog.info('created', { id, url: tab.url, space: tab.spaceId, partition: tab.sessionPartition, agent: tab.agent, chat: tab.chat })
      for (const [id, tab] of tabs) if (!next.has(id)) tabLog.info('closed', { id, host: host(tab.url) })
      for (const [id, tab] of next) {
        const before = tabs.get(id)
        if (before && before.spaceId !== tab.spaceId) tabLog.info('moved', { id, from: before.spaceId, to: tab.spaceId })
      }
      tabs = next
      const current = activeTab(state) ?? null
      if (state.activeSpaceId !== space) { winLog.info('space switched', { from: space, to: state.activeSpaceId }); space = state.activeSpaceId }
      if ((current?.id ?? null) !== active) { tabLog.info('activated', { id: current?.id ?? null, url: current?.url, from: active }); active = current?.id ?? null }
    } catch {}
  }
}

const LEVEL = { debug: 'debug', info: 'debug', warning: 'warn', error: 'error' }

function watchContents(wc, roleOf) {
  const id = wc.id
  const tag = () => ({ role: roleOf(wc), wc: id })
  const on = (event, fn) => wc.on(event, (...args) => { try { fn(...args) } catch {} })
  on('console-message', (event, ...legacy) => {
    const d = event?.message === undefined ? { level: legacy[0], message: legacy[1], lineNumber: legacy[2], sourceId: legacy[3] } : event
    const level = typeof d.level === 'number' ? ['debug', 'info', 'warning', 'error'][d.level] : d.level
    wcLog[LEVEL[level] ?? 'debug']('console', { ...tag(), text: d.message, source: `${d.sourceId}:${d.lineNumber}` })
  })
  on('did-start-navigation', (details, ...legacy) => {
    const mainFrame = details?.url === undefined ? legacy[1] : details.isMainFrame
    const url = details?.url ?? legacy[0]
    if (!/^(?:about:blank|data:)/.test(url ?? '')) wcLog[mainFrame ? 'debug' : 'trace']('did-start-navigation', { ...tag(), url, mainFrame, sameDocument: details?.isSameDocument ?? details?.isInPlace })
  })
  on('did-navigate', (_e, url, code, text) => wcLog.info('did-navigate', { ...tag(), url, status: code, statusText: text }))
  on('did-navigate-in-page', (_e, url, mainFrame) => wcLog.debug('did-navigate-in-page', { ...tag(), url, mainFrame }))
  on('did-redirect-navigation', (details, ...legacy) => wcLog.debug('redirect', { ...tag(), url: details?.url ?? legacy[0] }))
  on('did-finish-load', () => wcLog.debug('did-finish-load', { ...tag(), url: wc.getURL() }))
  on('dom-ready', () => wcLog.trace('dom-ready', tag()))
  on('did-fail-load', (_e, code, description, url, mainFrame) => wcLog[code === -3 || !mainFrame ? 'debug' : 'warn']('did-fail-load', { ...tag(), code, description, url, mainFrame }))
  on('did-fail-provisional-load', (_e, code, description, url, mainFrame) => wcLog[code === -3 || !mainFrame ? 'debug' : 'warn']('did-fail-provisional-load', { ...tag(), code, description, url, mainFrame }))
  on('preload-error', (_e, preload, error) => wcLog.error('preload-error', { ...tag(), preload, err: error }))
  on('render-process-gone', (_e, details) => wcLog.error('render-process-gone', { ...tag(), ...details, url: wc.getURL() }))
  on('unresponsive', () => wcLog.error('unresponsive', { ...tag(), url: wc.getURL() }))
  on('responsive', () => wcLog.warn('responsive', { ...tag(), url: wc.getURL() }))
  on('destroyed', () => wcLog.trace('destroyed', { wc: id }))
  // The owner registers the contents after construction, so name its role one tick later.
  setImmediate(() => wcLog.debug('created', { ...tag(), type: wc.isDestroyed() ? 'destroyed' : wc.getType() }))
}

function watchWindow(w, roleOf) {
  const id = w.id
  const bounds = () => { try { return w.getBounds() } catch { return null } }
  const on = (event, fn) => w.on(event, (...args) => { try { fn(...args) } catch {} })
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen', 'close', 'closed', 'unresponsive', 'responsive', 'always-on-top-changed']) {
    on(event, () => winLog[event === 'unresponsive' ? 'error' : event === 'focus' || event === 'blur' ? 'debug' : 'info'](event, { id, role: roleOf(w), ...(event !== 'closed' && { bounds: bounds() }) }))
  }
  let timer = null
  for (const event of ['resize', 'move']) on(event, () => {
    clearTimeout(timer)
    timer = setTimeout(() => winLog.debug(`${event}d`, { id, role: roleOf(w), bounds: bounds() }), 250)
  })
  on('closed', () => clearTimeout(timer))
  setImmediate(() => winLog.info('created', { id, role: roleOf(w), bounds: w.isDestroyed() ? null : bounds() }))
}

// Process-level and Electron app events. roleOf(wc) and windowRole(w) name a surface for the log.
function install({ electronApp, ipcMain, roleOf, windowRole }) {
  // Monitors observe without replacing Electron's own handling of a main-process error.
  process.on('uncaughtExceptionMonitor', (err, origin) => { app.error('uncaughtException', { err, origin }); log.current()?.flushSync() })
  process.on('unhandledRejection', (reason) => app.error('unhandledRejection', { err: reason }))
  process.on('warning', (warning) => app.warn('node warning', { err: warning }))
  electronApp.on('child-process-gone', (_e, details) => app.error('child-process-gone', details))
  electronApp.on('render-process-gone', (_e, wc, details) => app.error('render-process-gone', { ...details, role: roleOf(wc), url: wc.getURL?.() }))
  electronApp.on('gpu-info-update', () => app.info('gpu-info-update', { features: electronApp.getGPUFeatureStatus() }))
  electronApp.on('certificate-error', (_e, wc, url, error) => app.warn('certificate-error', { role: roleOf(wc), url, error }))
  electronApp.on('web-contents-created', (_e, wc) => watchContents(wc, roleOf))
  electronApp.on('browser-window-created', (_e, w) => watchWindow(w, windowRole))
  for (const event of ['will-finish-launching', 'ready', 'activate', 'open-url', 'second-instance', 'before-quit', 'will-quit', 'window-all-closed', 'browser-window-focus', 'browser-window-blur']) {
    electronApp.on(event, (...args) => {
      const detail = event === 'open-url' ? { url: args[1] } : event === 'second-instance' ? { argv: args[1] } : undefined
      app[event === 'browser-window-focus' || event === 'browser-window-blur' ? 'trace' : 'info'](event, detail)
    })
  }
  electronApp.on('quit', (_e, code) => { app.info('quit', { code }); log.current()?.flushSync() })
  // The page-side listener caps its own rate; the same cap here keeps a looping page from filling the log.
  const seen = new Map()
  ipcMain.on('skiff:renderer-error', (e, payload) => {
    const now = Date.now()
    const entry = seen.get(e.sender.id) ?? { at: now, n: 0 }
    if (now - entry.at > 1000) { entry.at = now; entry.n = 0 }
    seen.set(e.sender.id, entry)
    if (++entry.n > 20 || !payload || typeof payload !== 'object') return
    rendererLog.error(String(payload.message ?? 'error').slice(0, 2048), { role: roleOf(e.sender), wc: e.sender.id, kind: payload.kind, source: payload.source, line: payload.line, column: payload.column, url: payload.url, stack: payload.stack })
  })
}

function startup({ electronApp, dataDir, logDir, extra = {} }) {
  app.info('startup', {
    version: electronApp.getVersion(), packaged: electronApp.isPackaged, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion?.(), locale: electronApp.getLocale?.(), pid: process.pid,
    dataDir, logDir, execPath: process.execPath, argv: process.argv.slice(1), logLevel: process.env.SKIFF_LOG_LEVEL || 'debug', ...extra
  })
}

module.exports = { install, startup, commandLog, stateWatcher, surfaceOf, SENSITIVE, NOISY }

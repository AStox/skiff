'use strict'
const { contextBridge, ipcRenderer, webFrame } = require('electron')
// Errors the page raises, for the main-process log; capped so a looping page stays cheap. The page world is isolated from this one, so a hook is injected there.
{
  let sent = 0, windowStart = 0
  const send = (kind, payload) => {
    const now = Date.now()
    if (now - windowStart > 1000) { windowStart = now; sent = 0 }
    if (++sent > 10) return
    try { ipcRenderer.send('skiff:renderer-error', { kind, url: location.href.slice(0, 2048), ...payload }) } catch {}
  }
  contextBridge.exposeInMainWorld('__skiffReportError', (kind, payload) => send(kind, { message: String(payload?.message ?? ''), source: String(payload?.source ?? ''), line: payload?.line, column: payload?.column, stack: String(payload?.stack ?? '') }))
  webFrame.executeJavaScript(`addEventListener('error', (e) => __skiffReportError('error', { message: e.message, source: e.filename, line: e.lineno, column: e.colno, stack: e.error && e.error.stack }))
    addEventListener('unhandledrejection', (e) => __skiffReportError('unhandledrejection', { message: String(e.reason && e.reason.message || e.reason), stack: e.reason && e.reason.stack }))`).catch(() => {})
  window.addEventListener('error', (e) => { try { send('error', { message: e.message, source: e.filename, line: e.lineno, column: e.colno, stack: e.error?.stack }) } catch {} })
  window.addEventListener('unhandledrejection', (e) => { try { send('unhandledrejection', { message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }) } catch {} })
}
const browserTools = process.argv.find((arg) => arg.startsWith('--skiff-tools-url='))?.slice('--skiff-tools-url='.length)
async function call(method, params) {
  const out = await ipcRenderer.invoke('skiff:call', method, params)
  if (out.ok) return out.result
  throw out.error
}

contextBridge.exposeInMainWorld('skiff', {
  assets: {
    browserTools,
    favicons: process.argv.find((arg) => arg.startsWith('--skiff-icons-url='))?.slice('--skiff-icons-url='.length),
    shell: process.argv.find((arg) => arg.startsWith('--skiff-shell-url='))?.slice('--skiff-shell-url='.length)
  },
  call,
  storage: {
    read: (key, options = {}) => call('components.storage.read', { ...options, key }),
    write: (key, value, options = {}) => call('components.storage.write', { ...options, key, value }),
    remove: (key, options = {}) => call('components.storage.remove', { ...options, key })
  },
  settings: {
    list: (options = {}) => call('components.settings.list', options),
    get: (key, options = {}) => call('components.settings.get', { ...options, key }),
    set: (key, value, options = {}) => call('components.settings.set', { ...options, key, value }),
    reset: (key, options = {}) => call('components.settings.reset', { ...options, key })
  },
  source: {
    read: (file) => call('components.source.read', { file }),
    write: (file, content) => call('components.source.write', { file, content })
  },
  on: (name, listener) => {
    const handler = (_e, eventName, data) => {
      if (eventName === name) listener(data)
    }
    ipcRenderer.on('skiff:event', handler)
    return () => ipcRenderer.removeListener('skiff:event', handler)
  }
})

if (browserTools) window.addEventListener('DOMContentLoaded', () => {
  const script = document.createElement('script')
  script.src = new URL('shell.js', browserTools).href
  document.head.appendChild(script)
}, { once: true })

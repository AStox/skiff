'use strict'
const { contextBridge, ipcRenderer } = require('electron')
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

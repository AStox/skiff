'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('skiff', {
  call: async (method, params) => {
    const out = await ipcRenderer.invoke('skiff:call', method, params)
    if (out.ok) return out.result
    throw out.error
  },
  on: (name, listener) => {
    ipcRenderer.on('skiff:event', (_e, eventName, data) => {
      if (eventName === name) listener(data)
    })
  }
})

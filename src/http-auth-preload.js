'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('httpAuth', { submit: (result) => ipcRenderer.send('http-auth:result', result) })

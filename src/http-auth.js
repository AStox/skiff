'use strict'

const path = require('node:path')
const log = require('./log').scope('http-auth')

// Electron cancels an HTTP auth challenge unless 'login' is handled; this shows a small modal sign-in window per challenge.
// Credentials go straight from the dialog to the callback: never stored, never logged.
function createHttpAuth({ BrowserWindow, ipcMain, fallbackWindow }) {
  const dialogs = new Map() // dialog webContents id -> settle(result)

  ipcMain.on('http-auth:result', (event, result) => {
    const settle = dialogs.get(event.sender.id)
    if (!settle) return
    const ok = result && typeof result.username === 'string' && typeof result.password === 'string'
    settle(ok ? { username: result.username, password: result.password } : null)
  })

  function prompt(wc, authInfo) {
    if (wc?.isDestroyed()) return Promise.resolve(null)
    const owner = (wc && !wc.isDestroyed() && BrowserWindow.fromWebContents(wc)) || null
    const fallback = fallbackWindow()
    const parent = [owner, fallback].find((w) => w && !w.isDestroyed() && w.isVisible())
    return new Promise((resolve) => {
      const dialog = new BrowserWindow({
        parent: parent || undefined, modal: !!parent, show: false, width: 420, height: 262,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false, title: 'Sign in',
        webPreferences: { preload: path.join(__dirname, 'http-auth-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
      })
      dialog.removeMenu()
      const dwc = dialog.webContents
      const id = dwc.id
      let done = false
      const t = Date.now()
      const where = { host: authInfo.host, isProxy: Boolean(authInfo.isProxy) }
      log.info('auth prompted', where)
      const settle = (result) => {
        if (done) return
        done = true
        dialogs.delete(id)
        wc?.removeListener('destroyed', onGone)
        if (!dialog.isDestroyed()) dialog.destroy()
        log.info(result ? 'auth answered' : 'auth cancelled', { ...where, ms: Date.now() - t })
        resolve(result)
      }
      const onGone = () => settle(null)
      dialogs.set(id, settle)
      wc?.once('destroyed', onGone)
      dialog.on('closed', () => settle(null))
      dialog.once('ready-to-show', () => dialog.show())
      dwc.on('will-navigate', (e) => e.preventDefault())
      dwc.setWindowOpenHandler(() => ({ action: 'deny' }))
      const query = { host: authInfo.port && ![80, 443].includes(authInfo.port) ? `${authInfo.host}:${authInfo.port}` : authInfo.host, realm: authInfo.realm || '' }
      if (authInfo.isProxy) query.proxy = '1'
      dialog.loadFile(path.join(__dirname, 'http-auth.html'), { query }).catch((e) => { log.error('auth dialog failed to load', { ...where, err: e?.message }); settle(null) })
    })
  }

  // Wrong credentials make Chromium raise another 'login' for the same request; each gets its own dialog, one at a time.
  let queue = Promise.resolve()
  return function onLogin(event, webContents, _details, authInfo, callback) {
    event.preventDefault()
    log.info('auth requested', { host: authInfo.host, isProxy: Boolean(authInfo.isProxy) })
    queue = queue.then(() => prompt(webContents, authInfo)).then(
      (result) => result ? callback(result.username, result.password) : callback(),
      (e) => { log.error('auth prompt failed', { err: e?.stack }); callback() }
    )
  }
}

module.exports = { createHttpAuth }

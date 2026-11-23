'use strict'

const HOUR = 3600e3
const bad = (message) => Object.assign(new Error(message), { code: 'bad_params' })

// One shutdown for every way out: before-quit, updates.install. cleanup runs once; quitAndInstall must not hit a handler that blocks it.
function createQuit({ cleanup, quit }) {
  let running = null, done = false, installing = false, quitting = false
  const run = () => running ??= Promise.resolve().then(cleanup).catch(console.error).finally(() => { done = true })
  return {
    run,
    beforeQuit(event) {
      if (done) return
      event.preventDefault()
      if (quitting) return
      quitting = true
      run().then(() => { if (!installing) quit() })
    },
    // Resolves after cleanup; the caller then hands the quit to the updater. A failed hand-off falls back to a plain quit.
    async install(quitAndInstall) {
      if (installing) return
      installing = true
      await run()
      try { quitAndInstall() } catch (error) { installing = false; quit(); throw error }
    }
  }
}

// state() is null when updates are unsupported, else {status, version?, percent?}; never persisted.
function createUpdates({ updater, supported, quit, onChange = () => {}, notify = () => {}, now = Date.now }) {
  let state = supported ? { status: 'idle' } : null
  let last = 0, notified = null
  const set = (next) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    onChange(state)
  }
  const ready = () => state?.status === 'ready'
  const on = (event, fn) => updater.on(event, (...args) => { if (state) fn(...args) })
  on('checking-for-update', () => ready() || set({ status: 'checking' }))
  on('update-not-available', () => ready() || set({ status: 'idle' }))
  on('update-available', (info) => ready() && state.version === info?.version || set({ status: 'downloading', version: info?.version, percent: 0 }))
  on('download-progress', (p) => ready() || set({ status: 'downloading', version: state.version, percent: Math.round(p?.percent ?? 0) }))
  on('update-downloaded', (info) => {
    set({ status: 'ready', version: info?.version })
    if (notified !== info?.version) { notified = info?.version; notify(info?.version) }
  })
  on('error', (error) => { console.error('update failed:', error); ready() || set({ status: 'error' }) })

  async function check() {
    if (!state) throw bad('Updates are only available in the packaged macOS app')
    last = now()
    try { await updater.checkForUpdates() } catch (error) { console.error('update check failed:', error); ready() || set({ status: 'error' }) }
    return state
  }
  const checkIfStale = () => { if (state && now() - last > HOUR) return check() }
  async function install() {
    if (!state) throw bad('Updates are only available in the packaged macOS app')
    if (!ready()) throw bad('No update is ready to install')
    await quit.install(() => updater.quitAndInstall())
  }
  return { state: () => state, check, checkIfStale, install, ready, HOUR }
}

module.exports = { createQuit, createUpdates }

'use strict'
// Runs in every frame of a persistent session. In extension pages it adds the chrome.* surface Electron lacks and
// uBlock Origin expects: tab and navigation events, windows, browserAction, privacy, and tab calls answered by the
// main process. Extension pages have no context isolation, so the page's own chrome object is patched directly;
// browser is uBO's alias of it. In web pages it holds the first script until the extensions have taken the frame's
// navigation event, so what a blocker injects from it lands before the page's own scripts.
const { ipcRenderer } = require('electron')

if (/^https?:$/.test(location.protocol)) {
  ipcRenderer.sendSync('skiff:frame-start', location.href)
} else if (location.protocol === 'chrome-extension:') {
  const listeners = new Map()
  const events = new Map()
  // An extension that listens for navigations is up and filtering; main holds the session's page loads until it says so.
  let announced = false
  const announce = () => {
    if (announced) return
    announced = true
    setTimeout(() => ipcRenderer.send('skiff:extension-ready'), 0)
  }
  const event = (name) => {
    if (!events.has(name)) {
      const fns = new Set()
      listeners.set(name, fns)
      events.set(name, { addListener: (fn) => { fns.add(fn); if (name === 'webNavigation.onBeforeNavigate') announce() }, removeListener: (fn) => fns.delete(fn), hasListener: (fn) => fns.has(fn), hasListeners: () => fns.size > 0 })
    }
    return events.get(name)
  }
  const dispatch = (name, args) => {
    for (const fn of listeners.get(name) || []) {
      try { fn(...args) } catch (e) { console.error(`${name} listener failed`, e) }
    }
  }
  ipcRenderer.on('skiff:extension-event', (_e, name, ...args) => dispatch(name, args))
  ipcRenderer.on('skiff:extension-event-acked', (_e, name, token, ...args) => {
    dispatch(name, args)
    ipcRenderer.send('skiff:extension-ack', token)
  })
  const call = (method) => (...args) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null
    const result = ipcRenderer.invoke('skiff:extension', method, args)
    if (callback) result.then((value) => callback(value), () => callback())
    return result
  }
  const done = (...args) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null
    if (callback) callback()
    return Promise.resolve()
  }
  const setting = () => ({
    get: (_d, callback) => { const value = { levelOfControl: 'not_controllable' }; if (callback) callback(value); return Promise.resolve(value) },
    set: done,
    clear: done,
    onChange: event('privacy.onChange')
  })
  const patch = (chrome) => {
    chrome.browserAction = { setIcon: done, setBadgeText: done, setBadgeBackgroundColor: done, setBadgeTextColor: done, setTitle: done, setPopup: done, enable: done, disable: done, getBadgeText: call('browserAction.getBadgeText'), onClicked: event('browserAction.onClicked') }
    chrome.contextMenus = { create: (props, callback) => { if (callback) callback(); return props.id }, update: done, remove: done, removeAll: done, onClicked: event('contextMenus.onClicked') }
    chrome.privacy = { network: { networkPredictionEnabled: setting(), webRTCIPHandlingPolicy: setting() }, websites: { hyperlinkAuditingEnabled: setting() }, services: {} }
    chrome.windows = { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2, get: call('windows.get'), getCurrent: call('windows.getCurrent'), getLastFocused: call('windows.getLastFocused'), getAll: call('windows.getAll'), create: call('windows.create'), update: call('windows.update'), onFocusChanged: event('windows.onFocusChanged'), onCreated: event('windows.onCreated'), onRemoved: event('windows.onRemoved') }
    chrome.webNavigation = { getFrame: call('webNavigation.getFrame'), getAllFrames: call('webNavigation.getAllFrames'), onBeforeNavigate: event('webNavigation.onBeforeNavigate'), onCommitted: event('webNavigation.onCommitted'), onDOMContentLoaded: event('webNavigation.onDOMContentLoaded'), onCompleted: event('webNavigation.onCompleted'), onErrorOccurred: event('webNavigation.onErrorOccurred'), onCreatedNavigationTarget: event('webNavigation.onCreatedNavigationTarget'), onHistoryStateUpdated: event('webNavigation.onHistoryStateUpdated'), onReferenceFragmentUpdated: event('webNavigation.onReferenceFragmentUpdated') }
    if (chrome.tabs) {
      for (const name of ['get', 'query', 'create', 'remove', 'update', 'insertCSS', 'removeCSS']) chrome.tabs[name] = call(`tabs.${name}`)
      for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onActivated']) chrome.tabs[name] = event(`tabs.${name}`)
    }
  }
  patch(chrome)
  if (globalThis.browser && globalThis.browser !== chrome) patch(globalThis.browser)
}

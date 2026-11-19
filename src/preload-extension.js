'use strict'
// Runs in every frame of a persistent session and does nothing outside extension pages. Inside them it adds
// the chrome.* surface Electron lacks and uBlock Origin expects: tab and navigation events, windows,
// browserAction, privacy, and tab calls answered by the main process. Extension pages have no context
// isolation, so the page's own chrome object is patched directly; browser is uBO's alias of it.
const { ipcRenderer } = require('electron')

if (location.protocol === 'chrome-extension:') {
  const listeners = new Map()
  const events = new Map()
  const event = (name) => {
    if (!events.has(name)) {
      const fns = new Set()
      listeners.set(name, fns)
      events.set(name, { addListener: (fn) => fns.add(fn), removeListener: (fn) => fns.delete(fn), hasListener: (fn) => fns.has(fn), hasListeners: () => fns.size > 0 })
    }
    return events.get(name)
  }
  ipcRenderer.on('skiff:extension-event', (_e, name, ...args) => {
    for (const fn of listeners.get(name) || []) {
      try { fn(...args) } catch (e) { console.error(`${name} listener failed`, e) }
    }
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

'use strict'
const events = []
// Counts background starts in storage: a reinstall under the same id keeps the count, a fresh id starts over.
const installs = new Promise((resolve) => chrome.storage.local.get('installs', (stored) => {
  const count = (stored.installs || 0) + 1
  chrome.storage.local.set({ installs: count }, () => resolve(count))
}))

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.url.includes('/ext/blocked.js')) return { cancel: true }
  if (details.url.includes('/ext/redirect-me.js')) return { redirectUrl: chrome.runtime.getURL('stub.js') }
  return {}
}, { urls: ['<all_urls>'] }, ['blocking'])

chrome.webNavigation.onCommitted.addListener((details) => {
  events.push({ what: 'committed', tabId: details.tabId, frameId: details.frameId, url: details.url })
  if (details.frameId === 0 && details.url.startsWith('http:')) {
    chrome.tabs.insertCSS(details.tabId, { code: '#hide-me { display: none !important }', cssOrigin: 'user', frameId: 0 })
  }
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => events.push({ what: 'updated', tabId, changeInfo }))
chrome.tabs.onActivated.addListener((info) => events.push({ what: 'activated', tabId: info.tabId }))
chrome.tabs.onRemoved.addListener((tabId) => events.push({ what: 'removed', tabId }))

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.what === 'hello') {
    reply({ tabId: sender.tab.id, frameId: sender.frameId })
    return false
  }
  if (message.what === 'report') {
    installs.then((count) => chrome.tabs.query({ active: true, currentWindow: true }, (active) => reply({ events, active, installs: count })))
    return true
  }
  if (message.what === 'openOptions') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html'), active: true })
    reply({ ok: true })
    return false
  }
  return false
})

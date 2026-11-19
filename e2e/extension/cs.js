'use strict'
document.documentElement.dataset.cs = 'ran'
chrome.runtime.sendMessage({ what: 'hello' }, (reply) => {
  document.documentElement.dataset.tabId = String(reply.tabId)
  document.documentElement.dataset.frameId = String(reply.frameId)
})

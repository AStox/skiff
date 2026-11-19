'use strict'
chrome.runtime.sendMessage({ what: 'report' }, (reply) => {
  document.getElementById('events').textContent = JSON.stringify(reply.events)
  document.getElementById('active').textContent = reply.active.map((tab) => tab.url).join(' ')
  document.getElementById('installs').textContent = String(reply.installs)
})
document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.sendMessage({ what: 'openOptions' })
})

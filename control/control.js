'use strict'
// The control layer over one agent-driven page (see controlMode in src/main.js).
const id = new URLSearchParams(location.search).get('tab')
const $ = (name) => document.getElementById(name)
let state = null
let placed = false
let fadeTimer = null

const button = (text, onclick, quiet) => {
  const el = document.createElement('button')
  el.type = 'button'
  el.textContent = text
  if (quiet) el.className = 'quiet'
  el.addEventListener('click', onclick)
  return el
}
const call = (method, params) => skiff.call(method, params).catch(() => {})

function render() {
  const tab = state?.tabs.find((t) => t.id === id)
  if (!tab || !(tab.agent || tab.agentRequest)) return
  const mode = tab.agentRequest ? 'request' : tab.agentControl === 'user' ? 'user' : 'lock'
  const who = tab.agentRequest?.agent || tab.agent
  if (document.body.dataset.mode === mode && $('text').dataset.who === who) return
  document.body.dataset.mode = mode
  $('label').textContent = who
  $('text').dataset.who = who
  if (mode === 'request') {
    $('text').textContent = `${who} wants to use this tab`
    $('actions').replaceChildren(button('Deny', () => call('agent.answerTab', { id, allow: false }), true), button('Allow', () => call('agent.answerTab', { id, allow: true })))
  } else if (mode === 'user') {
    $('text').textContent = `You have control of this tab. ${who} is paused.`
    $('actions').replaceChildren(button('Give back', () => call('agent.giveBack', { id })))
  } else {
    $('text').textContent = `${who} is using this tab`
    $('actions').replaceChildren(button('Take over', () => call('agent.takeOver', { id })))
  }
}

// The cursor glides over ms; the first appearance starts a little way off so it is seen arriving.
function moveCursor({ x, y, ms }) {
  const el = $('cursor')
  const to = (px, py) => { el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)` }
  if (!placed) {
    placed = true
    el.style.transition = 'none'
    to(ms ? Math.max(0, x - 160) : x, ms ? Math.max(0, y - 110) : y)
    el.classList.add('on')
    el.getBoundingClientRect()
  }
  el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.22, .8, .3, 1)` : 'none'
  to(x, y)
}

function ripple({ x, y }) {
  const el = $('ripple')
  el.style.transform = `translate(${x}px, ${y}px)`
  el.classList.remove('go')
  el.getBoundingClientRect()
  el.classList.add('go')
}

function highlight(rect) {
  const el = $('field')
  clearTimeout(fadeTimer)
  el.classList.toggle('on', Boolean(rect))
  if (!rect) return
  Object.assign(el.style, { left: `${rect.x - 3}px`, top: `${rect.y - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` })
  fadeTimer = setTimeout(() => el.classList.remove('on'), 5000)
}

skiff.on('state', (s) => { state = s; render() })
skiff.on('agent-cursor', moveCursor)
skiff.on('agent-ripple', ripple)
skiff.on('agent-highlight', highlight)
skiff.call('state.get').then((s) => { state = s; render() }).catch(() => {})

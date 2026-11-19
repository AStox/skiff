'use strict'

const $ = (id) => document.getElementById(id)
const chatId = new URLSearchParams(location.search).get('id') || ''
const input = $('chat-input')
const log = $('chat-log')
const STATUS = { setup: 'Not connected', restoring: 'Restoring', ready: 'Ready', running: 'Working', error: 'Stopped with an error' }
const TOOL = { pending: 'Waiting', in_progress: 'Running', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' }
const STOPPED = { max_tokens: 'Stopped at the length limit.', max_turn_requests: 'Stopped at the step limit.', refusal: 'The agent declined.', cancelled: 'Stopped.', error: 'The agent stopped with an error.' }
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^(#{1,6})\s+(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
// Code spans, then **bold**/__bold__, *italic*/_italic_, then [text](url).
const INLINE = /`([^`\n]+)`|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g

let chat = null
let agents = []
let state = null
let failure = ''
let permissionKey = ''
let sentPending = false
let stick = true
// Turn id to its element and the fields it shows, so a streamed chunk rebuilds only the turn it changed.
const drawn = new Map()

function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else if (value === true) el.setAttribute(key, '')
    else if (value !== false && value != null) el.setAttribute(key, value)
  }
  el.append(...children.flat().filter((c) => c != null && c !== false && c !== ''))
  return el
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

const busy = () => chat?.status === 'running' || chat?.status === 'restoring'
const inSetup = () => chat?.status === 'setup' && !agents.length

function showError(text) {
  failure = text
  drawError()
}
function drawError() {
  const text = failure || chat?.error || ''
  $('chat-error').textContent = text
  $('chat-error').hidden = !text
}

/* ---------- markdown: text nodes only, links shown as text with the URL in a title ---------- */

function inline(text) {
  const out = []
  let at = 0
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(at, m.index))
    at = m.index + m[0].length
    if (m[1] != null) out.push(h('code', {}, m[1]))
    else if (m[2] != null || m[3] != null) out.push(h('strong', {}, inline(m[2] ?? m[3])))
    else if (m[4] != null || m[5] != null) out.push(h('em', {}, inline(m[4] ?? m[5])))
    else out.push(h('span', { class: 'ai-link', title: m[7] }, inline(m[6])))
  }
  out.push(text.slice(at))
  return out
}

// ponytail: nested list items flatten into their list with an indent; no tables, quotes or rules until agents need them
function markdown(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    const heading = HEADING.exec(line)
    const item = ITEM.exec(line)
    if (fence) {
      const body = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i])
      i++
      out.push(h('div', { class: 'ai-code' }, fence[2] && h('div', { class: 'ai-code-lang' }, fence[2]), h('pre', {}, h('code', {}, body.join('\n')))))
    } else if (heading) {
      out.push(h(`h${Math.min(heading[1].length + 1, 6)}`, {}, inline(heading[2].replace(/\s+#+\s*$/, ''))))
      i++
    } else if (item) {
      const ordered = /\d/.test(item[2])
      const list = h(ordered ? 'ol' : 'ul', { start: ordered && parseInt(item[2], 10) !== 1 ? parseInt(item[2], 10) : null })
      for (let m; i < lines.length; i++) {
        if ((m = ITEM.exec(lines[i])) && (m[1].length > item[1].length || /\d/.test(m[2]) === ordered)) list.append(h('li', { class: m[1].length > item[1].length ? 'nested' : null }, inline(m[3])))
        else if (lines[i].trim() && /^\s/.test(lines[i]) && !FENCE.test(lines[i])) list.lastChild.append('\n', ...inline(lines[i].trim()))
        else break
      }
      out.push(list)
    } else if (!line.trim()) {
      i++
    } else {
      const para = []
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !ITEM.test(lines[i])) para.push(lines[i++])
      out.push(h('p', {}, inline(para.join('\n'))))
    }
  }
  return out
}

/* ---------- conversation ---------- */

function fields(t) {
  if (t.kind === 'user') return [t.kind, t.text, t.context?.title, t.context?.url]
  if (t.kind === 'assistant') return [t.kind, t.text, t.thought, t.done, t.stopReason]
  if (t.kind === 'tool') return [t.kind, t.title, t.status, t.text]
  return [t.kind, t.text]
}

function turnEl(t, open) {
  if (t.kind === 'user') {
    return h('div', { class: 'ai-user' }, h('p', { class: 'ai-bubble' }, t.text),
      t.context && h('p', { class: 'ai-context', title: t.context.url }, `Page: ${t.context.title || t.context.url}`))
  }
  if (t.kind === 'assistant') {
    const thinking = !t.done && !t.text
    return h('div', { class: 'ai-assistant' },
      t.thought && h('details', { class: 'ai-thought', open }, h('summary', { class: 'ai-row' }, h('span', { class: thinking ? 'shine' : null }, thinking ? 'Thinking' : 'Thought'), icon('right')), h('p', {}, t.thought)),
      t.text && h('div', { class: 'ai-md' }, markdown(t.text)),
      thinking && !t.thought && h('p', { class: 'ai-working ai-row' }, h('span', { class: 'shine' }, 'Working')),
      STOPPED[t.stopReason] && h('p', { class: 'ai-stopped' }, icon('info'), STOPPED[t.stopReason]))
  }
  if (t.kind === 'tool') {
    const status = TOOL[t.status] ? t.status : 'pending'
    const live = status === 'pending' || status === 'in_progress'
    const glyph = status === 'completed' ? icon('check') : status === 'failed' || status === 'cancelled' ? icon('x') : h('span', { class: 'ai-spinner' })
    const head = [h('span', { class: 'ai-glyph', role: 'img', 'aria-label': TOOL[status], title: TOOL[status] }, glyph), h('span', { class: `ai-tool-title${live ? ' shine' : ''}` }, t.title || 'Tool call')]
    return h('div', { class: 'ai-tool', 'data-status': status },
      t.text ? h('details', { open }, h('summary', { class: 'ai-row' }, head, icon('right')), h('pre', {}, t.text)) : h('div', { class: 'ai-tool-head ai-row' }, head))
  }
  return h('p', { class: 'ai-notice' }, t.text)
}

function drawLog() {
  const turns = chat.turns || []
  const ids = new Set(turns.map((t) => t.id))
  for (const [id, entry] of drawn) {
    if (ids.has(id)) continue
    entry.el.remove()
    drawn.delete(id)
  }
  let at = log.firstChild
  for (const t of turns) {
    const parts = fields(t)
    let entry = drawn.get(t.id)
    if (!entry || parts.some((part, i) => part !== entry.parts[i])) {
      const el = turnEl(t, Boolean(entry?.el.querySelector('details')?.open))
      if (entry) {
        if (at === entry.el) at = el
        entry.el.replaceWith(el)
      }
      entry = { el, parts }
      drawn.set(t.id, entry)
    }
    if (at === entry.el) at = at.nextSibling
    else log.insertBefore(entry.el, at)
  }
  log.hidden = !turns.length
  $('chat-empty').hidden = Boolean(turns.length) || inSetup()
  if (stick) log.scrollTop = log.scrollHeight
}

function drawPermission() {
  const p = chat.permission
  const key = p ? JSON.stringify([p.id, p.title, p.options]) : ''
  if (key === permissionKey) return
  permissionKey = key
  $('chat-permission').hidden = !p
  if (!p) return $('chat-permission-options').replaceChildren()
  $('chat-permission-title').textContent = p.title || 'Use a tool'
  $('chat-permission-options').replaceChildren(...(p.options || []).map((o) => h('button', {
    class: o.kind === 'allow_once' ? 'text-btn primary' : 'text-btn outline', type: 'button', 'data-option-id': o.optionId, 'data-kind': o.kind,
    onclick: () => skiff.call('ai.permit', { chatId, optionId: o.optionId }).catch((error) => showError(error.message || 'That answer did not reach the agent.'))
  }, o.name || o.optionId)))
}

// Rebuilt only when the choices change, so a push never closes a select the user has open.
function fill(select, options, value) {
  const key = JSON.stringify(options)
  if (select.dataset.key !== key) {
    select.dataset.key = key
    select.replaceChildren(...options.map((o) => h('option', { value: o.value }, o.name || o.value)))
  }
  select.value = value ?? ''
  select.parentElement.hidden = !options.length
}

function render() {
  if (!chat) return
  const setup = inSetup()
  $('chat-connect-card').hidden = !setup
  $('chat-pending').textContent = chat.pending || ''
  $('chat-pending').hidden = !chat.pending
  $('chat-foot').hidden = setup
  const name = chat.agent || (chat.status === 'setup' ? agents[0]?.name : '') || 'Agent'
  $('chat-name').textContent = setup ? 'Connect an agent' : name
  $('chat-empty-name').textContent = name
  $('chat-empty-note').textContent = chat.status === 'restoring' ? 'Restoring the conversation' : chat.status === 'running' ? 'Starting' : 'Ask anything.'
  $('chat-empty-note').className = busy() ? 'shine' : ''
  $('chat-status').dataset.status = chat.status
  $('chat-status').title = STATUS[chat.status] || chat.status
  $('chat-status').setAttribute('aria-label', $('chat-status').title)
  fill($('chat-model'), chat.models || [], chat.model)
  fill($('chat-effort'), chat.efforts || [], chat.effort)
  $('chat-model').disabled = $('chat-effort').disabled = busy()
  $('chat-stop').hidden = chat.status !== 'running'
  $('chat-send').hidden = chat.status === 'running'
  $('chat-send').disabled = chat.status === 'restoring'
  input.placeholder = (chat.turns || []).length ? 'Ask for a follow-up' : `Ask ${name}`
  drawLog()
  drawPermission()
  drawError()
}

// A question asked before any agent existed goes out once the first one is connected.
function sendPending() {
  if (sentPending || chat?.status !== 'setup' || !chat.pending || !agents.length) return
  sentPending = true
  skiff.call('ai.prompt', { chatId, text: chat.pending }).catch((error) => showError(error.message || 'The agent did not get that. Try again.'))
}

function theme() {
  const tab = state.tabs.find((t) => t.id === chat?.tabId)
  const space = state.spaces.find((s) => s.id === (tab?.spaceId || state.activeSpaceId))
  if (!space) return
  document.documentElement.style.setProperty('--accent', space.color)
  document.documentElement.classList.toggle('incognito', Boolean(space.incognito))
}

async function send() {
  const text = input.value.trim()
  if (!text || !chat || busy()) return
  failure = ''
  drawError()
  try {
    await skiff.call('ai.prompt', { chatId, text })
    if (input.value.trim() === text) input.value = ''
    log.scrollTop = log.scrollHeight
  } catch (error) {
    showError(error.message || 'The agent did not get that. Try again.')
  }
}

const configure = (key) => skiff.call('ai.configure', { chatId, [key]: $(`chat-${key}`).value }).catch((error) => {
  showError(error.message || 'The agent did not take that setting.')
  render()
})

const openAgents = () => skiff.call('ui.emit', { name: 'toggle-settings', data: { section: 'agents' } }).catch((error) => showError(error.message || 'Settings did not open.'))

/* ---------- events ---------- */

$('chat-composer').addEventListener('submit', (event) => {
  event.preventDefault()
  send()
})
input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  send()
})
input.addEventListener('input', () => {
  if (!failure) return
  failure = ''
  drawError()
})
$('chat-stop').addEventListener('click', () => skiff.call('ai.cancel', { chatId }).catch((error) => showError(error.message || 'The agent did not stop.')))
$('chat-model').addEventListener('change', () => configure('model'))
$('chat-effort').addEventListener('change', () => configure('effort'))
$('chat-agents').addEventListener('click', openAgents)
$('chat-connect').addEventListener('click', openAgents)

skiff.on('chat', (next) => {
  if (next?.id !== chatId) return
  chat = next
  render()
  sendPending()
})
skiff.on('ai-agents', (next) => {
  agents = next || []
  render()
  sendPending()
})
skiff.on('state', (next) => {
  state = next
  theme()
})
skiff.call('ai.chat', { chatId }).then((first) => {
  chat = chat || first
  render()
  sendPending()
  if (state) theme()
}).catch((error) => showError(error.message || 'This conversation could not load.'))
skiff.call('ai.agents').then((first) => {
  agents = first || []
  render()
  sendPending()
}).catch(() => {})
skiff.call('state.get').then((first) => {
  state = state || first
  theme()
}).catch(() => {})
// Stays at the bottom while the log shrinks (permission tray, composer growing) or reflows (fonts), unless the user scrolled up.
log.addEventListener('scroll', () => { stick = log.scrollHeight - log.scrollTop - log.clientHeight < 32 })
new ResizeObserver(() => { if (stick) log.scrollTop = log.scrollHeight }).observe(log)
document.fonts.ready.then(() => { if (stick) log.scrollTop = log.scrollHeight })
input.focus()

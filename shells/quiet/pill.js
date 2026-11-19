'use strict'

const $ = (id) => document.getElementById(id)
const pill = $('pill')
let state = null
let noticeText = ''
let noticeTimer
let lastWidth = 0

const call = (method, params) => skiff.call(method, params).catch(() => {})
const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId)

// The overlay rectangle is only the pill plus its 16px margins, so the page around it stays clickable.
function fit() {
  const width = Math.ceil(pill.getBoundingClientRect().width) + 32
  if (width === lastWidth) return
  lastWidth = width
  showPill(width).catch(() => {})
}

function render() {
  if (!state) return
  const space = activeSpace()
  document.documentElement.style.setProperty('--accent', space.color)
  document.documentElement.classList.toggle('incognito', Boolean(space.incognito))
  $('pill-name').textContent = space.name
  $('pill-count').textContent = noticeText || tabCount(state.tabs.filter((t) => t.spaceId === space.id && !t.favorite && !t.pinned).length)
  pill.title = `${space.name}: open the sidebar`
  fit()
}

const openPanel = () => call('ui.showOverlay', { file: 'panel.html' })
pill.addEventListener('click', openPanel)
skiff.on('toggle-sidebar', openPanel)
new ResizeObserver(fit).observe(pill)

// The pill is the only shell surface at rest, so short notices show in place of the tab count.
function notice(text) {
  noticeText = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeText = ''
    render()
  }, 1500)
  render()
}

skiff.on('url-copied', () => notice('Copied URL'))
skiff.on('pill-notice', (data) => { if (data?.text) notice(String(data.text)) })
skiff.on('state', (next) => {
  state = next
  render()
})
skiff.call('state.get').then((first) => {
  state = first
  render()
}).catch(() => { $('pill-name').textContent = 'Skiff' })
// The pill is shown again after the panel or the bar closes, and the page must get the keyboard back.
call('ui.setWindowButtons', { visible: false }).then(() => call('ui.focusPage'))

'use strict'

const $ = (id) => document.getElementById(id)
const pill = $('dock')
let state = null
let noticeText = ''
let noticeTimer
let lastWidth = 0
let active = true

const call = (method, params) => skiff.call(method, params).catch(() => {})
const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId)

// The overlay rectangle is only the pill plus its 16px margins, so the page around it stays clickable.
function fit() {
  if (!active) return
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
  $('pill').title = `${space.name}: open the sidebar`
  renderUpdate()
  fit()
}

function renderUpdate() {
  const update = state.update?.status === 'ready' ? `Restart to update to Skiff ${state.update.version}` : ''
  $('update-pill').hidden = !update
  $('update-pill').title = update
  $('update-pill').setAttribute('aria-label', update)
}

const openPanel = () => {
  active = false
  return call('ui.showOverlay', { file: 'panel.html' })
}
$('pill').addEventListener('click', openPanel)
$('update-pill').addEventListener('click', () => call('updates.install'))
skiff.on('toggle-sidebar', openPanel)
// Retire resize and startup-focus requests as soon as another surface is requested.
for (const name of ['new-tab', 'focus-address', 'toggle-settings', 'toggle-archive', 'import-arc']) {
  skiff.on(name, () => { active = false })
}
addEventListener('pagehide', () => { active = false })
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
call('ui.setWindowButtons', { visible: false }).then(() => { if (active) return call('ui.focusPage') })

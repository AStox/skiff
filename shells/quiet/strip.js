'use strict'

const $ = (id) => document.getElementById(id)
const pageEl = $('page')
let state = null
let lastBounds = ''
let surfaceRequested = false

const call = (method, params) => skiff.call(method, params).catch(() => {})
const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId)
const activeTab = () => state.tabs.find((t) => t.id === state.activeTabBySpace[state.activeSpaceId])

function openPalette(mode) {
  if (!state) return
  surfaceRequested = true
  call('ui.showOverlay', { file: 'palette.html' }).then(() => call('ui.emit', { name: 'palette', data: { mode } }))
}

// The panel is shown first, then the event is sent again marked as forwarded, which the panel acts on and this page ignores.
function summon(name) {
  if (!state) return
  surfaceRequested = true
  const shown = call('ui.showOverlay', { file: 'panel.html' })
  if (name) shown.then(() => call('ui.emit', { name, data: { forwarded: true } }))
}

// The page is the whole window here, so the popup goes just inside its top-left corner.
function openExtensionPopup() {
  skiff.call('extensions.list').then((list) => {
    const entry = (list || []).find((e) => e.popup)
    if (entry) return call('extensions.popup', { id: entry.id, bounds: { x: 16, y: 16, width: 440, height: 680 } })
    call('ui.emit', { name: 'pill-notice', data: { text: 'No extension has a panel.' } })
  }).catch(() => {})
}

function render() {
  if (!state) return
  const space = activeSpace()
  const tab = activeTab()
  renderBackground(space, innerWidth)
  document.title = tab ? `${tab.title || tab.url} - Skiff` : 'Skiff'
  $('empty').hidden = Boolean(tab)
  $('empty-text').textContent = space.incognito ? 'Search the web or open a tab.' : 'Search the web, open a tab, or bring your spaces from Arc.'
  $('empty-import').hidden = Boolean(space.incognito)
  reportBounds()
}

function reportBounds() {
  const r = pageEl.getBoundingClientRect()
  const bounds = { x: r.x, y: r.y, width: r.width, height: r.height, radius: parseFloat(getComputedStyle(pageEl).borderTopLeftRadius) || 0 }
  if (JSON.stringify(bounds) === lastBounds) return
  lastBounds = JSON.stringify(bounds)
  call('ui.setPageBounds', bounds)
}

$('empty-new-tab').addEventListener('click', () => openPalette('new'))
$('empty-import').addEventListener('click', () => summon('import-arc'))
new ResizeObserver(reportBounds).observe(pageEl)
appearance.addEventListener('change', render)
addEventListener('resize', render)

skiff.on('new-tab', (data) => { if (!data?.forwarded) openPalette('new') })
skiff.on('focus-address', (data) => { if (!data?.forwarded) openPalette('edit') })
for (const name of ['toggle-settings', 'toggle-archive', 'import-arc']) skiff.on(name, (data) => { if (!data?.forwarded) summon(name) })
skiff.on('extension-popup', openExtensionPopup)
skiff.on('state', (next) => {
  state = next
  render()
})
skiff.call('state.get').then((first) => {
  state = first
  render()
}).catch(() => { $('empty-text').textContent = 'Skiff could not load your spaces. Reload the shell or restart Skiff.' })
// At rest only the pill floats over the page, and the page keeps the keyboard.
call('ui.setWindowButtons', { visible: false }).then(async () => {
  if (surfaceRequested) return
  await showPill().catch(() => {})
  if (!surfaceRequested) await call('ui.focusPage')
})

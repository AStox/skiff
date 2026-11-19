'use strict'

// The base page lies under every window: it draws the snapping guides and zone previews, opens the overlays and owns the app's events.
const $ = (id) => document.getElementById(id)
const deskEl = $('desk')

let state = null
// The file the main overlay (the command bar) shows, or '' while it is closed.
let open = ''
// The panel lives in its own overlay and stays open until Cmd+S, the Buoy or its close button closes it.
let panel = false
// Set while exposé is open.
let exposed = false
// The tab list floats in its own overlay, 'tabs', above other apps; the count in the Buoy toggles it.
let list = false

const call = (method, params) => skiff.call(method, params).catch(() => {})
const quietly = (name, data) => call('ui.emit', { name, data, focus: false })
const tellBuoy = () => quietly('buoy-state', { panel, list })
const notice = (text) => quietly('buoy-notice', { text })
// Ends the foreground set, so every window of the space is on the desk again.
const everyWindow = () => { if (state?.deskOnly) call('ui.setDesk', { only: null }) }

/* ---------- guides and zones, sent by the window being dragged ---------- */

function place(el, r) {
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
  return el
}

function drawGuides(data) {
  const parts = []
  if (data?.zone) parts.push(place(h('div', { class: 'zone', 'data-label': data.zone.label }), data.zone))
  for (const g of data?.guides || []) parts.push(place(h('div', { class: `guide ${g.width ? 'h' : 'v'}` }), g))
  deskEl.replaceChildren(...parts)
}

/* ---------- overlays open from the Buoy ---------- */

function showBuoy() {
  if (!state) return
  const r = buoyRect(state)
  call('ui.showOverlay', { name: 'buoy', file: 'buoy.html', bounds: { x: Math.max(0, r.x - BUOY_ROOM), y: Math.max(0, r.y - BUOY_ROOM), width: r.width + 2 * BUOY_ROOM, height: r.height + 2 * BUOY_ROOM }, float: true, focus: false }).then(tellBuoy)
}

// Opened as tall as the room beside the Buoy; the overlay trims itself once it has measured its content.
function openOverlay(file, width, name, data) {
  if (!state) return
  open = file
  tellBuoy()
  call('ui.showOverlay', { file, bounds: anchor(state, width, Infinity).bounds })
    .then(() => call('ui.emit', { name, data: { ...data, forwarded: true } }))
}
const openPalette = (mode) => openOverlay('palette.html', PALETTE_WIDTH, 'palette', { mode })

// Shown without the keyboard unless focus is asked for; an open panel only hears the event.
function showPanel(name = 'panel-open', focus = false, data) {
  if (!state) return
  everyWindow()
  const { forwarded, ...rest } = data || {}
  if (panel) return quietly(name, { ...rest, forwarded: true, focus })
  panel = true
  tellBuoy()
  call('ui.showOverlay', { name: 'panel', file: 'panel.html', bounds: anchor(state, PANEL_WIDTH, Infinity).bounds, focus: false })
    .then(() => quietly(name, { ...rest, forwarded: true, shown: true, focus }))
}
// The panel closes itself, unless a dialog in it holds it open.
const closePanel = () => quietly('toggle-sidebar', { forwarded: true })
const togglePanel = () => (panel ? closePanel() : showPanel())

// Opened as tall as the room beside the Buoy, letting every click through until the list trims itself and takes its own.
function openList() {
  if (!state) return
  list = true
  tellBuoy()
  call('ui.showOverlay', { name: 'tabs', file: 'tablist.html', bounds: anchor(state, TABLIST_WIDTH, Infinity).bounds, hit: [], float: true, focus: false })
    .then(() => quietly('tablist-open', { forwarded: true }))
}
const closeList = () => (list ? closeOverlay('tabs') : null)

// A pick from the list: with another app in front only that tab's window comes over it; with Skiff in front it joins the windows shown.
async function pickTab(id) {
  try {
    const { front } = await skiff.call('ui.inFront')
    closeList()
    await skiff.call('tabs.activate', { id })
    if (front) return await skiff.call('ui.focusPage')
    await skiff.call('ui.setDesk', { only: [id] })
    await skiff.call('ui.raise')
  } catch {}
}

function openExtensionPopup() {
  skiff.call('extensions.list').then((list) => {
    const entry = (list || []).find((e) => e.popup)
    if (!entry) return notice('No extension has a panel.')
    const { bounds, card } = anchor(state, POPUP_SIZE.width, POPUP_SIZE.height)
    return call('extensions.popup', { id: entry.id, bounds: { x: bounds.x + card.x, y: bounds.y + card.y, width: card.width, height: card.height } })
  }).catch(() => {})
}

skiff.on('desk-guides', drawGuides)
skiff.on('overlay-closed', (data) => {
  if (data?.name === 'expose') return void (exposed = false)
  if (data?.name === 'panel' ? !panel : data?.name === 'tabs' ? !list : !open) return
  if (data?.name === 'panel') panel = false
  else if (data?.name === 'tabs') list = false
  else open = ''
  tellBuoy()
})
// A panel page that loaded after it was shown missed the event that opens it.
skiff.on('panel-ready', () => { if (panel) quietly('panel-open', { forwarded: true, shown: true }) })
skiff.on('new-tab', (data) => { if (!data?.forwarded) openPalette('new') })
skiff.on('focus-address', (data) => { if (!data?.forwarded) openPalette('edit') })
skiff.on('ask-agent', (data) => { if (!data?.forwarded) openPalette('ask') })
for (const name of ['toggle-settings', 'toggle-archive', 'toggle-agents', 'import-arc']) skiff.on(name, (data) => { if (!data?.forwarded) showPanel(name, true, data) })
// Exposé covers the whole window and closes itself; while it is open it also takes this event as a close. It shows every window, so a foreground set ends first.
// The Buoy and the panel stay above it, as the Dock does over Mission Control.
const showExpose = (focus) => skiff.call('ui.showOverlay', { name: 'expose', file: 'expose.html', focus, under: 'panel' })
skiff.on('expose', async (data) => {
  if (data?.forwarded || data?.close || exposed || !state) return
  exposed = true
  closeList()
  if (open) closeOverlay()
  if (state.deskOnly) await call('ui.setDesk', { only: null })
  // A failed show must not leave every later gesture ignored as if exposé were open.
  showExpose(true).then(() => quietly('expose', { forwarded: true }), () => { exposed = false })
})
// Cmd+S: the menu's event leaves the keyboard on this page, so it goes back to the window (or stays in an open command bar).
skiff.on('toggle-sidebar', (data) => {
  if (data?.forwarded) return
  togglePanel()
  if (!open) call('ui.focusPage')
})
skiff.on('extension-popup', openExtensionPopup)
skiff.on('url-copied', () => notice('Copied URL'))
// Skiff brought forward from outside, by the Dock or the app switcher, shows the whole desk.
skiff.on('desk-activated', () => {
  everyWindow()
  closeList()
})
skiff.on('buoy', (data) => {
  if (data?.action === 'tabs') return list ? closeList() : openList()
  if (data?.action === 'pick') return pickTab(data.id)
  if (data?.action === 'list-close') return closeList()
  // Any other press on the Buoy is a click outside the tab list.
  closeList()
  if (data?.action === 'palette') openPalette(data.mode === 'edit' ? 'edit' : 'new')
  else if (data?.action === 'favorite') {
    everyWindow()
    skiff.call('tabs.activate', { id: data.id }).then(() => skiff.call('ui.raise')).catch(() => {})
  } else if (data?.action === 'panel' && panel) {
    everyWindow()
    closePanel()
  }
  // The panel lives in the desk window, so opening it from the floating Buoy brings the desk in front of other apps.
  else if (data?.action === 'panel' || data?.action === 'panel-show') {
    call('ui.raise')
    showPanel()
  }
})
skiff.on('state', (next) => { state = next })
// A reload hides every overlay without telling it, and the page keeps the keyboard.
call('ui.setDesk', { hit: [], capture: false, preview: null, only: null })
closeOverlay().then(() => call('ui.focusPage'))
skiff.call('state.get').then((first) => {
  state = first
  showBuoy()
  showPanel()
  // Loaded now, while nothing shows in it, so the first exposé does not wait for its page.
  if (!exposed) showExpose(false).then(() => { if (!exposed) call('ui.hideOverlay', { name: 'expose' }) }, () => {})
}).catch(() => {})

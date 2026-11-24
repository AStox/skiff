'use strict'

// The base page lies under every window: it draws the snapping guides and zone previews, opens the overlays and owns the app's events.
const $ = (id) => document.getElementById(id)
const deskEl = $('desk')

let state = null
// Set while exposé is open.
let exposed = false
// The tab list floats in its own overlay, 'tabs', above other apps; the count in the Buoy toggles it.
let list = false

const call = (method, params) => skiff.call(method, params).catch(() => {})
const quietly = (name, data) => call('ui.emit', { name, data, focus: false })
const tellBuoy = () => quietly('buoy-state', { list })
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

// The Buoy page draws the pill and the command bar's card; this window only has to be there and as big as the desk.
function showBuoy() {
  if (!state) return
  const { width, height } = deskSize(state)
  call('ui.showOverlay', { name: 'buoy', file: 'buoy.html', bounds: { x: 0, y: 0, width, height }, hit: [buoyRect(state)], float: true, focus: false }).then(tellBuoy)
}

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
  if (data?.name !== 'tabs' || !list) return
  list = false
  tellBuoy()
})
// Exposé covers the whole window and closes itself; while it is open it also takes this event as a close. It shows every window, so a foreground set ends first.
// The Buoy stays above it, as the Dock does over Mission Control.
const showExpose = (focus) => skiff.call('ui.showOverlay', { name: 'expose', file: 'expose.html', focus })
async function openExposeOverlay(pulled) {
  exposed = true
  closeList()
  if (state.deskOnly) await call('ui.setDesk', { only: null })
  // A failed show must not leave every later gesture ignored as if exposé were open. A swipe still pulling tells exposé how far it has gone.
  showExpose(true).then(() => quietly('expose', { forwarded: true, pull: pulled?.travel }), () => { exposed = false })
}
skiff.on('expose', (data) => {
  if (data?.forwarded || data?.close || exposed || !state) return
  openExposeOverlay(null)
})
// A swipe up opens the overlay at PEEK px of travel and exposé follows the rest of the swipe itself; with reduced motion it opens at COMMIT.
let pull = { last: -Infinity, travel: 0, asked: false }
skiff.on('expose-pull', (data) => {
  const now = performance.now()
  if (now - pull.last >= SWIPE_GAP) pull = { last: now, travel: 0, asked: false }
  pull.last = now
  pull.travel = Math.max(0, pull.travel + (data?.dy || 0))
  if (exposed || pull.asked || !state || pull.travel < (matchMedia('(prefers-reduced-motion: reduce)').matches ? COMMIT : PEEK)) return
  pull.asked = true
  openExposeOverlay(pull)
})
skiff.on('extension-popup', openExtensionPopup)
skiff.on('url-copied', () => notice('Copied URL'))
// Skiff brought forward from outside, by the Dock or the app switcher, shows the whole desk.
// A press on a page, a frame or the desk, or another app taking over: the tab list closes, the Buoy card does not.
skiff.on('desk-press', closeList)
skiff.on('desk-activated', () => {
  everyWindow()
  closeList()
})
skiff.on('buoy', (data) => {
  if (data?.action === 'tabs') return list ? closeList() : openList()
  if (data?.action === 'pick') return pickTab(data.id)
  if (data?.action === 'list-close') return closeList()
  // Any other press on the Buoy, or the card opening, is a click outside the tab list.
  closeList()
  if (data?.action === 'favorite') {
    everyWindow()
    skiff.call('tabs.activate', { id: data.id }).then(() => skiff.call('ui.raise')).catch(() => {})
  }
})
skiff.on('state', (next) => { state = next })
// A reload hides every overlay without telling it, and the page keeps the keyboard.
call('ui.setDesk', { hit: [], capture: false, preview: null, only: null })
closeOverlay().then(() => call('ui.focusPage'))
skiff.call('state.get').then((first) => {
  state = first
  showBuoy()
  // Loaded now, while nothing shows in it, so the first exposé does not wait for its page.
  if (!exposed) showExpose(false).then(() => { if (!exposed) call('ui.hideOverlay', { name: 'expose' }) }, () => {})
}).catch(() => {})

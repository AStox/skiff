'use strict'

// The Buoy: the space, its favorites, its tab count and a new tab, in its own small floating window that it moves itself, above other apps.
const $ = (id) => document.getElementById(id)
const pill = $('buoy')
// Within this distance of a desk edge (or the centre line) the Buoy snaps to it.
const PULL = 24
// The favorites fill the pill up to this share of the desk width; the rest go behind a +N.
const FAVORITES_SHARE = 0.6

let state = null
let place = readStore('buoy')
let panel = false
let list = false
let hiding = false
let noticeText = ''
let noticeTimer
let press = null
let shownAt = ''
let favoritesKey = ''

function render() {
  if (!state) return
  const space = paintSpace(state)
  const n = state.tabs.filter((t) => t.spaceId === space.id && isPlain(t)).length
  const note = hiding ? 'Drop to hide' : noticeText
  const agentTabs = state.agentTabs || []
  const agents = new Set(agentTabs.map((t) => t.agent)).size
  const chip = agentTabs.length ? `${agents} ${agents === 1 ? 'agent' : 'agents'} · ${tabCount(agentTabs.length)}` : ''
  $('buoy-name').textContent = space.name
  $('buoy-notice').textContent = note
  $('buoy-notice').hidden = !note
  $('buoy-agents').textContent = chip
  $('buoy-agents').hidden = !chip
  $('buoy-main').setAttribute('aria-label', `${space.name}${chip && `, ${chip}`}. Show or hide the panel`)
  $('buoy-main').setAttribute('aria-expanded', String(panel))
  $('buoy-tabs').textContent = String(n)
  $('buoy-tabs').setAttribute('aria-label', tabCount(n))
  $('buoy-tabs').title = `${tabCount(n)}. Show the active tabs`
  $('buoy-tabs').setAttribute('aria-expanded', String(list))
  const update = state.update?.status === 'ready' ? `Restart to update to Skiff ${state.update.version}` : ''
  $('update-pill').hidden = !update
  $('update-pill').title = update
  $('update-pill').setAttribute('aria-label', update)
  pill.classList.toggle('drop', hiding)
  renderFavorites()
  fit()
}

// The space's favorites in the panel's order, the active one ringed; a click brings its window forward.
function renderFavorites() {
  const favorites = state.tabs.filter((t) => t.favorite && t.spaceId === state.activeSpaceId)
  const active = state.activeTabBySpace[state.activeSpaceId]
  const limit = Math.floor(deskSize(state).width * FAVORITES_SHARE)
  const key = JSON.stringify([favorites.map((t) => [t.id, t.title, t.url, t.favicon]), active, limit, $('buoy-agents').textContent])
  if (key === favoritesKey) return
  favoritesKey = key
  const box = $('buoy-favs')
  const button = (tab) => h('button', {
    class: `buoy-fav${tab.id === active ? ' current' : ''}`, type: 'button', 'data-tab-id': tab.id, title: tab.title || tab.url, 'aria-label': tab.title || tab.url, 'aria-current': tab.id === active ? 'true' : null,
    onclick: () => { if (!press?.moved) buoyAction('favorite', { id: tab.id }) }
  }, favicon(tab))
  const more = (n) => h('button', { id: 'buoy-more', class: 'buoy-fav', type: 'button', title: `${n} more in the panel`, 'aria-label': `${n} more favorites. Show the panel`, onclick: () => { if (!press?.moved) buoyAction('panel-show') } }, `+${n}`)
  const draw = (shown) => box.replaceChildren(...favorites.slice(0, shown).map(button), shown < favorites.length ? more(favorites.length - shown) : '')
  box.hidden = !favorites.length
  let shown = favorites.length
  draw(shown)
  while (shown > 0 && pill.offsetWidth > limit) draw(--shown)
}

// Remembered against the nearest sides, so a smaller desk keeps the Buoy in its corner.
function placeAt(x, y, width) {
  const { width: W, height: H } = deskSize(state)
  const centred = Math.abs(x - (W - width) / 2) < 1
  return {
    ax: centred ? 'c' : x + width / 2 < W / 2 ? 'l' : 'r', x: centred ? 0 : x + width / 2 < W / 2 ? x : W - x - width,
    ay: y + BUOY_HEIGHT / 2 < H / 2 ? 't' : 'b', y: y + BUOY_HEIGHT / 2 < H / 2 ? y : H - y - BUOY_HEIGHT, width
  }
}

// The window is the pill plus room for its shadow; only the pill takes clicks, so what lies around it stays clickable.
function fit() {
  const width = Math.ceil(pill.offsetWidth)
  if (!place) place = { ax: 'l', x: 12, ay: 'b', y: GAP, width }
  if (place.width !== width) {
    place = { ...place, width }
    if (!press?.moved) writeStore('buoy', place)
  }
  const r = buoyRect(state, place)
  const { width: W, height: H } = deskSize(state)
  const x0 = Math.max(0, r.x - BUOY_ROOM)
  const y0 = Math.max(0, r.y - BUOY_ROOM)
  const bounds = { x: x0, y: y0, width: Math.min(W, r.x + r.width + BUOY_ROOM) - x0, height: Math.min(H, r.y + r.height + BUOY_ROOM) - y0 }
  Object.assign(pill.style, { left: `${r.x - x0}px`, top: `${r.y - y0}px` })
  const key = JSON.stringify(bounds)
  if (key === shownAt) return
  shownAt = key
  const hit = [{ x: r.x - x0, y: r.y - y0, width: r.width, height: r.height }]
  skiff.call('ui.showOverlay', { name: 'buoy', file: 'buoy.html', bounds, hit, float: true, focus: false }).catch(() => {})
  // The frames move their ears out from under it.
  skiff.call('ui.emit', { name: 'buoy-moved', data: place, focus: false }).catch(() => {})
}

function notice(text) {
  noticeText = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeText = ''
    render()
  }, 1500)
  render()
}

/* ---------- dragging: the window moves under the pointer, so only screen positions count ---------- */

pill.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state) return
  press = { id: e.pointerId, p0: { x: e.screenX, y: e.screenY }, r0: buoyRect(state, place), moved: false }
})
// On the document, since the first move past the threshold can already be off the pill.
document.addEventListener('pointermove', (e) => {
  if (press?.id !== e.pointerId) return
  const dx = e.screenX - press.p0.x
  const dy = e.screenY - press.p0.y
  if (!press.moved) {
    if (Math.hypot(dx, dy) < 4) return
    press.moved = true
    pill.setPointerCapture(e.pointerId)
    document.documentElement.classList.add('dragging')
    skiff.call('ui.setDesk', { capture: true }).catch(() => {})
  }
  const { width: W, height: H } = deskSize(state)
  const { width } = press.r0
  const pull = (v, targets) => targets.reduce((best, t) => (Math.abs(t - v) < Math.abs(best - v) ? t : best))
  let x = press.r0.x + dx
  let y = press.r0.y + dy
  const sx = pull(x, [GAP, (W - width) / 2, W - GAP - width])
  const sy = pull(y, [GAP, H - GAP - BUOY_HEIGHT])
  if (Math.abs(sx - x) <= PULL) x = sx
  if (Math.abs(sy - y) <= PULL) y = sy
  place = placeAt(clamp(x, GAP, W - GAP - width), clamp(y, GAP, H - GAP - BUOY_HEIGHT), width)
  fit()
})
function release(e) {
  if (press?.id !== e.pointerId) return
  const moved = press.moved
  if (moved) {
    document.documentElement.classList.remove('dragging')
    writeStore('buoy', place)
    skiff.call('ui.setDesk', { capture: false }).catch(() => {})
    // The click that follows a drag must not also toggle the panel or pick a favorite.
    setTimeout(() => { press = null })
  } else setTimeout(() => { press = null })
}
document.addEventListener('pointerup', release)
document.addEventListener('pointercancel', release)

$('buoy-main').addEventListener('click', () => { if (!press?.moved) buoyAction('panel') })
$('buoy-tabs').addEventListener('click', () => { if (!press?.moved) buoyAction('tabs') })
$('update-pill').addEventListener('click', () => { if (!press?.moved) skiff.call('updates.install').catch((error) => notice(error.message || 'Update failed')) })
$('buoy-new').addEventListener('click', () => { if (!press?.moved) buoyAction('palette', { mode: 'new' }) })
appearance.addEventListener('change', render)

const swipe = spaceSwiper(true)
pill.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (e.ctrlKey) return
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pill.clientWidth : 1
  const delta = swipe.step(e.timeStamp, e.deltaX * unit, e.deltaY * unit)
  if (!delta) return
  const main = $('buoy-main')
  main.classList.remove('swipe-next', 'swipe-prev')
  void main.offsetWidth
  main.classList.add(delta > 0 ? 'swipe-next' : 'swipe-prev')
}, { passive: false })
$('buoy-main').addEventListener('animationend', (e) => e.currentTarget.classList.remove('swipe-next', 'swipe-prev'))
new ResizeObserver(() => { if (state) fit() }).observe(pill)

skiff.on('buoy-state', (data) => {
  panel = Boolean(data?.panel)
  list = Boolean(data?.list)
  render()
})
skiff.on('buoy-notice', (data) => { if (data?.text) notice(String(data.text)) })
// A window dragged over the Buoy is hidden when it is let go there.
skiff.on('desk-guides', (data) => {
  if (Boolean(data?.overBuoy) === hiding) return
  hiding = Boolean(data?.overBuoy)
  render()
})
skiff.on('state', (next) => {
  state = next
  render()
})
skiff.call('state.get').then((first) => {
  state ||= first
  render()
}).catch(() => { $('buoy-name').textContent = 'Skiff' })

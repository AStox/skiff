'use strict'

// The Buoy: the space, its favorites, its tab count and a new tab, drawn in a floating window as big as the desk that it moves itself, above other apps.
// Open, the pill itself grows into the command bar's card in the middle of the desk and shrinks back when it closes.
const $ = (id) => document.getElementById(id)
const pill = $('buoy')
const row = $('buoy-row')
const card = $('card')
const bar = $('palette-input')
// Within this distance of a desk edge (or the centre line) the Buoy snaps to it.
const PULL = 24
// The favorites fill the pill up to this share of the desk width; the rest go behind a +N.
const FAVORITES_SHARE = 0.6
const CARD_WIDTH = 560
const AGENTS_WIDTH = 300
const AGENTS_MAX = 360
// The card keeps this far from the desk's edges.
const CARD_MARGIN = 40
// The pill's growth and its way back; the card's content fades in over the last part and out over the first.
const MORPH = 280
const reduced = matchMedia('(prefers-reduced-motion: reduce)')

let state = null
let place = readStore('buoy')
let list = false
let open = false
// The agent tabs' list, grown from its chip, and where it lies in desk pixels while it is open.
let agentsOpen = false
let agentsAt = null
// Where the card lies while it is open, in desk pixels; its height follows its content.
let at = null
// Set from the first frame of the card's way back until the pill is home.
let closing = false
let settling
let fade
let blurred
let focusedAt = 0
let hiding = false
let noticeText = ''
let noticeTimer
let press = null
let favoritesKey = ''

function renderPill() {
  if (!state) return
  const space = paintSpace(state)
  const n = state.tabs.filter((t) => t.spaceId === space.id && isPlain(t)).length
  const note = hiding ? 'Drop to hide' : noticeText
  const going = state.tabs.filter((t) => t.agent && t.agentState !== 'done')
  const listed = state.tabs.filter((t) => t.agentRequest || (t.agent && (t.agentState !== 'done' || t.agentUnseen)))
  const chip = agentChip(going, listed)
  const unseen = state.tabs.some((t) => t.agentUnseen || t.agentRequest)
  if (agentsOpen && !listed.length) agentsOpen = false
  const unread = state.tabs.filter((t) => t.bucket === 'unread').length
  $('buoy-name').textContent = space.name
  $('buoy-unread').textContent = String(unread)
  $('buoy-unread').hidden = !unread
  $('buoy-notice').textContent = note
  $('buoy-notice').hidden = !note
  $('buoy-agents').textContent = chip
  $('buoy-agents').hidden = !chip
  $('buoy-agents').title = `${chip}. Show the agent tabs`
  $('buoy-agents').setAttribute('aria-label', `${chip}. Show the agent tabs`)
  $('buoy-agents').setAttribute('aria-expanded', String(agentsOpen))
  $('buoy-unseen').hidden = !unseen
  renderAgents(listed)
  $('buoy-main').setAttribute('aria-label', `${space.name}${unread ? `, ${unread} unread` : ''}${chip && `, ${chip}`}${unseen ? ', an agent tab is ready to see' : ''}. Open the command bar`)
  $('buoy-main').setAttribute('aria-expanded', String(open))
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

// Names of the agents at work when they fit the pill, else their count; with none at work, those waiting, then those asking for a tab, then those whose finished tabs wait to be seen.
function agentChip(going, listed) {
  const working = going.filter((t) => t.agentState === 'working')
  const asking = listed.filter((t) => t.agentRequest)
  const [tabs, verb] = working.length ? [working, 'working'] : going.length ? [going, 'idle'] : asking.length ? [asking, 'asking'] : [listed, 'done']
  const names = [...new Set(tabs.map((t) => t.agentRequest?.agent || t.agent))]
  const text = names.join(', ')
  return !names.length ? '' : `${text.length <= 16 ? text : `${names.length} ${names.length === 1 ? 'agent' : 'agents'}`} ${verb}`
}

function agentRow(tab) {
  const asking = tab.agentRequest
  return h('li', { class: 'row buoy-agent', 'data-tab-id': tab.id },
    h('button', { class: 'row-main', type: 'button', title: tab.url, onclick: () => pickAgent(tab) },
      agentDot(tab), h('span', { class: 'label' }, tab.title || tab.url), h('span', { class: 'when' }, asking ? `${asking.agent} asks` : tab.agent)))
}

// The base page activates it, as for the tab list, since it knows whether another app is in front.
function pickAgent(tab) {
  closeAgents()
  buoyAction('pick', { id: tab.id })
}

let agentsKey = ''
function renderAgents(listed) {
  const box = $('buoy-agents-list')
  box.hidden = !agentsOpen
  if (!agentsOpen) return
  const key = JSON.stringify(listed.map((t) => [t.id, t.title, t.url, t.agent, t.agentState, t.agentRequest?.agent]))
  if (key === agentsKey) return
  agentsKey = key
  box.replaceChildren(...listed.map(agentRow))
}

// Under the chip, or above it with the pill in the lower half; only the list takes clicks beside the pill.
function placeAgents() {
  const box = $('buoy-agents-list')
  if (!agentsOpen) return void (agentsAt = null)
  const { width: W, height: H } = deskSize(state)
  const b = buoyRect(state, place)
  const below = b.y + b.height / 2 < H / 2
  const room = below ? H - b.y - b.height - 2 * GAP : b.y - 2 * GAP
  const width = Math.min(AGENTS_WIDTH, W - 2 * GAP)
  box.style.maxHeight = `${Math.min(AGENTS_MAX, room)}px`
  const height = box.offsetHeight
  const chip = $('buoy-agents').getBoundingClientRect()
  agentsAt = { x: Math.round(clamp(chip.x, GAP, W - GAP - width)), y: below ? b.y + b.height + GAP : b.y - GAP - height, width, height }
  Object.assign(box.style, { left: `${agentsAt.x}px`, top: `${agentsAt.y}px`, width: `${width}px` })
}

function openAgents() {
  if (open || !state || $('buoy-agents').hidden) return
  agentsOpen = true
  agentsKey = ''
  buoyAction('agents')
  renderPill()
}
function closeAgents() {
  if (!agentsOpen) return
  agentsOpen = false
  renderPill()
}

// The space's favorites in the panel's order, the active one ringed; a click brings its window forward.
function renderFavorites() {
  const favorites = state.tabs.filter((t) => t.favorite && t.spaceId === state.activeSpaceId)
  const active = state.activeTabBySpace[state.activeSpaceId]
  const limit = Math.floor(deskSize(state).width * FAVORITES_SHARE)
  const key = JSON.stringify([favorites.map((t) => [t.id, t.title, t.url, t.favicon, Boolean(t.protections?.audible)]), active, limit, $('buoy-agents').textContent])
  if (key === favoritesKey) return
  favoritesKey = key
  const box = $('buoy-favs')
  const button = (tab) => h('button', {
    class: `buoy-fav${tab.id === active ? ' current' : ''}`, type: 'button', 'data-tab-id': tab.id, title: tab.title || tab.url, 'aria-label': tab.title || tab.url, 'aria-current': tab.id === active ? 'true' : null,
    onclick: () => { if (!press?.moved) buoyAction('favorite', { id: tab.id }) }
  }, favicon(tab), speaker(tab))
  const more = (n) => h('button', { id: 'buoy-more', class: 'buoy-fav', type: 'button', title: `${n} more in the command bar`, 'aria-label': `${n} more favorites. Open the command bar`, onclick: () => { if (!press?.moved) openCard('new') } }, `+${n}`)
  const draw = (shown) => box.replaceChildren(...favorites.slice(0, shown).map(button), shown < favorites.length ? more(favorites.length - shown) : '')
  box.hidden = !favorites.length
  let shown = favorites.length
  draw(shown)
  while (shown > 0 && row.offsetWidth > limit) draw(--shown)
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

// The window covers the desk and only the pill, or the open card, takes clicks, so what lies around it stays clickable.
let shownAt = ''
let movedAt = ''
function fit() {
  const width = Math.ceil(row.offsetWidth)
  if (!place) place = { ax: 'l', x: 12, ay: 'b', y: GAP, width }
  if (place.width !== width) {
    place = { ...place, width }
    if (!press?.moved) writeStore('buoy', place)
  }
  const r = buoyRect(state, place)
  if (!open && !closing) Object.assign(pill.style, { left: `${r.x}px`, top: `${r.y}px` })
  placeAgents()
  sync(r)
}

const cardRect = () => ({ x: at.x, y: at.y, width: at.width, height: card.offsetHeight })
// New windows are placed clear of the open card.
let avoided = ''
function syncAvoid() {
  const avoid = open && at ? cardRect() : null
  const key = JSON.stringify(avoid)
  if (key === avoided) return
  avoided = key
  skiff.call('ui.setDesk', { avoid }).catch(() => {})
}
function sync(r = buoyRect(state, place)) {
  const { width, height } = deskSize(state)
  syncAvoid()
  // The import dialog is modal over the whole desk.
  const hit = [open ? (importer ? { x: 0, y: 0, width, height } : cardRect()) : r]
  if (agentsAt && !open) hit.push(agentsAt)
  const key = JSON.stringify([width, height, hit])
  if (key !== shownAt) {
    shownAt = key
    skiff.call('ui.showOverlay', { name: 'buoy', file: 'buoy.html', bounds: { x: 0, y: 0, width, height }, hit, float: true, focus: false }).catch(() => {})
  }
  const moved = JSON.stringify(r)
  if (moved === movedAt) return
  movedAt = moved
  // The frames move their ears out from under it.
  skiff.call('ui.emit', { name: 'buoy-moved', data: place, focus: false }).catch(() => {})
}

function notice(text) {
  noticeText = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeText = ''
    renderPill()
  }, 1500)
  renderPill()
}

/* ---------- dragging: the window moves under the pointer, so only screen positions count ---------- */

row.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state) return
  press = { id: e.pointerId, p0: { x: e.screenX, y: e.screenY }, r0: buoyRect(state, place), moved: false }
})
// On the document, since the first move past the threshold can already be off the pill.
document.addEventListener('pointermove', (e) => {
  if (open || press?.id !== e.pointerId) return
  const dx = e.screenX - press.p0.x
  const dy = e.screenY - press.p0.y
  if (!press.moved) {
    if (Math.hypot(dx, dy) < 4) return
    press.moved = true
    closeAgents()
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
    // The click that follows a drag must not also open the card or pick a favorite.
    setTimeout(() => { press = null })
  } else setTimeout(() => { press = null })
}
document.addEventListener('pointerup', release)
document.addEventListener('pointercancel', release)

$('buoy-main').addEventListener('click', () => { if (!press?.moved) openCard('new') })
$('buoy-agents').addEventListener('click', () => { if (!press?.moved) return agentsOpen ? closeAgents() : openAgents() })
$('buoy-tabs').addEventListener('click', () => { if (!press?.moved) buoyAction('tabs') })
$('update-pill').addEventListener('click', () => { if (!press?.moved) skiff.call('updates.install').catch((error) => notice(error.message || 'Update failed')) })
$('buoy-new').addEventListener('click', () => { if (!press?.moved) openCard('new') })
appearance.addEventListener('change', renderPill)

const swipe = spaceSwiper(true)
row.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (e.ctrlKey) return
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? row.clientWidth : 1
  const delta = swipe.step(e.timeStamp, e.deltaX * unit, e.deltaY * unit)
  if (!delta) return
  const main = $('buoy-main')
  main.classList.remove('swipe-next', 'swipe-prev')
  void main.offsetWidth
  main.classList.add(delta > 0 ? 'swipe-next' : 'swipe-prev')
}, { passive: false })
$('buoy-main').addEventListener('animationend', (e) => e.currentTarget.classList.remove('swipe-next', 'swipe-prev'))
new ResizeObserver(() => { if (state && !open) fit() }).observe(row)
// The card's height follows its content, and so does the area that takes clicks.
// A card that grew past the desk's bottom moves up rather than off it.
function keepOnDesk() {
  const y = Math.max(CARD_MARGIN, Math.min(at.y, deskSize(state).height - CARD_MARGIN - card.offsetHeight))
  if (y === at.y) return
  at.y = y
  pill.style.top = `${y}px`
}
new ResizeObserver(() => {
  if (!open || settling) return
  keepOnDesk()
  sync()
}).observe(card)

/* ---------- the card: the pill grown into the command bar and the panel's content, in the middle of the desk ---------- */

// Offsets of an element from the pill's corner, which the card shares while it is laid out.
const corner = (el) => {
  const a = el.getBoundingClientRect()
  const b = pill.getBoundingClientRect()
  return { left: `${a.x - b.x}px`, top: `${a.y - b.y}px` }
}

// A caller from another app puts Skiff in front first, as the panel did; the card then takes the keyboard.
async function grab() {
  try {
    const { front } = await skiff.call('ui.inFront')
    if (!front) await skiff.call('ui.raise')
    if (open) await skiff.call('ui.showOverlay', { name: 'buoy', file: 'buoy.html', bounds: { x: 0, y: 0, ...deskSize(state) }, hit: [importer ? { x: 0, y: 0, ...deskSize(state) } : cardRect()], float: true, focus: true })
  } catch {}
}

function openCard(mode = 'new') {
  if (open) return
  closeAgents()
  // A page that has just loaded has not heard the state yet.
  if (!state) return void skiff.call('state.get').then((first) => { state ||= first; openCard(mode) }, () => {})
  open = true
  closing = false
  clearTimeout(settling)
  settling = null
  fade?.cancel()
  buoyAction('card')
  // The whole desk comes back with the card.
  if (state.deskOnly) skiff.call('ui.setDesk', { only: null }).catch(() => {})
  resetPanel()
  const { width: W, height: H } = deskSize(state)
  const width = Math.min(CARD_WIDTH, W - 2 * GAP)
  document.documentElement.style.setProperty('--card-width', `${width}px`)
  document.documentElement.style.setProperty('--card-max', `${H - 2 * CARD_MARGIN}px`)
  openBar(mode)
  const height = card.offsetHeight
  at = { x: Math.round((W - width) / 2), y: Math.round((H - height) / 2), width }
  syncAvoid()
  const from = pill.getBoundingClientRect()
  const dot = corner(card.querySelector('.palette-field .space-dot'))
  renderPill()
  grab()
  if (reduced.matches) {
    Object.assign(pill.style, { left: `${at.x}px`, top: `${at.y}px`, width: '', height: '' })
    pill.classList.add('open')
    bar.focus()
    Object.assign($('buoy-dot').style, dot)
    fade = pill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 })
    return
  }
  pill.classList.add('morphing')
  Object.assign(pill.style, { width: `${from.width}px`, height: `${from.height}px` })
  void pill.offsetWidth
  pill.classList.add('open')
  bar.focus()
  Object.assign(pill.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${width}px`, height: `${height}px` })
  Object.assign($('buoy-dot').style, dot)
  settling = setTimeout(() => {
    settling = null
    pill.classList.remove('morphing')
    Object.assign(pill.style, { width: '', height: '' })
    keepOnDesk()
    sync()
  }, MORPH + 30)
}

// back: the card closes with the keyboard going back to the desk; a blur has lost it to another app, which stays in front.
function closeCard(back = true) {
  if (!open) return
  open = false
  syncAvoid()
  closing = true
  clearTimeout(settling)
  settling = null
  bar.blur()
  const r = buoyRect(state, place)
  const done = () => {
    closing = false
    pill.classList.remove('morphing', 'open')
    Object.assign(pill.style, { left: `${r.x}px`, top: `${r.y}px`, width: '', height: '' })
    $('buoy-dot').removeAttribute('style')
  }
  if (reduced.matches) {
    fade = pill.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90 })
    fade.onfinish = () => {
      done()
      fade = pill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110 })
    }
  } else {
    Object.assign(pill.style, { width: `${pill.offsetWidth}px`, height: `${pill.offsetHeight}px` })
    pill.classList.add('morphing')
    void pill.offsetWidth
    pill.classList.remove('open')
    Object.assign(pill.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
    $('buoy-dot').removeAttribute('style')
    settling = setTimeout(() => {
      settling = null
      done()
    }, MORPH + 30)
  }
  renderPill()
  sync(r)
  skiff.call(back ? 'ui.raise' : 'ui.focusPage').catch(() => {})
}

// Cmd+T, Cmd+S and the pill itself open and close the card; the other keys open it in their own mode, or move a card that is open to it.
const toggle = () => (open ? closeCard() : openCard('new'))
function reveal(mode) {
  if (!open) return openCard(mode)
  grab()
  if (mode === 'ask') return ask.on ? bar.focus() : enterAsk()
  openBar(mode)
}
skiff.on('new-tab', toggle)
skiff.on('toggle-sidebar', toggle)
skiff.on('focus-address', () => reveal('edit'))
skiff.on('ask-agent', () => reveal('ask'))
// Exposé and the tab list take over the desk.
skiff.on('expose', (data) => {
  if (data?.forwarded || data?.close) return
  closeCard(false)
  closeAgents()
})
// Anywhere else a press or the keyboard going elsewhere closes it; the keyboard coming back within a moment is not leaving.
document.addEventListener('pointerdown', (e) => {
  if (open && !e.target.closest('#buoy')) closeCard()
  if (agentsOpen && !e.target.closest('#buoy-agents, #buoy-agents-list')) closeAgents()
})
document.addEventListener('keydown', (e) => { if (agentsOpen && e.key === 'Escape') closeAgents() })
addEventListener('focus', () => { focusedAt = performance.now() })
addEventListener('blur', () => {
  const lost = performance.now()
  clearTimeout(blurred)
  blurred = setTimeout(() => {
    if (open && focusedAt < lost) closeCard(false)
    if (agentsOpen && focusedAt < lost) closeAgents()
  }, 80)
})

skiff.on('buoy-state', (data) => {
  list = Boolean(data?.list)
  renderPill()
})
skiff.on('buoy-notice', (data) => { if (data?.text) notice(String(data.text)) })
// A window dragged over the Buoy is hidden when it is let go there.
skiff.on('desk-guides', (data) => {
  if (Boolean(data?.overBuoy) === hiding) return
  hiding = Boolean(data?.overBuoy)
  renderPill()
})
skiff.on('state', (next) => {
  state = next
  renderPill()
  if (open) renderPanel()
})
skiff.call('state.get').then((first) => {
  state ||= first
  renderPill()
}).catch(() => {
  $('buoy-name').textContent = 'Skiff'
  showError('Skiff could not load your spaces. Reload the shell or restart Skiff to try again.')
})

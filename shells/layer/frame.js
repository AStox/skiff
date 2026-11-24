'use strict'

// One per desk window, lying right under its page: the ear, the border ring, the shadow and the resize handles.
const $ = (id) => document.getElementById(id)
const id = new URLSearchParams(location.search).get('tab')
// The insets shell.json gives this view around its page; the ear stands in the top one.
const IN = { top: 30, right: 12, bottom: 12, left: 12 }
// Windows snap and tile as their page plus the ear above it.
const EAR = 26
const MAGNET = 8
const EDGE = 18
const CORNER = 90
const MIN = { w: 340, h: 200 }
// A pinch commits once the wheel stream has been quiet this long.
const PINCH_SETTLE = 150

let state = null
let gesture = null
let pinch = null
let painted = ''
// Another window mid-drag or resize, as it last said where it is.
let moving = null
// This window's ear, relative to its page: {dx, width, room} or null when nothing of its top edge shows.
let ear = null
// Every window's ear on the desk, and the windows behind this one, for a press that lands on an ear seen through this frame.
let slots = {}
let behind = []
// Wide enough for the hide and close buttons beside the favicon.
const EAR_BUTTONS = 74

const call = (method, params) => skiff.call(method, params).catch(() => {})
const mine = () => state && deskWindows(state).find((w) => w.tab.id === id)
const frameOf = (p) => ({ x: p.x, y: p.y - EAR, w: p.width, h: p.height + EAR })
const pageOf = (f) => ({ x: Math.round(f.x), y: Math.round(f.y + EAR), width: Math.round(f.w), height: Math.round(f.h - EAR) })
const desk = () => { const { width, height } = deskSize(state); return { x: 0, y: 0, w: width, h: height } }
const root = document.documentElement
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 2)

function render() {
  const w = mine()
  const tab = w?.tab || state?.tabs.find((t) => t.id === id)
  if (!tab) return
  paintSpace(state)
  document.documentElement.classList.toggle('active', Boolean(w?.active))
  const title = earTitle(tab)
  const key = JSON.stringify([title, tab.favicon, tab.url, tab.agent, tab.agentState])
  if (key !== painted) {
    painted = key
    $('ear').title = hostOf(tab.url) || title
    $('ear').setAttribute('aria-label', title)
    $('ear-fav').replaceChildren(...[favicon(tab), agentDot(tab)].filter(Boolean))
    $('ear-title').textContent = title
    $('ear-hide').setAttribute('aria-label', `Hide ${title}`)
    $('ear-close').setAttribute('aria-label', `Close ${title}`)
  }
  drawOffer()
  placeEar()
}

/* ---------- the ear: as far left on the top edge as it can be and still be seen ---------- */

// Every frame works out every ear from the same state, so they agree without talking.
function placeEar() {
  // A window being moved keeps its ear where it was on it.
  if (!state || gesture?.kind === 'move') return
  const list = deskWindows(state)
  const me = list.findIndex((w) => w.tab.id === id)
  if (me < 0) return
  const wins = list.map((w) => {
    const own = w.tab.id === id && (gesture?.rect || pinch?.rect)
    const live = own || (moving?.id === w.tab.id && moving)
    const rect = live ? { x: live.x, y: live.y, width: live.width, height: live.height } : w.rect
    const entry = { id: w.tab.id, rect, natural: earNatural(earTitle(w.tab)), after: offerReserve(w.tab) }
    if (!own && live && 'ear' in live) entry.slot = live.ear && { x: rect.x + live.ear.dx, width: live.ear.width, room: live.ear.room }
    return entry
  })
  slots = earLayout(wins, [buoyRect(state)], deskSize(state).width)
  behind = wins.slice(0, me).reverse()
  const r = wins[me].rect
  const s = slots[id]
  ear = s && { dx: s.x - r.x, width: s.width, room: s.room }
  root.classList.toggle('earless', !ear)
  if (!ear) return
  const el = $('ear')
  Object.assign(el.style, { left: `${IN.left + ear.dx}px`, width: `${ear.width}px` })
  el.style.setProperty('--ear-room', `${Math.min(EAR_MAX, ear.room)}px`)
  el.classList.toggle('narrow', ear.width < wins[me].natural && ear.width < EAR_MIN + 24)
  el.classList.toggle('cramped', ear.room < EAR_BUTTONS)
  // The first place is taken at once; later ones glide.
  if (!root.classList.contains('settled')) requestAnimationFrame(() => root.classList.add('settled'))
  placeOffer()
}

// The window whose ear lies under a press on this frame's clear parts, frontmost first.
function earUnder(e) {
  const r = gesture?.rect || pinch?.rect || mine()?.rect
  if (!r) return null
  const x = r.x - IN.left + e.clientX
  const y = r.y - IN.top + e.clientY
  const w = behind.find((b) => slots[b.id] && x >= slots[b.id].x && x < slots[b.id].x + slots[b.id].width && y >= b.rect.y - EAR_HEIGHT && y < b.rect.y)
  return w?.id || null
}

/* ---------- the offer: do the other thing with what the bar was given, for a few seconds beside the ear ---------- */

// Hovering holds it: offerPaused is the time held so far, offerHeld when the pointer went onto it (0 when off).
let offerKey = ''
let offerPaused = 0
let offerHeld = 0
let offerDismissed = false
let offerTimer = 0
let reserveTimer = 0
const offerWidths = new Map()
const textWidth = (text) => {
  const measure = $('ear-measure')
  measure.textContent = text
  return Math.ceil(measure.getBoundingClientRect().width)
}

// Room the other ears leave beside this tab's, from the clock alone so every frame agrees, whether or not it was dismissed here.
function offerReserve(tab) {
  const label = offerLabel(state, tab)
  if (!label || offerLeft(tab) <= 0) return 0
  let width = offerWidths.get(label)
  if (width === undefined) offerWidths.set(label, width = textWidth(label) + 31)
  return width + 6
}

// Every frame re-places its ear when any pill's time runs out.
function reserveEnds() {
  clearTimeout(reserveTimer)
  const ends = state.tabs.filter((t) => t.intent).map((t) => offerLeft(t)).filter((ms) => ms > 0)
  if (ends.length) reserveTimer = setTimeout(placeEar, Math.min(...ends) + 30)
}

function drawOffer() {
  clearTimeout(offerTimer)
  const tab = state.tabs.find((t) => t.id === id)
  const key = tab?.intent ? `${tab.id}/${tab.intent.at}` : ''
  if (key !== offerKey) {
    offerKey = key
    offerPaused = offerHeld = 0
    offerDismissed = false
  }
  reserveEnds()
  const el = $('offer')
  const label = key && !offerDismissed ? offerLabel(state, tab) : null
  const left = label ? offerLeft(tab, offerPaused + (offerHeld ? Date.now() - offerHeld : 0)) : 0
  if (!label || left <= 0) {
    el.hidden = true
    return
  }
  if (el.hidden) {
    el.hidden = false
    el.classList.add('fresh')
  }
  if ($('offer-go').textContent !== label) $('offer-go').textContent = label
  const fading = left <= OFFER_FADE && !offerHeld
  el.classList.toggle('fading', fading)
  if (fading) el.classList.remove('fresh')
  el.style.animationDelay = fading ? `${left - OFFER_FADE}ms` : ''
  if (!offerHeld) offerTimer = setTimeout(drawOffer, left > OFFER_FADE ? left - OFFER_FADE : left + 30)
  placeOffer()
}

// Right after the ear, which may be wider while hovered, and only as far as the free stretch of the top edge goes.
function placeOffer() {
  const el = $('offer')
  if (el.hidden || !ear) return
  const left = Math.ceil($('ear').getBoundingClientRect().right) + 6
  const room = IN.left + ear.dx + ear.room - left
  el.style.maxWidth = `${Math.max(0, room)}px`
  el.style.left = `${left}px`
  el.style.visibility = room < 90 ? 'hidden' : ''
}
new ResizeObserver(placeOffer).observe($('ear'))

const dismissOffer = () => {
  offerDismissed = true
  drawOffer()
}
$('offer').addEventListener('pointerenter', () => {
  if (offerHeld) return
  offerHeld = Date.now()
  drawOffer()
})
$('offer').addEventListener('pointerleave', () => {
  if (!offerHeld) return
  offerPaused += Date.now() - offerHeld
  offerHeld = 0
  drawOffer()
})
$('offer-x').addEventListener('click', dismissOffer)
$('offer-go').addEventListener('click', () => {
  dismissOffer()
  call('tabs.reroute', { id })
})

/* ---------- snapping, as the prototype's window manager ---------- */

// The layout a drop at p tiles to: halves at the sides and the bottom, quarters at the corners, fill along the top, whose middle third opens the strip.
function zoneAt(p) {
  const { w: W, h: H } = desk()
  const L = p.x <= EDGE, R = p.x >= W - EDGE, T = p.y <= EDGE, B = p.y >= H - EDGE
  const nearTop = p.y <= CORNER, nearBottom = p.y >= H - CORNER, nearLeft = p.x <= CORNER, nearRight = p.x >= W - CORNER
  if (L) return nearTop ? 'top-left' : nearBottom ? 'bottom-left' : 'left'
  if (R) return nearTop ? 'top-right' : nearBottom ? 'bottom-right' : 'right'
  if (T) return nearLeft ? 'top-left' : nearRight ? 'top-right' : p.x >= W / 3 && p.x <= W * 2 / 3 ? 'strip' : 'fill'
  if (B) return nearLeft ? 'bottom-left' : nearRight ? 'bottom-right' : 'bottom'
  return null
}

// The core's layout rects for the current desk size, fetched once per size.
let layoutCache = null
function layouts() {
  const key = JSON.stringify(deskSize(state))
  if (layoutCache?.key === key) return layoutCache.rects
  const entry = { key, rects: skiff.call('desk.layouts').catch(() => { if (layoutCache === entry) layoutCache = null; return null }) }
  layoutCache = entry
  return entry.rects
}

// Magnetic within 8px to the desk's edges and to other windows' edges, abutting with an 8px gap.
function snap(rect, others, mode, edges = 'nesw', min = { w: 0, h: 0 }) {
  const s = desk()
  const r = { ...rect }
  const guides = []
  const near = (a0, a1, b0, b1) => a0 <= b1 + 24 && b0 <= a1 + 24
  const axis = (horiz) => {
    const P = horiz ? 'x' : 'y', S = horiz ? 'w' : 'h', Q = horiz ? 'y' : 'x', T = horiz ? 'h' : 'w'
    const moving = []
    if (edges.includes(horiz ? 'w' : 'n')) moving.push('lo')
    if (edges.includes(horiz ? 'e' : 's')) moving.push('hi')
    let best = null
    for (const side of moving) {
      const v = side === 'lo' ? r[P] : r[P] + r[S]
      const cand = [{ at: side === 'lo' ? s[P] : s[P] + s[S], o: null }]
      for (const o of others) {
        if (!near(r[Q], r[Q] + r[T], o[Q], o[Q] + o[T])) continue
        if (side === 'lo') cand.push({ at: o[P], o }, { at: o[P] + o[S] + GAP, o, line: o[P] + o[S] })
        else cand.push({ at: o[P] + o[S], o }, { at: o[P] - GAP, o, line: o[P] })
      }
      for (const c of cand) {
        const d = c.at - v
        if (Math.abs(d) <= MAGNET && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, side, c }
      }
    }
    if (!best) return
    if (mode === 'move') r[P] += best.d
    else if (best.side === 'lo') {
      if (r[S] - best.d < (horiz ? min.w : min.h)) return
      r[P] += best.d
      r[S] -= best.d
    } else {
      if (r[S] + best.d < (horiz ? min.w : min.h)) return
      r[S] += best.d
    }
    const at = best.c.line ?? best.c.at
    const o = best.c.o
    const a = o ? Math.max(s[Q], Math.min(r[Q], o[Q]) - 20) : s[Q]
    const b = o ? Math.min(s[Q] + s[T], Math.max(r[Q] + r[T], o[Q] + o[T]) + 20) : s[Q] + s[T]
    guides.push(horiz ? { x: at, y: a, width: 0, height: b - a } : { x: a, y: at, width: b - a, height: 0 })
  }
  axis(true)
  axis(false)
  return { rect: r, guides }
}

// Inside the desk, with room for the ear above the page.
function within(r) {
  const s = desk()
  const width = clamp(Math.round(r.width), 240, s.w)
  const height = clamp(Math.round(r.height), 160, Math.max(160, s.h - EAR))
  return { x: clamp(Math.round(r.x), 0, Math.max(0, s.w - width)), y: clamp(Math.round(r.y), EAR, Math.max(EAR, s.h - height)), width, height }
}

/* ---------- gestures: move by the ear or the page's background, resize by the insets, pinch the ear ---------- */

// The view moves under the pointer while it drags, so positions come from screen deltas, never from this view's own coordinates.
// source: 'pointer' for this frame's own handles, 'page' for page-drag reports from the page above it. at: the pointer on the desk.
function begin(kind, source, screen, at) {
  const w = mine()
  if (gesture || pinch || !w) return false
  const g = gesture = {
    kind, source, start: frameOf(w.rect), p0: screen, at0: at,
    others: deskWindows(state).filter((o) => o.tab.id !== id).map((o) => frameOf(o.rect)), buoy: buoyRect(state), moved: false, zone: null, cell: null, over: false, strip: null, rects: null
  }
  layouts().then((rects) => {
    if (gesture !== g) return
    g.rects = rects
    if (g.strip) tellStrip(g)
  })
  root.dataset.gesture = kind
  if (kind !== 'move') root.dataset.lit = kind
  call('ui.setDesk', { capture: true })
  return true
}

function start(e, kind) {
  const w = mine()
  if (e.button !== 0 || !w || !begin(kind, 'pointer', { x: e.screenX, y: e.screenY }, { x: w.rect.x - IN.left + e.clientX, y: w.rect.y - IN.top + e.clientY })) return
  e.preventDefault()
  e.currentTarget.setPointerCapture(e.pointerId)
}

// Past the left, right or bottom desk edge the window keeps that edge on it and loses the rest, down to the smallest size (or its start size if smaller); back again it regrows to at most its start size.
// The top stays a limit (the ear's), the edge a drag goes to to tile.
function shrunkAtEdges(f, st, s) {
  const minW = Math.min(MIN.w, s.w, st.w)
  const minH = Math.min(MIN.h + EAR, s.h, st.h)
  let { x, y, w, h } = f
  if (x < 0) { w = Math.max(minW, Math.min(st.w, x + w)); x = 0 }
  else if (x + w > s.w) { x = Math.min(x, s.w - minW); w = Math.max(minW, Math.min(st.w, s.w - x)) }
  if (y < 0) y = 0
  else if (y + h > s.h) { y = Math.min(y, s.h - minH); h = Math.max(minH, Math.min(st.h, s.h - y)) }
  return { x, y, w, h }
}

function step(ev) {
  const g = gesture
  if (!g) return
  const dx = ev.screenX - g.p0.x
  const dy = ev.screenY - g.p0.y
  if (!g.moved && Math.hypot(dx, dy) < 3) return
  g.moved = true
  const s = desk()
  const st = g.start
  let f
  let guides
  if (g.kind === 'move') {
    ;({ rect: f, guides } = snap({ ...st, x: st.x + dx, y: st.y + dy }, g.others, 'move'))
    const p = { x: g.at0.x + dx, y: g.at0.y + dy }
    g.over = overlapsRect(p, g.buoy)
    const zone = g.over ? null : zoneAt(p)
    g.cell = g.over ? null : stripStep(g, p, zone === 'strip')
    g.zone = g.cell || zone === 'strip' ? null : zone
    // Going to tile or hide it, the window is not shrunk on the way.
    if (g.over || g.cell || zone) {
      f.x = clamp(f.x, 0, Math.max(0, s.w - f.w))
      f.y = clamp(f.y, 0, Math.max(0, s.h - f.h))
    } else f = shrunkAtEdges(f, st, s)
  } else {
    const e = g.kind
    const min = { w: Math.min(MIN.w, s.w), h: Math.min(MIN.h, s.h - EAR) + EAR }
    const r = { ...st }
    if (e.includes('e')) r.w = clamp(st.w + dx, min.w, Math.max(min.w, s.w - st.x))
    if (e.includes('w')) { r.w = clamp(st.w - dx, min.w, Math.max(min.w, st.x + st.w)); r.x = st.x + st.w - r.w }
    if (e.includes('s')) r.h = clamp(st.h + dy, min.h, Math.max(min.h, s.h - st.y))
    if (e.includes('n')) { r.h = clamp(st.h - dy, min.h, Math.max(min.h, st.y + st.h)); r.y = st.y + st.h - r.h }
    ;({ rect: f, guides } = snap(r, g.others, 'resize', e, min))
  }
  g.rect = pageOf(f)
  const layout = g.cell || g.zone
  const zone = layout && g.rects?.[layout] && { ...g.rects[layout], label: LAYOUT_LABELS[layout] }
  call('ui.setDesk', { capture: true, preview: { id, ...g.rect } })
  // The other frames move their ears out of the way of this one as it goes; a moved window's own ear stays put on it.
  const live = { id, ...g.rect, ...(g.kind === 'move' && { ear }) }
  call('ui.emit', { name: 'desk-guides', data: { guides: layout || g.over ? [] : guides, zone, overBuoy: g.over, moving: live }, focus: false })
  if (g.kind !== 'move') placeEar()
}

/* ---------- the layout strip: opened from the top middle of the desk, picked from here, drawn by layouts.html ---------- */

// Overlay calls run in order, so a quick open and close never lands the other way round.
let stripQueue = Promise.resolve()
const stripCall = (method, params) => { stripQueue = stripQueue.then(() => call(method, params)) }
const tellStrip = (g) => stripCall('ui.emit', { name: 'layouts-strip', data: { hover: g.strip.hover, layouts: g.rects }, focus: false })

// The cell under p while the strip is open, opening it when the pointer enters the top middle; null once the pointer leaves it.
function stripStep(g, p, entering) {
  const strip = layoutStrip(state)
  const cell = stripCellAt(strip, p)
  if (!cell || (!g.strip && !entering)) {
    closeStrip(g)
    return null
  }
  if (!g.strip) {
    g.strip = { hover: null }
    tellStrip(g)
    stripCall('ui.showOverlay', { name: 'layouts', file: 'layouts.html', bounds: strip.bounds, focus: false })
  }
  if (cell !== g.strip.hover) {
    g.strip.hover = cell
    tellStrip(g)
  }
  return cell
}

function closeStrip(g) {
  if (!g.strip) return
  g.strip = null
  stripCall('ui.hideOverlay', { name: 'layouts' })
  stripCall('ui.emit', { name: 'layouts-strip', data: null, focus: false })
}

async function finish() {
  const g = gesture
  if (!g) return
  delete root.dataset.gesture
  closeStrip(g)
  const layout = g.cell || g.zone
  // The new place is saved before the preview ends, so the window never jumps back for a frame.
  if (g.moved && g.over) await call('desk.hide', { id })
  else if (g.moved && layout) await call('desk.tile', { id, layout })
  else if (g.moved) await call('desk.place', { id, ...within(g.rect) })
  gesture = null
  call('ui.emit', { name: 'desk-guides', data: null, focus: false })
  call('ui.setDesk', { capture: false, preview: null })
  relight()
  placeEar()
}

// A space switch mid-drag, Escape or a lost button on the page leaves the window where it was saved.
function cancel() {
  const g = gesture
  if (!g) return
  gesture = null
  delete root.dataset.gesture
  closeStrip(g)
  call('ui.emit', { name: 'desk-guides', data: null, focus: false })
  call('ui.setDesk', { capture: false, preview: null })
  relight()
  placeEar()
}

/* ---------- lit edges: the ring's edge a press would resize lights up ---------- */

function relight() {
  if (pinch) root.dataset.lit = 'nesw'
  else if (gesture && gesture.kind !== 'move') root.dataset.lit = gesture.kind
  else if (document.querySelector('.rz:hover')) root.dataset.lit = document.querySelector('.rz:hover').dataset.edge
  else delete root.dataset.lit
}

/* ---------- pinch on the ear: the window grows or shrinks around its centre ---------- */

function pinchStep(e) {
  if (!e.ctrlKey || !(pinch || e.target.closest?.('#ear'))) return
  e.preventDefault()
  const w = mine()
  if (!w || gesture) return
  const p = pinch ||= { base: { ...w.rect }, scale: 1, rect: w.rect, timer: 0 }
  const s = desk()
  const b = p.base
  const lo = { w: Math.min(MIN.w, s.w, b.width), h: Math.min(MIN.h, s.h - EAR, b.height) }
  const hi = { w: s.w, h: s.h - EAR }
  p.scale = clamp(p.scale * Math.exp(-clamp(e.deltaY, -25, 25) / 100), Math.min(lo.w / b.width, lo.h / b.height), Math.max(hi.w / b.width, hi.h / b.height))
  const width = Math.round(clamp(b.width * p.scale, lo.w, hi.w))
  const height = Math.round(clamp(b.height * p.scale, lo.h, hi.h))
  const rect = { x: Math.round(clamp(b.x + (b.width - width) / 2, 0, s.w - width)), y: Math.round(clamp(b.y + (b.height - height) / 2, EAR, s.h - height)), width, height }
  p.rect = rect
  relight()
  call('ui.setDesk', { preview: { id, ...rect } })
  call('ui.emit', { name: 'desk-guides', data: { guides: [], moving: { id, ...rect } }, focus: false })
  placeEar()
  clearTimeout(p.timer)
  p.timer = setTimeout(async () => {
    await call('desk.place', { id, ...within(rect) })
    // A pinch that went on meanwhile commits itself later.
    if (pinch !== p || p.rect !== rect) return
    pinch = null
    call('ui.emit', { name: 'desk-guides', data: null, focus: false })
    call('ui.setDesk', { preview: null })
    relight()
    placeEar()
  }, PINCH_SETTLE)
}

async function toggleFill() {
  const w = mine()
  const full = w && (await layouts())?.fill
  if (!full) return
  const memory = readStore('fill') || {}
  if (!sameRect(w.rect, full)) {
    writeStore('fill', { ...memory, [id]: w.rect })
    return call('desk.tile', { id, layout: 'fill' })
  }
  const back = memory[id] && !sameRect(memory[id], full) ? memory[id] : defaultRect(state, w.tab)
  call('desk.place', { id, ...within(back) })
}

const byPointer = (fn) => (e) => { if (gesture?.source === 'pointer') fn(e) }
const grab = (el, kind) => {
  el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) start(e, kind) })
  el.addEventListener('pointermove', byPointer(step))
  el.addEventListener('pointerup', byPointer(finish))
  el.addEventListener('pointercancel', byPointer(finish))
}
grab($('ear'), 'move')
grab($('bar'), 'move')
for (const rz of document.querySelectorAll('.rz')) {
  grab(rz, rz.dataset.edge)
  rz.addEventListener('pointerenter', relight)
  rz.addEventListener('pointerleave', relight)
}
// A two finger swipe on the ear switches spaces, or opens exposé upwards, as on the Buoy; with ctrlKey it is a pinch.
const swipe = spaceSwiper(true)
function earSwipe(e) {
  if (e.ctrlKey || pinch || !e.target.closest?.('#ear')) return
  e.preventDefault()
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? $('ear').clientWidth : 1
  swipe.step(e.timeStamp, e.deltaX * unit, e.deltaY * unit)
}
// Begun on the ear; the window grows out from under the fingers, so the rest of the pinch counts anywhere on the frame.
document.addEventListener('wheel', pinchStep, { passive: false })
document.addEventListener('wheel', earSwipe, { passive: false })
$('ear').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleFill() })
$('ear-hide').addEventListener('click', () => call('desk.hide', { id }))
$('ear-close').addEventListener('click', () => call('tabs.close', { id }))
// Any press on the frame brings its window forward, as a press on its page does; a press on another window's ear, seen through this frame's clear margin, brings that one.
document.addEventListener('pointerdown', (e) => {
  if (!state) return
  const other = !e.target.closest('#ear, #offer') && !gesture && earUnder(e)
  if (other) {
    e.preventDefault()
    e.stopPropagation()
    call('tabs.activate', { id: other })
  } else if (!mine()?.active && !e.target.closest('button')) call('tabs.activate', { id })
}, true)
appearance.addEventListener('change', () => { painted = ''; render() })
// Titles measured in the fallback font are wrong once the shell's font arrives.
document.fonts.addEventListener('loadingdone', () => { earWidths.clear(); offerWidths.clear(); placeEar() })
skiff.on('drag-cancel', cancel)
// A press on the page's empty background drags the window as the ear does; the core sends it here in screen coordinates.
skiff.on('page-drag', (d) => {
  if (d?.tab !== id) return
  if (d.phase === 'start') begin('move', 'page', { x: d.screenX, y: d.screenY }, { x: d.screenX - screenX, y: d.screenY - screenY })
  else if (gesture?.source !== 'page') return
  else if (d.phase === 'move') step(d)
  else if (d.phase === 'end') finish()
  else cancel()
})
skiff.on('desk-guides', (data) => {
  const next = data?.moving?.id && data.moving.id !== id ? data.moving : null
  if (!next && !moving) return
  moving = next
  placeEar()
})
skiff.on('buoy-moved', placeEar)
skiff.on('state', (next) => {
  state = next
  render()
})
skiff.call('state.get').then((first) => {
  state ||= first
  render()
}).catch(() => {})

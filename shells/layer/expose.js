'use strict'

// Exposé: every window of the active space spread out over the dimmed desk, as Mission Control does it. layer.js shows this overlay over the whole window.
const $ = (id) => document.getElementById(id)
const stage = $('stage')
const veil = $('veil')
const veilFill = veil.querySelector('.fill')
const holes = $('holes')
const tray = $('tray')
const root = document.documentElement
const CARD_GAP = 28
// Room under a card for its label.
const LABEL = 34
const PAD = { top: 56, side: 48, bottom: 48 }
// Hidden windows sit this tall in their row along the bottom.
const SHELF = 72
const SHELF_GAP = 18
// Windows of other macOS desktops sit in the tray apart from each other, each group under its label.
const GROUP_GAP = 36
const TAG = 26
const groups = $('groups')
// Kept clear around the Buoy, which stays above exposé.
const CLEAR = 12
const MS = 250
// Quick off the mark and settling gently, as macOS moves its windows.
const EASE = 'cubic-bezier(.25, .8, .25, 1)'
// A window page's corner radius, as the core rounds it.
const RADIUS = 10
// How long pictures taken as a gesture starts stay good for the exposé it opens.
const WARM = 500
// A swipe up pulls exposé open (PEEK and COMMIT are in common.js): the cards are fully out at FULL px of upward travel.
const FULL = 180
// The upward travel that closes an exposé that is already open.
const CLOSE_PULL = 40

let state = null
// While open: {space, active, cards: [{tab, rect, to, z, hidden, active, el}]}.
let shown = null
let closing = false
// An opening asked for while exposé was closing.
let again = false
// The work prepare() started: {at, key, layout, ready}.
let prepared = null
// The swipe stream being followed: {last, travel, timer, from: 'closed' | 'open', asked (exposé was opened for it), spent, cancelled}.
let stream = { last: -Infinity, spent: true }

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
// The transform that lays a box placed at `to` over the rect r.
const over = (to, r) => `translate(${r.x - to.x}px, ${r.y - to.y}px) scale(${r.width / to.width}, ${r.height / to.height})`
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const px = (v) => `${v}px`

// Justified rows: windows by their centre top to bottom, cut into k rows, each left to right and as tall as fits (never above real size); the k with the most card area wins.
function arrange(list, box) {
  const n = list.length
  if (!n) return []
  const byY = [...list].sort((a, b) => centre(a.rect).y - centre(b.rect).y)
  let best = null
  for (let k = 1; k <= n; k++) {
    const band = (box.height - (k - 1) * CARD_GAP) / k - LABEL
    if (band < 40 && best) break
    const rows = Array.from({ length: k }, (_, i) => byY.slice(Math.round(i * n / k), Math.round((i + 1) * n / k)).sort((a, b) => centre(a.rect).x - centre(b.rect).x))
    const sized = rows.map((row) => {
      const h = Math.min(band, (box.width - (row.length - 1) * CARD_GAP) / row.reduce((sum, w) => sum + w.rect.width / w.rect.height, 0))
      return row.map((w) => { const s = Math.min(1, h / w.rect.height); return { w, width: w.rect.width * s, height: w.rect.height * s } })
    })
    const area = sized.flat().reduce((sum, c) => sum + c.width * c.height, 0)
    if (!best || area > best.area * 1.001) best = { area, sized }
  }
  const heights = best.sized.map((row) => Math.max(...row.map((c) => c.height)))
  let y = box.y + (box.height - heights.reduce((sum, v) => sum + v + LABEL, 0) - (heights.length - 1) * CARD_GAP) / 2
  return best.sized.flatMap((row, i) => {
    let x = box.x + (box.width - row.reduce((sum, c) => sum + c.width + CARD_GAP, -CARD_GAP)) / 2
    const out = row.map((c) => {
      const to = { x: Math.round(x), y: Math.round(y + (heights[i] - c.height) / 2), width: Math.round(c.width), height: Math.round(c.height) }
      x += c.width + CARD_GAP
      return { ...c.w, to }
    })
    y += heights[i] + LABEL + CARD_GAP
    return out
  })
}

// One row along the bottom of the box, SHELF tall unless that is too wide; a window's group (its desktop, none for the current one) sits apart from the next.
function shelve(list, box) {
  if (!list.length) return []
  const gap = (i) => (list[i].group === list[i - 1].group ? SHELF_GAP : GROUP_GAP)
  const gaps = list.slice(1).reduce((sum, _, i) => sum + gap(i + 1), 0)
  const aspect = list.reduce((sum, w) => sum + w.rect.width / w.rect.height, 0)
  const h = Math.min(SHELF, (box.width - gaps) / aspect)
  let x = box.x + (box.width - aspect * h - gaps) / 2
  return list.map((w, i) => {
    if (i) x += gap(i)
    const to = { x: Math.round(x), y: Math.round(box.y + box.height - LABEL - h), width: Math.round(w.rect.width / w.rect.height * h), height: Math.round(h) }
    x += to.width
    return { ...w, to }
  })
}

// The largest part of the box beside each rect in turn, so no card lies under the Buoy.
function clearOf(box, rects) {
  for (const r of rects) {
    const o = { x: r.x - CLEAR, y: r.y - CLEAR, right: r.x + r.width + CLEAR, bottom: r.y + r.height + CLEAR }
    if (o.right <= box.x || o.x >= box.x + box.width || o.bottom <= box.y || o.y >= box.y + box.height) continue
    box = [
      { ...box, width: o.x - box.x },
      { ...box, x: o.right, width: box.x + box.width - o.right },
      { ...box, height: o.y - box.y },
      { ...box, y: o.bottom, height: box.y + box.height - o.bottom }
    ].reduce((best, b) => (b.width * b.height > best.width * best.height ? b : best))
  }
  return box
}

// Each window's ear where its frame draws it, from the windows back to front.
function placeEars(list) {
  const slots = earLayout(list.map((c) => ({ id: c.tab.id, rect: c.rect, natural: earNatural(earTitle(c.tab)) })), [buoyRect(state)], deskSize(state).width)
  for (const c of list) {
    const ear = c.el?.querySelector('.ear')
    if (!ear) continue
    const slot = slots[c.tab.id]
    ear.hidden = !slot
    if (!slot) continue
    Object.assign(ear.style, { left: px(slot.x - c.rect.x), width: px(slot.width) })
    ear.classList.toggle('narrow', slot.width < earNatural(earTitle(c.tab)) && slot.width < EAR_MIN + 24)
  }
  return slots
}

// A window is laid out at its real rect, as its frame and page draw it, and scaled into its place, a hidden one too, so it can grow into its window.
function card(c, image) {
  const title = earTitle(c.tab)
  const at = c.rect
  const scale = c.to.width / at.width
  const win = h('span', { class: `win${c.active ? ' active' : ''}` },
    h('span', { class: 'ear', 'aria-hidden': 'true' }, h('span', { class: 'ear-fav' }, favicon(c.tab), agentDot(c.tab)), h('span', { class: 'ear-title' }, title)),
    h('span', { class: 'ring' }),
    h('span', { class: 'glow' }),
    h('span', { class: 'card' }, image ? h('img', { class: 'shot', src: image, alt: '', draggable: 'false' }) : h('span', { class: 'blank' }, favicon(c.tab), h('span', { class: 'blank-title' }, title))))
  Object.assign(win.style, { left: px(at.x - c.to.x), top: px(at.y - c.to.y), width: px(at.width), height: px(at.height), transform: over(at, c.to) })
  win.style.setProperty('--k', 1 / scale)
  const el = h('button', { class: `slot${c.hidden ? ' shelved' : ''}`, type: 'button', 'data-tab-id': c.tab.id, 'aria-label': c.group ? `${title}, Desktop ${c.group.number}` : c.hidden ? `${title}, hidden` : title, onclick: () => pick(c) },
    win, h('span', { class: 'label' }, favicon(c.tab), h('span', { class: 'label-title' }, title), agentDot(c.tab)))
  Object.assign(el.style, { left: px(c.to.x), top: px(c.to.y), width: px(c.to.width), height: px(c.to.height), zIndex: c.z })
  el.style.setProperty('--r', px(c.hidden ? 7 : RADIUS * scale))
  return el
}

// The desk dims around the windows at once; they stay real until their pictures are ready.
function dim(rects, pulled) {
  const rect = (r, rx = 0) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    for (const [key, value] of Object.entries({ x: r.x, y: r.y, width: r.width, height: r.height, rx })) el.setAttribute(key, value)
    return el
  }
  holes.replaceChildren(Object.assign(rect({ x: 0, y: 0, width: innerWidth, height: innerHeight }), { id: 'all' }), ...rects.map((r) => rect(r, r.rx)))
  holes.firstChild.setAttribute('fill', '#fff')
  veilFill.setAttribute('mask', 'url(#holes)')
  veil.style.opacity = 1
  if (still()) return null
  const fade = veil.animate([{ opacity: 0 }, { opacity: 1 }], pulled ? { duration: MS, easing: 'linear', fill: 'both' } : { duration: MS, easing: 'ease-out' })
  if (pulled) fade.pause()
  return fade
}

// Everything before anything shows, for the desk as it is: the layout, then the cards with their pictures decoded. The gesture's
// first move starts it (the first 'expose-pull' of a swipe from the Buoy or an ear), so the pictures are often ready by the time exposé opens.
function prepare() {
  const fresh = prepared && performance.now() - prepared.at < WARM && (!prepared.key || !state || prepared.key === deskKey(state))
  if (!fresh) {
    const layout = plan()
    prepared = { at: performance.now(), key: state && deskKey(state), layout, ready: layout.then(pictures) }
  }
  return prepared
}
// layer.js ends a foreground set before exposé shows, so every window of the space is laid out.
const deskKey = (st) => JSON.stringify([st.activeSpaceId, st.desktops?.current, deskWindows({ ...st, deskOnly: null }).map((w) => [w.tab.id, w.rect, w.active])])

async function plan() {
  const st = state ||= await skiff.call('state.get').catch(() => null)
  if (!st) return null
  const active = activeTabOf(st)
  const wins = deskWindows({ ...st, deskOnly: null }).map((w, z) => ({ tab: w.tab, rect: w.rect, z, hidden: false, active: w.active }))
  const hidden = visibleTabs(st, st.activeSpaceId).filter((t) => t !== active && onDesktop(st, t) && t.desk?.hidden).map((tab) => ({ tab, rect: rectOf(st, tab), z: 0, hidden: true }))
  // Pictures of other desktops' tabs are never to be had (they are not on screen), so their cards show no picture.
  const elsewhere = visibleTabs(st, st.activeSpaceId).filter((t) => !t.userPeek && !onDesktop(st, t) && desktopOf(st, t)).map((tab) => ({ tab, rect: rectOf(st, tab), z: 0, hidden: true, group: desktopOf(st, tab) })).sort((a, b) => a.group.number - b.group.number)
  const shelf = [...hidden, ...elsewhere]
  const room = shelf.length ? SHELF + LABEL + CARD_GAP + (elsewhere.length ? TAG : 0) : 0
  const box = clearOf({ x: PAD.side, y: PAD.top, width: innerWidth - 2 * PAD.side, height: innerHeight - PAD.top - PAD.bottom }, [buoyRect(st)])
  const cards = [...arrange(wins, { ...box, height: box.height - room }), ...shelve(shelf, box)]
  const slots = placeEars(wins)
  const holes = wins.flatMap((c) => [{ ...c.rect, rx: RADIUS }, ...(slots[c.tab.id] ? [{ ...slots[c.tab.id], y: c.rect.y - EAR_HEIGHT, height: EAR_HEIGHT }] : [])])
  return { st, active, cards, holes }
}

// Pictures taken while the pages still show, each at twice the pixels its card settles at (never above the window's own): the main process encodes them one by one, so small ones open exposé sooner.
async function pictures(layout) {
  if (!layout) return layout
  const { cards } = layout
  await Promise.all(cards.map(async (c) => {
    const width = clamp(Math.ceil(Math.min(c.rect.width, c.to.width * 2) * devicePixelRatio), 160, 3840)
    const [shot] = c.hidden ? [] : await skiff.call('tabs.thumbnails', { ids: [c.tab.id], width }).catch(() => [])
    c.el = card(c, shot?.image)
    await Promise.all([...c.el.querySelectorAll('img.shot')].map((img) => img.decode().catch(() => {})))
  }))
  placeEars(cards.filter((c) => !c.hidden).sort((a, b) => a.z - b.z))
  return layout
}

async function openExpose() {
  if (shown) return
  const token = shown = { cards: [] }
  closing = false
  const pending = prepare()
  prepared = null
  const layout = await pending.layout
  if (shown !== token) return
  if (!layout) return finish()
  const { st, active, cards } = layout
  // The swipe that asked for this opening, if it is still the one being followed; one that ended before exposé could open is not an opening.
  const mine = stream.asked && !stream.opened && performance.now() - stream.last < 1000 ? stream : null
  if (mine) mine.opened = true
  if (mine?.cancelled) return void (shown = null, finish())
  const pulled = Boolean(mine && !mine.spent && !still())
  if (pulled) token.pull = mine
  paintSpace(st)
  // The desk dims around the windows at once; they stay real until their cards are ready.
  token.veil = dim(layout.holes, pulled)
  await pending.ready
  if (shown !== token) return
  Object.assign(token, { space: st.activeSpaceId, active: active?.id, desktop: st.desktops?.current, cards })
  $('empty').hidden = cards.length > 0
  const glide = !still()
  const motion = pulled ? { duration: MS, easing: 'linear', fill: 'both' } : glide ? { duration: MS, easing: EASE, fill: 'backwards' } : { duration: 150, easing: 'ease-out', fill: 'backwards' }
  const anims = [tray.animate([{ opacity: 0 }, { opacity: 1 }], motion), groups.animate([{ opacity: 0 }, { opacity: 1 }], motion), $('empty').animate([{ opacity: 0 }, { opacity: 1 }], motion)]
  for (const c of cards) {
    const win = c.el.firstChild
    if (c.hidden || !glide) {
      anims.push(c.el.animate([{ opacity: 0, transform: glide ? 'translateY(12px)' : 'none' }, { opacity: 1, transform: 'none' }], motion))
      continue
    }
    anims.push(
      win.animate([{ transform: 'none' }, { transform: win.style.transform }], motion),
      win.querySelector('.ear').animate([{ opacity: 1 }, { opacity: 0 }], { ...motion, duration: MS * 0.6 }),
      win.querySelector('.ring').animate([{ opacity: 1 }, { opacity: 0 }], motion),
      win.querySelector('.glow').animate([{ opacity: 0 }, { opacity: 1 }], motion))
  }
  // Each window card first lies exactly over its window, and moves once the real pages and frames have gone.
  if (glide) for (const a of anims) a.pause()
  if (pulled) token.anims = [token.veil, ...anims].filter(Boolean)
  stage.replaceChildren(...cards.map((c) => c.el))
  placeTray(cards.filter((c) => c.hidden))
  ;(cards.find((c) => c.tab === active) || cards[0])?.el.focus({ preventScroll: true })
  // Three frames, not two: the overlay's frame with the cards can reach the screen after the pages leave it, which left the desk bare in 7 of 13 Xvfb openings.
  for (let i = 0; i < 3; i++) await frame()
  if (shown !== token || closing) return
  await skiff.call('ui.setPageVisible', { visible: false }).catch(() => {})
  // The windows are gone, so the veil needs no holes, and a plain veil is cheap to fade.
  veilFill.removeAttribute('mask')
  if (glide) await frame()
  if (shown !== token || closing) return
  if (pulled) {
    token.live = true
    follow(token)
    if (stream.spent) arrive(token)
    return
  }
  for (const a of anims) a.play()
  settleWhenArrived(token, anims)
}

// Labels and the hover ring wait for the cards to arrive.
function settleWhenArrived(token, anims) {
  Promise.all(anims.map((a) => a.finished)).then(() => { if (shown === token && !closing) root.classList.add('settled') }, () => {})
}

// The cards stand where the fingers have taken them; the paused animations are the positions.
function follow(token) {
  const at = clamp(stream.travel / FULL, 0, 1) * MS
  for (const a of token.anims) a.currentTime = at
}

// A committed pull plays the rest of the way.
function arrive(token) {
  for (const a of token.anims) a.play()
  settleWhenArrived(token, token.anims)
}

// Upward travel of the swipe stream; dy is positive for fingers up. Opens exposé as it is pulled, follows the fingers, and decides when the stream ends.
function pullBy(dy) {
  const now = performance.now()
  if (now - stream.last >= SWIPE_GAP) {
    clearTimeout(stream.timer)
    stream = { last: now, travel: 0, from: shown && !closing ? 'open' : 'closed', spent: false, asked: false, cancelled: false }
  }
  stream.last = now
  if (stream.spent) return
  stream.travel = Math.max(0, stream.travel + dy)
  clearTimeout(stream.timer)
  const mine = stream
  mine.timer = setTimeout(() => endPull(mine), SWIPE_GAP + 30)
  if (mine.from === 'open') {
    if (mine.travel >= CLOSE_PULL) { mine.spent = true; closeExpose() }
    return
  }
  // A swipe that lands while the windows go home is layer.js's to open again once they have gone.
  if (closing) return void (mine.spent = true)
  if (!shown) prepare()
  const token = shown
  if (token?.veil && token.pull && !token.live) token.veil.currentTime = clamp(mine.travel / FULL, 0, 1) * MS
  if (token?.live) {
    if (mine.travel >= FULL) { mine.spent = true; arrive(token) } else follow(token)
  } else if (mine.travel >= FULL) mine.spent = true
}

function endPull(s) {
  if (s !== stream || s.spent) return
  s.spent = true
  if (s.from !== 'closed' || !s.asked) return
  if (s.travel >= COMMIT) {
    if (shown?.live) arrive(shown)
    return
  }
  s.cancelled = true
  closeExpose()
}

// Snug around the hidden windows' tiles; a tile's title shows under it, past the tray, while it is pointed at. Other desktops' tiles each get a tray with its label on top.
function placeTray(shelf) {
  const own = shelf.filter((c) => !c.group)
  tray.hidden = !own.length
  if (own.length) {
    const x = Math.min(...own.map((c) => c.to.x)) - 10
    const y = own[0].to.y - 10
    Object.assign(tray.style, { left: px(x), top: px(y), width: px(Math.max(...own.map((c) => c.to.x + c.to.width)) + 10 - x), height: px(own[0].to.height + 20) })
  }
  groups.replaceChildren(...[...new Set(shelf.map((c) => c.group).filter(Boolean))].map((group) => {
    const list = shelf.filter((c) => c.group === group)
    const x = Math.min(...list.map((c) => c.to.x)) - 10
    const y = list[0].to.y - 10 - TAG
    const el = h('div', { class: 'tray-group', 'data-desktop': String(group.number) }, h('span', { class: 'tray-label' }, `Desktop ${group.number}`))
    Object.assign(el.style, { left: px(x), top: px(y), width: px(Math.max(...list.map((c) => c.to.x + c.to.width)) + 10 - x), height: px(list[0].to.height + 20 + TAG) })
    return el
  }))
}

const pick = (c) => closeExpose(c)

// Every window glides back to its place, the chosen one in front and activated meanwhile; a hidden one that was not chosen fades away.
async function closeExpose(chosen) {
  if (!shown || closing) return
  // Asked to close before the cards are up: nothing has moved yet, so just leave.
  if (!shown.space) {
    shown = null
    return finish()
  }
  closing = true
  root.classList.remove('settled')
  const { cards } = shown
  const activated = chosen ? skiff.call('tabs.activate', { id: chosen.tab.id }).catch(() => {}) : null
  const back = cards.filter((c) => !c.hidden && c !== chosen).sort((a, b) => a.z - b.z)
  const front = chosen ? [...back, chosen] : back
  front.forEach((c, z) => {
    c.el.style.zIndex = z + 1
    c.el.firstChild.classList.toggle('active', chosen ? c === chosen : c.active)
  })
  placeEars(front)
  const glide = !still()
  // Without motion the pages come back first and the cards fade off them.
  if (!glide) {
    await activated
    await skiff.call('ui.setPageVisible', { visible: true }).catch(() => {})
  }
  // Each part goes back from wherever an unfinished opening left it.
  const moves = []
  const move = (el, prop, to, options) => moves.push([el, { [prop]: getComputedStyle(el)[prop] }, { [prop]: to }, options])
  const motion = glide ? { duration: MS, easing: EASE, fill: 'forwards' } : { duration: 150, easing: 'ease-in', fill: 'forwards' }
  move(veil, 'opacity', 0, motion)
  move(tray, 'opacity', 0, motion)
  move(groups, 'opacity', 0, motion)
  move($('empty'), 'opacity', 0, motion)
  for (const c of cards) {
    const win = c.el.firstChild
    if (!glide || (c.hidden && c !== chosen)) move(c.el, 'opacity', 0, motion)
    else {
      move(win, 'transform', 'none', motion)
      move(win.querySelector('.ear'), 'opacity', 1, { ...motion, delay: MS * 0.4, duration: MS * 0.6 })
      move(win.querySelector('.ring'), 'opacity', 1, motion)
      move(win.querySelector('.glow'), 'opacity', 0, motion)
      // A hidden window's tile grows from its tile corners into the window's.
      if (c.hidden) for (const part of ['.card', '.glow']) move(win.querySelector(part), 'borderRadius', `${RADIUS}px`, motion)
    }
  }
  for (const a of document.getAnimations()) if (!(a instanceof CSSTransition)) a.cancel()
  await Promise.all(moves.map(([el, from, to, options]) => el.animate([from, to], options).finished)).catch(() => {})
  if (glide) {
    await activated
    await skiff.call('ui.setPageVisible', { visible: true }).catch(() => {})
    // The pages draw again under the cards, which lie exactly over them, before the cards go.
    for (let i = 0; i < 4; i++) await frame()
    // A hidden window has no picture of itself, so its card gives way to the page it has become.
    if (chosen?.hidden) await chosen.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {})
  }
  finish()
}

// Cleared before it hides, so the next opening never shows this one's last picture.
async function finish() {
  stage.replaceChildren()
  holes.replaceChildren()
  tray.hidden = true
  groups.replaceChildren()
  $('empty').hidden = true
  for (const a of document.getAnimations()) a.cancel()
  veil.style.opacity = 0
  root.classList.remove('settled', 'keyed')
  await frame()
  await frame()
  await closeOverlay('expose')
  shown = null
  closing = false
  // A swipe up that landed while the windows were still going home opens exposé again, once it has gone.
  if (again) skiff.call('ui.emit', { name: 'expose', focus: false }).catch(() => {})
  again = false
}

const NEIGHBOUR = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
// The nearest card that way, weighing distance across the arrow twice; left and right run on in reading order past a row's end.
function moveFocus(key) {
  const cards = shown.cards
  const at = cards.find((c) => c.el === document.activeElement)
  if (!at) return cards[0]?.el.focus()
  const [dx, dy] = NEIGHBOUR[key]
  const from = centre(at.to)
  const next = cards.filter((c) => c !== at).map((c) => {
    const p = centre(c.to)
    const along = (p.x - from.x) * dx + (p.y - from.y) * dy
    return { c, along, score: along + 2 * (Math.abs(p.x - from.x) * Math.abs(dy) + Math.abs(p.y - from.y) * Math.abs(dx)) }
  }).filter((o) => o.along > 1).sort((a, b) => a.score - b.score)[0]?.c || (dx && cards[cards.indexOf(at) + dx])
  next?.el.focus()
}

addEventListener('keydown', (e) => {
  if (!shown || closing) return
  if (NEIGHBOUR[e.key] || e.key === 'Tab') root.classList.add('keyed')
  if (e.key === 'Escape') closeExpose()
  else if (NEIGHBOUR[e.key]) moveFocus(e.key)
  else return
  e.preventDefault()
})
addEventListener('pointermove', () => root.classList.remove('keyed'))
document.addEventListener('click', (e) => { if (shown?.space && !e.target.closest('.slot')) closeExpose() })
// A two finger swipe down anywhere closes; the rest of the swipe up that opened exposé lands here too and does nothing.
const swipe = swipeTracker(true)
addEventListener('wheel', (e) => {
  e.preventDefault()
  if (e.ctrlKey) return
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1
  const x = e.deltaX * unit
  const y = e.deltaY * unit
  // Once exposé is over an ear, that swipe's wheel events land here instead of on the ear.
  if (Math.abs(y) > Math.abs(x) * 1.3 && stream.from === 'closed' && performance.now() - stream.last < SWIPE_GAP) pullBy(state?.naturalScroll === false ? -y : y)
  if (!shown?.space) return
  if (swipe.step(e.timeStamp, x, y) === (state?.naturalScroll === false ? 'up' : 'down')) closeExpose()
}, { passive: false })

// layer.js forwards the event that opens exposé, with the travel so far when a swipe is pulling it open; the gesture again, or a swipe down on the Buoy or an ear, closes it.
skiff.on('expose', (data) => {
  if (data?.forwarded) {
    if (Number.isFinite(data.pull)) {
      const now = performance.now()
      if (now - stream.last >= SWIPE_GAP) stream = { last: now, from: 'closed', spent: false, cancelled: false, travel: 0 }
      stream.travel = Math.max(stream.travel, data.pull)
      stream.asked = true
      clearTimeout(stream.timer)
      const mine = stream
      mine.timer = setTimeout(() => endPull(mine), SWIPE_GAP + 30)
    }
    openExpose()
  }
  else if (closing) again ||= !data?.close
  else if (shown) closeExpose()
  else if (!data?.close) prepare()
})
skiff.on('expose-pull', (data) => { if (Number.isFinite(data?.dy)) pullBy(data.dy) })
// Leaving the space closes; a tab picked elsewhere, such as in the card, is picked here.
skiff.on('state', (next) => {
  state = next
  if (!shown?.space || closing) return
  if (next.activeSpaceId !== shown.space || next.desktops?.current !== shown.desktop) return closeExpose()
  const id = next.activeTabBySpace[next.activeSpaceId]
  if (id !== shown.active) closeExpose(shown.cards.find((c) => c.tab.id === id))
})
document.fonts.addEventListener('loadingdone', () => earWidths.clear())

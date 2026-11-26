'use strict'

const PLACEHOLDER = 'Search or enter address'
const HOST = /^(localhost|\[[0-9a-f:]+\]|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
// Whether text typed in the bar reads as a question or request for the agent rather than words to search for; local and synchronous, since it runs on every keystroke.
const ASK_LEAD = new Set(('who what when where why how which whose whom is are am was were do does did can could should would will shall may might explain write summarize summarise tell help give make show compare translate draft rewrite describe suggest recommend plan').split(' '))
const ASK_SELF = new Set(['i', "i'm", 'me', 'my', 'you', 'your', 'we', 'our', 'us'])
const ASK_FUNCTION = new Set('the a an is are was of to for in on with and that this it be from by as at'.split(' '))
function looksLikeQuestion(text) {
  const t = text.trim()
  if (!/\s/.test(t)) return false
  if (t.endsWith('?')) return true
  const words = t.split(/\s+/).map((w) => w.toLowerCase().replace(/’/g, "'").replace(/^[^\w']+|[^\w']+$/g, ''))
  if (words.length >= 3 && ASK_LEAD.has(words[0])) return true
  if (words.some((w) => ASK_SELF.has(w))) return true
  if (words.length >= 5 && words.filter((w) => ASK_FUNCTION.has(w)).length >= 2) return true
  return words.length >= 8
}
const SITES = [
  { host: 'google.com', name: 'Google', url: 'https://www.google.com', search: 'https://www.google.com/search?q=%s' },
  { host: 'maps.google.com', name: 'Google Maps', url: 'https://www.google.com/maps', search: 'https://www.google.com/maps/search/%s' },
  { host: 'youtube.com', name: 'YouTube', url: 'https://www.youtube.com', search: 'https://www.youtube.com/results?search_query=%s' },
  { host: 'reddit.com', name: 'Reddit', url: 'https://www.reddit.com', search: 'https://www.reddit.com/search/?q=%s' },
  { host: 'x.com', name: 'X', url: 'https://x.com', search: 'https://x.com/search?q=%s' },
  { host: 'twitter.com', name: 'Twitter', url: 'https://x.com', search: 'https://x.com/search?q=%s' },
  { host: 'github.com', name: 'GitHub', url: 'https://github.com', search: 'https://github.com/search?q=%s' },
  { host: 'wikipedia.org', name: 'Wikipedia', url: 'https://en.wikipedia.org', search: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { host: 'amazon.com', name: 'Amazon', url: 'https://www.amazon.com', search: 'https://www.amazon.com/s?k=%s' },
  { host: 'duckduckgo.com', name: 'DuckDuckGo', url: 'https://duckduckgo.com', search: 'https://duckduckgo.com/?q=%s' },
  { host: 'bing.com', name: 'Bing', url: 'https://www.bing.com', search: 'https://www.bing.com/search?q=%s' },
  { host: 'stackoverflow.com', name: 'Stack Overflow', url: 'https://stackoverflow.com', search: 'https://stackoverflow.com/search?q=%s' },
  { host: 'npmjs.com', name: 'npm', url: 'https://www.npmjs.com', search: 'https://www.npmjs.com/search?q=%s' },
  { host: 'developer.mozilla.org', name: 'MDN', url: 'https://developer.mozilla.org', search: 'https://developer.mozilla.org/en-US/search?q=%s' },
  { host: 'news.ycombinator.com', name: 'Hacker News', url: 'https://news.ycombinator.com', search: 'https://hn.algolia.com/?q=%s' },
  { host: 'imdb.com', name: 'IMDb', url: 'https://www.imdb.com', search: 'https://www.imdb.com/find/?q=%s' },
  { host: 'ebay.com', name: 'eBay', url: 'https://www.ebay.com', search: 'https://www.ebay.com/sch/i.html?_nkw=%s' },
  { host: 'twitch.tv', name: 'Twitch', url: 'https://www.twitch.tv', search: 'https://www.twitch.tv/search?term=%s' },
  { host: 'linkedin.com', name: 'LinkedIn', url: 'https://www.linkedin.com', search: 'https://www.linkedin.com/search/results/all/?keywords=%s' },
  { host: 'spotify.com', name: 'Spotify', url: 'https://open.spotify.com', search: 'https://open.spotify.com/search/%s' },
  { host: 'pinterest.com', name: 'Pinterest', url: 'https://www.pinterest.com', search: 'https://www.pinterest.com/search/pins/?q=%s' },
  { host: 'bsky.app', name: 'Bluesky', url: 'https://bsky.app', search: 'https://bsky.app/search?q=%s' },
  { host: 'tiktok.com', name: 'TikTok', url: 'https://www.tiktok.com', search: 'https://www.tiktok.com/search?q=%s' },
  { host: 'netflix.com', name: 'Netflix', url: 'https://www.netflix.com', search: 'https://www.netflix.com/search?q=%s' }
]

const SEARCH_ENGINES = [
  { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
  { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' }
]

function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else if (value === true) el.setAttribute(key, '')
    else if (value !== false && value != null) el.setAttribute(key, value)
  }
  el.append(...children.flat().filter((c) => c != null && c !== false))
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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Chromium loads and decodes some broken icon files without any error and then draws nothing, so only the pixels tell.
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
function draws(img) {
  try {
    probe.clearRect(0, 0, 8, 8)
    probe.drawImage(img, 0, 0, 8, 8)
    return probe.getImageData(0, 0, 8, 8).data.some((value, index) => index % 4 === 3 && value)
  } catch {
    return true
  }
}

function favicon(tab, fallback = h('span', { class: 'favicon letter', 'aria-hidden': 'true' }, (hostOf(tab.url)[0] || '?').toUpperCase())) {
  if (!/^(\.\.\/favicons\/|data:)/.test(tab.favicon)) return fallback
  const src = tab.favicon.startsWith('../favicons/') && skiff.assets?.favicons ? new URL(tab.favicon.slice(12), skiff.assets.favicons).href : tab.favicon
  const img = h('img', { class: 'favicon', src, alt: '', draggable: 'false' })
  img.decode().then(() => draws(img), () => false).then((shown) => shown || img.replaceWith(fallback))
  return img
}

const tabCount = (n) => `${n} ${n === 1 ? 'tab' : 'tabs'}`

// A tab an agent drives or asks for: the agent's name and a dot, pulsing while it works, steady while it waits or asks, green when it is done.
const AGENT_STATES = { working: 'working', idle: 'waiting', done: 'done', asking: 'asking for this tab' }
const agentNameOf = (tab) => tab.agentRequest?.agent || tab.agent
function agentDot(tab) {
  const name = agentNameOf(tab)
  if (!name) return null
  const state = tab.agentRequest ? 'asking' : tab.agentState
  const text = `${name}, ${AGENT_STATES[state] || state}`
  return h('span', { class: 'agent-dot', 'data-state': state, role: 'img', 'aria-label': text, title: text })
}
// A tab whose page is loaded; a favorite or pinned tab that was never opened, or is asleep, has none.
const isOpen = (tab) => Boolean(tab.lifecycle) && tab.lifecycle !== 'sleeping'
// Marks a tab that is producing sound right now.
const speaker = (tab) => (tab.protections?.audible ? h('span', { class: 'speaker', role: 'img', 'aria-label': 'Playing audio', title: 'Playing audio' }, icon('volume')) : null)
const agentBadge = (tab) => (agentNameOf(tab) ? h('span', { class: 'agent-badge' }, tab.agentRequest ? `${agentNameOf(tab)} asks` : tab.agent) : null)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const readStore = (key) => { try { return JSON.parse(localStorage.getItem(`layer.${key}`)) } catch { return null } }
const writeStore = (key, value) => { try { localStorage.setItem(`layer.${key}`, JSON.stringify(value)) } catch {} }

// A two finger swipe is a stream of wheel events, and macOS keeps a decaying momentum tail coming for up to a second after the fingers lift.
// One switch per gesture: a swipe fires once it has gone 30px, then only a pause (a new touch stops the tail first) or a reversal starts another.
// With vertical, a mostly vertical stream fires 'up' or 'down' once it has gone 40px, and nothing else fires until the next pause or a reversal.
const SWIPE_GAP = 120
// A swipe up pulls exposé open: the cards show from PEEK px of upward travel; when the stream goes quiet at COMMIT or more they stay out, under it they go home.
// Momentum counts as travel, so a flick that coasts past COMMIT opens, and fingers that stop or reverse back under COMMIT send everything home.
const PEEK = 8
const COMMIT = 72
function swipeTracker(vertical = false) {
  const s = { last: -Infinity, x: 0, y: 0, used: false, dir: 0, up: 0 }
  return {
    // Nothing fires again until the stream goes quiet.
    block(now) { Object.assign(s, { last: now, x: 0, y: 0, used: true, dir: 0, up: 0 }) },
    // x, y: one event's travel in CSS pixels. Returns 1 or -1 when a sideways swipe fires, 'up' or 'down' for a vertical one, else 0.
    step(now, x, y) {
      if (now - s.last >= SWIPE_GAP) Object.assign(s, { x: 0, y: 0, used: false })
      s.last = now
      if (vertical && Math.abs(y) > Math.abs(x) * 1.3) {
        s.x = 0
        if (s.used) {
          if (!s.up || Math.sign(y) === s.up) return 0
          Object.assign(s, { y: 0, used: false, up: 0 })
        }
        if (s.y && Math.sign(s.y) !== Math.sign(y)) s.y = 0
        s.y += y
        if (Math.abs(s.y) < 40) return 0
        Object.assign(s, { used: true, dir: 0, up: Math.sign(s.y) })
        // With natural scrolling, fingers moving up send a positive deltaY; spaceSwiper flips it when that is off.
        return s.y > 0 ? 'up' : 'down'
      }
      s.y = 0
      if (!x || Math.abs(x) <= Math.abs(y) * 1.3) { s.x = 0; return 0 }
      if (s.used && s.dir && Math.sign(x) !== s.dir) Object.assign(s, { x: 0, used: false })
      if (s.used) return 0
      if (s.x && Math.sign(s.x) !== Math.sign(x)) s.x = 0
      s.x += x
      if (Math.abs(s.x) < 30) return 0
      Object.assign(s, { used: true, dir: Math.sign(s.x) })
      return s.dir
    }
  }
}

// A space switch by a two finger swipe, as the Buoy, the card and the ears make it: the space comes in front of other apps.
// With expose (the Buoy and the ears), a swipe up pulls exposé open as the fingers travel (expose.js follows 'expose-pull' and decides when it commits) and a swipe down closes it.
// The momentum tail can land on another view once the windows have slid, so a switch anywhere holds every other view's tracker until its stream goes quiet.
function spaceSwiper(expose = false) {
  const swipe = swipeTracker(expose)
  const me = Math.random()
  // The time of the stream's last event, its upward travel so far, whether the window came forward for it, whether a space switch has claimed it, and the travel not yet sent.
  let last = -Infinity
  let up = 0
  let raised = false
  let claimed = false
  let unsent = 0
  let timer = 0
  let sentAt = -Infinity
  const claim = (now) => { last = now; claimed = true; swipe.block(now) }
  const send = () => {
    clearTimeout(timer)
    timer = 0
    if (!unsent) return
    sentAt = performance.now()
    const dy = unsent
    unsent = 0
    skiff.call('ui.emit', { name: 'expose-pull', data: { dy }, focus: false }).catch(() => {})
  }
  skiff.on('space-swiped', (data) => { if (data?.from !== me) claim(performance.now()) })
  return {
    block: claim,
    step(now, x, y) {
      if (now - last >= SWIPE_GAP) { up = 0; raised = false; claimed = false }
      last = now
      // Fingers up is a positive deltaY with natural scrolling; the travel sent is positive for fingers up either way.
      if (expose && !claimed && Math.abs(y) > Math.abs(x) * 1.3) {
        const dy = state?.naturalScroll === false ? -y : y
        up = Math.max(0, up + dy)
        // Exposé draws in the desk window, so from the Buoy over another app the window comes forward first or it opens out of sight.
        if (!raised && up >= 8) { raised = true; skiff.call('ui.raise').catch(() => {}) }
        unsent += dy
        // At most one message per frame, and none late: a hidden view's timers can wait a second.
        if (performance.now() - sentAt >= 16) send()
        else timer ||= setTimeout(send, 16)
      }
      const step = swipe.step(now, x, y)
      if (step === 'up' || step === 'down') {
        // The tracker reads fingers up as 'up' only with natural scrolling.
        if ((state?.naturalScroll === false ? (step === 'up' ? 'down' : 'up') : step) === 'down') skiff.call('ui.emit', { name: 'expose', data: { close: true }, focus: false }).catch(() => {})
        return 0
      }
      if (typeof step !== 'number' || !step) return 0
      claimed = true
      skiff.call('ui.raise').catch(() => {})
      skiff.call('spaces.cycle', { delta: step }).catch(() => {})
      skiff.call('ui.emit', { name: 'space-swiped', data: { from: me }, focus: false }).catch(() => {})
      return step
    }
  }
}

/* ---------- the desk, as the core lays it out ---------- */

// The base page fills the desk window; every other view learns its size from the state.
const deskSize = (state) => state?.deskSize || { width: innerWidth, height: innerHeight }
const isPlain = (t) => !t.favorite && !t.pinned
// The space's tabs in the core's order: favorites, pinned, then the ordinary tabs in trail order.
function visibleTabs(state, spaceId) {
  const tabs = state.tabs.filter((t) => t.spaceId === spaceId)
  const trail = (parentId) => tabs.filter((t) => isPlain(t) && t.parentId === parentId).flatMap((t) => [t, ...trail(t.id)])
  return [...tabs.filter((t) => t.favorite), ...tabs.filter((t) => t.pinned && !t.favorite), ...trail(undefined)]
}
// The core's cascade for a shown tab that has never been placed.
function defaultRect(state, tab) {
  const { width: W, height: H } = deskSize(state)
  const w = Math.max(240, Math.round(W * 0.62))
  const h = Math.max(160, Math.round(H * 0.74))
  const k = Math.max(1, Math.floor(Math.min(W - w, H - h) / 2 / 28) + 1)
  const n = Math.max(0, visibleTabs(state, tab.spaceId).indexOf(tab)) % k
  return { x: Math.round((W - w) / 2) + 28 * n, y: Math.round((H - h) / 2) + 28 * n, width: w, height: h }
}
const rectOf = (state, tab) => (tab.desk ? { x: tab.desk.x, y: tab.desk.y, width: tab.desk.width, height: tab.desk.height } : defaultRect(state, tab))
const activeTabOf = (state) => state.tabs.find((t) => t.id === state.activeTabBySpace[state.activeSpaceId])
// A space's active tab is shown, except one an old save left active in a space that is not (it comes back when that space does); the core's isShown says the same.
const isShown = (state, tab) => (state.activeTabBySpace[tab.spaceId] === tab.id && (tab.spaceId === state.activeSpaceId || !tab.desk?.hidden)) || (tab.desk ? !tab.desk.hidden : isPlain(tab) && !tab.agent)
const isPrivateSpace = (state, spaceId) => Boolean(state.spaces.find((s) => s.id === spaceId)?.incognito)
// The core sets state.desktops only where macOS desktops are known; each tab belongs to one, and the desk shows the current desktop's.
const onDesktop = (state, tab) => !state.desktops || tab.desktopId === state.desktops.current
// Labels exist only with two or more desktops.
const desktopOf = (state, tab) => (state.desktops?.list.length > 1 ? state.desktops.list.find((d) => d.id === tab.desktopId) : null)
// Back to front, as the core stacks them: unplaced windows, placed ones by z, then the active tab; only the foreground set while there is one.
// Every ordinary space shares the desk; while incognito is active it is the desk's only space.
function deskWindows(state) {
  const active = activeTabOf(state)
  const only = state.deskOnly
  const priv = isPrivateSpace(state, state.activeSpaceId)
  const shown = state.tabs.filter((t) => t !== active && !t.userPeek && isPrivateSpace(state, t.spaceId) === priv && onDesktop(state, t) && isShown(state, t) && (!only || only.includes(t.id)))
  const list = [...shown.filter((t) => !t.desk), ...shown.filter((t) => t.desk).sort((a, b) => a.desk.z - b.desk.z || a.lastActiveAt - b.lastActiveAt)]
  if (active) list.push(active)
  return list.map((tab) => ({ tab, active: tab === active, rect: rectOf(state, tab) }))
}
// A quiet dot in a window's space colour; none while there is only one ordinary space to tell apart.
function windowSpace(state, tab) {
  const space = state.spaces.filter((s) => !s.incognito).length > 1 && state.spaces.find((s) => s.id === tab.spaceId && !s.incognito)
  if (!space) return null
  const dot = h('span', { class: 'window-space', title: space.name })
  dot.style.setProperty('--space', space.color)
  return dot
}
/* ---------- ears: each window's tag on its top edge, clear of whatever is drawn in front of it ---------- */

const EAR_HEIGHT = 26
// Kept off the page's rounded corners.
const EAR_CORNER = 10
// How far a window's ring and shadow reach past its page, and the space an ear keeps from anything in front.
const EAR_RIM = 4
const EAR_GAP = 6
// Favicon alone, and the cap with a long title.
const EAR_MIN = 33
const EAR_MAX = 280
// The ear's padding, favicon and gap around its title.
const EAR_CHROME = 40
// The gap between title and host.
const EAR_HOST_GAP = 7
const earWidths = new Map()
// An ear as wide as its whole title and host, measured in the page's #ear-measure; clear earWidths once the shell's font arrives.
function earNatural(tab) {
  const title = earTitle(tab)
  const host = earHost(tab)
  const key = `${title}\n${host}`
  let width = earWidths.get(key)
  if (width !== undefined) return width
  if (earWidths.size > 500) earWidths.clear()
  const measure = document.getElementById('ear-measure')
  const textWidth = (text) => {
    measure.textContent = text
    return Math.ceil(measure.getBoundingClientRect().width)
  }
  width = Math.min(EAR_MAX, textWidth(title) + (host ? EAR_HOST_GAP + textWidth(host) : 0) + EAR_CHROME)
  earWidths.set(key, width)
  return width
}
// ponytail: the unread count is read from the title only ("(3) WhatsApp", "Inbox (3) - ..."); the app badge or Notification hooks come when a site needs them.
const siteNotice = (tab) => (/^\(([1-9]\d{0,2}\+?)\)\s|^Inbox \(([1-9]\d{0,2}\+?)\) - /.exec(tab.title || '') || []).slice(1).find(Boolean) || ''
const earTitle = (tab) => tab.title || hostOf(tab.url) || 'New tab'
// Shown after the title for web pages only; a chat tab has no host.
const earHost = (tab) => (/^https?:/.test(tab.url) ? hostOf(tab.url) : '')

/* ---------- the offer on a tab the bar just opened: do the other thing with the same text (tabs.reroute) ---------- */

const OFFER_LIFE = 8000
const OFFER_FADE = 600
// The pill's words, or null for a tab with no offer.
function offerLabel(state, tab) {
  if (!tab.intent) return null
  if (tab.intent.sent === 'ask') {
    const engine = SEARCH_ENGINES.find((e) => e.url === state.settings.searchUrl)
    return `Meant to search ${engine ? engine.name : hostOf(state.settings.searchUrl) || 'the web'}?`
  }
  const { agent, agents } = state.settings.ai
  return `Meant to ask ${agent || agents[0]?.name || 'an agent'}?`
}
// Milliseconds the offer has left; paused is how long hovering held it.
const offerLeft = (tab, paused = 0) => OFFER_LIFE - (Date.now() - tab.intent.at - paused)

// span: [left, right] of the top edge; occluders: [left, right] of whatever covers the ear's row. The leftmost free stretch that takes the
// whole ear wins, else the widest one, the ear shrunk to it, else none. Returns {x, width, room}, room being the free stretch from x.
function earSlot(span, occluders, natural, min = EAR_MIN) {
  const [lo, hi] = span
  const free = []
  let at = lo
  for (const [a, b] of occluders.map(([a, b]) => [a - EAR_GAP, b + EAR_GAP]).sort((p, q) => p[0] - q[0])) {
    if (a > at && at < hi) free.push([at, Math.min(a, hi)])
    at = Math.max(at, b)
  }
  if (at < hi) free.push([at, hi])
  const whole = free.find(([a, b]) => b - a >= natural)
  if (whole) return { x: whole[0], width: natural, room: Math.floor(whole[1] - whole[0]) }
  const widest = free.reduce((best, f) => (!best || f[1] - f[0] > best[1] - best[0] ? f : best), null)
  if (!widest || widest[1] - widest[0] < min) return null
  const width = Math.floor(widest[1] - widest[0])
  return { x: widest[0], width, room: width }
}

// windows: back to front, {id, rect, natural, after?, slot?}, after being room kept free beside the ear for its offer; a given slot (the window being dragged) is kept. fixed: rects always on top (the Buoy).
// Front ears are placed first, so each ear dodges the windows, ears, Buoy and panel drawn above it. Returns {id: slot or null}.
function earLayout(windows, fixed = [], deskWidth = Infinity) {
  // The ring reaches past a page on three sides, not over its top, where the ears stand: a window stacked exactly on another must not hide its ear.
  const grow = (r, by) => ({ x: r.x - by, y: r.y, width: r.width + 2 * by, height: r.height + by })
  const above = fixed.map((r) => grow(r, EAR_RIM))
  const slots = {}
  for (const w of [...windows].reverse()) {
    const r = w.rect
    const top = r.y - EAR_HEIGHT
    let slot = w.slot
    if (slot === undefined) {
      const row = above.filter((o) => o.y < r.y && o.y + o.height > top).map((o) => [o.x, o.x + o.width])
      slot = earSlot([Math.max(0, r.x + EAR_CORNER), Math.min(deskWidth, r.x + r.width - EAR_CORNER)], row, w.natural)
    }
    slots[w.id] = slot
    above.push(grow(r, EAR_RIM))
    if (slot) above.push({ x: slot.x, y: top, width: slot.width + (w.after || 0), height: EAR_HEIGHT })
  }
  return slots
}
const windowCount = (n) => `${n} ${n === 1 ? 'window' : 'windows'}`

function paintSpace(state) {
  const space = state.spaces.find((s) => s.id === state.activeSpaceId)
  document.documentElement.style.setProperty('--accent', space.color)
  document.documentElement.classList.toggle('incognito', Boolean(space.incognito))
  return space
}

/* ---------- the Buoy and what opens from it ---------- */

const GAP = 8
const BUOY_HEIGHT = 30
// Room around an overlay's card for its shadow.
const SHADOW = 32
const TABLIST_WIDTH = 300
const POPUP_SIZE = { width: 440, height: 560 }

// The Buoy's place as it last said while being dragged or resized; the stored one until then.
let buoyPlace = null
skiff.on('buoy-moved', (place) => { buoyPlace = place || null })

// Saved against its nearest sides (or centred), so the Buoy keeps its corner when the desk changes size.
function buoyRect(state, place = buoyPlace || readStore('buoy')) {
  const { width: W, height: H } = deskSize(state)
  const width = Math.min(place?.width || 200, W - 2 * GAP)
  const x = !place ? 12 : place.ax === 'r' ? W - place.x - width : place.ax === 'c' ? (W - width) / 2 + place.x : place.x
  const y = !place ? H - BUOY_HEIGHT - GAP : place.ay === 'b' ? H - place.y - BUOY_HEIGHT : place.y
  return { x: Math.round(clamp(x, GAP, W - GAP - width)), y: Math.round(clamp(y, GAP, H - GAP - BUOY_HEIGHT)), width, height: BUOY_HEIGHT }
}
const overlapsRect = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height

/* ---------- layouts: the core's named rects (desk.layouts), offered as a strip of small desks while a window is dragged ---------- */

const LAYOUT_GROUPS = [['fill', 'center'], ['left', 'right', 'top', 'bottom'], ['left-third', 'center-third', 'right-third', 'left-two-thirds', 'right-two-thirds'], ['top-left', 'top-right', 'bottom-left', 'bottom-right']]
const LAYOUT_LABELS = {
  fill: 'Fill', center: 'Centre', left: 'Left half', right: 'Right half', top: 'Top half', bottom: 'Bottom half',
  'left-third': 'Left third', 'center-third': 'Centre third', 'right-third': 'Right third', 'left-two-thirds': 'Left two thirds', 'right-two-thirds': 'Right two thirds',
  'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right'
}
const STRIP_CELL = 44
const STRIP_PAD = 8
const STRIP_GAP = 4
const STRIP_GROUP_GAP = 14
// How far past the card the pointer may stray before the strip closes.
const STRIP_SLACK = 12

// Under the top middle of the desk, in desk CSS pixels: the card, its cells (each a small desk at the desk's aspect) and the overlay's bounds around them.
function layoutStrip(state) {
  const { width: W, height: H } = deskSize(state)
  const ch = clamp(Math.round(STRIP_CELL * H / W), 22, 36)
  const cells = []
  let x = STRIP_PAD
  LAYOUT_GROUPS.forEach((group, i) => {
    if (i) x += STRIP_GROUP_GAP - STRIP_GAP
    for (const name of group) {
      cells.push({ name, x, y: STRIP_PAD, width: STRIP_CELL, height: ch })
      x += STRIP_CELL + STRIP_GAP
    }
  })
  const width = x - STRIP_GAP + STRIP_PAD
  const card = { x: Math.round((W - width) / 2), y: GAP, width, height: ch + 2 * STRIP_PAD }
  for (const c of cells) Object.assign(c, { x: c.x + card.x, y: c.y + card.y })
  const x0 = Math.max(0, card.x - SHADOW), y0 = Math.max(0, card.y - SHADOW)
  const bounds = { x: x0, y: y0, width: Math.min(W, card.x + card.width + SHADOW) - x0, height: Math.min(H, card.y + card.height + SHADOW) - y0 }
  return { card, cells, bounds }
}
// Anywhere on the card picks the cell nearest along the row; off the card (past the slack) picks nothing.
function stripCellAt(strip, p) {
  const c = strip.card
  if (p.x < c.x - STRIP_SLACK || p.x >= c.x + c.width + STRIP_SLACK || p.y < c.y - STRIP_SLACK || p.y >= c.y + c.height + STRIP_SLACK) return null
  const mid = (cell) => cell.x + cell.width / 2
  return strip.cells.reduce((best, cell) => (Math.abs(p.x - mid(cell)) < Math.abs(p.x - mid(best)) ? cell : best)).name
}

// A card opening from the Buoy: above it in the lower half of the desk, below it in the upper half, flush with its side.
function anchor(state, width, height) {
  const { width: W, height: H } = deskSize(state)
  const b = buoyRect(state)
  const above = b.y + b.height / 2 > H / 2
  const room = Math.max(120, above ? b.y - 2 * GAP : H - b.y - b.height - 2 * GAP)
  const w = Math.min(width, W - 2 * GAP)
  const h = Math.min(Math.ceil(height), room)
  const mid = b.x + b.width / 2
  const side = mid < W / 3 ? 'left' : mid > W * 2 / 3 ? 'right' : 'centre'
  const x = clamp(side === 'left' ? b.x : side === 'right' ? b.x + b.width - w : mid - w / 2, GAP, W - GAP - w)
  const y = clamp(above ? b.y - GAP - h : b.y + b.height + GAP, 0, H - h)
  const x0 = Math.max(0, Math.floor(x - SHADOW)), y0 = Math.max(0, Math.floor(y - SHADOW))
  const bounds = { x: x0, y: y0, width: Math.min(W, Math.ceil(x + w + SHADOW)) - x0, height: Math.min(H, Math.ceil(y + h + SHADOW)) - y0 }
  return { bounds, card: { x: x - x0, y: y - y0, width: w, height: h, room, bottom: bounds.height - (y - y0) - h }, above, side }
}

// The base page handles every Buoy action, since it alone tracks the open overlays.
const buoyAction = (action, data) => skiff.call('ui.emit', { name: 'buoy', data: { action, ...data }, focus: false }).catch(() => {})

// The overlay this page is shown in: the tab list in 'tabs'.
let overlayName = 'main'
// Set while this overlay is open; a hidden overlay must not show itself again by refitting.
let overlayOpen = false
let fitted = ''
skiff.on('overlay-closed', (data) => {
  if ((data?.name || 'main') !== overlayName) return
  overlayOpen = false
  fitted = ''
})
function closeOverlay(name = overlayName, data = {}) {
  if (name === overlayName) {
    overlayOpen = false
    fitted = ''
  }
  return skiff.call('ui.hideOverlay', { name }).catch(() => {}).then(() => skiff.call('ui.emit', { name: 'overlay-closed', data: { ...data, name }, focus: false })).catch(() => {})
}
// A freshly opened overlay grows out of the Buoy, from the side it sits on.
function grow(el) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const from = document.documentElement.classList.contains('above') ? 10 : -10
  el.animate([{ opacity: 0, transform: `translateY(${from}px) scale(.95)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' })
}
document.documentElement.classList.toggle('mac', navigator.userAgent.includes('Mac'))
const appearance = matchMedia('(prefers-color-scheme: dark)')
let backgroundKey
// Paints the accent, the incognito theme and an imported Arc background; `painted` is how far across the window the painted surface reaches.
function renderBackground(space, painted) {
  const root = document.documentElement
  root.style.setProperty('--accent', space.color)
  root.classList.toggle('incognito', Boolean(space.incognito))
  const dark = appearance.matches
  const layer = !space.incognito && space.background?.[dark ? 'dark' : 'light']
  // Ink is judged over the colors under the painted surface, so its share of the window width is part of the key.
  const span = layer ? Math.min(1, Math.ceil(painted / innerWidth * 50) / 50) : 0
  const key = JSON.stringify([dark, layer, span])
  if (key === backgroundKey) return
  backgroundKey = key
  for (const property of ['--bg', '--canvas', '--ink', '--soft', '--ring', '--danger', '--space-background']) root.style.removeProperty(property)
  root.classList.toggle('imported-background', Boolean(layer))
  if (!layer) return
  const rgba = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1)
  const mix = (a, b, amount) => a.slice(0, 3).map((v, i) => v * amount + b[i] * (1 - amount))
  // Calibrated against Arc: two thirds of the intensity is how much of each color shows over the layer color.
  const strength = layer.intensity * 2 / 3
  const base = mix(rgba(layer.color), dark ? [0, 0, 0] : [1, 1, 1], rgba(layer.color)[3])
  const colors = layer.colors?.length ? layer.colors.map(rgba).map((color) => mix(color, base, color[3] * strength)) : [base]
  const overlays = layer.overlayColors?.map(rgba) || []
  // Base colors run left to right and overlays top to bottom, so shell text sits on the base stops up to the painted edge under every overlay stop.
  const edge = span * (colors.length - 1)
  const under = colors.filter((_, i) => i <= edge)
  if (edge % 1) under.push(mix(colors[Math.ceil(edge)], colors[Math.floor(edge)], edge % 1))
  const samples = [base, ...under, ...under.flatMap((color) => overlays.map((overlay) => mix(overlay, color, overlay[3] * strength)))]
  // Component-wise bounds also cover darker intermediate sRGB mixtures.
  samples.push([0, 1, 2].map((i) => Math.min(...samples.map((sample) => sample[i]))))
  const luminance = (rgb) => rgb.map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const gray = (v) => [v, v, v]
  // Worst contrast of black (0) or white (1) ink over the veiled samples, measured on a hovered row (7% ink).
  const worst = (ink, veil) => Math.min(...samples.map((sample) => {
    const lum = luminance(mix(gray(ink), mix(gray(1 - ink), sample, veil), .07))
    return ink ? 1.05 / (lum + .05) : (lum + .05) / .05
  }))
  const ink = worst(1, 0) > worst(0, 0) ? 1 : 0
  let steps = 0
  while (steps < 40 && worst(ink, steps / 40) < 4.5) steps++
  const veil = steps / 40
  const css = (rgb, alpha = 1) => `rgb(${rgb.slice(0, 3).map((v) => Math.round(v * 255)).join(' ')} / ${alpha})`
  const gradient = (side, stops) => `linear-gradient(to ${side} in srgb, ${stops.concat(stops.length === 1 ? stops : []).join(', ')})`
  const layers = []
  if (veil) layers.push(gradient('right', [css(gray(1 - ink), veil)]))
  if (overlays.length) layers.push(gradient('bottom', overlays.map((color) => css(color, color[3] * strength))))
  layers.push(gradient('right', colors.map((color) => css(color))))
  const solid = css(mix(gray(1 - ink), base, veil))
  root.style.setProperty('--space-background', layers.join(', '))
  root.style.setProperty('--bg', solid)
  root.style.setProperty('--canvas', solid)
  for (const property of ['--ink', '--soft', '--ring', '--danger']) root.style.setProperty(property, ink ? '#ffffff' : '#000000')
}

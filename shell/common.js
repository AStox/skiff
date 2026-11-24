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
const agentBadge = (tab) => (agentNameOf(tab) ? h('span', { class: 'agent-badge' }, tab.agentRequest ? `${agentNameOf(tab)} asks` : tab.agent) : null)

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

'use strict'

const PLACEHOLDER = 'Search or enter address'
const HOST = /^(localhost|\[[0-9a-f:]+\]|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
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
  const img = h('img', { class: 'favicon', src: tab.favicon, alt: '', draggable: 'false' })
  img.decode().then(() => draws(img), () => false).then((shown) => shown || img.replaceWith(fallback))
  return img
}

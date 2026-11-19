'use strict'

const PLACEHOLDER = 'Search or enter address'
// The pill overlay hugs the bottom left corner; the pill page narrows the width to its own size once drawn.
const PILL_BOUNDS = { x: 0, y: -46, width: 240, height: 46 }
const showPill = (width = PILL_BOUNDS.width) => skiff.call('ui.showOverlay', { file: 'pill.html', bounds: { ...PILL_BOUNDS, width } })
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

const tabCount = (n) => `${n} ${n === 1 ? 'tab' : 'tabs'}`

// Host in ink, the rest tinted; anything that is not a web address shows whole.
function showAddress(button, url) {
  button.classList.toggle('placeholder', !url)
  button.title = url || ''
  if (!url) return button.replaceChildren(PLACEHOLDER)
  let parsed
  try { parsed = new URL(url) } catch { return button.replaceChildren(h('span', {}, url)) }
  if (!/^https?:$/.test(parsed.protocol)) return button.replaceChildren(h('span', {}, url))
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  button.replaceChildren(h('b', {}, parsed.host.replace(/^www\./, '')), h('span', {}, rest === '/' ? '' : rest))
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

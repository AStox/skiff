'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' }
const ICON_MAX = 256 * 1024
const DATA_MAX = 64 * 1024
const HTML_MAX = 512 * 1024

const isWeb = (url) => typeof url === 'string' && /^https?:\/\//i.test(url) && URL.canParse(url)
const originOf = (url) => (isWeb(url) ? new URL(url).origin : '')

function sniff(bytes) {
  const head = bytes.subarray(0, 1024).toString('latin1')
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'png'
  if (head.startsWith('\xff\xd8\xff')) return 'jpg'
  if (/^GIF8[79]a/.test(head)) return 'gif'
  if (/^RIFF[\s\S]{4}WEBP/.test(head)) return 'webp'
  if (head.startsWith('\0\0\x01\0')) return 'ico'
  if (/^(\xef\xbb\xbf)?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg'
}

// ponytail: regex over tags, ignores <base> and commented-out links; use a real HTML parser if sites get this wrong
function pickIcon(html, pageUrl) {
  let best
  let bestSize = -1
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((v) => v !== undefined) || ''
    const href = attr('href').replaceAll('&amp;', '&')
    if (!href || !/(^|\s)icon(\s|$)/i.test(attr('rel')) || !URL.canParse(href, pageUrl)) continue
    const url = new URL(href, pageUrl).href
    const size = /\bany\b/i.test(attr('sizes')) ? Infinity : Math.max(0, ...[...attr('sizes').matchAll(/(\d+)x\d+/gi)].map((m) => Number(m[1])))
    if (isWeb(url) && size > bestSize) [best, bestSize] = [url, size]
  }
  return best || (isWeb(pageUrl) ? new URL('/favicon.ico', pageUrl).href : '')
}

// Resolves to {url, bytes}, where bytes may run past the limit, or to undefined on any failure.
async function get(fetch, url, limit) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) return
    const chunks = []
    let size = 0
    for await (const chunk of res.body || []) {
      chunks.push(chunk)
      if ((size += chunk.length) > limit) break
    }
    if (!ac.signal.aborted) return { url: res.url, bytes: Buffer.concat(chunks) }
  } catch {
  } finally {
    clearTimeout(timer)
    ac.abort()
  }
}

async function getIcon(fetch, iconUrl, limit, pageUrl) {
  const got = isWeb(iconUrl) && await get(fetch, iconUrl, limit)
  const ext = got && got.bytes.length <= limit && sniff(got.bytes)
  if (ext) return { ext, bytes: got.bytes }
  const fallback = isWeb(pageUrl) ? new URL('/favicon.ico', pageUrl).href : iconUrl
  if (fallback !== iconUrl) return getIcon(fetch, fallback, limit)
}

const hashOf = (iconUrl) => crypto.createHash('sha256').update(iconUrl).digest('hex').slice(0, 24)

// Writes image bytes under the hashed name of their icon URL, replacing a file of the same type. '' when they are not a usable image.
// ponytail: icon files are never deleted; sweep files no tab or archive entry names if the folder grows
function storeIcon(dir, iconUrl, bytes) {
  const ext = isWeb(iconUrl) && bytes.length <= ICON_MAX && sniff(bytes)
  if (!ext) return ''
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${hashOf(iconUrl)}.${ext}`), bytes)
  return `../favicons/${hashOf(iconUrl)}.${ext}`
}

async function saveIcon(dir, fetch, iconUrl, pageUrl) {
  if (!isWeb(iconUrl)) return ''
  const file = Object.keys(TYPES).map((ext) => `${hashOf(iconUrl)}.${ext}`).find((name) => fs.existsSync(path.join(dir, name)))
  if (file) return `../favicons/${file}`
  const icon = await getIcon(fetch, iconUrl, ICON_MAX, pageUrl)
  return icon ? storeIcon(dir, iconUrl, icon.bytes) : ''
}

async function dataIcon(fetch, iconUrl, pageUrl) {
  const icon = await getIcon(fetch, iconUrl, DATA_MAX, pageUrl)
  return icon ? `data:${TYPES[icon.ext]};base64,${icon.bytes.toString('base64')}` : ''
}

async function findIcon(fetch, pageUrl) {
  const page = await get(fetch, pageUrl, HTML_MAX)
  const url = isWeb(page?.url) ? page.url : pageUrl
  return { url, icon: pickIcon(page ? page.bytes.subarray(0, HTML_MAX).toString() : '', url) }
}

// tabs() returns the live tab objects eligible for a saved icon. Each origin is tried once per app run.
function createPrefetch({ dir, fetch, tabs, changed }) {
  const tried = new Set()
  const queue = []
  let workers = 0
  const missing = (url) => tabs().filter((t) => !t.favicon && originOf(t.url) === originOf(url))
  const work = async () => {
    for (let url; (url = queue.shift());) {
      try {
        const found = missing(url).length && await findIcon(fetch, url)
        const favicon = found ? await saveIcon(dir, fetch, found.icon, found.url) : ''
        const hits = favicon ? missing(url) : []
        for (const hit of hits) hit.favicon = favicon
        if (hits.length) changed()
      } catch {}
    }
    workers--
  }
  return () => {
    const list = tabs().filter((t) => !t.favicon)
    for (const tab of [...list.filter((t) => t.favorite), ...list.filter((t) => !t.favorite)]) {
      const origin = originOf(tab.url)
      if (!origin || tried.has(origin)) continue
      tried.add(origin)
      queue.push(tab.url)
    }
    const started = []
    for (let n = Math.min(4 - workers, queue.length); n > 0; n--) {
      workers++
      started.push(work())
    }
    return Promise.all(started)
  }
}

module.exports = { sniff, pickIcon, storeIcon, saveIcon, dataIcon, originOf, createPrefetch }

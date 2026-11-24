'use strict'
const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 }
const SECRET = /pass|token|secret|cookie|authorization|credential|otp|key$/i
// Credentials in URLs: userinfo and sensitive query/fragment parameters.
const URL_SECRET = /([?&#;][^=&#;\s]*(?:pass|token|secret|cookie|auth|credential|otp|key|code|session|sig)[^=&#;\s]*=)[^&#;\s]*/gi
const URL_USER = /(\/\/[^/\s:@]+:)[^/\s@]+@/g
const RESERVED = new Set(['t', 'lvl', 'scope', 'msg'])
const LIMITS = { string: 2048, depth: 4, keys: 40, items: 20, budget: 12288, stack: 4096 }

const clean = (text) => text.replace(URL_USER, '$1[redacted]@').replace(URL_SECRET, '$1[redacted]')
const clip = (text, max = LIMITS.string) => text.length > max ? `${clean(text.slice(0, max))}...[+${text.length - max}]` : clean(text)

// Bounded, JSON-safe copy of anything; never throws. Secrets by key are replaced, the rest is capped in depth, width and total size.
function sanitize(value, limits = LIMITS) {
  const budget = { left: limits.budget }
  const walk = (item, depth, key) => {
    if (budget.left <= 0) return '[truncated]'
    if (key !== undefined && SECRET.test(key)) return '[redacted]'
    if (item === null || item === undefined || typeof item === 'boolean') return item ?? null
    if (typeof item === 'number') return Number.isFinite(item) ? item : String(item)
    if (typeof item === 'string') { const text = clip(item, limits.string); budget.left -= text.length; return text }
    if (typeof item === 'bigint') return String(item)
    if (typeof item === 'function') return '[function]'
    if (typeof item === 'symbol') return item.toString()
    if (item instanceof Error) {
      const out = { name: item.name, message: clip(String(item.message)), ...(item.code !== undefined && { code: String(item.code) }), stack: clip(String(item.stack || ''), limits.stack) }
      budget.left -= out.message.length + out.stack.length
      return out
    }
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return `[binary ${item.byteLength} bytes]`
    if (item instanceof Date) return Number.isNaN(+item) ? 'Invalid Date' : item.toISOString()
    if (depth >= limits.depth) return Array.isArray(item) ? `[array ${item.length}]` : '[object]'
    if (Array.isArray(item)) {
      const out = item.slice(0, limits.items).map((child) => walk(child, depth + 1))
      if (item.length > limits.items) out.push(`...[+${item.length - limits.items} items]`)
      return out
    }
    if (item instanceof Map || item instanceof Set) return walk([...item].slice(0, limits.items), depth, key)
    const out = {}
    let count = 0
    for (const name of Object.keys(item)) {
      if (count++ >= limits.keys) { out['...'] = `[+${Object.keys(item).length - limits.keys} keys]`; break }
      let child
      try { child = item[name] } catch { child = '[unreadable]' }
      budget.left -= name.length
      out[name] = walk(child, depth + 1, name)
    }
    return out
  }
  try { return walk(value, 0) } catch { return '[unserializable]' }
}

// A relative "30s", "10m", "2h", "1d" or any date string, as a time in ms; null when neither.
function since(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null
  const relative = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(String(value).trim())
  if (relative) return now - Number(relative[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[relative[2]]
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

function createLogger({ dir, file = 'skiff.log', maxBytes = 20 * 1024 * 1024, files = 5, level = 'debug', flushMs = 100, now = Date.now } = {}) {
  const base = path.basename(file, '.log')
  const nameOf = (index) => path.join(dir, index ? `${base}.${index}.log` : file)
  let threshold = LEVELS[level] ?? LEVELS.debug
  let queue = []
  let queued = 0
  let size = 0
  let timer = null
  let draining = null
  let ready = false
  const open = () => { try { fs.mkdirSync(dir, { recursive: true }); size = fs.existsSync(nameOf(0)) ? fs.statSync(nameOf(0)).size : 0; return true } catch { return false } }
  ready = open()

  async function rotate() {
    await fs.promises.rm(nameOf(files - 1), { force: true })
    for (let index = files - 2; index >= 0; index--) await fs.promises.rename(nameOf(index), nameOf(index + 1)).catch(() => {})
    size = 0
  }
  async function drain() {
    while (queue.length) {
      const chunk = queue.join('')
      queue = []
      queued = 0
      try {
        if (size > 0 && size + Buffer.byteLength(chunk) > maxBytes) await rotate()
        await fs.promises.mkdir(dir, { recursive: true })
        await fs.promises.appendFile(nameOf(0), chunk)
        size += Buffer.byteLength(chunk)
      } catch {}
    }
  }
  const kick = () => {
    timer = null
    draining ??= drain().finally(() => { draining = null })
    return draining
  }
  function line(lvl, scope, msg, data) {
    const entry = { t: new Date(now()).toISOString(), lvl, scope, msg: clip(String(msg), 4096) }
    const extra = data === undefined ? null : sanitize(data)
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) for (const [name, value] of Object.entries(extra)) entry[RESERVED.has(name) ? `_${name}` : name] = value
    else if (extra !== null) entry.data = extra
    return `${JSON.stringify(entry)}\n`
  }
  function write(lvl, scope, msg, data) {
    try {
      if (!ready || LEVELS[lvl] < threshold) return
      const text = line(lvl, scope, msg, data)
      queue.push(text)
      queued += text.length
      if (queued > 65536) kick()
      else timer ??= setTimeout(kick, flushMs)
    } catch {}
  }
  async function flush() {
    clearTimeout(timer)
    timer = null
    while (queue.length || draining) await (draining ?? kick())
  }
  // For a dying process: the async queue may never run again.
  function flushSync() {
    try {
      clearTimeout(timer)
      timer = null
      const chunk = queue.join('')
      queue = []
      queued = 0
      if (chunk) { fs.appendFileSync(nameOf(0), chunk); size += Buffer.byteLength(chunk) }
    } catch {}
  }
  const scope = (name) => Object.fromEntries(Object.keys(LEVELS).map((lvl) => [lvl, (msg, data) => write(lvl, name, msg, data)]))

  async function tail({ lines = 200, level: min, scope: wanted, grep, since: from } = {}) {
    await flush()
    lines = Math.max(1, Math.min(5000, Math.floor(lines) || 200))
    const floor = min ? LEVELS[min] ?? 0 : 0
    const after = since(from, now())
    let match = null
    if (grep) { try { match = new RegExp(grep, 'i') } catch { const needle = String(grep).toLowerCase(); match = { test: (text) => text.toLowerCase().includes(needle) } } }
    const out = []
    for (let index = 0; index < files && out.length < lines; index++) {
      let text
      try { text = await fs.promises.readFile(nameOf(index), 'utf8') } catch { continue }
      const found = []
      for (const raw of text.split('\n')) {
        if (!raw) continue
        if (match && !match.test(raw)) continue
        let entry = null
        if (floor || wanted || after !== null) {
          try { entry = JSON.parse(raw) } catch { continue }
          if (LEVELS[entry.lvl] < floor) continue
          if (wanted && !(entry.scope === wanted || entry.scope?.startsWith(`${wanted}.`))) continue
          if (after !== null && Date.parse(entry.t) < after) continue
        }
        found.push(raw)
      }
      out.unshift(...found.slice(-(lines - out.length)))
    }
    return out
  }

  return {
    path: nameOf(0), dir, scope, write, flush, flushSync, tail,
    mark: (note) => write('info', 'mark', 'MARK', { note }),
    setLevel: (name) => { if (LEVELS[name]) threshold = LEVELS[name] },
    files: () => Array.from({ length: files }, (_, index) => nameOf(index)).filter((name) => fs.existsSync(name))
  }
}

// The process-wide logger. Lines written before init() wait in memory (bounded) and are replayed.
let active = null
const early = []
const scopes = new Map()
const forward = (lvl, name, msg, data) => {
  if (active) return active.write(lvl, name, msg, data)
  if (early.length < 2000) early.push([lvl, name, msg, data === undefined ? data : sanitize(data)])
}
function scope(name) {
  if (!scopes.has(name)) scopes.set(name, Object.fromEntries(Object.keys(LEVELS).map((lvl) => [lvl, (msg, data) => forward(lvl, name, msg, data)])))
  return scopes.get(name)
}
function init(options) {
  active = createLogger({ level: process.env.SKIFF_LOG_LEVEL, ...options })
  for (const entry of early.splice(0)) active.write(...entry)
  return active
}
const current = () => active
let captured = false
// Keep printing, and also record main-process console output.
function captureConsole() {
  if (captured) return
  captured = true
  const log = scope('console')
  for (const [method, lvl] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console)
    console[method] = (...args) => {
      original(...args)
      try { log[lvl](util.format(...args)) } catch {}
    }
  }
}

module.exports = { createLogger, sanitize, since, scope, init, current, captureConsole, LEVELS }

'use strict'
const fs = require('node:fs')
const S = require('./state')
const log = require('./log').scope('page-features')

const DEFAULT_TIMEOUT = 15000
const MAX_TIMEOUT = 30000
const WORLD = 999
const TEXT_LIMIT = 20000
const ARTICLE_LIMIT = 200000
const URL_LIMIT = 8192
const error = (code, message) => Object.assign(new Error(message), { code })
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : ''
const webURL = (value) => {
  if (typeof value !== 'string' || value.length > URL_LIMIT) return ''
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : '' } catch { return '' }
}
const PAGE_JS = `(() => ({ title: document.title.slice(0, 1000), url: location.href.slice(0, ${URL_LIMIT}), selection: String(getSelection() || '').slice(0, ${TEXT_LIMIT}), text: document.body ? document.body.innerText.slice(0, ${TEXT_LIMIT}) : '' }))()`
let readerSource

// Readability operates only on a clone, in an isolated world. Only text and a small
// semantic vocabulary cross back to the shell; no article HTML or attributes do.
function readerScript() {
  readerSource ??= fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8')
  return `(() => { ${readerSource}\n
    const article = new Readability(document.cloneNode(true), { maxElemsToParse: 100000, serializer: node => node }).parse();
    if (!article) return null;
    const blocks = [];
    let remaining = ${ARTICLE_LIMIT};
    const visit = node => {
      if (!remaining || blocks.length >= 2000 || node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'textarea', 'button'].includes(tag)) return;
      const type = /^h[1-6]$/.test(tag) ? 'heading' : tag === 'li' ? 'list-item' : tag === 'blockquote' ? 'quote' : tag === 'pre' ? 'pre' : tag === 'p' ? 'paragraph' : null;
      if (type) {
        const value = (node.textContent || '').trim().slice(0, remaining);
        if (value) { blocks.push({ type, text: value, ...(type === 'heading' ? { level: Number(tag[1]) } : {}) }); remaining -= value.length; }
      } else {
        for (const child of node.childNodes) {
          if (!remaining || blocks.length >= 2000) break;
          if (child.nodeType === 3) {
            const value = (child.textContent || '').trim().slice(0, remaining);
            if (value) { blocks.push({ type: 'paragraph', text: value }); remaining -= value.length; }
          } else visit(child);
        }
      }
    };
    visit(article.content);
    const bounded = (value, limit) => String(value ?? '').slice(0, limit);
    return { title: bounded(article.title, 1000), byline: bounded(article.byline, 1000), excerpt: bounded(article.excerpt, 2000), siteName: bounded(article.siteName, 300), url: bounded(location.href, ${URL_LIMIT}), blocks };
  })()`
}

function articleData(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) throw error('not_readable', 'No readable article was found on this page')
  let remaining = ARTICLE_LIMIT
  const blocks = []
  for (const block of raw.blocks.slice(0, 2000)) {
    if (!remaining || !block || !['paragraph', 'heading', 'quote', 'pre', 'list-item'].includes(block.type)) continue
    const value = text(block.text, remaining).trim()
    if (!value) continue
    blocks.push({ type: block.type, text: value, ...(block.type === 'heading' ? { level: Math.min(6, Math.max(1, Number.isInteger(block.level) ? block.level : 2)) } : {}) })
    remaining -= value.length
  }
  const content = blocks.map((block) => block.text).join('\n\n')
  if (!content) throw error('not_readable', 'No readable article was found on this page')
  return { title: text(raw.title, 1000), byline: text(raw.byline, 1000), excerpt: text(raw.excerpt, 2000), siteName: text(raw.siteName, 300), url: webURL(raw.url), text: content, blocks, length: content.length }
}

function createPageFeatures({ state, views, runtime, changed = () => {}, emit = () => {}, createView, destroyView, getWindow = () => null, isShown = () => false, registry }) {
  const records = new Map()
  const generations = new Map()
  const registrations = []
  let stopped = false
  const currentState = () => typeof state === 'function' ? state() : state
  const tabFor = (id) => S.getTab(currentState(), id)
  const liveRecord = (rec) => !stopped && records.get(rec.id) === rec && views.get(rec.id) === rec.view && !rec.wc.isDestroyed()
  const update = (rec, fields) => {
    if (records.get(rec.id) !== rec) return
    runtime.set(rec.id, { ...runtime.get(rec.id), ...fields })
    changed()
  }
  const findState = (rec) => ({ id: rec.id, ...rec.find })
  const readerState = (rec) => ({ id: rec.id, generation: rec.generation, active: Boolean(rec.article), loading: rec.reading })
  const publishFind = (rec) => { update(rec, { find: { ...rec.find } }); emit('page-find', findState(rec)) }
  const publishReader = (rec) => { const { id, generation, ...reader } = readerState(rec); update(rec, { reader }); emit('page-reader', { id, generation, ...reader }) }
  const resetFind = (rec, active = false) => {
    rec.find = { active, query: '', count: 0, current: 0, matchCase: false, requestId: null, generation: rec.generation }
    if (!rec.wc.isDestroyed()) { try { rec.wc.stopFindInPage('clearSelection') } catch {} }
    publishFind(rec)
  }
  const cancelOperations = (rec, code, message, initial = false) => {
    for (const operation of [...rec.pending]) {
      if (initial && operation.initial) { operation.initial = false; operation.generation = rec.generation }
      else operation.finish(error(code, message))
    }
  }
  const nextGeneration = (rec, initial = false) => {
    rec.generation = (generations.get(rec.id) || 0) + 1
    generations.set(rec.id, rec.generation)
    cancelOperations(rec, 'stale_document', 'The page changed before the operation completed', initial)
    if (!initial) {
      rec.readerRequest++
      rec.reading = false
    }
    rec.article = null
    resetFind(rec)
    publishReader(rec)
    update(rec, { generation: rec.generation })
  }
  const publishProtection = (rec) => update(rec, { protections: { ...rec.protections, dirty: [...rec.frames.values()].some((frame) => frame.dirty), media: rec.playing || [...rec.frames.values()].some((frame) => frame.media) } })

  function attach(tab, view) {
    if (stopped || tab.chat) return
    if (records.get(tab.id)?.view === view) return
    beforeDestroy(tab.id)
    const wc = view.webContents
    const generation = (generations.get(tab.id) || 0) + 1
    generations.set(tab.id, generation)
    const rec = { id: tab.id, view, wc, generation, listeners: [], pending: new Set(), frames: new Map(), previousDocuments: new Set(), protections: { ...runtime.get(tab.id)?.protections, agent: Boolean(tab.agent) }, playing: false, article: null, reading: false, readerRequest: 0, readerAbort: null, firstNavigation: !webURL(wc.getURL()), lastShownAt: Date.now(), find: null }
    records.set(tab.id, rec)
    const on = (name, listener) => { wc.on(name, listener); rec.listeners.push([name, listener]) }
    on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame) return
      const initial = rec.firstNavigation
      rec.firstNavigation = false
      nextGeneration(rec, initial)
      if (!inPlace) {
        rec.previousDocuments = new Set([...rec.frames.values()].map((frame) => frame.document))
        rec.frames.clear()
        rec.playing = false
        rec.protections.calls = false
        publishProtection(rec)
      }
      update(rec, { lifecycle: inPlace ? 'live' : 'loading', loading: !inPlace, crash: null })
    })
    on('did-start-loading', () => update(rec, { loading: true, lifecycle: 'loading' }))
    on('did-stop-loading', () => {
      if (runtime.get(rec.id)?.lifecycle !== 'crashed') update(rec, { loading: false, lifecycle: 'live' })
    })
    on('found-in-page', (_event, result) => {
      if (!rec.find.active || rec.find.generation !== rec.generation || result.requestId !== rec.find.requestId) return
      rec.find.count = Math.max(0, Number.isInteger(result.matches) ? result.matches : 0)
      rec.find.current = Math.min(rec.find.count, Math.max(0, Number.isInteger(result.activeMatchOrdinal) ? result.activeMatchOrdinal : 0))
      publishFind(rec)
    })
    on('media-started-playing', () => { rec.playing = true; publishProtection(rec) })
    on('media-paused', () => { rec.playing = false; publishProtection(rec) })
    on('audio-state-changed', (event) => { rec.protections.audible = Boolean(event?.audible); publishProtection(rec) })
    on('render-process-gone', (_event, details) => {
      cancelOperations(rec, 'page_crashed', 'The page renderer stopped')
      nextGeneration(rec)
      update(rec, { loading: false, lifecycle: 'crashed', crash: { reason: text(details?.reason, 100), exitCode: Number.isInteger(details?.exitCode) ? details.exitCode : null } })
      emit('page-crashed', { id: rec.id, ...runtime.get(rec.id).crash })
    })
    on('destroyed', () => {
      cancelOperations(rec, 'page_closed', 'The page was closed')
      beforeDestroy(rec.id)
    })
    update(rec, { generation, loading: wc.isLoading(), lifecycle: wc.isLoading() || rec.firstNavigation ? 'loading' : 'live', crash: null, reader: { active: false, loading: false } })
    resetFind(rec)
    publishProtection(rec)
  }

  function ensure(tab, create = true) {
    if (stopped) throw error('stopped', 'Page features have stopped')
    if (!tab || !S.findTab(currentState(), tab.id)) throw error('not_found', 'No such tab')
    if (tab.chat) throw error('bad_params', 'This operation requires a web page')
    const view = views.get(tab.id) || (create && createView(tab))
    if (!view || view.webContents.isDestroyed()) throw error('page_closed', 'This page is not loaded')
    if (!records.has(tab.id)) attach(tab, view)
    const rec = records.get(tab.id)
    if (runtime.get(tab.id)?.lifecycle === 'crashed') throw error('page_crashed', 'Reload this crashed page to continue')
    return rec
  }

  function perform(tab, options, work, create = true) {
    const { signal, timeout = DEFAULT_TIMEOUT } = options || {}
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) return Promise.reject(error('bad_params', `timeout must be between 1 and ${MAX_TIMEOUT} milliseconds`))
    if (signal?.aborted) return Promise.reject(error('aborted', 'The page operation was cancelled'))
    let rec
    try { rec = ensure(tab, create) } catch (e) { return Promise.reject(e) }
    return new Promise((resolve, reject) => {
      let settled = false
      let started = false
      const cleanup = []
      const operation = { generation: rec.generation, initial: rec.firstNavigation, finish: (failure, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        for (const dispose of cleanup) dispose()
        rec.pending.delete(operation)
        if (failure) reject(failure)
        else resolve(result)
      } }
      const timer = setTimeout(() => operation.finish(error('timeout', 'The page operation timed out')), timeout)
      rec.pending.add(operation)
      const abort = () => operation.finish(error('aborted', 'The page operation was cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
      cleanup.push(() => signal?.removeEventListener('abort', abort))
      if (signal?.aborted) return abort()
      const begin = () => {
        if (settled || started) return
        if (!liveRecord(rec)) return operation.finish(error('page_closed', 'The page was closed'))
        if (rec.wc.isLoading() || rec.firstNavigation) return
        if (!webURL(rec.wc.getURL())) return operation.finish(error('bad_params', 'This operation requires an HTTP or HTTPS page'))
        started = true
        operation.initial = false
        Promise.resolve().then(() => {
          if (settled) return
          return work(rec)
        }).then((result) => {
          if (settled) return
          if (!liveRecord(rec) || rec.generation !== operation.generation) return operation.finish(error('stale_document', 'The page changed before the operation completed'))
          operation.finish(null, result)
        }, (failure) => operation.finish(failure))
      }
      rec.wc.on('did-stop-loading', begin)
      cleanup.push(() => rec.wc.off('did-stop-loading', begin))
      begin()
    })
  }

  async function read(tab, options) {
    const raw = await perform(tab, options, (rec) => rec.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: PAGE_JS }]))
    return { title: text(raw?.title, 1000), url: webURL(raw?.url), selection: text(raw?.selection, TEXT_LIMIT), text: text(raw?.text, TEXT_LIMIT) }
  }

  function capture(tab, options) {
    return perform(tab, options, (rec) => {
      const host = tab.agent && getWindow(tab)
      const attached = host && !host.isDestroyed() && host.contentView?.children?.includes(rec.view)
      if (!isShown(rec.view, tab) && !attached) throw error('page_hidden', 'A detached page has no frame to capture')
      return rec.wc.capturePage()
    }, false)
  }

  function findOpen(params) {
    const rec = ensure(tabFor(params.id))
    rec.find.active = true
    publishFind(rec)
    return findState(rec)
  }
  function findUpdate(params) {
    if (typeof params.query !== 'string' || params.query.length > 1000 || (params.matchCase !== undefined && typeof params.matchCase !== 'boolean')) throw error('bad_params', 'Find needs a query of at most 1000 characters and optional matchCase boolean')
    const rec = ensure(tabFor(params.id))
    const matchCase = params.matchCase ?? rec.find.matchCase
    resetFind(rec, true)
    Object.assign(rec.find, { query: params.query, matchCase })
    if (params.query) rec.find.requestId = rec.wc.findInPage(params.query, { matchCase, forward: true, findNext: false })
    publishFind(rec)
    return findState(rec)
  }
  function findNext(params) {
    const rec = ensure(tabFor(params.id))
    if (params.forward !== undefined && typeof params.forward !== 'boolean') throw error('bad_params', 'forward must be a boolean')
    if (rec.find.query) {
      rec.find.active = true
      rec.find.requestId = rec.wc.findInPage(rec.find.query, { matchCase: rec.find.matchCase, forward: params.forward !== false, findNext: true })
      publishFind(rec)
    }
    return findState(rec)
  }
  function findClose(params) {
    const tab = tabFor(params.id)
    const rec = records.get(tab.id)
    if (rec) { resetFind(rec); return findState(rec) }
    return { id: tab.id, active: false, query: '', count: 0, current: 0, matchCase: false, requestId: null, generation: generations.get(tab.id) || 0 }
  }
  async function readerOpen(params, context = {}) {
    const tab = tabFor(params.id)
    const rec = ensure(tab)
    rec.readerAbort?.abort()
    const controller = new AbortController()
    rec.readerAbort = controller
    const request = ++rec.readerRequest
    rec.reading = true
    publishReader(rec)
    try {
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
      const raw = await perform(tab, { signal, timeout: params.timeout }, (current) => current.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: readerScript() }]))
      if (!liveRecord(rec) || request !== rec.readerRequest) throw error('aborted', 'Reader mode was closed')
      rec.article = articleData(raw)
      return { ...readerState(rec), active: true, loading: false, article: rec.article }
    } finally {
      if (records.get(rec.id) === rec && request === rec.readerRequest) { rec.readerAbort = null; rec.reading = false; publishReader(rec) }
    }
  }
  function readerGet(params) {
    const tab = tabFor(params.id)
    const rec = records.get(tab.id)
    return rec ? { ...readerState(rec), article: rec.article } : { id: tab.id, generation: generations.get(tab.id) || 0, active: false, loading: false, article: null }
  }
  function readerClose(params) {
    const tab = tabFor(params.id)
    const rec = records.get(tab.id)
    if (rec) { rec.readerAbort?.abort(); rec.readerAbort = null; rec.readerRequest++; rec.article = null; rec.reading = false; publishReader(rec) }
    return readerGet(params)
  }

  // Only the host calls this with the actual IPC event. A document can protect
  // itself, never issue browser commands or clear a protection from another frame.
  function report(id, payload, event) {
    const rec = records.get(id)
    const frame = event?.senderFrame
    if (!rec || !liveRecord(rec) || event.sender !== rec.wc || !frame || frame.detached || (frame.top || frame) !== rec.wc.mainFrame) return false
    if (!payload || typeof payload !== 'object' || typeof payload.document !== 'string' || !payload.document || payload.document.length > 100 || typeof payload.dirty !== 'boolean' || typeof payload.media !== 'boolean' || !Number.isFinite(payload.timeOrigin) || rec.previousDocuments.has(payload.document)) return false
    if (!webURL(payload.url) || payload.url !== frame.url) return false
    if (payload.generation !== rec.generation) {
      frame.send('skiff:page-state-generation', rec.generation)
      return false
    }
    const key = `${frame.processId}:${frame.routingId}`
    const previous = rec.frames.get(key)
    if (previous && previous.document === payload.document && previous.timeOrigin !== payload.timeOrigin) return false
    rec.frames.set(key, { document: payload.document, timeOrigin: payload.timeOrigin, dirty: payload.dirty || (previous?.document === payload.document && previous.dirty), media: payload.media })
    publishProtection(rec)
    return true
  }

  function protect(id, reason, active) {
    if (!['downloads', 'permissions', 'calls', 'agent'].includes(reason) || typeof active !== 'boolean') throw error('bad_params', 'Unknown page protection')
    const rec = records.get(id)
    const protections = { ...runtime.get(id)?.protections, [reason]: active }
    if (rec) { rec.protections[reason] = active; publishProtection(rec) }
    else { runtime.set(id, { ...runtime.get(id), protections }); changed() }
    return protections
  }
  function protectedReasons(tab, rec) {
    const live = runtime.get(tab.id) || {}
    const reasons = []
    if (isShown(rec.view, tab)) { rec.lastShownAt = Date.now(); reasons.push('visible') }
    const state = currentState()
    if (state.activeTabBySpace?.[state.activeSpaceId] === tab.id || state.userPeek === tab.id) reasons.push('selected')
    if (tab.agent || tab.chat || tab.userPeek || S.isIncognito(state, tab.spaceId)) reasons.push('special-tab')
    if (live.lifecycle !== 'live' || rec.wc.isLoading()) reasons.push('loading')
    if (rec.pending.size || rec.reading || rec.article || rec.find.active) reasons.push('in-use')
    if (rec.wc.isCurrentlyAudible?.()) reasons.push('audible')
    if (live.pendingPermissions || live.activeDownloads) reasons.push('browser-activity')
    for (const [name, active] of Object.entries(live.protections || {})) if (active) reasons.push(name)
    // Unknown or newly-created subframes are not evidence that a page is safe.
    const frames = rec.wc.mainFrame?.framesInSubtree || [rec.wc.mainFrame]
    if (!frames.length || frames.some((frame) => !frame || !rec.frames.has(`${frame.processId}:${frame.routingId}`))) reasons.push('unreported-frame')
    return reasons
  }
  function discard(params) {
    const tab = tabFor(params.id)
    const rec = ensure(tab, false)
    const reasons = protectedReasons(tab, rec)
    if (reasons.length) throw error('page_protected', `This page must stay live: ${[...new Set(reasons)].join(', ')}`)
    const sleep = { ...runtime.get(tab.id), lifecycle: 'sleeping', loading: false, find: { ...rec.find, active: false }, reader: { active: false, loading: false } }
    beforeDestroy(tab.id)
    destroyView(tab.id)
    runtime.set(tab.id, sleep)
    changed()
    emit('page-sleeping', { id: tab.id })
    return { id: tab.id, lifecycle: 'sleeping' }
  }
  function recover(params) {
    const tab = tabFor(params.id)
    if (tab.chat) throw error('bad_params', 'This operation requires a web page')
    let view = views.get(tab.id)
    if (view && !view.webContents.isDestroyed()) {
      const rec = records.get(tab.id)
      if (rec) update(rec, { lifecycle: 'loading', loading: true, crash: null })
      view.webContents.reload()
    } else {
      if (view) { beforeDestroy(tab.id); destroyView(tab.id) }
      view = createView(tab)
      if (!records.has(tab.id)) attach(tab, view)
    }
    changed()
    return { id: tab.id, lifecycle: 'loading' }
  }
  function sweep(now = Date.now()) {
    const state = currentState()
    if (stopped || state.settings?.memorySaver !== true) return { discarded: [] }
    const minutes = state.settings.memorySaverMinutes
    const idle = (Number.isFinite(minutes) && minutes >= 1 ? minutes : 30) * 60000
    const discarded = []
    for (const [id, rec] of records) {
      const tab = S.findTab(state, id)
      if (!tab || protectedReasons(tab, rec).length || now - Math.max(tab.lastActiveAt || 0, rec.lastShownAt) < idle) continue
      try { discard({ id }); discarded.push(id) } catch (e) {
        if (e.code !== 'page_protected') { log.warn('memory saver discard failed', { id, err: e.message }); emit('page-discard-error', { id, message: text(e.message, 300) }) }
      }
    }
    if (discarded.length) log.info('memory saver slept tabs', { count: discarded.length })
    return { discarded }
  }
  function beforeDestroy(id) {
    const rec = records.get(id)
    if (!rec) return
    cancelOperations(rec, 'page_closed', 'The page was closed')
    rec.readerRequest++
    rec.readerAbort?.abort()
    for (const [name, listener] of rec.listeners) rec.wc.off(name, listener)
    records.delete(id)
  }
  function register(target = registry) {
    if (!target) throw new Error('A command registry is required')
    const id = { type: 'string', minLength: 1 }
    const define = (name, description, run, properties = {}, required = []) => registrations.push(target.register('stock.page', { name, description, title: description, visible: true, tool: false, inputSchema: { type: 'object', properties: { id, ...properties }, required, additionalProperties: false }, run }))
    define('find.open', 'Find in page', findOpen)
    define('find.update', 'Search this page', findUpdate, { query: { type: 'string', maxLength: 1000 }, matchCase: { type: 'boolean' } }, ['query'])
    define('find.next', 'Find the next or previous match', findNext, { forward: { type: 'boolean' } })
    define('find.close', 'Close find in page', findClose)
    define('reader.open', 'Read this article', readerOpen, { timeout: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT } })
    define('reader.get', 'Get the current reader article', readerGet)
    define('reader.close', 'Close reader mode', readerClose)
    define('tabs.recover', 'Reload a crashed or sleeping page', recover)
    define('tabs.discard', 'Sleep an unprotected background page', discard)
  }
  const timer = setInterval(() => sweep(), 60000)
  timer.unref?.()
  function stop() {
    log.debug('page features stop', { records: records.size })
    stopped = true
    clearInterval(timer)
    for (const id of records.keys()) beforeDestroy(id)
    for (const dispose of registrations.splice(0)) dispose()
    generations.clear()
  }
  return { attach, read, capture, register, beforeDestroy, stop, report, protect, sweep }
}

module.exports = { createPageFeatures }

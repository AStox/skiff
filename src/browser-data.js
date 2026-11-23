'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')

const DAY = 86400000
const OWNER = 'stock.browser-data'
const automatic = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'])
const permissionNames = {
  media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications',
  fullscreen: 'enter fullscreen', pointerLock: 'lock the pointer', 'clipboard-sanitized-write': 'write to the clipboard',
  'clipboard-read': 'read the clipboard', 'display-capture': 'capture your screen', midi: 'use MIDI devices', midiSysex: 'use MIDI system messages'
}
const error = (code, message) => Object.assign(new Error(message), { code })
const originOf = (url) => { try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.origin : null } catch { return null } }
const keyOf = (partition, origin, permission) => JSON.stringify([partition, origin, permission])
const clone = (value) => structuredClone(value)
const string = { type: 'string', minLength: 1 }
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

function createBrowserData({ dir, state, changed = () => {}, emit = () => {}, openTab, dialog, shell, getWindow = () => null, getDownloadDirectory = () => path.join(os.homedir(), 'Downloads') }) {
  const getState = typeof state === 'function' ? state : () => state
  const file = path.join(dir, 'browser-data.json')
  let data = { version: 1, history: [], downloads: [], permissions: [], zoom: [] }
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved.version !== 1 || !['history', 'downloads', 'permissions', 'zoom'].every((k) => Array.isArray(saved[k]))) throw error('bad_data', 'Invalid browser data file; existing data was not replaced')
    data = saved
  }
  const sessions = new Map()
  const contents = new Map()
  const liveDownloads = new Map()
  const retries = []
  const pending = new Map()
  const disposers = []
  let timer = null
  let stopped = false
  const settings = () => getState()?.settings || {}
  const privatePartition = (partition) => !partition.startsWith('persist:') || !!getState()?.spaces?.some((s) => s.incognito && s.sessionPartition === partition)
  const partitionOf = (tab) => tab.sessionPartition || getState()?.spaces?.find((s) => s.id === tab.spaceId)?.sessionPartition || 'persist:main'
  const privateTab = (tab) => !!(tab.incognito || tab.private || privatePartition(partitionOf(tab)) || getState()?.spaces?.some((s) => s.id === tab.spaceId && s.incognito))
  const prune = () => {
    const days = Number.isFinite(settings().historyRetentionDays) ? Math.max(0, settings().historyRetentionDays) : 90
    const cutoff = Date.now() - days * DAY
    data.history = days ? data.history.filter((r) => r.time >= cutoff && !privatePartition(r.partition)).slice(-100000) : []
  }
  data.history = data.history.filter((r) => r && typeof r.partition === 'string' && originOf(r.url) && Number.isFinite(r.time))
  data.downloads = data.downloads.filter((r) => r && typeof r.partition === 'string' && !r.private && !privatePartition(r.partition))
  data.permissions = data.permissions.filter((r) => r && typeof r.partition === 'string' && !privatePartition(r.partition) && r.lifetime === 'remember' && originOf(r.origin))
  data.zoom = data.zoom.filter((r) => r && typeof r.partition === 'string' && !privatePartition(r.partition) && originOf(r.origin) && Number.isFinite(r.factor))
  for (const row of data.downloads) if (['progressing', 'paused'].includes(row.state)) row.state = 'interrupted'
  prune()

  function flush() {
    clearTimeout(timer)
    timer = null
    prune()
    fs.mkdirSync(dir, { recursive: true })
    const persisted = {
      version: 1, history: data.history,
      downloads: data.downloads.filter((r) => !r.private && !privatePartition(r.partition)),
      permissions: data.permissions.filter((r) => r.lifetime === 'remember' && !privatePartition(r.partition)),
      zoom: data.zoom.filter((r) => !privatePartition(r.partition))
    }
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(persisted), { mode: 0o600 })
    fs.renameSync(`${file}.tmp`, file)
  }
  function notify(topic) {
    if (stopped) return
    if (!timer) {
      timer = setTimeout(() => { try { flush() } catch (e) { emit('browser-data-error', { message: e.message }) } }, 250)
      timer.unref?.()
    }
    // Event payloads deliberately contain no private URLs or filenames.
    emit('browser-data-changed', { topic })
    changed()
  }
  function recordVisit(tab, { url, title, time = Date.now() }) {
    if (stopped || !tab || tab.agent || tab.chat || tab.userPeek || privateTab(tab) || getState()?.userPeek === tab.id || getState()?.userPeek?.id === tab.id || !originOf(url)) return null
    if (!Number.isFinite(time)) throw error('bad_params', 'Visit time must be finite')
    prune()
    if (settings().historyRetentionDays === 0 || time < Date.now() - (settings().historyRetentionDays ?? 90) * DAY) return null
    const partition = partitionOf(tab)
    // Title updates for a committed navigation retain its entry ID.
    let row = data.history.findLast((r) => r.tabId === tab.id && r.partition === partition && r.url === url && r.time === time)
    if (row) row.title = title || url
    else {
      row = { id: crypto.randomUUID(), partition, url, title: title || url, time, spaceId: tab.spaceId, tabId: tab.id }
      data.history.push(row)
    }
    notify('history')
    return clone(row)
  }
  function historySearch({ query = '', partition, limit = 100, offset = 0 } = {}) {
    prune()
    const q = query.toLocaleLowerCase()
    const rows = data.history.filter((r) => (!partition || r.partition === partition) && (!q || `${r.title}\n${r.url}`.toLocaleLowerCase().includes(q))).sort((a, b) => b.time - a.time)
    return { entries: clone(rows.slice(offset, offset + limit)), total: rows.length }
  }
  function removeRows(kind, matches) {
    const before = data[kind].length
    data[kind] = data[kind].filter((r) => !matches(r))
    const deleted = before - data[kind].length
    if (deleted) notify(kind)
    return { deleted }
  }
  function download(id) {
    const row = data.downloads.find((r) => r.id === id)
    if (!row) throw error('not_found', 'Download not found')
    return row
  }
  function sourceOf(wc, partition, item, frame) {
    const tab = contents.get(wc)?.tab
    const topLevelUrl = wc?.getURL?.() || ''
    const initiatorOrigin = item.getInitiatorOrigin?.() || ''
    const sourceUrl = frame?.url || initiatorOrigin || topLevelUrl
    return {
      partition, sourceUrl, sourceOrigin: initiatorOrigin || originOf(sourceUrl) || '', topLevelUrl,
      sourceTitle: sourceUrl === topLevelUrl ? wc?.getTitle?.() || tab?.title || '' : sourceUrl,
      tabId: tab?.id || null, spaceId: tab?.spaceId || null,
      private: privatePartition(partition) || !!(tab && privateTab(tab)), agent: !!tab?.agent
    }
  }
  function uniquePath(directory, filename) {
    let destination = path.join(directory, path.basename(filename))
    const ext = path.extname(filename), base = path.basename(filename, ext)
    for (let n = 1; fs.existsSync(destination) || data.downloads.some((r) => liveDownloads.has(r.id) && r.path === destination); n++) destination = path.join(directory, `${base} (${n})${ext}`)
    return destination
  }
  function onDownload(partition, event, item, wc, frame) {
    if (stopped) return
    const url = item.getURL()
    for (let i = retries.length - 1; i >= 0; i--) if (retries[i].expiresAt < Date.now()) retries.splice(i, 1)
    const index = wc ? -1 : retries.findIndex((r) => r.partition === partition && r.url === url)
    const retry = index < 0 ? null : retries.splice(index, 1)[0]
    const source = retry?.source || sourceOf(wc, partition, item, frame)
    const row = { ...source, id: crypto.randomUUID(), url, filename: path.basename(item.getFilename()), path: item.getSavePath() || '', state: 'progressing', receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), startedAt: Date.now(), updatedAt: Date.now(), ...(retry && { retryOf: retry.id }) }
    try {
      const directory = settings().downloadDirectory || getDownloadDirectory()
      if (source.private || settings().downloadAskWhere !== false) {
        item.setSaveDialogOptions({ title: source.private ? 'Save private download — saved files remain after closing private browsing' : 'Save download', ...(directory && { defaultPath: path.join(directory, row.filename) }) })
      } else {
        if (!directory || !path.isAbsolute(directory)) throw error('bad_params', 'Download directory must be an absolute path')
        fs.mkdirSync(directory, { recursive: true })
        item.setSavePath(uniquePath(directory, row.filename))
      }
    } catch (e) {
      row.state = 'cancelled'
      row.error = `Could not prepare download destination: ${e.message}`
      data.downloads.push(row)
      item.cancel()
      notify('downloads')
      return
    }
    row.path = item.getSavePath() || row.path
    data.downloads.push(row)
    const update = (_event, status) => {
      if (stopped) return
      row.state = status === 'progressing' && item.isPaused?.() ? 'paused' : status
      row.receivedBytes = item.getReceivedBytes()
      row.totalBytes = item.getTotalBytes()
      row.path = item.getSavePath() || row.path
      row.updatedAt = Date.now()
      notify('downloads')
    }
    const done = (_event, status) => {
      liveDownloads.delete(row.id)
      item.removeListener('updated', update)
      update(_event, status)
    }
    liveDownloads.set(row.id, { item, update, done })
    item.on('updated', update)
    item.once('done', done)
    notify('downloads')
  }

  function site(params) {
    if (typeof params.partition !== 'string' || !params.partition) throw error('bad_params', 'A profile partition is required')
    const origin = originOf(params.origin)
    if (!origin || origin !== params.origin) throw error('bad_params', 'Use an exact HTTP(S) origin without a path')
    return { partition: params.partition, origin }
  }
  function permissionSet(params) {
    const { partition, origin } = site(params)
    if (!Object.hasOwn(permissionNames, params.permission)) throw error('bad_params', 'Unsupported permission')
    if (!['allow', 'block'].includes(params.decision) || !['once', 'session', 'remember'].includes(params.lifetime)) throw error('bad_params', 'Invalid permission decision or lifetime')
    const row = { partition, origin, permission: params.permission, decision: params.decision, lifetime: privatePartition(partition) && params.lifetime === 'remember' ? 'session' : params.lifetime }
    data.permissions = data.permissions.filter((r) => keyOf(r.partition, r.origin, r.permission) !== keyOf(partition, origin, params.permission))
    data.permissions.push(row)
    // Replacing a decision invalidates any older native prompt for this site.
    for (const request of pending.values()) if (request.partition === partition && request.origin === origin && request.permission === params.permission) request.finish(false)
    notify('permissions')
    return clone(row)
  }
  function permissionReset(params) {
    const { partition, origin } = site(params)
    for (const request of pending.values()) if (request.partition === partition && request.origin === origin && (!params.permission || request.permission === params.permission)) request.finish(false)
    return removeRows('permissions', (r) => r.partition === partition && r.origin === origin && (!params.permission || r.permission === params.permission))
  }
  function grantFor(partition, origin, permission) {
    return data.permissions.find((r) => r.partition === partition && r.origin === origin && r.permission === permission)
  }
  function requestPermission(partition, wc, permission, callback, details = {}) {
    const topURL = wc?.getURL?.()
    const origin = originOf(Object.hasOwn(details, 'requestingUrl') ? details.requestingUrl : topURL)
    const reply = (allow) => {
      if (allow && ['media', 'display-capture'].includes(permission)) emit('browser-permission-granted', { tabId: contents.get(wc)?.tab.id || null, permission })
      callback(allow)
    }
    if (stopped || !origin || !Object.hasOwn(permissionNames, permission)) { callback(false); return }
    const grant = grantFor(partition, origin, permission)
    if (grant) {
      if (grant.lifetime === 'once') removeRows('permissions', (r) => r === grant)
      reply(grant.decision === 'allow')
      return
    }
    if (automatic.has(permission)) { callback(true); return }
    if (!dialog?.showMessageBox || !wc || wc.isDestroyed?.()) { callback(false); return }
    const id = crypto.randomUUID()
    const request = { id, partition, origin, permission, tabId: contents.get(wc)?.tab.id || null }
    // Electron supplies a URL, not a requesting-frame ID. Duplicate-URL frames
    // are deliberately treated as candidates rather than inventing exact identity.
    const requestFrames = details.isMainFrame === false
      ? (wc.mainFrame?.framesInSubtree || []).filter((frame) => frame !== wc.mainFrame && frame.url === details.requestingUrl)
      : []
    let finished = false
    const finish = (allow) => {
      if (finished) return
      finished = true
      pending.delete(id)
      wc.removeListener?.('destroyed', deny)
      wc.removeListener?.('did-start-navigation', navigate)
      reply(!!allow)
      notify('permissions')
    }
    const deny = () => finish(false)
    const navigate = (event, url, isInPlace, isMainFrame, processId, routingId) => {
      if (event.isSameDocument ?? isInPlace) return
      if ((event.isMainFrame ?? isMainFrame) !== false) return deny()
      if (details.isMainFrame !== false) return
      const frame = event.frame
      if (requestFrames.length) {
        if (requestFrames.some((candidate) => candidate === frame || Number.isInteger(processId) && candidate.processId === processId && candidate.routingId === routingId)) deny()
      } else if (originOf(frame?.url || event.url || url) === origin) {
        // Without a matching frame, cancel only relevant-origin navigation.
        deny()
      }
    }
    request.finish = finish
    pending.set(id, request)
    wc.once?.('destroyed', deny)
    wc.on?.('did-start-navigation', navigate)
    notify('permissions')
    const options = {
      type: 'question', message: `${origin} wants to ${permissionNames[permission]}`,
      detail: `Profile: ${partition}${privatePartition(partition) ? '\nPrivate browsing: decisions will not be saved.' : ''}\nOnce applies to this request. Session lasts until quit. Remember persists for this profile and origin. Reset/revoke affects future requests.`,
      buttons: ['Deny', 'Allow once', 'Allow for session', 'Remember allow', 'Always block'], defaultId: 0, cancelId: 0, noLink: true
    }
    const window = getWindow()
    Promise.resolve().then(() => window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).then(({ response }) => {
      if (finished || stopped || wc.isDestroyed?.() || wc.getURL?.() !== topURL) return finish(false)
      if (requestFrames.some((frame) => frame.isDestroyed?.() || frame.url !== details.requestingUrl)) return finish(false)
      if ([2, 3, 4].includes(response)) {
        // Complete before storing so this request does not invalidate itself.
        pending.delete(id)
        permissionSet({ partition, origin, permission, decision: response === 4 ? 'block' : 'allow', lifetime: response === 2 ? 'session' : 'remember' })
      }
      finish([1, 2, 3].includes(response))
    }).catch(() => finish(false))
  }
  function attachSession(session, partition) {
    if (stopped || sessions.has(session)) return
    if (typeof partition !== 'string' || !partition) throw error('bad_params', 'Session partition is required')
    const onWillDownload = (event, item, wc, frame) => onDownload(partition, event, item, wc, frame)
    session.on('will-download', onWillDownload)
    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
      if (stopped) return false
      const origin = originOf(requestingOrigin || details.requestingUrl)
      if (!origin) return false
      const grant = grantFor(partition, origin, permission)
      // A true preflight bypasses the request handler, where once is consumed.
      const allow = grant ? grant.decision === 'allow' && grant.lifetime !== 'once' : automatic.has(permission)
      if (allow && ['media', 'display-capture'].includes(permission)) emit('browser-permission-granted', { tabId: contents.get(wc)?.tab.id || null, permission })
      return allow
    })
    session.setPermissionRequestHandler((wc, permission, callback, details) => requestPermission(partition, wc, permission, callback, details))
    sessions.set(session, { partition, onWillDownload })
  }
  function track(wc, tab) {
    if (contents.has(wc)) { contents.get(wc).tab = tab; return }
    const destroy = () => contents.delete(wc)
    wc.once?.('destroyed', destroy)
    contents.set(wc, { tab, destroy })
  }
  function applyZoom(wc, tab) {
    if (stopped || wc.isDestroyed?.()) return 1
    track(wc, tab)
    const origin = originOf(wc.getURL?.() || tab.url)
    const factor = data.zoom.find((r) => r.partition === partitionOf(tab) && r.origin === origin)?.factor || 1
    wc.setZoomFactor(factor)
    return factor
  }
  function zoomSet(params) {
    const { partition, origin } = site(params)
    if (!Number.isFinite(params.factor) || params.factor < 0.25 || params.factor > 5) throw error('bad_params', 'Zoom factor must be between 0.25 and 5')
    const row = { partition, origin, factor: params.factor }
    data.zoom = data.zoom.filter((r) => r.partition !== partition || r.origin !== origin)
    if (params.factor !== 1) data.zoom.push(row)
    for (const [wc, { tab }] of contents) if (!wc.isDestroyed?.() && partitionOf(tab) === partition && originOf(wc.getURL?.()) === origin) wc.setZoomFactor(params.factor)
    notify('zoom')
    return clone(row)
  }
  function rememberZoom(wc, tab) {
    if (stopped || wc.isDestroyed?.()) return null
    track(wc, tab)
    const origin = originOf(wc.getURL?.() || tab.url)
    if (!origin) return null
    return zoomSet({ partition: partitionOf(tab), origin, factor: wc.getZoomFactor() })
  }
  function forgetPartition(partition) {
    if (!privatePartition(partition)) throw error('bad_params', 'Only private partition metadata can be forgotten')
    for (const request of pending.values()) if (request.partition === partition) request.finish(false)
    for (const row of data.downloads.filter((r) => r.partition === partition)) {
      const live = liveDownloads.get(row.id)
      if (live) live.item.cancel()
    }
    for (const kind of ['history', 'downloads', 'permissions', 'zoom']) removeRows(kind, (r) => r.partition === partition)
  }
  function snapshot() {
    prune()
    return {
      historyCount: data.history.length, downloadCount: data.downloads.filter((r) => !r.private).length,
      activeDownloads: [...liveDownloads.keys()].map((id) => download(id).tabId).filter(Boolean),
      pendingPermissions: [...pending.values()].map(({ finish, ...row }) => clone(row))
    }
  }
  function register(registry) {
    const add = (name, description, properties, required, run) => disposers.push(registry.register(OWNER, { name, description, inputSchema: object(properties, required), run }))
    const profile = { partition: string }
    const siteFields = { ...profile, origin: string }
    const id = { id: string }
    add('history.search', 'Search normal browsing history, retaining the original profile.', { query: { type: 'string' }, ...profile, limit: { type: 'integer', minimum: 1, maximum: 1000 }, offset: { type: 'integer', minimum: 0 } }, [], historySearch)
    add('history.delete', 'Delete selected visits without touching tabs or cookies.', { ids: { type: 'array', items: string, minItems: 1, maxItems: 10000 } }, ['ids'], ({ ids }) => { const wanted = new Set(ids); return removeRows('history', (r) => wanted.has(r.id)) })
    add('history.clear', 'Clear history for one profile or all profiles.', profile, [], ({ partition }) => removeRows('history', (r) => !partition || r.partition === partition))
    add('history.open', 'Open a history entry using its original sign-in profile.', id, ['id'], ({ id }) => {
      prune()
      const row = data.history.find((r) => r.id === id)
      if (!row) throw error('not_found', 'History entry not found')
      if (!openTab) throw error('unavailable', 'Tab opening is unavailable')
      const spaceId = getState()?.spaces?.find((s) => s.id === row.spaceId && !s.incognito)?.id
      return openTab({ url: row.url, sessionPartition: row.partition, ...(spaceId && { spaceId }), activate: true })
    })
    add('downloads.list', 'List downloads; private metadata is opt-in and disappears on private close. Saved files remain.', { ...profile, includePrivate: { type: 'boolean' } }, [], ({ partition, includePrivate = false }) => ({ entries: clone(data.downloads.filter((r) => (!partition || r.partition === partition) && (includePrivate || !r.private)).slice().reverse()) }))
    add('downloads.cancel', 'Cancel an active download without deleting a completed file.', id, ['id'], ({ id }) => {
      const row = download(id), live = liveDownloads.get(id)
      if (!live) throw error('bad_params', 'Download is not active')
      live.item.cancel()
      row.state = 'cancelled'
      row.updatedAt = Date.now()
      notify('downloads')
      return clone(row)
    })
    add('downloads.open', 'Open a completed saved file with its default application.', id, ['id'], async ({ id }) => {
      const row = download(id)
      if (row.state !== 'completed' || !row.path || !fs.existsSync(row.path)) throw error('not_found', 'Completed file is not available')
      if (!shell?.openPath) throw error('unavailable', 'Opening files is unavailable')
      const message = await shell.openPath(row.path)
      if (message) throw error('open_failed', message)
      return { ok: true }
    })
    add('downloads.reveal', 'Reveal a saved download in the file manager.', id, ['id'], ({ id }) => {
      const row = download(id)
      if (!row.path || !fs.existsSync(row.path)) throw error('not_found', 'Saved file is not available')
      if (!shell?.showItemInFolder) throw error('unavailable', 'File manager is unavailable')
      shell.showItemInFolder(row.path)
      return { ok: true }
    })
    add('downloads.retry', 'Restart an interrupted or cancelled download in its original profile; a new file download is created.', id, ['id'], ({ id }) => {
      const row = download(id)
      if (!['interrupted', 'cancelled'].includes(row.state)) throw error('bad_params', 'Only interrupted or cancelled downloads can be restarted')
      const session = [...sessions].find(([, entry]) => entry.partition === row.partition)?.[0]
      if (!session) throw error('unavailable', 'Open a tab in the original profile before restarting this download')
      if (retries.some((r) => r.id === id && r.expiresAt > Date.now())) throw error('bad_params', 'A restart is already pending')
      const retry = { id, partition: row.partition, url: row.url, expiresAt: Date.now() + 60000, source: { partition: row.partition, sourceUrl: row.sourceUrl, sourceOrigin: row.sourceOrigin, topLevelUrl: row.topLevelUrl, sourceTitle: row.sourceTitle, tabId: row.tabId, spaceId: row.spaceId, private: row.private, agent: row.agent } }
      retries.push(retry)
      try { session.downloadURL(row.url) } catch (e) { retries.splice(retries.indexOf(retry), 1); throw e }
      return { ...clone(row), restartRequested: true }
    })
    add('downloads.clear', 'Forget finished download metadata, never saved files or active downloads.', profile, [], ({ partition }) => removeRows('downloads', (r) => (!partition || r.partition === partition) && !liveDownloads.has(r.id)))
    add('permissions.list', 'List exact-origin profile permission decisions and pending requests.', siteFields, [], ({ partition, origin }) => ({ entries: clone(data.permissions.filter((r) => (!partition || r.partition === partition) && (!origin || r.origin === origin))), pending: snapshot().pendingPermissions.filter((r) => (!partition || r.partition === partition) && (!origin || r.origin === origin)) }))
    add('permissions.set', 'Allow or block a site permission once, until quit, or remembered. Private decisions never persist.', { ...siteFields, permission: { type: 'string', enum: Object.keys(permissionNames) }, decision: { type: 'string', enum: ['allow', 'block'] }, lifetime: { type: 'string', enum: ['once', 'session', 'remember'] } }, ['partition', 'origin', 'permission', 'decision', 'lifetime'], permissionSet)
    for (const name of ['permissions.reset', 'permissions.revoke']) add(name, 'Remove site decisions and deny pending prompts. Applies to future requests; reload the page to stop existing media.', { ...siteFields, permission: string }, ['partition', 'origin'], permissionReset)
    add('zoom.list', 'List remembered zoom by profile and origin.', profile, [], ({ partition }) => ({ entries: clone(data.zoom.filter((r) => !partition || r.partition === partition)) }))
    add('zoom.set', 'Set zoom for this profile and origin, including other live tabs on the same site.', { ...siteFields, factor: { type: 'number', minimum: 0.25, maximum: 5 } }, ['partition', 'origin', 'factor'], zoomSet)
    add('zoom.reset', 'Restore actual size for this profile and origin.', siteFields, ['partition', 'origin'], (params) => { const { partition, origin } = site(params); const deleted = data.zoom.some((r) => r.partition === partition && r.origin === origin) ? 1 : 0; zoomSet({ partition, origin, factor: 1 }); return { deleted } })
  }
  function stop() {
    if (stopped) return
    stopped = true
    for (const request of pending.values()) request.finish(false)
    for (const [session, { onWillDownload }] of sessions) {
      session.removeListener('will-download', onWillDownload)
      session.setPermissionCheckHandler(null)
      session.setPermissionRequestHandler(null)
    }
    for (const { item, update, done } of liveDownloads.values()) { item.removeListener('updated', update); item.removeListener('done', done) }
    for (const [wc, { destroy }] of contents) wc.removeListener?.('destroyed', destroy)
    sessions.clear()
    contents.clear()
    liveDownloads.clear()
    retries.length = 0
    for (const dispose of disposers) dispose()
    flush()
    data.downloads = data.downloads.filter((r) => !r.private)
    data.permissions = data.permissions.filter((r) => r.lifetime === 'remember' && !privatePartition(r.partition))
    data.zoom = data.zoom.filter((r) => !privatePartition(r.partition))
  }
  return { register, recordVisit, attachSession, applyZoom, rememberZoom, forgetPartition, snapshot, stop }
}

module.exports = { createBrowserData }

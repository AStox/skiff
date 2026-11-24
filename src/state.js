'use strict'
const crypto = require('node:crypto')

const settingsCatalog = require('./settings-catalog')

const HOUR = 3600e3
const COLORS = ['#4f6bed', '#7c5ce0', '#d6336c', '#c2700e', '#2f9e5b', '#5f6b7a']
const mac = process.platform === 'darwin'
const SHORTCUTS = {
  'CmdOrCtrl+T': { method: 'ui.emit', params: { name: 'new-tab' } },
  'CmdOrCtrl+L': { method: 'ui.emit', params: { name: 'focus-address' } },
  'CmdOrCtrl+,': { method: 'ui.emit', params: { name: 'toggle-settings' } },
  'CmdOrCtrl+W': { method: 'tabs.close' },
  'CmdOrCtrl+Shift+T': { method: 'archive.restore' },
  'CmdOrCtrl+Shift+N': { method: 'incognito.open' },
  'CmdOrCtrl+Shift+C': { method: 'tabs.copyUrl' },
  'CmdOrCtrl+Shift+U': { method: 'ui.emit', params: { name: 'extension-popup' } },
  'CmdOrCtrl+R': { method: 'tabs.reload' },
  'CmdOrCtrl+[': { method: 'tabs.back' },
  'CmdOrCtrl+]': { method: 'tabs.forward' },
  'Ctrl+Tab': { method: 'tabs.cycle', params: { delta: 1 } },
  'Ctrl+Shift+Tab': { method: 'tabs.cycle', params: { delta: -1 } },
  'CmdOrCtrl+Alt+Right': { method: 'spaces.cycle', params: { delta: 1 } },
  'CmdOrCtrl+Alt+Left': { method: 'spaces.cycle', params: { delta: -1 } },
  'CmdOrCtrl+Alt+I': { method: 'ui.devtools', params: { target: 'page' } },
  [mac ? 'Cmd+Left' : 'Alt+Left']: { method: 'tabs.back' },
  [mac ? 'Cmd+Right' : 'Alt+Right']: { method: 'tabs.forward' },
  'CmdOrCtrl+Shift+R': { method: 'tabs.reload', params: { ignoreCache: true } },
  'CmdOrCtrl+Shift+]': { method: 'tabs.cycle', params: { delta: 1 } },
  'CmdOrCtrl+Shift+[': { method: 'tabs.cycle', params: { delta: -1 } },
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`CmdOrCtrl+${n}`, { method: 'tabs.select', params: { index: n === 9 ? -1 : n - 1 } }])),
  'CmdOrCtrl+=': { method: 'tabs.zoom', params: { delta: 1 } },
  'CmdOrCtrl+Plus': { method: 'tabs.zoom', params: { delta: 1 } },
  'CmdOrCtrl+-': { method: 'tabs.zoom', params: { delta: -1 } },
  'CmdOrCtrl+0': { method: 'tabs.zoom', params: { delta: 0 } },
  'CmdOrCtrl+P': { method: 'tabs.print' },
  'CmdOrCtrl+S': { method: 'ui.emit', params: { name: 'toggle-sidebar' } },
  'CmdOrCtrl+J': { method: 'ui.emit', params: { name: 'ask-agent' } },
  ...Object.fromEntries([['Left', 'left'], ['Right', 'right'], ['Up', 'top'], ['Down', 'bottom'], ['Enter', 'fill'], ['C', 'center']].map(([key, layout]) => [`${mac ? 'Ctrl+Alt' : 'Ctrl+Super'}+${key}`, { method: 'desk.tile', params: { layout } }]))
}
// System-wide: these fire while another app is in front, so the handler raises Skiff before running the method.
const GLOBAL_SHORTCUTS = {
  'Alt+Space': { method: 'ui.emit', params: { name: 'new-tab' } }
}
const MARGIN = 8
const OFFSET = 28
const HOSTS = 200
const AI = { agents: [], agent: '', model: '', effort: '' }
const CHAT = /^skiff:\/\/chat\/c[0-9a-f]{12}$/

const err = (code, message) => Object.assign(new Error(message), { code })
const bad = (message) => err('bad_params', message)
const newId = (prefix) => prefix + crypto.randomBytes(4).toString('hex')
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const findSpace = (s, id) => s.spaces.find((x) => x.id === id)
const findTab = (s, id) => s.tabs.find((x) => x.id === id) || s.agentTabs.find((x) => x.id === id)
const activeTab = (s) => findTab(s, s.activeTabBySpace[s.activeSpaceId])
const isPlain = (t) => !t.favorite && !t.pinned
const BUCKETS = ['favorites', 'unread', 'active', 'progress', 'later', 'done']
// ponytail: a done tab waits a fixed day before it is archived
const DONE_HOURS = 24
const bucketOf = (t) => (t.favorite ? 'favorites' : t.pinned ? 'later' : t.status || 'active')
const mark = (tab, status, now) => {
  tab.status = status
  if (status === 'done') tab.doneAt = now
  else delete tab.doneAt
}
const unmark = (tab) => {
  delete tab.status
  delete tab.doneAt
}
// Trails affect list visibility, not independently live Layer windows.
const visibleTabs = (s, spaceId = s.activeSpaceId) => {
  const tabs = s.tabs.filter((t) => t.spaceId === spaceId && !t.userPeek)
  const trail = (parentId) => tabs.filter((t) => isPlain(t) && t.parentId === parentId).flatMap((t) => [t, ...(t.trailCollapsed ? [] : trail(t.id))])
  return [...tabs.filter((t) => t.favorite), ...tabs.filter((t) => t.pinned && !t.favorite), ...trail(undefined)]
}
const isIncognito = (s, spaceId) => !!findSpace(s, spaceId)?.incognito
const deskTabs = (s, spaceId = s.activeSpaceId) => s.tabs.filter((t) => t.spaceId === spaceId && t.desk).sort((a, b) => a.desk.z - b.desk.z)
const isShown = (s, tab) => s.activeTabBySpace[tab.spaceId] === tab.id || (tab.desk ? !tab.desk.hidden : isPlain(tab))
// s.desktops {current, list: [{id, number}]} is runtime state, set only where macOS desktops are known; without it every tab is on the one desktop.
const onDesktop = (s, tab) => !s.desktops || tab.desktopId === s.desktops.current
const here = (s) => (s.desktops ? { desktopId: s.desktops.current } : {})
const desktopNumber = (s, id) => s.desktops?.list.find((d) => d.id === id)?.number ?? null
// Back to front: unplaced ordinary tabs in tab order, then placed ones by z, the active tab last.
function shownTabs(s, spaceId = s.activeSpaceId) {
  const tabs = s.tabs.filter((t) => t.spaceId === spaceId && !t.userPeek && onDesktop(s, t) && isShown(s, t))
  const active = tabs.find((t) => s.activeTabBySpace[spaceId] === t.id)
  return [...tabs.filter((t) => !t.desk), ...tabs.filter((t) => t.desk).sort((a, b) => a.desk.z - b.desk.z)].filter((t) => t !== active).concat(active || [])
}
const normalSpace = (s) => [findSpace(s, s.activeSpaceId), ...s.spaces].find((x) => x && !x.incognito)
const origin = (url) => (URL.canParse(url) ? new URL(url).origin : '')
const hostOf = (url) => (URL.canParse(url) ? new URL(url).host : '')

function getSpace(s, id) {
  const space = findSpace(s, id)
  if (!space) throw err('not_found', `No space ${id}`)
  return space
}

function getTab(s, id) {
  const tab = id === undefined ? activeTab(s) : findTab(s, id)
  if (!tab) throw err('not_found', id === undefined ? 'No active tab' : `No tab ${id}`)
  return tab
}

function webUrl(url) {
  if (!URL.canParse(url)) throw bad(`Not a URL: ${url}`)
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'chrome-extension:') throw bad(`Only http and https URLs can be opened, not ${u.protocol}`)
  return u.href
}

const HOST = /^(localhost|\[[0-9a-f:]+\]|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])([:/?#]|$)/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

function resolveInput(text, searchUrl) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) throw bad('url must be a non-empty string')
  let url
  if (!/\s/.test(t)) {
    if (HOST.test(t)) url = (LOOPBACK.test(t) ? 'http://' : 'https://') + t
    else if (SCHEME.test(t)) url = t
  }
  if (url && URL.canParse(url)) return new URL(url).href
  return searchUrl.replace('%s', () => encodeURIComponent(t))
}

const GOOGLE = 'https://www.google.com/search?q=%s'
const navUrl = (s, text) => webUrl(resolveInput(text, s.settings.searchUrl))

const chatOf = (item) => (CHAT.test(item.url) && isObject(item.chat) && typeof item.chat.agent === 'string' && (item.chat.sessionId === null || typeof item.chat.sessionId === 'string') ? { agent: item.chat.agent.slice(0, 40), sessionId: item.chat.sessionId?.slice(0, 500) ?? null } : null)

const validBrowserIdentity = ([partition, mode]) => /^persist:[a-zA-Z0-9._-]+$/.test(partition) && (mode === 'native' || mode === 'compatible')
const loadBrowserIdentity = (value) => Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(validBrowserIdentity))
const validTabIdentity = (value) => value === 'native' || value === 'compatible'
const whatsappURL = (url) => {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname === 'web.whatsapp.com'
  } catch {
    return false
  }
}

// The first agent setting was a single {command}; it becomes an agent named after the command's program.
function loadAi(raw) {
  if (isObject(raw) && typeof raw.command === 'string' && raw.agents === undefined) {
    const command = raw.command.trim().slice(0, 500)
    const name = command.split(/\s+/)[0].split('/').pop().replace(/['"]/g, '').slice(0, 40) || 'Agent'
    return command ? { ...AI, agents: [{ name, command }], agent: name } : { ...AI }
  }
  try {
    return aiSettings(raw)
  } catch {
    return { ...AI }
  }
}

function load(raw = {}) {
  const s = {
    agentTabs: [],
    peek: null,
    userPeek: null,
    folders: [],
    profiles: [],
    linkRules: [],
    splitBySpace: {},
    spaces: (Array.isArray(raw.spaces) ? raw.spaces : []).filter((x) => !x.incognito),
    activeSpaceId: raw.activeSpaceId,
    tabs: (Array.isArray(raw.tabs) ? raw.tabs : []).filter((t) => !t.userPeek),
    activeTabBySpace: { ...raw.activeTabBySpace },
    archive: Array.isArray(raw.archive) ? raw.archive : [],
    collapsed: { ...raw.collapsed },
    settings: { autoArchiveHours: 12, searchUrl: GOOGLE, shell: 'layer', historyRetentionDays: 90, downloadAskWhere: true, downloadDirectory: '', memorySaver: false, memorySaverMinutes: 30, transcriptRecovery: false, transcriptRetentionDays: 30, ...raw.settings, browserIdentity: loadBrowserIdentity(raw.settings?.browserIdentity), ai: loadAi(raw.settings?.ai), shortcuts: { ...SHORTCUTS, ...raw.settings?.shortcuts }, globalShortcuts: { ...GLOBAL_SHORTCUTS, ...raw.settings?.globalShortcuts } },
    window: { width: 1280, height: 800, ...raw.window },
    deskHosts: Object.fromEntries(Object.entries(isObject(raw.deskHosts) ? raw.deskHosts : {}).map(([host, rect]) => [host, deskRect(rect)]).filter(([, rect]) => rect).slice(-HOSTS))
  }
  // Before settings version 1 a saved DuckDuckGo URL is the old untouched default, not a choice
  if (!(s.settings.version >= 1) && s.settings.searchUrl === 'https://duckduckgo.com/?q=%s') s.settings.searchUrl = GOOGLE
  s.settings.version = 1
  if (!settingsCatalog.get('tabLayout').enum.includes(s.settings.tabLayout)) s.settings.tabLayout = 'free'
  const j = s.settings.shortcuts['CmdOrCtrl+J']
  if (j?.method === 'ui.emit' && j.params?.name === 'toggle-ai') s.settings.shortcuts['CmdOrCtrl+J'] = SHORTCUTS['CmdOrCtrl+J']
  if (!s.spaces.length) s.spaces.push({ id: newId('s'), name: 'Home', color: COLORS[0] })
  for (const space of s.spaces) {
    if (space.background !== undefined) space.background = background(space.background) || null
  }
  if (!findSpace(s, s.activeSpaceId)) s.activeSpaceId = s.spaces[0].id
  for (const tab of s.tabs) if (!Number.isSafeInteger(tab.desktopId)) delete tab.desktopId
  for (const item of [...s.tabs, ...s.archive]) {
    const chat = chatOf(item)
    if (chat) item.chat = chat
    else delete item.chat
    if (item.browserIdentity !== null && !validTabIdentity(item.browserIdentity)) {
      delete item.browserIdentity
      if (whatsappURL(item.url)) item.browserIdentity = 'compatible'
    }
  }
  s.tabs = s.tabs.filter((t) => findSpace(s, t.spaceId) && (/^https?:/.test(t.url) || t.chat))
  s.archive = s.archive.filter((a) => !/^skiff:/.test(a.url) || a.chat)
  for (const tab of s.tabs) tab.sessionPartition ||= findSpace(s, tab.spaceId)?.sessionPartition || 'persist:main'
  loadOrganization(s, raw)
  for (const tab of s.tabs) {
    if (!isPlain(tab)) unmark(tab)
    else if (!(tab.status === 'unread' || (tab.status === 'done' && Number.isFinite(tab.doneAt)))) mark(tab, 'active')
  }
  for (const tab of s.tabs) {
    if (tab.desk === undefined) continue
    const d = isObject(tab.desk) && deskRect(tab.desk)
    if (d && Number.isFinite(tab.desk.z)) tab.desk = { ...d, z: tab.desk.z, ...(tab.desk.hidden === true && { hidden: true }) }
    else delete tab.desk
  }
  for (const item of [...s.tabs, ...s.archive]) if (!/^\.\.\/favicons\/[0-9a-f]{24}\.\w+$/.test(item.favicon)) item.favicon = ''
  for (const tab of s.tabs) {
    const parent = findTab(s, tab.parentId)
    if (!parent || parent.spaceId !== tab.spaceId || !isPlain(parent) || !isPlain(tab)) delete tab.parentId
  }
  for (const tab of s.tabs) {
    const seen = new Set([tab.id])
    for (let t = findTab(s, tab.parentId); t; t = findTab(s, t.parentId)) {
      if (seen.has(t.id)) { delete tab.parentId; break }
      seen.add(t.id)
    }
  }
  for (const [spaceId, tabId] of Object.entries(s.activeTabBySpace)) {
    if (!s.tabs.some((t) => t.spaceId === spaceId && t.id === tabId)) delete s.activeTabBySpace[spaceId]
  }
  for (const [spaceId, split] of Object.entries(isObject(raw.splitBySpace) ? raw.splitBySpace : {})) {
    try {
      if (split.ids?.every((id) => findTab(s, id)?.spaceId === spaceId)) setSplit(s, split)
    } catch { /* Invalid saved pairs must not hide otherwise valid tabs. */ }
  }
  return s
}

function release(s, tab) {
  if (s.activeTabBySpace[tab.spaceId] !== tab.id) return
  const list = visibleTabs(s, tab.spaceId).filter((t) => (!(t.pinned || t.favorite) || t === tab) && (!s.desktops || t.desktopId === tab.desktopId))
  // On the desk the window beneath comes forward, the opener first, so no other window changes place.
  const beneath = tab.desk && shownTabs(s, tab.spaceId).filter((t) => t !== tab && t.desk)
  const next = (beneath?.find((t) => t.id === tab.parentId) || beneath?.at(-1)) || list[list.indexOf(tab) + 1] || list[list.indexOf(tab) - 1]
  if (next) s.activeTabBySpace[tab.spaceId] = next.id
  else delete s.activeTabBySpace[tab.spaceId]
  if (tab.spaceId === s.activeSpaceId) look(s)
}

function detach(s, tab) {
  for (const child of s.tabs.filter((t) => t.parentId === tab.id)) {
    if (tab.parentId) child.parentId = tab.parentId
    else delete child.parentId
  }
  delete tab.parentId
}

function dropTab(s, tab) {
  cleanupSplit(s, tab.id)
  if (s.userPeek === tab.id) s.userPeek = null
  release(s, tab)
  detach(s, tab)
  s.tabs.splice(s.tabs.indexOf(tab), 1)
}

function archiveTab(s, tab, now) {
  dropTab(s, tab)
  s.archive.unshift({ id: tab.id, spaceId: tab.spaceId, url: tab.url, title: tab.title, favicon: tab.favicon, sessionPartition: tab.sessionPartition, ...(tab.profileId && { profileId: tab.profileId }), ...(tab.browserIdentity !== undefined && { browserIdentity: tab.browserIdentity }), arcSourceId: tab.arcSourceId, arcSourceKind: tab.arcSourceKind, chat: tab.chat, archivedAt: now })
  // ponytail: flat cap of 500, oldest entries dropped; page or cap per space if the archive becomes a real history
  s.archive.length = Math.min(s.archive.length, 500)
}

function color(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw bad('color must look like #rrggbb')
  return value
}

// Only typed color data crosses into CSS. null records an explicit manual override.
function background(value) {
  if (!isObject(value)) return undefined
  const validColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)
  const stops = (v) => Array.isArray(v) && v.length <= 16 && v.every(validColor)
  const result = {}
  for (const appearance of ['light', 'dark']) {
    const layer = value[appearance]
    if (layer === undefined) continue
    if (!isObject(layer) || !validColor(layer.color)) return undefined
    result[appearance] = { color: layer.color }
    if (layer.colors !== undefined) {
      if (!stops(layer.colors) || !layer.colors.length || !stops(layer.overlayColors) ||
          !Number.isFinite(layer.intensity) || layer.intensity < 0 || layer.intensity > 1) return undefined
      Object.assign(result[appearance], { colors: [...layer.colors], overlayColors: [...layer.overlayColors], intensity: layer.intensity })
    }
  }
  return Object.keys(result).length ? result : undefined
}

function name(value) {
  if (typeof value !== 'string' || !value.trim()) throw bad('name must be a non-empty string')
  return value.trim().slice(0, 60)
}

function folder(value = '') {
  if (typeof value !== 'string') throw bad('folder must be a string')
  return value.trim().slice(0, 80)
}

function getFolder(s, id) {
  const value = s.folders.find((x) => x.id === id)
  if (!value) throw err('not_found', `No folder ${id}`)
  return value
}

function folderPath(s, value) {
  const parts = [value.name]
  for (let parent = s.folders.find((x) => x.id === value.parentId); parent; parent = s.folders.find((x) => x.id === parent.parentId)) parts.unshift(parent.name)
  return parts.join(' / ')
}

function refreshFolderLabels(s) {
  s.collapsed = {}
  for (const value of s.folders) if (value.collapsed) s.collapsed[`${value.spaceId}/${folderPath(s, value)}`] = true
  for (const tab of s.tabs) {
    const value = s.folders.find((x) => x.id === tab.folderId && x.spaceId === tab.spaceId)
    if (value) tab.folder = folderPath(s, value)
    else if (tab.folderId) { delete tab.folderId; tab.folder = '' }
  }
}

function ensureFolder(s, spaceId, label) {
  if (!label) return null
  return s.folders.find((x) => x.spaceId === spaceId && folderPath(s, x) === label) || createFolder(s, { spaceId, name: label })
}

function createFolder(s, p) {
  const parent = p.parentId ? getFolder(s, p.parentId) : null
  const spaceId = getSpace(s, p.spaceId ?? parent?.spaceId ?? s.activeSpaceId).id
  if (parent && parent.spaceId !== spaceId) throw bad('Parent folder must be in the same space')
  const label = folder(p.name)
  if (!label) throw bad('Folder name must not be empty')
  const value = { id: newId('f'), name: label, spaceId, parentId: parent?.id || null, collapsed: false }
  s.folders.push(value)
  return value
}

function updateFolder(s, p) {
  const value = getFolder(s, p.id)
  const next = {}
  if (p.name !== undefined) {
    next.name = folder(p.name)
    if (!next.name) throw bad('Folder name must not be empty')
  }
  if (p.collapsed !== undefined) {
    if (typeof p.collapsed !== 'boolean') throw bad('collapsed must be true or false')
    next.collapsed = p.collapsed
  }
  Object.assign(value, next)
  refreshFolderLabels(s)
  return value
}

function moveFolder(s, p) {
  const value = getFolder(s, p.id)
  const parent = p.parentId === undefined ? (p.spaceId && p.spaceId !== value.spaceId ? null : s.folders.find((x) => x.id === value.parentId)) : p.parentId === null ? null : getFolder(s, p.parentId)
  const spaceId = getSpace(s, p.spaceId ?? parent?.spaceId ?? value.spaceId).id
  if (parent && parent.spaceId !== spaceId) throw bad('Parent folder must be in the destination space')
  for (let item = parent; item; item = s.folders.find((x) => x.id === item.parentId)) if (item.id === value.id) throw bad('Folders cannot contain themselves')
  if (p.index !== undefined && (!Number.isInteger(p.index) || p.index < 0)) throw bad('index must be a non-negative integer')
  if (isIncognito(s, spaceId) !== isIncognito(s, value.spaceId)) throw bad('Folders cannot move into or out of incognito')
  const descendants = new Set([value.id])
  for (let size = -1; size !== descendants.size;) {
    size = descendants.size
    for (const item of s.folders) if (descendants.has(item.parentId)) descendants.add(item.id)
  }
  if (spaceId !== value.spaceId) {
    for (const tab of s.tabs.filter((t) => descendants.has(t.folderId))) {
      cleanupSplit(s, tab.id)
      release(s, tab)
      detach(s, tab)
      tab.spaceId = spaceId
    }
    for (const item of s.folders) if (descendants.has(item.id)) item.spaceId = spaceId
  }
  value.parentId = parent?.id || null
  if (p.index !== undefined) {
    s.folders.splice(s.folders.indexOf(value), 1)
    const peers = s.folders.filter((x) => x.spaceId === spaceId && x.parentId === value.parentId)
    const before = peers[p.index]
    s.folders.splice(before ? s.folders.indexOf(before) : s.folders.length, 0, value)
    // Lists place populated folders at their first tab, preserving legacy mixed pin order.
    const moving = s.tabs.filter((tab) => descendants.has(tab.folderId))
    const remaining = s.tabs.filter((tab) => !descendants.has(tab.folderId))
    const positions = new Map()
    remaining.forEach((tab, index) => {
      let group = s.folders.find((f) => f.id === tab.folderId && f.spaceId === spaceId)
      while (group && group.parentId !== value.parentId) group = s.folders.find((f) => f.id === group.parentId)
      if (!group) return
      const position = positions.get(group.id)
      if (position) position.last = index
      else positions.set(group.id, { first: index, last: index })
    })
    const next = peers.slice(p.index).find((f) => positions.has(f.id))
    const previous = peers.slice(0, p.index).reverse().find((f) => positions.has(f.id))
    if (moving.length && (next || previous)) {
      const at = next ? positions.get(next.id).first : positions.get(previous.id).last + 1
      remaining.splice(at, 0, ...moving)
      s.tabs.splice(0, s.tabs.length, ...remaining)
    }
  }
  refreshFolderLabels(s)
  return value
}

function removeFolder(s, p) {
  const value = getFolder(s, p.id)
  for (const item of s.folders) if (item.parentId === value.id) item.parentId = value.parentId
  for (const tab of s.tabs.filter((t) => t.folderId === value.id)) {
    if (value.parentId) tab.folderId = value.parentId
    else { delete tab.folderId; tab.folder = '' }
  }
  s.folders.splice(s.folders.indexOf(value), 1)
  refreshFolderLabels(s)
  return null
}

function setTrailCollapsed(s, p) {
  const tab = userTab(s, p.id)
  if (!isPlain(tab)) throw bad('Only ordinary tabs have trails')
  if (typeof p.collapsed !== 'boolean') throw bad('collapsed must be true or false')
  if (p.collapsed) tab.trailCollapsed = true
  else delete tab.trailCollapsed
  return tab
}

function getProfile(s, id) {
  const profile = s.profiles.find((x) => x.id === id)
  if (!profile) throw err('not_found', `No profile ${id}`)
  return profile
}

function ensureProfile(s, partition) {
  if (!/^persist:[a-zA-Z0-9._-]+$/.test(partition)) throw bad('Profile partition must be persistent')
  let profile = s.profiles.find((x) => x.partition === partition)
  if (!profile) {
    const id = partition === 'persist:main' ? 'main' : 'p' + crypto.createHash('sha256').update(partition).digest('hex').slice(0, 16)
    profile = { id, name: partition === 'persist:main' ? 'Default' : partition.slice(8), partition }
    s.profiles.push(profile)
  }
  return profile
}

function createProfile(s, p) {
  const profile = { id: newId('p'), name: name(p.name), partition: `persist:${newId('profile-')}` }
  s.profiles.push(profile)
  return profile
}

function updateProfile(s, p) {
  const profile = getProfile(s, p.id)
  profile.name = name(p.name)
  return profile
}

function assignProfile(s, p) {
  const space = getSpace(s, p.spaceId ?? s.activeSpaceId)
  const profile = getProfile(s, p.profileId)
  if (space.incognito) throw bad('Incognito cannot use a persistent profile')
  space.profileId = profile.id
  space.sessionPartition = profile.partition
  return space
}

function removeProfile(s, p) {
  const profile = getProfile(s, p.id)
  if (profile.partition === 'persist:main') throw bad('The default profile cannot be removed')
  const fallback = ensureProfile(s, 'persist:main')
  for (const space of s.spaces) if (space.profileId === profile.id) assignProfile(s, { spaceId: space.id, profileId: fallback.id })
  for (const tab of [...s.tabs, ...s.archive, ...s.agentTabs]) if (tab.profileId === profile.id) delete tab.profileId
  s.linkRules = s.linkRules.filter((x) => x.profileId !== profile.id)
  s.profiles.splice(s.profiles.indexOf(profile), 1)
  return null
}

function linkHost(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) throw bad('host must be an exact hostname or *.suffix')
  const wildcard = value.startsWith('*.')
  const host = wildcard ? value.slice(2) : value
  if (!wildcard && /^\[[0-9a-f:]+\]$/i.test(host)) {
    try { return new URL(`https://${host}`).hostname } catch { throw bad('Invalid IPv6 hostname') }
  }
  if (!host || /[\\/:?#@\s*%]/.test(host)) throw bad('host must not include a scheme, port, path or credentials')
  let normalized
  try { normalized = new URL(`https://${host}`).hostname } catch { throw bad('Invalid hostname') }
  if (!normalized || normalized.endsWith('.') || normalized.length > 253 || normalized.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw bad('Invalid hostname')
  if (wildcard && (!normalized.includes('.') || /^[0-9.]+$/.test(normalized))) throw bad('Wildcard must name a domain suffix')
  return (wildcard ? '*.' : '') + normalized
}

function setLinkRule(s, p) {
  const previous = p.id === undefined ? null : s.linkRules.find((x) => x.id === p.id)
  if (p.id !== undefined && !previous) throw err('not_found', `No link rule ${p.id}`)
  const host = linkHost(p.host)
  const space = getSpace(s, p.spaceId)
  if (space.incognito) throw bad('External links cannot target incognito')
  const profile = p.profileId === undefined || p.profileId === null ? null : getProfile(s, p.profileId)
  if (s.linkRules.some((x) => x !== previous && x.host === host)) throw bad('A rule for this host already exists')
  const value = { id: previous?.id || newId('r'), host, spaceId: space.id, ...(profile && { profileId: profile.id }) }
  if (previous) s.linkRules.splice(s.linkRules.indexOf(previous), 1, value)
  else s.linkRules.push(value)
  return value
}

function removeLinkRule(s, p) {
  const index = s.linkRules.findIndex((x) => x.id === p.id)
  if (index < 0) throw err('not_found', `No link rule ${p.id}`)
  s.linkRules.splice(index, 1)
  return null
}

function routeLink(s, p) {
  const url = webUrl(p.url)
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw bad('External links must use http or https')
  const host = parsed.hostname.toLowerCase()
  const candidates = s.linkRules.filter((rule) => rule.host === host || rule.host.startsWith('*.') && host.endsWith(rule.host.slice(1)) && host !== rule.host.slice(2))
  candidates.sort((a, b) => Number(a.host.startsWith('*.')) - Number(b.host.startsWith('*.')) || b.host.length - a.host.length)
  const rule = candidates[0]
  const space = rule ? getSpace(s, rule.spaceId) : normalSpace(s)
  const profile = s.profiles.find((x) => x.id === (rule?.profileId || space.profileId))
  return { url, spaceId: space.id, ...(profile && { profileId: profile.id }), sessionPartition: rule?.profileId ? profile.partition : space.sessionPartition || 'persist:main' }
}

function splitRatio(value = .5) {
  if (!Number.isFinite(value) || value < .1 || value > .9) throw bad('ratio must be between 0.1 and 0.9')
  return value
}

function setSplit(s, p, now) {
  if (!Array.isArray(p.ids) || p.ids.length !== 2 || !p.ids.every((id) => typeof id === 'string' && id) || p.ids[0] === p.ids[1]) throw bad('Split needs two distinct tab IDs')
  const tabs = p.ids.map((id) => getTab(s, id))
  if (tabs.some((t) => t.agent || t.userPeek || t.chat || !/^https?:/.test(t.url)) || tabs[0].spaceId !== tabs[1].spaceId) throw bad('Split needs two web tabs in the same space')
  const spaceId = tabs[0].spaceId
  const activeId = p.activeId ?? (p.ids.includes(s.activeTabBySpace[spaceId]) ? s.activeTabBySpace[spaceId] : p.ids[0])
  if (!p.ids.includes(activeId)) throw bad('activeId must belong to the split')
  const split = { ids: [...p.ids], ratio: splitRatio(p.ratio), activeId }
  s.splitBySpace[spaceId] = split
  if (now !== undefined) activateTab(s, { id: activeId }, now)
  return split
}

function resizeSplit(s, p) {
  const spaceId = getSpace(s, p.spaceId ?? s.activeSpaceId).id
  const split = s.splitBySpace[spaceId]
  if (!split) throw err('not_found', 'No split in this space')
  if (p.ratio === undefined) throw bad('ratio is required')
  split.ratio = splitRatio(p.ratio)
  return split
}

function clearSplit(s, p = {}) {
  const spaceId = getSpace(s, p.spaceId ?? s.activeSpaceId).id
  delete s.splitBySpace[spaceId]
  return null
}

function cleanupSplit(s, id) {
  for (const [spaceId, split] of Object.entries(s.splitBySpace)) if (split.ids.includes(id)) delete s.splitBySpace[spaceId]
}

function createPeek(s, p, now) {
  const source = getTab(s, p.sourceId)
  if (source.agent || source.userPeek || source.chat) throw bad('Peek source must be a user web tab')
  if (source.spaceId !== s.activeSpaceId) throw bad('Peek source must be in the active space')
  const url = webUrl(p.url)
  if (!/^https?:/.test(url)) throw bad('Peek requires an http or https URL')
  if (s.userPeek) dismissPeek(s, {})
  const tab = { id: newId('t'), spaceId: source.spaceId, sourceId: source.id, sessionPartition: source.sessionPartition, ...(source.profileId && { profileId: source.profileId }), userPeek: true, url, title: url, favicon: '', favorite: false, createdAt: now, lastActiveAt: now, ...here(s), ...(source.browserIdentity !== undefined && { browserIdentity: source.browserIdentity }) }
  s.tabs.push(tab)
  s.userPeek = tab.id
  s.peek = null
  return tab
}

function promotePeek(s, p = {}, now) {
  const tab = getTab(s, p.id ?? s.userPeek)
  if (!tab.userPeek) throw bad('Tab is not a link peek')
  delete tab.userPeek
  delete tab.sourceId
  s.userPeek = null
  if (s.desktops) tab.desktopId = s.desktops.current
  if (s.deskSize) tab.desk = { ...newDesk(s, tab), z: 0 }
  return activateTab(s, { id: tab.id }, now)
}

function dismissPeek(s, p = {}) {
  if (p.id === undefined && !s.userPeek) return null
  const tab = getTab(s, p.id ?? s.userPeek)
  if (!tab.userPeek) throw bad('Tab is not a link peek')
  dropTab(s, tab)
  return { closed: tab.id }
}

function loadOrganization(s, raw) {
  const records = Array.isArray(raw.profiles) ? raw.profiles : []
  for (const p of records) {
    if (!isObject(p) || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name.trim() || !/^persist:[a-zA-Z0-9._-]+$/.test(p.partition) || s.profiles.some((x) => x.id === p.id || x.partition === p.partition)) continue
    s.profiles.push({ id: p.id, name: name(p.name), partition: p.partition })
  }
  ensureProfile(s, 'persist:main')
  for (const space of s.spaces) {
    const assigned = s.profiles.find((x) => x.id === space.profileId)
    const profile = /^persist:[a-zA-Z0-9._-]+$/.test(space.sessionPartition) ? ensureProfile(s, space.sessionPartition) : assigned || ensureProfile(s, 'persist:main')
    space.profileId = profile.id
    space.sessionPartition = profile.partition
  }
  for (const tab of [...s.tabs, ...s.archive]) {
    const partition = tab.sessionPartition || findSpace(s, tab.spaceId)?.sessionPartition || 'persist:main'
    tab.sessionPartition = partition
    const profile = s.profiles.find((x) => x.partition === partition) || (!Array.isArray(raw.profiles) && /^persist:[a-zA-Z0-9._-]+$/.test(partition) ? ensureProfile(s, partition) : null)
    if (profile) tab.profileId = profile.id
    else delete tab.profileId
    if (tab.trailCollapsed !== true) delete tab.trailCollapsed
  }
  for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
    if (!isObject(f) || typeof f.id !== 'string' || !f.id || typeof f.name !== 'string' || !f.name || !findSpace(s, f.spaceId) || s.folders.some((x) => x.id === f.id)) continue
    s.folders.push({ id: f.id, name: f.name, spaceId: f.spaceId, parentId: typeof f.parentId === 'string' ? f.parentId : null, collapsed: f.collapsed === true, ...(f.arcSourceId && { arcSourceId: f.arcSourceId }) })
  }
  for (const f of s.folders) {
    const seen = new Set([f.id])
    for (let id = f.parentId; id;) {
      const parent = s.folders.find((x) => x.id === id)
      if (!parent || parent.spaceId !== f.spaceId || seen.has(id)) { f.parentId = null; break }
      seen.add(id)
      id = parent.parentId
    }
  }
  for (const tab of s.tabs) {
    if (!tab.pinned || tab.favorite) { delete tab.folderId; continue }
    let value = s.folders.find((x) => x.id === tab.folderId && x.spaceId === tab.spaceId)
    if (!value && typeof tab.folder === 'string' && tab.folder) {
      // A legacy label is one literal name, not a guessed hierarchy.
      value = s.folders.find((x) => x.spaceId === tab.spaceId && folderPath(s, x) === tab.folder)
      if (!value) { value = { id: newId('f'), name: tab.folder, spaceId: tab.spaceId, parentId: null, collapsed: false }; s.folders.push(value) }
    }
    if (value) tab.folderId = value.id
    else delete tab.folderId
  }
  for (const [key, collapsed] of Object.entries(Array.isArray(raw.folders) ? {} : s.collapsed)) {
    if (!collapsed) continue
    const space = s.spaces.find((x) => key.startsWith(`${x.id}/`))
    if (space) {
      const value = ensureFolder(s, space.id, key.slice(space.id.length + 1))
      if (value) value.collapsed = true
    }
  }
  refreshFolderLabels(s)
  for (const rule of Array.isArray(raw.linkRules) ? raw.linkRules : []) {
    try {
      if (!isObject(rule) || typeof rule.id !== 'string' || !rule.id || s.linkRules.some((x) => x.id === rule.id)) continue
      const value = setLinkRule(s, { ...rule, id: undefined })
      value.id = rule.id
    } catch { /* Ignore invalid destinations rather than routing externally into private state. */ }
  }
}

function delta(value) {
  if (!Number.isInteger(value)) throw bad('delta must be an integer')
  return value
}

function createSpace(s, p) {
  const space = { id: newId('s'), name: name(p.name), color: p.color === undefined ? COLORS[s.spaces.length % COLORS.length] : color(p.color) }
  const profile = p.profileId === undefined ? s.profiles.find((x) => x.partition === 'persist:main') : getProfile(s, p.profileId)
  if (profile) Object.assign(space, { profileId: profile.id, sessionPartition: profile.partition })
  s.spaces.push(space)
  return space
}

function updateSpace(s, p) {
  const space = getSpace(s, p.id)
  const next = {}
  if (p.name !== undefined) next.name = name(p.name)
  if (p.color !== undefined) {
    next.color = color(p.color)
    next.background = null
  }
  return Object.assign(space, next)
}

function moveSpace(s, p) {
  const space = getSpace(s, p.id)
  if (!Number.isInteger(p.index)) throw bad('index must be an integer')
  const index = Math.max(0, Math.min(s.spaces.length - 1, p.index))
  s.spaces.splice(s.spaces.indexOf(space), 1)
  s.spaces.splice(index, 0, space)
  return space
}

function removeSpace(s, p, now) {
  const space = getSpace(s, p.id)
  if (!space.incognito && s.spaces.filter((x) => !x.incognito).length === 1) throw bad('The last space cannot be removed')
  const i = s.spaces.indexOf(space)
  for (const tab of s.tabs.filter((t) => t.spaceId === space.id)) (space.incognito || tab.userPeek ? dropTab : archiveTab)(s, tab, now)
  s.agentTabs = s.agentTabs.filter((t) => t.spaceId !== space.id)
  if (!findTab(s, s.peek)) s.peek = null
  s.spaces.splice(i, 1)
  delete s.activeTabBySpace[space.id]
  delete s.splitBySpace[space.id]
  s.folders = s.folders.filter((x) => x.spaceId !== space.id)
  s.linkRules = s.linkRules.filter((x) => x.spaceId !== space.id)
  for (const key of Object.keys(s.collapsed)) if (key.startsWith(`${space.id}/`)) delete s.collapsed[key]
  if (s.activeSpaceId === space.id) s.activeSpaceId = s.spaces[Math.max(0, i - 1)].id
  return null
}

function activateSpace(s, p) {
  const spaceId = getSpace(s, p.id).id
  if (s.userPeek && getTab(s, s.userPeek).spaceId !== spaceId) dismissPeek(s, {})
  s.activeSpaceId = spaceId
  s.peek = null
  if (p.show !== false) look(s)
  return null
}

function cycleSpace(s, p) {
  const n = s.spaces.length
  const i = s.spaces.findIndex((x) => x.id === s.activeSpaceId)
  activateSpace(s, { id: s.spaces[(((i + delta(p.delta)) % n) + n) % n].id })
  return null
}

// A persistent partition, so the built-in blocker runs there; the main process wipes its site data when the space closes and at every start.
const INCOGNITO_PARTITION = 'persist:incognito'

function openIncognito(s) {
  let space = s.spaces.find((x) => x.incognito)
  if (!space) s.spaces.push(space = { id: newId('s'), name: 'Incognito', color: '#5f6b7a', incognito: true, sessionPartition: INCOGNITO_PARTITION })
  activateSpace(s, { id: space.id })
  return space
}

function persistable(s) {
  const gone = new Set(s.spaces.filter((x) => x.incognito).map((x) => x.id))
  const keep = (map) => Object.fromEntries(Object.entries(map).filter(([key]) => !gone.has(key.split('/')[0])))
  const { deskSize, deskTop, deskAvoid, desktops, agentTabs, peek, userPeek, ...rest } = s
  return { ...rest, spaces: s.spaces.filter((x) => !x.incognito), tabs: s.tabs.filter((t) => !gone.has(t.spaceId) && !t.userPeek), folders: s.folders.filter((f) => !gone.has(f.spaceId)), splitBySpace: keep(s.splitBySpace), activeSpaceId: normalSpace(s).id, activeTabBySpace: keep(s.activeTabBySpace), collapsed: keep(s.collapsed) }
}

// In a desk window (s.deskSize set) a favorite or pinned tab becomes a window when activated and stays one until hidden.
// An agent tab is peeked instead: shown over the current space without becoming its active tab.
function activateTab(s, p, now) {
  const tab = getTab(s, p.id)
  s.peek = tab.agent ? tab.id : null
  if (tab.agent) return tab
  if (tab.userPeek) {
    if (tab.spaceId !== s.activeSpaceId) throw bad('Peek must remain in the active space')
    s.userPeek = tab.id
    return tab
  }
  for (let parent = findTab(s, tab.parentId); parent; parent = findTab(s, parent.parentId)) delete parent.trailCollapsed
  const split = s.splitBySpace[tab.spaceId]
  if (split?.ids.includes(tab.id)) split.activeId = tab.id
  if (!tab.desk && !isPlain(tab) && s.deskSize) tab.desk = { ...defaultDesk(s, tab), z: 0 }
  if (tab.desk) {
    delete tab.desk.hidden
    front(s, tab)
  }
  // macOS has no way to switch desktops, so a tab from another one comes here instead.
  if (s.desktops) tab.desktopId = s.desktops.current
  activateSpace(s, { id: tab.spaceId, show: false })
  const previous = activeTab(s)
  if (previous) previous.lastActiveAt = now
  s.activeTabBySpace[s.activeSpaceId] = tab.id
  tab.lastActiveAt = now
  look(s)
  return tab
}

// chat {id, agent, title, favicon} makes a conversation tab; only the agent core passes it.
// agent makes a tab of that agent: kept apart from the tab list, never saved or archived, and never activated on creation.
function createTab(s, p, now, chat) {
  const url = chat ? `skiff://chat/${chat.id}` : navUrl(s, p.url)
  if (p.agent !== undefined) return createAgentTab(s, p, url, now)
  const spaceId = p.spaceId === undefined ? s.activeSpaceId : getSpace(s, p.spaceId).id
  const parent = s.tabs.find((t) => t.id === p.parentId)
  const space = getSpace(s, spaceId)
  const profile = p.profileId === undefined ? s.profiles.find((x) => x.id === space.profileId) : getProfile(s, p.profileId)
  if (space.incognito && p.profileId !== undefined) throw bad('Incognito tabs cannot use persistent profiles')
  const partition = p.profileId !== undefined ? profile.partition : space.sessionPartition || profile?.partition || 'persist:main'
  const tab = { id: newId('t'), spaceId, sessionPartition: partition, ...(profile?.partition === partition && { profileId: profile.id }), url, title: chat ? chat.title : url, favicon: chat ? chat.favicon : '', favorite: false, status: chat ? 'active' : 'progress', lastActiveAt: now, createdAt: now, ...here(s), ...(whatsappURL(url) && { browserIdentity: 'compatible' }), ...(chat && { chat: { agent: chat.agent, sessionId: null } }) }
  if (parent && parent.spaceId === spaceId && isPlain(parent)) tab.parentId = parent.id
  s.tabs.push(tab)
  if (s.deskSize) {
    tab.desk = { ...newDesk(s, tab), z: 0 }
    if (p.activate === false) behind(s, tab)
    else front(s, tab)
  }
  if (p.activate !== false) activateTab(s, { id: tab.id }, now)
  return tab
}

function createAgentTab(s, p, url, now) {
  const agent = typeof p.agent === 'string' ? p.agent.trim().slice(0, 40) : ''
  if (!agent) throw bad('agent must be a non-empty string')
  const space = p.spaceId === undefined ? normalSpace(s) : getSpace(s, p.spaceId)
  if (space.incognito) throw bad('Agent tabs cannot open in the incognito space')
  const tab = { id: newId('t'), spaceId: space.id, sessionPartition: space.sessionPartition || 'persist:main', url, title: url, favicon: '', agent, ...(whatsappURL(url) && { browserIdentity: 'compatible' }), createdAt: now, lastActiveAt: now }
  s.agentTabs.push(tab)
  return tab
}

const userTab = (s, id) => {
  const tab = getTab(s, id)
  if (tab.agent || tab.userPeek) throw bad('Agent tabs and unpromoted peeks cannot be moved, pinned or made favorites')
  return tab
}

function closeTab(s, p, now) {
  const tab = getTab(s, p.id)
  if (tab.userPeek) return dismissPeek(s, { id: tab.id })
  if (tab.agent) {
    s.agentTabs.splice(s.agentTabs.indexOf(tab), 1)
    if (s.peek === tab.id) s.peek = null
    return { closed: tab.id }
  }
  if (isIncognito(s, tab.spaceId)) {
    dropTab(s, tab)
    return { closed: tab.id }
  }
  if (!tab.favorite && !tab.pinned) {
    archiveTab(s, tab, now)
    return { archived: tab.id }
  }
  cleanupSplit(s, tab.id)
  if (tab.desk) tab.desk.hidden = true
  if (s.activeTabBySpace[tab.spaceId] === tab.id) {
    const next = s.tabs.filter((t) => !t.favorite && !t.pinned && t.spaceId === tab.spaceId && (!s.desktops || t.desktopId === tab.desktopId)).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
    if (next) s.activeTabBySpace[tab.spaceId] = next.id
    else delete s.activeTabBySpace[tab.spaceId]
    if (tab.spaceId === s.activeSpaceId) look(s)
  }
  return { unloaded: tab.id }
}

function navigateTab(s, p, now) {
  const tab = getTab(s, p.id)
  const url = navUrl(s, p.url)
  if (p.browserIdentity !== undefined && p.browserIdentity !== null && !validTabIdentity(p.browserIdentity)) throw bad('browserIdentity must be native, compatible or null')
  delete tab.chat
  if (p.browserIdentity !== undefined) tab.browserIdentity = p.browserIdentity
  return Object.assign(tab, { url, title: url, favicon: origin(url) === origin(tab.url) ? tab.favicon : '', lastActiveAt: now })
}

// A tab takes the session of the space it lands in, so a Dev tab moved to Work has Work's sign-ins; the old tab-level identity belonged to the old profile.
function joinSession(s, tab, space) {
  const partition = space.sessionPartition || 'persist:main'
  if ((tab.sessionPartition || 'persist:main') === partition) return false
  tab.sessionPartition = partition
  if (space.profileId) tab.profileId = space.profileId
  else delete tab.profileId
  delete tab.browserIdentity
  if (whatsappURL(tab.url)) tab.browserIdentity = 'compatible'
  return true
}

function moveTab(s, p, now) {
  const tab = getTab(s, p.id)
  if (!tab.userPeek) userTab(s, p.id)
  else if (p.spaceId === undefined) throw bad('A link peek moves only to a space, which makes it a tab there')
  if (p.index !== undefined && !(Number.isInteger(p.index) && p.index >= 0)) throw bad('index must be a non-negative integer')
  if (p.spaceId !== undefined && getSpace(s, p.spaceId).id !== tab.spaceId) {
    if (isIncognito(s, p.spaceId) !== isIncognito(s, tab.spaceId)) throw bad('Tabs cannot move into or out of the incognito space')
    const destinationFolder = tab.folderId ? ensureFolder(s, p.spaceId, tab.folder) : null
    cleanupSplit(s, tab.id)
    release(s, tab)
    detach(s, tab)
    tab.spaceId = p.spaceId
    if (destinationFolder) tab.folderId = destinationFolder.id
    joinSession(s, tab, getSpace(s, p.spaceId))
  }
  s.tabs.splice(s.tabs.indexOf(tab), 1)
  const peers = s.tabs.filter((t) => t.spaceId === tab.spaceId && t.favorite === tab.favorite && !t.pinned === !tab.pinned && (t.folder || '') === (tab.folder || '') && t.parentId === tab.parentId)
  const before = p.index === undefined ? undefined : peers[p.index]
  const at = before ? s.tabs.indexOf(before) : peers.length ? s.tabs.indexOf(peers.at(-1)) + 1 : s.tabs.length
  s.tabs.splice(at, 0, tab)
  tab.lastActiveAt = now
  return tab.userPeek ? promotePeek(s, { id: tab.id }, now) : tab
}

function setFavorite(s, p, now) {
  const tab = userTab(s, p.id)
  if (typeof p.favorite !== 'boolean') throw bad('favorite must be true or false')
  if (p.favorite) detach(s, tab)
  if (p.favorite) delete tab.folderId
  if (p.favorite) unmark(tab)
  else if (tab.favorite) mark(tab, 'active', now)
  return Object.assign(tab, { favorite: p.favorite, lastActiveAt: now }, p.favorite && { pinned: false, folder: '' })
}

function setPinned(s, p, now) {
  const tab = userTab(s, p.id)
  if (typeof p.pinned !== 'boolean') throw bad('pinned must be true or false')
  const group = p.pinned ? (p.folderId ? getFolder(s, p.folderId) : ensureFolder(s, tab.spaceId, folder(p.folder))) : null
  if (group && group.spaceId !== tab.spaceId) throw bad('Folder must be in the tab space')
  if (p.pinned) detach(s, tab)
  if (p.pinned && tab.favorite) setFavorite(s, { id: tab.id, favorite: false }, now)
  if (group) tab.folderId = group.id
  else delete tab.folderId
  if (p.pinned) unmark(tab)
  else if (tab.pinned) mark(tab, 'active', now)
  return Object.assign(tab, { pinned: p.pinned, folder: group ? folderPath(s, group) : '', lastActiveAt: now })
}

// Moves by hand; progress is only ever set by a page or chat starting to work.
function setBucket(s, p, now) {
  const tab = userTab(s, p.id)
  if (!BUCKETS.includes(p.bucket) || p.bucket === 'progress') throw bad(`bucket must be one of ${BUCKETS.filter((b) => b !== 'progress').join(', ')}`)
  if (bucketOf(tab) === p.bucket) return tab
  if (p.bucket === 'favorites') return setFavorite(s, { id: tab.id, favorite: true }, now)
  if (p.bucket === 'later') return setPinned(s, { id: tab.id, pinned: true, folder: '' }, now)
  if (tab.favorite) setFavorite(s, { id: tab.id, favorite: false }, now)
  if (tab.pinned) setPinned(s, { id: tab.id, pinned: false }, now)
  mark(tab, p.bucket, now)
  return tab
}

// Showing the active tab ends its wait: unread and done become active. Returns whether it changed.
function look(s) {
  const tab = activeTab(s)
  if (tab?.status !== 'unread' && tab?.status !== 'done') return false
  mark(tab, 'active')
  return true
}

// A web page finished loading: seen if the user is watching it, else unread. Only a tab still in progress moves.
function settle(s, id, watching) {
  const tab = findTab(s, id)
  if (tab?.status !== 'progress' || tab.chat) return false
  mark(tab, watching ? 'active' : 'unread')
  return true
}

// A chat is working (busy) or has stopped, or is waiting for a permission answer (not busy): progress while busy, then seen or unread.
function chatState(s, tabId, busy, watching) {
  const tab = s.tabs.find((t) => t.id === tabId)
  if (!tab?.chat || !isPlain(tab)) return false
  if (busy) {
    if (tab.status === 'progress') return false
    mark(tab, 'progress')
  } else if (tab.status === 'progress') mark(tab, watching ? 'active' : 'unread')
  else return false
  return true
}

function setCollapsed(s, p) {
  const spaceId = p.spaceId === undefined ? s.activeSpaceId : getSpace(s, p.spaceId).id
  if (typeof p.collapsed !== 'boolean') throw bad('collapsed must be true or false')
  const group = p.folderId ? getFolder(s, p.folderId) : ensureFolder(s, spaceId, folder(p.folder))
  if (!group) throw bad('folder must be a non-empty string')
  group.collapsed = p.collapsed
  refreshFolderLabels(s)
  return null
}

// ponytail: pinned tabs are skipped because the state does not know which are loaded
const cycleList = (s) => visibleTabs(s).filter((t) => !t.pinned && onDesktop(s, t))

function cycleTab(s, p, now) {
  const d = delta(p.delta)
  const list = cycleList(s)
  const n = list.length
  if (!n) return null
  const i = list.indexOf(activeTab(s))
  const next = i < 0 ? (d < 0 ? n - 1 : 0) : (((i + d) % n) + n) % n
  return activateTab(s, { id: list[next].id }, now)
}

function selectTab(s, p, now) {
  if (!Number.isInteger(p.index)) throw bad('index must be an integer')
  const list = cycleList(s)
  const tab = list[p.index < 0 ? list.length + p.index : p.index]
  return tab ? activateTab(s, { id: tab.id }, now) : null
}

function deskRect(p) {
  const rect = isObject(p) ? { x: p.x, y: p.y, width: p.width, height: p.height } : {}
  return Object.values(rect).every(Number.isFinite) && rect.width >= 240 && rect.height >= 160 ? rect : null
}

function front(s, tab) {
  tab.desk.z = Math.max(0, ...deskTabs(s, tab.spaceId).filter((t) => t !== tab).map((t) => t.desk.z)) + 1
}

// A window opened in the background goes directly beneath the active one, never above it.
function behind(s, tab) {
  const order = deskTabs(s, tab.spaceId).filter((t) => t !== tab)
  const active = order.findIndex((t) => s.activeTabBySpace[tab.spaceId] === t.id)
  order.splice(active < 0 ? order.length : active, 0, tab)
  order.forEach((t, i) => { t.desk.z = i + 1 })
}

function placeDesk(s, p) {
  const tab = getTab(s, p.id)
  const rect = deskRect(p)
  if (!rect) throw bad('x, y, width and height must be numbers, width at least 240 and height at least 160')
  // An arranged window keeps its own rect, so a drag or tile in a non-Free layout snaps back and Free finds it where it was.
  const arranged = s.settings.tabLayout !== 'free' && tab.desk
  const { x, y, width, height } = arranged || rect
  tab.desk = { x, y, width, height, z: 0 }
  front(s, tab)
  const host = hostOf(tab.url)
  if (!arranged && host && !tab.agent && !isIncognito(s, tab.spaceId)) {
    delete s.deskHosts[host]
    s.deskHosts[host] = rect
    for (const old of Object.keys(s.deskHosts).slice(0, -HOSTS)) delete s.deskHosts[old]
  }
  return tab
}

function deskOf(s) {
  if (!s.deskSize) throw err('not_found', 'No desk window is open')
  return { ...s.deskSize, top: s.deskTop || 0 }
}

// Window rects in an 8px margin with 8px gaps, each leaving its frame's top inset free above it.
function deskLayouts(s) {
  const { width: W, height: H, top: T } = deskOf(s)
  const m = MARGIN
  const box = ([l, r], [t, b]) => ({ x: Math.round(l), y: Math.round(t), width: Math.max(240, Math.round(r) - Math.round(l)), height: Math.max(160, Math.round(b) - Math.round(t)) })
  const col = (n, i, span = 1) => {
    const w = (W - (n + 1) * m) / n
    return [m + i * (w + m), m + (i + span) * (w + m) - m]
  }
  const half = (H - 3 * m - 2 * T) / 2
  const full = [m + T, H - m]
  const upper = [m + T, m + T + half]
  const lower = [H - m - half, H - m]
  const w = W * 0.6
  const h = H * 0.75
  return {
    fill: box(col(1, 0), full),
    center: box([(W - w) / 2, (W + w) / 2], [T + (H - T - h) / 2, T + (H - T + h) / 2]),
    left: box(col(2, 0), full),
    right: box(col(2, 1), full),
    top: box(col(1, 0), upper),
    bottom: box(col(1, 0), lower),
    'left-third': box(col(3, 0), full),
    'center-third': box(col(3, 1), full),
    'right-third': box(col(3, 2), full),
    'left-two-thirds': box(col(3, 0, 2), full),
    'right-two-thirds': box(col(3, 1, 2), full),
    'top-left': box(col(2, 0), upper),
    'top-right': box(col(2, 1), upper),
    'bottom-left': box(col(2, 0), lower),
    'bottom-right': box(col(2, 1), lower)
  }
}

function tileDesk(s, p) {
  const layouts = deskLayouts(s)
  if (typeof p.layout !== 'string' || !Object.hasOwn(layouts, p.layout)) throw bad(`layout must be one of ${Object.keys(layouts).join(', ')}`)
  return placeDesk(s, { id: p.id, ...layouts[p.layout] })
}

const gridOf = (a, n, byColumn = true) => Array.from({ length: n }, (_, i) => {
  const size = ((byColumn ? a.w : a.h) - (n - 1) * MARGIN) / n
  return byColumn ? { ...a, x: a.x + i * (size + MARGIN), w: size } : { ...a, y: a.y + i * (size + MARGIN), h: size }
})

// One cell per window, in the desk area inside its margin; a window's frame inset is taken from the top of its cell afterwards.
const ARRANGEMENTS = {
  full: (n, a) => Array(n).fill(a),
  sections: (n, a) => {
    const sections = gridOf(a, 2, false).flatMap((row) => gridOf(row, 4))
    return Array.from({ length: n }, (_, i) => sections[i % sections.length])
  },
  split: (n, a) => gridOf(a, n),
  grid: (n, a) => {
    const columns = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / columns)
    return gridOf(a, rows, false).flatMap((row, i) => gridOf(row, i < rows - 1 ? columns : n - columns * (rows - 1)))
  },
  'main-stack': (n, a) => {
    if (n === 1) return [a]
    const w = (a.w - MARGIN) * 0.6
    return [{ ...a, w }, ...gridOf({ ...a, x: a.x + w + MARGIN, w: a.w - w - MARGIN }, n - 1, false)]
  },
  spiral: (n, a) => {
    const cells = []
    for (let i = 0; i < n - 1; i++) {
      const across = i % 2 === 0
      const size = ((across ? a.w : a.h) - MARGIN) / 2
      cells.push(across ? { ...a, w: size } : { ...a, h: size })
      a = across ? { ...a, x: a.x + size + MARGIN, w: size } : { ...a, y: a.y + size + MARGIN, h: size }
    }
    return [...cells, a]
  },
  cascade: (n, a) => {
    const w = a.w * 0.7
    const h = a.h * 0.7
    const steps = Math.floor(Math.min(a.w - w, a.h - h) / OFFSET) + 1
    return Array.from({ length: n }, (_, i) => ({ x: a.x + OFFSET * (i % steps), y: a.y + OFFSET * (i % steps), w, h }))
  }
}

// Rect of every shown window of the active space by tab id, as the desk draws it in this layout mode; free is each window's own rect.
// Window order is tab order, so what is on top is still the stacking (z) order.
function arrange(s, mode) {
  const shown = new Set(shownTabs(s))
  const tabs = s.tabs.filter((t) => shown.has(t) && t.desk)
  const rects = Object.fromEntries(tabs.map((t) => [t.id, { x: t.desk.x, y: t.desk.y, width: t.desk.width, height: t.desk.height }]))
  if (!Object.hasOwn(ARRANGEMENTS, mode) || !s.deskSize || !tabs.length) return rects
  const { width: W, height: H, top: T } = deskOf(s)
  const active = tabs.find((t) => s.activeTabBySpace[t.spaceId] === t.id)
  const order = mode === 'main-stack' && active ? [active, ...tabs.filter((t) => t !== active)] : tabs
  const cells = ARRANGEMENTS[mode](order.length, { x: MARGIN, y: MARGIN, w: W - 2 * MARGIN, h: H - 2 * MARGIN })
  order.forEach((t, i) => {
    const { x, y, w, h } = cells[i]
    rects[t.id] = { x: Math.round(x), y: Math.round(y) + T, width: Math.round(x + w) - Math.round(x), height: Math.round(y + h) - Math.round(y) - T }
  })
  return rects
}

// The largest rectangle of the desk that no rect overlaps: its sides lie on desk edges or rect edges, so trying every pair of those suffices.
function largestGap(W, H, rects) {
  const xs = [...new Set([0, W, ...rects.flatMap((r) => [r.x, r.x + r.width])])].filter((x) => x >= 0 && x <= W).sort((a, b) => a - b)
  let best = null
  for (const [i, l] of xs.entries()) {
    for (const r of xs.slice(i + 1)) {
      const cuts = rects.filter((o) => o.x < r && o.x + o.width > l).map((o) => [o.y, o.y + o.height]).sort((a, b) => a[0] - b[0])
      let y = 0
      for (const [top, bottom] of [...cuts, [H, H]]) {
        const height = Math.min(top, H) - y
        if (height > 0 && (r - l) * height > (best ? best.width * best.height : 0)) best = { x: l, y, width: r - l, height }
        y = Math.max(y, bottom)
      }
    }
  }
  return best
}

// A new window goes where its host's windows were last put (28px down and right of one showing there), else into the largest free part of the desk, else to the cascade.
// s.deskAvoid, the open Buoy card, is never covered when any part of the desk beside it can hold a window.
function newDesk(s, tab) {
  const rect = placeNew(s, tab)
  const avoid = s.deskAvoid
  if (!avoid || !meets({ ...rect, y: rect.y - (s.deskTop || 0), height: rect.height + (s.deskTop || 0) }, avoid)) return rect
  const { width: W, height: H, top: T } = deskOf(s)
  const others = shownTabs(s, tab.spaceId).filter((t) => t !== tab).map((t) => t.desk || defaultDesk(s, t))
  const framed = (r) => ({ x: r.x, y: r.y - T, width: r.width, height: r.height + T })
  for (const rects of [[...others.map(framed), avoid], [avoid]]) {
    const gap = largestGap(W, H, rects)
    if (gap && gap.width - 2 * MARGIN >= 240 && gap.height - 2 * MARGIN - T >= 160) {
      const width = Math.min(rect.width, gap.width - 2 * MARGIN)
      const height = Math.min(rect.height, gap.height - 2 * MARGIN - T)
      return { x: Math.round(gap.x + (gap.width - width) / 2), y: Math.round(gap.y + T + (gap.height - T - height) / 2), width, height }
    }
  }
  return rect
}
const meets = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

function placeNew(s, tab) {
  const { width: W, height: H, top: T } = deskOf(s)
  const others = shownTabs(s, tab.spaceId).filter((t) => t !== tab).map((t) => t.desk || defaultDesk(s, t))
  const last = s.deskHosts[hostOf(tab.url)]
  if (last) {
    const width = Math.min(last.width, Math.max(240, W))
    const height = Math.min(last.height, Math.max(160, H))
    let rect = { x: Math.max(0, Math.min(last.x, W - width)), y: Math.max(0, Math.min(last.y, H - height)), width, height }
    const taken = (r) => others.some((o) => o.x === r.x && o.y === r.y && o.width === r.width && o.height === r.height)
    // Each step down and right gives up what would leave the desk, down to the smallest window.
    for (let i = 0; taken(rect) && i < 50; i++) {
      const x = rect.x + OFFSET
      const y = rect.y + OFFSET
      rect = { x, y, width: Math.max(240, Math.min(rect.width, W - x)), height: Math.max(160, Math.min(rect.height, H - y)) }
    }
    return rect
  }
  const gap = largestGap(W, H, others.map((o) => ({ x: o.x, y: o.y - T, width: o.width, height: o.height + T })))
  if (gap && gap.width - 2 * MARGIN >= 520 && gap.height - 2 * MARGIN >= 360) return { x: gap.x + MARGIN, y: gap.y + MARGIN + T, width: gap.width - 2 * MARGIN, height: gap.height - 2 * MARGIN - T }
  return defaultDesk(s, tab)
}

function hideDesk(s, p) {
  const tab = getTab(s, p.id)
  if (tab.agent) {
    if (s.peek === tab.id) s.peek = null
    return tab
  }
  if (tab.userPeek) { dismissPeek(s, { id: tab.id }); return tab }
  cleanupSplit(s, tab.id)
  tab.desk = { ...(tab.desk || { ...defaultDesk(s, tab), z: 0 }), hidden: true }
  if (s.activeTabBySpace[tab.spaceId] === tab.id) {
    delete s.activeTabBySpace[tab.spaceId]
    const next = shownTabs(s, tab.spaceId).at(-1)
    if (next) s.activeTabBySpace[tab.spaceId] = next.id
  }
  return tab
}

function showDesk(s, p, now) {
  if (typeof p.id !== 'string') throw bad('id must be a tab id')
  return activateTab(s, p, now)
}

// tabs.thumbnails: the tabs to capture in the order asked, null for an incognito tab while another space shows, and the image width.
function thumbnailTabs(s, p) {
  if (!Array.isArray(p.ids) || p.ids.length > 24 || !p.ids.every((id) => typeof id === 'string')) throw bad('ids must be a list of at most 24 tab ids')
  const width = p.width ?? 480
  if (!Number.isFinite(width) || width < 16 || width > 3840) throw bad('width must be a number from 16 to 3840')
  const tabs = p.ids.map((id) => {
    const tab = findTab(s, id)
    if (!tab) throw bad(`No tab ${id}`)
    return isIncognito(s, tab.spaceId) && tab.spaceId !== s.activeSpaceId ? null : tab
  })
  return { tabs, width: Math.round(width) }
}

// Centred, then 28px down and right per place in the space's tab order, wrapping before it leaves the desk.
function defaultDesk(s, tab) {
  const { width, height } = s.deskSize || s.window
  const w = Math.max(240, Math.round(width * 0.62))
  const h = Math.max(160, Math.round(height * 0.74))
  const steps = Math.max(1, Math.floor(Math.min(width - w, height - h) / 2 / 28) + 1)
  const n = Math.max(0, visibleTabs(s, tab.spaceId).indexOf(tab)) % steps
  return { x: Math.round((width - w) / 2) + 28 * n, y: Math.round((height - h) / 2) + 28 * n, width: w, height: h }
}

// Adopt the desktop list {current, list} (null where there is none): a tab on a desktop that no longer exists joins the current one, and a space whose active tab is on another desktop shows the latest one here, or none.
function setDesktops(s, info, now) {
  if (!info?.list?.length) {
    delete s.desktops
    return
  }
  s.desktops = { current: info.current, list: info.list.map(({ id, number }) => ({ id, number })) }
  for (const tab of s.tabs) if (!s.desktops.list.some((d) => d.id === tab.desktopId)) tab.desktopId = info.current
  for (const [spaceId, id] of Object.entries(s.activeTabBySpace)) {
    const active = s.tabs.find((t) => t.id === id)
    if (!active || onDesktop(s, active)) continue
    active.lastActiveAt = now
    const next = s.tabs.filter((t) => t.spaceId === spaceId && !t.userPeek && onDesktop(s, t)).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
    if (next) s.activeTabBySpace[spaceId] = next.id
    else delete s.activeTabBySpace[spaceId]
  }
}

function restore(s, p, now) {
  const i = p.id === undefined ? 0 : s.archive.findIndex((a) => a.id === p.id)
  const entry = s.archive[i]
  if (!entry) throw err('not_found', p.id === undefined ? 'The archive is empty' : `No archived tab ${p.id}`)
  s.archive.splice(i, 1)
  const spaceId = findSpace(s, entry.spaceId) ? entry.spaceId : normalSpace(s).id
  const tab = { id: entry.id, spaceId, sessionPartition: entry.sessionPartition || 'persist:main', ...(entry.profileId && { profileId: entry.profileId }), ...((entry.browserIdentity === null || validTabIdentity(entry.browserIdentity)) && { browserIdentity: entry.browserIdentity }), arcSourceId: entry.arcSourceId, arcSourceKind: entry.arcSourceKind, url: entry.url, title: entry.title, favicon: entry.favicon, favorite: false, status: entry.chat ? 'active' : 'progress', lastActiveAt: now, createdAt: now, ...here(s), ...(entry.chat && { chat: entry.chat }) }
  s.tabs.push(tab)
  if (s.deskSize) tab.desk = { ...newDesk(s, tab), z: 0 }
  return activateTab(s, { id: tab.id }, now)
}

function removeArchived(s, p) {
  const i = s.archive.findIndex((a) => a.id === p.id)
  if (i < 0) throw err('not_found', `No archived tab ${p.id}`)
  s.archive.splice(i, 1)
  return null
}

function clearArchive(s) {
  s.archive = []
  return null
}

// Step one: a tab not shown for the delay is done. Step two: a tab done for a day is archived. Progress tabs, favorites and pinned tabs stay.
// loading lists the ids of pages still loading; a progress page that is not one of them (never loaded) is unread.
function sweep(s, p, now) {
  const limit = s.settings.autoArchiveHours * HOUR
  const loading = new Set(p.loading)
  const settled = s.tabs.filter((t) => t.status === 'progress' && !t.chat && !loading.has(t.id))
  for (const tab of settled) mark(tab, 'unread')
  const idle = (t) => !t.userPeek && !s.splitBySpace[t.spaceId]?.ids.includes(t.id) && s.activeTabBySpace[t.spaceId] !== t.id
  const done = limit > 0 ? s.tabs.filter((t) => idle(t) && (bucketOf(t) === 'active' || bucketOf(t) === 'unread') && now - t.lastActiveAt > limit) : []
  for (const tab of done) mark(tab, 'done', now)
  const old = s.tabs.filter((t) => t.status === 'done' && idle(t) && !isIncognito(s, t.spaceId) && now - t.doneAt > DONE_HOURS * HOUR)
  for (const tab of old) archiveTab(s, tab, now)
  return { archived: old.map((t) => t.id), done: done.map((t) => t.id), settled: settled.map((t) => t.id) }
}

function importSetup(s, setup, now) {
  const added = { spaces: 0, favorites: 0, pinned: 0, tabs: 0 }
  const partition = setup.sessionPartition || 'persist:main'
  const profile = ensureProfile(s, partition)
  const imported = (item, kind) => item.sourceId && s.tabs.some((t) => t.arcSourceId === item.sourceId && t.arcSourceKind === kind && t.sessionPartition === partition)
  const add = (kind, item, fields, same) => {
    if (imported(item, kind)) return false
    let url
    try {
      url = webUrl(item.url)
    } catch {
      return false
    }
    if (s.tabs.some((t) => t.url === url && (t.sessionPartition || 'persist:main') === partition && same(t))) return false
    s.tabs.push({ id: newId('t'), url, title: item.title, favicon: '', sessionPartition: partition, profileId: profile.id, ...(whatsappURL(url) && { browserIdentity: 'compatible' }), ...(item.sourceId && { arcSourceId: item.sourceId, arcSourceKind: kind }), favorite: false, lastActiveAt: now, createdAt: now, ...fields })
    added[kind]++
    return true
  }
  let first
  for (const from of setup.spaces) {
    const title = name(from.name)
    let space = s.spaces.find((x) => (x.arcSourceId && x.arcSourceId === from.sourceId || x.name === title) && (x.sessionPartition || 'persist:main') === partition)
    if (!space) {
      if (from.pinned.length + from.tabs.length > 0 && from.pinned.every((t) => imported(t, 'pinned')) && from.tabs.every((t) => imported(t, 'tabs'))) continue
      space = createSpace(s, from)
      space.sessionPartition = partition
      space.profileId = profile.id
      if (from.sourceId) space.arcSourceId = from.sourceId
      const theme = background(from.background)
      if (theme) space.background = theme
      added.spaces++
    }
    first ||= space
    // Source identity and unchanged accent protect edits that predate override markers.
    if (space.background === undefined && from.sourceId && space.arcSourceId === from.sourceId &&
        typeof from.color === 'string' && space.color.toLowerCase() === from.color.toLowerCase()) {
      const theme = background(from.background)
      if (theme) space.background = theme
    }
    const here = (t) => !t.favorite && t.spaceId === space.id
    const known = new Set(s.folders.map((f) => f.id))
    const importedFolders = new Map()
    // Arc emits parents before children, with identities independent of their display paths.
    for (const item of from.folders || []) {
      const parent = importedFolders.get(item.parentSourceId)
      const label = parent ? `${folderPath(s, parent)} / ${item.name}` : item.name
      let value = s.folders.find((f) => f.arcSourceId === item.sourceId)
      if (!value) {
        const destination = parent?.spaceId || space.id
        value = s.folders.find((f) => f.spaceId === destination && !f.arcSourceId && folderPath(s, f) === label)
        if (value) Object.assign(value, { name: item.name, parentId: parent?.id || null })
        else value = createFolder(s, { spaceId: destination, name: item.name, parentId: parent?.id })
        value.name = item.name
        value.arcSourceId = item.sourceId
        if (!known.has(value.id)) value.collapsed = true
      }
      importedFolders.set(item.sourceId, value)
    }
    for (const item of from.pinned) {
      const value = importedFolders.get(item.folderSourceId) || ensureFolder(s, space.id, folder(item.folder))
      const group = value ? folderPath(s, value) : ''
      const destination = value?.spaceId || space.id
      const fresh = add('pinned', item, { spaceId: destination, pinned: true, folder: group, ...(value && { folderId: value.id }) }, (t) => !t.favorite && t.spaceId === destination && t.pinned && (value ? t.folderId === value.id : !t.folderId && !t.folder))
      if (fresh && value && !known.has(value.id)) value.collapsed = true
    }
    refreshFolderLabels(s)
    for (const item of from.tabs) add('tabs', item, { spaceId: space.id }, here)
  }
  // ponytail: Arc shares favorites across all spaces of a profile; here they land in the profile's first space
  for (const item of setup.favorites) add('favorites', item, { spaceId: (first || normalSpace(s)).id, favorite: true }, (t) => t.favorite)
  return added
}

// Partial objects merge into current; agents [{name, command}] at most 10, names unique ignoring case; agent '' or one of the names.
function aiSettings(value, current = AI) {
  if (!isObject(value)) throw bad('ai must be an object')
  const next = { ...current, ...value }
  if (!Array.isArray(next.agents) || next.agents.length > 10) throw bad('ai.agents must be a list of at most 10 agents')
  const agents = next.agents.map((a) => {
    const name = typeof a?.name === 'string' ? a.name.trim() : ''
    const command = typeof a?.command === 'string' ? a.command.trim() : ''
    if (!name || name.length > 40) throw bad('Each agent needs a name of at most 40 characters')
    if (!command || command.length > 500) throw bad('Each agent needs a command of at most 500 characters')
    return { name, command }
  })
  if (new Set(agents.map((a) => a.name.toLowerCase())).size < agents.length) throw bad('Agent names must be unique')
  // Removing the chosen agent without naming another falls back to the first.
  const agent = value.agent === undefined && !agents.some((a) => a.name === next.agent) ? agents[0]?.name || '' : next.agent
  if (agent !== '' && !agents.some((a) => a.name === agent)) throw bad(`No agent named ${agent}`)
  for (const key of ['model', 'effort']) if (typeof next[key] !== 'string' || next[key].length > 200) throw bad(`ai.${key} must be a string of at most 200 characters`)
  return { agents, agent, model: next.model, effort: next.effort }
}

function setSettings(s, p) {
  const next = {}
  if (p.tabLayout !== undefined) next.tabLayout = settingsCatalog.validate('tabLayout', p.tabLayout)
  for (const key of ['downloadAskWhere', 'memorySaver', 'transcriptRecovery']) {
    if (p[key] === undefined) continue
    if (typeof p[key] !== 'boolean') throw bad(`${key} must be true or false`)
    next[key] = p[key]
  }
  for (const key of ['historyRetentionDays', 'memorySaverMinutes', 'transcriptRetentionDays']) {
    if (p[key] === undefined) continue
    const min = key === 'historyRetentionDays' ? 0 : 1
    const max = key === 'memorySaverMinutes' ? 10080 : 3650
    if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) throw bad(`${key} must be an integer between ${min} and ${max}`)
    next[key] = p[key]
  }
  if (p.downloadDirectory !== undefined) {
    if (typeof p.downloadDirectory !== 'string' || p.downloadDirectory.includes('\0') || p.downloadDirectory.length > 4096) throw bad('downloadDirectory must be a path string')
    next.downloadDirectory = p.downloadDirectory
  }
  if (p.autoArchiveHours !== undefined) {
    if (!Number.isFinite(p.autoArchiveHours)) throw bad('autoArchiveHours must be a number')
    next.autoArchiveHours = p.autoArchiveHours
  }
  if (p.searchUrl !== undefined) {
    if (typeof p.searchUrl !== 'string' || !p.searchUrl.includes('%s')) throw bad('searchUrl must contain %s')
    webUrl(p.searchUrl)
    next.searchUrl = p.searchUrl
  }
  for (const key of ['shortcuts', 'globalShortcuts']) {
    if (p[key] === undefined) continue
    const ok = isObject(p[key]) && Object.values(p[key]).every((v) => isObject(v) && typeof v.method === 'string' && (v.params === undefined || isObject(v.params)))
    if (!ok) throw bad(`${key} must map an accelerator to {method, params?}`)
    next[key] = p[key]
  }
  if (p.ai !== undefined) next.ai = aiSettings(p.ai, s.settings.ai)
  if (p.browserIdentity !== undefined) {
    if (!isObject(p.browserIdentity) || !Object.entries(p.browserIdentity).every(validBrowserIdentity)) throw bad('browserIdentity must map persistent partition IDs (persist: followed by letters, digits, dots, underscores or hyphens) to native or compatible')
    next.browserIdentity = { ...s.settings.browserIdentity, ...p.browserIdentity }
  }
  return Object.assign(s.settings, next)
}

module.exports = {
  INCOGNITO_PARTITION, err, isObject, load, resolveInput, webUrl, findTab, activeTab, getTab, visibleTabs, isIncognito, persistable, deskTabs, shownTabs, onDesktop, desktopNumber, setDesktops,
  createSpace, updateSpace, moveSpace, removeSpace, activateSpace, cycleSpace, openIncognito,
  createFolder, updateFolder, moveFolder, removeFolder, setTrailCollapsed, refreshFolderLabels,
  createProfile, updateProfile, removeProfile, assignProfile, setLinkRule, removeLinkRule, routeLink,
  setSplit, resizeSplit, clearSplit, createPeek, promotePeek, dismissPeek,
  createTab, closeTab, activateTab, navigateTab, moveTab, setFavorite, setPinned, setBucket, bucketOf, look, settle, chatState, setCollapsed, cycleTab, selectTab,
  placeDesk, tileDesk, deskLayouts, arrange, hideDesk, showDesk, defaultDesk, thumbnailTabs, restore, removeArchived, clearArchive, sweep, setSettings, importSetup
}

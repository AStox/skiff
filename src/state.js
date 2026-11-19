'use strict'
const crypto = require('node:crypto')

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
// ponytail: quadratic in a space's plain tabs and no collapsing of trails; index children by parent or add a collapsed flag per tab when asked
const visibleTabs = (s, spaceId = s.activeSpaceId) => {
  const tabs = s.tabs.filter((t) => t.spaceId === spaceId)
  const trail = (parentId) => tabs.filter((t) => isPlain(t) && t.parentId === parentId).flatMap((t) => [t, ...trail(t.id)])
  return [...tabs.filter((t) => t.favorite), ...tabs.filter((t) => t.pinned && !t.favorite), ...trail(undefined)]
}
const isIncognito = (s, spaceId) => !!findSpace(s, spaceId)?.incognito
const deskTabs = (s, spaceId = s.activeSpaceId) => s.tabs.filter((t) => t.spaceId === spaceId && t.desk).sort((a, b) => a.desk.z - b.desk.z)
const isShown = (s, tab) => s.activeTabBySpace[tab.spaceId] === tab.id || (tab.desk ? !tab.desk.hidden : isPlain(tab))
// Back to front: unplaced ordinary tabs in tab order, then placed ones by z, the active tab last.
function shownTabs(s, spaceId = s.activeSpaceId) {
  const tabs = visibleTabs(s, spaceId).filter((t) => isShown(s, t))
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
    spaces: (Array.isArray(raw.spaces) ? raw.spaces : []).filter((x) => !x.incognito),
    activeSpaceId: raw.activeSpaceId,
    tabs: Array.isArray(raw.tabs) ? raw.tabs : [],
    activeTabBySpace: { ...raw.activeTabBySpace },
    archive: Array.isArray(raw.archive) ? raw.archive : [],
    collapsed: { ...raw.collapsed },
    settings: { autoArchiveHours: 12, searchUrl: GOOGLE, shell: 'default', ...raw.settings, browserIdentity: loadBrowserIdentity(raw.settings?.browserIdentity), ai: loadAi(raw.settings?.ai), shortcuts: { ...SHORTCUTS, ...raw.settings?.shortcuts } },
    window: { width: 1280, height: 800, ...raw.window },
    deskHosts: Object.fromEntries(Object.entries(isObject(raw.deskHosts) ? raw.deskHosts : {}).map(([host, rect]) => [host, deskRect(rect)]).filter(([, rect]) => rect).slice(-HOSTS))
  }
  // Before settings version 1 a saved DuckDuckGo URL is the old untouched default, not a choice
  if (!(s.settings.version >= 1) && s.settings.searchUrl === 'https://duckduckgo.com/?q=%s') s.settings.searchUrl = GOOGLE
  s.settings.version = 1
  const j = s.settings.shortcuts['CmdOrCtrl+J']
  if (j?.method === 'ui.emit' && j.params?.name === 'toggle-ai') s.settings.shortcuts['CmdOrCtrl+J'] = SHORTCUTS['CmdOrCtrl+J']
  if (!s.spaces.length) s.spaces.push({ id: newId('s'), name: 'Home', color: COLORS[0] })
  for (const space of s.spaces) {
    if (space.background !== undefined) space.background = background(space.background) || null
  }
  if (!findSpace(s, s.activeSpaceId)) s.activeSpaceId = s.spaces[0].id
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
    if (!findSpace(s, spaceId) || !visibleTabs(s, spaceId).some((t) => t.id === tabId)) delete s.activeTabBySpace[spaceId]
  }
  return s
}

function release(s, tab) {
  if (s.activeTabBySpace[tab.spaceId] !== tab.id) return
  const list = visibleTabs(s, tab.spaceId).filter((t) => !t.pinned || t === tab)
  const next = list[list.indexOf(tab) + 1] || list[list.indexOf(tab) - 1]
  if (next) s.activeTabBySpace[tab.spaceId] = next.id
  else delete s.activeTabBySpace[tab.spaceId]
}

function detach(s, tab) {
  for (const child of s.tabs.filter((t) => t.parentId === tab.id)) {
    if (tab.parentId) child.parentId = tab.parentId
    else delete child.parentId
  }
  delete tab.parentId
}

function dropTab(s, tab) {
  release(s, tab)
  detach(s, tab)
  s.tabs.splice(s.tabs.indexOf(tab), 1)
}

function archiveTab(s, tab, now) {
  dropTab(s, tab)
  s.archive.unshift({ id: tab.id, spaceId: tab.spaceId, url: tab.url, title: tab.title, favicon: tab.favicon, sessionPartition: tab.sessionPartition, ...(tab.browserIdentity !== undefined && { browserIdentity: tab.browserIdentity }), arcSourceId: tab.arcSourceId, arcSourceKind: tab.arcSourceKind, chat: tab.chat, archivedAt: now })
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

// ponytail: flat folders, an empty folder disappears; real folder records if nesting or empty folders matter
function folder(value = '') {
  if (typeof value !== 'string') throw bad('folder must be a string')
  return value.trim().slice(0, 80)
}

function delta(value) {
  if (!Number.isInteger(value)) throw bad('delta must be an integer')
  return value
}

function createSpace(s, p) {
  const space = { id: newId('s'), name: name(p.name), color: p.color === undefined ? COLORS[s.spaces.length % COLORS.length] : color(p.color) }
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
  for (const tab of s.tabs.filter((t) => t.spaceId === space.id)) (space.incognito ? dropTab : archiveTab)(s, tab, now)
  s.agentTabs = s.agentTabs.filter((t) => t.spaceId !== space.id)
  if (!findTab(s, s.peek)) s.peek = null
  s.spaces.splice(i, 1)
  delete s.activeTabBySpace[space.id]
  for (const key of Object.keys(s.collapsed)) if (key.startsWith(`${space.id}/`)) delete s.collapsed[key]
  if (s.activeSpaceId === space.id) s.activeSpaceId = s.spaces[Math.max(0, i - 1)].id
  return null
}

function activateSpace(s, p) {
  s.activeSpaceId = getSpace(s, p.id).id
  s.peek = null
  return null
}

function cycleSpace(s, p) {
  const n = s.spaces.length
  const i = s.spaces.findIndex((x) => x.id === s.activeSpaceId)
  s.activeSpaceId = s.spaces[(((i + delta(p.delta)) % n) + n) % n].id
  s.peek = null
  return null
}

function openIncognito(s) {
  let space = s.spaces.find((x) => x.incognito)
  if (!space) s.spaces.push(space = { id: newId('s'), name: 'Incognito', color: '#5f6b7a', incognito: true, sessionPartition: newId('incognito-') })
  s.activeSpaceId = space.id
  s.peek = null
  return space
}

function persistable(s) {
  const gone = new Set(s.spaces.filter((x) => x.incognito).map((x) => x.id))
  const keep = (map) => Object.fromEntries(Object.entries(map).filter(([key]) => !gone.has(key.split('/')[0])))
  const { deskSize, deskTop, agentTabs, peek, ...rest } = s
  return { ...rest, spaces: s.spaces.filter((x) => !x.incognito), tabs: s.tabs.filter((t) => !gone.has(t.spaceId)), activeSpaceId: normalSpace(s).id, activeTabBySpace: keep(s.activeTabBySpace), collapsed: keep(s.collapsed) }
}

// In a desk window (s.deskSize set) a favorite or pinned tab becomes a window when activated and stays one until hidden.
// An agent tab is peeked instead: shown over the current space without becoming its active tab.
function activateTab(s, p, now) {
  const tab = getTab(s, p.id)
  s.peek = tab.agent ? tab.id : null
  if (tab.agent) return tab
  if (!tab.desk && !isPlain(tab) && s.deskSize) tab.desk = { ...defaultDesk(s, tab), z: 0 }
  if (tab.desk) {
    delete tab.desk.hidden
    front(s, tab)
  }
  s.activeSpaceId = tab.spaceId
  const previous = activeTab(s)
  if (previous) previous.lastActiveAt = now
  s.activeTabBySpace[s.activeSpaceId] = tab.id
  tab.lastActiveAt = now
  return tab
}

// chat {id, agent, title, favicon} makes a conversation tab; only the agent core passes it.
// agent makes a tab of that agent: kept apart from the tab list, never saved or archived, and never activated on creation.
function createTab(s, p, now, chat) {
  const url = chat ? `skiff://chat/${chat.id}` : navUrl(s, p.url)
  if (p.agent !== undefined) return createAgentTab(s, p, url, now)
  const spaceId = p.spaceId === undefined ? s.activeSpaceId : getSpace(s, p.spaceId).id
  const parent = s.tabs.find((t) => t.id === p.parentId)
  const tab = { id: newId('t'), spaceId, sessionPartition: getSpace(s, spaceId).sessionPartition || 'persist:main', url, title: chat ? chat.title : url, favicon: chat ? chat.favicon : '', favorite: false, lastActiveAt: now, createdAt: now, ...(whatsappURL(url) && { browserIdentity: 'compatible' }), ...(chat && { chat: { agent: chat.agent, sessionId: null } }) }
  if (parent && parent.spaceId === spaceId && isPlain(parent)) tab.parentId = parent.id
  s.tabs.push(tab)
  if (s.deskSize) {
    tab.desk = { ...newDesk(s, tab), z: 0 }
    front(s, tab)
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
  if (tab.agent) throw bad('Agent tabs cannot be moved, pinned or made favorites')
  return tab
}

function closeTab(s, p, now) {
  const tab = getTab(s, p.id)
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
  if (tab.desk) tab.desk.hidden = true
  if (s.activeTabBySpace[tab.spaceId] === tab.id) {
    const next = s.tabs.filter((t) => !t.favorite && !t.pinned && t.spaceId === tab.spaceId).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
    if (next) s.activeTabBySpace[tab.spaceId] = next.id
    else delete s.activeTabBySpace[tab.spaceId]
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

function moveTab(s, p, now) {
  const tab = userTab(s, p.id)
  if (p.index !== undefined && !(Number.isInteger(p.index) && p.index >= 0)) throw bad('index must be a non-negative integer')
  if (p.spaceId !== undefined && getSpace(s, p.spaceId).id !== tab.spaceId) {
    if (isIncognito(s, p.spaceId) !== isIncognito(s, tab.spaceId)) throw bad('Tabs cannot move into or out of the incognito space')
    release(s, tab)
    detach(s, tab)
    tab.spaceId = p.spaceId
  }
  s.tabs.splice(s.tabs.indexOf(tab), 1)
  const peers = s.tabs.filter((t) => t.spaceId === tab.spaceId && t.favorite === tab.favorite && !t.pinned === !tab.pinned && (t.folder || '') === (tab.folder || '') && t.parentId === tab.parentId)
  const before = p.index === undefined ? undefined : peers[p.index]
  const at = before ? s.tabs.indexOf(before) : peers.length ? s.tabs.indexOf(peers.at(-1)) + 1 : s.tabs.length
  s.tabs.splice(at, 0, tab)
  tab.lastActiveAt = now
  return tab
}

function setFavorite(s, p, now) {
  const tab = userTab(s, p.id)
  if (typeof p.favorite !== 'boolean') throw bad('favorite must be true or false')
  if (p.favorite) detach(s, tab)
  return Object.assign(tab, { favorite: p.favorite, lastActiveAt: now }, p.favorite && { pinned: false, folder: '' })
}

function setPinned(s, p, now) {
  const tab = userTab(s, p.id)
  if (typeof p.pinned !== 'boolean') throw bad('pinned must be true or false')
  const group = folder(p.folder)
  if (p.pinned) detach(s, tab)
  if (p.pinned && tab.favorite) setFavorite(s, { id: tab.id, favorite: false }, now)
  return Object.assign(tab, { pinned: p.pinned, folder: p.pinned ? group : '', lastActiveAt: now })
}

function setCollapsed(s, p) {
  const spaceId = p.spaceId === undefined ? s.activeSpaceId : getSpace(s, p.spaceId).id
  const group = folder(p.folder)
  if (!group) throw bad('folder must be a non-empty string')
  if (typeof p.collapsed !== 'boolean') throw bad('collapsed must be true or false')
  const key = `${spaceId}/${group}`
  if (p.collapsed) s.collapsed[key] = true
  else delete s.collapsed[key]
  return null
}

// ponytail: pinned tabs are skipped because the state does not know which are loaded
const cycleList = (s) => visibleTabs(s).filter((t) => !t.pinned)

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

function placeDesk(s, p) {
  const tab = getTab(s, p.id)
  const rect = deskRect(p)
  if (!rect) throw bad('x, y, width and height must be numbers, width at least 240 and height at least 160')
  tab.desk = { ...rect, z: 0 }
  front(s, tab)
  const host = hostOf(tab.url)
  if (host && !tab.agent && !isIncognito(s, tab.spaceId)) {
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
function newDesk(s, tab) {
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

function restore(s, p, now) {
  const i = p.id === undefined ? 0 : s.archive.findIndex((a) => a.id === p.id)
  const entry = s.archive[i]
  if (!entry) throw err('not_found', p.id === undefined ? 'The archive is empty' : `No archived tab ${p.id}`)
  s.archive.splice(i, 1)
  const spaceId = findSpace(s, entry.spaceId) ? entry.spaceId : normalSpace(s).id
  const tab = { id: entry.id, spaceId, sessionPartition: entry.sessionPartition || 'persist:main', ...((entry.browserIdentity === null || validTabIdentity(entry.browserIdentity)) && { browserIdentity: entry.browserIdentity }), arcSourceId: entry.arcSourceId, arcSourceKind: entry.arcSourceKind, url: entry.url, title: entry.title, favicon: entry.favicon, favorite: false, lastActiveAt: now, createdAt: now, ...(entry.chat && { chat: entry.chat }) }
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

function sweep(s, _p, now) {
  const limit = s.settings.autoArchiveHours * HOUR
  const old = limit > 0 ? s.tabs.filter((t) => !t.favorite && !t.pinned && !isIncognito(s, t.spaceId) && s.activeTabBySpace[t.spaceId] !== t.id && now - t.lastActiveAt > limit) : []
  for (const tab of old) archiveTab(s, tab, now)
  return { archived: old.map((t) => t.id) }
}

function importSetup(s, setup, now) {
  const added = { spaces: 0, favorites: 0, pinned: 0, tabs: 0 }
  const partition = setup.sessionPartition || 'persist:main'
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
    s.tabs.push({ id: newId('t'), url, title: item.title, favicon: '', sessionPartition: partition, ...(whatsappURL(url) && { browserIdentity: 'compatible' }), ...(item.sourceId && { arcSourceId: item.sourceId, arcSourceKind: kind }), favorite: false, lastActiveAt: now, createdAt: now, ...fields })
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
    const known = new Set(s.tabs.filter(here).map((t) => t.folder))
    for (const item of from.pinned) {
      const group = folder(item.folder)
      const fresh = add('pinned', item, { spaceId: space.id, pinned: true, folder: group }, (t) => here(t) && t.pinned && (t.folder || '') === group)
      if (fresh && group && !known.has(group)) s.collapsed[`${space.id}/${group}`] = true
    }
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
  if (p.autoArchiveHours !== undefined) {
    if (!Number.isFinite(p.autoArchiveHours)) throw bad('autoArchiveHours must be a number')
    next.autoArchiveHours = p.autoArchiveHours
  }
  if (p.searchUrl !== undefined) {
    if (typeof p.searchUrl !== 'string' || !p.searchUrl.includes('%s')) throw bad('searchUrl must contain %s')
    webUrl(p.searchUrl)
    next.searchUrl = p.searchUrl
  }
  if (p.shortcuts !== undefined) {
    const ok = isObject(p.shortcuts) && Object.values(p.shortcuts).every((v) => isObject(v) && typeof v.method === 'string' && (v.params === undefined || isObject(v.params)))
    if (!ok) throw bad('shortcuts must map an accelerator to {method, params?}')
    next.shortcuts = p.shortcuts
  }
  if (p.ai !== undefined) next.ai = aiSettings(p.ai, s.settings.ai)
  if (p.browserIdentity !== undefined) {
    if (!isObject(p.browserIdentity) || !Object.entries(p.browserIdentity).every(validBrowserIdentity)) throw bad('browserIdentity must map persistent partition IDs (persist: followed by letters, digits, dots, underscores or hyphens) to native or compatible')
    next.browserIdentity = { ...s.settings.browserIdentity, ...p.browserIdentity }
  }
  return Object.assign(s.settings, next)
}

module.exports = {
  err, isObject, load, resolveInput, webUrl, findTab, activeTab, getTab, visibleTabs, isIncognito, persistable, deskTabs, shownTabs,
  createSpace, updateSpace, moveSpace, removeSpace, activateSpace, cycleSpace, openIncognito,
  createTab, closeTab, activateTab, navigateTab, moveTab, setFavorite, setPinned, setCollapsed, cycleTab, selectTab,
  placeDesk, tileDesk, deskLayouts, hideDesk, showDesk, defaultDesk, thumbnailTabs, restore, removeArchived, clearArchive, sweep, setSettings, importSetup
}

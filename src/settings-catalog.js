'use strict'

// Only actual user-editable scalars and host actions belong here. Profiles, shortcuts and agent
// definitions have their own structured commands, not flattened pseudo-settings.
// quickPanel marks an entry for the interface's quick Settings panel; a string setting with enum is a choice.
// An action has no value: its host handler (see present/run) supplies status text and availability.
const catalog = [
  { id: 'autoArchiveHours', type: 'number', default: 12, scope: 'global', title: 'Auto-archive after', description: 'Move ordinary tabs that have not been shown for this many hours to Done; a Done tab is archived a day later. Favorites, pinned tabs and tabs in progress never move. Zero or less stops tabs moving to Done.', aliases: ['archive', 'cleanup', 'hours'], section: 'tabs', quickPanel: true },
  { id: 'searchUrl', type: 'string', default: 'https://www.google.com/search?q=%s', scope: 'global', title: 'Search engine URL', description: 'HTTP or HTTPS search address containing %s for the search terms.', aliases: ['search', 'engine', 'provider'], section: 'general', pattern: '^https?://.*%s' },
  { id: 'historyRetentionDays', type: 'integer', default: 90, scope: 'global', title: 'History retention', description: 'Days to keep browsing history. Zero disables history recording.', aliases: ['history', 'privacy', 'days'], section: 'history', minimum: 0, maximum: 3650 },
  { id: 'downloadAskWhere', type: 'boolean', default: true, scope: 'global', title: 'Ask where to save downloads', description: 'Choose a destination before saving each download.', aliases: ['download', 'save', 'prompt'], section: 'downloads' },
  { id: 'downloadDirectory', type: 'string', default: '', scope: 'global', title: 'Download directory', description: 'Default download folder on this device. Empty uses the system Downloads folder.', aliases: ['download', 'folder', 'destination'], section: 'downloads', maxLength: 4096, pattern: '^[^\u0000]*$' },
  { id: 'memorySaver', type: 'boolean', default: false, scope: 'global', title: 'Memory saver', description: 'Unload inactive eligible pages. They reload at their last URL without restoring prior page state, back/forward history or scroll position. Visible pages and pages with protected activity stay loaded.', aliases: ['memory', 'sleep', 'discard', 'performance'], section: 'tabs' },
  { id: 'memorySaverMinutes', type: 'integer', default: 30, scope: 'global', title: 'Memory saver delay', description: 'Minutes before an inactive eligible page may be unloaded.', aliases: ['memory', 'sleep', 'minutes'], section: 'tabs', minimum: 1, maximum: 10080 },
  { id: 'transcriptRecovery', type: 'boolean', default: false, scope: 'global', title: 'Save conversation recovery transcripts', description: 'Opt in to local recovery transcripts for normal conversations. Private conversations are never saved.', aliases: ['chat', 'agent', 'transcript', 'recovery', 'privacy'], section: 'transcripts' },
  { id: 'transcriptRetentionDays', type: 'integer', default: 30, scope: 'global', title: 'Transcript retention', description: 'Days to retain opted-in conversation recovery transcripts.', aliases: ['chat', 'agent', 'transcript', 'days'], section: 'transcripts', minimum: 1, maximum: 3650 },
  { id: 'defaultBrowser', type: 'action', scope: 'global', title: 'Default browser', description: 'Open web links from other apps in Skiff.', actionLabel: 'Make Skiff your default browser', aliases: ['default', 'browser', 'links', 'handler'], section: 'general', quickPanel: true },
  { id: 'update', type: 'action', scope: 'global', title: 'Update', description: 'Skiff downloads updates in the background. Restart to finish installing one.', actionLabel: 'Restart to update', aliases: ['update', 'upgrade', 'restart', 'version'], section: 'general', quickPanel: true }
]
for (const entry of catalog) {
  entry.owner = 'core'
  Object.freeze(entry.aliases)
  Object.freeze(entry)
}
Object.freeze(catalog)
const byId = new Map(catalog.map((entry) => [entry.id, entry]))
const copy = (entry) => entry && structuredClone(entry)
const bad = (message) => Object.assign(new Error(message), { code: 'bad_params' })

function get(id) { return copy(byId.get(id)) }
function list(filters = {}) {
  return searchEntries(catalog, '', filters)
}
function searchEntries(entries, query = '', { scope, section, owner, quickPanel } = {}) {
  if (typeof query !== 'string') throw bad('query must be a string')
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return entries.filter((entry) => {
    if (scope !== undefined && entry.scope !== scope || section !== undefined && entry.section !== section || owner !== undefined && entry.owner !== owner || quickPanel !== undefined && Boolean(entry.quickPanel) !== quickPanel) return false
    const text = [entry.id, entry.title, entry.description, entry.section, entry.owner, entry.scope, ...(entry.aliases || [])].join(' ').toLowerCase()
    return terms.every((term) => text.includes(term))
  }).map(copy)
}
function search(query = '', filters = {}) {
  return searchEntries(catalog, query, filters)
}
const scalarType = (type, value) => type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : ['string', 'boolean'].includes(type) && typeof value === type
function schemaForEntry(entry) {
  if (!entry || !['string', 'boolean', 'number', 'integer'].includes(entry.type)) throw bad('Setting type must be string, boolean, number or integer')
  if (!['global', 'space'].includes(entry.scope)) throw bad('Setting scope must be global or space')
  for (const key of ['minimum', 'maximum']) {
    if (entry[key] !== undefined && (!['number', 'integer'].includes(entry.type) || !Number.isFinite(entry[key]))) throw bad(`${entry.id}.${key} must be a finite numeric constraint`)
  }
  if (entry.minimum !== undefined && entry.maximum !== undefined && entry.minimum > entry.maximum) throw bad(`${entry.id} has an invalid numeric range`)
  if (entry.maxLength !== undefined && (entry.type !== 'string' || !Number.isInteger(entry.maxLength) || entry.maxLength < 0)) throw bad(`${entry.id}.maxLength must be a non-negative string length`)
  if (entry.pattern !== undefined) {
    if (entry.type !== 'string' || typeof entry.pattern !== 'string') throw bad(`${entry.id}.pattern must be a string constraint`)
    try { new RegExp(entry.pattern, 'u') } catch { throw bad(`${entry.id}.pattern is invalid`) }
  }
  if (entry.enum !== undefined && (!Array.isArray(entry.enum) || !entry.enum.length || !entry.enum.every((value) => scalarType(entry.type, value)) || new Set(entry.enum).size !== entry.enum.length)) throw bad(`${entry.id}.enum must contain unique values of its declared type`)
  return copy(Object.fromEntries(['type', 'default', 'description', 'minimum', 'maximum', 'maxLength', 'pattern', 'enum'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])))
}
function schemaForSetting(id) {
  const entry = byId.get(id)
  if (!entry) throw bad(`Unknown setting: ${id}`)
  return schemaForEntry(entry)
}
function validate(id, value, { scope = 'global' } = {}) {
  const entry = byId.get(id)
  if (!entry) throw bad(`Unknown setting: ${id}`)
  if (entry.type === 'action') throw bad(`${id} is an action, not a setting`)
  return validateEntry(entry, value, { scope })
}
function validateEntry(entry, value, { scope = 'global' } = {}) {
  schemaForEntry(entry)
  const id = entry.id
  if (scope !== 'global' && !(scope === 'space' && entry.scope === 'space')) throw bad(`${id} is a ${entry.scope} setting, not ${scope}`)
  if (!scalarType(entry.type, value)) throw bad(`${id} must be ${entry.type}`)
  if (entry.minimum !== undefined && value < entry.minimum || entry.maximum !== undefined && value > entry.maximum) throw bad(`${id} is outside its allowed range`)
  if (entry.maxLength !== undefined && [...value].length > entry.maxLength || entry.pattern !== undefined && !new RegExp(entry.pattern, 'u').test(value)) throw bad(`${id} has an invalid value`)
  if (entry.enum !== undefined && !entry.enum.includes(value)) throw bad(`${id} must be one of its allowed values`)
  if (entry.owner === 'core' && id === 'searchUrl') {
    let url
    try { url = new URL(value) } catch { throw bad('searchUrl must be an HTTP or HTTPS URL containing %s') }
    if (!['http:', 'https:'].includes(url.protocol) || !value.includes('%s')) throw bad('searchUrl must be an HTTP or HTTPS URL containing %s')
  }
  return value
}

// Core entries as an interface draws them: settings gain their current value, actions the handler's
// status text and availability. An action whose handler is missing or unsupported here is omitted.
// A handler is { supported?(), status() -> {text, available}, run() }.
function present(entries, { values = {}, actions = {} } = {}) {
  return entries.flatMap((entry) => {
    if (entry.owner !== 'core') return [entry]
    if (entry.type !== 'action') return [{ ...entry, value: Object.hasOwn(values, entry.id) ? values[entry.id] : entry.default }]
    const action = actions[entry.id]
    if (!action || action.supported?.() === false) return []
    const { text = '', available = true } = action.status()
    return [{ ...entry, status: text, available }]
  })
}
async function run(id, actions = {}) {
  const entry = byId.get(id)
  if (entry?.type !== 'action') throw bad(`Unknown action: ${id}`)
  const action = actions[id]
  if (!action || action.supported?.() === false) throw bad(`${entry.title} is not available in this build or on this platform`)
  if (action.status().available === false) throw bad(`${entry.title} has nothing to do right now`)
  await action.run()
  return present([copy(entry)], { actions })[0]
}

module.exports = { catalog, get, list, search, validate, schemaForSetting, searchEntries, schemaForEntry, validateEntry, present, run }

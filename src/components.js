'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { fork } = require('node:child_process')
const { fileURLToPath } = require('node:url')
const { AsyncLocalStorage } = require('node:async_hooks')
const settingsCatalog = require('./settings-catalog')
const log = require('./log').scope('components')
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const NAME = /^[a-zA-Z][a-zA-Z0-9_.-]*$/
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const clone = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value))
const fail = (message, code = 'component_error') => Object.assign(new Error(message), { code })
const inside = (root, file) => file === root || file.startsWith(root + path.sep)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file) }
  finally { fs.rmSync(temp, { force: true }) }
}
// Resolve host-selected ancestor aliases (notably macOS /var and /tmp) before
// establishing a package/store boundary. The selected root itself may not be a
// symlink; relative() still rejects every symlink below the canonical boundary.
function hostRoot(directory) {
  directory = path.resolve(directory)
  if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) throw fail('Symlink component roots are not supported')
  let parent = path.dirname(directory)
  let suffix = path.basename(directory)
  while (!fs.lstatSync(parent, { throwIfNoEntry: false })) {
    suffix = path.join(path.basename(parent), suffix)
    parent = path.dirname(parent)
  }
  return path.join(fs.realpathSync(parent), suffix)
}
function relative(root, name, exists = true) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..')) throw fail('Expected a safe relative path', 'bad_params')
  const file = path.resolve(root, name)
  if (!inside(path.resolve(root), file)) throw fail('Path escapes component')
  let cursor = path.resolve(root)
  for (let ancestor = cursor; ; ancestor = path.dirname(ancestor)) {
    if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw fail('Symlink component paths are not supported')
    if (path.dirname(ancestor) === ancestor) break
  }
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part)
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw fail('Symlinks are not supported in components')
  }
  if (exists && !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw fail(`Missing component file: ${name}`)
  return file
}
function files(root) {
  const result = []
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw fail(`Unsupported component file: ${name}`)
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name + '/')
      else result.push(name)
    }
  }
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw fail('Component root must be a real directory')
  visit(root, '')
  return result
}
function revision(root) {
  const hash = crypto.createHash('sha256')
  for (const file of files(root)) { hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(relative(root, file))); hash.update('\0') }
  return hash.digest('hex')
}
// Identity of a copy's own source: every file but manifest.json, plus the manifest without its origin record.
function sourceHash(directory, manifest) {
  const rest = { ...manifest }
  delete rest.origin
  const hash = crypto.createHash('sha256')
  for (const file of files(directory)) {
    if (file === 'manifest.json') continue
    hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(relative(directory, file))); hash.update('\0')
  }
  return hash.update(JSON.stringify(rest)).digest('hex')
}
const manifestOf = (directory) => JSON.parse(fs.readFileSync(relative(directory, 'manifest.json'), 'utf8'))
function settingEntries(manifest) {
  if (manifest.settings === undefined) return []
  if (!manifest.settings || typeof manifest.settings !== 'object' || Array.isArray(manifest.settings)) throw fail('Component settings must be a map')
  return Object.entries(manifest.settings).map(([key, definition]) => {
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(key) || !definition || typeof definition !== 'object' || Array.isArray(definition) || !own(definition, 'default') || ['id', 'owner', 'key'].some((field) => own(definition, field))) throw fail('Invalid or colliding component setting declaration')
    const entry = { scope: 'global', title: key, description: '', aliases: [], section: 'components', ...definition, id: `${manifest.id}.${key}`, owner: manifest.id, key }
    if (typeof entry.title !== 'string' || typeof entry.description !== 'string' || typeof entry.section !== 'string' || !Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== 'string')) throw fail('Invalid component setting metadata')
    settingsCatalog.validateEntry(entry, entry.default)
    return entry
  })
}
function validatePropertyShape(properties) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
  if (!object(properties) || !object(properties.global) || !object(properties.spaces)) throw fail('Invalid component property snapshot')
  if (Object.keys(properties.spaces).some((spaceId) => !/^[\w-]+$/.test(spaceId) || ['__proto__', 'constructor', 'prototype'].includes(spaceId))) throw fail('Invalid component property space')
  for (const values of [properties.global, ...Object.values(properties.spaces)]) {
    if (!object(values) || Object.entries(values).some(([key, value]) => !/^[a-z][a-zA-Z0-9_-]*$/.test(key) || !(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))))) throw fail('Invalid component property values')
  }
}
function validate(root, supplied) {
  const manifest = supplied || JSON.parse(fs.readFileSync(relative(root, 'manifest.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw fail('Invalid component manifest')
  if (manifest.apiVersion !== 1) throw fail(`Unsupported component API version: ${manifest.apiVersion}`, 'incompatible')
  if (typeof manifest.id !== 'string' || !ID.test(manifest.id) || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) throw fail('Manifest requires a valid id and semantic version')
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some((cap) => typeof cap !== 'string' || !/^(ui|backend|storage|source|host\.manage|commands\.register|call:[\w.*-]+|events:[\w.*-]+)$/.test(cap))) throw fail('Invalid capability declaration')
  if (!manifest.surfaces || typeof manifest.surfaces !== 'object' || Array.isArray(manifest.surfaces)) throw fail('surfaces must be an object')
  for (const [name, file] of Object.entries(manifest.surfaces)) { if (!NAME.test(name)) throw fail('Invalid surface name'); relative(root, file) }
  if (Object.keys(manifest.surfaces).length && !manifest.capabilities.includes('ui')) throw fail('Surfaces require ui capability')
  if (manifest.backend) {
    const entry = relative(root, manifest.backend)
    if (!/\.c?js$/.test(manifest.backend) || !manifest.capabilities.includes('backend')) throw fail('Backend requires a JavaScript entry and backend capability')
    // Compile only: validation must never execute local code in Electron main.
    new (require('node:vm').Script)(require('node:module').wrap(fs.readFileSync(entry, 'utf8')), { filename: entry })
  }
  if (manifest.roles !== undefined && (!Array.isArray(manifest.roles) || manifest.roles.some((role) => !NAME.test(role)))) throw fail('Invalid roles')
  if (manifest.commands !== undefined && (!manifest.commands || typeof manifest.commands !== 'object' || Array.isArray(manifest.commands))) throw fail('Invalid role commands')
  for (const [role, command] of Object.entries(manifest.commands || {})) if (!NAME.test(role) || typeof command !== 'string' || !command.startsWith(manifest.id + '.')) throw fail('Role commands must use the component namespace')
  if (manifest.dataVersion !== undefined && (!Number.isSafeInteger(manifest.dataVersion) || manifest.dataVersion < 1)) throw fail('Invalid data version')
  if (settingEntries(manifest).length && !manifest.capabilities.includes('storage')) throw fail('Component settings require storage capability')
  files(root)
  return clone(manifest)
}
function assertOperation(context) {
  if (context?.signal?.aborted || context?.authoritySignal?.aborted || context?.accessContext?.signal?.aborted) throw fail('Component operation cancelled', 'cancelled')
}
function afterTargetTeardown(context, id) {
  if (context.component !== id || !context.hostManagement) return context
  // Disposing the target intentionally cancels a self-managing UI/backend's
  // generation. Independent grant revocation or caller cancellation still wins.
  const signals = [context.authoritySignal, context.accessContext?.signal].filter(Boolean)
  if (context.accessContext && !signals.length) return context
  return { ...context, signal: signals.length ? AbortSignal.any(signals) : undefined }
}
function bounded(promise, ms, label, signal) {
  let timer, abort
  const tasks = [promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail(`${label} timed out`, 'timeout')), ms) })]
  if (signal) tasks.push(new Promise((_, reject) => {
    abort = () => reject(fail(`${label} cancelled`, 'cancelled'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }))
  return Promise.race(tasks).finally(() => { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) })
}

function createComponents({ dir, bundledRoot, legacyShellDir, registry, call, state = () => ({}), changed = () => {}, onReplace = async () => {}, onSettingsChanged = () => {}, preview, timeouts = {}, safeMode = false }) {
  const root = hostRoot(dir)
  const storeFile = path.join(root, 'composition.json')
  const stocks = new Map()
  const active = new Map()
  const subscriptions = new Map()
  const invocation = new AsyncLocalStorage()
  const startupMs = timeouts.start || 5000
  const callMs = timeouts.call || 10000
  const stopMs = timeouts.stop || 1500
  let store = { version: 1, components: {}, bindings: { global: {}, spaces: {} } }
  let started = false
  let queue = Promise.resolve()
  let generation = 0
  const serial = (work, context) => { const next = queue.then(() => { assertOperation(context); return work() }); queue = next.catch(() => {}); return next }
  const save = () => { atomic(storeFile, store); changed() }
  const record = (id) => { if (typeof id !== 'string' || !ID.test(id)) throw fail('Invalid component id', 'bad_params'); if (!own(store.components, id)) throw fail(`Unknown component: ${id}`, 'not_found'); return store.components[id] }
  const sourcePath = (id) => path.join(root, 'packages', id)
  const revisionPath = (id, rev) => { if (!/^[a-f0-9]{64}$/.test(rev)) throw fail('Invalid revision'); return path.join(root, 'revisions', id, rev) }
  const roles = (manifest) => [...new Set([...Object.keys(manifest.surfaces), ...(manifest.roles || []), ...Object.keys(manifest.commands || {})])]
  const notify = (id, action, extra = {}) => onReplace({ id, owner: id, action, roles: roles(active.get(id)?.manifest || manifestFor(id)), ...extra })
  function manifestFor(id) {
    const item = record(id)
    if (stocks.has(id)) return stocks.get(id).manifest
    const selected = item.active || item.staged
    return validate(selected ? revisionPath(id, selected) : sourcePath(id))
  }
  function packageFor(id, rev) {
    if (stocks.has(id)) return stocks.get(id)
    const directory = revisionPath(id, rev)
    return { root: directory, manifest: validate(directory) }
  }
  function snapshot(id, directory, supplied) {
    const manifest = validate(directory, supplied)
    if (manifest.id !== id) throw fail('Component id changed')
    // Include the generated manifest for bundled sources that have no manifest file.
    const temporary = path.join(root, 'staging', crypto.randomUUID())
    fs.mkdirSync(path.dirname(temporary), { recursive: true })
    fs.cpSync(directory, temporary, { recursive: true })
    try {
      atomic(path.join(temporary, 'manifest.json'), manifest)
      const rev = revision(temporary)
      const destination = revisionPath(id, rev)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      if (!fs.existsSync(destination)) fs.renameSync(temporary, destination)
      return rev
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  }
  function info(id) {
    const item = record(id)
    let manifest = null, error = item.error || null, listing = []
    const directory = stocks.get(id)?.root || sourcePath(id)
    try { manifest = manifestFor(id); listing = files(directory) } catch (e) { error = e.message }
    const runtime = active.get(id)
    return { id, owner: id, kind: stocks.has(id) ? 'stock' : 'user', path: directory, manifest, files: listing, revision: item.active || null, previous: item.previous || null, staged: item.staged || null, sourceBackup: item.sourceBackup || null, activeProperties: clone(item.activeProperties || propertiesFor(id) || { global: {}, spaces: {} }), previousProperties: clone(item.previousProperties), enabled: !!item.enabled, running: !!runtime?.live, stopping: !!runtime && !runtime.live, error, grants: item.grants || [], origin: item.origin || null, dataPath: path.join(root, 'data', id), compatibility: manifest?.apiVersion === 1 ? 'compatible' : 'incompatible', instance: id }
  }
  function assertLive(runtime) { if (!runtime.live || active.get(runtime.id) !== runtime) throw fail('Component generation is no longer active', 'cancelled') }
  function assertOrigin(origin) {
    if (!origin) return
    assertLive(origin.runtime)
    if (origin.live === false || (origin.request !== undefined && origin.runtime.pending.get(origin.request) !== origin.pending) || origin.context.signal?.aborted) throw fail('Originating component invocation is no longer active', 'cancelled')
  }
  function workerOrigin(runtime, origin) {
    if (origin?.kind === 'background') return null
    if (origin?.kind !== 'command' || !Number.isSafeInteger(origin.id)) throw fail('Component API request has no valid invocation origin', 'forbidden')
    const pending = runtime.pending.get(origin.id)
    if (!pending) throw fail('Originating component invocation has finished', 'cancelled')
    const captured = { runtime, request: origin.id, pending, context: pending.context }
    assertOrigin(captured)
    return captured
  }
  function granted(runtime, capability) { assertLive(runtime); if (!runtime.grants.includes(capability)) throw fail(`Capability not granted: ${capability}`, 'forbidden') }
  function authorize(owner, command) {
    const runtime = active.get(owner)
    if (!runtime) throw fail('Component is not active', 'forbidden')
    return authorizeRuntime(runtime, command)
  }
  function authorizeRuntime(runtime, command) {
    const owner = runtime.id
    assertLive(runtime)
    if (typeof command !== 'string' || (!runtime.grants.includes('call:' + command) && !runtime.grants.includes('call:*') && !command.startsWith(owner + '.'))) throw fail(`Command not granted: ${command}`, 'forbidden')
    // A broad call grant is not administrative authority. Local management is
    // available only after explicit host.manage approval, for stock and copies.
    const hostManagement = runtime.grants.includes('host.manage')
    if (!hostManagement && /^(?:grants\.|sync\.|import\.|passwords\.|ui\.customize$|components\.(?:apply|revert|enable|disable|remove|stage|bind|create|source\.|storage\.|settings\.))/.test(command)) throw fail('Component management requires host.manage authorization; use owned source/storage/settings API', 'forbidden')
    return { owner, component: owner, signal: runtime.controller.signal, hostManagement }
  }
  function dataFile(id, key, { version, spaceId, private: isPrivate } = {}) {
    const manifest = active.get(id)?.manifest || manifestFor(id)
    if (typeof key !== 'string' || !key) throw fail('Storage key must be a nonempty relative path')
    const current = typeof state === 'function' ? state() : state
    if (isPrivate || (spaceId && (current.spaces || []).some((space) => space.id === spaceId && (space.incognito || space.private)))) throw fail('Private component data cannot be persisted', 'forbidden')
    version = version ?? manifest.dataVersion ?? 1
    if (!Number.isSafeInteger(version) || version < 1) throw fail('Invalid data version')
    if (spaceId !== undefined && (typeof spaceId !== 'string' || !/^[\w-]+$/.test(spaceId))) throw fail('Invalid storage space')
    const directory = path.join(root, 'data', id, 'v' + version, spaceId ? 'spaces/' + spaceId : 'global')
    return relative(directory, key + '.json', false)
  }
  function dataRead({ id, key, ...options }) { const file = dataFile(id, key, options); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null }
  function dataWrite({ id, key, value, ...options }) { const file = dataFile(id, key, options); if (JSON.stringify(value)?.length > 1024 * 1024) throw fail('Storage value exceeds 1 MiB'); atomic(file, { value: clone(value) }); return clone(value) }
  function storageRead(args) { const result = dataRead(args); return result ? result.value : null }
  function dataRemove({ id, key, ...options }) { fs.rmSync(dataFile(id, key, options), { force: true }); return { removed: true } }
  function propertyScope(spaceId, persist = false) {
    if (spaceId === undefined) return
    if (typeof spaceId !== 'string' || !/^[\w-]+$/.test(spaceId) || ['__proto__', 'constructor', 'prototype'].includes(spaceId)) throw fail('Invalid setting space', 'bad_params')
    const current = typeof state === 'function' ? state() : state
    const space = (current.spaces || []).find((entry) => entry.id === spaceId)
    if (!space) throw fail('Unknown setting space', 'not_found')
    const privateScope = !!(space.incognito || space.private)
    if (privateScope && persist) throw fail('Private-space component properties cannot be persisted', 'forbidden')
    return privateScope
  }
  function propertiesFor(id) { return store.properties && own(store.properties, id) ? store.properties[id] : null }
  function settingsManifest(id) { record(id); return active.get(id)?.manifest || manifestFor(id) }
  function resolvedSetting(entry, spaceId) {
    const properties = propertiesFor(entry.owner)
    let value = entry.default, source = 'default'
    if (properties && own(properties.global, entry.key)) { value = properties.global[entry.key]; source = 'global' }
    const scoped = spaceId === undefined ? null : properties?.spaces[spaceId]
    if (entry.scope === 'space' && scoped && own(scoped, entry.key)) { value = scoped[entry.key]; source = 'space' }
    return { ...clone(entry), value, source, ...(spaceId === undefined ? {} : { spaceId }) }
  }
  function settingsList({ id, spaceId, query = '' } = {}) {
    const privateScope = propertyScope(spaceId)
    const entries = []
    for (const owner of id === undefined ? Object.keys(store.components) : [id]) {
      try {
        entries.push(...settingEntries(settingsManifest(owner)).map((entry) => {
          const resolved = resolvedSetting(entry, privateScope ? undefined : spaceId)
          return privateScope ? { ...resolved, spaceId, privateScope: true } : resolved
        }))
      }
      catch (error) { if (id !== undefined) throw error }
    }
    return settingsCatalog.searchEntries(entries, query)
  }
  function settingsGet({ id, key, spaceId } = {}) {
    const entries = settingsList({ id, spaceId })
    if (key === undefined) return entries
    const entry = entries.find((item) => item.key === key)
    if (!entry) throw fail(`Unknown component setting: ${id}.${key}`, 'not_found')
    return entry
  }
  function validateProperties(id, manifest, properties = propertiesFor(id)) {
    if (!properties) return
    validatePropertyShape(properties)
    const current = typeof state === 'function' ? state() : state
    for (const spaceId of Object.keys(properties.spaces)) if ((current.spaces || []).some((space) => space.id === spaceId && (space.incognito || space.private))) throw fail('Private-space component properties cannot be restored', 'forbidden')
    const entries = new Map(settingEntries(manifest).map((entry) => [entry.key, entry]))
    for (const [scope, values] of [['global', properties.global], ...Object.values(properties.spaces).map((values) => ['space', values])]) {
      for (const [key, value] of Object.entries(values)) {
        const entry = entries.get(key)
        if (!entry) throw fail(`Retained component setting ${id}.${key} is no longer declared; reset it before activation`, 'incompatible')
        try { settingsCatalog.validateEntry(entry, value, { scope }) }
        catch (error) { throw fail(`Retained component setting is incompatible: ${error.message}`, 'incompatible') }
      }
    }
  }
  function settingsChange({ id, key, value, spaceId }, reset) {
    propertyScope(spaceId, true)
    const entry = settingsGet({ id, key, spaceId })
    if (key === undefined) throw fail('A component setting key is required', 'bad_params')
    const scope = spaceId === undefined ? 'global' : 'space'
    settingsCatalog.validateEntry(entry, reset ? entry.default : value, { scope })
    store.properties ||= {}
    const properties = propertiesFor(id) || (store.properties[id] = { global: {}, spaces: {} })
    const values = spaceId === undefined ? properties.global : (properties.spaces[spaceId] ||= {})
    if (reset) delete values[key]
    else values[key] = value
    if (spaceId !== undefined && !Object.keys(values).length) delete properties.spaces[spaceId]
    record(id).activeProperties = clone(properties)
    save()
    const resolved = settingsGet({ id, key, spaceId })
    notifySetting(resolved)
    return resolved
  }
  const settingsSet = (params) => settingsChange(params, false)
  const settingsReset = (params) => settingsChange(params, true)
  function notifySetting(entry) {
    onSettingsChanged(clone(entry))
    for (const item of subscriptions.get('settings.changed') || []) if (item.runtime.id === entry.owner && item.runtime.live) {
      try { Promise.resolve(item.callback(clone(entry))).catch(() => {}) } catch {}
    }
  }
  function apiFor(runtime) {
    return Object.freeze({
      id: runtime.id, manifest: clone(runtime.manifest),
      capabilities: Object.freeze([...runtime.grants]),
      hasCapability(capability) { assertLive(runtime); return runtime.grants.includes(capability) },
      call(name, params = {}) {
        const origin = invocation.getStore()
        assertOrigin(origin)
        const context = authorizeRuntime(runtime, name)
        if (origin) {
          context.accessContext = origin.context.accessContext
          context.authoritySignal = origin.context.authoritySignal || origin.context.accessContext?.signal
          context.signal = origin.context.signal ? AbortSignal.any([context.signal, origin.context.signal]) : context.signal
        }
        return bounded(Promise.resolve().then(() => {
          assertLive(runtime)
          assertOrigin(origin)
          return (call || registry.call.bind(registry))(name, clone(params), context)
        }), callMs, 'Host call').then((value) => { assertLive(runtime); assertOrigin(origin); return clone(value) })
      },
      register(definition) {
        granted(runtime, 'commands.register')
        if (!definition?.name?.startsWith(runtime.id + '.') || definition.aliases?.some((name) => !name.startsWith(runtime.id + '.'))) throw fail('Commands and aliases must use the component namespace')
        if (runtime.commands.has(definition.name)) throw fail('Duplicate component command')
        if (typeof definition.run !== 'function') throw fail('Component command requires run')
        const remove = registry.register(runtime.id, { ...definition, run: (params, context) => {
          const lifetime = new AbortController()
          const scopedContext = { ...context, signal: context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal }
          const origin = { runtime, context: scopedContext, live: true }
          return invocation.run(origin, async () => {
            try { return await definition.run(params, scopedContext) }
            finally { origin.live = false; lifetime.abort(fail('Originating component invocation finished', 'cancelled')) }
          })
        } })
        const disposer = () => { remove(); runtime.commands.delete(definition.name) }
        runtime.commands.set(definition.name, disposer)
        return disposer
      },
      on(event, callback) {
        assertLive(runtime)
        if (typeof event !== 'string' || typeof callback !== 'function' || (!runtime.grants.includes('events:' + event) && !runtime.grants.includes('events:*') && !(event === 'settings.changed' && runtime.grants.includes('storage')))) throw fail('Event not granted', 'forbidden')
        const item = { runtime, callback }
        if (!subscriptions.has(event)) subscriptions.set(event, new Set())
        subscriptions.get(event).add(item)
        const dispose = () => { subscriptions.get(event)?.delete(item); runtime.listeners.delete(dispose) }
        runtime.listeners.add(dispose)
        return dispose
      },
      storage: Object.freeze({
        read(key, options = {}) { granted(runtime, 'storage'); return storageRead({ version: runtime.manifest.dataVersion || 1, ...options, id: runtime.id, key }) },
        write(key, value, options = {}) { granted(runtime, 'storage'); return dataWrite({ version: runtime.manifest.dataVersion || 1, ...options, id: runtime.id, key, value }) },
        remove(key, options = {}) { granted(runtime, 'storage'); return dataRemove({ version: runtime.manifest.dataVersion || 1, ...options, id: runtime.id, key }) },
      }),
      settings: Object.freeze({
        list(options = {}) { granted(runtime, 'storage'); return settingsList({ ...options, id: runtime.id }) },
        get(key, options = {}) { granted(runtime, 'storage'); return settingsGet({ ...options, id: runtime.id, key }) },
        set(key, value, options = {}) { granted(runtime, 'storage'); return settingsSet({ ...options, id: runtime.id, key, value }) },
        reset(key, options = {}) { granted(runtime, 'storage'); return settingsReset({ ...options, id: runtime.id, key }) },
      }),
      source: Object.freeze({
        read(file) { granted(runtime, 'source'); return sourceRead({ id: runtime.id, file }) },
        write(file, content) { granted(runtime, 'source'); return sourceWrite({ id: runtime.id, file, content }) },
      }),
    })
  }
  async function killGroup(child) {
    if (!child?.pid) return
    const kill = (signal) => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
    kill('SIGTERM')
    await delay(40)
    kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) await bounded(new Promise((resolve) => child.once('exit', resolve)), stopMs, 'Worker termination')
  }
  async function deactivate(id) {
    const runtime = active.get(id)
    if (!runtime) return
    if (runtime.stopping) return runtime.stopping
    runtime.live = false
    runtime.controller.abort()
    registry?.dispose(id)
    for (const off of runtime.listeners) off()
    for (const pending of runtime.pending.values()) pending.reject(fail('Component stopped', 'cancelled'))
    runtime.pending.clear()
    runtime.stopping = (async () => {
      let error
      try {
        if (runtime.child?.connected) {
          const stopped = new Promise((resolve, reject) => { runtime.stopped = resolve; runtime.stopFailed = reject })
          runtime.child.send({ type: 'stop' })
          await bounded(stopped, stopMs, 'Component shutdown')
        } else if (runtime.dispose) await bounded(Promise.resolve().then(runtime.dispose), stopMs, 'Component shutdown')
      } catch (e) { error = e }
      finally { await killGroup(runtime.child); if (active.get(id) === runtime) active.delete(id) }
      if (error && error.code !== 'timeout') throw error
    })()
    return runtime.stopping
  }
  async function activate(id, rev, grants, context = {}) {
    assertOperation(context)
    const source = packageFor(id, rev)
    validateProperties(id, source.manifest)
    const runtime = { id, manifest: source.manifest, root: source.root, revision: rev, grants, generation: ++generation, live: true, controller: new AbortController(), commands: new Map(), listeners: new Set(), pending: new Map(), sequence: 0 }
    active.set(id, runtime)
    const api = apiFor(runtime)
    try {
      if (source.manifest.backend) {
        granted(runtime, 'backend')
        const child = fork(path.join(__dirname, 'component-worker.js'), [], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [] })
        runtime.child = child
        log.info('component backend spawn', { id, pid: child.pid })
        const ready = new Promise((resolve, reject) => { runtime.ready = { resolve, reject } })
        const workerCall = (name, params, context) => {
          assertLive(runtime)
          const request = ++runtime.sequence
          const task = new Promise((resolve, reject) => runtime.pending.set(request, { resolve, reject, context }))
          const cancel = () => { if (child.connected) child.send({ type: 'cancel', id: request }); runtime.pending.get(request)?.reject(fail('Call cancelled', 'cancelled')) }
          context.signal?.addEventListener('abort', cancel, { once: true })
          if (context.signal?.aborted) cancel()
          else child.send({ type: 'call', id: request, name, params })
          return bounded(task, callMs, 'Component call').catch(async (error) => {
            if (error.code === 'timeout') { record(id).error = error.message; await deactivate(id); save() }
            throw error
          }).finally(() => { runtime.pending.delete(request); context.signal?.removeEventListener('abort', cancel) })
        }
        const workerSubscriptions = new Map()
        child.on('message', async (message) => {
          if (!message || typeof message !== 'object') return
          if (message.type === 'stopped') { if (message.error) runtime.stopFailed?.(fail(message.error.message)); else runtime.stopped?.(); return }
          if (!runtime.live || active.get(id) !== runtime) return
          if (message.type === 'ready') runtime.ready.resolve()
          else if (message.type === 'failed') runtime.ready.reject(fail(message.error?.message || 'Backend activation failed'))
          else if (message.type === 'event-error') { record(id).error = message.error?.message || 'Component event failed'; save() }
          else if (message.type === 'result') {
            const item = runtime.pending.get(message.id)
            if (message.error) item?.reject(fail(message.error.message, message.error.code)); else item?.resolve(message.result)
            runtime.pending.delete(message.id)
          } else if (message.type === 'request') {
            try {
              const origin = workerOrigin(runtime, message.origin)
              await invocation.run(origin, async () => {
                let result
                const params = message.params || {}
                if (message.method === 'call') result = await api.call(params.name, params.params)
                else if (message.method === 'register') { api.register({ ...params, run: (p, ctx) => workerCall(params.name, p, ctx) }); result = true }
                else if (message.method === 'unregister') { runtime.commands.get(params.name)?.(); result = true }
                else if (message.method === 'on') { workerSubscriptions.set(params.subscription, api.on(params.event, (payload) => { if (child.connected) child.send({ type: 'event', subscription: params.subscription, payload }) })); result = true }
                else if (message.method === 'off') { workerSubscriptions.get(params.subscription)?.(); workerSubscriptions.delete(params.subscription); result = true }
                else if (message.method === 'storage.read') result = api.storage.read(params.key, params)
                else if (message.method === 'storage.write') result = api.storage.write(params.key, params.value, params)
                else if (message.method === 'storage.remove') result = api.storage.remove(params.key, params)
                else if (message.method === 'source.read') result = api.source.read(params.file)
                else if (message.method === 'source.write') result = await api.source.write(params.file, params.content)
                else if (message.method === 'settings.list') result = api.settings.list(params)
                else if (message.method === 'settings.get') result = api.settings.get(params.key, params)
                else if (message.method === 'settings.set') result = api.settings.set(params.key, params.value, params)
                else if (message.method === 'settings.reset') result = api.settings.reset(params.key, params)
                else throw fail('Unknown component API method')
                assertLive(runtime)
                assertOrigin(origin)
                if (child.connected) child.send({ type: 'reply', id: message.id, result: clone(result) })
              })
            } catch (error) { if (runtime.live && child.connected) child.send({ type: 'reply', id: message.id, error: { message: error.message, code: error.code } }) }
          }
        })
        child.on('error', (error) => runtime.ready.reject(error))
        child.on('exit', (code, signal) => {
          log.info('component backend exit', { id, pid: child.pid, code, signal, unexpected: runtime.live })
          runtime.ready.reject(fail('Backend exited during activation'))
          if (runtime.live) { record(id).error = 'Backend exited unexpectedly'; deactivate(id).then(save).catch((error) => { record(id).error = error.message; save() }) }
        })
        child.send({ type: 'start', file: relative(source.root, source.manifest.backend), id, manifest: source.manifest, capabilities: runtime.grants })
        await bounded(ready, startupMs, 'Component activation', context.signal)
      } else if (source.activate) {
        const result = await bounded(Promise.resolve().then(() => { assertOperation(context); return source.activate(api) }), startupMs, 'Component activation', context.signal)
        runtime.dispose = typeof result === 'function' ? result : result?.dispose?.bind(result)
      }
      return runtime
    } catch (error) { log.error('component activation failed', { id, err: error.stack }); await deactivate(id); throw error }
  }
  function check({ id, path: directory } = {}) {
    try {
      directory = directory ? (inside(root, path.resolve(directory)) ? path.resolve(directory) : hostRoot(directory)) : stocks.get(id)?.root || sourcePath(id)
      const manifest = validate(directory, stocks.get(id)?.manifest)
      if (id && manifest.id !== id) throw fail('Component id changed')
      if (manifest.id === 'core' || (!stocks.has(manifest.id) && manifest.id.startsWith('stock.'))) throw fail('Reserved component namespace')
      if (own(store.components, manifest.id) && (id || directory === sourcePath(manifest.id))) validateProperties(manifest.id, manifest)
      return { ok: true, path: directory, manifest, revision: revision(directory) }
    } catch (error) { return { ok: false, path: directory || null, error: error.message, code: error.code || 'bad_manifest' } }
  }
  function stageInternal({ path: directory }) {
    directory = inside(root, path.resolve(directory)) ? path.resolve(directory) : hostRoot(directory)
    const checked = check({ path: directory })
    if (!checked.ok) throw fail(checked.error, checked.code)
    const id = checked.manifest.id
    if (stocks.has(id)) throw fail('Copy a stock component before editing it')
    validateProperties(id, checked.manifest)
    const rev = snapshot(id, directory)
    const workspace = sourcePath(id)
    let backup
    if (directory !== workspace) {
      fs.mkdirSync(path.dirname(workspace), { recursive: true })
      if (fs.existsSync(workspace)) {
        files(workspace)
        backup = path.join(root, 'source-backups', id, crypto.randomUUID())
        fs.mkdirSync(path.dirname(backup), { recursive: true })
        fs.renameSync(workspace, backup)
      }
      try { fs.cpSync(revisionPath(id, rev), workspace, { recursive: true, errorOnExist: true, force: false }) }
      catch (error) {
        fs.rmSync(workspace, { recursive: true, force: true })
        if (backup) fs.renameSync(backup, workspace)
        throw error
      }
    }
    const item = own(store.components, id) ? store.components[id] : (store.components[id] = { enabled: false, grants: [], origin: { type: 'local', imported: new Date().toISOString() } })
    item.staged = rev
    item.workspaceRevision = revision(workspace)
    if (backup) item.sourceBackup = backup
    item.error = null
    save()
    return info(id)
  }
  function candidate(id) {
    const item = record(id)
    if (stocks.has(id)) {
      const source = stocks.get(id)
      const rev = snapshot(id, source.root, source.manifest)
      return { revision: rev, path: revisionPath(id, rev), manifest: source.manifest }
    }
    if (!item.staged || item.workspaceRevision !== revision(sourcePath(id))) stageInternal({ path: sourcePath(id) })
    const source = packageFor(id, item.staged)
    return { revision: item.staged, path: source.root, manifest: source.manifest }
  }
  function verifyApproval(id, revisionId, expectedRevision) {
    if (expectedRevision === undefined) return
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision) || revisionId !== expectedRevision) throw fail('Component candidate changed after approval; review it again', 'cancelled')
    const source = packageFor(id, revisionId)
    const current = stocks.has(id) ? stockRevision(source) : revision(source.root)
    if (current !== expectedRevision) throw fail('Approved component snapshot changed; review it again', 'cancelled')
  }
  async function restoreAfterFailure(id, previous, properties, error) {
    log.error('component change failed, rolling back', { id, err: error.stack })
    let cleanupError
    try { await deactivate(id) } catch (cleanup) { cleanupError = cleanup }
    const item = record(id)
    for (const key of Object.keys(item)) delete item[key]
    Object.assign(item, previous, { error: error.message })
    store.properties ||= {}
    store.properties[id] = properties
    if (cleanupError) {
      item.enabled = false
      item.error += `; cleanup failed: ${cleanupError.message}`
    } else if (previous.active && previous.enabled) {
      try { await activate(id, previous.active, previous.grants || []); await notify(id, 'rollback', { revision: previous.active }) }
      catch (recovery) {
        item.enabled = false
        item.error += `; recovery failed: ${recovery.message}`
        try { await deactivate(id) }
        catch (cleanup) { item.error += `; recovery cleanup failed: ${cleanup.message}` }
      }
    }
    save()
    return fail(item.error, error.code)
  }
  async function switchRevision(id, next, grants, action, expectedRevision, configuration, context = {}) {
    assertOperation(context)
    if (safeMode && !stocks.has(id)) throw fail('Leave safe mode before enabling custom components', 'forbidden')
    const item = record(id)
    const previous = clone(item)
    const previousProperties = clone(propertiesFor(id) || { global: {}, spaces: {} })
    const nextProperties = configuration === undefined ? clone(previousProperties) : clone(configuration)
    verifyApproval(id, next, expectedRevision)
    validateProperties(id, packageFor(id, next).manifest, nextProperties)
    try {
      await deactivate(id) // Cleanup is never interrupted; no old/new overlap.
      context = afterTargetTeardown(context, id)
      assertOperation(context)
      verifyApproval(id, next, expectedRevision)
      store.properties ||= {}
      store.properties[id] = nextProperties
      await activate(id, next, grants, context)
      assertOperation(context)
      item.active = next; item.enabled = true; item.grants = grants; item.error = null
      item.activeProperties = clone(propertiesFor(id))
      if (previous.active && (previous.active !== next || action === 'revert')) {
        item.previous = previous.active
        item.previousGrants = previous.grants
        item.previousProperties = previousProperties
      }
      if (item.staged === next) item.staged = null
      await notify(id, action, { previous: previous.active || null, revision: next })
      assertOperation(context)
      save()
      if (action === 'revert') {
        for (const entry of settingsList({ id })) notifySetting(entry)
        const current = typeof state === 'function' ? state() : state
        for (const spaceId of new Set([...Object.keys(previousProperties.spaces), ...Object.keys(nextProperties.spaces)])) {
          if ((current.spaces || []).some((space) => space.id === spaceId && !space.incognito && !space.private)) {
            for (const entry of settingsList({ id, spaceId })) notifySetting(entry)
          }
        }
      }
      return info(id)
    } catch (error) {
      throw await restoreAfterFailure(id, previous, previousProperties, error)
    }
  }
  function registerStock({ manifest, root: directory, activate: activateStock }) {
    if (started) throw fail('Register stock before start')
    directory = hostRoot(directory || bundledRoot)
    manifest = validate(directory, manifest)
    if (!manifest.id.startsWith('stock.') || stocks.has(manifest.id)) throw fail('Invalid or duplicate stock id')
    stocks.set(manifest.id, { manifest, root: directory, activate: activateStock })
  }
  function refreshStock({ id, manifest, root: directory }) { return serial(async () => {
    if (!started || !stocks.has(id)) throw fail('Refresh requires an installed stock component')
    const previous = stocks.get(id)
    directory = hostRoot(directory || previous.root)
    manifest = validate(directory, manifest)
    if (manifest.id !== id) throw fail('Stock component id changed')
    if (manifest.backend || previous.manifest.backend || previous.activate) throw fail('Only UI stock sources can be refreshed')
    validateProperties(id, manifest)
    const provided = new Set(roles(manifest))
    const affected = [...new Set([...roles(previous.manifest), ...provided])]
    const item = record(id)
    const rev = stockRevision({ manifest, root: directory })
    await deactivate(id)
    stocks.set(id, { manifest, root: directory })
    item.active = rev
    item.grants = manifest.capabilities
    item.error = null
    // Shell switches may remove stock-only files, but never change a user's
    // independently selected global or per-space component.
    for (const bindings of [store.bindings.global, ...Object.values(store.bindings.spaces)]) {
      for (const role of Object.keys(bindings)) if (bindings[role] === id && !provided.has(role)) delete bindings[role]
    }
    for (const role of provided) if (!own(store.bindings.global, role)) store.bindings.global[role] = id
    try {
      if (item.enabled) await activate(id, rev, item.grants)
      await onReplace({ id, owner: id, action: 'refresh', roles: affected, revision: rev })
      save()
      await followStock(id)
      return info(id)
    } catch (error) { item.error = error.message; save(); throw error }
  }) }
  const stockRevision = (stock) => crypto.createHash('sha256').update(revision(stock.root)).update(JSON.stringify(stock.manifest)).digest('hex')
  // Bundled sources are identified by where they sit in the app, not by absolute path.
  const stockKey = (stock) => bundledRoot ? path.relative(hostRoot(bundledRoot), stock.root) : stock.root
  const copyManifest = (source, from, id) => ({ ...source, id, commands: Object.fromEntries(Object.entries(source.commands || {}).map(([key, command]) => [key, command.replace(from + '.', id + '.')])) })
  function untouched(id, item) {
    try { return [sourcePath(id), item.active && revisionPath(id, item.active)].filter(Boolean).every((directory) => sourceHash(directory, manifestOf(directory)) === item.origin.sourceHash) }
    catch { return false }
  }
  async function follow(id, item, stock, base) {
    const grants = item.grants || []
    const manifest = copyManifest(clone(stock.manifest), item.origin.id, id)
    if (item.active && !manifest.capabilities.every((cap) => grants.includes(cap))) return // new capabilities need the normal approval
    const origin = { ...item.origin, baseRevision: base, sourceRevision: revision(stock.root), version: stock.manifest.version }
    const temporary = path.join(root, 'staging', crypto.randomUUID())
    fs.mkdirSync(path.dirname(temporary), { recursive: true })
    fs.cpSync(stock.root, temporary, { recursive: true })
    try {
      origin.sourceHash = sourceHash(temporary, manifest)
      atomic(path.join(temporary, 'manifest.json'), { ...manifest, origin })
      validateProperties(id, manifest)
      const rev = snapshot(id, temporary)
      if (started && item.enabled && item.active) await switchRevision(id, rev, grants, 'apply')
      else if (item.active) Object.assign(item, { previous: item.active, previousGrants: grants, previousProperties: clone(propertiesFor(id) || { global: {}, spaces: {} }), active: rev, error: null })
      fs.rmSync(sourcePath(id), { recursive: true, force: true })
      fs.cpSync(temporary, sourcePath(id), { recursive: true })
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
    item.origin = origin
    item.staged = null
    item.workspaceRevision = revision(sourcePath(id))
    save()
  }
  // A copy whose source still hashes to its recorded origin follows its stock's new revision; edited copies,
  // copies of workspace sources and legacy imports (no recorded hash) are never touched.
  async function followStock(only) {
    if (safeMode) return
    for (const [id, item] of Object.entries(store.components)) {
      const origin = item.origin
      const stock = origin?.type === 'copy' && origin.source === 'bundled' && origin.sourceHash && stocks.get(origin.id)
      if (!stock || (only && origin.id !== only) || origin.stockRoot !== stockKey(stock)) continue
      const base = stockRevision(stock)
      if (base === origin.baseRevision || !untouched(id, item)) continue
      try { await follow(id, item, stock, base) } catch {} // a copy that cannot follow keeps its current revision
    }
  }
  async function start(options = {}) {
    const nextSafeMode = options.safeMode ?? safeMode
    if (started && nextSafeMode === safeMode) return list()
    if (started) await stop()
    safeMode = nextSafeMode
    log.info('components start', { safeMode })
    fs.mkdirSync(root, { recursive: true })
    if (fs.existsSync(storeFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
        const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
        if (!object(parsed) || parsed.version !== 1 || !object(parsed.components) || !object(parsed.bindings) || !object(parsed.bindings.global) || !object(parsed.bindings.spaces)) throw fail('Invalid component composition schema')
        for (const [id, item] of Object.entries(parsed.components)) {
          if (!ID.test(id) || !object(item) || typeof item.enabled !== 'boolean' || (item.grants !== undefined && (!Array.isArray(item.grants) || item.grants.some((grant) => typeof grant !== 'string'))) || ['active', 'previous', 'staged'].some((key) => item[key] != null && !/^[a-f0-9]{64}$/.test(item[key]))) throw fail('Invalid component record')
          for (const key of ['activeProperties', 'previousProperties']) if (item[key] != null) validatePropertyShape(item[key])
        }
        for (const bindings of [parsed.bindings.global, ...Object.values(parsed.bindings.spaces)]) {
          if (!object(bindings) || Object.entries(bindings).some(([role, id]) => !NAME.test(role) || typeof id !== 'string' || !ID.test(id))) throw fail('Invalid component role bindings')
        }
        if (parsed.properties !== undefined) {
          if (!object(parsed.properties)) throw fail('Invalid component property store')
          for (const [id, properties] of Object.entries(parsed.properties)) {
            if (!ID.test(id)) throw fail('Invalid component property owner')
            validatePropertyShape(properties)
          }
        }
        store = parsed
      } catch (error) {
        log.error('component composition load failed', { safeMode, err: error.message })
        if (!safeMode) throw fail(`Component composition could not be loaded; restart with --safe-mode. ${error.message}`)
        const backup = path.join(root, 'recovery', `composition-${crypto.randomUUID()}.json`)
        fs.mkdirSync(path.dirname(backup), { recursive: true })
        fs.copyFileSync(storeFile, backup, fs.constants.COPYFILE_EXCL)
        store = { version: 1, components: {}, bindings: { global: {}, spaces: {} }, recovery: { error: error.message, backup, time: new Date().toISOString() } }
      }
    }
    if (!safeMode && !store.legacyImported && legacyShellDir && fs.existsSync(legacyShellDir)) {
      const id = 'legacy.shell'
      if (store.components[id]) throw fail('Legacy import id is already occupied')
      legacyShellDir = hostRoot(legacyShellDir)
      files(legacyShellDir)
      const backup = path.join(root, 'legacy', crypto.randomUUID())
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      fs.cpSync(legacyShellDir, backup, { recursive: true })
      const directory = sourcePath(id)
      fs.mkdirSync(path.dirname(directory), { recursive: true })
      fs.cpSync(backup, directory, { recursive: true })
      const surfaces = {}
      for (const [role, name] of Object.entries({ shell: 'index.html', launcher: 'palette.html', frame: 'frame.html', tablist: 'tablist.html', spaces: 'panel.html', overview: 'expose.html' })) if (fs.existsSync(path.join(directory, name))) surfaces[role] = name
      atomic(path.join(directory, 'manifest.json'), { apiVersion: 1, id, version: '1.0.0', surfaces, capabilities: ['ui', 'host.manage', 'call:*', 'events:*'], origin: { type: 'legacy', backup } })
      const rev = snapshot(id, directory)
      store.components[id] = { active: rev, enabled: true, grants: ['ui', 'host.manage', 'call:*', 'events:*'], origin: { type: 'legacy', backup, fullShell: true } }
      store.legacyImported = { id, backup, hostManagementMigrated: true }
      save()
    }
    if (!safeMode && legacyShellDir && store.legacyImported && (!store.legacyImported.rolesBound || !store.legacyImported.hostManagementMigrated)) {
      const id = store.legacyImported.id
      const item = record(id)
      const manifest = manifestFor(id)
      const original = JSON.stringify(manifest)
      const previousGrants = [...(item.grants || [])]
      if (!store.legacyImported.hostManagementMigrated) {
        if (!manifest.capabilities.includes('host.manage')) manifest.capabilities.push('host.manage')
        if (!item.grants.includes('host.manage')) item.grants.push('host.manage')
        store.legacyImported.hostManagementMigrated = true
      }
      delete manifest.surfaces.layout
      if (!manifest.surfaces.spaces && fs.existsSync(path.join(revisionPath(id, item.active), 'panel.html'))) manifest.surfaces.spaces = 'panel.html'
      if (JSON.stringify(manifest) !== original) {
        const previous = item.active
        item.active = snapshot(id, revisionPath(id, previous), manifest)
        item.previous = previous
        item.previousGrants = previousGrants
        item.previousProperties = clone(propertiesFor(id) || { global: {}, spaces: {} })
      }
      if (!store.legacyImported.rolesBound) {
        for (const role of ['shell', 'launcher', 'frame', 'tablist', 'spaces', 'overview']) {
          const selected = store.bindings.global[role]
          if (manifest.surfaces[role] && (!selected || selected.startsWith('stock.') || selected === id)) store.bindings.global[role] = id
        }
        for (const bindings of [store.bindings.global, ...Object.values(store.bindings.spaces)]) if (bindings.layout === id) delete bindings.layout
        store.legacyImported.rolesBound = true
      }
    }
    // A stock component an update no longer ships leaves no entry or binding behind.
    for (const id of Object.keys(store.components)) {
      if (!id.startsWith('stock.') || stocks.has(id)) continue
      delete store.components[id]
      for (const bindings of [store.bindings.global, ...Object.values(store.bindings.spaces)]) for (const role of Object.keys(bindings)) if (bindings[role] === id) delete bindings[role]
    }
    for (const [id, stock] of stocks) {
      const rev = stockRevision(stock)
      const item = store.components[id] ||= { enabled: true, origin: { type: 'bundled' } }
      item.active = rev; item.grants = stock.manifest.capabilities
      for (const role of roles(stock.manifest)) if (!own(store.bindings.global, role)) store.bindings.global[role] = id
    }
    await followStock()
    started = true
    for (const [id, item] of Object.entries(store.components)) if (item.enabled && item.active) {
      if (safeMode && !stocks.has(id)) continue
      try { await activate(id, item.active, item.grants || []); item.error = null }
      catch (error) { item.error = error.message; item.enabled = false }
    }
    save()
    return list()
  }
  function list() { return Object.keys(store.components).map(info) }
  function inspect({ id, instance } = {}) {
    id ||= instance
    if (!id) return { apiVersion: 1, components: list(), bindings: clone(store.bindings), properties: clone(store.properties || {}), legacy: clone(store.legacyImported), recovery: clone(store.recovery), safeMode }
    const detail = info(id)
    let settings = []
    try { settings = settingsList({ id }) } catch (error) { detail.error ||= error.message }
    return { ...detail, settings, properties: clone(propertiesFor(id) || { global: {}, spaces: {} }) }
  }
  function create({ id, from, role } = {}, context = {}) { return serial(async () => {
    if (typeof id !== 'string' || !ID.test(id) || id === 'core' || id.startsWith('stock.') || own(store.components, id) || fs.existsSync(sourcePath(id))) throw fail('Invalid, reserved, or duplicate component id')
    if (role && !NAME.test(role)) throw fail('Invalid role')
    let manifest, origin
    const directory = sourcePath(id)
    fs.mkdirSync(path.dirname(directory), { recursive: true })
    if (from) {
      const original = info(from)
      const sourceManifest = validate(original.path, stocks.get(from)?.manifest)
      if (sourceManifest.id !== from) throw fail('Source component id changed')
      const sourceRevision = revision(original.path)
      fs.cpSync(original.path, directory, { recursive: true })
      manifest = copyManifest(sourceManifest, from, id)
      origin = { type: 'copy', id: from, baseRevision: original.revision, sourceRevision, source: stocks.has(from) ? 'bundled' : 'workspace', version: sourceManifest.version }
      if (stocks.has(from)) Object.assign(origin, { stockRoot: stockKey(stocks.get(from)), sourceHash: sourceHash(directory, manifest) })
    } else {
      fs.mkdirSync(directory)
      manifest = { apiVersion: 1, id, version: '1.0.0', surfaces: {}, capabilities: [] }
      if (role) { manifest.surfaces[role] = 'index.html'; manifest.capabilities.push('ui'); fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + id + '</title><body><main><h1>' + id + '</h1></main></body></html>\n') }
      origin = { type: 'local' }
    }
    manifest.origin = origin
    atomic(path.join(directory, 'manifest.json'), manifest)
    store.components[id] = { enabled: false, grants: [], origin }
    save()
    return info(id)
  }, context) }
  function apply({ id, grants, expectedRevision } = {}, context = {}) { return serial(async () => {
    const item = record(id)
    if (stocks.has(id)) throw fail('Copy a stock component before applying changes')
    let selected
    if (expectedRevision !== undefined) {
      verifyApproval(id, item.staged, expectedRevision)
      if (item.workspaceRevision !== revision(sourcePath(id))) throw fail('Component workspace changed after approval; review it again', 'cancelled')
      const source = packageFor(id, expectedRevision)
      selected = { revision: expectedRevision, manifest: source.manifest }
    } else selected = candidate(id)
    const manifest = selected.manifest
    grants ||= manifest.capabilities
    if (!Array.isArray(grants) || grants.some((cap) => !manifest.capabilities.includes(cap))) throw fail('Grants must be declared capabilities')
    return switchRevision(id, selected.revision, [...new Set(grants)], 'apply', expectedRevision, undefined, context)
  }, context) }
  function revert({ id, expectedRevision }, context = {}) { return serial(async () => { const item = record(id); if (!item.previous) throw fail('No previous working revision'); return switchRevision(id, item.previous, item.previousGrants || item.grants, 'revert', expectedRevision, item.previousProperties || { global: {}, spaces: {} }, context) }, context) }
  function disable({ id }, context = {}) { return serial(async () => {
    const item = record(id), previous = clone(item), properties = clone(propertiesFor(id) || { global: {}, spaces: {} })
    try {
      await deactivate(id)
      context = afterTargetTeardown(context, id)
      assertOperation(context)
      item.enabled = false
      await notify(id, 'disable')
      assertOperation(context)
      save()
      return info(id)
    } catch (error) { throw await restoreAfterFailure(id, previous, properties, error) }
  }, context) }
  function enable({ id, expectedRevision }, context = {}) { return serial(async () => { const item = record(id); if (!item.active) throw fail('Apply the component before enabling it'); return switchRevision(id, item.active, item.grants, 'enable', expectedRevision, undefined, context) }, context) }
  function remove({ id, deleteData = false }, context = {}) { return serial(async () => {
    const item = record(id)
    if (stocks.has(id)) throw fail('Bundled components can be disabled, not removed')
    const previous = clone(item), properties = clone(propertiesFor(id) || { global: {}, spaces: {} })
    try {
      await deactivate(id)
      context = afterTargetTeardown(context, id)
      assertOperation(context)
      item.enabled = false
      await notify(id, 'remove')
      assertOperation(context)
    } catch (error) { throw await restoreAfterFailure(id, previous, properties, error) }
    for (const bindings of [store.bindings.global, ...Object.values(store.bindings.spaces)]) for (const role of Object.keys(bindings)) if (bindings[role] === id) delete bindings[role]
    delete store.components[id]
    if (deleteData && store.properties) delete store.properties[id]
    save()
    fs.rmSync(sourcePath(id), { recursive: true, force: true }); fs.rmSync(path.join(root, 'revisions', id), { recursive: true, force: true })
    if (deleteData) fs.rmSync(path.join(root, 'data', id), { recursive: true, force: true })
    return { id, removed: true, dataRetained: !deleteData }
  }, context) }
  function bind({ role, id, spaceId } = {}, context = {}) { return serial(async () => {
    if (typeof role !== 'string' || !NAME.test(role) || (spaceId !== undefined && (typeof spaceId !== 'string' || !/^[\w-]+$/.test(spaceId) || ['__proto__', 'constructor', 'prototype'].includes(spaceId)))) throw fail('Invalid role binding')
    const runtime = active.get(id)
    if (!runtime || !roles(runtime.manifest).includes(role)) throw fail('Component does not provide an active role')
    const bindings = spaceId ? (store.bindings.spaces[spaceId] ||= {}) : store.bindings.global
    const previous = bindings[role]
    bindings[role] = id
    try { await onReplace({ id, owner: id, action: 'bind', roles: [role], role, spaceId, previous }); assertOperation(context); save() }
    catch (error) {
      if (previous) bindings[role] = previous
      else delete bindings[role]
      try { await onReplace({ id: previous || id, owner: previous || id, action: 'rollback', roles: [role], role, spaceId, previous: id }) }
      catch (recovery) { throw fail(`${error.message}; binding recovery failed: ${recovery.message}`, error.code) }
      throw error
    }
    return resolve(role, { spaceId })
  }, context) }
  function selection(runtime, role) {
    if (!runtime?.live) return null
    const file = runtime.manifest.surfaces[role]
    if (file && !runtime.grants.includes('ui')) return null
    const command = runtime.manifest.commands?.[role]
    if (!file && !command && !runtime.manifest.roles?.includes(role)) return null
    return { id: runtime.id, owner: runtime.id, file: file ? relative(runtime.root, file) : null, command: command || null, role, revision: runtime.revision, path: runtime.root, manifest: clone(runtime.manifest) }
  }
  function resolve(role, { spaceId, fallback } = {}) {
    const scoped = store.bindings.spaces[spaceId]?.[role]
    const scopedSelection = selection(active.get(scoped), role)
    if (scopedSelection) return { ...scopedSelection, source: 'space', spaceId }
    const globalSelection = selection(active.get(store.bindings.global[role]), role)
    if (globalSelection) return { ...globalSelection, source: 'global' }
    const defaultSelection = typeof fallback === 'string' ? selection(active.get(fallback), role) : fallback && typeof fallback === 'object' ? fallback : null
    if (defaultSelection) return { ...defaultSelection, source: 'default' }
    // Match startup's deterministic provider order without overwriting an
    // inactive user's binding; it becomes effective again when enabled.
    for (const id of stocks.keys()) {
      const stockSelection = selection(active.get(id), role)
      if (stockSelection) return { ...stockSelection, source: 'default' }
    }
    return null
  }
  function surface({ id, name }) { const result = selection(active.get(id), name); if (!result?.file) throw fail('Unknown active component surface'); return result }
  function ownerForFile(file) {
    try { if (file.startsWith('file:')) file = fileURLToPath(file); file = path.resolve(file); for (const runtime of active.values()) if (runtime.live && runtime.grants.includes('ui') && inside(runtime.root, file)) { relative(runtime.root, path.relative(runtime.root, file)); return runtime.id } } catch {}
    return null
  }
  function bridge(owner) { const runtime = active.get(owner); if (!runtime) throw fail('Component is not active'); return apiFor(runtime) }
  function emit(event, payload) { for (const item of subscriptions.get(event) || []) if (item.runtime.live) { try { Promise.resolve(item.callback(clone(payload))).catch(() => {}) } catch {} } }
  function sourceRead({ id, file }) { const directory = stocks.get(id)?.root || sourcePath(id); record(id); const target = relative(directory, file); if (fs.statSync(target).size > 1024 * 1024) throw fail('Source file exceeds 1 MiB'); return { file, path: target, content: fs.readFileSync(target, 'utf8') } }
  async function sourceWrite({ id, file, content }) { record(id); if (stocks.has(id)) throw fail('Copy stock source before editing'); if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw fail('Source content must be at most 1 MiB'); const target = relative(sourcePath(id), file, false); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); record(id).staged = null; save(); return { file, path: target } }
  function previewComponent({ id }, context = {}) { return serial(async () => {
    if (!preview) throw fail('Isolated preview is unavailable')
    const item = record(id)
    const selected = candidate(id)
    assertOperation(context)
    return preview({ id, ...selected, backend: false, previous: item.active }, context)
  }, context) }
  async function stop() {
    await queue
    log.info('components stop', { active: active.size })
    const errors = []
    for (const id of [...active.keys()]) {
      try { await deactivate(id) }
      catch (error) { errors.push(error) }
    }
    started = false
    if (errors.length) log.error('component shutdown failed', { errors: errors.map((error) => error.message) })
    if (errors.length) throw new AggregateError(errors, `Component shutdown failed: ${errors.map((error) => error.message).join('; ')}`)
  }
  function register(target = registry) {
    const string = { type: 'string', minLength: 1 }
    const definitions = [
      ['list', {}, [], list], ['inspect', { id: string, instance: string }, [], inspect],
      ['create', { id: string, from: string, role: string }, ['id'], create], ['check', { id: string, path: string }, [], check],
      ['stage', { path: string }, ['path'], (params, context) => serial(() => stageInternal(params), context)],
      ['apply', { id: string, grants: { type: 'array', items: string }, expectedRevision: string }, ['id'], apply],
      ['revert', { id: string, expectedRevision: string }, ['id'], revert], ['disable', { id: string }, ['id'], disable], ['enable', { id: string, expectedRevision: string }, ['id'], enable],
      ['remove', { id: string, deleteData: { type: 'boolean' } }, ['id'], remove], ['bind', { role: string, id: string, spaceId: string }, ['role', 'id'], bind],
      ['resolve', { role: string, spaceId: string, fallback: string }, ['role'], ({ role, ...options }) => resolve(role, options)],
      ['preview', { id: string }, ['id'], previewComponent],
      ['source.read', { id: string, file: string }, ['id', 'file'], sourceRead], ['source.write', { id: string, file: string, content: { type: 'string' } }, ['id', 'file', 'content'], sourceWrite],
      ['storage.read', { id: string, key: string, version: { type: 'integer', minimum: 1 }, spaceId: string }, ['id', 'key'], storageRead],
      ['storage.write', { id: string, key: string, value: {}, version: { type: 'integer', minimum: 1 }, spaceId: string }, ['id', 'key', 'value'], dataWrite],
      ['storage.remove', { id: string, key: string, version: { type: 'integer', minimum: 1 }, spaceId: string }, ['id', 'key'], dataRemove],
      ['settings.list', { id: string, spaceId: string, query: { type: 'string' } }, [], settingsList],
      ['settings.get', { id: string, key: string, spaceId: string }, ['id'], settingsGet],
      ['settings.set', { id: string, key: string, value: {}, spaceId: string }, ['id', 'key', 'value'], settingsSet],
      ['settings.reset', { id: string, key: string, spaceId: string }, ['id', 'key'], settingsReset],
    ]
    const tools = new Set(['list', 'inspect', 'source.read', 'source.write', 'check', 'preview', 'create', 'apply', 'enable', 'revert', 'bind'])
    const disposers = definitions.map(([name, properties, required, run]) => target.register('core', { name: 'components.' + name, description: `Local component ${name}`, inputSchema: { type: 'object', properties, required, additionalProperties: false }, tool: tools.has(name), run: (params, context) => { assertOperation(context); return run(params, context) } }))
    return () => disposers.forEach((dispose) => dispose())
  }
  return { start, stop, list, inspect, create, check, stage: (params, context) => serial(() => stageInternal(params), context), apply, revert, disable, enable, remove, bind, resolve, surface, register, registerStock, refreshStock, bridge, authorize, ownerForFile, emit, dataRead: storageRead, dataWrite, dataRemove, sourceRead, sourceWrite, settingsList, settingsGet, settingsSet, settingsReset, preview: previewComponent }
}

module.exports = { createComponents }

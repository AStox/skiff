'use strict'
const { isDeepStrictEqual } = require('node:util')
const settings = require('./settings-catalog')

const error = (code, message) => Object.assign(new Error(message), { code })
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = (value) => structuredClone(value)
const types = {
  null: (v) => v === null,
  object,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: Number.isInteger
}
const keywords = new Set(['$schema', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'anyOf', 'oneOf', 'allOf', 'not'])

// Fail registration for unsupported validation keywords rather than advertising
// schemas whose constraints the host does not actually enforce.
function checkSchema(schema, depth = 0) {
  const bad = (message) => { throw error('bad_schema', message) }
  if (typeof schema === 'boolean') return
  if (!object(schema) || depth > 64) bad('Schema must be an object or boolean, at most 64 levels deep')
  for (const key of Object.keys(schema)) if (!keywords.has(key)) bad(`Unsupported schema keyword: ${key}`)
  const validType = (type) => typeof type === 'string' && Object.hasOwn(types, type)
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type.length && schema.type.every(validType) : validType(schema.type))) bad('Invalid schema type')
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) bad('enum must be a non-empty array')
  if (schema.properties !== undefined) {
    if (!object(schema.properties)) bad('properties must be an object')
    for (const child of Object.values(schema.properties)) checkSchema(child, depth + 1)
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === 'string') || new Set(schema.required).size !== schema.required.length)) bad('required must contain unique property names')
  for (const key of ['additionalProperties', 'items', 'not']) if (schema[key] !== undefined) checkSchema(schema[key], depth + 1)
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] !== undefined) {
    if (!Array.isArray(schema[key]) || !schema[key].length) bad(`${key} must be a non-empty array`)
    for (const child of schema[key]) checkSchema(child, depth + 1)
  }
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties']) if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) bad(`${key} must be a non-negative integer`)
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (schema[key] !== undefined && !types.number(schema[key])) bad(`${key} must be finite`)
  if (schema.multipleOf !== undefined && schema.multipleOf <= 0) bad('multipleOf must be positive')
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') bad('uniqueItems must be boolean')
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') bad('pattern must be a string')
    try { new RegExp(schema.pattern, 'u') } catch { bad('Invalid schema pattern') }
  }
}

function validateSchema(schema, value, path = 'params', code = 'bad_params', depth = 0) {
  const fail = (detail) => { throw error(code, `${path} ${detail}`) }
  if (schema === false) fail('is not allowed')
  if (schema === true) return value
  if (depth > 64) fail('is too deeply nested')
  const matches = (child) => { try { validateSchema(child, value, path, code, depth + 1); return true } catch (e) { if (e.code === code) return false; throw e } }
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some((type) => types[type](value))) fail(`must be ${[].concat(schema.type).join(' or ')}`)
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(item, value))) fail('must be one of the allowed values')
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema.const, value)) fail('must equal its declared constant')
  if (schema.anyOf && !schema.anyOf.some(matches)) fail('does not match any allowed shape')
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1) fail('must match exactly one allowed shape')
  if (schema.allOf) for (const child of schema.allOf) validateSchema(child, value, path, code, depth + 1)
  if (schema.not && matches(schema.not)) fail('matches a forbidden shape')
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) fail('has an invalid length')
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail('has an invalid format')
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('must be finite')
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail('is outside its allowed range')
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON * Math.max(1, Math.abs(value / schema.multipleOf))) fail('is not an allowed multiple')
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) fail('has an invalid item count')
    if (schema.uniqueItems && value.some((item, i) => value.slice(0, i).some((other) => isDeepStrictEqual(item, other)))) fail('must contain unique items')
    if (schema.items !== undefined) value.forEach((item, i) => validateSchema(schema.items, item, `${path}[${i}]`, code, depth + 1))
  } else if (object(value)) {
    const keys = Object.keys(value)
    if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail('has an invalid property count')
    for (const key of schema.required || []) if (!Object.hasOwn(value, key) || value[key] === undefined) fail(`requires ${key}`)
    for (const key of keys) {
      const child = Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : schema.additionalProperties
      // Local callers may pass undefined for optional fields, just as JSON omits them.
      if (value[key] === undefined && child !== false) continue
      if (child !== undefined) validateSchema(child, value[key], `${path}.${key}`, code, depth + 1)
    }
  }
  return value
}

function jsonCopy(value) {
  const visit = (item, seen = new Set()) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || types.number(item)) return
    if ((!Array.isArray(item) && !object(item)) || seen.has(item)) throw error('bad_params', 'Command metadata must be serializable JSON')
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw error('bad_params', 'Command metadata must contain plain objects')
    seen.add(item)
    for (const child of Object.values(item)) visit(child, seen)
    seen.delete(item)
  }
  visit(value)
  return clone(value)
}

function createRegistry({ changed = () => {} } = {}) {
  const commands = new Map()
  const tools = new Map()
  const owners = new Map()
  let generation = 0
  const validName = (name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name)
  const ownerState = (owner) => {
    if (!validName(owner)) throw error('bad_params', 'owner must be a non-empty identifier')
    if (!owners.has(owner)) owners.set(owner, { owner, generation: ++generation, entries: new Set(), callbacks: new Set(), controller: new AbortController() })
    return owners.get(owner)
  }
  const cancelled = () => error('cancelled', 'Command owner, registration or caller was disposed or cancelled')
  function register(owner, definition) {
    if (!object(definition) || !validName(definition.name) || typeof definition.run !== 'function') throw error('bad_params', 'Command needs a name and run function')
    if (typeof definition.description !== 'string') throw error('bad_params', 'Command needs a description')
    if (definition.inputSchema === undefined) throw error('bad_schema', 'Command needs an explicit inputSchema')
    checkSchema(definition.inputSchema)
    if (definition.outputSchema !== undefined) checkSchema(definition.outputSchema)
    if (definition.dispose !== undefined && typeof definition.dispose !== 'function') throw error('bad_params', 'dispose must be a function')
    const aliases = definition.aliases ?? []
    if (!Array.isArray(aliases) || !aliases.every(validName)) throw error('bad_params', 'aliases must contain command names')
    const names = [definition.name, ...aliases]
    if (new Set(names).size !== names.length) throw error('command_collision', 'A command cannot alias itself or repeat an alias')
    for (const name of names) if (commands.has(name)) throw error('command_collision', `Command ${name} is already owned by ${commands.get(name).metadata.owner}`)
    const metadata = jsonCopy({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema, title: definition.title ?? definition.name, visible: definition.visible ?? true, tool: definition.tool ?? false, aliases, owner, ...Object.fromEntries(['outputSchema', 'params'].filter((key) => definition[key] !== undefined).map((key) => [key, definition[key]])) })
    if (typeof metadata.title !== 'string' || typeof metadata.visible !== 'boolean' || !(typeof metadata.tool === 'boolean' || object(metadata.tool))) throw error('bad_params', 'Invalid command title, visible or tool metadata')
    if (object(metadata.tool) && Object.hasOwn(metadata.tool, 'name') && !validName(metadata.tool.name)) throw error('bad_params', 'tool.name must be a non-empty identifier')
    const toolName = metadata.tool ? metadata.tool.name || metadata.name : null
    if (toolName && tools.has(toolName)) throw error('command_collision', `Tool ${toolName} is already owned by ${tools.get(toolName).metadata.owner}`)
    const state = ownerState(owner)
    const entry = { metadata, toolName, run: definition.run, controller: new AbortController(), active: true, state }
    function remove(notify = true) {
      if (!entry.active) return false
      entry.active = false
      for (const name of names) if (commands.get(name) === entry) commands.delete(name)
      if (toolName && tools.get(toolName) === entry) tools.delete(toolName)
      state.entries.delete(entry)
      entry.controller.abort(cancelled())
      try { definition.dispose?.() } finally { if (notify) changed() }
      return true
    }
    entry.remove = remove
    for (const name of names) commands.set(name, entry)
    if (toolName) tools.set(toolName, entry)
    state.entries.add(entry)
    changed()
    return () => remove()
  }
  function onDispose(owner, callback) {
    if (typeof callback !== 'function') throw error('bad_params', 'Disposal callback must be a function')
    const state = ownerState(owner)
    state.callbacks.add(callback)
    return () => state.callbacks.delete(callback)
  }
  function dispose(owner) {
    const state = owners.get(owner)
    if (!state) return 0
    owners.delete(owner)
    const count = state.entries.size
    const failures = []
    // Unregister before abort callbacks can re-enter and register the next generation.
    for (const entry of state.entries) {
      for (const name of [entry.metadata.name, ...entry.metadata.aliases]) if (commands.get(name) === entry) commands.delete(name)
      if (entry.toolName && tools.get(entry.toolName) === entry) tools.delete(entry.toolName)
    }
    state.controller.abort(cancelled())
    for (const entry of [...state.entries]) try { entry.remove(false) } catch (e) { failures.push(e) }
    for (const callback of state.callbacks) try { callback() } catch (e) { failures.push(e) }
    state.callbacks.clear()
    changed()
    if (failures.length) throw new AggregateError(failures, `Disposing ${owner} failed`)
    return count
  }
  async function call(name, params = {}, context = {}) {
    const entry = commands.get(name)
    if (!entry) throw error('unknown_method', `Unknown method: ${name}`)
    if (!object(params)) throw error('bad_params', 'params must be an object')
    try { params = clone(params) } catch { throw error('bad_params', 'params must be cloneable data') }
    context = { ...context }
    validateSchema(entry.metadata.inputSchema, params)
    const caller = context.owner === undefined ? null : ownerState(context.owner)
    const signals = [...new Set([context.signal, entry.controller.signal, entry.state.controller.signal, caller?.controller.signal].filter(Boolean))]
    for (const signal of signals) if (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean') throw error('bad_params', 'signal must be an AbortSignal')
    if (signals.some((signal) => signal.aborted)) throw cancelled()
    const controller = new AbortController()
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => { for (const signal of signals) signal.removeEventListener('abort', abort) }
      const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value) }
      const abort = () => { controller.abort(cancelled()); finish(reject, cancelled()) }
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
      // The microtask ensures synchronous exceptions follow the same cleanup path.
      Promise.resolve().then(() => {
        if (settled) return
        return entry.run(params, { ...context, signal: controller.signal, commandOwner: entry.metadata.owner, generation: entry.state.generation })
      }).then((value) => {
        if (settled) return
        try {
          if (entry.metadata.outputSchema !== undefined) validateSchema(entry.metadata.outputSchema, value, 'result', 'bad_result')
          finish(resolve, value)
        } catch (e) { finish(reject, e) }
      }, (e) => finish(reject, e))
    })
  }
  function list({ owner, visible, tool } = {}) {
    return [...new Set(commands.values())].filter((entry) => (owner === undefined || entry.metadata.owner === owner) && (visible === undefined || entry.metadata.visible === visible) && (tool === undefined || Boolean(entry.metadata.tool) === tool)).map((entry) => clone(entry.metadata)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }
  return { register, call, list, has: (name) => commands.has(name), get: (name) => commands.has(name) ? clone(commands.get(name).metadata) : undefined, dispose, onDispose }
}

const string = { type: 'string' }
const id = { type: 'string', minLength: 1 }
const number = { type: 'number' }
const integer = { type: 'integer' }
const boolean = { type: 'boolean' }
const shape = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const array = (items, extra = {}) => ({ type: 'array', items, ...extra })
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] })
const rect = { x: number, y: number, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } }
const rectSchema = shape(rect, Object.keys(rect))
const identity = { enum: ['native', 'compatible', null] }
const schemas = {
  'commands.list': shape(),
  'state.get': shape(),
  'spaces.create': shape({ name: id, color: string }, ['name']),
  'spaces.update': shape({ id, name: id, color: string }, ['id']),
  'spaces.move': shape({ id, index: integer }, ['id', 'index']),
  'spaces.remove': shape({ id }, ['id']),
  'spaces.activate': shape({ id }, ['id']),
  'spaces.cycle': shape({ delta: integer }, ['delta']),
  'incognito.open': shape(),
  'tabs.create': shape({ url: string, spaceId: id, parentId: id, activate: boolean, agent: { type: 'string', minLength: 1, maxLength: 40 }, intent: boolean }, ['url']),
  'tabs.reroute': shape({ id }, ['id']),
  'tabs.close': shape({ id }),
  'tabs.activate': shape({ id }, ['id']),
  'tabs.read': shape({ id }),
  'tabs.navigate': shape({ id, url: string, browserIdentity: identity, agent: { type: 'string', minLength: 1, maxLength: 40 }, look: boolean }, ['url']),
  'tabs.back': shape({ id }),
  'tabs.forward': shape({ id }),
  'tabs.reload': shape({ id, ignoreCache: boolean }),
  'tabs.zoom': shape({ id, delta: { enum: [-1, 0, 1] } }, ['delta']),
  'tabs.print': shape({ id }),
  'tabs.copyUrl': shape({ id }),
  'tabs.move': shape({ id, index: { type: 'integer', minimum: 0 }, spaceId: id }, ['id']),
  'tabs.setFavorite': shape({ id, favorite: boolean }, ['favorite']),
  'tabs.setPinned': shape({ id, pinned: boolean, folder: string, folderId: nullable(id) }, ['pinned']),
  'tabs.setBucket': shape({ id, bucket: { enum: ['favorites', 'later', 'active', 'unread', 'done'] } }, ['bucket']),
  'tabs.cycle': shape({ delta: integer }, ['delta']),
  'tabs.select': shape({ index: integer }, ['index']),
  'tabs.thumbnails': shape({ ids: array(string, { maxItems: 24 }), width: { type: 'number', minimum: 16, maximum: 3840 } }, ['ids']),
  'folders.setCollapsed': { ...shape({ spaceId: id, folder: string, folderId: id, collapsed: boolean }, ['collapsed']), anyOf: [{ required: ['folder'] }, { required: ['folderId'] }] },
  'desk.place': shape({ id, ...rect, width: { type: 'number', minimum: 240 }, height: { type: 'number', minimum: 160 } }, Object.keys(rect)),
  'desk.layouts': shape(),
  'desk.tile': shape({ id, layout: { enum: ['fill', 'center', 'left', 'right', 'top', 'bottom', 'left-third', 'center-third', 'right-third', 'left-two-thirds', 'right-two-thirds', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] } }, ['layout']),
  'desk.hide': shape({ id }),
  'desk.show': shape({ id }, ['id']),
  'archive.restore': shape({ id }),
  'archive.remove': shape({ id }, ['id']),
  'archive.clear': shape(),
  'archive.sweep': shape(),
  'import.arc.preview': shape({ profileId: string }),
  'import.arc': shape({ profileIds: array(string, { minItems: 1 }), categories: shape({ tabs: boolean, openTabs: boolean, passwords: boolean, logins: boolean }, ['tabs', 'openTabs', 'passwords', 'logins']), keepSpaces: boolean }, ['profileIds', 'categories', 'keepSpaces']),
  'passwords.fill': shape(),
  'settings.set': shape({
    ...Object.fromEntries(settings.catalog.filter((entry) => entry.type !== 'action').map((entry) => [entry.id, settings.schemaForSetting(entry.id)])),
    shortcuts: { type: 'object', additionalProperties: shape({ method: id, params: { type: 'object' } }, ['method']) },
    globalShortcuts: { type: 'object', additionalProperties: shape({ method: id, params: { type: 'object' } }, ['method']) },
    browserIdentity: { type: 'object', additionalProperties: { enum: ['native', 'compatible'] } },
    ai: shape({ agents: array(shape({ name: { type: 'string', minLength: 1, maxLength: 40 }, command: { type: 'string', minLength: 1, maxLength: 500 } }, ['name', 'command']), { maxItems: 10 }), agent: string, model: { type: 'string', maxLength: 200 }, effort: { type: 'string', maxLength: 200 }, machine: { type: 'string', maxLength: 200 } })
  }),
  'ai.agents': shape(),
  'ai.machines': shape({ refresh: boolean }),
  'ai.installSkill': shape({ agent: id }, ['agent']),
  'ai.skillStatus': shape({ command: { type: 'string', minLength: 1, maxLength: 500 } }, ['command']),
  'ai.warm': shape({ agent: id, machine: string }, ['agent']),
  'ai.ask': shape({ text: string, agent: string, model: string, effort: string, machine: string, includePage: boolean, tabId: id, intent: boolean }, ['text']),
  'ai.chat': shape({ chatId: id }, ['chatId']),
  'ai.prompt': shape({ chatId: id, text: string, fresh: boolean }, ['chatId', 'text']),
  'ai.configure': shape({ chatId: id, model: string, effort: string, machine: string }, ['chatId']),
  'ai.cancel': shape({ chatId: id }, ['chatId']),
  'ai.permit': { ...shape({ chatId: id, optionId: id, cancel: { const: true } }, ['chatId']), oneOf: [{ required: ['optionId'], not: { required: ['cancel'] } }, { required: ['cancel'], not: { required: ['optionId'] } }] },
  'ui.setPageVisible': shape({ visible: boolean }, ['visible']),
  'ui.setPageBounds': shape({ ...rect, radius: { type: 'number', minimum: 0 } }, Object.keys(rect)),
  'ui.setDesk': shape({ hit: array(rectSchema), capture: boolean, animate: boolean, preview: nullable(shape({ id, ...rect }, ['id', ...Object.keys(rect)])), only: nullable(array(id, { minItems: 1 })), avoid: nullable(rectSchema) }),
  'ui.setFrame': shape({ id, hit: array(rectSchema) }, ['id', 'hit']),
  'ui.showOverlay': shape({ file: id, bounds: rectSchema, name: id, focus: boolean, float: boolean, hit: array(rectSchema), under: id }, ['file']),
  'ui.setWindowButtons': shape({ visible: boolean }, ['visible']),
  'ui.hideOverlay': shape({ name: id }),
  'extensions.list': shape(),
  'extensions.add': shape({ path: id }, ['path']),
  'extensions.download': shape({ url: id }, ['url']),
  'extensions.update': shape(),
  'extensions.remove': shape({ id }, ['id']),
  'extensions.open': shape({ id, page: string }, ['id']),
  'extensions.popup': shape({ id, bounds: rectSchema }, ['id', 'bounds']),
  'extensions.closePopup': shape(),
  'ui.emit': shape({ name: { type: 'string', minLength: 1, not: { const: 'state' } }, data: true, focus: boolean }, ['name']),
  'ui.focusPage': shape(),
  'ui.raise': shape(),
  'ui.inFront': shape(),
  'ui.reloadShell': shape(),
  'ui.resetShell': shape(),
  'ui.shellPath': shape(),
  'ui.capture': shape({ target: { enum: ['shell', 'page'] }, id }, ['target']),
  'ui.devtools': shape({ target: { enum: ['shell', 'page'] }, id }, ['target'])
}

// These are explicit contracts, never guesses from the human-readable params text.
function schemaFor(name) {
  if (!Object.hasOwn(schemas, name)) throw error('bad_schema', `No core schema for ${name}; provide an explicit inputSchema`)
  return clone(schemas[name])
}

module.exports = { createRegistry, schemaFor, validateSchema }

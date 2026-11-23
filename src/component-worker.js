'use strict'

// Trusted local Node code, deliberately NOT an OS sandbox. Only serializable
// messages cross this boundary; Electron objects and owner credentials never do.
const { AsyncLocalStorage } = require('node:async_hooks')
const invocation = new AsyncLocalStorage()
const pending = new Map()
const commands = new Map()
const listeners = new Map()
const running = new Map()
const registrations = new Set()
let sequence = 0
let dispose
let stopping = false
let identity
let manifest
let capabilities = Object.freeze([])
let activationError
const send = (message) => { if (process.connected) process.send(message) }
const failure = (error) => ({ message: error?.message || String(error), code: error?.code || 'component_error' })
function request(method, params) {
  if (stopping) return Promise.reject(new Error('Component is stopping'))
  const origin = invocation.getStore()
  if (!origin) return Promise.reject(new Error('Component API request has no invocation origin'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ type: 'request', id, method, params, origin })
  })
}
const api = Object.freeze({
  get id() { return identity },
  get manifest() { return manifest },
  get capabilities() { return capabilities },
  hasCapability: (capability) => !stopping && capabilities.includes(capability),
  call: (name, params = {}) => request('call', { name, params }),
  register(definition) {
    if (!definition || typeof definition.run !== 'function') throw new Error('Command requires run')
    const { run, ...metadata } = definition
    if (commands.has(metadata.name)) throw new Error('Duplicate command')
    commands.set(metadata.name, run)
    const registration = request('register', metadata).then(() => {
      let disposed = false
      return () => {
        if (disposed) return Promise.resolve()
        disposed = true
        commands.delete(metadata.name)
        // Host teardown already disposes this owner's registrations before stop.
        if (stopping) return Promise.resolve()
        return request('unregister', { name: metadata.name })
      }
    })
    registrations.add(registration)
    registration.then(() => registrations.delete(registration), (error) => { registrations.delete(registration); activationError = error })
    return registration
  },
  on(event, callback) {
    if (typeof callback !== 'function') throw new Error('Event requires callback')
    const id = ++sequence
    listeners.set(id, { callback, origin: invocation.getStore() })
    const registration = request('on', { event, subscription: id })
    registrations.add(registration)
    registration.then(() => registrations.delete(registration), (error) => { registrations.delete(registration); listeners.delete(id); activationError = error })
    return () => {
      if (!listeners.delete(id) || stopping) return Promise.resolve()
      return request('off', { subscription: id })
    }
  },
  storage: Object.freeze({
    read: (key, options = {}) => request('storage.read', { key, ...options }),
    write: (key, value, options = {}) => request('storage.write', { key, value, ...options }),
    remove: (key, options = {}) => request('storage.remove', { key, ...options }),
  }),
  settings: Object.freeze({
    list: (options = {}) => request('settings.list', options),
    get: (key, options = {}) => request('settings.get', { ...options, key }),
    set: (key, value, options = {}) => request('settings.set', { ...options, key, value }),
    reset: (key, options = {}) => request('settings.reset', { ...options, key }),
  }),
  source: Object.freeze({
    read: (file) => request('source.read', { file }),
    write: (file, content) => request('source.write', { file, content }),
  }),
})
process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'reply') {
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    else item.resolve(message.result)
  } else if (message.type === 'start') {
    try {
      identity = message.id
      manifest = Object.freeze(message.manifest)
      capabilities = Object.freeze(message.capabilities || [])
      await invocation.run({ kind: 'background' }, async () => {
        const backend = require(message.file)
        if (typeof backend.activate !== 'function') throw new Error('Backend must export activate(api)')
        const result = await backend.activate(api)
        dispose = typeof result === 'function' ? result : typeof result?.dispose === 'function' ? () => result.dispose() : backend.dispose
        return result
      })
      await Promise.all([...registrations])
      if (activationError) throw activationError
      send({ type: 'ready' })
    } catch (error) { send({ type: 'failed', error: failure(error) }) }
  } else if (message.type === 'call' && !stopping) {
    const controller = new AbortController()
    running.set(message.id, controller)
    try {
      const run = commands.get(message.name)
      if (!run) throw new Error('Command is no longer registered')
      const result = await invocation.run({ kind: 'command', id: message.id }, () => run(message.params, { signal: controller.signal }))
      if (!controller.signal.aborted) send({ type: 'result', id: message.id, result })
    } catch (error) { send({ type: 'result', id: message.id, error: failure(error) }) }
    finally { running.delete(message.id) }
  } else if (message.type === 'cancel') {
    running.get(message.id)?.abort()
  } else if (message.type === 'event' && !stopping) {
    try {
      const listener = listeners.get(message.subscription)
      if (listener) await invocation.run(listener.origin, () => listener.callback(message.payload))
    }
    catch (error) { send({ type: 'event-error', error: failure(error) }) }
  } else if (message.type === 'stop') {
    stopping = true
    for (const item of pending.values()) item.reject(new Error('Component stopped'))
    pending.clear()
    for (const controller of running.values()) controller.abort()
    listeners.clear()
    commands.clear()
    try { await dispose?.(); send({ type: 'stopped' }) }
    catch (error) { send({ type: 'stopped', error: failure(error) }) }
    // The supervisor owns process-group teardown, including children spawned by
    // the backend. Stay alive until it has received the stopped acknowledgement.
  }
})
process.on('disconnect', () => process.exit(0))

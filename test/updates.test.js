'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createQuit, createUpdates } = require('../src/updates')

function setup({ supported = true, cleanup = async () => {}, quitAndInstall = () => {} } = {}) {
  const log = []
  const updater = Object.assign(new EventEmitter(), { checkForUpdates: async () => { log.push('check') }, quitAndInstall: () => { log.push('quitAndInstall'); quitAndInstall() } })
  const quit = createQuit({ cleanup: async () => { log.push('cleanup'); await cleanup(); log.push('flushed') }, quit: () => log.push('quit') })
  const states = [], notices = []
  let time = 1e9
  const updates = createUpdates({ updater, supported, quit, onChange: (s) => states.push({ ...s }), notify: (v) => notices.push(v), now: () => time })
  return { log, updater, quit, updates, states, notices, advance: (ms) => { time += ms } }
}

test('update state follows the updater events and is absent when unsupported', async () => {
  const t = setup()
  assert.deepEqual(t.updates.state(), { status: 'idle' })
  t.updater.emit('checking-for-update')
  t.updater.emit('update-not-available')
  t.updater.emit('update-available', { version: '1.2.0' })
  t.updater.emit('download-progress', { percent: 41.6 })
  t.updater.emit('download-progress', { percent: 41.9 })
  t.updater.emit('update-downloaded', { version: '1.2.0' })
  assert.deepEqual(t.states, [
    { status: 'checking' }, { status: 'idle' },
    { status: 'downloading', version: '1.2.0', percent: 0 },
    { status: 'downloading', version: '1.2.0', percent: 42 },
    { status: 'ready', version: '1.2.0' }
  ])
  const off = setup({ supported: false })
  off.updater.emit('update-downloaded', { version: '9' })
  assert.equal(off.updates.state(), null)
  assert.deepEqual(off.notices, [])
  await assert.rejects(off.updates.check(), { code: 'bad_params' })
  await assert.rejects(off.updates.install(), { code: 'bad_params' })
})

test('a ready update survives later checks and errors, and notifies once per version', () => {
  const t = setup()
  t.updater.emit('update-downloaded', { version: '1.2.0' })
  for (const event of ['checking-for-update', 'update-not-available']) t.updater.emit(event)
  t.updater.emit('update-available', { version: '1.2.0' })
  t.updater.emit('error', new Error('offline'))
  t.updater.emit('update-downloaded', { version: '1.2.0' })
  assert.deepEqual(t.updates.state(), { status: 'ready', version: '1.2.0' })
  assert.deepEqual(t.notices, ['1.2.0'])
  t.updater.emit('update-available', { version: '1.3.0' })
  assert.deepEqual(t.updates.state(), { status: 'downloading', version: '1.3.0', percent: 0 })
  t.updater.emit('update-downloaded', { version: '1.3.0' })
  assert.deepEqual(t.notices, ['1.2.0', '1.3.0'])
})

test('errors show only when no update is ready', async () => {
  const t = setup()
  t.updater.emit('error', new Error('offline'))
  assert.deepEqual(t.updates.state(), { status: 'error' })
  t.updater.checkForUpdates = async () => { throw new Error('boom') }
  t.updater.emit('checking-for-update')
  await t.updates.check()
  assert.deepEqual(t.updates.state(), { status: 'error' })
})

test('focus checks only when the last check is over an hour old', async () => {
  const t = setup()
  assert.ok(t.updates.checkIfStale())
  await t.updates.checkIfStale()
  assert.equal(t.updates.checkIfStale(), undefined)
  t.advance(t.updates.HOUR - 1)
  assert.equal(t.updates.checkIfStale(), undefined)
  t.advance(2)
  await t.updates.checkIfStale()
  assert.equal(t.log.filter((entry) => entry === 'check').length, 2)
  assert.equal(setup({ supported: false }).updates.checkIfStale(), undefined)
})

test('install is refused until an update is ready', async () => {
  const t = setup()
  await assert.rejects(t.updates.install(), { code: 'bad_params' })
  assert.deepEqual(t.log, [])
})

test('install runs cleanup and flush once, then quitAndInstall, and never the plain quit', async () => {
  let release
  const t = setup({ cleanup: () => new Promise((resolve) => { release = resolve }) })
  t.updater.emit('update-downloaded', { version: '1.2.0' })
  const installing = t.updates.install()
  await Promise.resolve()
  assert.deepEqual(t.log, ['cleanup'])
  const event = { prevented: 0, preventDefault() { this.prevented++ } }
  t.quit.beforeQuit(event)
  t.updates.install()
  await Promise.resolve()
  assert.deepEqual(t.log, ['cleanup'])
  release()
  await installing
  assert.deepEqual(t.log, ['cleanup', 'flushed', 'quitAndInstall'])
  assert.equal(event.prevented, 1)
  const after = { prevented: 0, preventDefault() { this.prevented++ } }
  t.quit.beforeQuit(after)
  assert.equal(after.prevented, 0)
  assert.deepEqual(t.log, ['cleanup', 'flushed', 'quitAndInstall'])
})

test('a quit during install does not quit before quitAndInstall, and a failed hand-off still quits', async () => {
  const t = setup({ quitAndInstall: () => { throw new Error('no squirrel') } })
  t.updater.emit('update-downloaded', { version: '1.2.0' })
  await assert.rejects(t.updates.install(), /no squirrel/)
  assert.deepEqual(t.log, ['cleanup', 'flushed', 'quitAndInstall', 'quit'])
})

test('a plain quit runs cleanup once, prevents only the first before-quit and then lets quit through', async () => {
  const t = setup()
  const first = { prevented: 0, preventDefault() { this.prevented++ } }
  t.quit.beforeQuit(first)
  t.quit.beforeQuit({ preventDefault() {} })
  await t.quit.run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(t.log, ['cleanup', 'flushed', 'quit'])
  assert.equal(first.prevented, 1)
  const second = { prevented: 0, preventDefault() { this.prevented++ } }
  t.quit.beforeQuit(second)
  assert.equal(second.prevented, 0)
})


'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTranscripts } = require('../src/transcripts')
const { createRegistry } = require('../src/commands')
const S = require('../src/state')

function setup(t, enabled = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-transcripts-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = S.load()
  state.settings.transcriptRecovery = enabled
  state.settings.transcriptRetentionDays = 30
  const id = 'c0123456789ab'
  const tab = S.createTab(state, {}, 1, { id, agent: 'Fake', title: 'Conversation', favicon: '' })
  const chat = { id, tabId: tab.id, agent: 'Fake', sessionId: 'remote-session', turns: [{ id: 't1', kind: 'user', text: 'A question' }, { id: 't2', kind: 'assistant', text: 'An answer', thought: 'Internal reasoning is not journaled', done: false }] }
  const make = () => createTranscripts({ dir, state: () => state })
  return { dir, state, tab, chat, make, journal: make() }
}

test('recording is opt-in, writes restricted atomic files, and recovers completed read-only display turns', (t) => {
  const { dir, state, chat, journal, make } = setup(t)
  assert.equal(journal.record(chat), false)
  assert.equal(fs.existsSync(path.join(dir, 'transcripts.json')), false)
  state.settings.transcriptRecovery = true
  assert.equal(journal.record(chat), true)
  const file = path.join(dir, 'transcripts.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  assert.equal(fs.readFileSync(file, 'utf8').includes('Internal reasoning'), false)
  const saved = make().get({ id: chat.id })
  assert.equal(saved.readOnly, true)
  assert.equal(saved.sessionId, 'remote-session')
  assert.equal(saved.turns[1].done, true)
  assert.equal(saved.turns[1].stopReason, 'interrupted')
  assert.equal(saved.turns[1].text, 'An answer')
  saved.turns[0].text = 'Tampered copy'
  assert.equal(journal.get({ id: chat.id }).turns[0].text, 'A question')
})

test('private conversations are never captured and become unavailable if their space becomes private', (t) => {
  const { state, tab, chat, journal } = setup(t, true)
  journal.record(chat)
  state.spaces.find((space) => space.id === tab.spaceId).incognito = true
  assert.equal(journal.record(chat), false)
  assert.deepEqual(journal.list(), [])
  assert.throws(() => journal.get({ id: chat.id }), { code: 'not_found' })
})

test('deletion and clearing cannot resurrect an active transcript on its next stream update or restart', (t) => {
  const { chat, journal, make } = setup(t, true)
  journal.record(chat)
  assert.deepEqual(journal.delete({ id: chat.id }), { deleted: true })
  chat.turns.push({ id: 't3', kind: 'user', text: 'Still talking' })
  assert.equal(journal.record(chat), false)
  const next = make()
  assert.equal(next.record(chat), false)
  assert.deepEqual(next.list(), [])
  assert.deepEqual(next.clear(), { deleted: 0 })
  assert.equal(next.record(chat), false)
})

test('retention prunes persisted old chats and journal size remains bounded per conversation', (t) => {
  const { dir, chat, journal, make } = setup(t, true)
  chat.turns = Array.from({ length: 250 }, (_, index) => ({ id: `t${index}`, kind: 'user', text: `${index}: ${'x'.repeat(10000)}` }))
  journal.record(chat)
  const saved = journal.get({ id: chat.id })
  assert.ok(saved.turns.length < 200)
  assert.equal(saved.turns.at(-1).id, 't249')
  assert.ok(fs.statSync(path.join(dir, 'transcripts.json')).size < 600000)
  const file = path.join(dir, 'transcripts.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  data.records[0].updatedAt = Date.now() - 31 * 86400000
  fs.writeFileSync(file, JSON.stringify(data))
  assert.deepEqual(make().list(), [])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 0)
})

test('registered export/delete commands return real local data and removal is durable', async (t) => {
  const { chat, journal, make } = setup(t, true)
  journal.record(chat)
  const registry = createRegistry()
  journal.register(registry)
  const exported = await registry.call('transcripts.export', { id: chat.id, format: 'text' })
  assert.equal(exported.mime, 'text/plain')
  assert.match(exported.text, /Read-only local recovery/)
  assert.match(exported.text, /A question/)
  const json = await registry.call('transcripts.export', { id: chat.id })
  assert.equal(JSON.parse(json.text).readOnly, true)
  await registry.call('transcripts.delete', { id: chat.id })
  assert.deepEqual(make().list(), [])
})

test('corrupt journal is not silently overwritten and explicit clear recovers it', (t) => {
  const { dir, chat, make } = setup(t, true)
  const file = path.join(dir, 'transcripts.json')
  fs.writeFileSync(file, 'not-json')
  const broken = make()
  assert.throws(() => broken.record(chat), { code: 'transcript_error' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'not-json')
  broken.clear()
  assert.deepEqual(broken.list(), [])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1)
})

test('deleted transcript stays deleted through space removal, journal restart, and archive restore', (t) => {
  const { state, tab, chat, journal, make, dir } = setup(t, true)
  journal.record(chat)
  journal.delete({ id: chat.id })
  S.createSpace(state, { name: 'Destination' })
  S.removeSpace(state, { id: tab.spaceId }, 2)
  assert.ok(state.archive.some((entry) => entry.id === tab.id))
  assert.deepEqual(journal.list(), [])
  const next = make()
  assert.deepEqual(next.list(), [])
  S.restore(state, { id: tab.id }, 3)
  chat.turns.push({ id: 't3', kind: 'user', text: 'Continued after restoring the archived chat' })
  assert.equal(next.record(chat), false)
  assert.deepEqual(next.list(), [])
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'transcripts.json'), 'utf8')).records.length, 0)
  assert.throws(() => next.export({ id: chat.id }), { code: 'not_found' })
})

test('removing a space does not permanently disable an undeleted recoverable conversation', (t) => {
  const { state, tab, chat, journal, make } = setup(t, true)
  journal.record(chat)
  S.createSpace(state, { name: 'Destination' })
  S.removeSpace(state, { id: tab.spaceId }, 2)
  const next = make()
  assert.equal(next.get({ id: chat.id }).turns[0].text, 'A question')
  S.restore(state, { id: tab.id }, 3)
  chat.turns.push({ id: 't3', kind: 'user', text: 'An ordinary restored chat can keep recording' })
  assert.equal(next.record(chat), true)
  assert.equal(next.get({ id: chat.id }).turns.at(-1).text, 'An ordinary restored chat can keep recording')
})

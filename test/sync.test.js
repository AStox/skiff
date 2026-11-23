'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { createSync } = require('../src/sync')
const S = require('../src/state')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-sync-test-'))
  const instances = []
  t.after(() => { instances.forEach((instance) => instance.stop()); fs.rmSync(root, { recursive: true, force: true }) })
  const make = (name, state = initial(), options = {}) => {
    const dir = path.join(root, name)
    const instance = createSync({ dir, state: () => state, ...options })
    instances.push(instance)
    instance.start()
    return { sync: instance, state, dir }
  }
  return { root, make, shared: path.join(root, 'shared') }
}
function initial() {
  return {
    spaces: [{ id: 'home', name: 'Home', color: '#123456', profileId: 'main', sessionPartition: 'persist:main' }],
    profiles: [{ id: 'main', name: 'Default', partition: 'persist:main' }],
    tabs: [], folders: [], agentTabs: [], archive: [], activeSpaceId: 'home', activeTabBySpace: {},
    splitBySpace: {}, settings: { autoArchiveHours: 12, memorySaver: false }
  }
}
function tab(id, title = id) {
  return { id, title, url: `https://example.com/${id}`, spaceId: 'home', sessionPartition: 'persist:main', favorite: false }
}
function pair(a, b, params) {
  a.sync.configure(params); b.sync.configure(params)
  a.sync.createKey()
  b.sync.importKey(a.sync.exportKey())
}
function encryptedRecords(directory) {
  return fs.readdirSync(directory).filter((file) => file.endsWith('.skiff-sync')).map((file) => path.join(directory, file))
}
function decryptEnvelope(envelope, pairingKey) {
  const { version, algorithm, purpose, device, keyId } = envelope
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(pairingKey, 'base64url'), Buffer.from(envelope.nonce, 'base64'))
  decipher.setAAD(Buffer.from(JSON.stringify({ version, algorithm, purpose, device, keyId })))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString())
}

function encryptEnvelope(original, payload, pairingKey) {
  const { version, algorithm, purpose, device, keyId } = original
  const header = { version, algorithm, purpose, device, keyId }
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(pairingKey, 'base64url'), nonce)
  cipher.setAAD(Buffer.from(JSON.stringify(header)))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
  return { ...header, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

test('folder transport encrypts actual portable records, preserves live objects and maps remote profiles locally', async (t) => {
  const f = fixture(t)
  let changed = 0
  const a = f.make('a'), b = f.make('b', initial(), { changed: () => changed++ })
  a.state.profiles.push({ id: 'work', name: 'Work', partition: 'persist:alice-work' })
  a.state.spaces.push({ id: 'work-space', name: 'Work', color: '#abcdef', profileId: 'work', sessionPartition: 'persist:alice-work' })
  a.state.tabs.push({ ...tab('work-tab'), spaceId: 'work-space', sessionPartition: 'persist:alice-work', profileId: 'work' })
  b.state.tabs.push(tab('local'))
  const localTab = b.state.tabs[0]
  pair(a, b, { transport: 'folder', directory: f.shared })
  const { key } = a.sync.exportKey()
  assert.equal(Buffer.from(key, 'base64url').length, 32)
  await a.sync.now(); await b.sync.now(); await a.sync.now()
  assert.equal(b.state.tabs.find((x) => x.id === 'local'), localTab)
  assert.equal(localTab.sessionPartition, 'persist:main')
  const profile = b.state.profiles.find((x) => x.id === 'work')
  assert.match(profile.partition, /^persist:sync-/)
  assert.notEqual(profile.partition, 'persist:alice-work')
  assert.equal(b.state.tabs.find((x) => x.id === 'work-tab').sessionPartition, profile.partition)
  assert.equal(b.state.spaces.find((x) => x.id === 'work-space').sessionPartition, profile.partition)
  assert.equal(changed, 1)
  assert.equal(a.state.tabs.some((x) => x.id === 'local'), true)
  for (const file of encryptedRecords(f.shared)) {
    const bytes = fs.readFileSync(file, 'utf8')
    assert.equal(bytes.includes('example.com'), false)
    assert.equal(bytes.includes('alice-work'), false)
    assert.equal(bytes.includes(key), false)
    const records = decryptEnvelope(JSON.parse(bytes), key).records
    assert.equal(records['profiles/work'].value.partition, undefined)
    assert.equal(records['tabs/work-tab'].value.url, 'https://example.com/work-tab')
  }
  const config = fs.readFileSync(path.join(a.dir, 'sync/config.json'), 'utf8')
  const journal = fs.readFileSync(path.join(a.dir, 'sync/journal.enc.json'), 'utf8')
  assert.equal(config.includes(key), false)
  assert.equal(journal.includes('example.com'), false)
  assert.equal(a.sync.snapshot().busy, false)
})

test('privacy projection excludes private, agent, peek, transcript, credentials, local paths and executable settings', async (t) => {
  const f = fixture(t), a = f.make('a')
  a.state.spaces.push({ id: 'private', name: 'SECRET_PRIVATE', incognito: true, sessionPartition: 'incognito-1' })
  a.state.tabs.push(tab('normal'), { ...tab('private-tab'), spaceId: 'private' }, { ...tab('agent-tab'), agent: 'SECRET_AGENT' }, { ...tab('peek-tab'), userPeek: true }, { ...tab('chat-tab'), url: 'skiff://chat/c123', chat: { transcript: 'SECRET_TRANSCRIPT' } }, { ...tab('credential'), url: 'https://user:SECRET_PASSWORD@example.com/' }, { ...tab('token'), url: 'https://example.com/?access_token=SECRET_TOKEN' }, { ...tab('file'), url: 'file:///home/SECRET_PATH' }, { ...tab('loopback'), url: 'http://127.0.0.1/private' })
  a.state.tabs[0].runtime = { secret: 'SECRET_RUNTIME' }
  a.state.tabs[0].desk = { local: 'SECRET_DESK' }
  a.state.agentTabs.push(tab('agent-only'))
  a.state.settings.ai = { command: '/home/SECRET_CODE' }
  a.state.settings.downloadDirectory = '/home/SECRET_DOWNLOAD'
  a.state.settings.shortcuts = { 'Ctrl+X': { method: 'exec', params: 'SECRET_EXECUTABLE' } }
  a.state.passwords = ['SECRET_PASSWORD_STORE']
  a.state.cookies = ['SECRET_COOKIES']
  a.sync.configure({ transport: 'folder', directory: f.shared }); a.sync.createKey()
  await a.sync.now()
  const payload = decryptEnvelope(JSON.parse(fs.readFileSync(encryptedRecords(f.shared)[0])), a.sync.exportKey().key)
  const text = JSON.stringify(payload)
  assert.equal(text.includes('SECRET_'), false)
  assert.deepEqual(Object.keys(payload.records).filter((key) => key.startsWith('tabs/')), ['tabs/normal'])
  assert.equal(payload.records['preferences/autoArchiveHours'].value.value, 12)
  assert.equal(a.state.tabs.some((x) => x.id === 'private-tab'), true)
})

test('authenticated envelope metadata, nonce, ciphertext and tag tampering leave state and journal untouched', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.state.tabs.push(tab('shared'))
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  const file = encryptedRecords(f.shared).find((file) => JSON.parse(fs.readFileSync(file)).device === JSON.parse(fs.readFileSync(path.join(a.dir, 'sync/config.json'))).device)
  const original = JSON.parse(fs.readFileSync(file))
  const before = JSON.stringify(b.state)
  const journal = fs.readFileSync(path.join(b.dir, 'sync/journal.enc.json'), 'utf8')
  for (const field of ['version', 'purpose', 'device', 'keyId', 'nonce', 'ciphertext', 'tag']) {
    const corrupt = { ...original }
    corrupt[field] = field === 'version' ? 2 : field === 'device' ? '0'.repeat(32) : field === 'purpose' ? 'journal' : field === 'keyId' ? '0'.repeat(64) : Buffer.from(`tampered ${field}`).toString('base64')
    fs.writeFileSync(file, JSON.stringify(corrupt))
    await assert.rejects(b.sync.now(), /authentication failed/)
    assert.equal(JSON.stringify(b.state), before)
    assert.equal(fs.readFileSync(path.join(b.dir, 'sync/journal.enc.json'), 'utf8'), journal)
  }
  fs.writeFileSync(file, JSON.stringify(original))
  await b.sync.now()
})

test('wrong pairing key and malformed authenticated data cannot change local browser state', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.sync.configure({ transport: 'folder', directory: f.shared }); a.sync.createKey(); await a.sync.now()
  b.sync.configure({ transport: 'folder', directory: f.shared }); b.sync.createKey()
  const before = JSON.stringify(b.state)
  await assert.rejects(b.sync.now(), /authentication failed/)
  assert.equal(JSON.stringify(b.state), before)
  assert.throws(() => a.sync.importKey(b.sync.exportKey()), /does not match/)
  assert.equal(fs.existsSync(path.join(b.dir, 'sync/journal.enc.json')), false)
  b.sync.importKey(a.sync.exportKey())
  await b.sync.now()
  assert.equal(b.sync.snapshot().error, null)
})

test('offline deletions survive restart and defeat stale concurrent edits without resurrection', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.state.tabs.push(tab('deleted'), tab('edited'))
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now(); await a.sync.now()
  const { key } = b.sync.exportKey()
  b.state.tabs = b.state.tabs.filter((x) => x.id !== 'deleted')
  b.sync.stop()
  const restarted = f.make('b', b.state)
  assert.equal(restarted.sync.snapshot().locked, true)
  await assert.rejects(restarted.sync.now(), /Unlock/)
  restarted.sync.unlock({ key })
  a.state.tabs.find((x) => x.id === 'deleted').title = 'offline edit on stale device'
  a.state.tabs.find((x) => x.id === 'edited').title = 'edit A'
  restarted.state.tabs.find((x) => x.id === 'edited').title = 'edit B'
  await a.sync.now(); await restarted.sync.now(); await a.sync.now(); await restarted.sync.now()
  assert.equal(a.state.tabs.some((x) => x.id === 'deleted'), false)
  assert.equal(restarted.state.tabs.some((x) => x.id === 'deleted'), false)
  assert.equal(a.state.tabs.find((x) => x.id === 'edited').title, restarted.state.tabs.find((x) => x.id === 'edited').title)
  const records = decryptEnvelope(JSON.parse(fs.readFileSync(encryptedRecords(f.shared)[0])), key).records
  assert.equal(records['tabs/deleted'].deleted, true)
  assert.ok(a.sync.snapshot().conflicts.some((x) => x.record === 'tabs/deleted' && x.deleted))
})

test('folder writes have fresh nonces and independent device files, with fresh key unlock each run', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  pair(a, b, { transport: 'folder', directory: f.shared })
  const key = a.sync.exportKey().key
  await a.sync.now()
  const first = JSON.parse(fs.readFileSync(encryptedRecords(f.shared)[0]))
  await a.sync.now()
  const second = JSON.parse(fs.readFileSync(encryptedRecords(f.shared)[0]))
  assert.notEqual(first.nonce, second.nonce)
  await b.sync.now()
  assert.equal(encryptedRecords(f.shared).length, 2)
  a.sync.stop()
  const restarted = f.make('a', a.state)
  assert.equal(restarted.sync.snapshot().locked, true)
  assert.equal(restarted.sync.snapshot().requiresUnlock, true)
  restarted.sync.unlock({ key })
  assert.equal(restarted.sync.snapshot().locked, false)
  restarted.sync.disable()
  await assert.rejects(restarted.sync.now(), /Configure and enable/)
  assert.equal(encryptedRecords(f.shared).length, 2)
})

function storage() {
  const wrappingKey = crypto.randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keyring',
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce)
      return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(-16))
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString()
    }
  }
}

test('safeStorage persists wrapped secrets but basic_text backend always requires explicit unlock', async (t) => {
  const f = fixture(t), safeStorage = storage()
  const a = f.make('a', initial(), { safeStorage })
  a.sync.configure({ transport: 'webdav', endpoint: 'https://dav.example.com/folder/', username: 'test-user', password: 'secret-password' })
  a.sync.createKey()
  const key = a.sync.exportKey().key
  const bytes = fs.readFileSync(path.join(a.dir, 'sync/config.json'), 'utf8')
  assert.equal(bytes.includes(key), false)
  assert.equal(bytes.includes('secret-password'), false)
  assert.equal(bytes.includes('test-user'), false)
  a.sync.stop()
  const restarted = f.make('a', a.state, { safeStorage })
  assert.equal(restarted.sync.snapshot().locked, false)
  assert.equal(restarted.sync.snapshot().credentialsRequired, false)
  assert.equal(restarted.sync.exportKey().key, key)
  const basic = f.make('basic', initial(), { safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' } })
  basic.sync.createKey()
  assert.equal(basic.sync.snapshot().requiresUnlock, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(basic.dir, 'sync/config.json'))).sealedKey, undefined)
})

async function webdav(t) {
  let body = null, revision = 0, barrier = false, held = [], conflicts = 0, mode = 'normal'
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, headers: req.headers, url: req.url })
    if (mode === 'fail') { res.writeHead(503).end(); return }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/steal' }).end(); return }
    if (req.method === 'GET') {
      const captured = body, etag = `"${revision}"`
      const respond = () => { res.writeHead(captured ? 200 : 404, captured && mode !== 'no-etag' ? { ETag: mode === 'weak-etag' ? `W/${etag}` : etag } : {}); res.end(captured || '') }
      if (barrier) { held.push(respond); if (held.length === 2) { barrier = false; held.splice(0).forEach((release) => release()) } }
      else respond()
    } else if (req.method === 'PUT') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        if (mode === 'conflict' || (body ? req.headers['if-match'] !== `"${revision}"` : req.headers['if-none-match'] !== '*')) {
          conflicts++; res.writeHead(412).end(); return
        }
        body = Buffer.concat(chunks).toString(); revision++
        if (mode === 'drop-response') { res.destroy(); return }
        res.writeHead(201, { ETag: `"${revision}"` }).end()
      })
    } else res.writeHead(405).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  return { endpoint: `http://127.0.0.1:${server.address().port}/dav/`, requests, collide: () => { barrier = true }, mode: (value) => { mode = value }, conflicts: () => conflicts, body: () => body, replace: (value) => { body = value; revision++ } }
}

test('real HTTP WebDAV conditional PUT retries concurrent writers and converges edits and deletions', async (t) => {
  const f = fixture(t), dav = await webdav(t), a = f.make('a'), b = f.make('b')
  a.state.tabs.push(tab('shared'), tab('remove'))
  pair(a, b, { transport: 'webdav', endpoint: dav.endpoint, username: 'test', password: 'synthetic' })
  await a.sync.now(); await b.sync.now(); await a.sync.now()
  a.state.tabs.find((x) => x.id === 'shared').title = 'A concurrent edit'
  b.state.tabs.find((x) => x.id === 'shared').title = 'B concurrent edit'
  b.state.tabs = b.state.tabs.filter((x) => x.id !== 'remove')
  a.state.tabs.find((x) => x.id === 'remove').title = 'edit versus delete'
  dav.collide()
  await Promise.all([a.sync.now(), b.sync.now()])
  await a.sync.now(); await b.sync.now()
  assert.ok(dav.conflicts() >= 1)
  assert.equal(a.state.tabs.find((x) => x.id === 'shared').title, b.state.tabs.find((x) => x.id === 'shared').title)
  assert.equal(a.state.tabs.some((x) => x.id === 'remove'), false)
  assert.equal(b.state.tabs.some((x) => x.id === 'remove'), false)
  assert.ok(dav.requests.some((r) => r.headers['if-none-match'] === '*'))
  assert.ok(dav.requests.some((r) => r.headers['if-match']))
  assert.ok(dav.requests.every((r) => r.url === '/dav/skiff-sync-v1.json'))
  assert.equal(dav.body().includes('concurrent edit'), false)
  assert.equal(dav.body().includes('synthetic'), false)
})

test('WebDAV failures, redirects, tampering and bounded conflict exhaustion preserve local state', async (t) => {
  const f = fixture(t), dav = await webdav(t), a = f.make('a')
  a.sync.configure({ transport: 'webdav', endpoint: dav.endpoint }); a.sync.createKey()
  await a.sync.now()
  a.state.tabs.push(tab('pending'))
  const before = JSON.stringify(a.state)
  for (const mode of ['fail', 'redirect', 'conflict']) {
    dav.mode(mode)
    const requests = dav.requests.length
    await assert.rejects(a.sync.now(), /failed|changed repeatedly/)
    assert.equal(JSON.stringify(a.state), before)
    if (mode === 'conflict') assert.equal(dav.requests.length - requests, 8)
  }
  dav.mode('normal')
  const original = dav.body(), corrupt = JSON.parse(original)
  corrupt.tag = crypto.randomBytes(16).toString('base64'); dav.replace(JSON.stringify(corrupt))
  await assert.rejects(a.sync.now(), /authentication failed/)
  assert.equal(JSON.stringify(a.state), before)
  dav.replace(original)
  await a.sync.now()
  assert.equal(a.state.tabs.some((x) => x.id === 'pending'), true)
})

test('transport configuration rejects insecure remote HTTP and URL credentials without any request', (t) => {
  const f = fixture(t), a = f.make('a')
  for (const endpoint of ['http://dav.example.com/', 'https://user:pass@example.com/', 'https://example.com/?token=secret', 'file:///tmp/dav']) assert.throws(() => a.sync.configure({ transport: 'webdav', endpoint }), /HTTPS|credentials/)
  assert.throws(() => a.sync.configure({ transport: 'folder', directory: 'relative' }), /absolute/)
  assert.equal(a.sync.snapshot().enabled, false)
})

test('command registration exposes complete lifecycle with schemas and never marks pairing keys as agent tools', (t) => {
  const f = fixture(t), a = f.make('a'), definitions = new Map()
  const dispose = a.sync.register({ register(owner, definition) { assert.equal(owner, 'stock.sync'); definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } })
  assert.deepEqual([...definitions.keys()].sort(), ['sync.configure', 'sync.disable', 'sync.key.create', 'sync.key.export', 'sync.key.import', 'sync.now', 'sync.status', 'sync.unlock'])
  for (const definition of definitions.values()) { assert.equal(definition.tool, false); assert.equal(definition.inputSchema.additionalProperties, false) }
  definitions.get('sync.key.create').run()
  assert.equal(definitions.get('sync.key.export').run().key.length, 43)
  dispose()
  assert.equal(definitions.size, 0)
})

test('authenticated but malformed record shapes are rejected before browser mutation', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.state.tabs.push(tab('shared'))
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now()
  const file = encryptedRecords(f.shared)[0], original = JSON.parse(fs.readFileSync(file))
  const key = a.sync.exportKey().key
  const before = JSON.stringify(b.state)
  for (const mutate of [
    (payload) => { payload.records['tabs/shared'].clock = -1 },
    (payload) => { payload.records['tabs/shared'].value.cookies = 'not portable' },
    (payload) => { payload.records['tabs/shared'].value.id = 'other' },
    (payload) => { delete payload.records['tabs/shared'].value.spaceId },
    (payload) => { payload.records['tabs/shared'].value.url = 'file:///home/private' },
    (payload) => { payload.records['profiles/main'].value.id = '__proto__' }
  ]) {
    const payload = decryptEnvelope(original, key)
    mutate(payload)
    fs.writeFileSync(file, JSON.stringify(encryptEnvelope(original, payload, key)))
    await assert.rejects(b.sync.now(), /record/)
    assert.equal(JSON.stringify(b.state), before)
  }
})

test('missing or weak ETags fail explicitly and never issue an unsafe PUT', async (t) => {
  const f = fixture(t), dav = await webdav(t), a = f.make('a')
  a.sync.configure({ transport: 'webdav', endpoint: dav.endpoint }); a.sync.createKey()
  await a.sync.now()
  const before = JSON.stringify(a.state)
  for (const mode of ['no-etag', 'weak-etag']) {
    dav.mode(mode)
    const count = dav.requests.length
    await assert.rejects(a.sync.now(), /strong ETags/)
    assert.equal(dav.requests.length - count, 1)
    assert.equal(dav.requests.at(-1).method, 'GET')
    assert.equal(JSON.stringify(a.state), before)
  }
})

test('changing a previously synced tab to a credential URL removes its remote record without closing the local tab', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.state.tabs.push(tab('shared'))
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  const localTab = a.state.tabs[0]
  localTab.url = 'https://example.com/?access_token=local-only'
  await a.sync.now(); await b.sync.now()
  assert.equal(a.state.tabs[0], localTab)
  assert.equal(localTab.url, 'https://example.com/?access_token=local-only')
  assert.equal(b.state.tabs.some((item) => item.id === 'shared'), false)
})

test('oversized encrypted files and symlinked records are rejected before parsing or state changes', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now()
  const file = encryptedRecords(f.shared)[0], original = fs.readFileSync(file)
  const before = JSON.stringify(b.state)
  fs.truncateSync(file, 16 * 1024 * 1024 + 1)
  await assert.rejects(b.sync.now(), /size limit/)
  assert.equal(JSON.stringify(b.state), before)
  const other = path.join(f.root, 'outside-record')
  fs.writeFileSync(other, original)
  fs.unlinkSync(file)
  fs.symlinkSync(other, file)
  await assert.rejects(b.sync.now(), /regular files/)
  assert.equal(JSON.stringify(b.state), before)
})

test('folder merges rebuild canonical legacy labels and collapse paths without stale renamed keys', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.state.folders.push(
    { id: 'docs', name: 'Docs', spaceId: 'home', parentId: null, collapsed: false },
    { id: 'specs', name: 'Specs', spaceId: 'home', parentId: 'docs', collapsed: true }
  )
  a.state.tabs.push({ ...tab('nested'), folderId: 'specs', pinned: true })
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  assert.equal(b.state.tabs.find((item) => item.id === 'nested').folder, 'Docs / Specs')
  assert.deepEqual(b.state.collapsed, { 'home/Docs / Specs': true })
  a.state.folders.find((item) => item.id === 'docs').name = 'Guides'
  await a.sync.now(); await b.sync.now()
  assert.equal(b.state.tabs.find((item) => item.id === 'nested').folder, 'Guides / Specs')
  assert.deepEqual(b.state.collapsed, { 'home/Guides / Specs': true })
  a.state.folders.find((item) => item.id === 'specs').collapsed = false
  await a.sync.now(); await b.sync.now()
  assert.deepEqual(b.state.collapsed, {})
})

test('accepted WebDAV PUT with a lost response reserves versions across restart and subsequent edits', async (t) => {
  const f = fixture(t), dav = await webdav(t), a = f.make('a'), b = f.make('b')
  a.state.tabs.push(tab('edited', 'original'))
  pair(a, b, { transport: 'webdav', endpoint: dav.endpoint })
  const key = a.sync.exportKey().key
  await a.sync.now(); await b.sync.now()
  a.state.tabs[0].title = 'accepted but response lost'
  dav.mode('drop-response')
  await assert.rejects(a.sync.now(), /Sync failed/)
  assert.equal(a.state.tabs[0].title, 'accepted but response lost')
  assert.equal(decryptEnvelope(JSON.parse(dav.body()), key).records['tabs/edited'].value.title, 'accepted but response lost')
  a.sync.stop()
  const restarted = f.make('a', a.state)
  restarted.sync.unlock({ key })
  restarted.state.tabs[0].title = 'new edit after restart'
  dav.mode('normal')
  await restarted.sync.now(); await b.sync.now()
  assert.equal(b.state.tabs.find((item) => item.id === 'edited').title, 'new edit after restart')
  assert.equal(restarted.sync.snapshot().error, null)
})

test('folder publication followed by a local journal failure never reuses the published version', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.state.tabs.push(tab('edited', 'original'))
  pair(a, b, { transport: 'folder', directory: f.shared })
  const key = a.sync.exportKey().key
  await a.sync.now(); await b.sync.now()
  a.state.tabs[0].title = 'published before disk failure'
  const rename = fs.renameSync
  let journalWrites = 0
  fs.renameSync = function (from, to) {
    if (to === path.join(a.dir, 'sync/journal.enc.json') && ++journalWrites === 2) throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' })
    return rename.call(this, from, to)
  }
  try { await assert.rejects(a.sync.now(), /Sync failed/) } finally { fs.renameSync = rename }
  assert.equal(journalWrites, 2)
  a.sync.stop()
  const restarted = f.make('a', a.state)
  restarted.sync.unlock({ key })
  restarted.state.tabs[0].title = 'new edit after disk recovery'
  await restarted.sync.now(); await b.sync.now()
  assert.equal(b.state.tabs.find((item) => item.id === 'edited').title, 'new edit after disk recovery')
})

test('WebDAV credentials never follow an origin change or a folder transport interlude', async (t) => {
  const f = fixture(t), first = await webdav(t), second = await webdav(t), safeStorage = storage()
  const a = f.make('a', initial(), { safeStorage })
  a.sync.configure({ transport: 'webdav', endpoint: first.endpoint, username: 'origin-a', password: 'only-for-a' })
  a.sync.createKey()
  await a.sync.now()
  assert.ok(first.requests.every((request) => request.headers.authorization === `Basic ${Buffer.from('origin-a:only-for-a').toString('base64')}`))
  a.sync.configure({ transport: 'webdav', endpoint: second.endpoint })
  let config = JSON.parse(fs.readFileSync(path.join(a.dir, 'sync/config.json')))
  assert.equal(config.hasCredentials, false)
  assert.equal(config.sealedCredentials, undefined)
  a.sync.stop()
  const restarted = f.make('a', a.state, { safeStorage })
  await restarted.sync.now()
  assert.ok(second.requests.every((request) => request.headers.authorization === undefined))
  restarted.sync.configure({ transport: 'webdav', endpoint: first.endpoint, username: 'again', password: 'private' })
  restarted.sync.configure({ transport: 'folder', directory: f.shared })
  config = JSON.parse(fs.readFileSync(path.join(a.dir, 'sync/config.json')))
  assert.equal(config.hasCredentials, false)
  assert.equal(config.sealedCredentials, undefined)
  restarted.sync.configure({ transport: 'webdav', endpoint: first.endpoint })
  const count = first.requests.length
  await restarted.sync.now()
  assert.ok(first.requests.slice(count).every((request) => request.headers.authorization === undefined))
})

test('concurrent folder and trail cycles repair identically despite opposite local array order', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  a.state.folders.push(
    { id: 'a', name: 'A', spaceId: 'home', parentId: null, collapsed: false },
    { id: 'b', name: 'B', spaceId: 'home', parentId: null, collapsed: false }
  )
  a.state.tabs.push(tab('ta'), tab('tb'))
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now(); await a.sync.now()
  b.state.folders.reverse(); b.state.tabs.reverse()
  a.state.folders.find((item) => item.id === 'a').parentId = 'b'
  b.state.folders.find((item) => item.id === 'b').parentId = 'a'
  a.state.tabs.find((item) => item.id === 'ta').parentId = 'tb'
  b.state.tabs.find((item) => item.id === 'tb').parentId = 'ta'
  await a.sync.now(); await b.sync.now(); await a.sync.now()
  const edges = (state, kind) => state[kind].map((item) => [item.id, item.parentId || null]).sort()
  assert.deepEqual(edges(a.state, 'folders'), [['a', null], ['b', 'a']])
  assert.deepEqual(edges(a.state, 'folders'), edges(b.state, 'folders'))
  assert.deepEqual(edges(a.state, 'tabs'), [['ta', null], ['tb', 'ta']])
  assert.deepEqual(edges(a.state, 'tabs'), edges(b.state, 'tabs'))
  await b.sync.now(); await a.sync.now()
  assert.deepEqual(edges(a.state, 'folders'), edges(b.state, 'folders'))
  assert.deepEqual(edges(a.state, 'tabs'), edges(b.state, 'tabs'))
})

test('credential fragments use decoded sensitive parameter names and never reach portable records', async (t) => {
  const f = fixture(t), a = f.make('a'), b = f.make('b')
  const fragments = ['code=SECRET', 'api_key=SECRET', 'access%5Ftoken=SECRET', '?refresh_token=SECRET', '/callback?id_token=SECRET', 'authorization=SECRET', 'password=SECRET']
  a.state.tabs.push(tab('public'), ...fragments.map((fragment, index) => ({ ...tab(`secret${index}`), url: `https://example.com/#${fragment}` })))
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  assert.deepEqual(b.state.tabs.map((item) => item.id), ['public'])
  const key = a.sync.exportKey().key
  for (const file of encryptedRecords(f.shared)) {
    const payload = decryptEnvelope(JSON.parse(fs.readFileSync(file)), key)
    assert.equal(JSON.stringify(payload).includes('SECRET'), false)
  }
  assert.equal(a.state.tabs.length, fragments.length + 1)
})

test('real close and restore sync as archive updates preserving tab ID and each device profile', async (t) => {
  const f = fixture(t), a = f.make('a', S.load()), b = f.make('b', S.load())
  const profile = S.createProfile(a.state, { name: 'Work' })
  S.assignProfile(a.state, { spaceId: a.state.activeSpaceId, profileId: profile.id })
  const opened = S.createTab(a.state, { url: 'https://example.com/restorable' }, 100)
  const id = opened.id, localPartition = opened.sessionPartition
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  const remotePartition = b.state.tabs.find((item) => item.id === id).sessionPartition
  assert.notEqual(remotePartition, localPartition)
  S.closeTab(a.state, { id }, 200)
  await a.sync.now(); await b.sync.now()
  assert.equal(a.state.tabs.some((item) => item.id === id), false)
  assert.equal(b.state.tabs.some((item) => item.id === id), false)
  assert.equal(a.state.archive.find((item) => item.id === id).sessionPartition, localPartition)
  assert.equal(b.state.archive.find((item) => item.id === id).sessionPartition, remotePartition)
  const restored = S.restore(a.state, { id }, 300)
  assert.equal(restored.id, id)
  await a.sync.now(); await b.sync.now()
  await a.sync.now(); await b.sync.now()
  assert.equal(a.state.tabs.find((item) => item.id === id).sessionPartition, localPartition)
  assert.equal(b.state.tabs.find((item) => item.id === id).sessionPartition, remotePartition)
  assert.equal(a.state.archive.some((item) => item.id === id), false)
  assert.equal(b.state.archive.some((item) => item.id === id), false)
  for (const file of encryptedRecords(f.shared)) {
    const record = decryptEnvelope(JSON.parse(fs.readFileSync(file)), a.sync.exportKey().key).records[`tabs/${id}`]
    assert.equal(record.deleted, false)
    assert.equal(record.value.archived, false)
  }
})

test('removing a space syncs its archived tabs and real restore uses a surviving space', async (t) => {
  const f = fixture(t), a = f.make('a', S.load()), b = f.make('b', S.load())
  const work = S.createSpace(a.state, { name: 'Temporary' })
  const profile = S.createProfile(a.state, { name: 'Temporary profile' })
  S.assignProfile(a.state, { spaceId: work.id, profileId: profile.id })
  const opened = S.createTab(a.state, { spaceId: work.id, url: 'https://example.com/removed-space' }, 100)
  const id = opened.id
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  const partition = b.state.tabs.find((item) => item.id === id).sessionPartition
  S.removeSpace(a.state, { id: work.id }, 200)
  await a.sync.now(); await b.sync.now()
  assert.equal(b.state.spaces.some((item) => item.id === work.id), false)
  assert.equal(b.state.archive.find((item) => item.id === id).spaceId, work.id)
  assert.equal(b.state.archive.find((item) => item.id === id).sessionPartition, partition)
  const restored = S.restore(b.state, { id }, 300)
  assert.notEqual(restored.spaceId, work.id)
  assert.equal(restored.sessionPartition, partition)
  await b.sync.now(); await a.sync.now()
  await b.sync.now(); await a.sync.now()
  assert.equal(a.state.tabs.find((item) => item.id === id).spaceId, restored.spaceId)
  assert.equal(a.state.tabs.find((item) => item.id === id).sessionPartition, opened.sessionPartition)
  assert.equal(a.state.archive.some((item) => item.id === id), false)
})

test('offline permanent archive deletion defeats stale restore without resurrecting either collection', async (t) => {
  const f = fixture(t), a = f.make('a', S.load()), b = f.make('b', S.load())
  const opened = S.createTab(a.state, { url: 'https://example.com/permanent' }, 100)
  const id = opened.id
  S.closeTab(a.state, { id }, 200)
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now(); await a.sync.now()
  S.removeArchived(a.state, { id })
  S.restore(b.state, { id }, 300)
  await b.sync.now(); await a.sync.now(); await b.sync.now()
  for (const instance of [a, b]) {
    assert.equal(instance.state.tabs.some((item) => item.id === id), false)
    assert.equal(instance.state.archive.some((item) => item.id === id), false)
  }
  const payload = decryptEnvelope(JSON.parse(fs.readFileSync(encryptedRecords(f.shared)[0])), a.sync.exportKey().key)
  assert.equal(payload.records[`tabs/${id}`].deleted, true)
})

test('archive clear syncs permanent deletions while archive privacy exclusions match live tabs', async (t) => {
  const f = fixture(t), a = f.make('a', S.load()), b = f.make('b', S.load())
  const opened = S.createTab(a.state, { url: 'https://example.com/archive-clear' }, 100)
  S.closeTab(a.state, { id: opened.id }, 200)
  const excluded = [
    { ...tab('private-archive'), private: true },
    { ...tab('agent-archive'), agent: 'local' },
    { ...tab('peek-archive'), userPeek: true },
    { ...tab('chat-archive'), chat: { sessionId: 'local' } },
    { ...tab('credential-archive'), url: 'https://example.com/#code=SECRET' },
    { ...tab('incognito-archive'), sessionPartition: 'incognito-local' }
  ]
  a.state.archive.push(...excluded)
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  assert.deepEqual(b.state.archive.map((item) => item.id), [opened.id])
  assert.equal(a.state.archive.length, excluded.length + 1)
  S.clearArchive(a.state)
  await a.sync.now(); await b.sync.now()
  assert.equal(b.state.archive.length, 0)
  assert.equal(b.state.tabs.some((item) => item.id === opened.id), false)
})

test('authenticated remote archive moves and tombstones cannot overwrite local-only ID collisions in either collection', async (t) => {
  const f = fixture(t), a = f.make('a', S.load()), b = f.make('b', S.load())
  const opened = S.createTab(a.state, { url: 'https://example.com/remote' }, 100)
  const id = opened.id
  S.closeTab(a.state, { id }, 200)
  const privateTab = { ...tab(id), spaceId: b.state.activeSpaceId, private: true, title: 'Local private tab' }
  b.state.tabs.push(privateTab)
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  assert.equal(b.state.tabs.find((item) => item.id === id), privateTab)
  assert.equal(b.state.archive.some((item) => item.id === id), false)
  b.state.tabs.splice(b.state.tabs.indexOf(privateTab), 1)
  b.state.archive.push(privateTab)
  S.restore(a.state, { id }, 300)
  await a.sync.now(); await b.sync.now()
  assert.equal(b.state.archive.find((item) => item.id === id), privateTab)
  assert.equal(b.state.tabs.some((item) => item.id === id), false)
  S.closeTab(a.state, { id }, 400)
  S.removeArchived(a.state, { id })
  await a.sync.now(); await b.sync.now()
  assert.equal(b.state.archive.find((item) => item.id === id), privateTab)
  assert.equal(privateTab.title, 'Local private tab')
})

test('automatic archive remains restorable with the original ID after repeated two-device sync', async (t) => {
  const f = fixture(t), a = f.make('a', S.load()), b = f.make('b', S.load())
  const idle = S.createTab(a.state, { url: 'https://example.com/idle' }, 0)
  S.createTab(a.state, { url: 'https://example.com/active' }, 1)
  pair(a, b, { transport: 'folder', directory: f.shared })
  await a.sync.now(); await b.sync.now()
  const swept = S.sweep(a.state, {}, 13 * 3600e3)
  assert.ok(swept.archived.includes(idle.id))
  await a.sync.now(); await b.sync.now()
  assert.ok(b.state.archive.some((item) => item.id === idle.id))
  S.restore(b.state, { id: idle.id }, 14 * 3600e3)
  await b.sync.now(); await a.sync.now(); await b.sync.now()
  assert.ok(a.state.tabs.some((item) => item.id === idle.id))
  assert.ok(b.state.tabs.some((item) => item.id === idle.id))
  assert.equal(a.state.archive.some((item) => item.id === idle.id), false)
  assert.equal(b.state.archive.some((item) => item.id === idle.id), false)
})

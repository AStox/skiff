'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { discoverArc, readArcSecrets, readArcIcons, createVault } = require('../src/migration')
const { fillArcIcons } = require('../src/importer')
let DatabaseSync
try { ({ DatabaseSync } = require('node:sqlite')) } catch {}
const sqlite = { skip: !DatabaseSync && 'Requires Node 22.13+ with node:sqlite' }
const partition = `persist:arc-${'a'.repeat(24)}`
const otherPartition = `persist:arc-${'b'.repeat(24)}`
const syntheticKey = () => crypto.pbkdf2Sync('synthetic-only-key', 'saltysalt', 1003, 16, 'sha1')
const dependencies = { platform: 'darwin', DatabaseSync, readKey: async () => syntheticKey() }

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-migration-'))
  const root = path.join(home, 'Library', 'Application Support', 'Arc')
  const userData = path.join(root, 'User Data')
  const profilePath = path.join(userData, 'Default')
  fs.mkdirSync(profilePath, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return { home, root, userData, profilePath }
}

function encrypt(value) {
  const cipher = crypto.createCipheriv('aes-128-cbc', syntheticKey(), Buffer.alloc(16, 32))
  return Buffer.concat([Buffer.from('v10'), cipher.update(value), cipher.final()])
}

function passwordDB(file, records) {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE logins (origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, scheme INTEGER)')
  const insert = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, ?, ?)')
  for (const row of records) insert.run(row.origin || 'https://example.test/login', row.realm || 'https://example.test/', row.username || 'alice', row.encrypted || encrypt(row.password || 'synthetic-password'), row.blocked || 0, row.scheme || 0)
  db.close()
}

function cookieDB(file, rows, version = 24, wal = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, is_persistent INTEGER, top_frame_site_key TEXT, source_scheme INTEGER, source_port INTEGER, is_same_party INTEGER)`)
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version))
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const row of rows) {
    const host = row.host || 'example.test'
    const plaintext = Buffer.from(row.secret || 'synthetic-cookie')
    const encrypted = row.encrypted ?? encrypt(version >= 24 ? Buffer.concat([crypto.createHash('sha256').update(row.digestHost || host).digest(), plaintext]) : plaintext)
    insert.run(host, row.name || 'sid', row.value || '', encrypted, row.path || '/', row.expires ?? 0n, row.secure ?? 1, row.httpOnly ?? 1, row.sameSite ?? 1, row.persistent ?? 0, row.persistent ?? 0, row.partition || '', row.sourceScheme ?? 2, -1, row.sameParty || 0)
  }
  if (!wal) db.close()
  return db
}

function storage() {
  const key = crypto.randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString(value) {
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8')
    }
  }
}

test('profile discovery reads metadata only and excludes traversal and symlink profiles', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.userData, 'Profile 1'))
  fs.mkdirSync(path.join(f.userData, 'named-profile'))
  fs.mkdirSync(path.join(f.userData, 'Guest Profile'))
  fs.mkdirSync(path.join(f.userData, 'arc-system'))
  fs.symlinkSync(f.profilePath, path.join(f.userData, 'Profile 2'))
  fs.writeFileSync(path.join(f.userData, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'named-profile': { name: 'Work' }, 'arc-system': { name: '__ARC_SYSTEM_PROFILE' }, '../outside': {}, 'Profile 2': {} } } }))
  const reads = []
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => { reads.push(String(file)); return read(file, ...args) })
  const found = discoverArc(f.home)
  assert.equal(found.root, f.root)
  assert.deepEqual(found.profiles.map(({ id, name }) => ({ id, name })), [{ id: 'Default', name: 'Personal' }, { id: 'named-profile', name: 'Work' }, { id: 'Profile 1', name: 'Profile 1' }])
  assert.deepEqual(reads, [path.join(f.userData, 'Local State')])
  assert.ok(found.profiles.every((profile) => path.dirname(profile.path) === f.userData))
})

test('missing or malformed Local State discovers real standard directories only', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.userData, 'Local State'), '{broken')
  assert.deepEqual(discoverArc(f.home).profiles.map((row) => row.id), ['Default'])
  assert.deepEqual(discoverArc(path.join(f.home, 'missing')).profiles, [])
})

test('unselected categories perform no filesystem, SQLite or Keychain work', async (t) => {
  t.mock.method(fs, 'lstatSync', () => { throw new Error('must not touch disk') })
  const result = await readArcSecrets({}, { readKey: () => { throw new Error('must not touch keychain') } })
  assert.deepEqual(result, { passwords: [], cookies: [], warnings: [], passwordSkipped: 0, cookieSkipped: 0, passwordFailed: 0, cookieFailed: 0 })
  await assert.rejects(readArcSecrets({ profilePath: 'secret-path', passwords: true }, { platform: 'linux' }), { message: 'Protected Arc import is supported only on macOS.' })
})

test('password import decrypts both stores, deduplicates and skips unsafe or blocked origins', sqlite, async (t) => {
  const f = fixture(t)
  passwordDB(path.join(f.profilePath, 'Login Data'), [{}, { username: 'bob', password: 'second-secret' }, { origin: 'http://example.test/', realm: 'http://example.test/' }, { blocked: 1 }, { scheme: 1 }, { realm: 'https://other.test/' }, { origin: 'https://user:secret@example.test/' }])
  passwordDB(path.join(f.profilePath, 'Login Data For Account'), [{ password: 'must-not-overwrite' }, { username: 'carol' }])
  fs.writeFileSync(path.join(f.profilePath, 'Cookies'), 'must not be read')
  const before = fs.readFileSync(path.join(f.profilePath, 'Login Data'))
  let calls = 0, key
  const result = await readArcSecrets({ profilePath: f.profilePath, passwords: true }, { ...dependencies, readKey: async () => { calls++; key = syntheticKey(); return key } })
  assert.deepEqual(result.passwords, [{ origin: 'https://example.test', username: 'alice', password: 'synthetic-password' }, { origin: 'https://example.test', username: 'bob', password: 'second-secret' }, { origin: 'https://example.test', username: 'carol', password: 'synthetic-password' }])
  assert.equal(result.passwordSkipped, 6)
  assert.equal(result.passwordFailed, 0)
  assert.equal(calls, 1)
  assert.ok(key.every((byte) => byte === 0))
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(fs.readFileSync(path.join(f.profilePath, 'Login Data')), before)
})

test('unknown crypto, bad ciphertext and key denial fail without exposing sensitive errors', sqlite, async (t) => {
  const f = fixture(t)
  passwordDB(path.join(f.profilePath, 'Login Data'), [{ encrypted: Buffer.from('v20synthetic-secret') }, { username: 'bob', encrypted: Buffer.from('v10invalid') }])
  let calls = 0
  const result = await readArcSecrets({ profilePath: f.profilePath, passwords: true }, { ...dependencies, readKey: async () => { calls++; throw new Error('SENSITIVE KEY STDERR') } })
  assert.equal(result.passwordFailed, 2)
  assert.equal(result.passwords.length, 0)
  assert.equal(calls, 1)
  assert.match(result.warnings.join(' '), /unsupported Arc encryption/)
  assert.match(result.warnings.join(' '), /Keychain access/)
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|synthetic-secret|invalid/)
})

test('v24 cookies verify host digests and preserve host-only, domain, security, expiry and session semantics', sqlite, async (t) => {
  const f = fixture(t)
  const expires = BigInt(Math.floor(Date.now() / 1000) + 3600 + 11644473600) * 1000000n
  cookieDB(path.join(f.profilePath, 'Network', 'Cookies'), [
    {}, { host: '.example.test', name: 'domain', persistent: 1, expires, sameSite: 2 },
    { name: 'none', sameSite: 0 }, { name: 'plain', encrypted: Buffer.alloc(0), value: 'plain-synthetic', secure: 0, sourceScheme: 1, sameSite: -1 },
    { name: 'expired', persistent: 1, expires: 1n }, { name: 'partitioned', partition: 'https://other.test' },
    { name: 'mismatch', digestHost: 'other.test' }, { name: 'future', encrypted: Buffer.from('v20unknown') },
    { name: 'same-party', sameParty: 1 }, { name: 'unsafe-none', secure: 0, sameSite: 0 }
  ])
  fs.writeFileSync(path.join(f.profilePath, 'Login Data'), 'must not be read')
  const result = await readArcSecrets({ profilePath: f.profilePath, logins: true }, dependencies)
  assert.equal(result.cookies.length, 4)
  assert.equal(result.cookieSkipped, 3)
  assert.equal(result.cookieFailed, 3)
  assert.deepEqual(result.cookies[0], { url: 'https://example.test/', name: 'sid', value: 'synthetic-cookie', path: '/', secure: true, httpOnly: true, sameSite: 'lax' })
  assert.equal(result.cookies[1].domain, '.example.test')
  assert.equal(result.cookies[1].sameSite, 'strict')
  assert.equal(result.cookies[1].expirationDate, Number(expires) / 1000000 - 11644473600)
  assert.equal(result.cookies[2].sameSite, 'no_restriction')
  assert.equal(result.cookies[3].sameSite, 'unspecified')
  assert.equal(result.cookies[3].url, 'http://example.test/')
  assert.equal(result.cookies[3].secure, false)
  assert.ok(result.cookies.every((cookie) => !Object.hasOwn(cookie, 'partitionKey')))
  assert.doesNotMatch(result.warnings.join(' '), /example\.test|synthetic-cookie/)
})

test('legacy v23 values have no host prefix and committed WAL rows are imported without writing source DB', sqlite, async (t) => {
  const f = fixture(t)
  const file = path.join(f.profilePath, 'Cookies')
  const writer = cookieDB(file, [{ secret: 'legacy-cookie' }], 23, true)
  t.after(() => writer.close())
  const before = fs.readFileSync(file)
  const wal = fs.readFileSync(`${file}-wal`)
  const result = await readArcSecrets({ profilePath: f.profilePath, logins: true }, dependencies)
  assert.equal(result.cookies[0]?.value, 'legacy-cookie')
  assert.deepEqual(fs.readFileSync(file), before)
  assert.deepEqual(fs.readFileSync(`${file}-wal`), wal)
})

test('future cookie schema is rejected without decrypting or widening records', sqlite, async (t) => {
  const f = fixture(t)
  cookieDB(path.join(f.profilePath, 'Cookies'), [{}], 25)
  const result = await readArcSecrets({ profilePath: f.profilePath, logins: true }, { ...dependencies, readKey: () => { throw new Error('must not read key') } })
  assert.equal(result.cookieFailed, 1)
  assert.deepEqual(result.cookies, [])
  assert.match(result.warnings.join(' '), /version is unsupported/)
})

test('unreadable databases warn honestly and source symlinks are not followed', sqlite, async (t) => {
  const f = fixture(t)
  const external = path.join(f.home, 'external')
  fs.writeFileSync(external, 'private source')
  fs.symlinkSync(external, path.join(f.profilePath, 'Login Data'))
  fs.writeFileSync(path.join(f.profilePath, 'Cookies'), 'not sqlite')
  const result = await readArcSecrets({ profilePath: f.profilePath, passwords: true, logins: true }, dependencies)
  assert.equal(result.passwordFailed, 0)
  assert.equal(result.cookieFailed, 0)
  assert.equal(result.warnings.length, 2)
  assert.ok(result.warnings.every((warning) => warning.includes('not counted')))
  assert.doesNotMatch(JSON.stringify(result), /private source|external|not sqlite/)
})

test('vault encrypts on disk, preserves existing credentials and isolates exact HTTPS origins and profiles', (t) => {
  const f = fixture(t)
  const file = path.join(f.home, 'vault', 'passwords.enc')
  const safeStorage = storage()
  const vault = createVault({ file, safeStorage })
  const record = { origin: 'https://example.test/path', username: 'alice', password: 'synthetic-vault-secret' }
  assert.deepEqual(vault.import([record, { ...record, password: 'replacement' }, { ...record, origin: 'http://example.test' }], partition), { imported: 1, skipped: 2, failed: 0 })
  assert.deepEqual(vault.import([{ ...record, password: 'other-profile' }], otherPartition), { imported: 1, skipped: 0, failed: 0 })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.ok(!fs.readFileSync(file).includes(Buffer.from(record.password)))
  assert.ok(!fs.readFileSync(file).includes(Buffer.from('alice')))
  const accounts = vault.list('https://example.test', partition)
  assert.equal(accounts.length, 1)
  assert.deepEqual(Object.keys(accounts[0]).sort(), ['id', 'username'])
  const { id } = accounts[0]
  assert.deepEqual(vault.get(id, 'https://example.test', partition), { username: 'alice', password: record.password })
  for (const origin of ['http://example.test', 'https://sub.example.test', 'https://example.test:444', 'https://example.test/path', 'https://user:pass@example.test']) {
    assert.deepEqual(vault.list(origin, partition), [])
    assert.equal(vault.get(id, origin, partition), null)
  }
  assert.equal(vault.get(id, 'https://example.test', otherPartition), null)
  assert.deepEqual(createVault({ file, safeStorage }).list('https://example.test', partition), accounts)
  assert.equal(vault.remove(id), true)
  assert.equal(vault.remove(id), false)
  assert.equal(vault.get(id, 'https://example.test', partition), null)
  assert.equal(vault.list('https://example.test', otherPartition).length, 1)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['passwords.enc'])
})

test('vault rejects unavailable or basic_text storage without writing files', (t) => {
  const f = fixture(t)
  for (const safeStorage of [{ ...storage(), isEncryptionAvailable: () => false }, { ...storage(), getSelectedStorageBackend: () => 'basic_text' }]) {
    const file = path.join(f.home, 'passwords.enc')
    const vault = createVault({ file, safeStorage })
    assert.throws(() => vault.import([], partition), { message: 'Secure password storage is unavailable.' })
    assert.equal(fs.existsSync(file), false)
  }
})

test('corrupt vault and encryption failures cannot overwrite existing credentials or leak errors', (t) => {
  const f = fixture(t)
  const file = path.join(f.home, 'passwords.enc')
  const safeStorage = storage()
  const vault = createVault({ file, safeStorage })
  fs.writeFileSync(file, 'CORRUPT PRIVATE CONTENT')
  assert.throws(() => vault.import([{ origin: 'https://example.test', username: 'a', password: 'secret' }], partition), { message: 'The password vault could not be unlocked; it was not changed.' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'CORRUPT PRIVATE CONTENT')
  fs.unlinkSync(file)
  vault.import([{ origin: 'https://example.test', username: 'a', password: 'secret' }], partition)
  const before = fs.readFileSync(file)
  safeStorage.encryptString = () => { throw new Error('SENSITIVE ENCRYPTION ERROR') }
  assert.throws(() => vault.import([{ origin: 'https://example.test', username: 'b', password: 'secret2' }], partition), { message: 'The password vault could not be saved; existing passwords were not changed.' })
  assert.deepEqual(fs.readFileSync(file), before)
  assert.deepEqual(fs.readdirSync(f.home).sort(), ['Library', 'passwords.enc'])
})

test('vault refuses unsafe partitions and authenticated but invalid vault structure', (t) => {
  const f = fixture(t)
  const file = path.join(f.home, 'passwords.enc')
  const safeStorage = storage()
  const vault = createVault({ file, safeStorage })
  assert.throws(() => vault.import([], 'persist:default'), { message: 'Invalid password import.' })
  fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify({ version: 1, records: [{ origin: 'https://example.test', password: 'secret' }] })))
  const before = fs.readFileSync(file)
  assert.throws(() => vault.import([], partition), { message: 'The password vault could not be unlocked; it was not changed.' })
  assert.deepEqual(fs.readFileSync(file), before)
})

test('sidebar custom profile basenames supplement missing Local State without path traversal', (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.userData, 'arc-custom-profile'))
  fs.writeFileSync(path.join(f.root, 'StorableSidebar.json'), JSON.stringify({
    sidebar: { containers: [{ spaces: ['work', { profile: { custom: { _0: { directoryBasename: 'arc-custom-profile' } } } }], topAppsContainerIDs: [{ custom: { _0: { directoryBasename: '../outside' } } }, 'apps'] }] }
  }))
  assert.deepEqual(discoverArc(f.home).profiles.map(({ id, name }) => ({ id, name })), [
    { id: 'Default', name: 'Default' }, { id: 'arc-custom-profile', name: 'arc-custom-profile' }
  ])
})

test('missing selected databases are reported without requesting the Keychain', sqlite, async (t) => {
  const f = fixture(t)
  let calls = 0
  const result = await readArcSecrets({ profilePath: f.profilePath, passwords: true, logins: true }, { ...dependencies, readKey: () => { calls++ } })
  assert.equal(calls, 0)
  assert.equal(result.warnings.length, 2)
  assert.ok(result.warnings.every((warning) => warning.includes('No ') && warning.includes('database was found')))
  assert.deepEqual(result.passwords, [])
  assert.deepEqual(result.cookies, [])
})

test('malformed ciphertext and mismatched v24 keys report failure rather than success', sqlite, async (t) => {
  const f = fixture(t)
  passwordDB(path.join(f.profilePath, 'Login Data'), [{ encrypted: Buffer.from('v10invalid') }, { username: 'other', encrypted: Buffer.from([0xf6, 0x31, 0x30, 0]) }])
  cookieDB(path.join(f.profilePath, 'Cookies'), [{}])
  const result = await readArcSecrets({ profilePath: f.profilePath, passwords: true, logins: true }, { ...dependencies, readKey: async () => Buffer.alloc(16, 1) })
  assert.equal(result.passwordFailed, 2)
  assert.equal(result.cookieFailed, 1)
  assert.deepEqual(result.passwords, [])
  assert.deepEqual(result.cookies, [])
  assert.match(result.warnings.join(' '), /unsupported Arc encryption/)
})

const png = (label) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(label)])
// icons: [{url, pages: [page_url], bitmaps: [[width, image_data, last_updated?]]}] in Chromium's Favicons layout.
function faviconDB(file, icons) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE favicons (id INTEGER PRIMARY KEY, url LONGVARCHAR NOT NULL, icon_type INTEGER DEFAULT 1);
    CREATE TABLE icon_mapping (id INTEGER PRIMARY KEY, page_url LONGVARCHAR NOT NULL, icon_id INTEGER);
    CREATE TABLE favicon_bitmaps (id INTEGER PRIMARY KEY, icon_id INTEGER NOT NULL, last_updated INTEGER DEFAULT 0, image_data BLOB, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0)`)
  icons.forEach(({ url, pages, bitmaps }, index) => {
    db.prepare('INSERT INTO favicons (id, url) VALUES (?, ?)').run(index + 1, url)
    for (const page of pages) db.prepare('INSERT INTO icon_mapping (page_url, icon_id) VALUES (?, ?)').run(page, index + 1)
    for (const [width, data, updated = 0] of bitmaps) db.prepare('INSERT INTO favicon_bitmaps (icon_id, width, height, image_data, last_updated) VALUES (?, ?, ?, ?, ?)').run(index + 1, width, width, data, updated)
  })
  db.close()
}

test('Arc icons: the exact page wins with its largest bitmap, the newest icon of the same origin is the fallback, and unreadable sources are silent', sqlite, (t) => {
  const f = fixture(t)
  assert.equal(readArcIcons(f.profilePath, ['https://site.test/a']).size, 0, 'no Favicons file')
  const empty = path.join(f.userData, 'Profile 1')
  fs.mkdirSync(empty)
  new DatabaseSync(path.join(empty, 'Favicons')).close()
  assert.equal(readArcIcons(empty, ['https://site.test/a']).size, 0, 'no tables')
  assert.equal(readArcIcons(path.join(f.userData, 'Missing'), ['https://site.test/a']).size, 0, 'no profile')
  faviconDB(path.join(f.profilePath, 'Favicons'), [
    { url: 'https://site.test/a.png', pages: ['https://site.test/a'], bitmaps: [[16, png('a16')], [64, png('a64')], [32, png('a32')]] },
    { url: 'https://site.test/old.png', pages: ['https://site.test/old'], bitmaps: [[128, png('old'), 10]] },
    { url: 'https://cdn.test/new.png', pages: ['https://site.test/new?x=1'], bitmaps: [[16, png('new16'), 20], [32, png('new32'), 20]] },
    { url: 'https://site.test.evil.test/x.png', pages: ['https://site.test.evil.test/', 'https://site.test:8443/'], bitmaps: [[256, png('evil'), 99]] },
    { url: 'https://blank.test/x.png', pages: ['https://blank.test/'], bitmaps: [[16, null]] }
  ])
  const icons = readArcIcons(f.profilePath, ['https://site.test/a', 'https://site.test/never-visited', 'https://blank.test/', 'https://other.test/', 'not a url', 7])
  assert.deepEqual([...icons].map(([page, icon]) => [page, icon.url, icon.bytes.subarray(8).toString()]), [
    ['https://site.test/a', 'https://site.test/a.png', 'a64'],
    ['https://site.test/never-visited', 'https://cdn.test/new.png', 'new32']
  ])
})

test('Arc icons are still read while another connection holds the database locked, through a copy that is removed', sqlite, (t) => {
  const f = fixture(t)
  const file = path.join(f.profilePath, 'Favicons')
  faviconDB(file, [{ url: 'https://site.test/a.png', pages: ['https://site.test/a'], bitmaps: [[32, png('a32')]] }])
  const temp = path.join(f.home, 'tmp')
  fs.mkdirSync(temp)
  const previous = process.env.TMPDIR
  process.env.TMPDIR = temp
  const holder = new DatabaseSync(file)
  t.after(() => {
    holder.close()
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  })
  holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE')
  const icons = readArcIcons(f.profilePath, ['https://site.test/a'])
  assert.deepEqual([...icons].map(([page, icon]) => [page, icon.url, icon.bytes.subarray(8).toString()]), [['https://site.test/a', 'https://site.test/a.png', 'a32']])
  assert.deepEqual(fs.readdirSync(temp), [])
})

test('fillArcIcons saves Arc icons for the Arc tabs of one profile, replaces an older icon and rejects bytes that are not an image', sqlite, (t) => {
  const f = fixture(t)
  const dir = path.join(f.home, 'favicons')
  faviconDB(path.join(f.profilePath, 'Favicons'), [
    { url: 'https://good.test/icon.png', pages: ['https://good.test/'], bitmaps: [[32, png('good')]] },
    { url: 'https://html.test/icon.png', pages: ['https://html.test/'], bitmaps: [[32, Buffer.from('<html>sign in')]] }
  ])
  const own = `persist:arc-${crypto.createHash('sha256').update('Default').digest('hex').slice(0, 24)}`
  const tab = (url, fields) => ({ url, favicon: '', arcSourceId: 'arc', sessionPartition: own, ...fields })
  const state = { tabs: [
    tab('https://good.test/', { favicon: '../favicons/broken.ico' }),
    tab('https://html.test/', { favicon: '../favicons/kept.png' }),
    tab('https://good.test/', { arcSourceId: undefined }),
    tab('https://good.test/', { sessionPartition: otherPartition })
  ] }
  assert.equal(fillArcIcons(state, dir, f.profilePath), 1)
  const saved = state.tabs[0].favicon
  assert.match(saved, /^\.\.\/favicons\/[0-9a-f]{24}\.png$/)
  assert.deepEqual(state.tabs.map((item) => item.favicon), [saved, '../favicons/kept.png', '', ''])
  assert.deepEqual(fs.readdirSync(dir), [path.basename(saved)])
  assert.deepEqual(fs.readFileSync(path.join(dir, path.basename(saved))), png('good'))
  assert.equal(fillArcIcons(state, dir, f.profilePath), 0, 'a second fill changes nothing')
})

'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const profileId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,127}$/.test(id)
const partitionId = (id) => typeof id === 'string' && /^persist:arc-[a-f0-9]{24}$/.test(id)
const failure = (message) => Object.assign(new Error(message), { code: 'migration_failed' })
const isDirectory = (file) => {
  try { return fs.lstatSync(file).isDirectory() } catch { return false }
}

// Metadata only: preview must never touch Login Data, Cookies, or Keychain.
function discoverArc(home = os.homedir()) {
  const root = path.join(home, 'Library', 'Application Support', 'Arc')
  const userData = path.join(root, 'User Data')
  if (!isDirectory(root) || !isDirectory(userData)) return { root, profiles: [] }
  let cache = {}
  try {
    const file = path.join(userData, 'Local State')
    if (fs.lstatSync(file).isFile()) cache = JSON.parse(fs.readFileSync(file, 'utf8')).profile?.info_cache || {}
  } catch { /* Directory discovery still works without usable Local State. */ }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {}
  const ids = new Set(Object.keys(cache).filter(profileId))
  try {
    const file = path.join(root, 'StorableSidebar.json')
    if (fs.lstatSync(file).isFile()) {
      const pending = [JSON.parse(fs.readFileSync(file, 'utf8'))]
      while (pending.length) {
        const value = pending.pop()
        if (!value || typeof value !== 'object') continue
        const id = value.custom?._0?.directoryBasename
        if (profileId(id)) ids.add(id)
        pending.push(...Object.values(value).filter((child) => child && typeof child === 'object'))
      }
    }
  } catch { /* Local State and standard directories remain usable without a sidebar. */ }
  for (const entry of fs.readdirSync(userData, { withFileTypes: true })) {
    if (entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name)) ids.add(entry.name)
  }
  const profiles = [...ids].sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b)).flatMap((id) => {
    if (cache[id]?.name === '__ARC_SYSTEM_PROFILE') return []
    const directory = path.join(userData, id)
    if (!isDirectory(directory)) return []
    const name = typeof cache[id]?.name === 'string' && cache[id].name.trim() ? cache[id].name : id
    return [{ id, name, path: directory }]
  })
  return { root, profiles }
}

function httpsOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null
  } catch { return null }
}

function readArcKey() {
  return new Promise((resolve, reject) => {
    // No shell, no logging, no inherited stdout, and no fallback to another browser's key.
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'Arc Safe Storage', '-w'],
      { encoding: 'buffer', maxBuffer: 16384, timeout: 120000 }, (error, stdout, stderr) => {
        if (Buffer.isBuffer(stderr)) stderr.fill(0)
        if (error || !Buffer.isBuffer(stdout) || !stdout.length) {
          if (Buffer.isBuffer(stdout)) stdout.fill(0)
          return reject(failure('Arc Keychain access was denied or unavailable.'))
        }
        // security appends one newline; do not trim spaces from the actual secret.
        const end = stdout[stdout.length - 1] === 10 ? stdout.length - 1 : stdout.length
        try {
          if (!end) throw failure('Arc Keychain access was denied or unavailable.')
          resolve(crypto.pbkdf2Sync(stdout.subarray(0, end), 'saltysalt', 1003, 16, 'sha1'))
        } catch { reject(failure('Arc Keychain access was denied or unavailable.')) }
        finally { stdout.fill(0) }
      })
  })
}

// Chromium 143 os_crypt/sync/os_crypt_mac.mm: v10, PBKDF2-SHA1/1003,
// AES-128-CBC, IV = sixteen spaces. Never guess at v11/v20/unknown formats.
function decrypt(value, key) {
  const bytes = Buffer.from(value)
  if (!bytes.subarray(0, 3).equals(Buffer.from('v10'))) throw failure('Unsupported Arc encryption format.')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
  return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()])
}

function databaseRows(DatabaseSync, file, table, required, optional = {}) {
  let db
  try {
    // Do NOT use immutable=1 or copy just the DB: both can lose committed WAL rows.
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
    db.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 2000; BEGIN')
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
    if (required.some((column) => !columns.has(column))) throw failure('Unsupported Arc database schema.')
    const fields = [...required, ...Object.entries(optional).map(([column, fallback]) => columns.has(column) ? column : `${fallback} AS ${column}`)]
    const statement = db.prepare(`SELECT ${fields.join(', ')} FROM ${table}`)
    statement.setReadBigInts(true)
    const rows = statement.all()
    let version = null
    if (table === 'cookies') version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value)
    db.exec('COMMIT')
    return { rows, version }
  } finally { if (db) db.close() }
}

function sourceFile(profilePath, relative) {
  let current = profilePath
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw failure('An Arc database could not be opened.')
    }
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw failure('An Arc database path is not supported.')
  }
  return current
}

// Arc's own saved icons: a plain Chromium Favicons database, not encrypted, no Keychain.
// Per page URL: the largest bitmap mapped to that exact page, else the most recently updated icon of the same origin.
// A missing or unreadable database gives no icons and no error.
function readArcIcons(profilePath, pageUrls, dependencies = {}) {
  const read = (file) => {
    const icons = new Map()
    const DatabaseSync = dependencies.DatabaseSync || require('node:sqlite').DatabaseSync
    const db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 2000; BEGIN')
      const from = 'SELECT f.url AS url, b.image_data AS bytes FROM favicons f JOIN favicon_bitmaps b ON b.icon_id = f.id WHERE length(b.image_data) > 0 AND f.id'
      const exact = db.prepare(`${from} IN (SELECT icon_id FROM icon_mapping WHERE page_url = ?) ORDER BY b.width DESC LIMIT 1`)
      const near = db.prepare(`${from} = (SELECT m.icon_id FROM icon_mapping m JOIN favicon_bitmaps n ON n.icon_id = m.icon_id WHERE m.page_url >= ? AND m.page_url < ? AND length(n.image_data) > 0 ORDER BY n.last_updated DESC LIMIT 1) ORDER BY b.width DESC LIMIT 1`)
      for (const pageUrl of new Set(pageUrls)) {
        if (typeof pageUrl !== 'string' || !URL.canParse(pageUrl)) continue
        const origin = new URL(pageUrl).origin
        // '0' is the character after '/', so the range holds every page of this origin.
        const row = exact.get(pageUrl) || near.get(`${origin}/`, `${origin}0`)
        if (typeof row?.url === 'string') icons.set(pageUrl, { url: row.url, bytes: Buffer.from(row.bytes) })
      }
      db.exec('COMMIT')
      return icons
    } finally { db.close() }
  }
  let copy
  try {
    const file = typeof profilePath === 'string' && profileId(path.basename(profilePath)) && sourceFile(profilePath, 'Favicons')
    if (!file) return new Map()
    try { return read(file) } catch {
      // A running Arc holds this database locked. A plain copy is safe here: it uses a rollback journal, not WAL, so the file alone is stale by at most one transaction, and it holds icons only.
      copy = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-arc-icons-'))
      fs.copyFileSync(file, path.join(copy, 'Favicons'))
      return read(path.join(copy, 'Favicons'))
    }
  } catch { return new Map() }
  finally { if (copy) fs.rmSync(copy, { recursive: true, force: true }) }
}

// Call only after native consent. The second argument is for synthetic fixture
// dependencies; renderer/API arguments must never be forwarded into it.
async function readArcSecrets({ profilePath, passwords = false, logins = false }, dependencies = {}) {
  const result = { passwords: [], cookies: [], warnings: [], passwordSkipped: 0, cookieSkipped: 0, passwordFailed: 0, cookieFailed: 0 }
  if (!passwords && !logins) return result
  const warn = (message) => { if (!result.warnings.includes(message)) result.warnings.push(message) }
  if ((dependencies.platform || process.platform) !== 'darwin') throw failure('Protected Arc import is supported only on macOS.')
  if (typeof profilePath !== 'string' || !profileId(path.basename(profilePath)) || !isDirectory(profilePath)) throw failure('The selected Arc profile is unavailable.')
  let DatabaseSync
  try { DatabaseSync = dependencies.DatabaseSync || require('node:sqlite').DatabaseSync }
  catch { throw failure('This runtime does not support protected Arc import.') }
  let key, keyAttempted = false
  const decode = async (bytes) => {
    if (!bytes || !Buffer.from(bytes).subarray(0, 3).equals(Buffer.from('v10'))) {
      warn('Some records use an unsupported Arc encryption format.')
      throw failure('Unsupported Arc encryption format.')
    }
    if (!keyAttempted) {
      keyAttempted = true
      try { key = await (dependencies.readKey || readArcKey)() }
      catch { warn('Arc Keychain access was denied or unavailable; encrypted records were not imported.') }
    }
    if (!key) throw failure('Arc Keychain access was denied or unavailable.')
    return decrypt(bytes, key)
  }
  const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  try {
    if (passwords) {
      const seen = new Set()
      let databaseFound = false
      for (const name of ['Login Data', 'Login Data For Account']) {
        let rows
        try {
          const file = sourceFile(profilePath, name)
          if (!file) continue
          databaseFound = true
          ;({ rows } = databaseRows(DatabaseSync, file, 'logins', ['origin_url', 'username_value', 'password_value', 'signon_realm'], { blacklisted_by_user: '0', blocked_by_user: '0', scheme: '0' }))
        } catch { databaseFound = true; warn('A saved-password database could not be read; its records were not counted.'); continue }
        for (const row of rows) {
          const origin = httpsOrigin(row.origin_url)
          if (!origin || httpsOrigin(row.signon_realm) !== origin || Number(row.scheme) !== 0 || Number(row.blacklisted_by_user) || Number(row.blocked_by_user) || typeof row.username_value !== 'string' || !row.password_value?.length) {
            result.passwordSkipped++; continue
          }
          const identity = JSON.stringify([origin, row.username_value])
          if (seen.has(identity)) { result.passwordSkipped++; continue }
          let plaintext
          try {
            plaintext = await decode(row.password_value)
            const password = utf8(plaintext)
            if (!password) { result.passwordSkipped++; continue }
            result.passwords.push({ origin, username: row.username_value, password })
            seen.add(identity)
          } catch { result.passwordFailed++; warn('Some saved passwords could not be decrypted safely.') }
          finally { plaintext?.fill(0) }
        }
      }
      if (!databaseFound) warn('No saved-password database was found in the selected Arc profile.')
    }
    if (logins) {
      let rows, version
      try {
        const file = sourceFile(profilePath, 'Network/Cookies') || sourceFile(profilePath, 'Cookies')
        if (file) ({ rows, version } = databaseRows(DatabaseSync, file, 'cookies', ['host_key', 'name', 'value', 'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly', 'samesite', 'has_expires', 'is_persistent'], { top_frame_site_key: "''", source_scheme: '0', source_port: '-1', is_same_party: '0' }))
        else warn('No website sign-in database was found in the selected Arc profile.')
      } catch { warn('The website sign-in database could not be read; its records were not counted.') }
      for (const row of rows || []) {
        if (!Number.isInteger(version) || version < 1 || version > 24) {
          result.cookieFailed++; warn('The Arc cookie database version is unsupported.'); continue
        }
        if (row.top_frame_site_key || Number(row.is_same_party)) {
          result.cookieSkipped++; warn('Partitioned or SameParty cookies were skipped to preserve their security boundaries.'); continue
        }
        const persistent = Number(row.has_expires) !== 0 && Number(row.is_persistent) !== 0
        const expires = Number(row.expires_utc) / 1000000 - 11644473600
        if (persistent && expires <= Date.now() / 1000) { result.cookieSkipped++; continue }
        let plaintext
        try {
          const domain = row.host_key
          if (typeof domain !== 'string' || !domain || /[\s/@?#\\]/.test(domain)) throw failure('Invalid cookie domain.')
          const host = domain.startsWith('.') ? domain.slice(1) : domain
          const secure = Number(row.is_secure) !== 0
          const scheme = secure || Number(row.source_scheme) === 2 ? 'https:' : 'http:'
          const url = new URL(`${scheme}//${host}`)
          if (url.hostname !== host || url.port || url.pathname !== '/') throw failure('Invalid cookie domain.')
          const port = Number(row.source_port)
          if (port > 0 && port <= 65535) url.port = String(port)
          if (typeof row.path !== 'string' || !row.path.startsWith('/')) throw failure('Invalid cookie path.')
          const sameSite = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' }[String(row.samesite)]
          if (!sameSite || (sameSite === 'no_restriction' && !secure)) throw failure('Unsupported cookie policy.')
          let value = row.value
          if (row.encrypted_value?.length) {
            if (value) throw failure('Ambiguous cookie value.')
            plaintext = await decode(row.encrypted_value)
            let offset = 0
            if (version === 24) {
              const digest = crypto.createHash('sha256').update(domain).digest()
              if (plaintext.length < 32 || !crypto.timingSafeEqual(digest, plaintext.subarray(0, 32))) throw failure('Cookie domain verification failed.')
              offset = 32
            }
            value = utf8(plaintext.subarray(offset))
          }
          if (typeof value !== 'string' || typeof row.name !== 'string' || /[\x00-\x1f\x7f;]/.test(value) || /[\x00-\x20\x7f;=]/.test(row.name)) throw failure('Invalid cookie value.')
          const cookie = { url: url.href, name: row.name, value, path: row.path, secure, httpOnly: Number(row.is_httponly) !== 0, sameSite }
          // Electron normalizes an explicit domain to a domain cookie. Omit it
          // for host-only cookies, otherwise migration would widen their scope.
          if (domain.startsWith('.')) cookie.domain = domain
          if (persistent) {
            if (!Number.isFinite(expires)) throw failure('Invalid cookie expiry.')
            cookie.expirationDate = expires
          }
          result.cookies.push(cookie)
        } catch { result.cookieFailed++; warn('Some website cookies could not be imported safely.') }
        finally { plaintext?.fill(0) }
      }
    }
  } finally { key?.fill(0) }
  return result
}

function createVault({ file, safeStorage }) {
  const available = () => {
    try {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error()
    } catch { throw failure('Secure password storage is unavailable.') }
  }
  const validRecord = (row) => row && typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id) && partitionId(row.partition) && typeof row.origin === 'string' && httpsOrigin(row.origin) === row.origin && typeof row.username === 'string' && typeof row.password === 'string' && row.password.length > 0
  const load = () => {
    available()
    try {
      let stat
      try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
      if (!stat.isFile()) throw new Error()
      const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))
      if (data.version !== 1 || !Array.isArray(data.records) || !data.records.every(validRecord)) throw new Error()
      if (new Set(data.records.map((row) => row.id)).size !== data.records.length || new Set(data.records.map((row) => JSON.stringify([row.partition, row.origin, row.username]))).size !== data.records.length) throw new Error()
      return data.records
    } catch { throw failure('The password vault could not be unlocked; it was not changed.') }
  }
  const save = (records) => {
    available()
    let temporary, descriptor
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, records }))
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error()
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      temporary = `${file}.${crypto.randomUUID()}.tmp`
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, encrypted)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporary, file)
      temporary = undefined
    } catch { throw failure('The password vault could not be saved; existing passwords were not changed.') }
    finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch {} }
      if (temporary) { try { fs.unlinkSync(temporary) } catch {} }
    }
  }
  return {
    import(records, partition) {
      if (!Array.isArray(records) || !partitionId(partition)) throw failure('Invalid password import.')
      const stored = load()
      const seen = new Set(stored.map((row) => JSON.stringify([row.partition, row.origin, row.username])))
      const counts = { imported: 0, skipped: 0, failed: 0 }
      for (const record of records) {
        const origin = httpsOrigin(record?.origin)
        if (!origin || typeof record?.username !== 'string' || typeof record?.password !== 'string' || !record.password) { counts.skipped++; continue }
        const identity = JSON.stringify([partition, origin, record.username])
        if (seen.has(identity)) { counts.skipped++; continue }
        stored.push({ id: crypto.randomUUID(), partition, origin, username: record.username, password: record.password })
        seen.add(identity)
        counts.imported++
      }
      if (counts.imported) save(stored)
      return counts
    },
    list(origin, partition) {
      if (!partitionId(partition) || httpsOrigin(origin) !== origin) return []
      return load().filter((row) => row.origin === origin && row.partition === partition).map(({ id, username }) => ({ id, username }))
    },
    get(id, origin, partition) {
      if (!partitionId(partition) || httpsOrigin(origin) !== origin) return null
      const record = load().find((row) => row.id === id && row.origin === origin && row.partition === partition)
      return record ? { username: record.username, password: record.password } : null
    },
    remove(id) {
      const records = load()
      const next = records.filter((row) => row.id !== id)
      if (next.length === records.length) return false
      save(next)
      return true
    }
  }
}

module.exports = { discoverArc, readArcSecrets, readArcIcons, createVault }

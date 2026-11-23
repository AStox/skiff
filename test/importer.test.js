'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const S = require('../src/state')
const { parseArc } = require('../src/arc')
const { createImporter } = require('../src/importer')
const { createVault } = require('../src/migration')
const { windowTheme } = require('../e2e/arc-fixture')

const sidebar = {
  sidebar: { containers: [{
    spaces: [
      'default', { id: 'default', title: 'Personal', profile: { default: {} }, newContainerIDs: [{ pinned: {} }, 'd', { unpinned: {} }, 'do'] },
      'work', { id: 'work', title: 'Work', profile: { custom: { _0: { directoryBasename: 'Profile 1' } } }, newContainerIDs: [{ pinned: {} }, 'w', { unpinned: {} }, 'wo'] },
      'other', { id: 'other', title: 'Other', profile: { custom: { _0: { directoryBasename: 'Profile 2' } } }, newContainerIDs: [{ pinned: {} }, 'o'] }
    ],
    items: [
      'd', { id: 'd', childrenIds: ['dt'] }, 'dt', { id: 'dt', data: { tab: { savedURL: 'https://personal.example/' } } },
      'w', { id: 'w', childrenIds: ['wt'] }, 'wt', { id: 'wt', data: { tab: { savedURL: 'https://work.example/' } } },
      'o', { id: 'o', childrenIds: ['ot'] }, 'ot', { id: 'ot', data: { tab: { savedURL: 'https://other.example/' } } },
      'do', { id: 'do', data: { tab: { savedURL: 'https://shared.example/' } } },
      'wo', { id: 'wo', data: { tab: { savedURL: 'https://shared.example/' } } }
    ],
    topAppsContainerIDs: [{ default: {} }, 'd', { custom: { _0: { directoryBasename: 'Profile 1' } } }, 'w', { custom: { _0: { directoryBasename: 'Profile 2' } } }, 'o']
  }] }
}
const all = { tabs: true, openTabs: true, passwords: true, logins: true }
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-import-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'StorableSidebar.json'), JSON.stringify(sidebar))
  const state = S.load()
  let reads = 0
  let confirmations = 0
  const importer = createImporter({
    home: root, state, changed() {}, platform: 'darwin',
    discover: () => ({ root, profiles: [
      { id: 'Default', name: 'Personal', path: path.join(root, 'Default') },
      { id: 'Profile 1', name: 'Work', path: path.join(root, 'Profile 1') },
      { id: 'Profile 2', name: 'Other', path: path.join(root, 'Profile 2') }
    ] }),
    confirm: async () => { confirmations++; return false },
    readSecrets: async () => { reads++; throw new Error('must never read without consent') },
    vault: { import() { throw new Error('unexpected vault access') } },
    getSession() { throw new Error('unexpected cookie access') },
    ...overrides
  })
  return { importer, state, root, reads: () => reads, confirmations: () => confirmations }
}

function secretData(id, { passwords = true, logins = true } = {}) {
  return {
    passwords: passwords ? [{ origin: 'https://shared.example', username: 'same-account', password: `synthetic-password-${id}` }] : [],
    cookies: logins ? [{ url: 'https://shared.example/', domain: 'shared.example', path: '/', name: 'session', value: `synthetic-session-${id}`, secure: true }] : [],
    warnings: [], passwordSkipped: 0, passwordFailed: 0, cookieSkipped: 0, cookieFailed: 0
  }
}

function batchFixture(t, overrides = {}) {
  const key = crypto.randomBytes(32)
  const safeStorage = {
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
  const consent = []
  const readProfiles = []
  const sessions = new Map()
  let vault
  const f = fixture(t, {
    confirm: async (names) => { consent.push(names); return true },
    readSecrets: async ({ profilePath, ...categories }) => {
      assert.equal(consent.length, 1)
      const id = path.basename(profilePath)
      readProfiles.push(id)
      return secretData(id, categories)
    },
    vault: { import: (...args) => vault.import(...args) },
    getSession(partition) {
      if (!sessions.has(partition)) sessions.set(partition, [])
      const records = sessions.get(partition)
      return { cookies: {
        get: async () => records,
        set: async (cookie) => { records.push({ ...cookie }) },
        flushStore: async () => {}
      } }
    },
    ...overrides
  })
  vault = createVault({ file: path.join(f.root, 'passwords.enc'), safeStorage })
  return { ...f, vault, consent, readProfiles, sessions }
}

test('metadata-only preview and declined batch consent never read protected data or mutate state', async (t) => {
  const f = fixture(t)
  const before = JSON.stringify(f.state)
  assert.deepEqual(f.importer.preview().profiles, [{ id: 'Default', name: 'Personal' }, { id: 'Profile 1', name: 'Work' }, { id: 'Profile 2', name: 'Other' }])
  assert.equal(f.reads(), 0)
  fs.unlinkSync(path.join(f.root, 'StorableSidebar.json'))
  assert.deepEqual(await f.importer.run({ profileIds: ['Default', 'Profile 1'], categories: all, keepSpaces: true }), { cancelled: true })
  assert.equal(f.confirmations(), 1)
  assert.equal(f.reads(), 0)
  assert.equal(JSON.stringify(f.state), before)
  assert.deepEqual(await f.importer.run({ profileIds: ['Default', 'Profile 1'], categories: all, keepSpaces: true }), { cancelled: true })
  assert.equal(f.confirmations(), 2)
  assert.equal(f.reads(), 0)
  assert.equal(JSON.stringify(f.state), before)
})

test('preview counts same-site favorites per importable profile and excludes system profiles', async (t) => {
  const f = fixture(t)
  const data = structuredClone(sidebar)
  const container = data.sidebar.containers[0]
  container.items.find((item) => item.id === 'wt').data.tab.savedURL = 'https://personal.example/'
  container.spaces.push('system', { id: 'system', title: 'Arc system', profile: { custom: { _0: { directoryBasename: 'arc-system' } } }, newContainerIDs: [{ pinned: {} }, 'd'] })
  container.topAppsContainerIDs.push({ custom: { _0: { directoryBasename: 'arc-system' } } }, 'd')
  fs.writeFileSync(path.join(f.root, 'StorableSidebar.json'), JSON.stringify(data))
  assert.deepEqual(f.importer.preview().counts, { spaces: 3, favorites: 3, pinned: 3, tabs: 2 })
  for (const profileId of ['Default', 'Profile 1']) {
    assert.deepEqual(f.importer.preview({ profileId }).counts, { spaces: 1, favorites: 1, pinned: 1, tabs: 1 })
  }
  const result = await f.importer.run({ profileIds: ['Default', 'Profile 1', 'Profile 2'], categories: { tabs: true, openTabs: true, passwords: false, logins: false }, keepSpaces: true })
  assert.deepEqual({ spaces: result.spaces, favorites: result.favorites, pinned: result.pinned, tabs: result.tabs }, f.importer.preview().counts)
  assert.equal(f.state.tabs.filter((tab) => tab.favorite && tab.url === 'https://personal.example/').length, 2)
  assert.equal(f.state.spaces.some((space) => space.name === 'Arc system'), false)
  assert.equal(f.reads(), 0)
})

test('tabs-only import does not request permission or touch credentials and remains idempotent', async (t) => {
  const f = fixture(t)
  const params = { profileIds: ['Default'], categories: { tabs: true, openTabs: false, passwords: false, logins: false }, keepSpaces: true }
  const result = await f.importer.run(params)
  assert.equal(result.pinned, 1)
  assert.equal(result.favorites, 1)
  assert.equal(f.state.spaces.some((s) => s.name === 'Work'), false)
  assert.equal(f.confirmations(), 0)
  assert.equal(f.reads(), 0)
  assert.equal((await f.importer.run(params)).pinned, 0)
  assert.equal(f.state.tabs.every((t) => t.sessionPartition.startsWith('persist:arc-')), true)
})

test('repeat imports preserve user edits and avoid duplicates across space layout choices', async (t) => {
  const f = fixture(t)
  const params = { profileIds: ['Default'], categories: { tabs: true, openTabs: true, passwords: false, logins: false }, keepSpaces: true }
  await f.importer.run(params)
  const tab = f.state.tabs.find((t) => t.pinned)
  const space = f.state.spaces.find((s) => s.id === tab.spaceId)
  S.updateSpace(f.state, { id: space.id, name: 'My renamed space' })
  S.navigateTab(f.state, { id: tab.id, url: 'https://personal.example/new-location' }, 3)
  const before = JSON.stringify(f.state)
  for (const keepSpaces of [false, true]) {
    const result = await f.importer.run({ ...params, keepSpaces })
    assert.deepEqual([result.spaces, result.favorites, result.pinned, result.tabs], [0, 0, 0, 0])
    assert.equal(JSON.stringify(f.state), before)
  }
})

test('destination cookie failure preserves completed password results without leaking its error', async (t) => {
  const f = fixture(t, {
    confirm: async () => true,
    readSecrets: async () => ({ passwords: [], cookies: [], warnings: [], passwordSkipped: 0, passwordFailed: 0, cookieSkipped: 0, cookieFailed: 0 }),
    vault: { import: () => ({ imported: 0, skipped: 0, failed: 0 }) },
    getSession: () => ({ cookies: { get: async () => [], flushStore: async () => { throw new Error('private cookie value') } } })
  })
  const result = await f.importer.run({ profileIds: ['Default'], categories: all, keepSpaces: true })
  assert.equal(result.passwords.failed, 0)
  assert.equal(result.logins.failed, 0)
  assert.equal(result.warnings.some((s) => s.includes('could not be saved completely')), true)
  assert.equal(JSON.stringify(result).includes('private cookie value'), false)
  assert.equal(result.warnings.some((s) => s.includes('Keychain')), false)
})

test('reject invalid selection before consent; do not treat truthy values as opt in', async (t) => {
  const f = fixture(t)
  const before = JSON.stringify(f.state)
  for (const params of [
    { profileIds: ['Default'], categories: { ...all, passwords: 'true' }, keepSpaces: true },
    { profileIds: ['../Default'], categories: all, keepSpaces: true },
    { profileIds: ['Default', 'missing'], categories: all, keepSpaces: true },
    { profileIds: ['Default', null], categories: all, keepSpaces: true },
    { profileIds: [], categories: all, keepSpaces: true },
    { profileIds: 'Default', categories: all, keepSpaces: true },
    { profileId: 'Default', categories: all, keepSpaces: true },
    { profileIds: ['Default'], categories: { tabs: false, openTabs: false, passwords: false, logins: false }, keepSpaces: true },
    { profileIds: ['Default'], categories: all, keepSpaces: 'yes' }
  ]) await assert.rejects(f.importer.run(params), { code: 'bad_params' })
  assert.equal(f.confirmations(), 0)
  assert.equal(f.reads(), 0)
  assert.equal(JSON.stringify(f.state), before)
})

test('batch imports selected profiles once with isolated same-site accounts, sessions and tabs', async (t) => {
  const f = batchFixture(t)
  const params = { profileIds: ['Default', 'Profile 1', 'Default', 'Profile 1'], categories: all, keepSpaces: true }
  const result = await f.importer.run(params)
  assert.deepEqual(f.consent, [['Personal', 'Work']])
  assert.deepEqual(f.readProfiles, ['Default', 'Profile 1'])
  assert.deepEqual(result.profiles.map(({ id, name }) => ({ id, name })), [{ id: 'Default', name: 'Personal' }, { id: 'Profile 1', name: 'Work' }])
  assert.deepEqual([result.spaces, result.favorites, result.pinned, result.tabs], [2, 2, 2, 2])
  assert.deepEqual(result.passwords, { imported: 2, skipped: 0, failed: 0 })
  assert.deepEqual(result.logins, { imported: 2, skipped: 0, failed: 0 })
  assert.equal(f.state.spaces.some((s) => s.name === 'Other'), false)
  assert.equal(f.state.tabs.some((tab) => tab.url.includes('other.example')), false)
  const partitions = []
  for (const profile of result.profiles) {
    assert.deepEqual([profile.spaces, profile.favorites, profile.pinned, profile.tabs], [1, 1, 1, 1])
    assert.deepEqual(profile.passwords, { imported: 1, skipped: 0, failed: 0 })
    assert.deepEqual(profile.logins, { imported: 1, skipped: 0, failed: 0 })
    const space = f.state.spaces.find((s) => s.name === profile.name)
    const partition = 'persist:arc-' + crypto.createHash('sha256').update(profile.id).digest('hex').slice(0, 24)
    assert.equal(space.sessionPartition, partition)
    partitions.push(partition)
    const accounts = f.vault.list('https://shared.example', partition)
    assert.equal(accounts.length, 1)
    assert.deepEqual(f.vault.get(accounts[0].id, 'https://shared.example', partition), { username: 'same-account', password: `synthetic-password-${profile.id}` })
    assert.equal(f.sessions.get(partition)[0].value, `synthetic-session-${profile.id}`)
    assert.equal(f.state.tabs.find((tab) => tab.spaceId === space.id && tab.url === 'https://shared.example/').sessionPartition, partition)
    assert.equal(S.createTab(f.state, { spaceId: space.id, url: 'https://shared.example/new' }, 1).sessionPartition, partition)
    assert.deepEqual(result.warnings.filter((warning) => warning.startsWith(`${profile.name}: `)), profile.warnings.map((warning) => `${profile.name}: ${warning}`))
  }
  assert.notEqual(partitions[0], partitions[1])
  assert.equal(f.sessions.size, 2)
  const firstAccount = f.vault.list('https://shared.example', partitions[0])[0]
  assert.equal(f.vault.get(firstAccount.id, 'https://shared.example', partitions[1]), null)
  assert.equal(fs.readFileSync(path.join(f.root, 'passwords.enc')).includes(Buffer.from('synthetic-password')), false)
  assert.equal(JSON.stringify(result).includes('synthetic-'), false)
  const before = JSON.stringify(f.state)
  f.consent.length = 0
  f.sessions.get(partitions[0])[0].value = 'newer-destination-session'
  const repeated = await f.importer.run(params)
  assert.deepEqual([repeated.spaces, repeated.favorites, repeated.pinned, repeated.tabs], [0, 0, 0, 0])
  assert.deepEqual(repeated.passwords, { imported: 0, skipped: 2, failed: 0 })
  assert.deepEqual(repeated.logins, { imported: 0, skipped: 2, failed: 0 })
  assert.equal(f.sessions.get(partitions[0])[0].value, 'newer-destination-session')
  assert.equal(JSON.stringify(f.state), before)
})

test('batch tabs-only import neither requests consent nor reads any protected profile', async (t) => {
  const f = fixture(t)
  const result = await f.importer.run({ profileIds: ['Default', 'Profile 1'], categories: { tabs: true, openTabs: true, passwords: false, logins: false }, keepSpaces: false })
  assert.deepEqual([result.spaces, result.favorites, result.pinned, result.tabs], [2, 2, 2, 2])
  assert.deepEqual(f.state.spaces.filter((s) => s.sessionPartition?.startsWith('persist:arc-')).map((s) => s.name), ['Arc Personal', 'Arc Work'])
  assert.equal(f.confirmations(), 0)
  assert.equal(f.reads(), 0)
})

test('each sensitive category can be imported alone across profiles', async (t) => {
  for (const category of ['passwords', 'logins']) {
    const f = batchFixture(t)
    const result = await f.importer.run({ profileIds: ['Default', 'Profile 1'], categories: { tabs: false, openTabs: false, passwords: false, logins: false, [category]: true }, keepSpaces: true })
    assert.deepEqual([result.spaces, result.favorites, result.pinned, result.tabs], [2, 0, 0, 0])
    assert.deepEqual(result[category], { imported: 2, skipped: 0, failed: 0 })
    assert.deepEqual(result[category === 'passwords' ? 'logins' : 'passwords'], { imported: 0, skipped: 0, failed: 0 })
    assert.equal(f.sessions.size, category === 'logins' ? 2 : 0)
    assert.equal(fs.existsSync(path.join(f.root, 'passwords.enc')), category === 'passwords')
  }
})

test('unreadable protected profile does not prevent other profiles or invent failure counts', async (t) => {
  const f = batchFixture(t, {
    readSecrets: async ({ profilePath, ...categories }) => {
      if (path.basename(profilePath) === 'Default') throw new Error('synthetic-private-failure')
      const data = secretData('Profile 1', categories)
      data.passwordSkipped = 2
      data.cookieFailed = 3
      data.warnings.push('Some cookies could not be decrypted.')
      return data
    }
  })
  const result = await f.importer.run({ profileIds: ['Default', 'Profile 1'], categories: all, keepSpaces: true })
  assert.deepEqual(result.passwords, { imported: 1, skipped: 2, failed: 0 })
  assert.deepEqual(result.logins, { imported: 1, skipped: 0, failed: 3 })
  assert.deepEqual(result.profiles[0].passwords, { imported: 0, skipped: 0, failed: 0 })
  assert.deepEqual(result.profiles[0].logins, { imported: 0, skipped: 0, failed: 0 })
  assert.match(result.profiles[0].warnings[0], /records were not counted/)
  assert.equal(result.warnings.includes('Work: Some cookies could not be decrypted.'), true)
  assert.deepEqual([result.spaces, result.favorites, result.pinned, result.tabs], [2, 2, 2, 2])
  assert.equal(f.sessions.size, 1)
  const work = f.state.spaces.find((space) => space.name === 'Work')
  assert.equal(f.vault.list('https://shared.example', work.sessionPartition).length, 1)
  assert.equal(JSON.stringify(result).includes('synthetic-'), false)
})

test('a profile completion failure is reported without stopping the batch or losing known counts', async (t) => {
  let changes = 0
  const f = fixture(t, { changed() { if (++changes === 1) throw new Error('private destination error') } })
  const result = await f.importer.run({ profileIds: ['Default', 'Profile 1'], categories: { tabs: true, openTabs: true, passwords: false, logins: false }, keepSpaces: true })
  assert.equal(changes, 2)
  assert.deepEqual([result.spaces, result.favorites, result.pinned, result.tabs], [2, 2, 2, 2])
  assert.match(result.warnings[0], /^Personal: This profile could not be imported completely/)
  assert.deepEqual(result.profiles[1].warnings, [])
  assert.equal(f.state.spaces.some((space) => space.name === 'Work'), true)
  assert.equal(JSON.stringify(result).includes('private destination error'), false)
})

test('one busy guard covers batch consent and all protected reads, then releases', async (t) => {
  let approve, releaseRead, reading
  const consent = new Promise((resolve) => { approve = resolve })
  const heldRead = new Promise((resolve) => { releaseRead = resolve })
  const readStarted = new Promise((resolve) => { reading = resolve })
  const f = fixture(t, {
    confirm: () => consent,
    readSecrets: async ({ profilePath }) => {
      if (path.basename(profilePath) === 'Profile 1') { reading(); await heldRead }
      return secretData('Default', { passwords: false, logins: false })
    },
    vault: { import: () => ({ imported: 0, skipped: 0, failed: 0 }) }
  })
  const params = { profileIds: ['Default', 'Profile 1'], categories: { tabs: true, openTabs: true, passwords: true, logins: false }, keepSpaces: true }
  const running = f.importer.run(params)
  await assert.rejects(f.importer.run(params), /already running/)
  assert.equal(f.state.spaces.some((space) => space.name === 'Personal'), false)
  approve(true)
  await readStarted
  assert.equal(f.state.spaces.some((space) => space.name === 'Personal'), true)
  assert.equal(f.state.spaces.some((space) => space.name === 'Work'), false)
  await assert.rejects(f.importer.run(params), /already running/)
  releaseRead()
  assert.equal((await running).profiles.length, 2)
  const repeated = await f.importer.run({ ...params, categories: { ...params.categories, passwords: false } })
  assert.deepEqual([repeated.spaces, repeated.favorites, repeated.pinned, repeated.tabs], [0, 0, 0, 0])
})

test('batch selection has no small fixed profile limit', async (t) => {
  const profileIds = Array.from({ length: 80 }, (_, i) => `Profile ${i + 10}`)
  const f = fixture(t, {
    discover: () => ({ root: f.root, profiles: profileIds.map((id) => ({ id, name: id, path: path.join(f.root, id) })) })
  })
  const result = await f.importer.run({ profileIds, categories: { tabs: true, openTabs: false, passwords: false, logins: false }, keepSpaces: true })
  assert.equal(result.spaces, 80)
  assert.deepEqual(result.profiles.map((profile) => profile.id), profileIds)
  assert.equal(f.confirmations(), 0)
  assert.equal(f.reads(), 0)
})

test('Arc profile filtering separates favorites and spaces', () => {
  const personal = parseArc(sidebar, { profileId: 'Default' })
  const work = parseArc(sidebar, { profileId: 'Profile 1' })
  assert.deepEqual(personal.spaces.map((s) => s.name), ['Personal'])
  assert.deepEqual(work.spaces.map((s) => s.name), ['Work'])
  assert.equal(personal.favorites[0].url, 'https://personal.example/')
  assert.equal(work.favorites[0].url, 'https://work.example/')
  assert.deepEqual(parseArc(sidebar, { profileId: 'Unknown' }), { spaces: [], favorites: [] })
})

test('each profile keeps its favorites in its own first space', async (t) => {
  const f = fixture(t)
  await f.importer.run({ profileIds: ['Default', 'Profile 1'], categories: { tabs: true, openTabs: true, passwords: false, logins: false }, keepSpaces: true })
  for (const [name, url] of [['Personal', 'https://personal.example/'], ['Work', 'https://work.example/']]) {
    const space = f.state.spaces.find((s) => s.name === name)
    assert.deepEqual(f.state.tabs.filter((tab) => tab.favorite && tab.spaceId === space.id).map((tab) => [tab.url, tab.sessionPartition]), [[url, space.sessionPartition]])
  }
  assert.equal(f.state.tabs.filter((tab) => tab.favorite).length, 2)
})

test('profile sessions survive moving, favoriting, closing, restore and restart', () => {
  const s = S.load()
  const setup = parseArc(sidebar, { profileId: 'Default' })
  setup.sessionPartition = 'persist:arc-' + 'a'.repeat(24)
  S.importSetup(s, setup, 1)
  const space = s.spaces.find((x) => x.name === 'Personal')
  const tab = S.createTab(s, { spaceId: space.id, url: 'https://example.com/' }, 2)
  S.moveTab(s, { id: tab.id, spaceId: s.spaces[0].id }, 3)
  S.setFavorite(s, { id: tab.id, favorite: true }, 4)
  S.setFavorite(s, { id: tab.id, favorite: false }, 5)
  S.closeTab(s, { id: tab.id }, 6)
  S.restore(s, { id: tab.id }, 7)
  const reloaded = S.load(JSON.parse(JSON.stringify(s)))
  assert.equal(S.getTab(reloaded, tab.id).sessionPartition, setup.sessionPartition)
  assert.equal(S.createTab(reloaded, { spaceId: space.id, url: 'https://example.com/' }, 8).sessionPartition, setup.sessionPartition)
  assert.equal(S.createTab(reloaded, { spaceId: s.spaces[0].id, url: 'https://example.com/' }, 8).sessionPartition, 'persist:main')
})

test('metadata import carries space backgrounds end to end without protected reads', async (t) => {
  const f = fixture(t)
  const source = structuredClone(sidebar)
  source.sidebar.containers[0].spaces[1].customInfo = { windowTheme: windowTheme() }
  fs.writeFileSync(path.join(f.root, 'StorableSidebar.json'), JSON.stringify(source))
  const params = { profileIds: ['Default'], categories: { tabs: true, openTabs: true, passwords: false, logins: false }, keepSpaces: true }
  await f.importer.run(params)
  const space = f.state.spaces.find((space) => space.arcSourceId === 'default')
  assert.deepEqual(space.background, parseArc(source, { profileId: 'Default' }).spaces[0].background)
  assert.deepEqual(S.load(JSON.parse(JSON.stringify(f.state))).spaces.find((item) => item.id === space.id).background, space.background)
  S.updateSpace(f.state, { id: space.id, color: '#2f9e5b' })
  await f.importer.run(params)
  assert.equal(space.background, null)
  assert.equal(space.color, '#2f9e5b')
  assert.equal(f.confirmations(), 0)
  assert.equal(f.reads(), 0)
  const merged = fixture(t)
  fs.writeFileSync(path.join(merged.root, 'StorableSidebar.json'), JSON.stringify(source))
  await merged.importer.run({ ...params, keepSpaces: false })
  assert.equal(merged.state.spaces[1].background, undefined, 'merged profile spaces have no single source theme')
})

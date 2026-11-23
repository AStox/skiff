'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createComponents } = require('../src/components')
const { createRegistry } = require('../src/commands')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setup(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-components-')))
  const registry = createRegistry()
  const dir = path.join(root, 'components')
  const runtime = createComponents({ dir, registry, timeouts: { start: 1000, call: 200, stop: 100 }, ...options })
  t.after(async () => { await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, dir, registry, runtime }
}
function writePackage(root, id, { mode = 'normal', child = false, revision = 1, backend = true, capabilities } = {}) {
  const directory = path.join(root, 'input', id)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Notes</title><main>Owned notes surface</main>')
  const manifest = { apiVersion: 1, id, version: `${revision}.0.0`, surfaces: { notes: 'index.html' }, capabilities: capabilities || ['ui', 'storage', 'backend', 'commands.register', 'events:tick'], ...(backend ? { backend: 'backend.js' } : {}) }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ mode, child, revision }))
  if (backend) fs.copyFileSync(path.join(__dirname, 'fixtures', 'component-backend.js'), path.join(directory, 'backend.js'))
  return directory
}
function gatedPackage(root, id, { gate = true, capabilities } = {}) {
  const source = writePackage(root, id, { capabilities })
  const starts = path.join(root, `${id}-starts.jsonl`)
  const stopEntered = path.join(root, `${id}-stop-entered`)
  const stopRelease = path.join(root, `${id}-stop-release`)
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'component-gated-backend.js'), path.join(source, 'backend.js'))
  fs.writeFileSync(path.join(source, 'config.json'), JSON.stringify({ revision: 1, starts, ...(gate ? { stopEntered, stopRelease } : {}) }))
  return { source, starts, stopEntered, stopRelease }
}
async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await delay(15)
  assert.ok(predicate())
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false
    return true
  } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return false; throw error }
}

test('local package lifecycle retains data and prior revisions while swapping only selected roles', async (t) => {
  const replaced = []
  const { root, runtime, registry } = setup(t, { onReplace: (event) => replaced.push(event) })
  await runtime.start()
  const source = writePackage(root, 'local.notes')
  const staged = await runtime.stage({ path: source })
  assert.equal(staged.enabled, false)
  await runtime.apply({ id: 'local.notes' })
  await runtime.bind({ role: 'notes', id: 'local.notes', spaceId: 'work' })
  const initial = runtime.resolve('notes', { spaceId: 'work' })
  assert.equal(initial.owner, 'local.notes')
  assert.equal(runtime.resolve('notes'), null)
  assert.equal(runtime.ownerForFile(initial.file), 'local.notes')
  assert.deepEqual(await registry.call('local.notes.add', { text: 'first' }), [{ text: 'first', revision: 1 }])
  runtime.emit('tick', { value: 9 })
  await until(() => runtime.dataRead({ id: 'local.notes', key: 'event' })?.value === 9)
  await assert.rejects(registry.call('local.notes.forbidden', {}), /not granted/)
  const workspace = runtime.inspect({ id: 'local.notes' }).path
  await runtime.sourceWrite({ id: 'local.notes', file: 'config.json', content: JSON.stringify({ revision: 2 }) })
  await runtime.sourceWrite({ id: 'local.notes', file: 'index.html', content: '<!doctype html><title>Revision two</title>' })
  await runtime.apply({ id: 'local.notes' })
  assert.notEqual(runtime.resolve('notes', { spaceId: 'work' }).revision, initial.revision)
  assert.equal(runtime.inspect({ id: 'local.notes' }).previous, initial.revision)
  const notes = await registry.call('local.notes.add', { text: 'second' })
  assert.deepEqual(notes, [{ text: 'first', revision: 1 }, { text: 'second', revision: 2 }])
  await runtime.revert({ id: 'local.notes' })
  assert.equal(runtime.resolve('notes', { spaceId: 'work' }).revision, initial.revision)
  assert.equal((await registry.call('local.notes.add', { text: 'third' }))[2].revision, 1)
  assert.match(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), /Revision two/)
  const oldBridge = runtime.bridge('local.notes')
  await runtime.disable({ id: 'local.notes' })
  assert.equal(registry.has('local.notes.add'), false)
  assert.equal(runtime.resolve('notes', { spaceId: 'work' }), null)
  assert.throws(() => oldBridge.storage.read('notes'), /no longer active/)
  await runtime.enable({ id: 'local.notes' })
  assert.equal(runtime.dataRead({ id: 'local.notes', key: 'notes' }).length, 3)
  const dataPath = runtime.inspect({ id: 'local.notes' }).dataPath
  await runtime.remove({ id: 'local.notes' })
  assert.ok(fs.existsSync(dataPath))
  await runtime.stage({ path: source }); await runtime.apply({ id: 'local.notes' })
  assert.equal(runtime.dataRead({ id: 'local.notes', key: 'notes' }).length, 3)
  await runtime.remove({ id: 'local.notes', deleteData: true })
  assert.equal(fs.existsSync(dataPath), false)
  assert.ok(replaced.some((event) => event.action === 'revert'))
})

test('bad manifests, namespace collisions, symlinks, private storage and traversal fail closed', async (t) => {
  const { root, runtime, registry } = setup(t, { state: () => ({ spaces: [{ id: 'private', incognito: true }] }) })
  await runtime.start()
  const source = writePackage(root, 'local.boundary', { backend: false, capabilities: ['ui', 'storage'] })
  const manifestFile = path.join(source, 'manifest.json')
  const original = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  for (const patch of [{ apiVersion: 2 }, { id: '../escape' }, { id: 'stock.override' }, { surfaces: { notes: '../outside.html' } }, { capabilities: ['electron'] }]) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...original, ...patch }))
    assert.equal(runtime.check({ path: source }).ok, false)
    await assert.rejects(runtime.stage({ path: source }))
  }
  fs.writeFileSync(manifestFile, JSON.stringify(original))
  fs.symlinkSync(manifestFile, path.join(source, 'escape.json'))
  assert.equal(runtime.check({ path: source }).ok, false)
  fs.unlinkSync(path.join(source, 'escape.json'))
  await runtime.stage({ path: source }); await runtime.apply({ id: original.id })
  const api = runtime.bridge(original.id)
  assert.throws(() => api.storage.write('../outside', 'bad'), /relative path/)
  assert.throws(() => api.storage.write('secret', 'bad', { spaceId: 'private' }), /Private/)
  assert.throws(() => api.source.read('manifest.json'), /not granted/)
  assert.throws(() => api.register({ name: 'core.override', run() {} }), /not granted/)
  await assert.rejects(runtime.create({ id: original.id }), /duplicate/)
  await assert.rejects(runtime.create({ id: 'stock.test' }), /reserved/)
  assert.throws(() => runtime.inspect({ id: 'constructor' }), /Unknown/)
  const writable = runtime.inspect({ id: original.id }).dataPath
  fs.mkdirSync(writable, { recursive: true })
  fs.symlinkSync(root, path.join(writable, 'v1'))
  assert.throws(() => api.storage.write('escape', 'bad'), /Symlink/)
  assert.equal(fs.existsSync(path.join(root, 'global', 'escape.json')), false)
  registry.register('core', { name: 'local.collision.add', description: 'Collision', inputSchema: { type: 'object' }, run: () => 7 })
  const collision = writePackage(root, 'local.collision')
  await runtime.stage({ path: collision })
  await assert.rejects(runtime.apply({ id: 'local.collision' }), /already|collision|registered|Duplicate/i)
  assert.equal(await registry.call('local.collision.add'), 7)
})

test('partial activation failure restores prior code and cleans owned child processes without touching other workers', async (t) => {
  const { root, runtime, registry } = setup(t)
  await runtime.start()
  const good = writePackage(root, 'local.recovery', { child: true })
  const other = writePackage(root, 'local.other', { child: true })
  await runtime.stage({ path: good }); await runtime.apply({ id: 'local.recovery' })
  await runtime.stage({ path: other }); await runtime.apply({ id: 'local.other' })
  const first = runtime.inspect({ id: 'local.recovery' }).revision
  const oldProcess = runtime.dataRead({ id: 'local.recovery', key: 'child' })
  const otherProcess = runtime.dataRead({ id: 'local.other', key: 'child' })
  const bad = writePackage(root, 'local.recovery', { mode: 'fail', child: true, revision: 2 })
  await runtime.stage({ path: bad })
  await assert.rejects(runtime.apply({ id: 'local.recovery' }), /partial activation/)
  assert.equal(runtime.inspect({ id: 'local.recovery' }).revision, first)
  assert.equal(runtime.inspect({ id: 'local.recovery' }).running, true)
  assert.equal((await registry.call('local.recovery.add', { text: 'recovered' }))[0].revision, 1)
  await until(() => !alive(oldProcess.pid) && !alive(oldProcess.parent))
  const partialProcess = runtime.dataRead({ id: 'local.recovery', key: 'children' })[1]
  await until(() => !alive(partialProcess.pid) && !alive(partialProcess.parent))
  assert.equal(alive(otherProcess.parent), true)
  assert.equal((await registry.call('local.other.add', { text: 'unaffected' }))[0].text, 'unaffected')
})

test('startup, call and shutdown hangs are bounded and remove all owned workers and commands', async (t) => {
  const { root, runtime, registry } = setup(t)
  await runtime.start()
  for (const mode of ['hang-start', 'normal', 'hang-stop']) {
    const id = 'local.' + mode
    await runtime.stage({ path: writePackage(root, id, { mode, child: true }) })
    if (mode === 'hang-start') await assert.rejects(runtime.apply({ id }), /timed out/)
    else {
      await runtime.apply({ id })
      if (mode === 'normal') await assert.rejects(registry.call(`${id}.hang`), /timed out|cancelled|stopped/i)
      else await runtime.disable({ id })
    }
    const owned = runtime.dataRead({ id, key: 'child' })
    assert.ok(owned?.pid)
    await until(() => !alive(owned.parent) && !alive(owned.pid))
    assert.equal(runtime.inspect({ id }).running, false)
    assert.equal(registry.has(`${id}.add`), false)
  }
})

test('legacy whole-shell import is byte-preserving and later bundled updates do not overwrite user copies', async (t) => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-legacy-'))
  t.after(() => fs.rmSync(legacy, { recursive: true, force: true }))
  fs.mkdirSync(path.join(legacy, 'assets'))
  fs.writeFileSync(path.join(legacy, 'index.html'), '<!doctype html>unrecorded edits')
  fs.writeFileSync(path.join(legacy, 'assets', 'custom.bin'), Buffer.from([0, 1, 255, 2]))
  fs.writeFileSync(path.join(legacy, 'unknown.js'), 'custom feature')
  const { runtime } = setup(t, { legacyShellDir: legacy })
  await runtime.start()
  const imported = runtime.inspect({ id: 'legacy.shell' })
  assert.equal(imported.origin.fullShell, true)
  for (const file of ['index.html', 'unknown.js', 'assets/custom.bin']) {
    const original = fs.readFileSync(path.join(legacy, file))
    assert.deepEqual(fs.readFileSync(path.join(imported.path, file)), original)
    assert.deepEqual(fs.readFileSync(path.join(imported.origin.backup, file)), original)
  }
  await runtime.create({ id: 'my.shell', from: 'legacy.shell' })
  await runtime.sourceWrite({ id: 'my.shell', file: 'unknown.js', content: 'owned edit' })
  await runtime.apply({ id: 'my.shell' })
  await runtime.stop()
  fs.writeFileSync(path.join(legacy, 'unknown.js'), 'new live host content')
  await runtime.start()
  assert.equal(runtime.sourceRead({ id: 'my.shell', file: 'unknown.js' }).content, 'owned edit')
  assert.equal(runtime.sourceRead({ id: 'legacy.shell', file: 'unknown.js' }).content, 'custom feature')
  assert.equal(runtime.inspect({ id: 'my.shell' }).origin.id, 'legacy.shell')
})

test('stock backend copies execute the same API with their own namespace and explicit role binding', async (t) => {
  const { runtime, registry } = setup(t)
  registry.register('core', { name: 'host.search', description: 'Resolve URL', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, run: ({ text }) => ({ url: new URL(text).href }) })
  const stockRoot = path.join(__dirname, '..', 'components', 'search')
  runtime.registerStock({ root: stockRoot, manifest: JSON.parse(fs.readFileSync(path.join(stockRoot, 'manifest.json'), 'utf8')) })
  await runtime.start()
  assert.equal(runtime.resolve('search').owner, 'stock.search')
  await runtime.create({ id: 'my.search', from: 'stock.search' })
  await runtime.apply({ id: 'my.search' })
  assert.deepEqual(await registry.call('my.search.run', { text: 'https://example.test' }), { url: 'https://example.test/' })
  assert.equal(runtime.resolve('search').owner, 'stock.search')
  await runtime.bind({ role: 'search', id: 'my.search' })
  assert.equal(runtime.resolve('search').command, 'my.search.run')
  await runtime.start({ safeMode: true })
  assert.equal(runtime.inspect({ id: 'my.search' }).running, false)
  assert.equal(runtime.inspect({ id: 'my.search' }).enabled, true)
  assert.equal(runtime.resolve('search').owner, 'stock.search')
  assert.equal(runtime.resolve('search').source, 'default')
  await runtime.start({ safeMode: false })
  assert.equal(runtime.resolve('search').owner, 'my.search')
})

test('owned copies that still match their recorded source follow a changed stock; edited copies and legacy imports stay put', async (t) => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-legacy-follow-'))
  t.after(() => fs.rmSync(legacy, { recursive: true, force: true }))
  fs.writeFileSync(path.join(legacy, 'index.html'), '<!doctype html>legacy')
  const replaced = []
  const { root, runtime } = setup(t, { legacyShellDir: legacy, onReplace: (event) => replaced.push(event) })
  const stockRoot = writePackage(root, 'stock.notes', { backend: false, capabilities: ['ui'] })
  const manifest = JSON.parse(fs.readFileSync(path.join(stockRoot, 'manifest.json'), 'utf8'))
  runtime.registerStock({ root: stockRoot, manifest })
  await runtime.start()
  const stockPage = (text) => fs.writeFileSync(path.join(stockRoot, 'index.html'), `<!doctype html><main>${text}</main>`)
  const page = (id) => runtime.sourceRead({ id, file: 'index.html' }).content
  const revision = (id) => runtime.inspect({ id }).revision
  const ids = ['my.plain', 'my.edited', 'my.draft', 'my.unapplied']
  for (const id of ids) await runtime.create({ id, from: 'stock.notes' })
  assert.match(runtime.inspect({ id: 'my.plain' }).origin.sourceHash, /^[a-f0-9]{64}$/)
  for (const id of ids.slice(0, 3)) await runtime.apply({ id })
  await runtime.sourceWrite({ id: 'my.edited', file: 'index.html', content: 'mine' })
  await runtime.apply({ id: 'my.edited' })
  await runtime.sourceWrite({ id: 'my.draft', file: 'index.html', content: 'draft' })
  const before = Object.fromEntries([...ids, 'legacy.shell'].map((id) => [id, revision(id)]))
  assert.equal(runtime.inspect({ id: 'legacy.shell' }).origin.type, 'legacy')

  await runtime.stop()
  stockPage('first stock update')
  await runtime.start()
  assert.match(page('my.plain'), /first stock update/)
  assert.match(page('my.unapplied'), /first stock update/)
  assert.notEqual(revision('my.plain'), before['my.plain'])
  assert.equal(runtime.inspect({ id: 'my.plain' }).previous, before['my.plain'])
  assert.equal(runtime.inspect({ id: 'my.plain' }).running, true)
  assert.equal(page('my.edited'), 'mine')
  assert.equal(page('my.draft'), 'draft')
  for (const id of ['my.edited', 'my.draft', 'legacy.shell']) assert.equal(revision(id), before[id])
  const followed = revision('my.plain')
  await runtime.stop()
  await runtime.start()
  assert.equal(revision('my.plain'), followed)

  replaced.length = 0
  stockPage('second stock update')
  await runtime.refreshStock({ id: 'stock.notes', root: stockRoot, manifest })
  assert.match(page('my.plain'), /second stock update/)
  assert.notEqual(revision('my.plain'), followed)
  assert.equal(runtime.inspect({ id: 'my.plain' }).previous, followed)
  assert.ok(replaced.some((event) => event.id === 'my.plain' && event.action === 'apply'))
  assert.equal(page('my.edited'), 'mine')
  assert.equal(revision('my.edited'), before['my.edited'])
})

test('a copy does not follow when the new stock asks for capabilities it was never granted', async (t) => {
  const { root, runtime } = setup(t)
  const stockRoot = writePackage(root, 'stock.notes', { backend: false, capabilities: ['ui'] })
  const manifest = JSON.parse(fs.readFileSync(path.join(stockRoot, 'manifest.json'), 'utf8'))
  runtime.registerStock({ root: stockRoot, manifest })
  await runtime.start()
  await runtime.create({ id: 'my.notes', from: 'stock.notes' })
  await runtime.apply({ id: 'my.notes' })
  const before = runtime.inspect({ id: 'my.notes' }).revision
  fs.writeFileSync(path.join(stockRoot, 'index.html'), '<!doctype html><main>new</main>')
  await runtime.refreshStock({ id: 'stock.notes', root: stockRoot, manifest: { ...manifest, capabilities: ['ui', 'host.manage'] } })
  assert.equal(runtime.inspect({ id: 'my.notes' }).revision, before)
  assert.doesNotMatch(runtime.sourceRead({ id: 'my.notes', file: 'index.html' }).content, /new/)
})

test('preview uses an immutable staged path and excludes backend execution by default', async (t) => {
  let request
  const { root, runtime } = setup(t, { preview: async (params) => { request = params; return { launched: true } } })
  await runtime.start()
  await runtime.stage({ path: writePackage(root, 'local.preview', { mode: 'hang-start' }) })
  assert.deepEqual(await runtime.preview({ id: 'local.preview' }), { launched: true })
  assert.equal(request.backend, false)
  assert.ok(fs.existsSync(path.join(request.path, 'manifest.json')))
  assert.equal(runtime.inspect({ id: 'local.preview' }).running, false)
  assert.equal(runtime.dataRead({ id: 'local.preview', key: 'child' }), null)
})

test('surface activation failure rolls back code and explicit grants restrict the shared UI API', async (t) => {
  let rejectSurface = false
  const { root, runtime } = setup(t, { onReplace: (event) => {
    if (rejectSurface && event.action === 'apply') throw new Error('Surface failed to load')
  } })
  await runtime.start()
  await runtime.stage({ path: writePackage(root, 'local.surface', { backend: false, capabilities: ['ui', 'storage', 'source', 'call:state.get'] }) })
  await runtime.apply({ id: 'local.surface', grants: ['ui', 'source'] })
  await runtime.bind({ role: 'notes', id: 'local.surface' })
  const first = runtime.resolve('notes')
  const api = runtime.bridge('local.surface')
  assert.throws(() => api.storage.write('notes', []), /not granted/)
  assert.throws(() => runtime.authorize('local.surface', 'state.get'), /not granted/)
  assert.throws(() => runtime.authorize('local.surface', 'components.storage.read'), /not granted/)
  await api.source.write('index.html', '<!doctype html><title>Changed surface</title>')
  assert.match(api.source.read('index.html').content, /Changed surface/)
  assert.doesNotMatch(fs.readFileSync(first.file, 'utf8'), /Changed surface/)
  rejectSurface = true
  await assert.rejects(runtime.apply({ id: 'local.surface' }), /Surface failed/)
  assert.equal(runtime.resolve('notes').revision, first.revision)
  assert.deepEqual(runtime.inspect({ id: 'local.surface' }).grants, ['ui', 'source'])
  assert.equal(runtime.inspect({ id: 'local.surface' }).running, true)
  await assert.rejects(runtime.bind({ role: 'notes', id: 'local.surface', spaceId: '__proto__' }), /Invalid role/)
})

test('refreshing stock shell files preserves custom global and space role selections', async (t) => {
  const { root, runtime } = setup(t)
  const first = writePackage(root, 'stock.shell', { backend: false, capabilities: ['ui'] })
  const second = writePackage(root, 'stock.other', { backend: false, capabilities: ['ui'] })
  const manifest = { apiVersion: 1, id: 'stock.shell', version: '1.0.0', surfaces: { shell: 'index.html', frame: 'index.html' }, capabilities: ['ui'] }
  runtime.registerStock({ root: first, manifest })
  await runtime.start()
  await runtime.create({ id: 'my.frame', role: 'frame' })
  await runtime.apply({ id: 'my.frame' })
  await runtime.bind({ role: 'frame', id: 'my.frame' })
  await runtime.bind({ role: 'frame', id: 'my.frame', spaceId: 'custom' })
  await runtime.bind({ role: 'frame', id: 'stock.shell', spaceId: 'stock' })
  const oldBridge = runtime.bridge('stock.shell')
  const next = { ...manifest, surfaces: { shell: 'index.html', launcher: 'index.html' } }
  await runtime.refreshStock({ id: 'stock.shell', root: second, manifest: next })
  assert.equal(runtime.resolve('shell').file, path.join(second, 'index.html'))
  assert.equal(runtime.resolve('launcher').owner, 'stock.shell')
  assert.equal(runtime.resolve('frame').owner, 'my.frame')
  assert.equal(runtime.resolve('frame', { spaceId: 'custom' }).owner, 'my.frame')
  assert.equal(runtime.inspect().bindings.spaces.stock.frame, undefined)
  assert.equal(runtime.inspect({ id: 'stock.shell' }).manifest.surfaces.frame, undefined)
  assert.throws(() => oldBridge.on('state', () => {}), /no longer active/)
  await assert.rejects(runtime.refreshStock({ id: 'stock.shell', root: second, manifest: { ...next, surfaces: { shell: 'missing.html' } } }), /Missing/)
  assert.equal(runtime.resolve('shell').file, path.join(second, 'index.html'))
  await runtime.disable({ id: 'stock.shell' })
  await runtime.refreshStock({ id: 'stock.shell', root: first, manifest })
  assert.equal(runtime.inspect({ id: 'stock.shell' }).running, false)
  assert.equal(runtime.inspect({ id: 'stock.shell' }).enabled, false)
  assert.equal(runtime.resolve('frame').owner, 'my.frame')
})

test('external restaging reconciles editable source and previews the exact next activation', async (t) => {
  let previewed
  const { root, runtime } = setup(t, { preview: async (request) => { previewed = request; return { revision: request.revision } } })
  await runtime.start()
  const source = writePackage(root, 'local.candidate', { backend: false, capabilities: ['ui'] })
  await runtime.stage({ path: source })
  await runtime.apply({ id: 'local.candidate' })
  await runtime.sourceWrite({ id: 'local.candidate', file: 'unsaved.txt', content: 'Keep this local source edit' })
  fs.writeFileSync(path.join(source, 'index.html'), '<!doctype html><title>External revision B</title>')
  const staged = await runtime.stage({ path: source })
  assert.equal(fs.readFileSync(path.join(staged.sourceBackup, 'unsaved.txt'), 'utf8'), 'Keep this local source edit')
  assert.match(runtime.sourceRead({ id: staged.id, file: 'index.html' }).content, /External revision B/)
  await runtime.preview({ id: staged.id })
  assert.equal(previewed.revision, staged.staged)
  assert.match(fs.readFileSync(path.join(previewed.path, 'index.html'), 'utf8'), /External revision B/)
  const applied = await runtime.apply({ id: staged.id })
  assert.equal(applied.revision, previewed.revision)
  // An editor writing directly to the exposed workspace is also detected.
  fs.writeFileSync(path.join(applied.path, 'index.html'), '<!doctype html><title>Editor revision C</title>')
  await runtime.preview({ id: staged.id })
  assert.match(fs.readFileSync(path.join(previewed.path, 'index.html'), 'utf8'), /Editor revision C/)
  assert.equal((await runtime.apply({ id: staged.id })).revision, previewed.revision)
})

test('old and deferred bridges cannot mutate through a replacement generation', async (t) => {
  let mutations = 0
  const { root, runtime, registry } = setup(t)
  registry.register('core', { name: 'host.mutate', description: 'Count authorized mutations', inputSchema: { type: 'object' }, run: () => ++mutations })
  await runtime.start()
  await runtime.stage({ path: writePackage(root, 'local.identity', { backend: false, capabilities: ['ui', 'call:host.mutate'] }) })
  await runtime.apply({ id: 'local.identity', grants: ['ui'] })
  const old = runtime.bridge('local.identity')
  await runtime.apply({ id: 'local.identity' })
  assert.throws(() => old.call('host.mutate'), /no longer active/)
  assert.equal(mutations, 0)
  const current = runtime.bridge('local.identity')
  const stopping = runtime.disable({ id: 'local.identity' })
  const pending = current.call('host.mutate')
  await assert.rejects(pending, /no longer active/)
  await stopping
  assert.equal(mutations, 0)
  await runtime.enable({ id: 'local.identity' })
  assert.equal(await runtime.bridge('local.identity').call('host.mutate'), 1)
})

test('host-selected ancestor aliases work while package and internal symlinks remain rejected', async (t) => {
  const { root } = setup(t)
  const real = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  fs.mkdirSync(real)
  fs.symlinkSync(real, alias, 'dir')
  const registry = createRegistry()
  const runtime = createComponents({ dir: path.join(alias, 'profile'), registry })
  t.after(() => runtime.stop())
  await runtime.start()
  const source = writePackage(real, 'local.alias', { backend: false, capabilities: ['ui', 'storage'] })
  const aliasedSource = path.join(alias, 'input', 'local.alias')
  assert.equal(runtime.check({ path: aliasedSource }).ok, true)
  await runtime.stage({ path: aliasedSource })
  await runtime.apply({ id: 'local.alias' })
  runtime.bridge('local.alias').storage.write('note', { saved: true })
  assert.deepEqual(runtime.dataRead({ id: 'local.alias', key: 'note' }), { saved: true })
  assert.ok(runtime.inspect({ id: 'local.alias' }).path.startsWith(real + path.sep))
  const linkedPackage = path.join(real, 'linked-package')
  fs.symlinkSync(source, linkedPackage, 'dir')
  assert.equal(runtime.check({ path: linkedPackage }).ok, false)
  fs.symlinkSync(path.join(source, 'index.html'), path.join(source, 'linked.html'))
  assert.equal(runtime.check({ path: aliasedSource }).ok, false)
  await assert.rejects(runtime.stage({ path: aliasedSource }), /Unsupported|Symlink/)
})

test('failed rollback surface notification stops the restored backend before disabling it', async (t) => {
  let rejectReplacement = false
  const { root, runtime, registry } = setup(t, { onReplace: ({ action }) => {
    if (rejectReplacement && (action === 'apply' || action === 'rollback')) throw new Error(`${action} surface failed`)
  } })
  await runtime.start()
  await runtime.stage({ path: writePackage(root, 'local.rollback', { child: true }) })
  await runtime.apply({ id: 'local.rollback' })
  await runtime.sourceWrite({ id: 'local.rollback', file: 'config.json', content: JSON.stringify({ revision: 2, child: true }) })
  rejectReplacement = true
  await assert.rejects(runtime.apply({ id: 'local.rollback' }), /recovery failed: rollback surface failed/)
  const info = runtime.inspect({ id: 'local.rollback' })
  assert.equal(info.enabled, false)
  assert.equal(info.running, false)
  assert.equal(info.stopping, false)
  assert.equal(registry.has('local.rollback.add'), false)
  for (const child of runtime.dataRead({ id: 'local.rollback', key: 'children' })) {
    await until(() => !alive(child.pid) && !alive(child.parent))
  }
})

test('copying editable source preserves the edited manifest and records its actual provenance', async (t) => {
  const { root, runtime, registry } = setup(t)
  await runtime.start()
  await runtime.stage({ path: writePackage(root, 'local.original', { backend: false, capabilities: ['ui'] }) })
  const original = await runtime.apply({ id: 'local.original' })
  const edited = JSON.parse(runtime.sourceRead({ id: original.id, file: 'manifest.json' }).content)
  edited.version = '2.0.0'
  edited.backend = 'updated-backend.js'
  edited.capabilities = ['ui', 'storage', 'backend', 'commands.register', 'events:tick']
  edited.surfaces.detail = 'detail.html'
  await runtime.sourceWrite({ id: original.id, file: 'updated-backend.js', content: fs.readFileSync(path.join(__dirname, 'fixtures', 'component-backend.js'), 'utf8') })
  await runtime.sourceWrite({ id: original.id, file: 'detail.html', content: '<!doctype html><title>Details</title>' })
  await runtime.sourceWrite({ id: original.id, file: 'manifest.json', content: JSON.stringify(edited) })
  const copy = await runtime.create({ id: 'local.copy', from: original.id })
  assert.equal(copy.manifest.version, '2.0.0')
  assert.equal(copy.manifest.backend, 'updated-backend.js')
  assert.equal(copy.manifest.surfaces.detail, 'detail.html')
  assert.equal(copy.origin.source, 'workspace')
  assert.equal(copy.origin.baseRevision, original.revision)
  assert.equal(copy.origin.sourceRevision, runtime.check({ id: original.id }).revision)
  assert.notEqual(copy.origin.sourceRevision, original.revision)
  await runtime.apply({ id: copy.id })
  assert.equal((await registry.call('local.copy.add', { text: 'Stored from the copied backend' }))[0].text, 'Stored from the copied backend')
  assert.equal(runtime.inspect({ id: original.id }).manifest.backend, undefined)
})

test('approved revisions are checked inside queued apply, enable and revert without restaging', async (t) => {
  const { root, dir, runtime, registry } = setup(t)
  runtime.register()
  await runtime.start()
  const id = 'local.approved'
  const source = writePackage(root, id, { backend: false, capabilities: ['ui'] })
  const firstStage = await runtime.stage({ path: source })
  const first = await registry.call('components.apply', { id, expectedRevision: firstStage.staged })
  writePackage(root, id, { revision: 2, backend: false, capabilities: ['ui'] })
  const approved = await runtime.stage({ path: source })
  writePackage(root, id, { revision: 3, backend: false, capabilities: ['ui'] })
  const queuedStage = runtime.stage({ path: source })
  const rejectedApply = assert.rejects(registry.call('components.apply', { id, expectedRevision: approved.staged }), /changed after approval/)
  const replacement = await queuedStage
  await rejectedApply
  assert.equal(runtime.inspect({ id }).revision, first.revision)
  assert.equal(runtime.inspect({ id }).staged, replacement.staged)
  fs.writeFileSync(path.join(replacement.path, 'index.html'), '<!doctype html><title>Changed after consent</title>')
  await assert.rejects(runtime.apply({ id, expectedRevision: replacement.staged }), /workspace changed after approval/)
  assert.equal(runtime.inspect({ id }).staged, replacement.staged)
  const reviewed = await runtime.stage({ path: replacement.path })
  const next = await runtime.apply({ id, expectedRevision: reviewed.staged })
  await assert.rejects(registry.call('components.revert', { id, expectedRevision: approved.staged }), /changed after approval/)
  assert.equal(runtime.inspect({ id }).revision, next.revision)
  await runtime.disable({ id })
  await assert.rejects(registry.call('components.enable', { id, expectedRevision: first.revision }), /changed after approval/)
  assert.equal(runtime.inspect({ id }).running, false)
  await registry.call('components.enable', { id, expectedRevision: next.revision })
  await registry.call('components.revert', { id, expectedRevision: first.revision })
  assert.equal(runtime.inspect({ id }).revision, first.revision)
  const tampered = await runtime.stage({ path: source })
  fs.writeFileSync(path.join(dir, 'revisions', id, tampered.staged, 'index.html'), '<!doctype html><title>Tampered approved snapshot</title>')
  await assert.rejects(runtime.apply({ id, expectedRevision: tampered.staged }), /snapshot changed/)
  assert.equal(runtime.inspect({ id }).revision, first.revision)
})

test('backend tools preserve opaque caller scope and reject expired or unassociated nested requests', async (t) => {
  const allowed = Object.freeze({})
  const denied = Object.freeze({})
  let mutations = 0
  let releaseWait, signalWaitStarted
  let waitStarted = new Promise((resolve) => { signalWaitStarted = resolve })
  const contexts = []
  const { root, runtime, registry } = setup(t, { call: async (name, params, context) => {
    contexts.push(context.accessContext)
    // Background component requests are trusted by their declared capability;
    // an agent request must never silently fall back to this branch.
    if (context.accessContext && context.accessContext !== allowed) throw Object.assign(new Error('Agent mutation denied'), { code: 'forbidden' })
    if (name === 'host.barrier') return { started: true }
    if (name === 'host.wait') {
      assert.equal(context.accessContext, allowed)
      signalWaitStarted()
      await new Promise((resolve) => { releaseWait = resolve })
      context.signal.throwIfAborted()
    }
    return { count: ++mutations }
  } })
  await runtime.start()
  const id = 'local.scoped'
  const source = writePackage(root, id, { capabilities: ['ui', 'backend', 'commands.register', 'call:host.mutate', 'call:host.wait', 'call:host.barrier', 'events:background'] })
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'component-scope-backend.js'), path.join(source, 'backend.js'))
  await runtime.stage({ path: source })
  await runtime.apply({ id })
  await assert.rejects(registry.call(`${id}.mutate`, {}, { accessContext: denied }), /Agent mutation denied/)
  assert.equal(mutations, 0)
  assert.deepEqual(await registry.call(`${id}.mutate`, {}, { accessContext: allowed }), { count: 1 })
  assert.equal(contexts[0], denied)
  assert.equal(contexts[1], allowed)
  assert.equal(registry.get(`${id}.mutate`).tool, true)
  await registry.call(`${id}.late`, {}, { accessContext: allowed })
  await registry.call(`${id}.unassociated`, {}, { accessContext: allowed })
  let status
  const deadline = Date.now() + 3000
  do {
    status = await registry.call(`${id}.status`)
    if (status.late !== 'waiting' && status.unassociated !== 'waiting') break
    await delay(15)
  } while (Date.now() < deadline)
  assert.equal(status.late, 'cancelled')
  assert.equal(status.unassociated, 'forbidden')
  assert.equal(mutations, 1)
  runtime.emit('background', {})
  await until(() => mutations === 2)
  const controller = new AbortController()
  const waiting = registry.call(`${id}.wait`, {}, { accessContext: allowed, signal: controller.signal })
  const rejected = assert.rejects(waiting, /cancel|abort/i)
  await waitStarted
  controller.abort()
  await rejected
  releaseWait()
  await delay(30)
  assert.equal(mutations, 2)
  waitStarted = new Promise((resolve) => { signalWaitStarted = resolve })
  await registry.call(`${id}.fire`, {}, { accessContext: allowed })
  await waitStarted
  releaseWait()
  const completionDeadline = Date.now() + 3000
  do {
    status = await registry.call(`${id}.status`)
    if (status.inFlight !== 'waiting') break
    await delay(15)
  } while (Date.now() < completionDeadline)
  assert.equal(status.inFlight, 'cancelled')
  assert.equal(mutations, 2)
})

for (const [label, contents] of [
  ['invalid JSON', '{\"version\":'],
  ['invalid schema', JSON.stringify({ version: 1, components: [], bindings: { global: {}, spaces: {} } })],
]) test(`safe mode recovers ${label} with stock components and preserves the original composition`, async (t) => {
  const { root, dir, runtime } = setup(t)
  const stockRoot = writePackage(root, 'stock.recovery', { backend: false, capabilities: ['ui'] })
  runtime.registerStock({ root: stockRoot, manifest: JSON.parse(fs.readFileSync(path.join(stockRoot, 'manifest.json'), 'utf8')) })
  fs.mkdirSync(dir, { recursive: true })
  const composition = path.join(dir, 'composition.json')
  fs.writeFileSync(composition, contents)
  const savedSource = path.join(dir, 'packages', 'local.saved', 'index.html')
  fs.mkdirSync(path.dirname(savedSource), { recursive: true })
  fs.writeFileSync(savedSource, 'Unrecorded user source')
  await assert.rejects(runtime.start(), /--safe-mode/)
  assert.equal(fs.readFileSync(composition, 'utf8'), contents)
  await runtime.start({ safeMode: true })
  const recovered = runtime.inspect()
  assert.equal(recovered.safeMode, true)
  assert.ok(recovered.recovery.error)
  assert.match(recovered.recovery.backup, /recovery[/\\]composition-[^/\\]+\.json$/)
  assert.equal(fs.readFileSync(recovered.recovery.backup, 'utf8'), contents)
  assert.deepEqual(runtime.list().map((item) => item.id), ['stock.recovery'])
  assert.equal(runtime.resolve('notes').owner, 'stock.recovery')
  assert.equal(fs.readFileSync(savedSource, 'utf8'), 'Unrecorded user source')
  assert.equal(JSON.parse(fs.readFileSync(composition, 'utf8')).version, 1)
})

test('shutdown cleans every owned worker even when the first backend disposer throws', async (t) => {
  const { root, runtime, registry } = setup(t)
  await runtime.start()
  const owned = []
  for (const [id, mode] of [['local.failedstop', 'fail-stop'], ['local.otherstop', 'normal']]) {
    await runtime.stage({ path: writePackage(root, id, { mode, child: true }) })
    await runtime.apply({ id })
    owned.push({ id, ...runtime.dataRead({ id, key: 'child' }) })
  }
  await assert.rejects(runtime.stop(), /Intentional disposer failure/)
  for (const child of owned) {
    await until(() => !alive(child.pid) && !alive(child.parent))
    assert.equal(runtime.inspect({ id: child.id }).running, false)
    assert.equal(runtime.inspect({ id: child.id }).stopping, false)
    assert.equal(registry.has(`${child.id}.add`), false)
  }
})

test('component scalar properties resolve provenance and persist scoped overrides through lifecycle changes', async (t) => {
  const notifications = []
  const { root, dir, runtime, registry } = setup(t, {
    state: () => ({ spaces: [{ id: 'work' }, { id: 'private', incognito: true }] }),
    onSettingsChanged: (entry) => notifications.push(entry),
  })
  runtime.register()
  await runtime.start()
  const id = 'local.preferences'
  const source = writePackage(root, id, { capabilities: ['ui', 'backend', 'commands.register', 'storage'] })
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'component-settings-backend.js'), path.join(source, 'backend.js'))
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  manifest.settings = {
    theme: { type: 'string', default: 'system', scope: 'space', title: 'Reading theme', aliases: ['palette'], enum: ['system', 'light', 'dark'] },
    compact: { type: 'boolean', default: false, scope: 'global', title: 'Compact notes' },
    size: { type: 'integer', default: 12, scope: 'space', minimum: 8, maximum: 24 },
  }
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest))
  await runtime.stage({ path: source })
  const first = await runtime.apply({ id })
  await runtime.create({ id: 'local.otherprefs', from: id })
  await runtime.apply({ id: 'local.otherprefs' })
  const defaults = await registry.call('components.settings.list', { id, query: 'palette' })
  assert.equal(defaults.length, 1)
  assert.equal(defaults[0].id, `${id}.theme`)
  assert.equal(defaults[0].owner, id)
  assert.equal(defaults[0].value, 'system')
  assert.equal(defaults[0].source, 'default')
  const global = await registry.call('components.settings.set', { id, key: 'theme', value: 'light' })
  assert.equal(global.source, 'global')
  assert.equal(runtime.settingsGet({ id, key: 'theme', spaceId: 'work' }).value, 'light')
  const scoped = await registry.call(`${id}.preference`, { op: 'set', key: 'theme', value: 'dark', spaceId: 'work' })
  assert.equal(scoped.source, 'space')
  assert.equal(scoped.spaceId, 'work')
  assert.equal(runtime.settingsGet({ id, key: 'theme' }).value, 'light')
  assert.equal(runtime.settingsGet({ id: 'local.otherprefs', key: 'theme', spaceId: 'work' }).value, 'system')
  await registry.call('components.settings.set', { id, key: 'compact', value: true })
  assert.equal(runtime.settingsGet({ id, key: 'compact', spaceId: 'work' }).source, 'global')
  await assert.rejects(registry.call('components.settings.set', { id, key: 'compact', value: false, spaceId: 'work' }), /global setting/)
  await assert.rejects(registry.call('components.settings.set', { id, key: 'size', value: 100 }), /range/)
  await assert.rejects(registry.call('components.settings.set', { id, key: 'theme', value: 'private-marker', spaceId: 'private' }), /Private-space/)
  const privateRead = runtime.settingsGet({ id, key: 'theme', spaceId: 'private' })
  assert.equal(privateRead.value, 'light')
  assert.equal(privateRead.source, 'global')
  assert.equal(privateRead.privateScope, true)
  await assert.rejects(registry.call('components.settings.set', { id, key: 'theme', value: 'dark', spaceId: 'missing' }), /Unknown setting space/)
  const api = runtime.bridge(id)
  api.settings.set('size', 18, { spaceId: 'work', id: 'local.otherprefs' })
  assert.equal(runtime.settingsGet({ id: 'local.otherprefs', key: 'size', spaceId: 'work' }).value, 12)
  assert.equal(runtime.inspect({ id }).properties.spaces.work.size, 18)
  assert.equal(fs.readFileSync(path.join(dir, 'composition.json'), 'utf8').includes('private-marker'), false)
  const delivered = await registry.call(`${id}.notifications`)
  assert.ok(delivered.some((entry) => entry.key === 'theme' && entry.source === 'space'))
  assert.deepEqual(await registry.call('local.otherprefs.notifications'), [])
  assert.ok(notifications.every((entry) => entry.owner === id))
  await runtime.disable({ id })
  assert.equal(runtime.settingsGet({ id, key: 'size', spaceId: 'work' }).value, 18)
  await runtime.enable({ id })
  await runtime.sourceWrite({ id, file: 'manifest.json', content: JSON.stringify({ ...manifest, version: '2.0.0', settings: { ...manifest.settings, size: { ...manifest.settings.size, default: 14 } } }) })
  await runtime.apply({ id })
  await runtime.revert({ id })
  assert.equal(runtime.inspect({ id }).revision, first.revision)
  assert.equal(runtime.settingsGet({ id, key: 'size', spaceId: 'work' }).value, 18)
  await runtime.stop()
  await runtime.start()
  assert.equal(runtime.settingsGet({ id, key: 'theme', spaceId: 'work' }).value, 'dark')
  const resetSpace = await registry.call('components.settings.reset', { id, key: 'theme', spaceId: 'work' })
  assert.equal(resetSpace.value, 'light')
  assert.equal(resetSpace.source, 'global')
  const resetGlobal = runtime.settingsReset({ id, key: 'theme' })
  assert.equal(resetGlobal.value, 'system')
  assert.equal(resetGlobal.source, 'default')
  await runtime.remove({ id })
  assert.equal(runtime.inspect().properties[id].spaces.work.size, 18)
  await runtime.stage({ path: source })
  await runtime.apply({ id })
  assert.equal(runtime.settingsGet({ id, key: 'size', spaceId: 'work' }).value, 18)
  await runtime.remove({ id, deleteData: true })
  assert.equal(runtime.inspect().properties[id], undefined)
})

test('invalid setting declarations and incompatible retained properties cannot replace active code', async (t) => {
  const { root, runtime } = setup(t, { state: () => ({ spaces: [{ id: 'work' }] }) })
  await runtime.start()
  const id = 'local.compatibility'
  const source = writePackage(root, id, { backend: false, capabilities: ['ui', 'storage'] })
  const base = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  const valid = { type: 'integer', default: 12, scope: 'space', minimum: 8, maximum: 24 }
  for (const settings of [
    { 'theme.color': { type: 'string', default: 'blue' } },
    { size: { ...valid, id: 'searchUrl' } },
    { size: { ...valid, owner: 'core' } },
    { size: { ...valid, default: 'twelve' } },
    { size: { ...valid, scope: 'private' } },
    { size: { ...valid, minimum: 30 } },
  ]) {
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ ...base, settings }))
    assert.equal(runtime.check({ path: source }).ok, false)
  }
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ ...base, settings: { size: valid } }))
  await runtime.stage({ path: source })
  const active = await runtime.apply({ id })
  runtime.settingsSet({ id, key: 'size', value: 18, spaceId: 'work' })
  const incompatible = { ...base, version: '2.0.0', settings: { size: { ...valid, minimum: 20, default: 20 } } }
  await runtime.sourceWrite({ id, file: 'manifest.json', content: JSON.stringify(incompatible) })
  const checked = runtime.check({ id })
  assert.equal(checked.ok, false)
  assert.equal(checked.code, 'incompatible')
  await assert.rejects(runtime.apply({ id }), /incompatible/)
  assert.equal(runtime.inspect({ id }).revision, active.revision)
  assert.equal(runtime.inspect({ id }).running, true)
  runtime.settingsReset({ id, key: 'size', spaceId: 'work' })
  await runtime.apply({ id })
  runtime.settingsSet({ id, key: 'size', value: 22 })
  await runtime.sourceWrite({ id, file: 'manifest.json', content: JSON.stringify({ ...incompatible, version: '3.0.0', settings: {} }) })
  await assert.rejects(runtime.apply({ id }), /no longer declared/)
  assert.equal(runtime.settingsGet({ id, key: 'size' }).value, 22)
})

test('legacy first selection and imported-but-unbound migration preserve independent custom roles', async (t) => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-legacy-roles-'))
  t.after(() => fs.rmSync(legacy, { recursive: true, force: true }))
  for (const file of ['index.html', 'palette.html', 'frame.html', 'tablist.html', 'panel.html', 'expose.html', 'layouts.html']) fs.writeFileSync(path.join(legacy, file), `<!doctype html><title>Owned ${file}</title>`)
  const { root, dir, runtime } = setup(t, { legacyShellDir: legacy })
  const stockRoot = writePackage(root, 'stock.shell', { backend: false, capabilities: ['ui'] })
  runtime.registerStock({ root: stockRoot, manifest: { apiVersion: 1, id: 'stock.shell', version: '1.0.0', capabilities: ['ui'], surfaces: { shell: 'index.html', launcher: 'index.html' } } })
  runtime.registerStock({ root: stockRoot, manifest: { apiVersion: 1, id: 'stock.layout', version: '1.0.0', capabilities: [], surfaces: {}, roles: ['layout'] } })
  await runtime.start()
  assert.equal(runtime.resolve('shell').owner, 'legacy.shell')
  assert.equal(runtime.bridge('legacy.shell').hasCapability('host.manage'), true)
  assert.equal(runtime.resolve('spaces').owner, 'legacy.shell')
  assert.equal(path.basename(runtime.resolve('spaces').file), 'panel.html')
  assert.equal(runtime.resolve('layout').owner, 'stock.layout')
  await runtime.create({ id: 'my.launcher', role: 'launcher' })
  await runtime.apply({ id: 'my.launcher' })
  await runtime.bind({ role: 'launcher', id: 'my.launcher' })
  await runtime.bind({ role: 'launcher', id: 'my.launcher', spaceId: 'work' })
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).source, 'space')
  await runtime.stop()
  const compositionPath = path.join(dir, 'composition.json')
  const composition = JSON.parse(fs.readFileSync(compositionPath, 'utf8'))
  delete composition.legacyImported.rolesBound
  composition.bindings.global.shell = 'stock.shell'
  fs.writeFileSync(compositionPath, JSON.stringify(composition))
  await runtime.start()
  assert.equal(runtime.resolve('shell').owner, 'legacy.shell')
  assert.equal(runtime.resolve('launcher').owner, 'my.launcher')
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).owner, 'my.launcher')
  await runtime.bind({ role: 'shell', id: 'stock.shell' })
  await runtime.stop()
  await runtime.start()
  assert.equal(runtime.resolve('shell').owner, 'stock.shell')
  assert.equal(runtime.resolve('launcher').owner, 'my.launcher')
})

test('revert swaps matching code and property snapshots without reverting component data', async (t) => {
  const observed = []
  const { root, dir, runtime } = setup(t, { state: () => ({ spaces: [{ id: 'work' }] }), onSettingsChanged: (entry) => observed.push(entry) })
  await runtime.start()
  const id = 'local.configrevert'
  const source = writePackage(root, id, { backend: false, capabilities: ['ui', 'storage'] })
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  manifest.settings = { size: { type: 'integer', default: 12, maximum: 20, scope: 'space' } }
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest))
  await runtime.stage({ path: source })
  const first = await runtime.apply({ id })
  runtime.settingsSet({ id, key: 'size', value: 18, spaceId: 'work' })
  runtime.dataWrite({ id, key: 'notes', value: ['before replacement'] })
  await runtime.sourceWrite({ id, file: 'manifest.json', content: JSON.stringify({ ...manifest, version: '2.0.0', settings: { size: { ...manifest.settings.size, maximum: 30 } } }) })
  const second = await runtime.apply({ id })
  assert.equal(second.previousProperties.spaces.work.size, 18)
  runtime.settingsSet({ id, key: 'size', value: 28, spaceId: 'work' })
  runtime.dataWrite({ id, key: 'notes', value: ['before replacement', 'after replacement'] })
  // Native consent's code-only check must not apply the current value 28 to
  // the old schema; revert restores its compatible saved value 18.
  assert.equal(runtime.check({ path: path.join(dir, 'revisions', id, first.revision) }).ok, true)
  await runtime.revert({ id, expectedRevision: first.revision })
  assert.equal(runtime.settingsGet({ id, key: 'size', spaceId: 'work' }).value, 18)
  assert.equal(runtime.inspect({ id }).previousProperties.spaces.work.size, 28)
  assert.deepEqual(runtime.dataRead({ id, key: 'notes' }), ['before replacement', 'after replacement'])
  assert.ok(observed.some((entry) => entry.spaceId === 'work' && entry.value === 18))
  await runtime.stop()
  await runtime.start()
  await runtime.revert({ id, expectedRevision: second.revision })
  assert.equal(runtime.settingsGet({ id, key: 'size', spaceId: 'work' }).value, 28)
  assert.equal(runtime.inspect({ id }).activeProperties.spaces.work.size, 28)
  assert.deepEqual(runtime.dataRead({ id, key: 'notes' }), ['before replacement', 'after replacement'])
})

test('stock and copied manager backends require explicit host.manage and cannot replace agent authority', async (t) => {
  const delegated = Object.freeze({})
  let issued = 0
  const { root, runtime, registry } = setup(t, { call: async (name, params, context) => {
    assert.equal(name, 'grants.issue')
    assert.equal(context.hostManagement, true)
    if (context.accessContext) {
      assert.equal(context.accessContext, delegated)
      throw Object.assign(new Error('Agent grant does not authorize management'), { code: 'forbidden' })
    }
    return { issued: ++issued, owner: params.owner }
  } })
  const source = writePackage(root, 'stock.manager', { capabilities: ['ui', 'backend', 'commands.register', 'host.manage', 'call:*', 'events:background'] })
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'component-scope-backend.js'), path.join(source, 'backend.js'))
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  runtime.registerStock({ root: source, manifest })
  runtime.registerStock({ root: source, manifest: { ...manifest, id: 'stock.unprivileged', capabilities: manifest.capabilities.filter((capability) => capability !== 'host.manage') } })
  await runtime.start()
  await assert.rejects(registry.call('stock.unprivileged.grant'), /host.manage/)
  assert.equal(issued, 0)
  assert.deepEqual(await registry.call('stock.manager.grant'), { issued: 1, owner: 'stock.manager' })
  await runtime.create({ id: 'local.manager', from: 'stock.manager' })
  assert.equal(runtime.inspect({ id: 'local.manager' }).enabled, false)
  await runtime.apply({ id: 'local.manager', grants: manifest.capabilities.filter((capability) => capability !== 'host.manage') })
  const deniedBridge = runtime.bridge('local.manager')
  assert.equal(deniedBridge.hasCapability('host.manage'), false)
  await assert.rejects(registry.call('local.manager.grant'), /host.manage/)
  assert.throws(() => runtime.authorize('local.manager', 'components.apply'), /host.manage/)
  await runtime.apply({ id: 'local.manager' })
  assert.throws(() => deniedBridge.hasCapability('host.manage'), /no longer active/)
  assert.equal(runtime.bridge('local.manager').hasCapability('host.manage'), true)
  assert.equal(runtime.authorize('local.manager', 'components.apply').hostManagement, true)
  assert.deepEqual(await registry.call('local.manager.grant'), { issued: 2, owner: 'local.manager' })
  await assert.rejects(registry.call('local.manager.grant', {}, { accessContext: delegated }), /Agent grant does not authorize management/)
  assert.equal(issued, 2)
})

test('revocation during real backend teardown restores the old generation without starting the approved replacement', async (t) => {
  for (const self of [false, true]) {
    const { root, runtime, registry } = setup(t, { timeouts: { start: 1000, call: 200, stop: 3000 } })
    await runtime.start()
    runtime.register()
    const id = self ? 'local.selfcancel' : 'local.cancel'
    const fixture = gatedPackage(root, id)
    await runtime.stage({ path: fixture.source })
    const first = await runtime.apply({ id })
    runtime.dataWrite({ id, key: 'retained', value: 'original data' })
    await runtime.sourceWrite({ id, file: 'config.json', content: JSON.stringify({ revision: 2, starts: fixture.starts }) })
    const staged = await runtime.stage({ path: runtime.inspect({ id }).path })
    const cancelled = new AbortController()
    const context = self
      ? { owner: id, component: id, hostManagement: true, signal: cancelled.signal, accessContext: Object.freeze({ signal: cancelled.signal }) }
      : { signal: cancelled.signal }
    const rejected = assert.rejects(registry.call('components.apply', { id, expectedRevision: staged.staged }, context), { code: 'cancelled' })
    await until(() => fs.existsSync(fixture.stopEntered))
    cancelled.abort()
    fs.writeFileSync(fixture.stopRelease, '')
    await rejected
    // A genuine queued operation waits until teardown, cancellation and recovery
    // have all settled, without replacing the component or global binding.
    await runtime.bind({ role: 'notes', id, spaceId: 'barrier' })
    assert.equal(runtime.inspect({ id }).revision, first.revision)
    assert.equal(runtime.inspect({ id }).enabled, true)
    assert.equal((await registry.call(`${id}.alive`)).revision, 1)
    assert.equal(runtime.dataRead({ id, key: 'retained' }), 'original data')
    const starts = fs.readFileSync(fixture.starts, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(starts.map((entry) => entry.revision), [1, 1])
    await runtime.stop()
  }
})

test('queued lifecycle commands recheck cancellation before create, apply, enable, revert, remove, disable and bind', async (t) => {
  const { root, dir, runtime, registry } = setup(t, { timeouts: { start: 1000, call: 200, stop: 3000 } })
  await runtime.start()
  runtime.register()
  for (const id of ['local.first', 'local.second', 'local.enable', 'local.revert']) {
    await runtime.stage({ path: writePackage(root, id, { backend: false, capabilities: ['ui'] }) })
    await runtime.apply({ id })
  }
  const disabledRevision = runtime.inspect({ id: 'local.enable' }).revision
  await runtime.disable({ id: 'local.enable' })
  const previousRevert = runtime.inspect({ id: 'local.revert' }).revision
  await runtime.sourceWrite({ id: 'local.revert', file: 'index.html', content: '<title>Keep this revision</title>' })
  const currentRevert = await runtime.apply({ id: 'local.revert' })
  await runtime.bind({ role: 'notes', id: 'local.first' })
  const previous = runtime.inspect({ id: 'local.second' }).revision
  await runtime.sourceWrite({ id: 'local.second', file: 'index.html', content: '<title>Must not activate</title>' })
  const staged = await runtime.stage({ path: runtime.inspect({ id: 'local.second' }).path })
  const blocker = gatedPackage(root, 'local.blocker')
  await runtime.stage({ path: blocker.source })
  await runtime.apply({ id: 'local.blocker' })
  const blocked = runtime.disable({ id: 'local.blocker' })
  await until(() => fs.existsSync(blocker.stopEntered))
  const cancelled = new AbortController()
  const requests = [
    ['components.apply', { id: 'local.second', expectedRevision: staged.staged }],
    ['components.enable', { id: 'local.enable', expectedRevision: disabledRevision }],
    ['components.revert', { id: 'local.revert', expectedRevision: previousRevert }],
    ['components.disable', { id: 'local.first' }],
    ['components.remove', { id: 'local.second' }],
    ['components.create', { id: 'local.cancelled', from: 'local.first' }],
    ['components.bind', { role: 'notes', id: 'local.second' }],
  ].map(([name, params]) => assert.rejects(registry.call(name, params, { signal: cancelled.signal }), { code: 'cancelled' }))
  await delay(0) // Registry handlers have entered the real lifecycle queue.
  cancelled.abort()
  await Promise.all(requests)
  fs.writeFileSync(blocker.stopRelease, '')
  await blocked
  await runtime.bind({ role: 'notes', id: 'local.first', spaceId: 'barrier' })
  assert.equal(runtime.inspect({ id: 'local.second' }).revision, previous)
  assert.equal(runtime.inspect({ id: 'local.enable' }).enabled, false)
  assert.equal(runtime.inspect({ id: 'local.enable' }).running, false)
  assert.equal(runtime.inspect({ id: 'local.revert' }).revision, currentRevert.revision)
  assert.equal(runtime.inspect({ id: 'local.first' }).enabled, true)
  assert.equal(runtime.resolve('notes').owner, 'local.first')
  assert.equal(runtime.list().some((entry) => entry.id === 'local.cancelled'), false)
  assert.equal(fs.existsSync(path.join(dir, 'packages', 'local.cancelled')), false)
})

test('self-managing surfaces may apply and revert themselves despite expected caller-generation disposal', async (t) => {
  const events = []
  let registry
  const prepared = setup(t, { call: (name, params, context) => registry.call(name, params, context), onReplace: (event) => events.push(event.action) })
  registry = prepared.registry
  const { root, runtime } = prepared
  await runtime.start()
  runtime.register()
  const id = 'local.selfmanager'
  await runtime.stage({ path: writePackage(root, id, { backend: false, capabilities: ['ui', 'host.manage', 'call:*'] }) })
  const first = await runtime.apply({ id })
  await runtime.sourceWrite({ id, file: 'index.html', content: '<title>New self-manager</title>' })
  const staged = await runtime.stage({ path: runtime.inspect({ id }).path })
  const old = runtime.bridge(id)
  await assert.rejects(old.call('components.apply', { id, expectedRevision: staged.staged }), { code: 'cancelled' })
  await runtime.bind({ role: 'notes', id, spaceId: 'barrier' })
  assert.equal(runtime.inspect({ id }).revision, staged.staged)
  assert.equal(runtime.inspect({ id }).enabled, true)
  assert.equal(events.includes('rollback'), false)
  await assert.rejects(runtime.bridge(id).call('components.revert', { id, expectedRevision: first.revision }), { code: 'cancelled' })
  await runtime.bind({ role: 'notes', id, spaceId: 'barrier' })
  assert.equal(runtime.inspect({ id }).revision, first.revision)
  assert.equal(events.includes('rollback'), false)
})

test('failed disable fallback either restores the old runtime or durably disables it before restart', async (t) => {
  for (const recoveryFails of [false, true]) {
    const { root, dir, runtime, registry } = setup(t, { onReplace: ({ action }) => {
      if (action === 'disable' || (recoveryFails && action === 'rollback')) throw new Error(`Broken ${action} surface`)
    } })
    await runtime.start()
    const id = recoveryFails ? 'local.disabled' : 'local.restored'
    const fixture = gatedPackage(root, id, { gate: false })
    await runtime.stage({ path: fixture.source })
    const original = await runtime.apply({ id })
    await assert.rejects(runtime.disable({ id }), /Broken disable surface/)
    assert.equal(runtime.inspect({ id }).enabled, !recoveryFails)
    assert.equal(runtime.inspect({ id }).running, !recoveryFails)
    assert.equal(runtime.inspect({ id }).revision, original.revision)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'composition.json'), 'utf8')).components[id].enabled, !recoveryFails)
    await runtime.stop()
    const startsBefore = fs.readFileSync(fixture.starts, 'utf8').trim().split('\n').length
    await runtime.start()
    assert.equal(runtime.inspect({ id }).running, !recoveryFails)
    const startsAfter = fs.readFileSync(fixture.starts, 'utf8').trim().split('\n').length
    assert.equal(startsAfter, startsBefore + (recoveryFails ? 0 : 1))
    if (!recoveryFails) assert.equal((await registry.call(`${id}.alive`)).revision, 1)
    await runtime.stop()
  }
})

test('returned command and event disposers are idempotent during live cleanup and worker shutdown', async (t) => {
  for (const mode of ['command', 'listener', 'repeated']) {
    const { root, dir, runtime, registry } = setup(t)
    await runtime.start()
    const id = `local.disposer-${mode}`
    const source = writePackage(root, id, { mode })
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'component-disposer-backend.js'), path.join(source, 'backend.js'))
    await runtime.stage({ path: source })
    await runtime.apply({ id })
    if (mode !== 'listener') assert.equal(await registry.call(`${id}.value`), 1)
    if (mode !== 'command') {
      runtime.emit('tick', { value: 1 })
      await until(() => runtime.dataRead({ id, key: 'last' }) === 1)
    }
    if (mode === 'repeated') {
      assert.equal(await registry.call(`${id}.cleanup`), 'cleaned')
      assert.equal(await registry.call(`${id}.value`), 2)
      runtime.emit('tick', { value: 2 })
      await delay(50)
      assert.equal(runtime.dataRead({ id, key: 'last' }), 1)
    }
    const disabled = await runtime.disable({ id })
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.running, false)
    assert.equal(disabled.error, null)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'composition.json'), 'utf8')).components[id].enabled, false)
    if (mode !== 'listener') await assert.rejects(registry.call(`${id}.value`), { code: 'unknown_method' })
    await runtime.enable({ id })
    assert.equal(runtime.inspect({ id }).running, true)
    await runtime.disable({ id })
    assert.equal(runtime.inspect({ id }).enabled, false)
    await runtime.stop()
  }
})

test('role resolution falls through inactive bindings to global and registered stock providers without rewriting selections', async (t) => {
  const { root, dir, runtime } = setup(t)
  const stock = (id, surfaces) => {
    const directory = writePackage(root, id, { backend: false, capabilities: ['ui'] })
    for (const file of new Set(Object.values(surfaces))) fs.writeFileSync(path.join(directory, file), `<title>${id}: ${file}</title>`)
    const manifest = { ...JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')), surfaces }
    runtime.registerStock({ root: directory, manifest })
    return directory
  }
  const shellRoot = stock('stock.shell', { shell: 'index.html', launcher: 'palette.html' })
  stock('stock.browser-tools', { settings: 'index.html', history: 'index.html', downloads: 'index.html' })
  stock('stock.alternate-launcher', { launcher: 'index.html' })
  await runtime.start()
  for (const id of ['local.global', 'local.scoped']) {
    await runtime.create({ id, from: 'stock.shell' })
    await runtime.apply({ id })
  }
  await runtime.create({ id: 'local.tools', from: 'stock.browser-tools' })
  await runtime.apply({ id: 'local.tools' })
  await runtime.bind({ role: 'launcher', id: 'local.global' })
  await runtime.bind({ role: 'launcher', id: 'local.scoped', spaceId: 'work' })
  for (const role of ['settings', 'history', 'downloads']) await runtime.bind({ role, id: 'local.tools' })
  const bindings = runtime.inspect().bindings
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).owner, 'local.scoped')
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).source, 'space')
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).spaceId, 'work')
  assert.equal(runtime.resolve('launcher', { spaceId: 'other' }).owner, 'local.global')
  assert.equal(runtime.resolve('launcher', { spaceId: 'other' }).source, 'global')
  await runtime.disable({ id: 'local.scoped' })
  const global = runtime.resolve('launcher', { spaceId: 'work' })
  assert.equal(global.owner, 'local.global')
  assert.equal(global.source, 'global')
  assert.equal(global.spaceId, undefined)
  await runtime.disable({ id: 'local.global' })
  const fallback = runtime.resolve('launcher', { spaceId: 'work' })
  assert.equal(fallback.owner, 'stock.shell')
  assert.equal(fallback.source, 'default')
  assert.equal(fallback.file, path.join(shellRoot, 'palette.html'))
  assert.equal(fallback.spaceId, undefined)
  assert.equal(runtime.resolve('launcher', { fallback: 'stock.alternate-launcher' }).owner, 'stock.alternate-launcher')
  assert.deepEqual(runtime.inspect().bindings, bindings)
  await runtime.enable({ id: 'local.global' })
  await runtime.enable({ id: 'local.scoped' })
  await runtime.apply({ id: 'local.scoped', grants: [] })
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).owner, 'local.global')
  await runtime.apply({ id: 'local.scoped' })
  await runtime.start({ safeMode: true })
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).owner, 'stock.shell')
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).source, 'default')
  for (const role of ['settings', 'history', 'downloads']) {
    assert.equal(runtime.resolve(role).owner, 'stock.browser-tools')
    assert.equal(runtime.resolve(role).source, 'default')
  }
  assert.deepEqual(runtime.inspect().bindings, bindings)
  assert.equal(runtime.inspect({ id: 'local.scoped' }).enabled, true)
  assert.equal(runtime.inspect({ id: 'local.scoped' }).running, false)
  await runtime.start({ safeMode: false })
  assert.equal(runtime.resolve('launcher', { spaceId: 'work' }).owner, 'local.scoped')
  assert.equal(runtime.resolve('settings').owner, 'local.tools')
  await runtime.stop()
  const composition = path.join(dir, 'composition.json')
  const saved = JSON.parse(fs.readFileSync(composition, 'utf8'))
  saved.bindings.spaces.missing = { launcher: 'local.missing' }
  saved.bindings.spaces.unsupported = { launcher: 'stock.browser-tools' }
  saved.bindings.global.history = 'local.missing'
  fs.writeFileSync(composition, JSON.stringify(saved))
  await runtime.start()
  for (const spaceId of ['missing', 'unsupported']) {
    assert.equal(runtime.resolve('launcher', { spaceId }).owner, 'local.global')
    assert.equal(runtime.resolve('launcher', { spaceId }).source, 'global')
  }
  assert.equal(runtime.resolve('history').owner, 'stock.browser-tools')
  assert.equal(runtime.resolve('history').source, 'default')
  assert.deepEqual(runtime.inspect().bindings, saved.bindings)
  await runtime.remove({ id: 'local.global' })
  assert.equal(runtime.inspect().bindings.global.launcher, undefined)
  assert.equal(runtime.resolve('launcher').owner, 'stock.shell')
  assert.equal(runtime.resolve('launcher').source, 'default')
  await runtime.disable({ id: 'stock.shell' })
  assert.equal(runtime.resolve('launcher').owner, 'stock.alternate-launcher')
  assert.equal(runtime.inspect({ id: 'stock.shell' }).enabled, false)
  assert.equal(runtime.resolve('unprovided'), null)
})

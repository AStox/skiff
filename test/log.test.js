'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLogger, sanitize, since } = require('../src/log')

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-log-'))
const read = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

test('lines are JSON with time, level, scope and message, and data cannot overwrite them', async () => {
  const dir = scratch()
  const logger = createLogger({ dir, now: () => Date.parse('2026-11-24T12:00:00.123Z') })
  logger.scope('cmd').info('tabs.create', { ms: 3, lvl: 'x', msg: 'y' })
  await logger.flush()
  assert.deepEqual(read(logger.path), [{ t: '2026-11-24T12:00:00.123Z', lvl: 'info', scope: 'cmd', msg: 'tabs.create', ms: 3, _lvl: 'x', _msg: 'y' }])
  fs.rmSync(dir, { recursive: true })
})

test('the default level keeps debug and drops trace until the level is lowered', async () => {
  const dir = scratch()
  const logger = createLogger({ dir })
  const log = logger.scope('s')
  log.trace('hot')
  log.debug('kept')
  await logger.flush()
  assert.deepEqual(read(logger.path).map((e) => e.msg), ['kept'])
  logger.setLevel('trace')
  log.trace('hot')
  logger.setLevel('warn')
  log.info('quiet')
  log.error('loud')
  await logger.flush()
  assert.deepEqual(read(logger.path).map((e) => e.msg), ['kept', 'hot', 'loud'])
  fs.rmSync(dir, { recursive: true })
})

test('secret keys are replaced at any depth, other values stay', () => {
  const out = sanitize({ host: 'a.test', password: 'hunter2', nested: { apiKey: 'k', Authorization: 'Bearer x', list: [{ cookie: 'c', ok: 1 }] }, sessionToken: 't', otpSecret: 's', keys: 3 })
  assert.deepEqual(out, { host: 'a.test', password: '[redacted]', nested: { apiKey: '[redacted]', Authorization: '[redacted]', list: [{ cookie: '[redacted]', ok: 1 }] }, sessionToken: '[redacted]', otpSecret: '[redacted]', keys: 3 })
})

test('credentials inside URLs and messages are masked', async () => {
  const dir = scratch()
  const logger = createLogger({ dir })
  logger.scope('wc').info('GET https://user:hunter2@site.test/path?id=7&access_token=abc123&q=hello#session=zzz', { url: 'https://x.test/cb?code=9&state=ok' })
  await logger.flush()
  const [entry] = read(logger.path)
  assert.equal(entry.msg, 'GET https://user:[redacted]@site.test/path?id=7&access_token=[redacted]&q=hello#session=[redacted]')
  assert.equal(entry.url, 'https://x.test/cb?code=[redacted]&state=ok')
  fs.rmSync(dir, { recursive: true })
})

test('long strings, wide objects, long arrays and deep nesting are capped before writing', () => {
  const out = sanitize({ long: 'x'.repeat(5000), many: Array.from({ length: 100 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } }, wide: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])) })
  assert.equal(out.long.length, 2048 + '...[+2952]'.length)
  assert.ok(out.long.endsWith('...[+2952]'))
  assert.equal(out.many.length, 21)
  assert.equal(out.many[20], '...[+80 items]')
  assert.equal(out.deep.a.b.c, '[object]')
  assert.equal(Object.keys(out.wide).length, 41)
  assert.equal(out.wide['...'], '[+60 keys]')
})

test('the whole entry stays bounded when every field is large', () => {
  const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, 'y'.repeat(2000)]))
  const text = JSON.stringify(sanitize({ a: big, b: big, c: big }))
  assert.ok(text.length < 20000, String(text.length))
  assert.ok(text.includes('[truncated]'))
})

test('errors keep name, message, code and stack; cycles, binaries and odd values do not throw', () => {
  const error = Object.assign(new Error('boom'), { code: 'ECONN' })
  const cycle = { name: 'loop' }
  cycle.self = cycle
  const out = sanitize({ error, cycle, buffer: Buffer.alloc(10), fn() {}, big: 10n, nan: NaN, when: new Date(0), map: new Map([['a', 1]]) })
  assert.equal(out.error.name, 'Error')
  assert.equal(out.error.message, 'boom')
  assert.equal(out.error.code, 'ECONN')
  assert.match(out.error.stack, /boom/)
  assert.equal(out.cycle.self.self.self, '[object]')
  assert.deepEqual([out.buffer, out.fn, out.big, out.nan, out.when, out.map], ['[binary 10 bytes]', '[function]', '10', 'NaN', '1970-01-01T00:00:00.000Z', [['a', 1]]])
  const hostile = { get boom() { throw new Error('x') } }
  assert.deepEqual(sanitize(hostile), { boom: '[unreadable]' })
})

test('the file rotates at the size limit and keeps only the newest files', async () => {
  const dir = scratch()
  const logger = createLogger({ dir, maxBytes: 600, files: 3 })
  const log = logger.scope('r')
  for (let i = 0; i < 12; i++) { log.info(`line ${i}`, { pad: 'p'.repeat(150) }); await logger.flush() }
  const names = fs.readdirSync(dir).sort()
  assert.deepEqual(names, ['skiff.1.log', 'skiff.2.log', 'skiff.log'])
  for (const name of names) assert.ok(fs.statSync(path.join(dir, name)).size <= 600 + 400, name)
  const all = names.flatMap((name) => read(path.join(dir, name)).map((e) => e.msg))
  assert.ok(all.includes('line 11'))
  assert.ok(!all.includes('line 0'))
  assert.equal(read(path.join(dir, 'skiff.log')).at(-1).msg, 'line 11')
  const order = [2, 1, 0].flatMap((i) => read(path.join(dir, i ? `skiff.${i}.log` : 'skiff.log')).map((e) => Number(e.msg.slice(5))))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  fs.rmSync(dir, { recursive: true })
})

test('a new logger continues the size of the existing file instead of restarting at zero', async () => {
  const dir = scratch()
  const first = createLogger({ dir, maxBytes: 700, files: 2 })
  first.scope('r').info('a', { pad: 'p'.repeat(400) })
  await first.flush()
  const second = createLogger({ dir, maxBytes: 700, files: 2 })
  second.scope('r').info('b', { pad: 'p'.repeat(400) })
  await second.flush()
  assert.deepEqual(read(path.join(dir, 'skiff.1.log')).map((e) => e.msg), ['a'])
  assert.deepEqual(read(path.join(dir, 'skiff.log')).map((e) => e.msg), ['b'])
  fs.rmSync(dir, { recursive: true })
})

test('tail returns the newest matches in order across rotated files and applies every filter', async () => {
  const dir = scratch()
  let clock = Date.parse('2026-11-24T12:00:00Z')
  const logger = createLogger({ dir, maxBytes: 500, files: 8, now: () => clock })
  const cmd = logger.scope('cmd')
  const wc = logger.scope('wc')
  for (let i = 0; i < 10; i++) {
    clock += 60e3
    cmd.debug(`call ${i}`, { pad: 'p'.repeat(100) })
    if (i % 3 === 0) wc.error(`fail ${i}`)
    await logger.flush()
  }
  assert.ok(fs.existsSync(path.join(dir, 'skiff.1.log')))
  const msgs = async (options) => (await logger.tail(options)).map((line) => JSON.parse(line).msg)
  assert.deepEqual(await msgs({ lines: 3 }), ['call 8', 'call 9', 'fail 9'])
  assert.deepEqual(await msgs({ lines: 2, scope: 'cmd' }), ['call 8', 'call 9'])
  assert.deepEqual(await msgs({ level: 'error', lines: 10 }), ['fail 0', 'fail 3', 'fail 6', 'fail 9'])
  assert.deepEqual(await msgs({ grep: 'call [12]"', lines: 10 }), ['call 1', 'call 2'])
  assert.deepEqual(await msgs({ since: new Date(clock - 2.5 * 60e3).toISOString(), scope: 'cmd', lines: 10 }), ['call 7', 'call 8', 'call 9'])
  assert.deepEqual(await msgs({ since: '3m', scope: 'cmd', lines: 10 }), ['call 6', 'call 7', 'call 8', 'call 9'])
  assert.deepEqual(await msgs({ grep: '(', lines: 10 }), [])
  fs.rmSync(dir, { recursive: true })
})

test('marks always land as a MARK line with the note', async () => {
  const dir = scratch()
  const logger = createLogger({ dir })
  logger.mark('before repro')
  await logger.flush()
  const [entry] = read(logger.path)
  assert.deepEqual([entry.msg, entry.scope, entry.note], ['MARK', 'mark', 'before repro'])
  fs.rmSync(dir, { recursive: true })
})

test('relative and absolute since values parse; junk is ignored', () => {
  assert.equal(since('10m', 1e6), 1e6 - 600e3)
  assert.equal(since('2h', 1e7), 1e7 - 7200e3)
  assert.equal(since('2026-11-24T00:00:00Z'), Date.parse('2026-11-24T00:00:00Z'))
  assert.equal(since('soon'), null)
  assert.equal(since(undefined), null)
})

test('logging into an unusable directory never throws', async () => {
  const dir = scratch()
  const blocker = path.join(dir, 'file')
  fs.writeFileSync(blocker, 'x')
  const logger = createLogger({ dir: path.join(blocker, 'logs') })
  assert.doesNotThrow(() => logger.scope('x').error('nope', { circular: (() => { const o = {}; o.o = o; return o })() }))
  await logger.flush()
  assert.deepEqual(await logger.tail(), [])
  fs.rmSync(dir, { recursive: true })
})

test('flushSync writes what the async queue has not yet', () => {
  const dir = scratch()
  const logger = createLogger({ dir, flushMs: 60000 })
  logger.scope('app').error('fatal')
  logger.flushSync()
  assert.deepEqual(read(logger.path).map((e) => e.msg), ['fatal'])
  fs.rmSync(dir, { recursive: true })
})

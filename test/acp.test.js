'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('node:stream')
const { connect } = require('../src/acp')

// The client writes to `toAgent` and reads `fromAgent`; `sent()` parses what it wrote so far.
function pair(handlers = {}) {
  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  let written = ''
  toAgent.setEncoding('utf8')
  toAgent.on('data', (chunk) => { written += chunk })
  const client = connect({ input: fromAgent, output: toAgent, ...handlers })
  const sent = () => written.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const reply = (message) => fromAgent.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  return { client, fromAgent, sent, reply }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('requests get integer ids and resolve or reject by the matching response', async () => {
  const { client, sent, reply } = pair()
  const first = client.request('initialize', { protocolVersion: 1 })
  const second = client.request('session/new', { cwd: '/tmp' })
  await tick()
  assert.deepEqual(sent(), [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }, { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } }])
  reply({ id: 2, error: { code: -32000, message: 'Authentication required' } })
  reply({ id: 1, result: { protocolVersion: 1 } })
  assert.deepEqual(await first, { protocolVersion: 1 })
  await assert.rejects(second, { code: -32000, message: 'Authentication required' })
})

test('notifications go out without an id and come in through onNotification; malformed lines are ignored', async () => {
  const seen = []
  const { client, sent, fromAgent } = pair({ onNotification: (method, params) => seen.push([method, params]) })
  client.notify('session/cancel', { sessionId: 's' })
  await tick()
  assert.deepEqual(sent(), [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }])
  // One update split across two chunks, with junk around it.
  fromAgent.write('not json\n{"jsonrpc":"2.0","method":"session/upd')
  fromAgent.write('ate","params":{"n":1}}\n42\n\n')
  await tick()
  assert.deepEqual(seen, [['session/update', { n: 1 }]])
})

test('an incoming request goes to onRequest and is answered with respond', async () => {
  const requests = []
  const { client, sent, reply } = pair({ onRequest: (method, params, id) => requests.push({ method, params, id }) })
  reply({ id: 'p1', method: 'session/request_permission', params: { options: [] } })
  reply({ id: 7, method: 'fs/read_text_file', params: {} })
  await tick()
  assert.deepEqual(requests.map((r) => [r.method, r.id]), [['session/request_permission', 'p1'], ['fs/read_text_file', 7]])
  client.respond('p1', { outcome: { outcome: 'cancelled' } })
  client.respond(7, Object.assign(new Error('Method not found'), { code: -32601 }))
  await tick()
  assert.deepEqual(sent(), [
    { jsonrpc: '2.0', id: 'p1', result: { outcome: { outcome: 'cancelled' } } },
    { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } }
  ])
})

test('the end of the input rejects pending requests and later ones', async () => {
  let closed
  const { client, fromAgent } = pair({ onClose: (error) => { closed = error } })
  const pending = client.request('session/prompt', {})
  fromAgent.end()
  await assert.rejects(pending, { closed: true, message: /exited/ })
  assert.equal(closed, null)
  await assert.rejects(client.request('ping'), { closed: true })
})

test('a line over 4 MB rejects everything and closes', async () => {
  let closed
  const { client, fromAgent } = pair({ onClose: (error) => { closed = error } })
  const pending = client.request('session/prompt', {})
  fromAgent.write('x'.repeat(3 * 1024 * 1024))
  await tick()
  assert.equal(closed, undefined)
  fromAgent.write('x'.repeat(2 * 1024 * 1024))
  await assert.rejects(pending, { closed: true, message: /4 MB/ })
  assert.match(closed.message, /4 MB/)
})

test('aborted requests detach from late replies without closing unrelated sessions', async () => {
  const { client, sent, reply } = pair()
  const controller = new AbortController()
  const cancelled = client.request('session/load', { sessionId: 'cancelled' }, { signal: controller.signal })
  const other = client.request('session/load', { sessionId: 'other' })
  controller.abort(new Error('Grant revoked'))
  await assert.rejects(cancelled, { message: 'Grant revoked' })
  const [first, second] = sent()
  reply({ id: first.id, result: { privateText: 'Late result must be ignored' } })
  reply({ id: second.id, result: { sessionId: 'other' } })
  assert.deepEqual(await other, { sessionId: 'other' })
  client.close()
})

test('bounded startup requests time out and reject late responses without leaking pending calls', async () => {
  const { client, sent, reply } = pair()
  const waiting = client.request('initialize', {}, { timeout: 10 })
  await assert.rejects(waiting, { code: 'timeout' })
  reply({ id: sent()[0].id, result: { protocolVersion: 1 } })
  const next = client.request('ping', {})
  reply({ id: sent()[1].id, result: {} })
  assert.deepEqual(await next, {})
  client.close()
})

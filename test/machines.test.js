'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMachines, aliasOf, quote } = require('../src/machines')

const LIST = JSON.stringify([
  { id: 'host_a', name: 'Latitude', status: 'connected' },
  { id: 'host_b', name: 'Personal macbook', status: 'disconnected' },
  { id: 'host_c', name: 'Work Macbook', status: 'connected' },
  { id: 7, name: 'Broken' }
])

function home(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-machines-'))
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  if (id) {
    fs.mkdirSync(path.join(dir, '.bb-machines', 'x'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.bb-machines', 'x', 'host-id'), `${id}\n`)
  }
  return dir
}

test('the ssh alias is the machine name lowercased with runs of other characters turned into one dash', () => {
  assert.deepEqual(['Latitude', 'Personal macbook', ' Work  MacBook (2) ', 'a_b.c'].map(aliasOf), ['latitude', 'personal-macbook', 'work-macbook-2', 'a-b-c'])
})

test('quote makes one literal shell word, single quotes included', () => {
  assert.equal(quote(`it's "$HOME"`), `'it'\\''s "$HOME"'`)
})

test('the list is this machine first, then bb\'s others with their aliases; the machine named in host-id is not listed twice', async () => {
  const asked = []
  const machines = createMachines({ home: home('host_c'), run: async (command) => { asked.push(command); return LIST } })
  assert.deepEqual(await machines.list(), [
    { id: '', name: 'This Mac', status: 'connected', local: true, alias: '' },
    { id: 'host_a', name: 'Latitude', status: 'connected', local: false, alias: 'latitude' },
    { id: 'host_b', name: 'Personal macbook', status: 'disconnected', local: false, alias: 'personal-macbook' }
  ])
  assert.deepEqual([machines.normalize('host_c'), machines.normalize(''), machines.normalize('host_a')], ['', '', 'host_a'])
  await machines.list()
  assert.deepEqual(asked, ['bb machine list --json'])
  await machines.list({ refresh: true })
  assert.equal(asked.length, 2)
})

test('without bb, or with an answer that is not a list, only this machine is listed and nothing is thrown', async () => {
  for (const run of [async () => { throw new Error('bb: command not found') }, async () => 'not json', async () => '{"machines":[]}']) {
    const machines = createMachines({ home: home(), run })
    assert.deepEqual((await machines.list()).map((m) => m.id), [''])
    assert.equal(await machines.find('host_a'), null)
  }
})

test('find refreshes once for an id it has not seen and returns only another machine', async () => {
  let answer = '[]'
  let calls = 0
  const machines = createMachines({ home: home('host_c'), run: async () => { calls++; return answer } })
  assert.equal(await machines.find('host_a'), null)
  answer = LIST
  assert.equal((await machines.find('host_a')).alias, 'latitude')
  assert.equal(await machines.find('host_c'), null)
  await machines.find('host_a')
  assert.equal(calls, 2)
})

'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { selectCandidate, promoteRuntime } = require('../scripts/security-updater')
const releases = (rows) => rows.map(([tag_name, prerelease = false, draft = false]) => ({ tag_name, prerelease, draft }))

test('selects highest stable patch on the installed major, never prereleases, downgrades, or another major', () => {
  assert.equal(selectCandidate(releases([['v46.0.0'], ['v45.4.1'], ['v45.5.0-beta.1', true], ['v45.3.0'], ['v45.4.0', false, true]]), '45.3.0').version, '45.4.1')
  assert.equal(selectCandidate(releases([['v46.0.0'], ['v45.2.9'], ['v45.3.0']]), '45.3.0'), null)
  assert.throws(() => selectCandidate([], 'latest'), /Invalid installed/)
})

test('failed candidate promotion leaves installed runtime intact and keeps candidate staged', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-updater-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'electron'), candidate = path.join(root, 'candidate'), backup = path.join(root, 'previous')
  fs.mkdirSync(live); fs.writeFileSync(path.join(live, 'version'), 'old')
  fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, 'version'), 'new')
  assert.throws(() => promoteRuntime(live, candidate, backup, { isRunning: () => false, fingerprint: () => 'changed', expected: 'tested' }), /Source changed/)
  assert.equal(fs.readFileSync(path.join(live, 'version'), 'utf8'), 'old')
  assert.equal(fs.readFileSync(path.join(candidate, 'version'), 'utf8'), 'new')
  assert.equal(fs.existsSync(backup), false)
})

test('active-app deferral and concurrent promotion fail closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-updater-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'electron'), candidate = path.join(root, 'candidate'), backup = path.join(root, 'previous')
  fs.mkdirSync(live); fs.writeFileSync(path.join(live, 'version'), 'old')
  fs.mkdirSync(candidate)
  const opts = { isRunning: () => true, fingerprint: () => 'tested', expected: 'tested' }
  assert.throws(() => promoteRuntime(live, candidate, backup, opts), /Skiff is running/)
  fs.mkdirSync(`${live}.security-updater.lock`)
  assert.throws(() => promoteRuntime(live, candidate, backup, { ...opts, isRunning: () => false }), /EEXIST/)
  assert.equal(fs.readFileSync(path.join(live, 'version'), 'utf8'), 'old')
})

test('source change or launch during the atomic swap restores the previous runtime', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-updater-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'electron'), candidate = path.join(root, 'candidate'), backup = path.join(root, 'previous')
  fs.mkdirSync(live); fs.writeFileSync(path.join(live, 'version'), 'old')
  fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, 'version'), 'new')
  let checks = 0
  assert.throws(() => promoteRuntime(live, candidate, backup, { isRunning: () => false, fingerprint: () => ++checks === 1 ? 'tested' : 'changed', expected: 'tested' }), /launched or source changed/)
  assert.equal(fs.readFileSync(path.join(live, 'version'), 'utf8'), 'old')
  assert.equal(fs.existsSync(backup), false)
})

test('promotion preserves previous runtime and rolls it back on rename failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-updater-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'electron'), candidate = path.join(root, 'candidate'), backup = path.join(root, 'previous')
  fs.mkdirSync(live); fs.writeFileSync(path.join(live, 'version'), 'old')
  assert.throws(() => promoteRuntime(live, path.join(root, 'missing-candidate'), backup, { isRunning: () => false, fingerprint: () => 'tested', expected: 'tested' }), /ENOENT/)
  assert.equal(fs.readFileSync(path.join(live, 'version'), 'utf8'), 'old')
  fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, 'version'), 'new')
  assert.equal(promoteRuntime(live, candidate, backup, { isRunning: () => false, fingerprint: () => 'tested', expected: 'tested' }), backup)
  assert.equal(fs.readFileSync(path.join(live, 'version'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(backup, 'version'), 'utf8'), 'old')
})

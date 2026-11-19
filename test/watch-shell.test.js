'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { watchShellFiles } = require('../src/watch-shell')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('shell watching ignores replayed copy events and metadata-only changes but reloads edited assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-watch-test-'))
  const shell = path.join(root, 'shell')
  fs.mkdirSync(shell)
  const file = path.join(shell, 'index.html')
  fs.writeFileSync(file, '<h1>Original</h1>')
  let changes = 0
  const watcher = watchShellFiles(shell, () => changes++)
  const waitFor = async (count) => {
    const deadline = Date.now() + 4000
    while (changes < count && Date.now() < deadline) await delay(25)
    assert.equal(changes, count)
  }
  try {
    fs.readFileSync(file)
    fs.writeFileSync(path.join(root, 'state.json'), '{}')
    fs.utimesSync(file, new Date(), new Date())
    await delay(1800)
    assert.equal(changes, 0)
    fs.writeFileSync(file + '.tmp', '<h1>Updated</h1>')
    fs.renameSync(file + '.tmp', file)
    await waitFor(1)
    fs.mkdirSync(path.join(shell, 'assets'))
    fs.writeFileSync(path.join(shell, 'assets', 'theme.css'), 'body { color: red }')
    await waitFor(2)
    fs.unlinkSync(path.join(shell, 'assets', 'theme.css'))
    await waitFor(3)
  } finally {
    watcher.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

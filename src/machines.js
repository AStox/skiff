'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const log = require('./log').scope('machines')

const TIMEOUT = 8000
const loginShell = () => (!process.env.SHELL || /(nologin|false)$/.test(process.env.SHELL) ? '/bin/sh' : process.env.SHELL)
// The ssh host alias of a bb machine: its name lowercased, each run of other characters turned into one "-".
const aliasOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
// Single quotes make the text one literal word for the shell that reads it.
const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

// bb's machines, from `bb machine list --json` run in the user's login shell (bb is on its PATH, not necessarily Skiff's).
// The machine this app runs on is the one whose id is in ~/.bb-machines/*/host-id. Without bb the list is just this machine.
function createMachines({ home = os.homedir(), bb = 'bb', run = (command) => new Promise((resolve, reject) => execFile(loginShell(), ['-lc', command], { timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)))) } = {}) {
  let localId = ''
  let remote = []
  let fetched = false
  let inflight = null

  function readLocal() {
    const root = path.join(home, '.bb-machines')
    try {
      for (const folder of fs.readdirSync(root)) {
        const id = fs.readFileSync(path.join(root, folder, 'host-id'), 'utf8').trim()
        if (id) return id
      }
    } catch {}
    return ''
  }

  async function refresh() {
    localId = readLocal()
    let found = []
    try {
      const list = JSON.parse(await run(`${bb} machine list --json`))
      found = (Array.isArray(list) ? list : []).filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && aliasOf(m.name)).map((m) => ({ id: text(m.id, 200), name: text(m.name, 100), status: text(m.status, 40) || 'unknown' }))
    } catch (e) {
      log.warn('bb machine list failed', { err: e.message })
    }
    remote = found
    fetched = true
  }

  // A refresh is shared by callers that arrive while it runs.
  function load() {
    inflight ??= refresh().finally(() => { inflight = null })
    return inflight
  }

  const here = { id: '', name: 'This Mac', status: 'connected', local: true, alias: '' }
  const all = () => [here, ...remote.filter((m) => !localId || m.id !== localId).map((m) => ({ ...m, local: false, alias: aliasOf(m.name) }))]

  localId = readLocal()
  return {
    // {id, name, status, local, alias} with this machine first (id ''); the machine ids chats store are these ids.
    async list({ refresh: force = false } = {}) {
      if (force || !fetched) await load()
      return all()
    },
    // Folds this machine's own bb id into '' so a chat never ssh-es to itself.
    normalize: (id) => (!id || id === localId ? '' : id),
    // A known remote machine, refreshing the list once when the id is not in it yet.
    async find(id) {
      if (!remote.some((m) => m.id === id)) await load()
      return all().find((m) => !m.local && m.id === id) || null
    }
  }
}

module.exports = { createMachines, aliasOf, quote, loginShell }

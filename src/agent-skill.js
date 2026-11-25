'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const NAME = 'skiff'
const ROOT = path.join(__dirname, '..', 'agent-skill')

// Each harness's user-level skills folder, relative to the home folder, from the harness's own docs:
// Claude Code code.claude.com/docs/en/skills, omp docs/config-usage.md, Codex developers.openai.com/codex/skills,
// Gemini CLI geminicli.com/docs/cli/skills, Hermes hermes-agent.nousresearch.com/docs/user-guide/features/skills.
const HARNESSES = {
  claude: ['.claude', 'skills'],
  omp: ['.omp', 'agent', 'skills'],
  codex: ['.agents', 'skills'],
  gemini: ['.gemini', 'skills'],
  hermes: ['.hermes', 'skills']
}
const EXECUTABLES = { omp: 'omp', gemini: 'gemini', hermes: 'hermes', 'codex-acp': 'codex', 'claude-agent-acp': 'claude', 'claude-code-acp': 'claude' }
const PACKAGES = { '@agentclientprotocol/codex-acp': 'codex', '@zed-industries/codex-acp': 'codex', '@agentclientprotocol/claude-agent-acp': 'claude', '@zed-industries/claude-agent-acp': 'claude', '@zed-industries/claude-code-acp': 'claude' }
const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])

function tokens(command) {
  const out = []
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  for (let m; (m = pattern.exec(command));) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

const base = (token) => path.basename(token).replace(/\.(?:cmd|exe)$/i, '')
const unversioned = (name) => name.replace(/(?<=.)@[^/@]*$/, '')

// The harness behind an agent command, or null: an unknown program, and every wrapper (ssh, docker, sh -c) that is not a plain local launch.
function harnessOf(command) {
  const words = tokens(String(command || ''))
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || base(words[0]) === 'env')) words.shift()
  if (!words.length) return null
  let exe = base(words[0])
  let rest = words.slice(1)
  if (exe === 'pnpm' || exe === 'yarn' || exe === 'npm') {
    const verb = rest[0]
    if (!(verb === 'dlx' || (exe === 'npm' && verb === 'exec'))) return null
    exe = 'npx'
    rest = rest.slice(1)
  }
  if (RUNNERS.has(exe)) {
    const pkg = rest.find((word) => !word.startsWith('-'))
    return pkg ? PACKAGES[unversioned(pkg)] || null : null
  }
  return EXECUTABLES[exe] || null
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

// source: the folder with skiff/SKILL.md and versions.json, a list of {version, sha256} of every SKILL.md Skiff has shipped, the last the current one.
// A file is only ever replaced when it still matches one of them, so a user's edit is never overwritten.
function createAgentSkill({ home = os.homedir(), source = ROOT } = {}) {
  const content = fs.readFileSync(path.join(source, NAME, 'SKILL.md'))
  const versions = JSON.parse(fs.readFileSync(path.join(source, 'versions.json'), 'utf8'))
  const current = versions.at(-1)
  const known = new Set(versions.map((v) => v.sha256))

  const fileOf = (harness) => path.join(home, ...HARNESSES[harness], NAME, 'SKILL.md')

  function status(command) {
    const harness = harnessOf(command)
    if (!harness) return { harness: null, status: 'unsupported', path: null }
    const file = fileOf(harness)
    try {
      let stat
      try { stat = fs.lstatSync(file) } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { harness, status: 'missing', path: file }
        throw e
      }
      if (!stat.isFile()) return { harness, status: 'modified', path: file }
      const hash = sha256(fs.readFileSync(file))
      return { harness, status: hash === current.sha256 ? 'installed' : known.has(hash) ? 'outdated' : 'modified', path: file }
    } catch (e) {
      return { harness, status: 'error', path: file, error: e.message }
    }
  }

  // Never writes outside the home folder, even through a symlinked skills folder.
  function assertInHome(dir) {
    let existing = dir
    while (!fs.existsSync(existing)) existing = path.dirname(existing)
    const real = fs.realpathSync(existing)
    const root = fs.realpathSync(home)
    if (real !== root && !real.startsWith(root + path.sep)) throw Object.assign(new Error(`${dir} is outside your home folder`), { code: 'bad_params' })
  }

  // Writes the bundled skill for a missing or outdated install; returns the status after, with written: whether this call changed the file.
  function install(command) {
    const before = status(command)
    if (before.status !== 'missing' && before.status !== 'outdated') {
      if (before.status === 'error') throw Object.assign(new Error(before.error), { code: 'internal' })
      return { ...before, written: false }
    }
    const dir = path.dirname(before.path)
    assertInHome(dir)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const tmp = path.join(dir, `.SKILL.md.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
    try {
      fs.writeFileSync(tmp, content, { mode: 0o644, flag: 'wx' })
      fs.chmodSync(tmp, 0o644)
      fs.renameSync(tmp, before.path)
    } catch (e) {
      fs.rmSync(tmp, { force: true })
      throw e
    }
    return { ...before, status: 'installed', written: true }
  }

  return { status, install, version: current.version }
}

module.exports = { createAgentSkill, harnessOf, HARNESSES, sha256 }

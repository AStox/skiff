'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createAgentSkill, harnessOf, sha256 } = require('../src/agent-skill')

const bundled = path.join(__dirname, '..', 'agent-skill')

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-skill-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

// A source folder holding a one-line skill and the versions it shipped with.
function source(root, ...texts) {
  const dir = path.join(root, 'source')
  fs.mkdirSync(path.join(dir, 'skiff'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skiff', 'SKILL.md'), texts.at(-1))
  fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify(texts.map((text, i) => ({ version: i + 1, sha256: sha256(Buffer.from(text)) }))))
  return dir
}

test('the bundled skill is the last version in versions.json', () => {
  const versions = JSON.parse(fs.readFileSync(path.join(bundled, 'versions.json'), 'utf8'))
  assert.equal(versions.at(-1).sha256, sha256(fs.readFileSync(path.join(bundled, 'skiff', 'SKILL.md'))), 'append the new hash to versions.json when SKILL.md changes')
  assert.equal(new Set(versions.map((v) => v.sha256)).size, versions.length)
  const head = fs.readFileSync(path.join(bundled, 'skiff', 'SKILL.md'), 'utf8').match(/^---\nname: skiff\ndescription: (.+)\n---\n/)
  assert.ok(head, 'frontmatter is name then description')
  assert.doesNotMatch(head[1], /: | #/, 'a strict YAML reader rejects a colon or comment in an unquoted description')
  assert.ok(head[1].length <= 1024)
})

test('a harness is found from the agent command', () => {
  const cases = [
    ['omp acp', 'omp'],
    ['/opt/bin/omp acp', 'omp'],
    ["'/home/me/.local/bin/omp' acp", 'omp'],
    ['gemini --acp', 'gemini'],
    ['hermes acp', 'hermes'],
    ['npx -y @agentclientprotocol/codex-acp', 'codex'],
    ['npx -y @agentclientprotocol/claude-agent-acp', 'claude'],
    ['npx --yes @agentclientprotocol/claude-agent-acp@0.4.1 --flag', 'claude'],
    ['bunx @zed-industries/codex-acp', 'codex'],
    ['pnpm dlx @agentclientprotocol/codex-acp', 'codex'],
    ['npm exec @zed-industries/claude-code-acp', 'claude'],
    ['claude-code-acp', 'claude'],
    ['FOO=1 omp acp', 'omp'],
    ['env FOO=1 gemini --acp', 'gemini'],
    ['ssh myserver omp acp', null],
    ['ssh -t me@host npx -y @agentclientprotocol/codex-acp', null],
    ['docker exec -i box omp acp', null],
    ['sh -c "omp acp"', null],
    ['npx -y some-other-acp', null],
    ['npx', null],
    ['npm install omp', null],
    ['my-custom-agent --acp', null],
    ['', null]
  ]
  for (const [command, harness] of cases) assert.equal(harnessOf(command), harness, command)
})

test('each harness gets its own user skills folder under home', (t) => {
  const root = scratch(t)
  const skills = createAgentSkill({ home: root, source: bundled })
  const rel = (command) => path.relative(root, skills.status(command).path)
  assert.equal(rel('omp acp'), path.join('.omp', 'agent', 'skills', 'skiff', 'SKILL.md'))
  assert.equal(rel('npx -y @agentclientprotocol/claude-agent-acp'), path.join('.claude', 'skills', 'skiff', 'SKILL.md'))
  assert.equal(rel('npx -y @agentclientprotocol/codex-acp'), path.join('.agents', 'skills', 'skiff', 'SKILL.md'))
  assert.equal(rel('gemini --acp'), path.join('.gemini', 'skills', 'skiff', 'SKILL.md'))
  assert.equal(rel('hermes acp'), path.join('.hermes', 'skills', 'skiff', 'SKILL.md'))
  assert.deepEqual(skills.status('ssh host omp acp'), { harness: null, status: 'unsupported', path: null })
})

test('install writes the skill, then leaves a current copy alone', (t) => {
  const root = scratch(t)
  const skills = createAgentSkill({ home: root, source: bundled })
  const first = skills.install('gemini --acp')
  assert.deepEqual({ harness: first.harness, status: first.status, written: first.written }, { harness: 'gemini', status: 'installed', written: true })
  assert.deepEqual(fs.readFileSync(first.path), fs.readFileSync(path.join(bundled, 'skiff', 'SKILL.md')))
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o644)
  assert.deepEqual(fs.readdirSync(path.dirname(first.path)), ['SKILL.md'])
  assert.equal(skills.status('gemini --acp').status, 'installed')
  const mtime = fs.statSync(first.path).mtimeMs
  assert.equal(skills.install('gemini --acp').written, false)
  assert.equal(fs.statSync(first.path).mtimeMs, mtime)
})

test('a file the user edited is never overwritten, one from an older Skiff is', (t) => {
  const root = scratch(t)
  const dir = source(root, 'version one\n', 'version two\n')
  const skills = createAgentSkill({ home: root, source: dir })
  const file = path.join(root, '.claude', 'skills', 'skiff', 'SKILL.md')
  const command = 'npx -y @agentclientprotocol/claude-agent-acp'
  fs.mkdirSync(path.dirname(file), { recursive: true })

  fs.writeFileSync(file, 'version one\n')
  assert.equal(skills.status(command).status, 'outdated')
  assert.deepEqual({ ...skills.install(command), path: undefined }, { harness: 'claude', status: 'installed', path: undefined, written: true })
  assert.equal(fs.readFileSync(file, 'utf8'), 'version two\n')

  fs.writeFileSync(file, 'version two\nmy own note\n')
  assert.equal(skills.status(command).status, 'modified')
  const result = skills.install(command)
  assert.deepEqual({ status: result.status, written: result.written }, { status: 'modified', written: false })
  assert.equal(fs.readFileSync(file, 'utf8'), 'version two\nmy own note\n')

  fs.writeFileSync(file, 'version one\nmy own note\n')
  assert.equal(skills.install(command).written, false)
  assert.equal(fs.readFileSync(file, 'utf8'), 'version one\nmy own note\n')
})

test('a symlinked skill file and a skills folder pointing outside home are left alone', (t) => {
  const root = scratch(t)
  const home = path.join(root, 'home')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true })
  fs.mkdirSync(path.join(home, '.gemini', 'skills', 'skiff'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'mine.md'), 'mine')
  fs.symlinkSync(path.join(outside, 'mine.md'), path.join(home, '.gemini', 'skills', 'skiff', 'SKILL.md'))
  fs.symlinkSync(outside, path.join(home, '.agents', 'skills'))
  const skills = createAgentSkill({ home, source: bundled })

  assert.equal(skills.status('gemini --acp').status, 'modified')
  assert.equal(skills.install('gemini --acp').written, false)
  assert.equal(fs.readFileSync(path.join(outside, 'mine.md'), 'utf8'), 'mine')

  assert.throws(() => skills.install('npx -y @agentclientprotocol/codex-acp'), /outside your home folder/)
  assert.deepEqual(fs.readdirSync(outside), ['mine.md'])
})

test('a skills folder that cannot be read is an error entry, not a thrown list', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads anything')
  const root = scratch(t)
  const locked = path.join(root, '.omp')
  fs.mkdirSync(locked, { mode: 0o000 })
  try {
    const skills = createAgentSkill({ home: root, source: bundled })
    assert.equal(skills.status('omp acp').status, 'error')
    assert.throws(() => skills.install('omp acp'))
  } finally {
    fs.chmodSync(locked, 0o755)
  }
})

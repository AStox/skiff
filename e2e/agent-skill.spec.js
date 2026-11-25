'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { test, expect, barReady } = require('./fixtures')

const bundledDir = path.join(__dirname, '..', 'agent-skill')
const bundled = fs.readFileSync(path.join(bundledDir, 'skiff', 'SKILL.md'), 'utf8')
const fakeAgent = path.join(__dirname, 'fake-agent.js')
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')

// A harness-named launcher that runs the fake agent, so Skiff's detection sees `omp` and the process is still ours.
function launcher(skiff, name) {
  const dir = path.join(skiff.root, 'bin')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${fakeAgent}' '${skiff.root}'\n`, { mode: 0o755 })
  return `${file} acp`
}

const skillFile = (skiff, ...dir) => path.join(skiff.home, ...dir, 'skiff', 'SKILL.md')

// Settings > Agents in Layer's card.
async function openAgents(skiff) {
  const tab = await skiff.rpc('tabs.create', { url: `${skiff.origin}/reading` })
  await expect.poll(async () => (await skiff.state()).tabs.find((t) => t.id === tab.id)?.title).toBe('Fixture reading')
  await skiff.shortcut('CmdOrCtrl+T')
  const panel = await barReady(skiff)
  await expect(async () => {
    if (!(await panel.locator('#settings-page-agents').count())) await panel.locator('#settings-toggle').click()
    await panel.locator('#settings-page-agents').click({ timeout: 1000 })
    await expect(panel.locator('#agents-section')).toBeVisible({ timeout: 1000 })
  }).toPass()
  return panel
}

async function typeInto(page, selector, text) {
  await page.locator(selector).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type(text)
}

const row = (page, name) => page.locator(`#agents-list li[data-agent="${name}"]`)

async function open(page, name) {
  const main = row(page, name).locator('.set-main')
  if ((await main.getAttribute('aria-expanded')) !== 'true') await main.click()
}

async function fill(page, name, command) {
  if (!(await page.locator('#agent-name').isVisible())) await page.locator('#agent-add-toggle').click()
  await typeInto(page, '#agent-name', name)
  await typeInto(page, '#agent-command', command)
}

test('a ticked box installs the skill when the agent is added, and an unsupported command offers nothing', async ({ skiff }) => {
  const page = await openAgents(skiff)
  await fill(page, 'Wrapped', launcher(skiff, 'omp'))
  await expect(page.locator('#agent-teach-row')).toBeVisible()
  await expect(page.locator('#agent-teach')).toBeChecked()
  await expect(page.locator('#agent-teach-row')).toHaveText('Teach it to use Skiff')

  await typeInto(page, '#agent-command', 'ssh somewhere omp acp')
  await expect(page.locator('#agent-teach-row')).toBeHidden()
  await typeInto(page, '#agent-command', launcher(skiff, 'omp'))
  await expect(page.locator('#agent-teach-row')).toBeVisible()

  expect(fs.existsSync(skillFile(skiff, '.omp', 'agent', 'skills'))).toBe(false)
  await page.locator('#agent-add').click()
  await expect(row(page, 'Wrapped')).toBeVisible()
  await open(page, 'Wrapped')
  await expect(row(page, 'Wrapped').locator('.agent-skill')).toHaveText('Skiff skill installed')
  const file = skillFile(skiff, '.omp', 'agent', 'skills')
  expect(fs.readFileSync(file, 'utf8')).toBe(bundled)
  expect(fs.statSync(file).mode & 0o777).toBe(0o644)
  expect(fs.readdirSync(path.dirname(file))).toEqual(['SKILL.md'])
  expect((await skiff.rpc('ai.agents')).find((a) => a.name === 'Wrapped').skill).toEqual({ harness: 'omp', status: 'installed', path: file })

  await fill(page, 'Remote', 'ssh somewhere omp acp')
  await expect(page.locator('#agent-teach-row')).toBeHidden()
  await page.locator('#agent-add').click()
  await expect(row(page, 'Remote')).toBeVisible()
  await open(page, 'Remote')
  await expect(row(page, 'Remote').locator('.agent-skill')).toHaveCount(0)
  expect((await skiff.rpc('ai.agents')).find((a) => a.name === 'Remote').skill).toEqual({ harness: null, status: 'unsupported', path: null })
  for (const other of ['.claude', '.gemini', '.agents', '.hermes']) expect(fs.existsSync(path.join(skiff.home, other)), other).toBe(false)
})

test("an unticked box installs nothing until the row's button is pressed, and an edited file is never overwritten", async ({ skiff }) => {
  const page = await openAgents(skiff)
  await fill(page, 'Gem', launcher(skiff, 'gemini'))
  await expect(page.locator('#agent-teach')).toBeChecked()
  await page.locator('#agent-teach').uncheck()
  await page.locator('#agent-add').click()
  const gem = row(page, 'Gem')
  await expect(gem).toBeVisible()
  await open(page, 'Gem')
  const file = skillFile(skiff, '.gemini', 'skills')
  await expect(gem.getByRole('button', { name: 'Install Skiff skill' })).toBeVisible()
  expect(fs.existsSync(path.join(skiff.home, '.gemini'))).toBe(false)

  await gem.getByRole('button', { name: 'Install Skiff skill' }).click()
  await expect(gem.locator('.agent-skill')).toHaveText('Skiff skill installed')
  expect(fs.readFileSync(file, 'utf8')).toBe(bundled)

  fs.writeFileSync(file, `${bundled}\nMy own rule: never open the news.\n`)
  const edited = fs.readFileSync(file)
  const result = await skiff.rpc('ai.installSkill', { agent: 'Gem' })
  expect({ status: result.status, written: result.written }).toEqual({ status: 'modified', written: false })
  await expect(gem.locator('.agent-skill')).toHaveText('Skiff skill edited, left as it is')
  await expect(gem.getByRole('button', { name: /Skiff skill/ })).toHaveCount(0)
  expect(fs.readFileSync(file).equals(edited)).toBe(true)

  expect((await skiff.rpc('ai.installSkill', { agent: 'Gem' })).written).toBe(false)
  expect(fs.readFileSync(file).equals(edited)).toBe(true)
  await expect(skiff.rpc('ai.installSkill', { agent: 'Nobody' })).rejects.toThrow(/No agent named Nobody/)
})

test.describe('with a newer copy of the skill shipped', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-skill-source-'))
  const newer = `${bundled}\nA newer line.\n`
  test.beforeAll(() => {
    fs.mkdirSync(path.join(source, 'skiff'))
    fs.writeFileSync(path.join(source, 'skiff', 'SKILL.md'), newer)
    fs.writeFileSync(path.join(source, 'versions.json'), JSON.stringify([{ version: 1, sha256: sha(bundled) }, { version: 2, sha256: sha(newer) }]))
    process.env.SKIFF_AGENT_SKILL_SOURCE = source
  })
  test.afterAll(() => {
    delete process.env.SKIFF_AGENT_SKILL_SOURCE
    fs.rmSync(source, { recursive: true, force: true })
  })

  test('the row of an older Skiff copy offers Update, which replaces it', async ({ skiff }) => {
    const file = skillFile(skiff, '.claude', 'skills')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bundled)
    await skiff.rpc('settings.set', { ai: { agents: [{ name: 'Claude', command: launcher(skiff, 'claude-agent-acp') }] } })
    const page = await openAgents(skiff)
    const claude = row(page, 'Claude')
    await open(page, 'Claude')
    await expect(claude.getByRole('button', { name: 'Update Skiff skill' })).toBeVisible()
    await claude.getByRole('button', { name: 'Update Skiff skill' }).click()
    await expect(claude.locator('.agent-skill')).toHaveText('Skiff skill installed')
    expect(fs.readFileSync(file, 'utf8')).toBe(newer)
  })
})

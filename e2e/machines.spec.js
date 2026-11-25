'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test, expect, barReady } = require('./fixtures')

test.use({ fixtureOptions: { bb: true } })

const fakeAgent = path.join(__dirname, 'fake-agent.js')
const command = (skiff) => `'${process.execPath}' '${fakeAgent}' '${skiff.root}'`
const MACHINES = [
  { id: 'host_mac000001', name: 'Work Mac', status: 'connected' },
  { id: 'host_lat000001', name: 'Latitude', status: 'connected' },
  { id: 'host_per000001', name: 'Personal macbook', status: 'disconnected' }
]
const shq = (text) => `'${text.replace(/'/g, `'\\''`)}'`
const LATITUDE = 'host_lat000001'
const PERSONAL = 'host_per000001'

// A stub bb and ssh on the login shell's PATH (~/.profile). The ssh stub runs the remote command locally in a separate "home", as the machine named by the alias; only `latitude` answers.
function stubs(skiff, machines = MACHINES) {
  const home = path.join(skiff.root, 'home')
  const bin = path.join(skiff.root, 'stub-bin')
  const remote = path.join(skiff.root, 'remote-home')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(remote, { recursive: true })
  fs.writeFileSync(path.join(skiff.root, 'machines.json'), JSON.stringify(machines))
  fs.writeFileSync(path.join(bin, 'bb'), `#!/bin/sh\n[ "$*" = "machine list --json" ] || exit 2\ncat '${path.join(skiff.root, 'machines.json')}'\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
echo "$@" >> '${path.join(skiff.root, 'ssh.log')}'
while [ $# -gt 0 ]; do
  case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac
done
alias=$1
shift
if [ "$alias" != latitude ]; then
  echo "ssh: Could not resolve hostname $alias: Name or service not known" >&2
  exit 255
fi
cd '${remote}'
export HOME='${remote}' SHELL=/bin/bash FAKE_HOST="$alias"
exec /bin/sh -c "$1"
`, { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.profile'), `export PATH='${bin}':"$PATH"\n`)
  fs.mkdirSync(path.join(home, '.bb-machines', 'work'), { recursive: true })
  fs.writeFileSync(path.join(home, '.bb-machines', 'work', 'host-id'), 'host_mac000001\n')
  return { remote, log: () => (fs.existsSync(path.join(skiff.root, 'ssh.log')) ? fs.readFileSync(path.join(skiff.root, 'ssh.log'), 'utf8').trim().split('\n') : []) }
}

const connect = (skiff) => skiff.rpc('settings.set', { ai: { agents: [{ name: 'Fake', command: command(skiff) }] } })
const settled = (skiff, chatId) => expect.poll(async () => (await skiff.rpc('ai.chat', { chatId })).status).toBe('ready')
const last = (page, selector) => page.locator(selector).last()
const where = async (skiff, chatId, page) => {
  const before = await page.locator('.ai-assistant').count()
  await page.locator('#chat-input').click()
  await page.keyboard.type('where-fixture')
  await page.keyboard.press('Enter')
  await expect(page.locator('.ai-assistant')).toHaveCount(before + 1)
  await settled(skiff, chatId)
  return last(page, '.ai-assistant').innerText()
}
// The fake agents of this test, by the working folder of each process.
const agentCwds = (skiff) => execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').map((line) => line.trim().split(/\s+/)).filter(([, exe, file, root]) => exe === process.execPath && file === fakeAgent && root === skiff.root).map(([pid]) => fs.readlinkSync(`/proc/${pid}/cwd`)).sort()

async function openedChat(skiff) {
  let tab
  await expect.poll(async () => {
    const s = await skiff.state()
    tab = s.tabs.find((t) => t.id === s.activeTabBySpace[s.activeSpaceId] && t.chat)
    return Boolean(tab)
  }).toBe(true)
  const chatId = tab.url.slice('skiff://chat/'.length)
  return { tab, chatId, page: await skiff.chat(chatId) }
}

test('the bar and the chat list bb machines; a remote pick runs the agent over ssh in the remote home, and a chat keeps its machine across restarts', async ({ skiff }) => {
  const fake = stubs(skiff)
  await connect(skiff)
  await expect.poll(() => skiff.rpc('ai.machines', { refresh: true })).toEqual([
    { id: '', name: 'This Mac', status: 'connected', local: true, alias: '' },
    { id: LATITUDE, name: 'Latitude', status: 'connected', local: false, alias: 'latitude' },
    { id: PERSONAL, name: 'Personal macbook', status: 'disconnected', local: false, alias: 'personal-macbook' }
  ])

  // Agent mode of the command bar: the Machine pill lists them, marks the disconnected one, and the pick runs the new question there.
  await (await skiff.bar()).waitForLoadState()
  await skiff.shortcut('CmdOrCtrl+T')
  const bar = await barReady(skiff)
  await bar.keyboard.type('summarize this page')
  await expect(bar.locator('#palette-results li').first()).toHaveAttribute('data-ask', '')
  await bar.keyboard.press('Tab')
  await expect(bar.locator('#palette-ask')).toHaveText('Ask Fake')
  const machine = bar.locator('#palette-machine')
  await expect(machine).toBeVisible()
  await expect(machine.locator('option')).toHaveText(['This Mac', 'Latitude', 'Personal macbook (disconnected)'])
  await expect(machine).toHaveValue('')
  await machine.selectOption(LATITUDE)
  await expect(bar.locator('#palette-model')).toBeEnabled()
  await bar.keyboard.press('Enter')
  const remote = await openedChat(skiff)
  await settled(skiff, remote.chatId)
  await expect(remote.page.locator('#chat-machine')).toHaveValue(LATITUDE)
  expect((await skiff.rpc('ai.chat', { chatId: remote.chatId })).machine).toBe(LATITUDE)
  expect(remote.tab.chat.machine).toBe(LATITUDE)
  expect((await skiff.state()).settings.ai.machine).toBe(LATITUDE)

  // The exact command line: ssh options, the alias, and the agent command handed to the remote login shell with $SHELL left for it to expand.
  const calls = fake.log().filter((line) => line.includes('exec "${SHELL:-/bin/sh}"'))
  expect(calls).toHaveLength(1)
  expect(calls[0]).toBe(`-T -o BatchMode=yes -o ServerAliveInterval=30 latitude exec "\${SHELL:-/bin/sh}" -lc ${shq(command(skiff))}`)
  expect(fake.log()).toContain('-T -o BatchMode=yes -o ConnectTimeout=15 latitude printf %s "$HOME"')

  const here = await skiff.rpc('ai.ask', { text: 'a local one', machine: '' })
  const local = await openedChat(skiff)
  expect(local.chatId).toBe(here.chatId)
  await settled(skiff, local.chatId)

  // Same agent twice at once: two processes, one in the remote home and one in the app's agent folder.
  const where1 = await where(skiff, remote.chatId, remote.page)
  expect(where1).toContain(`Host: latitude Cwd: ${fake.remote} Mcp: none`)
  const where2 = await where(skiff, local.chatId, local.page)
  expect(where2).toContain(`Host: local Cwd: ${path.join(skiff.root, 'data', 'ai')}`)
  expect(agentCwds(skiff)).toEqual([path.join(skiff.root, 'data', 'ai'), fake.remote].sort().map((p) => fs.realpathSync(p)))

  // A restart restores the remote chat through session/load over ssh, the local one without ssh.
  const calls1 = fake.log().length
  await skiff.restart()
  const state = await skiff.state()
  expect(state.tabs.find((t) => t.url === `skiff://chat/${remote.chatId}`).chat.machine).toBe(LATITUDE)
  expect(state.tabs.find((t) => t.url === `skiff://chat/${local.chatId}`).chat.machine).toBeUndefined()
  const again = await skiff.chat(remote.chatId)
  await settled(skiff, remote.chatId)
  await expect(again.locator('.ai-user')).toHaveText(['summarize this page', 'where-fixture'])
  await expect(again.locator('#chat-machine')).toHaveValue(LATITUDE)
  expect(fake.log().length).toBeGreaterThan(calls1)
  expect(await where(skiff, remote.chatId, again)).toContain(`Host: latitude Cwd: ${fake.remote} Mcp: none`)
  const localAgain = await skiff.chat(local.chatId)
  await settled(skiff, local.chatId)
  expect(await where(skiff, local.chatId, localAgain)).toContain('Host: local')

  // Moving a chat that has turns starts a fresh session on the other machine and says so.
  const before = (await skiff.rpc('ai.chat', { chatId: remote.chatId })).sessionId
  await again.locator('#chat-machine').selectOption('')
  await expect(again.locator('.ai-notice').last()).toContainText('The next message starts a fresh session there')
  expect(await where(skiff, remote.chatId, again)).toContain('Host: local')
  expect((await skiff.rpc('ai.chat', { chatId: remote.chatId })).sessionId).not.toBe(before)
  expect((await skiff.state()).tabs.find((t) => t.url === `skiff://chat/${remote.chatId}`).chat.machine ?? '').toBe('')
})

test('a machine ssh cannot reach shows ssh\'s own error in the chat', async ({ skiff }) => {
  stubs(skiff)
  await connect(skiff)
  await skiff.rpc('ai.ask', { text: 'are you there', machine: PERSONAL })
  const { chatId, page } = await openedChat(skiff)
  await expect.poll(async () => (await skiff.rpc('ai.chat', { chatId })).status).toBe('error')
  await expect(page.locator('#chat-machine')).toHaveValue(PERSONAL)
  await expect(page.locator('#chat-error')).toContainText('Could not resolve hostname personal-macbook')
})

test('without bb the Machine pill is hidden and agents run here as before', async ({ skiff }) => {
  const fake = stubs(skiff)
  fs.writeFileSync(path.join(skiff.root, 'stub-bin', 'bb'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await connect(skiff)
  await expect.poll(async () => (await skiff.rpc('ai.machines', { refresh: true })).length).toBe(1)
  await skiff.rpc('ai.ask', { text: 'hi' })
  const { chatId, page } = await openedChat(skiff)
  await settled(skiff, chatId)
  await expect(page.locator('#chat-model')).toBeVisible()
  await expect(page.locator('#chat-machine')).toBeHidden()
  expect(await where(skiff, chatId, page)).toContain('Host: local')
  expect(fake.log()).toEqual([])
})

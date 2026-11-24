'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { test, expect } = require('./fixtures')

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const agentCommand = (skiff) => [process.execPath, path.join(__dirname, 'fake-agent.js'), skiff.root].map(quote).join(' ')
const sessionFile = (data) => path.join(data, 'ai', 'fake-sessions.json')
const savedSessions = (skiff) => fs.existsSync(sessionFile(skiff.data)) ? JSON.parse(fs.readFileSync(sessionFile(skiff.data), 'utf8')) : {}
const settled = (skiff, chatId) => expect.poll(async () => (await skiff.rpc('ai.chat', { chatId })).status).toBe('ready')

async function tools(skiff, section) {
  await skiff.rpc('ui.openTools', { section })
  const matches = (page) => !page.isClosed() && new URL(page.url()).pathname.endsWith('/browser-tools/index.html')
  await expect.poll(() => skiff.app.context().pages().some(matches)).toBe(true)
  const panel = skiff.app.context().pages().find(matches)
  await expect(panel.locator('#content h2').first()).toBeVisible()
  return panel
}

async function send(skiff, chatId, chat, text) {
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await chat.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(chat.locator('.ai-assistant').last()).toContainText(`You said: ${text}`)
  await settled(skiff, chatId)
}

test.describe('transcripts', () => {
  test('local transcript recovery is read-only, fresh context is explicit, and visible deletion survives restart', async ({ skiff }, testInfo) => {
    test.setTimeout(90_000)
    // Only the isolated fixture's real local ACP process runs; no model or account is needed.
    await skiff.rpc('settings.set', { ai: { agents: [{ name: 'Fake', command: agentCommand(skiff) }] } })
    expect((await skiff.state()).settings.transcriptRecovery).toBe(false)
    expect(await skiff.rpc('transcripts.list')).toEqual([])

    const settings = await tools(skiff, 'settings')
    const title = 'Save conversation recovery transcripts'
    await settings.getByRole('searchbox', { name: 'Search this section' }).fill('transcript')
    const optIn = settings.locator('#content .row').filter({ has: settings.getByRole('heading', { name: title, exact: true }) })
    await expect(optIn.getByRole('checkbox', { name: title, exact: true })).not.toBeChecked()
    await optIn.getByRole('checkbox', { name: title, exact: true }).check()
    await optIn.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await skiff.state()).settings.transcriptRecovery).toBe(true)
    await settings.getByRole('button', { name: 'Close', exact: true }).click()

    const original = 'Remember the copper boat only in this original conversation.'
    const followUp = 'The original boat has seven sails.'
    const { tabId, chatId } = await skiff.rpc('ai.ask', { agent: 'Fake', text: original, includePage: false })
    let chat = await skiff.chat(chatId)
    await expect(chat.locator('.ai-assistant').last()).toContainText(`You said: ${original}`)
    await settled(skiff, chatId)
    await send(skiff, chatId, chat, followUp)
    const oldSessionId = (await skiff.rpc('ai.chat', { chatId })).sessionId
    expect(savedSessions(skiff)[oldSessionId].turns.map((turn) => turn.user)).toEqual([[original], [followUp]])
    await expect.poll(async () => (await skiff.rpc('transcripts.list')).map((record) => record.id)).toContain(chatId)

    await skiff.restart({ beforeLaunch: ({ data }) => {
      // Remove the fake agent's own durable session only after its process has stopped.
      // Skiff's local journal remains intact: session/load now genuinely rejects the old ID.
      const file = sessionFile(data)
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))[oldSessionId].turns).toHaveLength(2)
      fs.unlinkSync(file)
      expect(fs.existsSync(file)).toBe(false)
    } })
    await skiff.rpc('tabs.activate', { id: tabId })
    chat = await skiff.chat(chatId)
    await expect(chat.getByRole('heading', { name: 'Recovered transcript · read only', exact: true })).toBeVisible()
    await expect(chat.locator('.ai-user')).toHaveText([original, followUp])
    await expect(chat.locator('.ai-assistant')).toHaveCount(2)
    await expect(chat.locator('.ai-assistant').first()).toContainText(`You said: ${original}`)
    await expect(chat.locator('.ai-assistant').last()).toContainText(`You said: ${followUp}`)
    await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await expect(chat.getByRole('button', { name: 'Start fresh session', exact: true })).toBeVisible()
    const recovered = await skiff.rpc('ai.chat', { chatId })
    expect(recovered.recovery).toMatchObject({ source: 'local', readOnly: true, requiresFresh: true, transcriptId: chatId })
    expect(recovered.sessionId).toBeNull()
    await testInfo.attach('read-only-recovery', { body: await chat.screenshot(), contentType: 'image/png' })

    const fresh = 'A new conversation about the green lighthouse.'
    const input = chat.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill(fresh)
    await input.press('Enter')
    await expect(chat.locator('#chat-error')).toContainText('This transcript is read only.')
    await expect(chat.locator('.ai-user')).toHaveText([original, followUp])
    expect(Object.values(savedSessions(skiff)).flatMap((session) => session.turns)).toEqual([])

    await chat.getByRole('button', { name: 'Start fresh session', exact: true }).click()
    await expect(chat.locator('.ai-assistant').last()).toContainText(`You said: ${fresh}`)
    await settled(skiff, chatId)
    await expect(chat.locator('#chat-recovery')).toBeHidden()
    await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await expect(chat.locator('.ai-user')).toHaveText([original, followUp, fresh])
    const newSessionId = (await skiff.rpc('ai.chat', { chatId })).sessionId
    expect(newSessionId).toBeTruthy()
    expect(newSessionId).not.toBe(oldSessionId)
    // Inspect what the real ACP process received, not just what the renderer displays.
    expect(savedSessions(skiff)[newSessionId].turns.map((turn) => turn.user)).toEqual([[fresh]])
    expect(JSON.stringify(savedSessions(skiff)[newSessionId])).not.toContain(original)
    expect(JSON.stringify(savedSessions(skiff)[newSessionId])).not.toContain(followUp)

    const transcripts = await tools(skiff, 'transcripts')
    const transcript = transcripts.locator('#content .row').filter({ hasText: chatId })
    await expect(transcript).toHaveCount(1)
    await transcript.getByRole('button', { name: 'Read transcript', exact: true }).click()
    await expect(transcripts.getByRole('heading', { name: 'Read-only transcript', exact: true })).toBeVisible()
    await expect(transcripts.locator('#content pre')).toContainText(original)
    await transcript.getByRole('button', { name: 'Export text', exact: true }).click()
    const exported = transcripts.getByRole('textbox', { name: 'Exported transcript', exact: true })
    await expect(exported).not.toBeEditable()
    await expect(exported).toHaveValue(new RegExp(original.replaceAll('.', '\\.')))
    await transcript.getByRole('button', { name: 'Delete and stop recording', exact: true }).click()
    await expect(transcripts.getByRole('dialog')).toBeVisible()
    await transcripts.getByRole('dialog').getByRole('button', { name: 'Delete and stop recording', exact: true }).click()
    await expect(transcript).toHaveCount(0)
    await expect.poll(() => skiff.rpc('transcripts.list')).toEqual([])
    await transcripts.getByRole('button', { name: 'Close', exact: true }).click()

    const afterDelete = 'Continue without saving any local transcript.'
    await send(skiff, chatId, chat, afterDelete)
    expect(await skiff.rpc('transcripts.list')).toEqual([])
    await skiff.restart()
    await skiff.rpc('tabs.activate', { id: tabId })
    chat = await skiff.chat(chatId)
    // ACP session/load stays primary and still restores the agent's conversation.
    // It must not recreate the deliberately deleted local journal as it replays turns.
    await expect(chat.locator('.ai-user')).toHaveText([fresh, afterDelete])
    await settled(skiff, chatId)
    expect((await skiff.rpc('ai.chat', { chatId })).sessionId).toBe(newSessionId)
    await expect(chat.locator('#chat-recovery')).toBeHidden()
    expect(await skiff.rpc('transcripts.list')).toEqual([])
    await send(skiff, chatId, chat, 'Still not opting this conversation back into local recording.')
    expect(await skiff.rpc('transcripts.list')).toEqual([])
    const empty = await tools(skiff, 'transcripts')
    await expect(empty.locator('#content .row')).toHaveCount(0)
    await expect(empty.getByRole('button', { name: 'Read transcript', exact: true })).toHaveCount(0)
  })
})

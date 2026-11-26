'use strict'
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test, expect } = require('./fixtures')

const FORM = '/agent-form'
const href = (skiff, route) => skiff.origin + route
// Runs in the page through the main process, so Playwright's own debugger plays no part in what the page sees.
const inPage = (skiff, route, code) => skiff.app.evaluate(({ webContents }, [url, code]) => webContents.getAllWebContents().find((w) => w.getURL() === url).executeJavaScript(code), [href(skiff, route), code])
const pageFocused = (skiff, route) => skiff.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url).isFocused(), href(skiff, route))
const log = (skiff, route) => inPage(skiff, route, 'JSON.stringify(window.log)').then(JSON.parse)
const agent = (skiff, method, tabId, params = {}, name = 'bb') => skiff.rpc(method, { tabId, agent: name, ...params })
const refOf = async (skiff, tabId, pattern) => {
  const { text } = await agent(skiff, 'tabs.snapshot', tabId)
  const line = text.split('\n').find((l) => pattern.test(l))
  if (!line) throw new Error(`No ${pattern} in\n${text}`)
  return line.split(' ')[0]
}
// The error code of a call that must be refused; rpc rejects with "<method> [<code>]: <message>".
const refused = async (promise) => {
  const error = await promise.then(() => null, (e) => e)
  expect(error, 'the call was refused').not.toBeNull()
  return /\[(\w+)\]/.exec(error.message)?.[1]
}
// A person's click, from the X server, at a CSS point of a page: it goes to whatever view is on top there.
async function nativeClick(skiff, route, selector) {
  const rect = JSON.parse(await inPage(skiff, route, `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`))
  const geometry = await skiff.app.evaluate(({ BrowserWindow, webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
    const win = BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents === wc))
    return { content: win.getContentBounds(), bounds: win.contentView.children.find((v) => v.webContents === wc).getBounds() }
  }, href(skiff, route))
  const point = { x: Math.round(geometry.content.x + geometry.bounds.x + rect.x + rect.width / 2), y: Math.round(geometry.content.y + geometry.bounds.y + rect.y + rect.height / 2), click: true }
  execFileSync('python3', [path.join(__dirname, 'native-pointer.py'), JSON.stringify(point)], { timeout: 5000 })
}
// A person's keys, sent to that page alone: they reach before-input-event, as the keyboard's do.
const humanKeys = (skiff, route, text) => skiff.app.evaluate(({ webContents }, [url, text]) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
  for (const ch of text) { wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch }) }
}, [href(skiff, route), text])
const control = async (skiff, id) => {
  const at = (page) => !page.isClosed() && page.url().endsWith(`/control/control.html?tab=${id}`)
  await expect.poll(() => skiff.app.context().pages().filter(at).length).toBeGreaterThan(0)
  const page = skiff.app.context().pages().find(at)
  await page.emulateMedia({ colorScheme: 'light' })
  return page
}

async function formTab(skiff, name = 'bb') {
  return skiff.rpc('tabs.create', { url: href(skiff, FORM), agent: name })
}

test('an agent clicks and types into a form in a background tab while the user keeps the keyboard in another tab', async ({ skiff }) => {
  const user = await skiff.rpc('tabs.create', { url: href(skiff, '/article') })
  await skiff.page('/article')
  await inPage(skiff, '/article', 'document.querySelector("input").focus()')
  await skiff.rpc('ui.focusPage')
  await expect.poll(() => pageFocused(skiff, '/article')).toBe(true)
  const before = await skiff.state()

  const tab = await formTab(skiff)
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')
  const query = await refOf(skiff, tab.id, /textbox "Query"/)
  await agent(skiff, 'tabs.type', tab.id, { ref: query, text: 'select 1' })
  await agent(skiff, 'tabs.press', tab.id, { key: 'Meta+Enter' })
  await agent(skiff, 'tabs.click', tab.id, { ref: await refOf(skiff, tab.id, /button "Run Query"/) })
  await expect.poll(() => inPage(skiff, FORM, 'document.getElementById("out").textContent')).toBe('RAN: select 1')
  expect(await inPage(skiff, FORM, 'document.getElementById("q").value')).toBe('select 1')
  const seen = await log(skiff, FORM)
  expect(seen.keys).toContain('Meta+Enter')
  expect(seen.clicks).toEqual([{ target: 'run', trusted: true }])

  // The user's tab never lost the keyboard, and the agent's tab never took it or the active tab.
  expect(await pageFocused(skiff, '/article')).toBe(true)
  expect(await pageFocused(skiff, FORM)).toBe(false)
  await humanKeys(skiff, '/article', 'h')
  await expect.poll(() => inPage(skiff, '/article', 'document.querySelector("input").value')).toBe('h')
  const after = await skiff.state()
  expect([after.activeSpaceId, after.activeTabBySpace]).toEqual([before.activeSpaceId, before.activeTabBySpace])
  expect(after.tabs.find((t) => t.id === tab.id)).toMatchObject({ agent: 'bb', agentState: 'working' })
  expect(after.tabs.find((t) => t.id === user.id).agent).toBeUndefined()

  // A page is a picture and a scroll position too, from the same tab.
  const shot = await agent(skiff, 'tabs.screenshot', tab.id)
  expect(shot).toMatchObject({ mime: 'image/jpeg', width: 1280 })
  expect(Buffer.from(shot.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')
  await agent(skiff, 'tabs.wait', tab.id, { text: 'RAN: select 1', timeout: 2000 })
  expect(await refused(agent(skiff, 'tabs.wait', tab.id, { text: 'never there', timeout: 300 }))).toBe('timeout')
  await agent(skiff, 'tabs.type', tab.id, { ref: query, text: 'x', clear: true })
  expect(await inPage(skiff, FORM, 'document.getElementById("q").value')).toBe('x')
})

test('an agent drives only a tab it opened or was handed, for the owner CLI and for a scoped MCP grant alike', async ({ skiff }) => {
  const user = await skiff.rpc('tabs.create', { url: href(skiff, FORM) })
  await skiff.page(FORM)
  const mine = await formTab(skiff, 'omp')
  await expect.poll(() => skiff.state().then((s) => s.tabs.find((t) => t.id === mine.id).title)).toBe('Agent form')

  // Not the user's tab, not another agent's, not a name left out.
  expect(await refused(agent(skiff, 'tabs.snapshot', user.id))).toBe('forbidden')
  expect(await refused(agent(skiff, 'tabs.snapshot', mine.id, {}, 'bb'))).toBe('forbidden')
  expect(await refused(skiff.rpc('tabs.snapshot', { tabId: mine.id }))).toBe('bad_params')
  expect(await refused(skiff.rpc('tabs.click', { tabId: mine.id, x: 5, y: 5 }))).toBe('bad_params')
  expect((await agent(skiff, 'tabs.snapshot', mine.id, {}, 'omp')).refs).toBeGreaterThan(0)

  // Handing a tab over is the user's command; the agent then drives it, and it is saved as the user's own.
  await skiff.rpc('tabs.handToAgent', { id: user.id, agent: 'bb' })
  expect(await skiff.state().then((s) => s.tabs.find((t) => t.id === user.id))).toMatchObject({ agent: 'bb', agentState: 'idle', agentControl: 'agent' })
  expect((await agent(skiff, 'tabs.snapshot', user.id)).refs).toBeGreaterThan(0)

  // A scoped grant is its own agent: it cannot name another, opens agent tabs, and drives only those.
  const space = (await skiff.state()).activeSpaceId
  const grant = await skiff.rpc('grants.issue', { owner: 'Scoped', spaceIds: [space], read: true, mutate: true })
  const mcp = async (method, params) => {
    const api = skiff.api()
    const response = await fetch(`http://127.0.0.1:${api.port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return response.json()
  }
  const listed = (await mcp('tools/list', {})).result.tools
  const names = listed.map((t) => t.name)
  for (const tool of ['browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_screenshot', 'browser_wait', 'browser_request_tab', 'browser_finish']) expect(names).toContain(tool)
  expect(listed.find((t) => t.name === 'browser_click').inputSchema.properties.agent).toBeUndefined()
  const opened = JSON.parse((await mcp('tools/call', { name: 'browser_open_tab', arguments: { url: href(skiff, FORM) } })).result.content[0].text)
  expect(opened).toMatchObject({ agent: 'Scoped', agentState: 'working' })
  const call = async (name, args) => (await mcp('tools/call', { name, arguments: args })).result
  expect((await call('browser_snapshot', { tabId: opened.id })).isError).toBeUndefined()
  const other = await call('browser_snapshot', { tabId: user.id })
  expect(other.isError).toBe(true)
  expect(other.content[0].text).toContain("not Scoped's")
  const picture = await call('browser_screenshot', { tabId: opened.id })
  expect(picture.content.map((c) => c.type)).toEqual(['image', 'text'])
})

test('an agent asks for a tab: Allow hands it over, Deny refuses, and the call resolves with the answer', async ({ skiff }) => {
  const user = await skiff.rpc('tabs.create', { url: href(skiff, FORM) })
  await skiff.page(FORM)
  const ask = () => skiff.http('agent.requestTab', { id: user.id, agent: 'bb' })

  const denied = ask()
  await expect.poll(() => skiff.state().then((s) => s.tabs.find((t) => t.id === user.id).agentRequest)).toEqual({ agent: 'bb' })
  // The strip is on the tab itself: only its top is a view over the page, with the two answers.
  const strip = await control(skiff, user.id)
  await expect(strip.locator('#text')).toHaveText('bb wants to use this tab')
  await expect(strip.locator('#actions button')).toHaveText(['Deny', 'Allow'])
  expect(await refused(agent(skiff, 'tabs.snapshot', user.id))).toBe('forbidden')
  await strip.getByRole('button', { name: 'Deny' }).click()
  expect(await denied).toMatchObject({ ok: true, result: { allowed: false, agent: 'bb' } })
  expect(await skiff.state().then((s) => s.tabs.find((t) => t.id === user.id))).not.toHaveProperty('agent')
  expect(await refused(agent(skiff, 'tabs.snapshot', user.id))).toBe('forbidden')

  const allowed = ask()
  await expect.poll(() => skiff.state().then((s) => s.tabs.find((t) => t.id === user.id).agentRequest)).toEqual({ agent: 'bb' })
  await (await control(skiff, user.id)).getByRole('button', { name: 'Allow' }).click()
  expect(await allowed).toMatchObject({ ok: true, result: { allowed: true, agent: 'bb' } })
  expect(await skiff.state().then((s) => s.tabs.find((t) => t.id === user.id))).toMatchObject({ agent: 'bb', agentState: 'idle' })
  expect((await agent(skiff, 'tabs.snapshot', user.id)).refs).toBeGreaterThan(0)
  // Asking again for a tab it has answers at once; a command answers for the user too.
  expect((await ask()).result).toMatchObject({ allowed: true })
  await skiff.rpc('tabs.handToAgent', { id: user.id, agent: 'omp' })
  const pending = skiff.http('agent.requestTab', { id: user.id, agent: 'bb' })
  await expect.poll(() => skiff.state().then((s) => s.tabs.find((t) => t.id === user.id).agentRequest)).toEqual({ agent: 'bb' })
  await skiff.rpc('agent.answerTab', { id: user.id, allow: false })
  expect((await pending).result).toMatchObject({ allowed: false })
})

test('while an agent works its page is locked: a person\'s clicks and keys are swallowed, Take over refuses the agent, Give back returns it', async ({ skiff }) => {
  const user = await skiff.rpc('tabs.create', { url: href(skiff, '/article') })
  await skiff.page('/article')
  const tab = await formTab(skiff)
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')
  const query = await refOf(skiff, tab.id, /textbox "Query"/)
  const run = await refOf(skiff, tab.id, /button "Run Query"/)
  // Look at it: the tab shows like any tab, with the control layer over its page.
  await skiff.rpc('tabs.activate', { id: tab.id })
  const layer = await control(skiff, tab.id)
  await expect(layer.locator('body')).toHaveAttribute('data-mode', 'lock')
  await expect(layer.locator('#text')).toHaveText('bb is using this tab')
  await agent(skiff, 'tabs.click', tab.id, { ref: query })

  // A real click from the X server lands on the layer, and keys sent to the page are dropped before it sees them.
  await nativeClick(skiff, FORM, '#run')
  await humanKeys(skiff, FORM, 'zz')
  await agent(skiff, 'tabs.type', tab.id, { ref: query, text: 'ok' })
  await skiff.shell.waitForTimeout(300)
  const swallowed = await log(skiff, FORM)
  expect(swallowed.clicks.filter((c) => c.target === 'run')).toEqual([])
  expect(swallowed.keys).not.toContain('z')
  expect(await inPage(skiff, FORM, 'document.getElementById("q").value')).toBe('ok')
  // The agent's own key press passes the same guard.
  await agent(skiff, 'tabs.press', tab.id, { key: 'Enter' })
  await expect.poll(async () => (await log(skiff, FORM)).keys).toContain('Enter')

  // Take over: the layer shrinks to a strip, the agent is refused with a code it can act on, and the user's click lands.
  await layer.getByRole('button', { name: 'Take over' }).click()
  await expect.poll(() => skiff.state().then((s) => s.tabs.find((t) => t.id === tab.id).agentControl)).toBe('user')
  await expect(layer.locator('body')).toHaveAttribute('data-mode', 'user')
  expect(await refused(agent(skiff, 'tabs.click', tab.id, { ref: run }))).toBe('user_has_control')
  expect(await refused(agent(skiff, 'tabs.type', tab.id, { ref: query, text: 'no' }))).toBe('user_has_control')
  await nativeClick(skiff, FORM, '#run')
  await expect.poll(async () => (await log(skiff, FORM)).clicks.filter((c) => c.target === 'run').length).toBe(1)
  await expect.poll(() => inPage(skiff, FORM, 'document.getElementById("out").textContent')).toBe('RAN: ok')
  await humanKeys(skiff, FORM, 'q')
  await expect.poll(async () => (await log(skiff, FORM)).keys).toContain('q')
  expect((await skiff.state()).tabs.find((t) => t.id === user.id).agent).toBeUndefined()

  // Give back: the agent works again, and the layer comes back with its next call.
  await layer.getByRole('button', { name: 'Give back' }).click()
  await expect.poll(() => skiff.state().then((s) => s.tabs.find((t) => t.id === tab.id).agentControl)).toBe('agent')
  await agent(skiff, 'tabs.type', tab.id, { ref: query, text: 'again', clear: true })
  await expect((await control(skiff, tab.id)).locator('body')).toHaveAttribute('data-mode', 'lock')
  expect(await inPage(skiff, FORM, 'document.getElementById("q").value')).toBe('again')
  // The same commands are the buttons.
  await skiff.rpc('agent.takeOver', { id: tab.id })
  expect(await refused(agent(skiff, 'tabs.press', tab.id, { key: 'Enter' }))).toBe('user_has_control')
  await skiff.rpc('agent.giveBack', { id: tab.id })
  await agent(skiff, 'tabs.press', tab.id, { key: 'Tab' })
})

test('an agent tab shows working, then done with an unseen mark that viewing clears, and works again on its next call', async ({ skiff }) => {
  const tab = await formTab(skiff)
  const stateOf = () => skiff.state().then((s) => s.tabs.find((t) => t.id === tab.id))
  expect(await stateOf()).toMatchObject({ agentState: 'working', agentControl: 'agent' })
  await agent(skiff, 'agent.finish', tab.id, { summary: 'filled the form' })
  expect(await stateOf()).toMatchObject({ agentState: 'done', agentUnseen: true, agentSummary: 'filled the form' })
  expect(await refused(skiff.rpc('agent.finish', { tabId: tab.id, agent: 'omp' }))).toBe('forbidden')
  await skiff.rpc('tabs.activate', { id: tab.id })
  const seen = await stateOf()
  expect(seen.agentUnseen).toBeUndefined()
  expect(seen).toMatchObject({ agentState: 'done' })
  // The next call starts work again.
  await agent(skiff, 'tabs.snapshot', tab.id)
  expect(await stateOf()).toMatchObject({ agentState: 'working' })
})

test('the pill marks an agent tab working, then done and unseen, and viewing the tab takes the unseen ring away', async ({ skiff }) => {
  const tab = await formTab(skiff, 'bb')
  const buoy = await skiff.bar()
  const icon = buoy.locator(`.buoy-tab[data-tab-id="${tab.id}"]`)
  const dot = icon.locator('.agent-dot')
  await expect(dot).toHaveAttribute('data-state', 'working')
  await expect(icon).toHaveAttribute('aria-label', /, bb working$/)

  await agent(skiff, 'agent.finish', tab.id, { summary: 'done' })
  await expect(dot).toHaveAttribute('data-state', 'done')
  await expect(dot).toHaveAttribute('data-unseen', '')
  await expect(icon).toHaveAttribute('aria-label', /, bb done$/)
  await icon.click()
  await expect.poll(async () => (await skiff.state()).activeTabBySpace[(await skiff.state()).activeSpaceId]).toBe(tab.id)
  await expect(dot).toHaveAttribute('data-state', 'done')
  await expect(dot).not.toHaveAttribute('data-unseen', '')
  expect((await skiff.state()).tabs.find((t) => t.id === tab.id).agentUnseen).toBeUndefined()
})

test('an agent key press never runs an app menu item', async ({ skiff }) => {
  const tab = await formTab(skiff)
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')
  await skiff.rpc('tabs.activate', { id: tab.id })
  await skiff.app.evaluate(({ Menu }) => {
    global.__menuClicks = []
    for (const item of Menu.getApplicationMenu().items.flatMap((menu) => menu.submenu?.items || [])) item.click = () => global.__menuClicks.push(item.accelerator || item.label)
  })
  for (const key of ['CmdOrCtrl+F', 'CmdOrCtrl+,', 'Meta+Enter', 'Escape', 'Control+Shift+a']) await agent(skiff, 'tabs.press', tab.id, { key })
  expect(await skiff.app.evaluate(() => global.__menuClicks)).toEqual([])
  // A person's shortcut in the same tab, once they have taken it over, still runs its item.
  await skiff.rpc('agent.takeOver', { id: tab.id })
  await skiff.app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['control'] })
  }, href(skiff, FORM))
  await expect.poll(() => skiff.app.evaluate(() => global.__menuClicks)).toEqual(['CmdOrCtrl+F'])
})

// What a chain's own failure looks like to the agent: the call succeeds and says where it stopped.
const steps = (skiff, tabId, list, name = 'bb') => agent(skiff, 'tabs.steps', tabId, { steps: list }, name)
const typed = (skiff) => inPage(skiff, FORM, 'document.getElementById("q").value')

test('tabs.steps does a form in one call and returns each step\'s result', async ({ skiff }) => {
  const tab = await formTab(skiff)
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')
  const query = await refOf(skiff, tab.id, /textbox "Query"/)
  const run = await refOf(skiff, tab.id, /button "Run Query"/)
  const reply = await steps(skiff, tab.id, [
    { do: 'type', ref: query, text: 'select 1', clear: true },
    { do: 'press', key: 'Meta+Enter' },
    { do: 'click', ref: run },
    { do: 'snapshot' },
    { do: 'read' }
  ])
  expect(Object.keys(reply)).toEqual(['results'])
  expect(reply.results.map((r) => r.do)).toEqual(['type', 'press', 'click', 'snapshot', 'read'])
  expect(reply.results[0]).toMatchObject({ typed: 8 })
  expect(reply.results[3].text).toContain('button "Run Query"')
  expect(reply.results[4].text).toContain('RAN: select 1')
  const seen = await log(skiff, FORM)
  expect(seen.keys).toContain('Meta+Enter')
  expect(seen.clicks).toEqual([{ target: 'run', trusted: true }])
  // A snapshot step renews the refs like the single command: the new ones work in the next call.
  const fresh = await steps(skiff, tab.id, [{ do: 'snapshot' }])
  const again = fresh.results[0].text.split('\n').find((l) => /button "Run Query"/.test(l)).split(' ')[0]
  expect((await steps(skiff, tab.id, [{ do: 'click', ref: again }])).results[0]).toMatchObject({ do: 'click', clicked: again })

  // Looking right after an action that loads a page sees the page it led to.
  const moved = await steps(skiff, tab.id, [{ do: 'navigate', url: href(skiff, '/article') }, { do: 'snapshot' }])
  expect(moved.results.map((r) => r.do)).toEqual(['navigate', 'snapshot'])
  expect(moved.results[1].url).toBe(href(skiff, '/article'))
})

test('a failing step stops the chain: earlier results come back with failed and notRun, and later steps do nothing', async ({ skiff }) => {
  const tab = await formTab(skiff)
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')
  const query = await refOf(skiff, tab.id, /textbox "Query"/)
  const reply = await steps(skiff, tab.id, [
    { do: 'type', ref: query, text: 'first', clear: true },
    { do: 'click', ref: 'e999' },
    { do: 'type', ref: query, text: 'second', clear: true },
    { do: 'snapshot' }
  ])
  expect(Object.keys(reply)).toEqual(['failed', 'notRun', 'results'])
  expect(reply.failed).toMatchObject({ step: 2, do: 'click', code: 'bad_params' })
  expect(reply.failed.message).toContain('e999')
  expect(reply.notRun).toEqual(['type', 'snapshot'])
  expect(reply.results.map((r) => r.do)).toEqual(['type'])
  expect(await typed(skiff)).toBe('first')
  // A last step that fails has nothing left to report as not run.
  const last = await steps(skiff, tab.id, [{ do: 'press', key: 'Tab' }, { do: 'wait', text: 'never there', timeout: 200 }])
  expect(last.failed).toMatchObject({ step: 2, do: 'wait', code: 'timeout' })
  expect(last.notRun).toBeUndefined()
})

test('a chain on a tab the agent does not hold is refused like the single command, and a Take over stops it before the next step', async ({ skiff }) => {
  const user = await skiff.rpc('tabs.create', { url: href(skiff, '/article') })
  await skiff.page('/article')
  const mine = await formTab(skiff, 'omp')
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')
  // The user's tab and another agent's: the first step fails with the code the single command gives, and nothing ran.
  for (const [tabId, name] of [[user.id, 'bb'], [mine.id, 'bb']]) {
    for (const first of [{ do: 'type', text: 'no' }, { do: 'read' }, { do: 'navigate', url: href(skiff, '/article') }]) {
      const reply = await steps(skiff, tabId, [first, { do: 'snapshot' }], name)
      expect(reply.failed, JSON.stringify(first)).toMatchObject({ step: 1, do: first.do, code: 'forbidden' })
      expect(reply.notRun).toEqual(['snapshot'])
      expect(reply.results).toEqual([])
    }
  }
  expect(await refused(agent(skiff, 'tabs.type', user.id, { text: 'no' }))).toBe('forbidden')
  expect(await typed(skiff)).toBe('')

  // After a Take over the next chain is refused, for every kind of first step.
  await skiff.rpc('agent.takeOver', { id: mine.id })
  for (const first of [{ do: 'snapshot' }, { do: 'read' }]) expect((await steps(skiff, mine.id, [first], 'omp')).failed).toMatchObject({ step: 1, code: 'user_has_control' })
  await skiff.rpc('agent.giveBack', { id: mine.id })

  // A Take over in the middle of a chain stops it at the next step.
  await inPage(skiff, FORM, 'setTimeout(() => { document.getElementById("out").textContent = "LATE" }, 800)')
  const chain = steps(skiff, mine.id, [{ do: 'wait', text: 'LATE', timeout: 5000 }, { do: 'type', text: 'after', clear: true }, { do: 'snapshot' }], 'omp')
  await skiff.shell.waitForTimeout(250)
  await skiff.rpc('agent.takeOver', { id: mine.id })
  const stopped = await chain
  expect(stopped.results.map((r) => r.do)).toEqual(['wait'])
  expect(stopped.failed).toMatchObject({ step: 2, do: 'type', code: 'user_has_control' })
  expect(stopped.notRun).toEqual(['snapshot'])
  expect(await typed(skiff)).toBe('')
})

test('a malformed chain fails with bad_params before any step runs', async ({ skiff }) => {
  const tab = await formTab(skiff)
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')
  const query = await refOf(skiff, tab.id, /textbox "Query"/)
  const type = { do: 'type', ref: query, text: 'oops' }
  const malformed = [
    [],
    Array.from({ length: 21 }, () => ({ do: 'press', key: 'Tab' })),
    'press',
    [type, { do: 'bogus' }],
    [type, { key: 'Tab' }],
    [type, { do: 'press', key: 'Tab', agent: 'bb' }],
    [type, { do: 'press', key: 'Tab', tabId: tab.id }],
    [type, { do: 'press', key: 'Tab', id: tab.id }],
    [type, { do: 'press' }],
    [type, { do: 'click', ref: 5 }],
    [type, { do: 'scroll', dy: 'far' }],
    [type, { do: 'read', extra: true }],
    [type, { do: 'navigate' }]
  ]
  for (const list of malformed) expect(await refused(steps(skiff, tab.id, list)), JSON.stringify(list).slice(0, 80)).toBe('bad_params')
  expect(await refused(skiff.rpc('tabs.steps', { tabId: tab.id, steps: [type] }))).toBe('bad_params')
  expect(await typed(skiff)).toBe('')
  expect((await log(skiff, FORM)).keys).toEqual([])
})

test('a scoped grant sees browser_steps, keeps its own rules in a chain, and gets a screenshot step as an image', async ({ skiff }) => {
  const user = await skiff.rpc('tabs.create', { url: href(skiff, '/article') })
  await skiff.page('/article')
  const space = (await skiff.state()).activeSpaceId
  const asGrant = (token) => async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${skiff.api().port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    return (await response.json()).result
  }
  const full = await skiff.rpc('grants.issue', { owner: 'Scoped', spaceIds: [space], read: true, mutate: true })
  const listed = await fetch(`http://127.0.0.1:${skiff.api().port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${full.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((r) => r.json())
  const tool = listed.result.tools.find((t) => t.name === 'browser_steps')
  expect(tool).toBeTruthy()
  expect(tool.inputSchema.properties.agent).toBeUndefined()
  expect(tool.inputSchema.properties.steps).toBeTruthy()
  const call = asGrant(full.token)
  const opened = JSON.parse((await call('browser_open_tab', { url: href(skiff, FORM) })).content[0].text)
  await expect.poll(() => inPage(skiff, FORM, 'document.readyState').catch(() => '')).toBe('complete')

  // Its own tab: text first, the screenshot's picture as image content after it.
  const own = await call('browser_steps', { tabId: opened.id, steps: [{ do: 'snapshot' }, { do: 'screenshot' }] })
  expect(own.isError).toBeUndefined()
  expect(own.content.map((c) => c.type)).toEqual(['text', 'image'])
  expect(own.content[1]).toMatchObject({ mimeType: 'image/jpeg' })
  expect(Buffer.from(own.content[1].data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')
  const body = JSON.parse(own.content[0].text)
  expect(body.results.map((r) => r.do)).toEqual(['snapshot', 'screenshot'])
  expect(body.results[1]).toMatchObject({ mime: 'image/jpeg', width: 1280 })
  expect(body.results[1].data).toBeUndefined()

  // A tab in its space that it neither opened nor was handed: the chain stops at its first step.
  const notMine = JSON.parse((await call('browser_steps', { tabId: user.id, steps: [{ do: 'snapshot' }] })).content[0].text)
  expect(notMine.failed).toMatchObject({ step: 1, do: 'snapshot', code: 'forbidden' })
  expect(notMine.failed.message).toContain("not Scoped's")
  // A tab outside its grant: the whole call is refused.
  const elsewhere = await skiff.rpc('spaces.create', { name: 'Elsewhere' })
  const outside = await skiff.rpc('tabs.create', { url: href(skiff, '/article'), spaceId: elsewhere.id, activate: false })
  const refusedAll = await call('browser_steps', { tabId: outside.id, steps: [{ do: 'snapshot' }] })
  expect(refusedAll.isError).toBe(true)

  // A grant that may drive but not read: the read step is held to that, and the step before it still ran.
  const narrow = await skiff.rpc('grants.issue', { owner: 'Narrow', spaceIds: [space], read: false, mutate: true })
  const small = asGrant(narrow.token)
  const theirs = JSON.parse((await small('browser_open_tab', { url: href(skiff, FORM) })).content[0].text)
  const cut = JSON.parse((await small('browser_steps', { tabId: theirs.id, steps: [{ do: 'snapshot' }, { do: 'read' }] })).content[0].text)
  expect(cut.failed).toMatchObject({ step: 2, do: 'read', code: 'forbidden' })
  expect(cut.results.map((r) => r.do)).toEqual(['snapshot'])
})

'use strict'
const S = require('./state')

// Drives one tab through its own DevTools channel (webContents.debugger): never the OS keyboard, mouse or focus.
// Coordinates are CSS pixels of the page viewport. visual {glide, ripple, highlight} draws the agent's cursor; it may do nothing.

const MAX_REFS = 300
const MAX_TEXT = 24000
const SHOT_WIDTH = 1280
const SHOT_QUALITY = 60
const CALL_MS = 15000
const WAIT_MS = 10000
const WAIT_MAX_MS = 60000
const LOAD_MS = 15000
// Settling after an action: a grace for a navigation to start, then the DOM must be quiet for QUIET_MS, for at most QUIET_MAX_MS.
// ponytail: a page that never stops changing (a ticker, a script-driven animation) costs QUIET_MAX_MS on every action; raise QUIET_MS or skip the watch per site if that matters.
const SETTLE_GRACE_MS = 50
const QUIET_MS = 150
const QUIET_MAX_MS = 1500

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton', 'option', 'listbox', 'treeitem', 'PopUpButton', 'DisclosureTriangle'])
const SHOWN_PROPS = ['focused', 'checked', 'disabled', 'expanded', 'selected', 'required', 'invalid', 'readonly']
const MODIFIERS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 }
const NAMED = {
  enter: [13, 'Enter', 'Enter', '\r'], return: [13, 'Enter', 'Enter', '\r'], tab: [9, 'Tab', 'Tab'], escape: [27, 'Escape', 'Escape'], esc: [27, 'Escape', 'Escape'],
  backspace: [8, 'Backspace', 'Backspace'], delete: [46, 'Delete', 'Delete'], del: [46, 'Delete', 'Delete'], insert: [45, 'Insert', 'Insert'],
  arrowup: [38, 'ArrowUp', 'ArrowUp'], up: [38, 'ArrowUp', 'ArrowUp'], arrowdown: [40, 'ArrowDown', 'ArrowDown'], down: [40, 'ArrowDown', 'ArrowDown'],
  arrowleft: [37, 'ArrowLeft', 'ArrowLeft'], left: [37, 'ArrowLeft', 'ArrowLeft'], arrowright: [39, 'ArrowRight', 'ArrowRight'], right: [39, 'ArrowRight', 'ArrowRight'],
  home: [36, 'Home', 'Home'], end: [35, 'End', 'End'], pageup: [33, 'PageUp', 'PageUp'], pagedown: [34, 'PageDown', 'PageDown'], space: [32, ' ', 'Space', ' ']
}
const PUNCT = { '-': [189, 'Minus'], '=': [187, 'Equal'], ',': [188, 'Comma'], '.': [190, 'Period'], '/': [191, 'Slash'], ';': [186, 'Semicolon'], "'": [222, 'Quote'], '[': [219, 'BracketLeft'], ']': [221, 'BracketRight'], '\\': [220, 'Backslash'], '`': [192, 'Backquote'] }
// Editing shortcuts need the native command; a synthetic key event alone does not run them.
const COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' }

const bad = (message) => S.err('bad_params', message)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// "Meta+Enter", "Shift+Tab", "a", "F5": the events of one key press.
function parseKey(text) {
  if (typeof text !== 'string' || !text) throw bad('key must be a non-empty string')
  const parts = text.endsWith('+') && text.length > 1 ? [...text.slice(0, -2).split('+'), '+'] : text.split('+')
  const key = parts.pop()
  let modifiers = 0
  for (const part of parts) {
    const name = part.toLowerCase() === 'cmdorctrl' ? (process.platform === 'darwin' ? 'meta' : 'control') : part.toLowerCase()
    if (!Object.hasOwn(MODIFIERS, name)) throw bad(`Unknown modifier ${part}`)
    modifiers |= MODIFIERS[name]
  }
  const named = NAMED[key.toLowerCase()]
  let [vk, name, code, character] = named || []
  if (!named) {
    if (/^F([1-9]|1[0-2])$/i.test(key)) [vk, name, code] = [111 + Number(key.slice(1)), key.toUpperCase(), key.toUpperCase()]
    else if (key.length === 1 && /[a-z]/i.test(key)) {
      vk = key.toUpperCase().charCodeAt(0)
      code = `Key${key.toUpperCase()}`
      name = modifiers & 8 ? key.toUpperCase() : key.toLowerCase()
      character = name
    } else if (key.length === 1 && /[0-9]/.test(key)) [vk, name, code, character] = [key.charCodeAt(0), key, `Digit${key}`, key]
    else if (key.length === 1 && PUNCT[key]) [vk, name, code, character] = [PUNCT[key][0], key, PUNCT[key][1], key]
    else throw bad(`Unknown key ${key}`)
  }
  // A shortcut types nothing.
  const text_ = modifiers & ~8 ? undefined : character
  const commands = modifiers & 6 && !(modifiers & 1) && !(modifiers & 8) && COMMANDS[name] ? [COMMANDS[name]] : undefined
  return { modifiers, key: name, code, vk, text: text_, commands }
}

const quadCenter = (quad) => {
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const area = Math.abs(quad[0] * quad[3] - quad[2] * quad[1] + quad[2] * quad[5] - quad[4] * quad[3] + quad[4] * quad[7] - quad[6] * quad[5] + quad[6] * quad[1] - quad[0] * quad[7]) / 2
  return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), left: Math.min(...xs), top: Math.min(...ys), area }
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const quote = (text, n = 100) => JSON.stringify(clip(String(text).replace(/\s+/g, ' ').trim(), n))

const LIVE = new Set(['status', 'alert', 'alertdialog', 'log'])
const LIVE_TEXT = 200

// Refs outlive snapshots: a node keeps the ref it first got for as long as its document is in the tab, and a number is never reused.
// A document whose root node is new (a real navigation, not an in-page one) starts again from e1.
const newRefs = () => ({ doc: undefined, nodes: new Map(), byNode: new Map(), next: 1 })

// What a status, alert or log says: the static text under it.
function said(node, byId) {
  const parts = []
  const walk = (parent) => {
    for (const id of parent.childIds || []) {
      const child = byId.get(id)
      if (!child) continue
      if (child.role?.value !== 'StaticText') walk(child)
      else if (!child.ignored && child.name?.value) parts.push(child.name.value)
    }
  }
  walk(node)
  return parts.join(' ') || node.name?.value || ''
}

// Interactive nodes of a CDP accessibility tree as lines "e12 button "Run" [disabled]", with page headings and what the page says back
// (status, alert, alertdialog, log) as lines without a ref. `refs` (newRefs()) is updated in place and keeps the numbers across calls.
// Returns {lines, count: lines with a ref, truncated}.
function outline(nodes, refs = newRefs()) {
  const doc = nodes.find((node) => node.role?.value === 'RootWebArea')?.backendDOMNodeId
  if (doc !== refs.doc) Object.assign(refs, newRefs(), { doc })
  let byId
  const lines = []
  let size = 0
  let truncated = 0
  let count = 0
  for (const node of nodes) {
    if (node.ignored) continue
    const role = node.role?.value
    const heading = role === 'heading'
    const live = LIVE.has(role)
    if (!INTERACTIVE.has(role) && !heading && !live) continue
    const props = new Map((node.properties || []).map((p) => [p.name, p.value?.value]))
    const name = live ? said(node, byId ??= new Map(nodes.map((n) => [n.nodeId, n]))) : node.name?.value
    if ((heading || live) && !name) continue
    let line
    let ref
    if (heading) line = `heading${props.get('level') ? ` h${props.get('level')}` : ''} ${quote(name)}`
    else if (live) line = `${role} ${quote(name, LIVE_TEXT)}`
    else {
      if (node.backendDOMNodeId === undefined) continue
      const flags = SHOWN_PROPS.filter((p) => props.get(p) === true || (p === 'checked' && props.get(p) === 'mixed') || (p === 'invalid' && props.get(p) && props.get(p) !== 'false')).map((p) => (props.get(p) === 'mixed' ? 'mixed' : p))
      const value = node.value?.value
      const href = props.get('url')
      line = `ref ${role}${name ? ` ${quote(name)}` : ''}${value !== undefined && value !== '' ? ` value=${quote(value)}` : ''}${href ? ` href=${clip(String(href), 120)}` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}`
      if (count >= MAX_REFS || size > MAX_TEXT) { truncated++; continue }
      ref = refs.byNode.get(node.backendDOMNodeId) ?? `e${refs.next}`
      line = line.replace('ref', ref)
    }
    if (size + line.length > MAX_TEXT) { truncated++; continue }
    if (ref !== undefined) {
      count++
      if (!refs.byNode.has(node.backendDOMNodeId)) {
        refs.byNode.set(node.backendDOMNodeId, ref)
        refs.nodes.set(ref, node.backendDOMNodeId)
        refs.next++
      }
    }
    size += line.length + 1
    lines.push(line)
  }
  return { lines, count, truncated }
}

const render = (lines, truncated) => lines.join('\n') + (truncated ? `\n(${truncated} more elements not shown; scroll or narrow the page)` : '') || '(no interactive elements)'

const refOf = (line) => /^e\d+(?= )/.exec(line)?.[0]
// A line is named by its ref, or by its whole text (and which copy of it) when it has none.
function keysOf(lines) {
  const seen = new Map()
  return lines.map((line) => {
    const ref = refOf(line)
    if (ref) return ref
    const n = seen.get(line) || 0
    seen.set(line, n + 1)
    return `${line}\n${n}`
  })
}

// What an agent is told about the page after an action: `before` is the lines of the last outline it was given (null if none for this document),
// `after` the lines now, `full` the whole outline as text. Returns {changed} (one line per difference: "- " went, "+ " came, "~ " a ref whose line changed, shown as it is now)
// or {text: full} when there is nothing to compare with or the difference is longer than the outline.
function compare(before, after, full) {
  if (!before) return { text: full }
  const was = keysOf(before)
  const now = keysOf(after)
  const wasLine = new Map(was.map((key, i) => [key, before[i]]))
  const nowKeys = new Set(now)
  const diff = [
    ...was.flatMap((key, i) => (nowKeys.has(key) ? [] : [`- ${before[i]}`])),
    ...now.flatMap((key, i) => (!wasLine.has(key) ? [`+ ${after[i]}`] : wasLine.get(key) !== after[i] ? [`~ ${after[i]}`] : []))
  ].join('\n')
  if (!diff) return { changed: 'Nothing on the page changed.' }
  return diff.length > full.length ? { text: full } : { changed: diff }
}

function createAgentBrowser({ contentsOf, awake = () => {}, visual = {} }) {
  const channels = new Map()
  // tab id -> {wc, refs, sent}: the refs handed out for the tab's current document and the last outline delivered for it.
  const pages = new Map()
  // tab id -> the DevTools events being sent right now, as the page's before-input-event / before-mouse-event will report them.
  const sending = new Map()
  const none = { glide: async () => {}, ripple: () => {}, highlight: () => {} }
  const draw = { ...none, ...visual }

  function contents(id) {
    const wc = contentsOf(id)
    if (!wc || wc.isDestroyed()) throw S.err('not_found', `Tab ${id} has no page`)
    return wc
  }

  // The page is read and driven once it has stopped loading.
  async function ready(wc) {
    if (!wc.isLoading()) return
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); wc.off('did-stop-loading', done); resolve() }
      const timer = setTimeout(done, LOAD_MS)
      wc.on('did-stop-loading', done)
    })
  }

  // After an action: a moment for a navigation to start, then wait while the page loads, until the DOM has been quiet for QUIET_MS (at most QUIET_MAX_MS), and once more for a load that began meanwhile.
  async function settle(id) {
    await sleep(SETTLE_GRACE_MS)
    const wc = contents(id)
    for (let tries = 0; tries < 2; tries++) {
      const c = await channel(id)
      try { await quiet(c); break } catch { await ready(wc) /* the page navigated under the watcher: it is loading */ }
    }
    await ready(wc)
  }

  // Resolves once no DOM mutation has been seen for QUIET_MS. The host stops waiting a little after the page's own cap, so a frozen page or an open dialog cannot hold the call.
  async function quiet(c) {
    const watch = `new Promise((resolve) => {
      let timer
      const done = () => { clearTimeout(timer); clearTimeout(cap); observer.disconnect(); resolve(true) }
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${QUIET_MS}) })
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      timer = setTimeout(done, ${QUIET_MS})
      const cap = setTimeout(done, ${QUIET_MAX_MS})
    })`
    let timer
    const cap = new Promise((resolve) => { timer = setTimeout(resolve, QUIET_MAX_MS + 300) })
    try { await Promise.race([send(c, 'Runtime.evaluate', { expression: watch, awaitPromise: true }), cap]) } finally { clearTimeout(timer) }
  }

  // Resolves {} once the page the tab is loading has loaded, or {loadFailed} with the error when the main frame fails (an aborted load that a redirect or a second navigation caused is not a failure).
  // Arm it in the same tick that starts the load: a view's first load starts later than the view exists, and this covers that.
  function landing(id) {
    const wc = contents(id)
    return new Promise((resolve) => {
      let started = wc.isLoading()
      const events = {
        'did-start-loading': () => { started = true },
        'did-stop-loading': () => { if (started) done({}) },
        // A same-document navigation never loads; a replaceState while the page loads is not the end of it.
        'did-navigate-in-page': (_e, _url, main) => { if (main && !wc.isLoading()) done({}) },
        'did-fail-load': (_e, code, description, _url, main) => { if (main && code !== -3) done({ loadFailed: description }) }
      }
      const done = (value) => {
        clearTimeout(timer)
        for (const [name, listener] of Object.entries(events)) wc.off(name, listener)
        resolve(value)
      }
      const timer = setTimeout(() => done({}), LOAD_MS)
      for (const [name, listener] of Object.entries(events)) wc.on(name, listener)
    })
  }

  async function channel(id) {
    const wc = contents(id)
    await ready(wc)
    let c = channels.get(id)
    if (c?.wc === wc && wc.debugger.isAttached()) return c
    if (c) channels.delete(id)
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      throw S.err('devtools_attached', 'Another debugger, probably DevTools, is attached to this tab. Ask the user to close DevTools on it, then try again.')
    }
    c = { wc, page: pageOf(id, wc) }
    channels.set(id, c)
    wc.debugger.on('detach', () => { if (channels.get(id) === c) channels.delete(id) })
    try {
      // The page believes it has focus even when it is a background tab, so editors and :focus styles behave.
      await send(c, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      await send(c, 'Accessibility.enable')
    } catch (e) {
      release(id)
      throw e
    }
    return c
  }

  // What an agent has been told about a tab's page outlives its DevTools channel (agent.finish detaches it) and ends with the page's document:
  // a real navigation commits a new one (an in-page one does not), and two documents in different processes can both have root node 1.
  function pageOf(id, wc) {
    let page = pages.get(id)
    if (page?.wc === wc) return page
    page = { wc, refs: newRefs(), sent: null }
    pages.set(id, page)
    wc.on('did-navigate', () => { page.refs = newRefs(); page.sent = null })
    wc.once('destroyed', () => { if (pages.get(id) === page) pages.delete(id) })
    return page
  }

  function send(c, method, params) {
    let timer
    const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(S.err('timeout', `${method} timed out`)), CALL_MS) })
    return Promise.race([c.wc.debugger.sendCommand(method, params), timeout]).finally(() => clearTimeout(timer))
  }

  function release(id) {
    const c = channels.get(id)
    channels.delete(id)
    sending.delete(id)
    if (c && !c.wc.isDestroyed() && c.wc.debugger.isAttached()) {
      try { c.wc.debugger.detach() } catch { /* already gone */ }
    }
  }

  // DevTools input is reported to before-input-event and before-mouse-event like a person's; sent() tells the page its own events from a user's.
  const MOUSE = { mousePressed: 'mouseDown', mouseReleased: 'mouseUp', mouseMoved: 'mouseMove', mouseWheel: 'mouseWheel' }
  async function input(id, c, method, params) {
    const sig = method === 'Input.dispatchKeyEvent' ? { type: params.type === 'keyUp' ? 'keyUp' : 'keyDown', key: params.key } : { type: MOUSE[params.type] }
    const list = sending.get(id) || sending.set(id, []).get(id)
    list.push(sig)
    try { return await send(c, method, params) } finally {
      const i = list.indexOf(sig)
      if (i >= 0) list.splice(i, 1)
      if (!list.length) sending.delete(id)
    }
  }

  function sent(id, event) {
    const list = sending.get(id)
    const i = list ? list.findIndex((sig) => sig.type === event.type && (sig.key === undefined || sig.key === event.key)) : -1
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }

  function node(c, ref) {
    const backendNodeId = c.page.refs.nodes.get(ref)
    if (backendNodeId === undefined) throw bad(`Unknown ref ${ref}: take a new browser_snapshot and use a ref from it`)
    return backendNodeId
  }

  const staleRef = (ref) => bad(`Ref ${ref} is gone from the page: take a new browser_snapshot`)

  // Scrolls the element into view and returns where its centre is in the viewport.
  async function locate(c, ref) {
    const backendNodeId = node(c, ref)
    try {
      await send(c, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
      const { quads } = await send(c, 'DOM.getContentQuads', { backendNodeId })
      const best = (quads || []).map(quadCenter).filter((q) => q.area > 0).sort((a, b) => b.area - a.area)[0]
      if (!best) throw bad(`Ref ${ref} has no visible box`)
      return best
    } catch (e) {
      if (e.code) throw e
      throw staleRef(ref)
    }
  }

  async function outlined(id) {
    const c = await channel(id)
    const { nodes } = await send(c, 'Accessibility.getFullAXTree')
    const { lines, count, truncated } = outline(nodes, c.page.refs)
    return { c, lines, doc: c.page.refs.doc, refs: count, text: render(lines, truncated) }
  }

  // The whole outline. It becomes the base of the next answer's comparison.
  async function snapshot(id) {
    const { c, lines, doc, refs, text } = await outlined(id)
    c.page.sent = { doc, lines }
    return { tabId: id, url: c.wc.getURL(), title: c.wc.getTitle(), refs, text }
  }

  // The page as an answer: what differs from the last outline delivered for this document, or the whole outline when that is not shorter or there is none.
  async function see(id) {
    const { c, lines, doc, refs, text } = await outlined(id)
    const delta = compare(c.page.sent?.doc === doc ? c.page.sent.lines : null, lines, text)
    c.page.sent = { doc, lines }
    return { url: c.wc.getURL(), title: c.wc.getTitle(), refs, ...delta }
  }

  // An action's short result, with the settled page after it unless look is false.
  async function answer(id, result, look) {
    if (look === false) return result
    await settle(id)
    return { ...result, ...(await see(id)) }
  }

  async function click(id, { ref, x, y, look }) {
    const c = await channel(id)
    let point
    if (ref !== undefined) point = await locate(c, ref)
    else if (Number.isFinite(x) && Number.isFinite(y)) point = { x, y }
    else throw bad('click needs a ref or x and y')
    await draw.glide(id, point)
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
    await input(id, c, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none', clickCount: 0 })
    await input(id, c, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    draw.ripple(id, point)
    await input(id, c, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    return answer(id, { clicked: ref ?? { x: point.x, y: point.y } }, look)
  }

  async function chord(id, c, parsed) {
    const base = { modifiers: parsed.modifiers, key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.vk, nativeVirtualKeyCode: parsed.vk }
    await input(id, c, 'Input.dispatchKeyEvent', { type: parsed.text ? 'keyDown' : 'rawKeyDown', ...base, ...(parsed.text && { text: parsed.text, unmodifiedText: parsed.text }), ...(parsed.commands && { commands: parsed.commands }) })
    await input(id, c, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async function type(id, { ref, text, clear, look }) {
    if (typeof text !== 'string') throw bad('text must be a string')
    const c = await channel(id)
    if (ref !== undefined) {
      const point = await locate(c, ref)
      await draw.glide(id, point)
      draw.highlight(id, { x: point.left, y: point.top, width: point.width, height: point.height })
      try { await send(c, 'DOM.focus', { backendNodeId: node(c, ref) }) } catch { throw staleRef(ref) }
    }
    if (clear) {
      await chord(id, c, parseKey('CmdOrCtrl+a'))
      await chord(id, c, parseKey('Backspace'))
    }
    if (text) await send(c, 'Input.insertText', { text })
    return answer(id, { typed: [...text].length }, look)
  }

  async function press(id, { key, look }) {
    const c = await channel(id)
    await chord(id, c, parseKey(key))
    return answer(id, { pressed: key }, look)
  }

  async function scroll(id, { ref, x, y, dx = 0, dy = 0, look }) {
    if (![dx, dy].every(Number.isFinite)) throw bad('dx and dy must be numbers')
    const c = await channel(id)
    let at = { x, y }
    if (ref !== undefined) at = await locate(c, ref)
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
      const { cssVisualViewport: view } = await send(c, 'Page.getLayoutMetrics')
      at = { x: Math.round(view.clientWidth / 2), y: Math.round(view.clientHeight / 2) }
    }
    if (dx || dy) await input(id, c, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: dx, deltaY: dy })
    const { result } = await send(c, 'Runtime.evaluate', { expression: '({ x: Math.round(scrollX), y: Math.round(scrollY) })', returnByValue: true })
    return answer(id, { scrolled: { dx, dy }, scroll: result.value }, look)
  }

  // Electron's own capture, not Page.captureScreenshot: a page parked in the hidden window paints only when asked, and DevTools waits for a frame that never comes once the page has changed.
  async function screenshot(id) {
    const wc = contents(id)
    await ready(wc)
    awake(id)
    let timer
    const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(S.err('timeout', 'The page did not paint')), CALL_MS) })
    const image = await Promise.race([wc.capturePage(), timeout]).finally(() => clearTimeout(timer))
    const fit = image.getSize().width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH, quality: 'good' }) : image
    const { width, height } = fit.getSize()
    return { tabId: id, mime: 'image/jpeg', width, height, data: fit.toJPEG(SHOT_QUALITY).toString('base64') }
  }

  async function wait(id, { text, url, timeout = WAIT_MS }) {
    if (text === undefined && url === undefined) throw bad('wait needs text or url')
    if (!Number.isFinite(timeout) || timeout < 0) throw bad('timeout must be a number of milliseconds')
    const until = Date.now() + Math.min(timeout, WAIT_MAX_MS)
    const wc = contents(id)
    const c = text === undefined ? null : await channel(id)
    for (;;) {
      if (url !== undefined && wc.getURL().includes(url)) return { matched: 'url', url: wc.getURL() }
      if (c) {
        const { result } = await send(c, 'Runtime.evaluate', { expression: `document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`, returnByValue: true })
        if (result.value === true) return { matched: 'text', url: wc.getURL() }
      }
      if (Date.now() >= until) throw S.err('timeout', `Nothing matched within ${Math.min(timeout, WAIT_MAX_MS)} ms`)
      await sleep(100)
    }
  }

  return { snapshot, click, type, press, scroll, screenshot, wait, settle, landing, release, sent }
}

module.exports = { createAgentBrowser, parseKey, outline, compare, newRefs }

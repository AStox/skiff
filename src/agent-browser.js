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
const quote = (text) => JSON.stringify(clip(String(text).replace(/\s+/g, ' ').trim(), 100))

// Interactive nodes of a CDP accessibility tree as lines "e12 button "Run" [disabled]", with page headings (no ref) for orientation.
// Returns {lines, refs: Map ref -> backendDOMNodeId, truncated}.
function outline(nodes) {
  const refs = new Map()
  const lines = []
  let size = 0
  let truncated = 0
  for (const node of nodes) {
    if (node.ignored) continue
    const role = node.role?.value
    const heading = role === 'heading'
    if (!INTERACTIVE.has(role) && !heading) continue
    const props = new Map((node.properties || []).map((p) => [p.name, p.value?.value]))
    const name = node.name?.value
    if (heading && !name) continue
    let line
    if (heading) line = `heading${props.get('level') ? ` h${props.get('level')}` : ''} ${quote(name)}`
    else {
      if (node.backendDOMNodeId === undefined) continue
      const flags = SHOWN_PROPS.filter((p) => props.get(p) === true || (p === 'checked' && props.get(p) === 'mixed') || (p === 'invalid' && props.get(p) && props.get(p) !== 'false')).map((p) => (props.get(p) === 'mixed' ? 'mixed' : p))
      const value = node.value?.value
      const href = props.get('url')
      line = `ref ${role}${name ? ` ${quote(name)}` : ''}${value !== undefined && value !== '' ? ` value=${quote(value)}` : ''}${href ? ` href=${clip(String(href), 120)}` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}`
      if (refs.size >= MAX_REFS || size > MAX_TEXT) { truncated++; continue }
      const ref = `e${refs.size + 1}`
      refs.set(ref, node.backendDOMNodeId)
      line = line.replace('ref', ref)
    }
    if (size + line.length > MAX_TEXT) { truncated++; continue }
    size += line.length + 1
    lines.push(line)
  }
  return { lines, refs, truncated }
}

function createAgentBrowser({ contentsOf, awake = () => {}, visual = {} }) {
  const channels = new Map()
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

  async function channel(id) {
    const wc = contents(id)
    await ready(wc)
    let c = channels.get(id)
    if (c?.wc === wc && wc.debugger.isAttached()) return c
    if (c) channels.delete(id)
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      throw S.err('devtools_attached', `Another debugger, probably DevTools, is attached to this tab. ${devtoolsHint}`)
    }
    c = { wc, refs: new Map() }
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
    const backendNodeId = c.refs.get(ref)
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

  async function snapshot(id) {
    const c = await channel(id)
    const { nodes } = await send(c, 'Accessibility.getFullAXTree')
    const { lines, refs, truncated } = outline(nodes)
    c.refs = refs
    const text = lines.join('\n') + (truncated ? `\n(${truncated} more elements not shown; scroll or narrow the page)` : '')
    return { tabId: id, url: c.wc.getURL(), title: c.wc.getTitle(), refs: refs.size, text: text || '(no interactive elements)' }
  }

  async function click(id, { ref, x, y }) {
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
    return { clicked: ref ?? { x: point.x, y: point.y } }
  }

  async function chord(id, c, parsed) {
    const base = { modifiers: parsed.modifiers, key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.vk, nativeVirtualKeyCode: parsed.vk }
    await input(id, c, 'Input.dispatchKeyEvent', { type: parsed.text ? 'keyDown' : 'rawKeyDown', ...base, ...(parsed.text && { text: parsed.text, unmodifiedText: parsed.text }), ...(parsed.commands && { commands: parsed.commands }) })
    await input(id, c, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async function type(id, { ref, text, clear }) {
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
    return { typed: [...text].length }
  }

  async function press(id, { key }) {
    const c = await channel(id)
    await chord(id, c, parseKey(key))
    return { pressed: key }
  }

  async function scroll(id, { ref, x, y, dx = 0, dy = 0 }) {
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
    return { scrolled: { dx, dy }, scroll: result.value }
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

  return { snapshot, click, type, press, scroll, screenshot, wait, release, sent }
}

module.exports = { createAgentBrowser, parseKey, outline }

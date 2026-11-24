'use strict'
// Runs in every browser-page frame with no exposed browser API. HTTP(S) frames
// report draft/media safety; their main frame also owns link peek and the
// existing swipe and desk-background drag gestures below.
const { ipcRenderer, webFrame } = require('electron')

// Errors the page itself raises, for the main-process log; capped so a looping page stays cheap.
{
  let sent = 0, windowStart = 0
  const send = (kind, payload) => {
    const now = Date.now()
    if (now - windowStart > 1000) { windowStart = now; sent = 0 }
    if (++sent > 10) return
    try { ipcRenderer.send('skiff:renderer-error', { kind, url: location.href.slice(0, 2048), ...payload }) } catch {}
  }
  addEventListener('error', (e) => { try { send('error', { message: e.message, source: e.filename, line: e.lineno, column: e.colno, stack: e.error?.stack }) } catch {} })
  addEventListener('unhandledrejection', (e) => { try { send('unhandledrejection', { message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }) } catch {} })
}

// Page CSS must not create native window drag regions through sibling views.
// User-origin rules override author !important, including closed shadow roots.
webFrame.insertCSS(`
  *, *::before, *::after {
    app-region: no-drag !important;
    window-drag: none !important;
  }
`, { cssOrigin: 'user' })

if (/^https?:$/.test(location.protocol)) {
  const documentId = `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`
  let generation = null
  let dirty = false
  let queued = false
  const playing = new Set()
  const report = () => {
    queued = false
    ipcRenderer.send('skiff:page-state', {
      document: documentId, generation, timeOrigin: performance.timeOrigin,
      url: location.href.slice(0, 8192), dirty, media: playing.size > 0
    })
  }
  const scheduleReport = () => {
    if (queued) return
    queued = true
    queueMicrotask(report)
  }
  ipcRenderer.on('skiff:page-state-generation', (_event, value) => {
    if (!Number.isSafeInteger(value) || value < 1 || value === generation) return
    generation = value
    scheduleReport()
  })
  const edited = (event) => {
    if (!event.isTrusted || dirty) return
    if (!event.composedPath().some((node) => node instanceof Element && (node.matches('input, textarea, select, [role="textbox"], [role="combobox"]') || node.isContentEditable))) return
    // A submit or autosave is not evidence that a draft reached its server.
    // Keep protection until a new document; never send field contents.
    dirty = true
    scheduleReport()
  }
  for (const type of ['beforeinput', 'input', 'change', 'paste', 'cut', 'drop']) addEventListener(type, edited, true)
  // Custom editors may consume modifier shortcuts without native beforeinput.
  // Conservatively protect those too, including nonmutating shortcuts in editors.
  addEventListener('keydown', (event) => {
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(event.key)) edited(event)
  }, true)
  for (const type of ['play', 'playing', 'pause', 'ended', 'emptied']) addEventListener(type, (event) => {
    const media = event.target
    if (!(media instanceof HTMLMediaElement)) return
    if (!media.paused && !media.ended) playing.add(media)
    else playing.delete(media)
    scheduleReport()
  }, true)
  const ready = () => {
    for (const media of document.querySelectorAll('audio, video')) if (!media.paused && !media.ended) playing.add(media)
    scheduleReport()
  }
  addEventListener('DOMContentLoaded', ready, { once: true })
  addEventListener('pageshow', ready)
  if (document.readyState !== 'loading') ready()
}

if (window === window.top && /^https?:$/.test(location.protocol)) {
  addEventListener('click', (event) => {
    if (!event.isTrusted || event.button !== 0 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const link = event.composedPath().find((node) => node instanceof Element && node.matches('a[href]'))
    if (!link || typeof link.href !== 'string' || link.href.length > 8192 || !URL.canParse(link.href) || !/^https?:$/.test(new URL(link.href).protocol)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    ipcRenderer.send('skiff:link-peek', { url: link.href })
  }, true)
  const ROLES = 'button checkbox combobox grid gridcell link listbox menu menubar menuitem menuitemcheckbox menuitemradio option radio radiogroup scrollbar searchbox slider spinbutton switch tab tablist textbox tree treegrid treeitem'
  const INTERACTIVE = ['a[href]', 'area', 'button', 'input', 'textarea', 'select', 'label', 'summary', 'video', 'audio', 'canvas', 'embed', 'object', 'iframe', ...ROLES.split(' ').map((role) => `[role~="${role}"]`)].join(',')
  let desk = false
  let press = null
  let last = null

  const overText = (x, y) => {
    const node = document.caretRangeFromPoint(x, y)?.startContainer
    if (node?.nodeType !== Node.TEXT_NODE || !node.data.trim()) return false
    const range = document.createRange()
    range.selectNodeContents(node)
    return [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
  }
  const overScrollbar = (el, x, y) => {
    const root = document.documentElement
    if (x >= root.clientWidth || y >= root.clientHeight) return true
    if (el === root || el === document.body || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return false
    const b = el.getBoundingClientRect()
    const left = b.left + el.clientLeft
    const top = b.top + el.clientTop
    return x < left || x >= left + el.clientWidth || y < top || y >= top + el.clientHeight
  }
  const background = (e) => {
    const path = e.composedPath().filter((node) => node instanceof Element)
    const target = path[0]
    if (!target || path.some((el) => el.matches(INTERACTIVE) || el.isContentEditable || el.draggable)) return false
    return ['auto', 'default'].includes(getComputedStyle(target).cursor) && !overText(e.clientX, e.clientY) && !overScrollbar(target, e.clientX, e.clientY)
  }
  // A window resized under a held press makes Chromium send moves with no button down; they are not a release.
  let held = { at: 0, size: '' }
  const sizeNow = () => `${innerWidth}x${innerHeight}`
  const send = (phase, x, y) => ipcRenderer.send('skiff:page-drag', phase, x, y)
  const stop = (e) => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  const cancel = () => {
    if (press?.started) send('cancel', last.screenX, last.screenY)
    press = null
  }

  ipcRenderer.invoke('skiff:desk-page').then((on) => { desk = on }, () => {})
  ipcRenderer.on('skiff:desk-page', (_e, on) => {
    desk = on
    if (!on) cancel()
  })
  addEventListener('mousedown', (e) => {
    cancel()
    if (!desk || !e.isTrusted || e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || !background(e)) return
    press = { down: e, firsts: {}, started: false, pending: false }
    last = e
  }, true)
  for (const type of ['pointermove', 'mousemove']) addEventListener(type, (e) => {
    if (!press || !e.isTrusted) return
    if (!(e.buttons & 1)) return !press.started || (performance.now() - held.at < 250 && sizeNow() !== held.size) ? undefined : cancel()
    held = { at: performance.now(), size: sizeNow() }
    press.firsts[type] ||= e
    if (type === 'pointermove') return press.started && stop(e)
    last = e
    if (press.started) {
      stop(e)
      return send('move', e.screenX, e.screenY)
    }
    if (press.pending || Math.hypot(e.clientX - press.down.clientX, e.clientY - press.down.clientY) <= 4) return
    press.pending = true
    // Once this move has gone through the page's own listeners, so a page that keeps the press or its first move keeps the drag.
    const mine = press
    setTimeout(() => {
      if (press !== mine) return
      if (mine.down.defaultPrevented || Object.values(mine.firsts).some((move) => move.defaultPrevented)) return (press = null)
      mine.started = true
      getSelection()?.removeAllRanges()
      send('start', mine.down.screenX, mine.down.screenY)
      send('move', last.screenX, last.screenY)
    })
  }, true)
  addEventListener('mouseup', (e) => {
    if (!press || e.button !== 0) return
    const { started } = press
    press = null
    if (!started) return
    send('end', e.screenX, e.screenY)
    // The press and release land on the same background, which would make a click.
    addEventListener('click', stop, { capture: true, once: true })
    setTimeout(() => removeEventListener('click', stop, { capture: true }))
  }, true)
  addEventListener('selectstart', (e) => { if (press?.started) e.preventDefault() }, true)
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !press?.started) return
    stop(e)
    cancel()
  }, true)
  addEventListener('blur', cancel)
  addEventListener('pagehide', cancel)
  document.addEventListener('visibilitychange', () => document.hidden && cancel())

  // A two finger swipe at the scroll edge goes back or forward, as in Chrome on the Mac. A gesture is a wheel stream that a 120 ms pause
  // ends; it counts only if it starts sideways where nothing under the pointer can scroll that way, with history that way and the
  // page not taking the wheel. 140px of travel navigates once, momentum included; reversing first cancels. Page wheel events stay untouched.
  const SWIPE_GAP = 120
  const SWIPE_COMMIT = 140
  const SWIPE_SHOW = 8
  // A momentum tail flows on into the page a swipe opened, so that page ignores its first gesture this soon after the swipe.
  const SWIPE_TAIL = 1200
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  let history = null
  let swipe = null
  let gestures = 0
  let swipeTimer = 0

  const learn = (next) => { history = next && { ...history, ...next } }
  const askHistory = () => ipcRenderer.invoke('skiff:swipe-page').then(learn, () => {})
  askHistory()
  ipcRenderer.on('skiff:swipe-page', (_e, next) => learn(next))

  const sideways = (x, y) => Math.abs(x) > Math.abs(y) * 1.3
  const span = (left, range, direction) => (direction === 'rtl' ? { left, min: -range, max: 0 } : { left, min: 0, max: range })
  // Every horizontal scroller under the pointer, the viewport included, as it stood when the gesture began.
  const scrollers = (e) => {
    const root = document.documentElement
    const viewport = document.scrollingElement || root
    const rootX = getComputedStyle(root).overflowX
    const list = []
    for (const el of e.composedPath()) {
      if (!(el instanceof Element) || el === root || el === viewport || (el === document.body && rootX === 'visible')) continue
      const style = getComputedStyle(el)
      if (/auto|scroll|overlay/.test(style.overflowX) && el.scrollWidth > el.clientWidth) list.push(span(el.scrollLeft, el.scrollWidth - el.clientWidth, style.direction))
    }
    const viewX = rootX === 'visible' && document.body ? getComputedStyle(document.body).overflowX : rootX
    if (!/hidden|clip/.test(viewX) && viewport.scrollWidth > viewport.clientWidth) list.push(span(viewport.scrollLeft, viewport.scrollWidth - viewport.clientWidth, getComputedStyle(root).direction))
    if (visualViewport && visualViewport.scale > 1.01) list.push(span(visualViewport.offsetLeft, root.clientWidth - visualViewport.width, 'ltr'))
    return list
  }
  const canScroll = (list, dir) => list.some((s) => (dir < 0 ? s.left > s.min + 1 : s.left < s.max - 1))

  const ARROW = { back: 'M14.5 6.5 9 12l5.5 5.5M9.5 12H19', forward: 'M9.5 6.5 15 12l-5.5 5.5M14.5 12H5' }
  const bubble = (way) => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    const host = document.createElement('skiff-swipe')
    host.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 !important; overflow: hidden !important; z-index: 2147483647 !important; pointer-events: none !important'
    const root = host.attachShadow({ mode: 'closed' })
    const disc = document.createElement('div')
    const fill = document.createElement('div')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    disc.style.cssText = `position: absolute; top: calc(50% - 22px); ${way === 'back' ? 'left' : 'right'}: 0; width: 44px; height: 44px; border-radius: 50%; overflow: hidden; box-sizing: border-box; background: ${dark ? '#3c4043' : '#fff'}; box-shadow: 0 1px 3px rgba(0,0,0,.3), 0 4px 10px rgba(0,0,0,.15)`
    fill.style.cssText = 'position: absolute; inset: 0; border-radius: 50%; background: #1a73e8; opacity: .3'
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.style.cssText = `position: absolute; inset: 10px; width: 24px; height: 24px; fill: none; stroke: ${dark ? '#e8eaed' : '#5f6368'}; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round`
    path.setAttribute('d', ARROW[way])
    svg.append(path)
    disc.append(fill, svg)
    root.append(disc)
    document.documentElement.append(host)
    const side = way === 'back' ? 1 : -1
    const place = (p) => {
      disc.style.transform = `translateX(${side * (-48 + 64 * p)}px)`
      fill.style.transform = `scale(${p})`
    }
    const fade = (ms, also) => {
      if (still.matches) return host.remove()
      disc.style.transition = `transform ${ms}ms ease-out, opacity ${ms}ms ease-out`
      also()
      disc.style.opacity = '0'
      setTimeout(() => host.remove(), ms + 20)
    }
    place(0)
    return {
      progress: place,
      commit() {
        place(1)
        Object.assign(fill.style, { opacity: '1', transition: still.matches ? '' : 'opacity 120ms' })
        svg.style.stroke = '#fff'
        // The bubble stays up until the page goes, or briefly when the navigation stays inside the page.
        setTimeout(() => fade(200, () => {}), 400)
      },
      cancel: () => fade(160, () => { disc.style.transform = `translateX(${side * -48}px) scale(.6)` }),
      remove: () => host.remove()
    }
  }

  const cancelSwipe = () => {
    swipe.bubble?.cancel()
    swipe.phase = 'cancelled'
  }
  const begin = (e) => {
    clearTimeout(swipeTimer)
    if (swipe?.phase === 'tracking') cancelSwipe()
    swipe = { phase: 'pending', last: e.timeStamp, x: 0, y: 0, events: [], scrollers: scrollers(e), first: gestures++ === 0, dir: 0, travel: 0, bubble: null }
  }
  const qualifies = () => {
    const { events, x, y } = swipe
    if (!history || (swipe.first && Date.now() - (history.swipedAt || 0) < SWIPE_TAIL)) return false
    if (!sideways(x, y) || events.some((ev) => ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey || ev.deltaMode !== 0)) return false
    // This event has not reached the page's own listeners yet; the next event checks it.
    if (events.slice(0, -1).some((ev) => ev.defaultPrevented)) return false
    swipe.dir = Math.sign(x)
    return history[swipe.dir < 0 ? 'back' : 'forward'] && !canScroll(swipe.scrollers, swipe.dir)
  }
  const track = (e) => {
    const prev = swipe.events.at(-1)
    swipe.events = [e]
    if (prev !== e && prev.defaultPrevented) return cancelSwipe()
    if (e.ctrlKey) return cancelSwipe()
    swipe.travel += e.deltaX * swipe.dir
    if (swipe.travel <= 0) return cancelSwipe()
    const way = swipe.dir < 0 ? 'back' : 'forward'
    if (!swipe.bubble && swipe.travel > SWIPE_SHOW) swipe.bubble = bubble(way)
    swipe.bubble?.progress(Math.min(1, swipe.travel / SWIPE_COMMIT))
    if (swipe.travel < SWIPE_COMMIT) return
    swipe.phase = 'done'
    swipe.bubble?.commit()
    ipcRenderer.send('skiff:swipe-nav', way)
  }
  addEventListener('wheel', (e) => {
    if (!e.isTrusted) return
    // Momentum never reverses, so a reversal after a finished or refused gesture is a new touch.
    const reversal = swipe && (swipe.phase === 'done' || swipe.phase === 'off') && swipe.dir && Math.abs(e.deltaX) >= 4 && sideways(e.deltaX, e.deltaY) && Math.sign(e.deltaX) !== swipe.dir
    if (!swipe || e.timeStamp - swipe.last >= SWIPE_GAP || reversal) begin(e)
    swipe.last = e.timeStamp
    clearTimeout(swipeTimer)
    // Fingers that lift short of the threshold with no momentum; only the next event's timestamp starts a new gesture.
    swipeTimer = setTimeout(() => swipe?.phase === 'tracking' && cancelSwipe(), SWIPE_GAP + 30)
    if (swipe.phase === 'tracking') return track(e)
    if (swipe.phase !== 'pending') return
    swipe.events.push(e)
    swipe.x += e.deltaX
    swipe.y += e.deltaY
    if (Math.abs(swipe.x) < 4 && Math.abs(swipe.y) < 4) return
    if (!qualifies()) {
      swipe.phase = 'off'
      return
    }
    swipe.phase = 'tracking'
    swipe.travel = Math.abs(swipe.x) - e.deltaX * swipe.dir
    track(e)
  }, { capture: true, passive: true })
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return
    // Back from the back/forward cache: a fresh start, momentum tail included.
    swipe?.bubble?.remove()
    swipe = null
    gestures = 0
    askHistory()
  })
  addEventListener('pagehide', () => swipe?.bubble?.remove())
}

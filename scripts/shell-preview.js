#!/usr/bin/env node
// Preview a shell folder in plain Chromium with a synthetic profile, no Skiff needed.
//   node scripts/shell-preview.js <shell-dir> <out.png> [--dark] [--overlay palette.html] [--type lin] [--emit name=json] [--size 1280x800]
// The native page is stood in for by a fake article inside #page. Needs `npx playwright install chromium` once.
// A desk shell (shell.json {"window": "desk"}) renders on a transparent stage over a plain wallpaper, with stand-in page views at
// sample tab.desk rects, a frame view under each when shell.json declares one, named overlays, and a small core behind desk.*, tabs.*
// and ui.setDesk. Its steps run in order:
//   --click sel | --hover sel | --drag "x,y x,y ..." (held, not released) | --drop "x,y x,y ..." | --pinch "x,y dy" (Ctrl+wheel) | --emit name=json | --type text | --eval js | --wait ms
// A press on a stand-in page's empty background reports page-drag to its frame, as the core does. A selector (or --eval code) starting with "overlay:"
// targets the main overlay, "panel:" the panel's, "buoy:" the Buoy's, "tabs:" the tab list's, "layouts:" the layout strip, "frame:<tab id>:" that window's frame. Default size 1440x900.
// The preview stands for Skiff behind another app, so a pick from the tab list shows just that window.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')
const S = require('../src/state')

const raw = process.argv.slice(2)
const args = [...raw]
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const dark = args.includes('--dark') && args.splice(args.indexOf('--dark'), 1)
const overlay = flag('--overlay')
const typed = flag('--type')
const emits = []
for (let e = flag('--emit'); e; e = flag('--emit')) emits.push(e)
const sizeFlag = flag('--size')
for (const name of ['--click', '--hover', '--drag', '--drop', '--pinch', '--eval', '--wait']) while (flag(name) !== undefined);
const [shellDir, out] = args
if (!shellDir || !out) {
  console.error('usage: node scripts/shell-preview.js <shell-dir> <out.png> [--dark] [--overlay palette.html] [--type lin] [--emit name=json] [--size 1280x800]')
  process.exit(1)
}
const deskShell = (() => { try { return JSON.parse(fs.readFileSync(path.join(shellDir, 'shell.json'), 'utf8')).window === 'desk' } catch { return false } })()
const size = (sizeFlag || (deskShell ? '1440x900' : '1280x800')).split('x').map(Number)

const now = Date.now()
const ago = (minutes) => now - minutes * 60e3
const svg = (fill, body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${fill}"/>${body}</svg>`)}`
const ICON = {
  mail: svg('#3b6fd6', '<rect x="3" y="4.5" width="10" height="7" rx="1" fill="none" stroke="#fff" stroke-width="1.3"/><path d="m3.5 5.5 4.5 3.2 4.5-3.2" fill="none" stroke="#fff" stroke-width="1.3"/>'),
  calendar: svg('#d64545', '<rect x="3" y="4" width="10" height="9" rx="1" fill="none" stroke="#fff" stroke-width="1.3"/><path d="M3 7h10M6 2.5v3M10 2.5v3" stroke="#fff" stroke-width="1.3"/>'),
  linear: svg('#5e6ad2', '<path d="M4 8.5 7.5 12M3.2 6.2 9.8 12.8M4.6 3.6l7.8 7.8" stroke="#fff" stroke-width="1.4"/>'),
  github: svg('#24292f', '<circle cx="5" cy="4" r="1.5" fill="#fff"/><circle cx="5" cy="12" r="1.5" fill="#fff"/><circle cx="11" cy="6" r="1.5" fill="#fff"/><path d="M5 5.5v5M11 7.5c0 2-6 1-6 3" fill="none" stroke="#fff" stroke-width="1.2"/>'),
  figma: svg('#1e1e1e', '<circle cx="9.5" cy="8" r="2" fill="#1abcfe"/><path d="M4.5 4a2 2 0 0 1 2-2H8v4H6.5a2 2 0 0 1-2-2z" fill="#f24e1e"/><path d="M8 2h1.5a2 2 0 1 1 0 4H8z" fill="#ff7262"/><path d="M4.5 8a2 2 0 0 1 2-2H8v4H6.5a2 2 0 0 1-2-2z" fill="#a259ff"/><path d="M4.5 12a2 2 0 0 1 2-2H8v2a2 2 0 1 1-3.5 0z" fill="#0acf83"/>')
}

const spaces = [
  { id: 's1', name: 'Studio', color: '#2f6b4f' },
  { id: 's2', name: 'Personal', color: '#b4552d' },
  { id: 's3', name: 'Reading', color: '#4f6bed' },
  { id: 's4', name: 'Build', color: '#8a7a2c' }
]
const tab = (id, spaceId, url, title, extra = {}) => ({ id, spaceId, sessionPartition: 'persist:main', url, title, favicon: '', favorite: false, loading: false, canGoBack: false, canGoForward: false, createdAt: ago(60), lastActiveAt: ago(60), ...extra })
const tabs = [
  tab('f1', 's1', 'https://mail.example/inbox', 'Inbox', { favorite: true, favicon: ICON.mail }),
  tab('f2', 's1', 'https://calendar.example/week', 'Calendar', { favorite: true, favicon: ICON.calendar }),
  tab('f3', 's1', 'https://linear.app/skiff', 'Linear', { favorite: true, favicon: ICON.linear }),
  tab('f4', 's1', 'https://github.com/notifications', 'GitHub', { favorite: true, favicon: ICON.github }),
  tab('f5', 's1', 'https://figma.com/files', 'Figma', { favorite: true, favicon: ICON.figma }),
  tab('p1', 's1', 'https://skiff.example/readme', 'Skiff README', { pinned: true, folder: 'Docs' }),
  tab('p2', 's1', 'https://arc.example/import-notes', 'Arc import notes', { pinned: true, folder: 'Docs' }),
  tab('p3', 's1', 'https://weekly.example/plan', 'Weekly plan', { pinned: true, folder: '', favicon: ICON.calendar }),
  tab('t1', 's1', 'https://margin.example/journal/looking-up', 'Looking up, slowing down', { createdAt: ago(38), lastActiveAt: ago(0), canGoBack: true }),
  tab('t2', 's1', 'https://atelier.example/material-studies', 'Material studies', { createdAt: ago(60), lastActiveAt: ago(30) }),
  tab('t3', 's1', 'https://atelier.example/apartments', 'Apartment references', { parentId: 't2', createdAt: ago(59), lastActiveAt: ago(45) }),
  tab('t4', 's1', 'https://city.example/everyday', 'The everyday city', { createdAt: ago(205), lastActiveAt: ago(120) }),
  tab('t5', 's1', 'https://walks.example/copenhagen', 'A walk through Copenhagen', { createdAt: ago(310), lastActiveAt: ago(300) }),
  tab('t6', 's1', 'https://tools.example/small', 'Small tools, well made', { createdAt: ago(1220), lastActiveAt: ago(1200) }),
  tab('t7', 's1', 'https://margin.example/reading/november', 'Reading list for November', { createdAt: ago(1355), lastActiveAt: ago(600) }),
  tab('u1', 's2', 'https://trips.example/lisbon', 'Lisbon in March', { createdAt: ago(2000), lastActiveAt: ago(1900) }),
  tab('u2', 's2', 'https://tax.example/2026', 'Tax return 2026', { createdAt: ago(2100), lastActiveAt: ago(2050) }),
  tab('u3', 's2', 'https://bikes.example/fit', 'Bike fit notes', { createdAt: ago(2200), lastActiveAt: ago(2150) }),
  tab('u4', 's2', 'https://food.example/recipes', 'Recipes', { createdAt: ago(2300), lastActiveAt: ago(2250) })
]
const archived = (id, url, title, minutes) => ({ id, spaceId: 's1', url, title, favicon: '', sessionPartition: 'persist:main', archivedAt: ago(minutes) })
const archive = [
  archived('a1', 'https://margin.example/reading/october', 'Reading list for October', 2900),
  archived('a2', 'https://tides.example/table', 'Tide tables', 2950),
  archived('a3', 'https://chairs.example/references', 'Chair references', 4300),
  ...Array.from({ length: 9 }, (_, i) => archived(`a${i + 4}`, `https://older.example/${i + 4}`, `Older page ${i + 4}`, 5000 + i * 700))
]
const state = {
  spaces, activeSpaceId: 's1', tabs, activeTabBySpace: { s1: 't1', s2: 'u1' }, archive, collapsed: {}, agentTabs: [], peek: null,
  shells: ['default', 'filmstrip', 'index', 'lacquer', 'ledger', 'quiet', 'timeline'],
  settings: { autoArchiveHours: 12, searchUrl: 'https://www.google.com/search?q=%s', shell: path.basename(path.resolve(shellDir)) === 'shell' ? 'default' : path.basename(path.resolve(shellDir)), shortcuts: {}, ai: { agents: [], agent: '', model: '', effort: '' } },
  window: { width: size[0], height: size[1] }
}

// PREVIEW_EXTENSIONS=1 lists the built-in blocker plus one added extension; =installing or =failed shows the built-in before it is installed.
const sample = process.env.PREVIEW_EXTENSIONS
const ubo = { id: 'ubo', name: 'uBlock Origin', version: '1.76.2', description: '', path: '', popup: 'popup-fenix.html', options: 'dashboard.html', builtin: true, state: 'ready', error: '' }
const missing = { id: '', name: 'uBlock Origin', version: '', description: '', path: '', popup: '', options: '', builtin: true, state: sample, error: sample === 'failed' ? 'api.github.com answered 503' : '' }
const extensions = !sample ? [] : sample === 'installing' || sample === 'failed' ? [missing] : [
  ubo,
  { id: 'x', name: 'Dark Reader', version: '4.9', description: '', path: '', popup: 'popup.html', options: '', builtin: false, state: 'ready', error: '' }
]

const shim = `(() => {
  const listeners = {}
  const state = ${JSON.stringify(state)}
  window.__skiff = { state, calls: [], emit: (name, data) => (listeners[name] || []).forEach((fn) => fn(data)) }
  window.skiff = {
    call(method, params) {
      window.__skiff.calls.push([method, params])
      if (method === 'state.get') return Promise.resolve(state)
      if (method === 'commands.list') return Promise.resolve([])
      if (method === 'ui.shellPath') return Promise.resolve({ path: '/preview' })
      if (method === 'extensions.list') return Promise.resolve(${JSON.stringify(extensions)})
      if (method === 'ai.agents') return Promise.resolve([])
      if (method === 'ui.capture') return Promise.reject(Object.assign(new Error('No page in preview'), { code: 'not_found' }))
      return Promise.resolve(null)
    },
    on(name, fn) {
      ;(listeners[name] ||= []).push(fn)
      if (name === 'state') queueMicrotask(() => fn(state))
    }
  }
})()`

const article = `<div style="height:100%;overflow:hidden;background:#fbfaf7;color:#1f1e1a;font:15px/1.5 system-ui,sans-serif">
<div style="display:flex;justify-content:space-between;padding:22px 48px;border-bottom:1px solid #e3dfd5"><b style="font:400 24px/1 Georgia,serif">Margin</b><span style="color:#5d5a52;font-size:13px">Journal &nbsp;&nbsp; Places &nbsp;&nbsp; About</span></div>
<div style="max-width:720px;margin:0 auto;padding:48px 32px 0"><h1 style="font:400 54px/1.02 Georgia,serif;letter-spacing:-.02em;margin:0 0 22px">Looking up,<br>slowing down.</h1>
<p style="font-size:18px;line-height:1.45;color:#3b3934;max-width:460px;margin:0 0 30px">There is another city above the shopfronts. A few notes on noticing the buildings we pass every day.</p>
<div style="aspect-ratio:3/2;background:linear-gradient(180deg,#9aa3a8,#5b6469 60%,#2f3538)"></div></div></div>`

/* ---------- desk shells ---------- */

// The desk content: a Work and a Personal space. All fictional.
const letter = (text, fill, ink = '#fff') => svg(fill, `<text x="8" y="11.8" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="${ink}">${text}</text>`)
const DESK_TABS = [
  ['linear', 'work', 'https://linear.app/skiff/issue/SKF-88', 'SKF-88 Windows on the desk', ICON.linear, 'issue'],
  ['github', 'work', 'https://github.com/skiff/skiff/pull/41', 'skiff#41 Tabs as windows', ICON.github, 'pr'],
  ['electron', 'work', 'https://www.electronjs.org/docs/latest/api/base-window', 'BaseWindow | Electron', letter('E', '#2f3241', '#9feaf9'), 'docs'],
  ['calendar', 'work', 'https://calendar.google.com/calendar/r/week', 'Week of Nov 16', ICON.calendar],
  ['figma', 'work', 'https://figma.com/design/skiff-r3', 'Skiff r3 mocks', ICON.figma],
  ['hn', 'work', 'https://news.ycombinator.com/', 'Hacker News', letter('Y', '#ff6600')],
  ['notion', 'work', 'https://notion.so/reading-list', 'Reading list', letter('N', '#ffffff', '#111')],
  ['gmail', 'work', 'https://mail.google.com/mail/u/0/#inbox', 'Inbox (12)', ICON.mail],
  ['youtube', 'work', 'https://youtube.com/watch?v=calm', 'Designing calm software', letter('Y', '#e62117')],
  ['nytimes', 'personal', 'https://cooking.nytimes.com/weeknight-soups', 'Cooking: Weeknight soups', letter('T', '#111'), 'recipe'],
  ['maps', 'personal', 'https://maps.apple.com/?q=Toronto+Island+ferry', 'Ferry times to Toronto Island', letter('M', '#34a853'), 'map'],
  ['airbnb', 'personal', 'https://airbnb.com/s/montreal', 'Montreal in March', letter('A', '#ff385c')],
  ['letterboxd', 'personal', 'https://letterboxd.com/watchlist', 'Watchlist', letter('L', '#202830', '#00e054')],
  ['bandcamp', 'personal', 'https://bandcamp.com/new', 'New arrivals', letter('B', '#1da0c3')],
  ['wikipedia', 'personal', 'https://en.wikipedia.org/wiki/Skiff', 'Skiff (boat)', letter('W', '#ffffff', '#111')]
]
// Page rects at 1440 by 900, scaled to the window: three overlapping windows in Work, two in Personal. [x, y, width, height, z]
const DESK_LAYOUT = { linear: [90, 100, 700, 480, 2], github: [360, 200, 780, 520, 3], electron: [800, 130, 560, 400, 1], nytimes: [60, 60, 640, 760, 2], maps: [720, 60, 680, 520, 1] }
// The rest of each space: favorites and pinned tabs, and ordinary tabs whose windows are hidden.
const DESK_ROLES = { calendar: { favorite: true }, gmail: { favorite: true }, figma: { pinned: true, folder: 'Design' }, notion: { pinned: true }, airbnb: { favorite: true } }

function deskState([W, H], shell) {
  const sx = W / 1440
  const sy = H / 900
  const rect = ([x, y, w, h, z]) => {
    const width = Math.min(W, Math.max(260, Math.round(w * sx)))
    const height = Math.min(H - 30, Math.max(170, Math.round(h * sy)))
    return { x: Math.max(0, Math.min(Math.round(x * sx), W - width)), y: Math.max(30, Math.min(Math.round(y * sy), H - height)), width, height, z }
  }
  const tabs = DESK_TABS.map(([id, spaceId, url, title, favicon], i) => {
    const role = DESK_ROLES[id] || {}
    const plain = !role.favorite && !role.pinned
    return {
      id, spaceId, sessionPartition: 'persist:main', url, title, favicon, favorite: false, pinned: false, folder: '', loading: false,
      canGoBack: id === 'github', canGoForward: false, createdAt: ago(40 + i * 53), lastActiveAt: ago(i * 11), ...role,
      ...(DESK_LAYOUT[id] ? { desk: rect(DESK_LAYOUT[id]) } : plain && { desk: { ...rect([200 + i * 20, 160, 700, 500, 0]), hidden: true } })
    }
  })
  const gone = (id, url, title, minutes) => ({ id, spaceId: 'work', url, title, favicon: '', sessionPartition: 'persist:main', archivedAt: ago(minutes) })
  return {
    spaces: [{ id: 'work', name: 'Work', color: '#4f6bed' }, { id: 'personal', name: 'Personal', color: '#2f6b4f' }],
    activeSpaceId: 'work', tabs, activeTabBySpace: { work: 'github', personal: 'nytimes' }, collapsed: {}, agentTabs: [], peek: null,
    archive: [gone('a1', 'https://linear.app/skiff/issue/SKF-80', 'SKF-80 Buoy notices', 300), gone('a2', 'https://github.com/skiff/skiff/pull/38', 'skiff#38 Quiet pill', 2900)],
    shells: ['default', 'filmstrip', 'index', 'lacquer', 'layer', 'ledger', 'quiet', 'timeline'],
    settings: { autoArchiveHours: 12, searchUrl: 'https://www.google.com/search?q=%s', shell, shortcuts: {}, ai: { agents: [], agent: '', model: '', effort: '' } },
    window: { width: 1280, height: 800 },
    deskSize: { width: W, height: H }
  }
}

// Stand-ins for the native page views: plain light pages that reflow from 260px up.
const PAGE_CSS = `
.pv { container-type: inline-size; background: #fff; color: #1f2328; font: 13px/1.5 system-ui, -apple-system, sans-serif; }
.pv * { box-sizing: border-box; margin: 0; }
.pv .wrap { display: flex; height: 100%; }
.pv aside { flex: none; width: 190px; padding: 16px 12px; border-right: 1px solid #e7e7ea; background: #f6f6f8; color: #5c5f66; font-size: 12px; line-height: 2.1; }
.pv main { flex: 1; min-width: 0; padding: 20px 26px; overflow: hidden; }
.pv .bar { display: flex; align-items: center; gap: 14px; height: 48px; padding: 0 18px; font-size: 13px; }
.pv .crumb { color: #8a8f98; font-size: 12px; }
.pv h1 { margin: 8px 0 12px; font: 600 22px/1.25 system-ui, sans-serif; letter-spacing: -.01em; }
.pv h2 { margin: 18px 0 8px; font: 600 15px/1.3 system-ui, sans-serif; }
.pv p { margin: 0 0 10px; color: #3d4148; max-width: 640px; }
.pv .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 16px; }
.pv .chip { padding: 2px 9px; border: 1px solid #e3e3e7; border-radius: 999px; color: #4b4f57; font-size: 12px; }
.pv .line { height: 9px; margin: 9px 0; border-radius: 4px; background: #eceef1; }
.pv pre { margin: 10px 0; padding: 12px 14px; border-radius: 8px; background: #f5f6f8; color: #2b3138; font: 12px/1.6 ui-monospace, Menlo, monospace; white-space: pre; overflow: hidden; }
.pv .diff { margin-top: 14px; border: 1px solid #d1d9e0; border-radius: 8px; overflow: hidden; font: 12px/20px ui-monospace, Menlo, monospace; }
.pv .diff div { padding: 0 12px; white-space: pre; }
.pv .diff .head { padding: 8px 12px; border-bottom: 1px solid #d1d9e0; background: #f6f8fa; font-family: system-ui, sans-serif; font-weight: 600; }
.pv .diff .add { background: #e6ffec; } .pv .diff .del { background: #ffebe9; }
.pv .serif { font-family: Georgia, 'Times New Roman', serif; }
.pv .photo { aspect-ratio: 16 / 9; margin: 14px 0; border-radius: 4px; background: radial-gradient(circle at 40% 45%, #f2c38b 0 18%, #d7843f 19% 30%, #8a4b25 31% 34%, transparent 35%), linear-gradient(135deg, #e9dccb, #c9b59b); }
.pv .map { position: relative; height: 100%; background: linear-gradient(180deg, #e8efe3 0 52%, #a9cbe8 52% 100%); }
.pv .map svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.pv .card { position: absolute; top: 14px; left: 14px; width: min(300px, calc(100% - 28px)); padding: 14px 16px; border-radius: 12px; background: #fff; box-shadow: 0 6px 24px rgba(0, 0, 0, .16); }
.pv .times { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin-top: 8px; font-variant-numeric: tabular-nums; }
@container (max-width: 560px) { .pv aside { display: none; } .pv main { padding: 16px; } }
`
const DESK_PAGES = {
  issue: () => `<div class="wrap" style="background:#fbfbfc"><aside><b style="color:#1b1c1f">Skiff</b><br>Inbox<br>My issues<br><br><b style="color:#1b1c1f">Projects</b><br>Desk<br>Buoy<br>Tab list</aside>
    <main><div class="crumb">Desk &rsaquo; SKF-88</div><h1>Windows on the desk</h1>
    <div class="chips"><span class="chip">&#9679; In progress</span><span class="chip">High</span><span class="chip">Mira</span><span class="chip">Round 3</span></div>
    <p>Every tab you put on the desk becomes a window on one transparent layer. The desktop and other apps show between them, and empty areas pass clicks to the apps below.</p>
    <h2>Acceptance</h2><p>&#9745; Drag the ear to move, edges to resize<br>&#9745; Snap to halves, quarters and fill<br>&#9744; Count the tabs in the Buoy</p>
    <h2>Activity</h2><div class="line" style="width:80%"></div><div class="line" style="width:64%"></div><div class="line" style="width:72%"></div></main></div>`,
  pr: () => `<div class="bar" style="background:#1f2328;color:#fff"><b>skiff / skiff</b><span style="opacity:.7">Pull requests</span></div>
    <main><h1 style="font-weight:400">Tabs as windows <span style="color:#59636e">#41</span></h1>
    <div class="chips"><span class="chip" style="background:#1f883d;border-color:#1f883d;color:#fff">Open</span><span class="chip">mira wants to merge 6 commits into main</span></div>
    <div class="chips"><span class="chip">Conversation 4</span><span class="chip">Commits 6</span><span class="chip">Files changed 4</span></div>
    <div class="diff"><div class="head">src/main.js</div><div>  function syncView() {</div><div class="del">-   const view = tab &amp;&amp; pageBounds ? views.get(tab.id) : null</div><div class="add">+   for (const tab of deskTabs()) attach(tab, tab.desk)</div><div class="add">+   win.setIgnoreMouseEvents(!over, { forward: true })</div><div>  }</div></div></main>`,
  docs: () => `<div class="bar" style="border-bottom:1px solid #e7e7ea"><b>Electron</b><span style="color:#5c5f66">Docs</span><span style="color:#5c5f66">API</span><span style="color:#5c5f66">Blog</span></div>
    <div class="wrap" style="height:calc(100% - 48px)"><aside>app<br>BaseWindow<br>BrowserWindow<br>screen<br>WebContentsView</aside>
    <main><h1>BaseWindow</h1><p>Create and control windows. A BaseWindow can host several WebContentsView children, each with its own bounds.</p>
    <h2>new BaseWindow([options])</h2><pre>const win = new BaseWindow({ transparent: true, frame: false })
win.setIgnoreMouseEvents(true, { forward: true })</pre><p>Process: Main</p></main></div>`,
  recipe: () => `<div class="bar serif" style="border-bottom:1px solid #e7e7ea;font-size:18px"><b>Cooking</b></div>
    <main><h1 class="serif" style="font-weight:400;font-size:30px">Weeknight soups</h1><p>Six pots that come together in under an hour, from a lemony white bean to a spicy tomato and lentil.</p>
    <div class="photo"></div><h2>Ingredients</h2><p>2 tablespoons olive oil<br>1 onion, diced<br>2 celery stalks, sliced<br>1 can white beans</p></main>`,
  map: () => `<div class="map"><svg viewBox="0 0 800 500" preserveAspectRatio="none"><path d="M0 120 L800 160 M120 0 L180 260 M420 0 L460 260 M0 220 L800 230" stroke="#fff" stroke-width="10" fill="none"/><path d="M380 260 C 420 330, 520 360, 600 420" stroke="#1d6fd6" stroke-width="3" stroke-dasharray="8 6" fill="none"/><ellipse cx="610" cy="420" rx="120" ry="34" fill="#cfe3c4"/></svg>
    <div class="card"><b style="font-size:15px">Ferry times to Toronto Island</b><div class="times"><span>Jack Layton terminal</span><b>10:15</b><span>Ward's Island</span><b>10:45</b><span>Centre Island</span><b>11:00</b></div></div></div>`,
  plain: (tab) => `<div class="bar" style="border-bottom:1px solid #e7e7ea"><b>${new URL(tab[2]).hostname.replace(/^www\./, '')}</b></div>
    <main><h1>${tab[3]}</h1><div class="line" style="width:90%"></div><div class="line" style="width:76%"></div><div class="line" style="width:84%"></div><div class="line" style="width:58%"></div></main>`
}
const deskPage = (id) => {
  const tab = DESK_TABS.find((t) => t[0] === id)
  return tab ? (DESK_PAGES[tab[5]] || DESK_PAGES.plain)(tab) : `<main><h1>New tab</h1></main>`
}

const deskShim = `(() => {
  const listeners = {}
  window.__skiffEmit = (name, data) => (listeners[name] || []).slice().forEach((fn) => fn(data))
  window.skiff = {
    call: (method, params) => window.__skiffCall(method, params === undefined ? null : params),
    on(name, fn) { (listeners[name] ||= []).push(fn) }
  }
})()`

async function previewDesk(dir) {
  const [W, H] = size
  const st = deskState(size, path.basename(dir))
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'shell.json'), 'utf8'))
  const inset = config.frame && { top: 0, right: 0, bottom: 0, left: 0, ...config.frame }
  const desk = { hit: [], capture: false, preview: null }
  const errors = []
  const overlays = {}
  let made = 0
  const fail = (message) => { throw Object.assign(new Error(message), { code: 'bad_params' }) }
  const find = (id) => st.tabs.find((t) => t.id === id) || fail(`No tab ${id}`)
  const active = () => st.tabs.find((t) => t.id === st.activeTabBySpace[st.activeSpaceId])
  const only = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })
  // The core's rules: which tabs are windows, the default cascade, and the stacking order.
  const plain = (t) => !t.favorite && !t.pinned
  const visible = (spaceId) => {
    const tabs = st.tabs.filter((t) => t.spaceId === spaceId)
    const trail = (parentId) => tabs.filter((t) => plain(t) && t.parentId === parentId).flatMap((t) => [t, ...trail(t.id)])
    return [...tabs.filter((t) => t.favorite), ...tabs.filter((t) => t.pinned && !t.favorite), ...trail(undefined)]
  }
  const defaultRect = (t) => {
    const w = Math.max(240, Math.round(W * 0.62)), h = Math.max(160, Math.round(H * 0.74))
    const k = Math.max(1, Math.floor(Math.min(W - w, H - h) / 2 / 28) + 1)
    const n = Math.max(0, visible(t.spaceId).indexOf(t)) % k
    return { x: Math.round((W - w) / 2) + 28 * n, y: Math.round((H - h) / 2) + 28 * n, width: w, height: h }
  }
  const isActive = (t) => st.activeTabBySpace[t.spaceId] === t.id
  const shownTabs = (spaceId) => {
    const current = st.tabs.find((t) => t.id === st.activeTabBySpace[spaceId])
    const shown = visible(spaceId).filter((t) => t !== current && (t.desk ? !t.desk.hidden : plain(t)))
    const list = [...shown.filter((t) => !t.desk), ...shown.filter((t) => t.desk).sort((a, b) => a.desk.z - b.desk.z)]
    return current ? [...list, current] : list
  }
  const raise = (t) => {
    if (!t.desk) return
    t.desk.z = Math.max(0, ...st.tabs.filter((o) => o !== t && o.spaceId === t.spaceId && o.desk).map((o) => o.desk.z)) + 1
  }
  const activate = (t) => {
    st.activeSpaceId = t.spaceId
    st.activeTabBySpace[t.spaceId] = t.id
    t.lastActiveAt = Date.now()
    if (!plain(t) && !t.desk) t.desk = { ...defaultRect(t), z: 0 }
    if (t.desk) delete t.desk.hidden
    raise(t)
  }
  const leave = (t) => {
    if (!isActive(t)) return
    const next = shownTabs(t.spaceId).filter((o) => o !== t && (o.desk ? !o.desk.hidden : plain(o))).at(-1)
    if (next) st.activeTabBySpace[t.spaceId] = next.id
    else delete st.activeTabBySpace[t.spaceId]
  }

  const browser = await chromium.launch({ args: ['--no-sandbox'] }).catch((error) => {
    console.error(`${error.message.split('\n')[0]}\nRun: npx playwright install chromium`)
    process.exit(1)
  })
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, bypassCSP: true, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Skiff preview' })
  const page = await context.newPage()
  // Every shell view hears every event, as the core sends them: the base page, each frame and each overlay.
  const emit = (name, data) => Promise.all(page.frames().map((f) => f.evaluate(([n, d]) => window.__skiffEmit?.(n, d), [name, data]).catch(() => {})))
  const loaded = (pred) => page.waitForEvent('framenavigated', (f) => f !== page.mainFrame() && pred(f.url())).then(async (f) => {
    await f.waitForLoadState('load')
    await f.evaluate(() => document.fonts.ready)
    return f
  })

  // The views the core would attach, back to front: each shown window's frame view right under its page view, at its rect or the live preview.
  async function drawViews() {
    const views = shownTabs(st.activeSpaceId).filter((t) => !st.deskOnly || st.deskOnly.includes(t.id)).map((t) => ({ id: t.id, ...(t.desk ? only(t.desk) : defaultRect(t)) }))
    const moving = desk.preview && views.find((v) => v.id === desk.preview.id)
    if (moving) Object.assign(moving, only(desk.preview))
    const fresh = inset ? views.filter((v) => !frameViews.has(v.id)).map((v) => v.id) : []
    const waits = fresh.map((id) => loaded((url) => url.includes(`${inset.file}?tab=${encodeURIComponent(id)}`)))
    for (const id of fresh) frameViews.add(id)
    await page.evaluate(({ views, live, css, inset, base }) => {
      let root = document.getElementById('preview-views')
      if (!root) {
        root = Object.assign(document.createElement('div'), { id: 'preview-views' })
        root.style.cssText = 'position:fixed;inset:0;z-index:2147482000;pointer-events:none'
        document.head.append(Object.assign(document.createElement('style'), { textContent: css }))
        document.body.append(root)
        // The core's page-drag, roughly: a press on a page's background (not a control, not text) that travels more than 4px drags the window.
        root.addEventListener('pointerdown', (e) => {
          const pv = e.target.closest('.pv')
          if (!pv || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.target.closest('a, button, input, textarea, select, label, summary, [contenteditable], [draggable="true"]')) return
          const caret = document.caretRangeFromPoint(e.clientX, e.clientY)
          if (caret?.startContainer.nodeType === Node.TEXT_NODE) {
            const text = document.createRange()
            text.selectNodeContents(caret.startContainer)
            if ([...text.getClientRects()].some((r) => e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom)) return
          }
          e.preventDefault()
          pv.setPointerCapture(e.pointerId)
          const send = (phase, ev) => window.__skiffCall('preview.pageDrag', { tab: pv.dataset.id, phase, screenX: ev.screenX, screenY: ev.screenY })
          let started = false
          const move = (ev) => {
            if (!started && Math.hypot(ev.screenX - e.screenX, ev.screenY - e.screenY) <= 4) return
            if (!started) send('start', e)
            started = true
            send('move', ev)
          }
          const up = (ev) => {
            pv.removeEventListener('pointermove', move)
            pv.removeEventListener('pointerup', up)
            if (started) send('end', ev)
          }
          pv.addEventListener('pointermove', move)
          pv.addEventListener('pointerup', up)
        })
      }
      const at = (el, r, z) => Object.assign(el.style, { position: 'absolute', left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: String(z), display: '' })
      for (const el of [...root.children]) {
        if (!live.includes(el.dataset.id)) el.remove()
        else el.style.display = 'none'
      }
      views.forEach((v, i) => {
        let el = root.querySelector(`.pv[data-id="${v.id}"]`)
        if (!el) {
          el = Object.assign(document.createElement('div'), { className: 'pv', innerHTML: v.html })
          el.dataset.id = v.id
          root.append(el)
        }
        at(el, v, 2 * i + 2)
        Object.assign(el.style, { borderRadius: '10px', overflow: 'hidden', pointerEvents: 'auto' })
        if (!inset) return
        let frame = root.querySelector(`iframe[data-id="${v.id}"]`)
        if (!frame) {
          frame = Object.assign(document.createElement('iframe'), { src: `${base}${inset.file}?tab=${encodeURIComponent(v.id)}` })
          frame.dataset.id = v.id
          frame.setAttribute('allowtransparency', 'true')
          root.append(frame)
        }
        at(frame, { x: v.x - inset.left, y: v.y - inset.top, width: v.width + inset.left + inset.right, height: v.height + inset.top + inset.bottom }, 2 * i + 1)
        Object.assign(frame.style, { border: '0', background: 'transparent', pointerEvents: 'auto' })
      })
    }, { views: views.map((v) => ({ ...v, html: deskPage(v.id) })), live: st.tabs.map((t) => t.id), css: PAGE_CSS, inset, base: pathToFileURL(dir + path.sep).href })
    await Promise.all(waits)
  }
  const frameViews = new Set()
  // The core's foreground set: windows still on the desk, the active one joining, none left ends it.
  const trim = () => {
    if (!st.deskOnly) return
    const ids = shownTabs(st.activeSpaceId).map((t) => t.id)
    const kept = st.deskOnly.filter((id) => ids.includes(id))
    const current = st.activeTabBySpace[st.activeSpaceId]
    st.deskOnly = !kept.length ? null : kept.includes(current) || !ids.includes(current) ? kept : [...kept, current]
  }
  const push = async () => { trim(); await emit('state', st); await drawViews() }

  // Named overlays, each its own transparent view above every page and frame; main above the others, a float one (its own window in the app) above all.
  let pending = 0
  async function showOverlay(p) {
    pending++
    try { return await placeOverlay(p) } finally { pending-- }
  }
  async function placeOverlay(p) {
    const file = typeof p.file === 'string' && p.file === path.basename(p.file) && fs.existsSync(path.join(dir, p.file)) ? p.file : fail('file must name a file in the shell folder')
    const name = p.name || 'main'
    const b = p.bounds
    const rect = b ? { x: b.x < 0 ? Math.max(0, W + b.x) : b.x, y: b.y < 0 ? Math.max(0, H + b.y) : b.y, width: Math.min(b.width, W), height: Math.min(b.height, H) } : { x: 0, y: 0, width: W, height: H }
    const o = overlays[name] ||= { name }
    // A second call while the file still loads must not load it again, or the events it heard so far are lost.
    const same = o.file === file
    if (!same) Object.assign(o, { file, ready: loaded((url) => url.endsWith(`/${file}`)) })
    await page.evaluate(({ id, src, same, rect, z }) => {
      let f = document.getElementById(id)
      if (!f) {
        f = Object.assign(document.createElement('iframe'), { id })
        f.setAttribute('allowtransparency', 'true')
        document.body.append(f)
      }
      f.style.cssText = `position:fixed;border:0;background:transparent;z-index:${z};left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`
      if (!same) f.src = src
    }, { id: `preview-overlay-${name}`, src: pathToFileURL(path.join(dir, file)).href, same, rect, z: p.float ? 2147483646 : name === 'main' ? 2147483600 : 2147483500 })
    o.frame = await o.ready
    const wasShown = o.shown
    o.shown = true
    o.bounds = rect
    // The core focuses an overlay it shows unless told not to; the shell pages learn it from the focus event.
    if (p.focus === true || (p.focus !== false && (!wasShown || !same))) await o.frame.evaluate(() => dispatchEvent(new Event('focus'))).catch(() => {})
    return null
  }
  async function hideOverlay(p) {
    const o = overlays[p.name || 'main']
    if (!o?.shown) return null
    o.shown = false
    await o.frame.evaluate(() => dispatchEvent(new Event('blur'))).catch(() => {})
    await page.evaluate((id) => { document.getElementById(id).style.display = 'none' }, `preview-overlay-${o.name}`)
    return null
  }

  const placeRect = (p) => {
    if (![p.x, p.y, p.width, p.height].every(Number.isFinite) || p.width < 240 || p.height < 160) fail('x, y, width, height must be finite; width at least 240, height at least 160')
    return only(p)
  }
  const commands = {
    'state.get': () => st,
    'commands.list': () => [],
    'extensions.list': () => [],
    'ai.agents': () => [],
    'ui.shellPath': () => ({ path: '/preview' }),
    'ui.focusPage': () => null,
    'ui.inFront': () => ({ front: false }),
    'ui.showOverlay': showOverlay,
    'ui.hideOverlay': hideOverlay,
    'ui.emit': async (p) => { await emit(p.name, p.data); return null },
    'ui.setDesk': async (p) => {
      for (const key of ['hit', 'capture', 'preview']) if (key in p) desk[key] = p[key]
      if ('only' in p) {
        st.deskOnly = p.only
        await push()
      } else if ('preview' in p) await drawViews()
      return null
    },
    'desk.place': async (p) => {
      const t = p.id ? find(p.id) : active() || fail('No active tab')
      t.desk = { ...placeRect(p), z: 0 }
      raise(t)
      await push()
      return null
    },
    'desk.layouts': () => S.deskLayouts({ deskSize: { width: W, height: H }, deskTop: inset ? inset.top : 0 }),
    'desk.tile': async (p) => {
      const t = p.id ? find(p.id) : active() || fail('No active tab')
      const r = S.deskLayouts({ deskSize: { width: W, height: H }, deskTop: inset ? inset.top : 0 })[p.layout] || fail(`No layout ${p.layout}`)
      t.desk = { ...only(r), z: 0 }
      raise(t)
      await push()
      return null
    },
    // Sent to the dragged window's frame only, as the core does.
    'preview.pageDrag': async (p) => {
      const frame = page.frames().find((f) => f.url().includes(`${inset.file}?tab=${encodeURIComponent(p.tab)}`))
      await frame?.evaluate((d) => window.__skiffEmit?.('page-drag', d), p).catch(() => {})
      return null
    },
    'desk.hide': async (p) => {
      const t = p.id ? find(p.id) : active() || fail('No active tab')
      t.desk = { ...(t.desk || defaultRect(t)), z: t.desk?.z || 0, hidden: true }
      leave(t)
      await push()
      return null
    },
    'desk.show': async (p) => { activate(find(p.id)); await push(); return null },
    'tabs.activate': async (p) => { activate(find(p.id)); await push(); return null },
    'spaces.activate': async (p) => { st.activeSpaceId = p.id; await push(); return null },
    'spaces.cycle': async (p) => { const i = st.spaces.findIndex((x) => x.id === st.activeSpaceId); st.activeSpaceId = st.spaces[(i + p.delta + st.spaces.length) % st.spaces.length].id; await push(); return null },
    'tabs.create': async (p) => {
      const t = { id: `new${++made}`, spaceId: st.activeSpaceId, sessionPartition: 'persist:main', url: p.url || 'about:blank', title: p.url || 'New tab', favicon: '', favorite: false, pinned: false, folder: '', loading: false, canGoBack: false, canGoForward: false, createdAt: Date.now(), lastActiveAt: Date.now() }
      st.tabs.push(t)
      activate(t)
      await push()
      return t
    },
    'tabs.navigate': async (p) => { const t = active(); if (t) Object.assign(t, { url: p.url, title: p.url }); await push(); return null },
    'tabs.close': async (p) => {
      const t = find(p.id)
      leave(t)
      if (!plain(t)) t.desk = { ...(t.desk || defaultRect(t)), z: t.desk?.z || 0, hidden: true }
      else {
        st.tabs.splice(st.tabs.indexOf(t), 1)
        st.archive.unshift({ id: `a-${t.id}`, spaceId: t.spaceId, url: t.url, title: t.title, favicon: t.favicon, archivedAt: Date.now() })
      }
      await push()
      return null
    }
  }
  await context.exposeBinding('__skiffCall', (_source, method, params) => (commands[method] || (() => null))(params || {}))
  await context.addInitScript(deskShim)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href)
  await page.addStyleTag({ content: `html { background: ${dark ? 'linear-gradient(170deg, #1f2a38 0%, #18202b 55%, #121821 100%)' : 'linear-gradient(170deg, #c7d5e0 0%, #b5c6d3 55%, #a3b4c2 100%)'} !important; }` })
  await page.evaluate(() => document.fonts.ready)
  await drawViews()
  // Settled once the shell has opened the overlays it shows at rest.
  for (let quiet = 0; quiet < 4; quiet = pending ? 0 : quiet + 1) await page.waitForTimeout(100)

  // A selector starting with "overlay:" targets the main overlay, "panel:" the panel's, "buoy:" the Buoy's, "tabs:" the tab list's, "layouts:" the strip, "frame:<tab>:" that window's frame.
  const scope = (value) => {
    const m = /^(overlay|panel|buoy|tabs|layouts|frame:[^:]+):(.*)$/s.exec(value)
    if (!m) return [page, value]
    if (m[1].startsWith('frame:')) return [page.frames().find((f) => f.url().includes(`${inset.file}?tab=${encodeURIComponent(m[1].slice(6))}`)), m[2]]
    return [overlays[m[1] === 'overlay' ? 'main' : m[1]].frame, m[2]]
  }
  const STEPS = ['--click', '--hover', '--drag', '--drop', '--pinch', '--emit', '--type', '--eval', '--wait']
  for (let i = 0; i < raw.length; i++) {
    if (!STEPS.includes(raw[i])) continue
    const kind = raw[i]
    const value = raw[++i] || ''
    if (kind === '--click' || kind === '--hover') {
      const [target, selector] = scope(value)
      const locator = target.locator(selector)
      await (kind === '--click' ? locator.click() : locator.hover())
    } else if (kind === '--drag' || kind === '--drop') {
      const points = value.trim().split(/\s+/).map((p) => p.split(',').map(Number))
      await page.mouse.move(...points[0])
      await page.mouse.down()
      for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 8 })
      if (kind === '--drop') await page.mouse.up()
    } else if (kind === '--pinch') {
      const [at, dy] = value.trim().split(/\s+/)
      await page.mouse.move(...at.split(',').map(Number))
      await page.keyboard.down('Control')
      for (let left = Number(dy); Math.abs(left) > 0.5; left -= Math.sign(left) * Math.min(Math.abs(left), 10)) await page.mouse.wheel(0, Math.sign(left) * Math.min(Math.abs(left), 10))
      await page.keyboard.up('Control')
    } else if (kind === '--emit') {
      const [name, json] = value.split(/=(.*)/s)
      await emit(name, json ? JSON.parse(json) : undefined)
    } else if (kind === '--type') {
      const input = overlays.main?.shown && overlays.main.frame.locator('#palette-input')
      if (input && await input.count()) await input.pressSequentially(value, { delay: 20 })
      else await page.keyboard.type(value, { delay: 20 })
    } else if (kind === '--eval') {
      const [target, code] = scope(value)
      await (target.evaluate ? target.evaluate(code) : page.evaluate(code))
    } else if (kind === '--wait') await page.waitForTimeout(Number(value))
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(250)
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  await page.screenshot({ path: out })
  const placed = Object.fromEntries(st.tabs.filter((t) => t.desk).map((t) => [t.id, [t.desk.x, t.desk.y, t.desk.width, t.desk.height, t.desk.z, ...(t.desk.hidden ? ['hidden'] : [])]]))
  const shown = Object.values(overlays).filter((o) => o.shown).map((o) => `${o.name} ${o.file} ${JSON.stringify(o.bounds)}`)
  console.log(`wrote ${out}; active ${st.activeTabBySpace[st.activeSpaceId]}; windows ${shownTabs(st.activeSpaceId).map((t) => t.id).join(' ')}; only ${JSON.stringify(st.deskOnly || null)}; desk ${JSON.stringify(placed)}; capture ${desk.capture}; preview ${JSON.stringify(desk.preview)}; overlays ${shown.join(', ') || 'none'}`)
  if (errors.length) console.error(errors.join('\n'))
  await browser.close()
}

;(async () => {
  const dir = path.resolve(shellDir)
  if (!fs.existsSync(path.join(dir, 'index.html'))) { console.error(`${dir} has no index.html`); process.exit(1) }
  if (deskShell) return previewDesk(dir)
  const browser = await chromium.launch({ args: ['--no-sandbox'] }).catch((error) => {
    console.error(`${error.message.split('\n')[0]}\nRun: npx playwright install chromium`)
    process.exit(1)
  })
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2, bypassCSP: true, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Skiff preview' })
  await context.addInitScript(shim)
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('page error:', error.message))
  page.on('console', (message) => message.type() === 'error' && console.error('console:', message.text()))
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
  await page.evaluate((html) => {
    const target = document.getElementById('page')
    if (!target) return
    const fake = document.createElement('div')
    fake.id = 'preview-page'
    fake.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit'
    fake.innerHTML = html
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative'
    target.append(fake)
  }, article)
  if (overlay) {
    await page.evaluate((file) => {
      const frame = document.createElement('iframe')
      frame.id = 'preview-overlay'
      frame.src = file
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent;z-index:2147483647'
      frame.setAttribute('allowtransparency', 'true')
      document.body.append(frame)
    }, overlay)
    const frame = page.frameLocator('#preview-overlay')
    await frame.locator('body').waitFor()
    await page.waitForTimeout(150)
    const handle = await page.$('#preview-overlay')
    const content = await handle.contentFrame()
    await content.evaluate(() => document.fonts.ready)
    // An overlay that asks for bounds (ui.showOverlay {file, bounds}) sits in that rectangle, as it would in the app.
    await page.waitForTimeout(100)
    const bounds = await content.evaluate(() => window.__skiff.calls.filter(([m, p]) => m === 'ui.showOverlay' && p?.bounds).at(-1)?.[1].bounds)
    if (bounds) {
      // The core puts a negative edge at size + x, so the rectangle's near edge is |x| minus its own width from that side.
      await handle.evaluate((frame, b) => {
        frame.style.inset = 'auto'
        if (b.x < 0) frame.style.right = `${-b.x - b.width}px`
        else frame.style.left = `${b.x}px`
        if (b.y < 0) frame.style.bottom = `${-b.y - b.height}px`
        else frame.style.top = `${b.y}px`
        frame.style.width = `${b.width}px`
        frame.style.height = `${b.height}px`
      }, bounds)
    }
    for (const e of emits) {
      const [name, json] = e.split(/=(.*)/s)
      await content.evaluate(([n, d]) => window.__skiff.emit(n, d ? JSON.parse(d) : undefined), [name, json])
    }
    if (!emits.length && overlay === 'palette.html') await content.evaluate(() => window.__skiff.emit('palette', { mode: 'new' }))
    await page.waitForTimeout(100)
    if (typed) {
      const input = frame.locator('#palette-input')
      await input.focus()
      await input.pressSequentially(typed, { delay: 20 })
    }
  } else {
    for (const e of emits) {
      const [name, json] = e.split(/=(.*)/s)
      await page.evaluate(([n, d]) => window.__skiff.emit(n, d ? JSON.parse(d) : undefined), [name, json])
    }
  }
  await page.waitForTimeout(250)
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  await page.screenshot({ path: out })
  const bounds = await page.evaluate(() => window.__skiff.calls.filter(([m]) => m === 'ui.setPageBounds').at(-1)?.[1])
  const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status !== 'loaded' && !/italic/i.test(f.style)).map((f) => `${f.family}:${f.status}`))
  console.log(`wrote ${out}; page bounds ${JSON.stringify(bounds)}${fonts.length ? `; fonts not loaded: ${fonts.join(', ')}` : ''}`)
  await browser.close()
})().catch((error) => { console.error(error); process.exit(1) })

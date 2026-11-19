'use strict'

const $ = (id) => document.getElementById(id)
const paletteInput = $('palette-input')
const palette = { mode: 'new', site: null, typed: '', rows: [], selected: 0 }
const ask = { on: false, agent: '', model: '', effort: '' }
// Agent names are trimmed, so this value never collides with one.
const ADD = ' add'
let state = null
let agents = []

const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId)
const activeTab = () => state.tabs.find((t) => t.id === state.activeTabBySpace[state.activeSpaceId])
const isIncognito = (spaceId) => Boolean(state.spaces.find((space) => space.id === spaceId)?.incognito)
const openUrl = (url) => skiff.call(palette.mode === 'edit' && activeTab() ? 'tabs.navigate' : 'tabs.create', { url })
// back: the keyboard goes back to the panel when the bar was opened from it.
const close = (back = false) => {
  paletteInput.blur()
  return closeOverlay('main', { back })
}
const paletteEl = $('palette')
const results = $('palette-results')
const fit = () => fitOverlay(state, 'palette.html', paletteEl, PALETTE_WIDTH, paletteEl.offsetHeight + Math.max(0, results.scrollHeight - results.clientHeight))

const askEntry = () => agents.find((a) => a.name === ask.agent) || agents[0]
const valueIn = (list, value, fallback) => (list.some((o) => o.value === value) ? value : fallback || '')
const nameOf = (list, value) => list?.find((o) => o.value === value)?.name
function askChoice() {
  const entry = askEntry()
  return { entry, model: entry?.models ? valueIn(entry.models, ask.model, entry.model) : ask.model, effort: entry?.efforts ? valueIn(entry.efforts, ask.effort, entry.effort) : ask.effort }
}
const pageTab = () => {
  const tab = activeTab()
  return !activeSpace().incognito && tab && !tab.chat && /^https?:/i.test(tab.url) ? tab : null
}

function askRow() {
  const { entry, model, effort } = askChoice()
  const sub = [nameOf(entry?.models, model), nameOf(entry?.efforts, effort)].filter(Boolean).join(' · ')
  return { label: entry ? `Ask ${entry.name}` : 'Ask an agent', note: entry ? sub || 'Tab to choose model and effort' : 'Connect your agent', hint: entry ? 'New tab' : 'Settings', icon: 'sparkle', ask: true, pick: sendAsk }
}

// With no agent yet the bar closes and Settings opens at its Agents group.
const connectAgent = () => close().then(() => skiff.call('ui.emit', { name: 'toggle-settings', data: { section: 'agents' } }))

function sendAsk() {
  const { entry, model, effort } = askChoice()
  if (!entry) return connectAgent()
  return skiff.call('ai.ask', { text: palette.typed.trim(), includePage: Boolean(ask.on && pageTab()) && $('palette-include').checked, agent: entry.name, model: model || undefined, effort: effort || undefined })
}

function paletteRows() {
  const text = palette.typed.trim()
  const q = text.toLowerCase()
  const hint = palette.mode === 'edit' ? 'Go' : 'New tab'
  if (ask.on) return []
  if (palette.site) {
    const site = palette.site
    return [{ label: q ? `Search ${site.name} for ${text}` : `Search ${site.name}`, hint, icon: 'search', pick: () => openUrl(site.search.replace('%s', () => encodeURIComponent(text))) }]
  }
  if (!q) return []
  const incognito = Boolean(activeSpace().incognito)
  const tabs = state.tabs.filter((t) => isIncognito(t.spaceId) === incognito).sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  const prefix = (host) => host.startsWith(q)
  const completion = tabs.map((t) => hostOf(t.url)).find(prefix)
    || SITES.find((s) => prefix(s.host) || s.name.toLowerCase().startsWith(q))?.host
    || state.archive.map((e) => hostOf(e.url)).find(prefix)
  const siteOf = (host) => SITES.find((s) => s.host === host)
  const rows = []
  if (completion) {
    const site = siteOf(completion)
    rows.push({ label: completion, note: site && `Tab to search ${site.name}`, hint, icon: 'globe', site, complete: true, pick: () => openUrl(completion) })
  }
  for (const t of tabs) {
    if ((palette.mode === 'edit' && t === activeTab()) || !`${t.title} ${t.url}`.toLowerCase().includes(q)) continue
    rows.push({ label: t.title || t.url, host: hostOf(t.url), note: state.spaces.find((s) => s.id === t.spaceId)?.name, hint: 'Switch to tab', tab: t, pick: () => skiff.call('tabs.activate', { id: t.id }) })
  }
  for (const site of SITES) {
    if (site.host === completion || !(site.host.includes(q) || site.name.toLowerCase().includes(q))) continue
    rows.push({ label: site.name, host: site.host, note: 'Tab to search', hint, icon: 'globe', site, pick: () => openUrl(site.url) })
  }
  for (const entry of state.archive.filter((e) => `${e.title} ${e.url}`.toLowerCase().includes(q)).slice(0, 3)) {
    rows.push({ label: entry.title || entry.url, host: hostOf(entry.url), hint: 'Reopen', tab: entry, pick: () => skiff.call('archive.restore', { id: entry.id }) })
  }
  rows.length = Math.min(rows.length, 7)
  const urlish = !/\s/.test(text) && (HOST.test(text) || SCHEME.test(text))
  const question = palette.mode === 'new' && /\s/.test(text) && !completion
  if (question) rows.unshift(askRow())
  rows.push({ label: urlish ? `Go to ${text}` : `Search the web for ${text}`, host: urlish ? '' : hostOf(state.settings.searchUrl), hint, icon: urlish ? 'globe' : 'search', pick: () => openUrl(text) })
  // An address or a single word still opens on Enter; the agent waits below.
  if (!question) rows.push(askRow())
  return rows
}

// The first row sits nearest the input, above or below it as the bar opens from the Buoy, so ArrowDown walks away from the input.
function drawPalette() {
  palette.rows = paletteRows()
  palette.selected = Math.max(0, Math.min(palette.selected, palette.rows.length - 1))
  $('palette-results').replaceChildren(...palette.rows.map((row, i) => h('li', {
    id: `palette-${i}`, role: 'option', class: i === palette.selected ? 'pick' : null, 'aria-selected': String(i === palette.selected), 'data-ask': row.ask,
    onmousedown: (event) => event.preventDefault(), onclick: () => pickRow(row)
  }, row.tab ? favicon(row.tab) : icon(row.icon),
    h('span', { class: 'palette-label' }, h('span', { class: 'label' }, row.label),
      (row.host || row.note) && h('small', {}, row.host && h('span', { class: 'mono' }, row.host), row.host && row.note && ' · ', row.note)),
    h('span', { class: 'when' }, row.hint))))
  paletteInput.setAttribute('aria-expanded', String(Boolean(palette.rows.length)))
  if (palette.rows.length) paletteInput.setAttribute('aria-activedescendant', `palette-${palette.selected}`)
  else paletteInput.removeAttribute('aria-activedescendant')
  fit()
}

function setSite(site, typed) {
  palette.site = site
  palette.typed = typed
  palette.selected = 0
  paletteInput.value = typed
  paletteInput.placeholder = site ? `Search ${site.name}` : PLACEHOLDER
  $('palette-site').textContent = site ? `Search ${site.name}` : ''
  $('palette-site').hidden = !site
  drawPalette()
}

// What the bar opens comes with every window of the space.
async function pickRow(row) {
  try {
    await row.pick()
    if (state.deskOnly) skiff.call('ui.setDesk', { only: null }).catch(() => {})
    close()
  } catch (error) {
    $('palette-error').textContent = error.message || 'That could not open. Try again.'
    $('palette-error').hidden = false
  }
}

// Rebuilt only when the choices change, so a push never closes a select the user has open.
function fill(select, options, value) {
  const key = JSON.stringify(options)
  if (select.dataset.key !== key) {
    select.dataset.key = key
    select.replaceChildren(...options.map((o) => h('option', { value: o.value }, o.name || o.value)))
  }
  select.value = value
}

function drawAsk() {
  $('palette-ask').hidden = $('palette-tools').hidden = !ask.on
  if (!ask.on) return fit()
  const { entry, model, effort } = askChoice()
  $('palette-ask').textContent = entry ? `Ask ${entry.name}` : 'Ask an agent'
  fill($('palette-agent'), [...agents.map((a) => ({ value: a.name, name: a.name })), ...(entry ? [] : [{ value: '', name: 'No agent' }]), { value: ADD, name: 'Add an agent...' }], entry?.name || '')
  const waiting = { value: '', name: entry?.status === 'error' ? 'Unavailable' : 'Loading...' }
  for (const [id, list, value] of [['palette-model', entry?.models, model], ['palette-effort', entry?.efforts, effort]]) {
    fill($(id), list || [waiting], list ? value : '')
    $(id).disabled = !list
    $(id).parentElement.hidden = !entry
  }
  const tab = pageTab()
  $('palette-include').parentElement.hidden = !tab
  $('palette-include').parentElement.title = tab ? tab.title || tab.url : ''
  if (entry?.status === 'error') {
    $('palette-error').textContent = entry.error || `${entry.name} could not start.`
    $('palette-error').hidden = false
  }
  fit()
}

function warm() {
  const entry = askEntry()
  if (!entry) return
  skiff.call('ai.warm', { agent: entry.name }).then((next) => {
    agents = agents.map((a) => (a.name === next?.name ? next : a))
    drawAsk()
  }, (error) => {
    $('palette-error').textContent = error.message || `${entry.name} could not start.`
    $('palette-error').hidden = false
    fit()
  })
}

function enterAsk() {
  ask.on = true
  ask.agent = askEntry()?.name || ''
  paletteInput.placeholder = 'Ask anything'
  drawPalette()
  drawAsk()
  warm()
  paletteInput.focus()
}

function leaveAsk() {
  ask.on = false
  paletteInput.placeholder = PLACEHOLDER
  $('palette-error').hidden = true
  drawAsk()
  drawPalette()
}

function openPalette(mode) {
  palette.mode = mode === 'edit' ? 'edit' : 'new'
  const saved = state.settings.ai || {}
  Object.assign(ask, { on: false, agent: saved.agent || '', model: saved.model || '', effort: saved.effort || '' })
  $('palette-include').checked = false
  paintSpace(state)
  $('palette-error').hidden = true
  setSite(null, mode === 'edit' ? activeTab()?.url || '' : '')
  drawAsk()
  if (mode === 'ask') enterAsk()
  paletteInput.focus()
  paletteInput.select()
}

paletteInput.addEventListener('input', (event) => {
  palette.typed = paletteInput.value
  $('palette-error').hidden = true
  if (ask.on) return fit()
  const exact = !palette.site && SITES.find((s) => `${s.host} ` === paletteInput.value.toLowerCase())
  if (exact) return setSite(exact, '')
  palette.selected = 0
  drawPalette()
  const top = palette.rows[0]
  if (event.inputType === 'insertText' && top?.complete) {
    paletteInput.value = palette.typed + top.label.slice(palette.typed.trim().length)
    paletteInput.setSelectionRange(palette.typed.length, paletteInput.value.length)
  }
})
paletteInput.addEventListener('keydown', (event) => {
  if (ask.on) {
    if (event.key !== 'Backspace' || paletteInput.value) return
    event.preventDefault()
    return leaveAsk()
  }
  const rows = palette.rows
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!rows.length) return
    palette.selected = (palette.selected + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
    drawPalette()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (rows[palette.selected]) pickRow(rows[palette.selected])
  } else if (event.key === 'Tab') {
    event.preventDefault()
    if (rows[palette.selected]?.ask && !event.shiftKey) return enterAsk()
    const site = rows[palette.selected]?.site
    if (site?.search && !event.shiftKey) setSite(site, '')
  } else if (event.key === 'Backspace' && palette.site && !paletteInput.value) {
    event.preventDefault()
    setSite(null, palette.site.host)
  }
})
// In agent mode Enter sends from anywhere in the bar; an open select keeps its own keys.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close(true)
  else if (event.key === 'Enter' && ask.on && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    if (palette.typed.trim() || !askEntry()) pickRow({ pick: sendAsk })
  }
})
// Bounded to its card, the bar closes when the pointer goes anywhere else: a page, an ear, another app.
addEventListener('blur', () => { if (overlayOpen) close() })
// The overlay's shadow margin can lie over the Buoy or a window, so a press there is a press outside the bar.
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('#palette')) close() })
addEventListener('resize', fit)
$('palette-agent').addEventListener('change', () => {
  const value = $('palette-agent').value
  if (value === ADD) return pickRow({ pick: connectAgent })
  Object.assign(ask, { agent: value, model: '', effort: '' })
  $('palette-error').hidden = true
  drawAsk()
  warm()
})
$('palette-model').addEventListener('change', () => { ask.model = $('palette-model').value })
$('palette-effort').addEventListener('change', () => { ask.effort = $('palette-effort').value })

const ready = Promise.all([
  skiff.call('state.get').then((first) => { state = first }),
  skiff.call('ai.agents').then((list) => { agents = list || [] }, () => {})
])
skiff.on('state', (next) => {
  state = next
  paintSpace(state)
})
skiff.on('ai-agents', (next) => {
  agents = next || []
  if (!state) return
  drawPalette()
  drawAsk()
})
skiff.on('palette', ({ mode, forwarded }) => {
  if (!forwarded) return
  ready.then(() => {
    // Cmd+J over an open bar keeps what was typed.
    if (mode === 'ask' && overlayOpen) return ask.on ? paletteInput.focus() : enterAsk()
    if (!overlayOpen) grow(paletteEl)
    overlayOpen = true
    openPalette(mode)
  })
})

'use strict'

const $ = (id) => document.getElementById(id)
const paletteInput = $('palette-input')
const palette = { mode: 'new', site: null, typed: '', rows: [], selected: 0 }
let state = null

const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId)
const activeTab = () => state.tabs.find((t) => t.id === state.activeTabBySpace[state.activeSpaceId])
const isIncognito = (spaceId) => Boolean(state.spaces.find((space) => space.id === spaceId)?.incognito)
const openUrl = (url) => skiff.call(palette.mode === 'edit' && activeTab() ? 'tabs.navigate' : 'tabs.create', { url })
const close = () => {
  paletteInput.blur()
  return skiff.call('ui.hideOverlay')
}

function paletteRows() {
  const text = palette.typed.trim()
  const q = text.toLowerCase()
  const hint = palette.mode === 'edit' ? 'Go' : 'New tab'
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
  rows.push({ label: urlish ? `Go to ${text}` : `Search the web for ${text}`, host: urlish ? '' : hostOf(state.settings.searchUrl), hint, icon: urlish ? 'globe' : 'search', pick: () => openUrl(text) })
  return rows
}

function drawPalette() {
  palette.rows = paletteRows()
  palette.selected = Math.max(0, Math.min(palette.selected, palette.rows.length - 1))
  $('palette-results').replaceChildren(...palette.rows.map((row, i) => h('li', {
    id: `palette-${i}`, role: 'option', class: i === palette.selected ? 'pick' : null, 'aria-selected': String(i === palette.selected),
    onmousedown: (event) => event.preventDefault(), onclick: () => pickRow(row)
  }, row.tab ? favicon(row.tab) : icon(row.icon), h('span', { class: 'palette-label' }, h('span', { class: 'label' }, row.label), row.host && h('small', { class: 'host' }, row.host), row.host && row.note && h('small', { class: 'sep', 'aria-hidden': 'true' }, '·'), row.note && h('small', {}, row.note)), h('span', { class: 'act' }, `[${row.hint}]`))))
  paletteInput.setAttribute('aria-expanded', String(Boolean(palette.rows.length)))
  if (palette.rows.length) paletteInput.setAttribute('aria-activedescendant', `palette-${palette.selected}`)
  else paletteInput.removeAttribute('aria-activedescendant')
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

async function pickRow(row) {
  try {
    await row.pick()
    close()
  } catch (error) {
    $('palette-error').textContent = error.message || 'That could not open. Try again.'
    $('palette-error').hidden = false
  }
}

function theme() {
  const space = activeSpace()
  document.documentElement.style.setProperty('--accent', space.color)
  document.documentElement.classList.toggle('incognito', Boolean(space.incognito))
}

function openPalette(mode) {
  palette.mode = mode
  theme()
  $('palette-error').hidden = true
  setSite(null, mode === 'edit' ? activeTab()?.url || '' : '')
  paletteInput.focus()
  paletteInput.select()
}

paletteInput.addEventListener('input', (event) => {
  palette.typed = paletteInput.value
  $('palette-error').hidden = true
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
    const site = rows[palette.selected]?.site
    if (site?.search && !event.shiftKey) setSite(site, '')
  } else if (event.key === 'Backspace' && palette.site && !paletteInput.value) {
    event.preventDefault()
    setSite(null, palette.site.host)
  }
})
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close() })
$('backdrop').addEventListener('click', close)

const ready = skiff.call('state.get').then((first) => { state = first })
skiff.on('state', (next) => {
  state = next
  theme()
})
skiff.on('palette', ({ mode }) => ready.then(() => openPalette(mode)))

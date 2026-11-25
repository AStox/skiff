'use strict'

// Every open tab of every space, under its space's heading, opened from the count in the Buoy, with a speaker on those playing sound. A favorite or pinned tab is open once its page is loaded. It floats above other apps and opening it never brings Skiff forward.
const $ = (id) => document.getElementById(id)
const card = $('tablist')
const rows = $('tablist-rows')

overlayName = 'tabs'
let state = null
let drawn = ''

// The base page closes it, since hiding a floating overlay ends this page before it could say so.
const close = () => {
  if (!overlayOpen) return
  overlayOpen = false
  buoyAction('list-close')
}

function row(tab, current) {
  const children = state.tabs.some((t) => t.parentId === tab.id)
  const item = h('li', { class: `row${current ? ' current' : ''}${isShown(state, tab) ? '' : ' hidden-win'}`, 'data-tab-id': tab.id },
    h('button', { class: 'row-main', type: 'button', title: tab.url, 'aria-current': current ? 'true' : null, onclick: () => pick(tab) },
      favicon(tab), h('span', { class: 'label' }, tab.title || tab.url), speaker(tab), agentBadge(tab), agentDot(tab)),
    children && h('button', { id: `trail-toggle-${tab.id}`, class: 'skiff-trail', type: 'button', 'aria-expanded': String(!tab.trailCollapsed), 'aria-label': `${tab.trailCollapsed ? 'Expand' : 'Collapse'} trail for ${tab.title || tab.url}`, onclick: () => skiff.call('tabs.setTrailCollapsed', { id: tab.id, collapsed: !tab.trailCollapsed }).catch((error) => rows.prepend(h('li', { role: 'alert', class: 'empty' }, error.message))) }))
  const seen = new Set()
  for (let parent = state.tabs.find((t) => t.id === tab.parentId); parent && !seen.has(parent.id); parent = state.tabs.find((t) => t.id === parent.parentId)) seen.add(parent.id)
  item.style.paddingInlineStart = `${Math.min(seen.size, 8) * 12}px`
  return item
}

function render() {
  if (!state) return
  paintSpace(state)
  const active = state.activeTabBySpace[state.activeSpaceId]
  // List collapse never changes the desk's independent live windows.
  const listed = (tab) => {
    if (tab.userPeek) return false
    if (!isPlain(tab)) return isOpen(tab)
    const seen = new Set()
    for (let parent = state.tabs.find((t) => t.id === tab.parentId); parent && !seen.has(parent.id); parent = state.tabs.find((t) => t.id === parent.parentId)) {
      if (parent.trailCollapsed) return false
      seen.add(parent.id)
    }
    return true
  }
  const spaces = state.spaces.map((space) => ({ space, tabs: visibleTabs(state, space.id).filter(listed) })).filter((s) => s.tabs.length)
  // Headings by space where there are two or more, and by desktop within a space where there are two or more desktops.
  const named = state.spaces.length > 1
  const desktops = state.desktops?.list.length > 1 ? state.desktops : null
  const key = JSON.stringify([spaces.map(({ space, tabs }) => [space.id, space.name, tabs.map((t) => [t.id, t.title, t.url, t.favicon, t.parentId, t.trailCollapsed, t.favorite, t.pinned, t.lifecycle, Boolean(t.protections?.audible), t.agent, t.agentState, isShown(state, t), desktops && t.desktopId])]), state.activeSpaceId, active, desktops])
  if (key !== drawn) {
    drawn = key
    const focusId = rows.contains(document.activeElement) ? document.activeElement.id : ''
    const line = (space, t) => row(t, space.id === state.activeSpaceId && t.id === active)
    const group = (space, tabs, d) => [h('li', { class: 'desk-head', 'data-desktop': String(d.number) }, `Desktop ${d.number}${d.id === desktops.current ? ' · this desktop' : ''}`), ...tabs.filter((t) => t.desktopId === d.id).map((t) => line(space, t))]
    const body = (space, tabs) => (desktops ? desktops.list.filter((d) => tabs.some((t) => t.desktopId === d.id)).flatMap((d) => group(space, tabs, d)) : tabs.map((t) => line(space, t)))
    const items = spaces.flatMap(({ space, tabs }) => [...(named ? [h('li', { class: 'desk-head', 'data-space': space.id }, `${space.name}${space.id === state.activeSpaceId ? ' · this space' : ''}`)] : []), ...body(space, tabs)])
    rows.replaceChildren(...(items.length ? items : [h('li', { class: 'empty' }, 'No open tabs')]))
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true })
  }
  fit()
}

// The card sits next to the Buoy as the panel does, and only the card takes clicks.
function fit() {
  if (!overlayOpen || !state) return
  const natural = rows.scrollHeight + card.offsetHeight - rows.clientHeight
  const a = anchor(state, TABLIST_WIDTH, natural)
  document.documentElement.classList.toggle('above', a.above)
  Object.assign(card.style, { left: `${a.card.x}px`, top: `${a.card.y}px`, width: `${a.card.width}px`, height: `${a.card.height}px` })
  const hit = [{ x: a.card.x, y: a.card.y, width: a.card.width, height: a.card.height }]
  const key = JSON.stringify([a.bounds, hit])
  if (key === fitted) return
  fitted = key
  skiff.call('ui.showOverlay', { name: 'tabs', file: 'tablist.html', bounds: a.bounds, hit, float: true, focus: false }).catch(() => {})
}

// The base page picks it too, since closing the list ends this page.
const pick = (tab) => buoyAction('pick', { id: tab.id })

const swipe = spaceSwiper()
card.addEventListener('wheel', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return swipe.block(event.timeStamp)
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? card.clientWidth : 1
  const x = event.deltaX * unit
  const y = event.deltaY * unit
  if (Math.abs(x) > Math.abs(y) * 1.3) event.preventDefault()
  swipe.step(event.timeStamp, x, y)
}, { passive: false })
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close() })
addEventListener('blur', close)

skiff.on('tablist-open', (data) => {
  if (!data?.forwarded) return
  overlayOpen = true
  fitted = ''
  render()
  grow(card)
})
skiff.on('buoy-moved', fit)
skiff.on('state', (next) => {
  const was = state && [state.activeSpaceId, state.activeTabBySpace[state.activeSpaceId]]
  state = next
  // Another window brought forward, by a click on it or a favorite, is a click outside the list.
  if (was && was[0] === state.activeSpaceId && was[1] !== state.activeTabBySpace[state.activeSpaceId]) close()
  render()
})
skiff.call('state.get').then((first) => {
  state ||= first
  render()
}).catch(() => {})

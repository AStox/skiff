'use strict'

// The layout strip. The frame of the window being dragged shows it, picks the cell under the pointer and tells this page what to draw.
const stripEl = document.getElementById('strip')
const labelEl = document.getElementById('strip-label')
let state = null
let shown = null

function draw() {
  if (!state) return
  paintSpace(state)
  const { width: W, height: H } = deskSize(state)
  const { card, cells, bounds } = layoutStrip(state)
  const at = (el, r) => Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
  at(stripEl, { ...card, x: card.x - bounds.x, y: card.y - bounds.y })
  stripEl.replaceChildren(...cells.map((c) => {
    const on = c.name === shown?.hover
    const cell = h('div', { class: on ? 'cell on' : 'cell', role: 'option', 'aria-selected': String(on), 'aria-label': LAYOUT_LABELS[c.name], 'data-layout': c.name })
    at(cell, { ...c, x: c.x - card.x, y: c.y - card.y })
    const r = shown?.layouts?.[c.name]
    if (r) {
      const pct = (v, of) => `${(v / of) * 100}%`
      const mark = h('i')
      Object.assign(mark.style, { left: pct(r.x, W), top: pct(r.y, H), width: pct(r.width, W), height: pct(r.height, H) })
      cell.append(mark)
    }
    return cell
  }))
  const hovered = cells.find((c) => c.name === shown?.hover)
  labelEl.hidden = !hovered
  if (!hovered) return
  labelEl.textContent = LAYOUT_LABELS[hovered.name]
  Object.assign(labelEl.style, { left: `${hovered.x + hovered.width / 2 - bounds.x}px`, top: `${card.y + card.height + 6 - bounds.y}px` })
}

skiff.on('layouts-strip', (data) => {
  // A fresh open slides in; hover changes only repaint.
  const fresh = !shown && data
  shown = data || null
  if (!data) return
  draw()
  if (fresh) {
    stripEl.classList.remove('fresh')
    void stripEl.offsetWidth
    stripEl.classList.add('fresh')
  }
})
skiff.on('state', (next) => {
  state = next
  draw()
})
skiff.call('state.get').then((first) => {
  state ||= first
  draw()
}).catch(() => {})

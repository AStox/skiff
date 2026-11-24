'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../src/state')

// A 1000x800 desk with a 30px frame top, so the free area is x 8 to 992 and y 38 to 792.
const desk = (n) => {
  const s = Object.assign(S.load(), { deskSize: { width: 1000, height: 800 }, deskTop: 30 })
  const tabs = Array.from({ length: n }, (_, i) => S.createTab(s, { url: `https://t${i}.example/` }, 1))
  return { s, tabs }
}
const rects = (s, tabs, mode) => {
  const r = S.arrange(s, mode)
  return tabs.map((t) => [r[t.id].x, r[t.id].y, r[t.id].width, r[t.id].height])
}
const meets = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
const apart = (list) => list.every((a, i) => list.every((b, j) => i === j || !meets(a, b)))

const FILL = [8, 38, 984, 754]
const EXPECTED = {
  full: { 1: [FILL], 2: [FILL, FILL], 3: [FILL, FILL, FILL] },
  sections: {
    1: [[8, 38, 240, 358]],
    2: [[8, 38, 240, 358], [256, 38, 240, 358]],
    3: [[8, 38, 240, 358], [256, 38, 240, 358], [504, 38, 240, 358]],
    9: [[8, 38, 240, 358], [256, 38, 240, 358], [504, 38, 240, 358], [752, 38, 240, 358], [8, 434, 240, 358], [256, 434, 240, 358], [504, 434, 240, 358], [752, 434, 240, 358], [8, 38, 240, 358]]
  },
  split: {
    1: [FILL],
    2: [[8, 38, 488, 754], [504, 38, 488, 754]],
    3: [[8, 38, 323, 754], [339, 38, 322, 754], [669, 38, 323, 754]],
    9: [[8, 38, 102, 754], [118, 38, 102, 754], [228, 38, 103, 754], [339, 38, 102, 754], [449, 38, 102, 754], [559, 38, 102, 754], [669, 38, 103, 754], [780, 38, 102, 754], [890, 38, 102, 754]]
  },
  grid: {
    1: [FILL],
    2: [[8, 38, 488, 754], [504, 38, 488, 754]],
    3: [[8, 38, 488, 358], [504, 38, 488, 358], [8, 434, 984, 358]],
    9: [[8, 38, 323, 226], [339, 38, 322, 226], [669, 38, 323, 226], [8, 302, 323, 226], [339, 302, 322, 226], [669, 302, 323, 226], [8, 566, 323, 226], [339, 566, 322, 226], [669, 566, 323, 226]]
  },
  // The last tab is the active one and takes the main place.
  'main-stack': {
    1: [FILL],
    2: [[602, 38, 390, 754], [8, 38, 586, 754]],
    3: [[602, 38, 390, 358], [602, 434, 390, 358], [8, 38, 586, 754]]
  },
  spiral: {
    1: [FILL],
    2: [[8, 38, 488, 754], [504, 38, 488, 754]],
    3: [[8, 38, 488, 754], [504, 38, 488, 358], [504, 434, 488, 358]]
  },
  cascade: {
    1: [[8, 38, 689, 519]],
    2: [[8, 38, 689, 519], [36, 66, 689, 519]],
    3: [[8, 38, 689, 519], [36, 66, 689, 519], [64, 94, 689, 519]],
    9: [[8, 38, 689, 519], [36, 66, 689, 519], [64, 94, 689, 519], [92, 122, 689, 519], [120, 150, 689, 519], [148, 178, 689, 519], [176, 206, 689, 519], [204, 234, 689, 519], [232, 262, 689, 519]]
  }
}

for (const [mode, byCount] of Object.entries(EXPECTED)) {
  test(`${mode} arranges 1, 2, 3 and 9 windows`, () => {
    for (const [n, expected] of Object.entries(byCount)) {
      const { s, tabs } = desk(Number(n))
      assert.deepEqual(rects(s, tabs, mode), expected, `${n} windows`)
    }
  })
}

test('full matches the fill layout of desk.layouts', () => {
  const { s, tabs } = desk(2)
  const { x, y, width, height } = S.deskLayouts(s).fill
  assert.deepEqual(rects(s, tabs, 'full'), [[x, y, width, height], [x, y, width, height]])
})

test('sections, split, grid, main-stack and spiral never overlap and stay on the desk', () => {
  for (const mode of ['sections', 'split', 'grid', 'main-stack', 'spiral']) {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9]) {
      const { s, tabs } = desk(n)
      const list = rects(s, tabs, mode)
      const visible = mode === 'sections' ? list.slice(0, 8) : list
      assert.ok(apart(visible), `${mode} ${n}`)
      for (const [x, y, w, h] of list) assert.ok(x >= 8 && y >= 38 && x + w <= 992 && y + h <= 792 && w > 0 && h > 0, `${mode} ${n} inside`)
    }
  }
})

test('sections starts over after 8 windows and split makes n equal columns', () => {
  const { s, tabs } = desk(10)
  const list = rects(s, tabs, 'sections')
  assert.deepEqual(list[8], list[0])
  assert.deepEqual(list[9], list[1])
  assert.ok(apart(list.slice(0, 8)))
  const five = desk(5)
  const columns = rects(five.s, five.tabs, 'split')
  assert.equal(columns.length, 5)
  assert.ok(Math.max(...columns.map((c) => c[2])) - Math.min(...columns.map((c) => c[2])) <= 1)
  assert.equal(columns.reduce((sum, c) => sum + c[2], 0) + 4 * 8, 984)
})

test('each window leaves its frame top free beneath the window above it', () => {
  const { s, tabs } = desk(4)
  const [a, , c] = rects(s, tabs, 'grid')
  assert.equal(c[1] - (a[1] + a[3]), 30 + 8)
})

test('free returns each shown window own rect and leaves hidden windows out', () => {
  const { s, tabs } = desk(3)
  S.hideDesk(s, { id: tabs[1].id })
  const r = S.arrange(s, 'free')
  assert.deepEqual(Object.keys(r).sort(), [tabs[0].id, tabs[2].id].sort())
  assert.deepEqual(r[tabs[0].id], { x: tabs[0].desk.x, y: tabs[0].desk.y, width: tabs[0].desk.width, height: tabs[0].desk.height })
  const split = S.arrange(s, 'split')
  assert.deepEqual(Object.keys(split).sort(), [tabs[0].id, tabs[2].id].sort())
  assert.equal(split[tabs[0].id].width, 488)
})

test('only the active space and desktop are arranged, and arranging never writes tab.desk', () => {
  const { s, tabs } = desk(2)
  const other = S.createSpace(s, { name: 'Other' })
  S.activateSpace(s, { id: s.spaces[0].id })
  const away = S.createTab(s, { url: 'https://away.example/', spaceId: other.id, activate: false }, 1)
  const before = JSON.stringify(s.tabs)
  const r = S.arrange(s, 'split')
  assert.equal(away.id in r, false)
  assert.deepEqual(Object.keys(r).sort(), tabs.map((t) => t.id).sort())
  assert.equal(JSON.stringify(s.tabs), before)
})

test('main-stack gives the active window the main place', () => {
  const { s, tabs } = desk(3)
  S.activateTab(s, { id: tabs[0].id }, 2)
  const [first, second, third] = rects(s, tabs, 'main-stack')
  assert.deepEqual(first, [8, 38, 586, 754])
  assert.deepEqual(second, [602, 38, 390, 358])
  assert.deepEqual(third, [602, 434, 390, 358])
})

test('windows keep their tab order, not their stacking, when one is raised', () => {
  const { s, tabs } = desk(3)
  const before = rects(s, tabs, 'split')
  S.activateTab(s, { id: tabs[0].id }, 2)
  assert.deepEqual(rects(s, tabs, 'split'), before)
})

test('without a desk window there is nothing to arrange', () => {
  const { s, tabs } = desk(2)
  delete s.deskSize
  assert.deepEqual(rects(s, tabs, 'split'), tabs.map((t) => [t.desk.x, t.desk.y, t.desk.width, t.desk.height]))
})

test('tabLayout is a validated setting that defaults to free', () => {
  const s = S.load()
  assert.equal(s.settings.tabLayout, 'free')
  S.setSettings(s, { tabLayout: 'spiral' })
  assert.equal(S.load(JSON.parse(JSON.stringify(S.persistable(s)))).settings.tabLayout, 'spiral')
  assert.throws(() => S.setSettings(s, { tabLayout: 'masonry' }), { code: 'bad_params' })
  assert.throws(() => S.setSettings(s, { tabLayout: 3 }), { code: 'bad_params' })
  assert.equal(S.load({ settings: { tabLayout: 'masonry' } }).settings.tabLayout, 'free')
})

test('in a non-free layout a placed or tiled window keeps its own rect, and free finds it where it was', () => {
  const { s, tabs } = desk(2)
  const own = { ...tabs[0].desk }
  const hosts = JSON.stringify(s.deskHosts)
  S.setSettings(s, { tabLayout: 'split' })
  S.placeDesk(s, { id: tabs[0].id, x: 300, y: 300, width: 400, height: 300 })
  S.tileDesk(s, { id: tabs[0].id, layout: 'left' })
  assert.deepEqual({ x: tabs[0].desk.x, y: tabs[0].desk.y, width: tabs[0].desk.width, height: tabs[0].desk.height }, { x: own.x, y: own.y, width: own.width, height: own.height })
  assert.equal(JSON.stringify(s.deskHosts), hosts)
  assert.throws(() => S.placeDesk(s, { id: tabs[0].id, x: 0, y: 0, width: 10, height: 10 }), { code: 'bad_params' })
  S.setSettings(s, { tabLayout: 'free' })
  assert.deepEqual(rects(s, tabs, 'free')[0], [own.x, own.y, own.width, own.height])
  S.placeDesk(s, { id: tabs[0].id, x: 300, y: 300, width: 400, height: 300 })
  assert.deepEqual(rects(s, tabs, 'free')[0], [300, 300, 400, 300])
})

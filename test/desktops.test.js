'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../src/state')
const D = require('../src/desktops')

const TWO = (current) => ({ current, list: [{ id: 3, number: 1 }, { id: 1, number: 2 }] })
const ids = (list) => list.map((x) => x.id)

function two() {
  const s = S.load()
  S.setDesktops(s, TWO(3), 0)
  s.deskSize = { width: 1280, height: 800 }
  return s
}

test('without desktops every tab is on the one desktop and nothing is stored', () => {
  const s = S.load()
  const a = S.createTab(s, { url: 'https://a.example' }, 1)
  assert.equal(a.desktopId, undefined)
  assert.equal(S.onDesktop(s, a), true)
  assert.equal(S.desktopNumber(s, 3), null)
  assert.equal('desktops' in S.persistable(two()), false)
})

test('new, restored and promoted tabs take the current desktop', () => {
  const s = two()
  const a = S.createTab(s, { url: 'https://a.example' }, 1)
  assert.equal(a.desktopId, 3)
  S.setDesktops(s, TWO(1), 2)
  const b = S.createTab(s, { url: 'https://b.example' }, 3)
  assert.equal(b.desktopId, 1)
  S.closeTab(s, { id: b.id }, 4)
  S.setDesktops(s, TWO(3), 5)
  assert.equal(S.restore(s, { id: b.id }, 6).desktopId, 3)
  const peek = S.createPeek(s, { url: 'https://c.example', sourceId: a.id }, 7)
  S.setDesktops(s, TWO(1), 8)
  assert.equal(S.promotePeek(s, { id: peek.id }, 9).desktopId, 1)
})

test('tabs with no desktop or one that is gone are adopted by the current desktop', () => {
  const s = S.load({ spaces: [{ id: 's1', name: 'Home', color: '#000' }], tabs: [
    { id: 'old', spaceId: 's1', url: 'https://old.example', title: 'old', favorite: false, lastActiveAt: 1, createdAt: 1, desktopId: 99 },
    { id: 'none', spaceId: 's1', url: 'https://none.example', title: 'none', favorite: false, lastActiveAt: 2, createdAt: 2 },
    { id: 'kept', spaceId: 's1', url: 'https://kept.example', title: 'kept', favorite: false, lastActiveAt: 3, createdAt: 3, desktopId: 3 },
    { id: 'junk', spaceId: 's1', url: 'https://junk.example', title: 'junk', favorite: false, lastActiveAt: 3, createdAt: 3, desktopId: 'x' }
  ] })
  assert.equal(S.getTab(s, 'junk').desktopId, undefined)
  S.setDesktops(s, TWO(1), 10)
  assert.deepEqual(s.tabs.map((t) => [t.id, t.desktopId]), [['old', 1], ['none', 1], ['kept', 3], ['junk', 1]])
  // A desktop closed in Mission Control hands its tabs over at the next read.
  S.setDesktops(s, { current: 1, list: [{ id: 1, number: 1 }] }, 11)
  assert.deepEqual(s.tabs.map((t) => t.desktopId), [1, 1, 1, 1])
})

test('desktops are runtime state and a tab keeps its desktop in the saved state', () => {
  const s = two()
  const a = S.createTab(s, { url: 'https://a.example' }, 1)
  const saved = JSON.parse(JSON.stringify(S.persistable(s)))
  assert.equal('desktops' in saved, false)
  assert.equal(saved.tabs[0].desktopId, 3)
  assert.equal(S.load(saved).tabs[0].desktopId, a.desktopId)
})

test('the desk shows only the current desktop\'s windows of the active space', () => {
  const s = two()
  const a = S.createTab(s, { url: 'https://a.example' }, 1)
  S.setDesktops(s, TWO(1), 2)
  const b = S.createTab(s, { url: 'https://b.example' }, 3)
  const c = S.createTab(s, { url: 'https://c.example' }, 4)
  assert.deepEqual(ids(S.shownTabs(s)), [b.id, c.id])
  S.setDesktops(s, TWO(3), 5)
  assert.deepEqual(ids(S.shownTabs(s)), [a.id])
  assert.deepEqual(ids(S.visibleTabs(s)), [a.id, b.id, c.id])
})

test('a desktop change shows the latest tab of the space on that desktop, or none', () => {
  const s = two()
  const a = S.createTab(s, { url: 'https://a.example' }, 1)
  const b = S.createTab(s, { url: 'https://b.example' }, 2)
  S.setDesktops(s, TWO(1), 3)
  const c = S.createTab(s, { url: 'https://c.example' }, 4)
  const d = S.createTab(s, { url: 'https://d.example' }, 5)
  S.activateTab(s, { id: c.id }, 6)
  S.activateTab(s, { id: d.id }, 7)
  S.setDesktops(s, TWO(3), 8)
  assert.equal(S.activeTab(s).id, b.id, 'the latest of desktop 1, b, was active before a')
  S.activateTab(s, { id: a.id }, 9)
  S.setDesktops(s, TWO(1), 10)
  assert.equal(S.activeTab(s).id, d.id)
  S.setDesktops(s, TWO(3), 11)
  assert.equal(S.activeTab(s).id, a.id, 'back where it was left')
  // A space with no tab on the new desktop has no active tab.
  const work = S.createSpace(s, { name: 'Work' })
  S.createTab(s, { url: 'https://w.example', spaceId: work.id }, 12)
  S.activateSpace(s, { id: work.id })
  S.setDesktops(s, TWO(1), 13)
  assert.equal(S.activeTab(s), undefined)
  assert.deepEqual(ids(S.shownTabs(s)), [c.id, d.id], 'the other space still shows its windows of this desktop')
  assert.equal(S.activeTab({ ...s, activeSpaceId: s.spaces[0].id }).id, d.id)
})

test('picking a tab from another desktop moves it to the current one', () => {
  const s = two()
  const a = S.createTab(s, { url: 'https://a.example' }, 1)
  S.setDesktops(s, TWO(1), 2)
  const b = S.createTab(s, { url: 'https://b.example' }, 3)
  assert.equal(a.desktopId, 3)
  assert.equal(S.activateTab(s, { id: a.id }, 4).desktopId, 1)
  assert.equal(S.activeTab(s).id, a.id)
  assert.deepEqual(ids(S.shownTabs(s)), [b.id, a.id])
  S.setDesktops(s, TWO(3), 5)
  assert.deepEqual(ids(S.shownTabs(s)), [])
})

test('tab cycling and closing stay within the current desktop', () => {
  const s = two()
  const a = S.createTab(s, { url: 'https://a.example' }, 1)
  S.setDesktops(s, TWO(1), 2)
  const b = S.createTab(s, { url: 'https://b.example' }, 3)
  const c = S.createTab(s, { url: 'https://c.example' }, 4)
  S.setDesktops(s, TWO(3), 5)
  const d = S.createTab(s, { url: 'https://d.example' }, 6)
  S.setDesktops(s, TWO(1), 7)
  S.activateTab(s, { id: b.id }, 8)
  assert.equal(S.cycleTab(s, { delta: 1 }, 9).id, c.id)
  assert.equal(S.cycleTab(s, { delta: 1 }, 10).id, b.id)
  assert.equal(S.selectTab(s, { index: -1 }, 11).id, c.id)
  assert.equal(S.selectTab(s, { index: 2 }, 12), null)
  S.closeTab(s, { id: c.id }, 13)
  assert.equal(S.activeTab(s).id, b.id, 'closing picks a neighbour on the same desktop')
  assert.deepEqual(ids(S.visibleTabs(s)), [a.id, b.id, d.id])
})

test('desktops that cannot be read leave Skiff as it is', () => {
  if (process.platform !== 'darwin') assert.equal(D.open({ systemPreferences: {} }), null)
  const s = two()
  S.setDesktops(s, null, 1)
  assert.equal(s.desktops, undefined)
  S.setDesktops(s, { current: 1, list: [] }, 2)
  assert.equal(s.desktops, undefined)
})

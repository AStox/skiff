'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../src/state')

const HOUR = 3600e3
const ids = (list) => list.map((x) => x.id)
const sweep = (s, now, loading) => {
  const { archived, done } = S.sweep(s, { loading }, now)
  return { archived, done }
}

test('auto-archive takes only old, non-favorite, non-active tabs in two steps', () => {
  const s = S.load()
  const fav = S.createTab(s, { url: 'fav.example' }, 0)
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  const old = S.createTab(s, { url: 'old.example' }, 0)
  const edge = S.createTab(s, { url: 'edge.example' }, 1)
  const active = S.createTab(s, { url: 'active.example' }, 1)
  for (const tab of s.tabs) tab.lastActiveAt = tab === edge ? 1 : 0

  assert.deepEqual(sweep(s, 12 * HOUR), { archived: [], done: [] })
  assert.deepEqual(sweep(s, 12 * HOUR + 1), { archived: [], done: [old.id] })
  assert.deepEqual([old.status, old.doneAt], ['done', 12 * HOUR + 1])
  assert.deepEqual(ids(s.tabs), [fav.id, old.id, edge.id, active.id])
  assert.deepEqual(sweep(s, 36 * HOUR + 1), { archived: [], done: [edge.id] })
  assert.deepEqual(sweep(s, 36 * HOUR + 2), { archived: [old.id], done: [] })
  assert.deepEqual(sweep(s, 1000 * HOUR), { archived: [edge.id], done: [] })
  assert.deepEqual(ids(s.tabs), [fav.id, active.id])
  assert.deepEqual(ids(s.archive), [edge.id, old.id])
})

test('autoArchiveHours 0 disables the sweep', () => {
  const s = S.load()
  S.createTab(s, { url: 'a.example' }, 0)
  S.createTab(s, { url: 'b.example' }, 0)
  S.setSettings(s, { autoArchiveHours: 0 })
  assert.deepEqual(sweep(s, 1000 * HOUR), { archived: [], done: [] })
  assert.equal(s.tabs.length, 2)
})

test('close then restore returns the tab to its space and activates it', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const tab = S.createTab(s, { url: 'https://example.com/a', spaceId: work.id }, 1)
  S.activateSpace(s, { id: home })
  S.closeTab(s, { id: tab.id }, 2)
  assert.equal(s.tabs.length, 0)
  assert.equal(s.activeTabBySpace[work.id], undefined)

  const back = S.restore(s, {}, 3)
  assert.deepEqual([back.id, back.spaceId, back.url], [tab.id, work.id, 'https://example.com/a'])
  assert.equal(s.activeSpaceId, work.id)
  assert.equal(s.activeTabBySpace[work.id], tab.id)
  assert.equal(s.archive.length, 0)
})

test('restore falls back to the active space when the original space is gone', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const tab = S.createTab(s, { url: 'example.com', spaceId: work.id }, 1)
  S.closeTab(s, { id: tab.id }, 2)
  S.removeSpace(s, { id: work.id }, 3)
  assert.equal(S.restore(s, { id: tab.id }, 4).spaceId, home)
  assert.equal(S.activeTab(s).id, tab.id)
})

test('removing a space archives its tabs, favorites included, and the last space is refused', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const plain = S.createTab(s, { url: 'plain.example', spaceId: work.id }, 1)
  const fav = S.createTab(s, { url: 'fav.example', spaceId: work.id }, 1)
  S.setFavorite(s, { id: fav.id, favorite: true }, 1)

  S.removeSpace(s, { id: work.id }, 2)
  assert.deepEqual(ids(s.spaces), [home])
  assert.equal(s.activeSpaceId, home)
  assert.deepEqual(ids(s.archive), [fav.id, plain.id])
  assert.equal(s.tabs.length, 0)
  assert.throws(() => S.removeSpace(s, { id: home }, 3), { code: 'bad_params' })
})

test('a favorite stays in its space across activate, unfavorite and move', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const fav = S.createTab(s, { url: 'fav.example', spaceId: work.id }, 1)
  const plain = S.createTab(s, { url: 'plain.example', spaceId: work.id }, 1)
  S.setFavorite(s, { id: fav.id, favorite: true }, 2)
  assert.deepEqual([ids(S.visibleTabs(s, work.id)), ids(S.visibleTabs(s, home))], [[fav.id, plain.id], []])

  S.activateSpace(s, { id: home })
  S.activateTab(s, { id: fav.id }, 3)
  assert.equal(s.activeSpaceId, work.id)
  S.activateSpace(s, { id: home })
  S.setFavorite(s, { id: fav.id, favorite: false }, 4)
  assert.equal(fav.spaceId, work.id)

  S.setFavorite(s, { id: fav.id, favorite: true }, 5)
  const other = S.createTab(s, { url: 'other.example', spaceId: home, activate: false }, 5)
  S.setFavorite(s, { id: other.id, favorite: true }, 5)
  S.moveTab(s, { id: fav.id, spaceId: home, index: 0 }, 6)
  assert.deepEqual([fav.spaceId, fav.favorite], [home, true])
  assert.deepEqual(ids(S.visibleTabs(s, home)), [fav.id, other.id])
  assert.deepEqual(s.activeTabBySpace, { [work.id]: plain.id })
})

test('imported favorites land in the first space of their setup, or in a normal space without one', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const item = (url) => ({ url, title: url })
  S.importSetup(s, { sessionPartition: 'persist:arc-a', favorites: [item('https://fav.example/')], spaces: [{ name: 'One', pinned: [], tabs: [] }, { name: 'Two', pinned: [], tabs: [item('https://tab.example/')] }] }, 1)
  assert.equal(s.tabs.find((t) => t.favorite).spaceId, s.spaces.find((x) => x.name === 'One').id)
  S.openIncognito(s)
  S.importSetup(s, { favorites: [item('https://loose.example/')], spaces: [] }, 2)
  assert.equal(s.tabs.find((t) => t.url === 'https://loose.example/').spaceId, home)
})

test('the incognito space is temporary: nothing in it is archived, moved across or persisted', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const kept = S.createTab(s, { url: 'kept.example' }, 0)
  const space = S.openIncognito(s)
  assert.equal(S.openIncognito(s), space)
  assert.deepEqual([s.activeSpaceId, space.incognito, space.name], [space.id, true, 'Incognito'])
  assert.match(space.sessionPartition, /^incognito-/)
  const [a, b] = ['a', 'b'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  assert.equal(a.sessionPartition, space.sessionPartition)
  S.setCollapsed(s, { folder: 'Docs', collapsed: true })
  assert.throws(() => S.moveTab(s, { id: a.id, spaceId: home }, 1), { code: 'bad_params' })
  assert.throws(() => S.moveTab(s, { id: kept.id, spaceId: space.id }, 1), { code: 'bad_params' })
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR).archived, [])
  assert.deepEqual(S.closeTab(s, { id: a.id }, 2), { closed: a.id })
  assert.equal(s.archive.length, 0)

  const saved = S.persistable(s)
  assert.deepEqual([ids(saved.spaces), ids(saved.tabs), saved.activeSpaceId, saved.activeTabBySpace, saved.collapsed], [[home], [kept.id], home, { [home]: kept.id }, {}])
  assert.deepEqual(ids(s.tabs), [kept.id, b.id])
  assert.deepEqual(ids(S.load(JSON.parse(JSON.stringify(s))).spaces), [home])

  const work = S.createSpace(s, { name: 'Work' })
  const lost = S.createTab(s, { url: 'lost.example', spaceId: work.id, activate: false }, 3)
  S.removeSpace(s, { id: work.id }, 4)
  assert.equal(s.activeSpaceId, space.id)
  assert.equal(S.restore(s, { id: lost.id }, 5).spaceId, home)
  assert.throws(() => S.removeSpace(s, { id: home }, 6), { code: 'bad_params' })
  S.removeSpace(s, { id: space.id }, 7)
  assert.deepEqual([ids(s.spaces), ids(s.tabs), s.activeSpaceId, s.archive.length], [[home], [kept.id, lost.id], home, 0])
})

test('load keeps only saved favicon paths on tabs and archive entries', () => {
  const saved = `../favicons/${'a'.repeat(24)}.png`
  const tab = (id, favicon) => ({ id, spaceId: 'home', url: `https://${id}.example/`, favicon })
  const s = S.load({
    spaces: [{ id: 'home', name: 'Home', color: '#4f6bed' }],
    tabs: [tab('ok', saved), tab('remote', 'https://remote.example/favicon.ico'), tab('data', 'data:image/png;base64,AAAA'), tab('escape', '../favicons/../state.json'), tab('none')],
    archive: [tab('old', 'https://old.example/favicon.ico'), tab('kept', saved)]
  })
  assert.deepEqual([...s.tabs, ...s.archive].map((t) => t.favicon), [saved, '', '', '', '', '', saved])
  assert.equal(S.navigateTab(s, { id: 'ok', url: 'https://ok.example/next' }, 1).favicon, saved)
  assert.equal(S.navigateTab(s, { id: 'ok', url: 'https://elsewhere.example/' }, 2).favicon, '')
})

test('a tab opened from a plain tab nests under it; favorite, pinned and foreign openers start a root', () => {
  const s = S.load()
  const work = S.createSpace(s, { name: 'Work' })
  const root = S.createTab(s, { url: 'root.example' }, 0)
  assert.equal(S.createTab(s, { url: 'child.example', parentId: root.id }, 0).parentId, root.id)
  const fav = S.createTab(s, { url: 'fav.example' }, 0)
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  const pinned = S.createTab(s, { url: 'pinned.example' }, 0)
  S.setPinned(s, { id: pinned.id, pinned: true }, 0)
  for (const parentId of [fav.id, pinned.id, 'missing', undefined]) assert.equal('parentId' in S.createTab(s, { url: 'x.example', parentId }, 0), false)
  assert.equal('parentId' in S.createTab(s, { url: 'y.example', parentId: root.id, spaceId: work.id }, 0), false)
})

test('plain tabs show in trail order, and closing a middle tab hands its children to its parent', () => {
  const s = S.load()
  const open = (name, parent) => S.createTab(s, { url: `${name}.example`, parentId: parent?.id }, 0)
  const pinned = open('pinned')
  S.setPinned(s, { id: pinned.id, pinned: true }, 0)
  const a = open('a')
  const b = open('b')
  const a1 = open('a1', a)
  const a1x = open('a1x', a1)
  const a2 = open('a2', a)
  const fav = open('fav')
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  assert.deepEqual(ids(S.visibleTabs(s)), ids([fav, pinned, a, a1, a1x, a2, b]))

  S.activateTab(s, { id: a.id }, 1)
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => S.cycleTab(s, { delta: 1 }, 2).id), ids([a1, a1x, a2, b, fav, a]))
  S.moveTab(s, { id: a2.id, index: 0 }, 3)
  assert.deepEqual(ids(S.visibleTabs(s)), ids([fav, pinned, a, a2, a1, a1x, b]))

  S.activateTab(s, { id: a1.id }, 4)
  S.closeTab(s, {}, 5)
  assert.equal(S.activeTab(s).id, a1x.id)
  assert.equal(a1x.parentId, a.id)
  S.closeTab(s, { id: a.id }, 6)
  assert.deepEqual(['parentId' in a1x, 'parentId' in a2], [false, false])
  assert.deepEqual(ids(S.visibleTabs(s)), ids([fav, pinned, b, a2, a1x]))
  assert.equal(s.archive.some((entry) => 'parentId' in entry), false)
  assert.equal('parentId' in S.restore(s, { id: a1.id }, 7), false)
})

test('pinning, favoriting or moving a tab to another space detaches it from its trail', () => {
  const s = S.load()
  const work = S.createSpace(s, { name: 'Work' })
  for (const change of [
    (tab) => S.setPinned(s, { id: tab.id, pinned: true }, 1),
    (tab) => S.setFavorite(s, { id: tab.id, favorite: true }, 1),
    (tab) => S.moveTab(s, { id: tab.id, spaceId: work.id }, 1)
  ]) {
    const root = S.createTab(s, { url: 'root.example' }, 0)
    const middle = S.createTab(s, { url: 'middle.example', parentId: root.id }, 0)
    const leaf = S.createTab(s, { url: 'leaf.example', parentId: middle.id }, 0)
    change(middle)
    assert.deepEqual(['parentId' in middle, leaf.parentId], [false, root.id])
  }
})

test('load drops a parentId that is missing, crosses spaces, names a pinned or favorite tab, or loops', () => {
  const tab = (id, fields) => ({ id, spaceId: 'home', url: `https://${id}.example/`, ...fields })
  const s = S.load({
    spaces: [{ id: 'home', name: 'Home', color: '#4f6bed' }, { id: 'work', name: 'Work', color: '#4f6bed' }],
    tabs: [
      tab('root'), tab('ok', { parentId: 'root' }), tab('orphan', { parentId: 'missing' }), tab('far', { parentId: 'root', spaceId: 'work' }),
      tab('pin', { pinned: true }), tab('underPin', { parentId: 'pin' }), tab('fav', { favorite: true, parentId: 'root' }),
      tab('x', { parentId: 'y' }), tab('y', { parentId: 'x' }), tab('self', { parentId: 'self' })
    ]
  })
  assert.deepEqual(s.tabs.filter((t) => t.parentId).map((t) => [t.id, t.parentId]), [['ok', 'root'], ['y', 'x']])
  assert.deepEqual(ids(S.visibleTabs(s, 'home')), ['fav', 'pin', 'root', 'ok', 'orphan', 'underPin', 'x', 'y', 'self'])
})

test('resolveInput turns addresses into URLs and everything else into a search', () => {
  const search = 'https://www.google.com/search?q=%s'
  assert.equal(S.resolveInput('example.com', search), 'https://example.com/')
  assert.equal(S.resolveInput('localhost:3000/x', search), 'http://localhost:3000/x')
  assert.equal(S.resolveInput('http://example.com/a?b=1', search), 'http://example.com/a?b=1')
  assert.equal(S.resolveInput('how to row a skiff', search), 'https://www.google.com/search?q=how%20to%20row%20a%20skiff')
  assert.equal(S.resolveInput('skiff', search), 'https://www.google.com/search?q=skiff')
})

test('search defaults to Google and an old saved DuckDuckGo default moves to Google once', () => {
  const ddg = 'https://duckduckgo.com/?q=%s'
  const google = 'https://www.google.com/search?q=%s'
  assert.equal(S.load().settings.searchUrl, google)
  const old = S.load({ settings: { autoArchiveHours: 12, searchUrl: ddg, shell: 'default' } })
  assert.equal(old.settings.searchUrl, google)
  assert.equal(S.load({ settings: { searchUrl: 'https://kagi.com/search?q=%s' } }).settings.searchUrl, 'https://kagi.com/search?q=%s')
})

test('a DuckDuckGo search engine chosen after the move survives restarts', () => {
  const ddg = 'https://duckduckgo.com/?q=%s'
  const s = S.load({ settings: { searchUrl: ddg } })
  S.setSettings(s, { searchUrl: ddg })
  const once = S.load(JSON.parse(JSON.stringify(s)))
  assert.equal(once.settings.searchUrl, ddg)
  assert.equal(S.load(JSON.parse(JSON.stringify(once))).settings.searchUrl, ddg)
})

test('navigation refuses anything that is not http or https', () => {
  const s = S.load()
  const tab = S.createTab(s, { url: 'example.com' }, 1)
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'about:blank']) {
    assert.throws(() => S.createTab(s, { url }, 2), { code: 'bad_params' })
    assert.throws(() => S.navigateTab(s, { id: tab.id, url }, 2), { code: 'bad_params' })
  }
  assert.equal(s.tabs.length, 1)
  assert.equal(tab.url, 'https://example.com/')
})

test('a pinned tab survives the sweep', () => {
  const s = S.load()
  const pinned = S.createTab(s, { url: 'pinned.example' }, 0)
  S.setPinned(s, { id: pinned.id, pinned: true, folder: ' Docs ' }, 0)
  const plain = S.createTab(s, { url: 'plain.example' }, 0)
  const active = S.createTab(s, { url: 'active.example' }, 0)
  assert.equal(pinned.folder, 'Docs')
  assert.deepEqual(sweep(s, 1000 * HOUR), { archived: [], done: [plain.id] })
  assert.deepEqual(sweep(s, 1025 * HOUR), { archived: [plain.id], done: [] })
  assert.deepEqual(ids(s.tabs), [pinned.id, active.id])
})

test('closing a pinned or favorite tab keeps it and shows the most recent unpinned tab', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const [recent, stale, pinned, fav] = ['recent', 'stale', 'pinned', 'fav'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  S.setPinned(s, { id: pinned.id, pinned: true }, 0)
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)

  for (const tab of [pinned, fav]) {
    S.activateTab(s, { id: tab.id }, 1)
    recent.lastActiveAt = 5
    stale.lastActiveAt = 2
    assert.deepEqual(S.closeTab(s, {}, 6), { unloaded: tab.id })
    assert.equal(s.activeTabBySpace[home], recent.id)
  }
  assert.deepEqual(ids(s.tabs), [recent.id, stale.id, pinned.id, fav.id])
  assert.equal(s.archive.length, 0)
})

test('closing the last ordinary tab never brings a favorite or pinned tab forward', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const [fav, pinned, tab] = ['fav', 'pinned', 'tab'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  S.setPinned(s, { id: pinned.id, pinned: true }, 0)
  S.activateTab(s, { id: tab.id }, 1)
  assert.deepEqual(S.closeTab(s, {}, 2), { archived: tab.id })
  assert.equal(s.activeTabBySpace[home], undefined)
})

test('moving spaces changes their order without moving tabs, sessions or the active selection', () => {
  const s = S.load()
  const home = s.spaces[0]
  const work = S.createSpace(s, { name: 'Work' })
  const reading = S.createSpace(s, { name: 'Reading' })
  work.sessionPartition = 'persist:arc-work'
  const tab = S.createTab(s, { url: 'https://example.com', spaceId: work.id }, 1)
  S.setCollapsed(s, { spaceId: work.id, folder: 'Docs', collapsed: true })
  const contents = structuredClone({ tabs: s.tabs, activeTabBySpace: s.activeTabBySpace, collapsed: s.collapsed })

  S.moveSpace(s, { id: work.id, index: 2 })
  assert.deepEqual(ids(s.spaces), [home.id, reading.id, work.id])
  assert.equal(s.activeSpaceId, work.id)
  assert.equal(S.activeTab(s).id, tab.id)
  assert.equal(s.spaces[2].sessionPartition, 'persist:arc-work')
  assert.deepEqual({ tabs: s.tabs, activeTabBySpace: s.activeTabBySpace, collapsed: s.collapsed }, contents)

  const restored = S.load(JSON.parse(JSON.stringify(s)))
  assert.deepEqual(ids(restored.spaces), [home.id, reading.id, work.id])
  S.moveSpace(restored, { id: work.id, index: 0 })
  assert.deepEqual(ids(restored.spaces), [work.id, home.id, reading.id])
  S.cycleSpace(restored, { delta: 1 })
  assert.equal(restored.activeSpaceId, home.id)
})

test('space moves clamp boundaries and reject invalid requests without mutation', () => {
  const s = S.load()
  const home = s.spaces[0]
  const work = S.createSpace(s, { name: 'Work' })
  S.moveSpace(s, { id: home.id, index: 99 })
  assert.deepEqual(ids(s.spaces), [work.id, home.id])
  S.moveSpace(s, { id: home.id, index: -1 })
  assert.deepEqual(ids(s.spaces), [home.id, work.id])
  const before = structuredClone(s)
  for (const index of [undefined, NaN, Infinity, 0.5, '1', null]) {
    assert.throws(() => S.moveSpace(s, { id: home.id, index }), { code: 'bad_params' })
    assert.deepEqual(s, before)
  }
  assert.throws(() => S.moveSpace(s, { id: 'missing', index: 0 }), { code: 'not_found' })
  assert.deepEqual(s, before)
  S.removeSpace(s, { id: work.id }, 1)
  S.moveSpace(s, { id: home.id, index: 1 })
  assert.deepEqual(ids(s.spaces), [home.id])
})

test('imported background persists, repeat import preserves edits, and color overrides survive restart', () => {
  const theme = { light: { color: '#e6f0ff', colors: ['#4b79f8', '#f7cc35'], overlayColors: ['#00000000'], intensity: .38 }, dark: { color: '#051429' } }
  const setup = { favorites: [], sessionPartition: 'persist:arc-fixture', spaces: [{ name: 'Arc space', sourceId: 'source-space', color: '#4b79f8', background: theme, pinned: [], tabs: [] }] }
  const s = S.load()
  S.importSetup(s, setup, 1)
  const space = s.spaces[1]
  assert.deepEqual(space.background, theme)
  assert.notEqual(space.background, theme)
  S.updateSpace(s, { id: space.id, name: 'My name' })
  S.importSetup(s, { ...setup, spaces: [{ ...setup.spaces[0], background: { light: { color: '#ff0000' } } }] }, 2)
  assert.deepEqual(space.background, theme)
  assert.equal(space.name, 'My name')
  assert.throws(() => S.updateSpace(s, { id: space.id, color: 'url(x)' }), { code: 'bad_params' })
  assert.deepEqual(space.background, theme)
  S.updateSpace(s, { id: space.id, color: space.color })
  assert.equal(space.background, null, 'even choosing the same accent explicitly removes the imported background')
  const restored = S.load(JSON.parse(JSON.stringify(s)))
  S.importSetup(restored, setup, 3)
  assert.equal(restored.spaces[1].background, null)
  assert.equal(restored.spaces.length, 2)
  assert.equal(restored.spaces[0].background, undefined)
})

test('old import backgrounds backfill only with matching source, partition and unchanged accent', () => {
  const theme = { light: { color: '#e6f0ff' }, dark: { color: '#001040' } }
  const source = { name: 'Arc space', sourceId: 'source-space', color: '#4b79f8', background: theme, pinned: [], tabs: [] }
  const setup = { favorites: [], sessionPartition: 'persist:arc-fixture', spaces: [source] }
  for (const change of [{}, { color: '#ff0000' }, { arcSourceId: undefined }, { background: null }, { sessionPartition: 'persist:other' }]) {
    const s = S.load()
    const old = S.createSpace(s, { name: source.name, color: source.color })
    Object.assign(old, { arcSourceId: source.sourceId, sessionPartition: setup.sessionPartition }, change)
    S.importSetup(s, setup, 1)
    assert.deepEqual(old.background, Object.keys(change).length ? change.background : theme)
  }
  const s = S.load()
  S.importSetup(s, { ...setup, spaces: [{ ...source, background: undefined }] }, 1)
  S.updateSpace(s, { id: s.spaces[1].id, name: 'Renamed before backfill' })
  S.importSetup(s, setup, 2)
  assert.deepEqual(s.spaces[1].background, theme)
})

test('invalid persisted and imported background data is discarded at the state boundary', () => {
  const valid = { color: '#112233', colors: ['#123456'], overlayColors: [], intensity: .5 }
  for (const layer of [
    { color: 'url(https://evil.example)' }, { ...valid, colors: ['#123456; color:red'] },
    { ...valid, intensity: '0.5' }, { ...valid, intensity: NaN }, { ...valid, intensity: -1 },
    { ...valid, overlayColors: ['var(--x)'] }, { ...valid, colors: Array(17).fill('#123456') }
  ]) {
    const s = S.load({ spaces: [{ id: 's1', name: 'Bad', color: '#112233', background: { light: layer } }] })
    assert.equal(s.spaces[0].background, null)
    S.importSetup(s, { favorites: [], spaces: [{ name: 'Imported', background: { light: layer }, pinned: [], tabs: [] }] }, 1)
    assert.equal(s.spaces[1].background, undefined)
  }
  const s = S.load({ spaces: [{ id: 's1', name: 'Safe', color: '#112233', background: { light: { ...valid, css: 'url(x)' }, malicious: 'url(x)' } }] })
  assert.deepEqual(s.spaces[0].background, { light: valid })
})

test('a saved shortcut map gains new defaults and keeps its overrides', () => {
  const s = S.load({ settings: { shortcuts: { 'CmdOrCtrl+W': { method: 'tabs.reload' }, 'Alt+X': { method: 'tabs.back' } } } })
  assert.deepEqual(s.settings.shortcuts['CmdOrCtrl+W'], { method: 'tabs.reload' })
  assert.deepEqual(s.settings.shortcuts['Alt+X'], { method: 'tabs.back' })
  assert.deepEqual(s.settings.shortcuts['CmdOrCtrl+Shift+C'], { method: 'tabs.copyUrl' })
})

test('global shortcuts gain the default on load, keep overrides, and are validated like shortcuts', () => {
  assert.deepEqual(S.load({}).settings.globalShortcuts['Alt+Space'], { method: 'ui.emit', params: { name: 'new-tab' } })
  const s = S.load({ settings: { globalShortcuts: { 'Alt+Space': { method: 'tabs.back' }, 'Alt+X': { method: 'tabs.forward' } } } })
  assert.deepEqual(s.settings.globalShortcuts, { 'Alt+Space': { method: 'tabs.back' }, 'Alt+X': { method: 'tabs.forward' } })
  assert.throws(() => S.setSettings(s, { globalShortcuts: { 'Alt+Y': 'tabs.back' } }), /globalShortcuts must map/)
  assert.deepEqual(s.settings.globalShortcuts['Alt+X'], { method: 'tabs.forward' })
})

test('browser identity defaults to compatible and loads only supported persistent overrides', () => {
  assert.deepEqual(S.load().settings.browserIdentity, {})
  for (const value of [null, 'native', [], 1]) assert.deepEqual(S.load({ settings: { browserIdentity: value } }).settings.browserIdentity, {})
  assert.deepEqual(S.load({ settings: { browserIdentity: {
    'persist:main': 'native', 'persist:arc-work': 'compatible', 'persist:': 'native',
    'incognito-private': 'native', 'persist:bad/name': 'native', 'persist:bad\n': 'native', 'persist:unsupported': 'chrome'
  } } }).settings.browserIdentity, { 'persist:main': 'native', 'persist:arc-work': 'compatible' })
})

test('browser identity settings merge atomically, preserve the startup map and survive persistence', () => {
  const s = S.load()
  const initial = s.settings.browserIdentity
  S.setSettings(s, { browserIdentity: { 'persist:arc-work': 'native' } })
  const startup = s.settings.browserIdentity
  S.setSettings(s, { browserIdentity: { 'persist:main': 'native' } })
  S.setSettings(s, { browserIdentity: { 'persist:arc-work': 'compatible' } })
  assert.deepEqual(initial, {})
  assert.deepEqual(startup, { 'persist:arc-work': 'native' })
  assert.deepEqual(s.settings.browserIdentity, { 'persist:arc-work': 'compatible', 'persist:main': 'native' })
  const saved = structuredClone(S.persistable(s))
  const loaded = S.load(JSON.parse(JSON.stringify(saved)))
  assert.deepEqual(loaded.settings.browserIdentity, s.settings.browserIdentity)
  for (const value of [null, [], 'native', { main: 'native' }, { 'persist:': 'native' }, { 'incognito-private': 'native' },
    { 'persist:bad/name': 'native' }, { 'persist:bad\n': 'native' }, { 'persist:main': true }, { 'persist:main': 'chrome' },
    { 'persist:main': 'compatible', 'persist:other': null }]) {
    assert.throws(() => S.setSettings(s, { autoArchiveHours: 99, browserIdentity: value }), { code: 'bad_params' })
    assert.deepEqual(S.persistable(s), saved)
  }
})

test('browser identity settings do not create profiles or change moved and restored tab ownership', () => {
  const s = S.load()
  const home = s.spaces[0]
  S.importSetup(s, { sessionPartition: 'persist:arc-work', favorites: [], spaces: [{ name: 'Work', pinned: [], tabs: [{ url: 'https://work.example/', title: 'Work' }] }] }, 1)
  const tab = s.tabs[0]
  const spaces = s.spaces.map((space) => ({ ...space }))
  S.setSettings(s, { browserIdentity: { 'persist:arc-work': 'native', 'persist:unused': 'native' } })
  assert.deepEqual(s.spaces, spaces)
  S.moveTab(s, { id: tab.id, spaceId: home.id }, 2)
  S.closeTab(s, { id: tab.id }, 3)
  assert.equal(s.archive[0].sessionPartition, 'persist:main')
  S.restore(s, { id: tab.id }, 4)
  const loaded = S.load(JSON.parse(JSON.stringify(S.persistable(s))))
  assert.equal(loaded.tabs[0].sessionPartition, 'persist:main')
  assert.equal(loaded.tabs[0].spaceId, home.id)
  assert.equal(loaded.settings.browserIdentity['persist:arc-work'], 'native')
  assert.equal(S.createTab(loaded, { url: 'https://home.example/', spaceId: home.id }, 5).sessionPartition, 'persist:main')
})

test('WhatsApp tabs use an exact-host compatible override and migrate saved URLs', () => {
  const s = S.load()
  const home = s.spaces[0].id
  const whatsapp = S.createTab(s, { url: 'https://web.whatsapp.com/' }, 1)
  assert.equal(whatsapp.browserIdentity, 'compatible')
  const lookalikes = [
    'https://web.whatsapp.com.example.org/',
    'https://www.web.whatsapp.com/',
    'https://example.org/?site=web.whatsapp.com'
  ].map((url, index) => S.createTab(s, { url, spaceId: home, activate: false }, index + 2))
  assert.ok(lookalikes.every((tab) => !Object.hasOwn(tab, 'browserIdentity')))

  const saved = structuredClone(S.persistable(s))
  delete saved.tabs.find((tab) => tab.id === whatsapp.id).browserIdentity
  const loaded = S.load(saved)
  assert.equal(loaded.tabs.find((tab) => tab.id === whatsapp.id).browserIdentity, 'compatible')
  assert.equal(JSON.parse(JSON.stringify(S.persistable(loaded))).tabs.find((tab) => tab.id === whatsapp.id).browserIdentity, 'compatible')
})

test('explicit tab identity stays through navigation, archive, restore and reset', () => {
  const s = S.load()
  const tab = S.createTab(s, { url: 'https://www.google.com/' }, 1)
  assert.equal(Object.hasOwn(tab, 'browserIdentity'), false)
  S.navigateTab(s, { id: tab.id, url: 'https://web.whatsapp.com/', browserIdentity: 'compatible' }, 2)
  assert.equal(tab.browserIdentity, 'compatible')
  S.navigateTab(s, { id: tab.id, url: 'https://example.org/elsewhere' }, 3)
  assert.equal(tab.browserIdentity, 'compatible')

  S.closeTab(s, { id: tab.id }, 4)
  assert.equal(s.archive[0].browserIdentity, 'compatible')
  const restored = S.restore(s, { id: tab.id }, 5)
  assert.equal(restored.browserIdentity, 'compatible')
  const loaded = S.load(JSON.parse(JSON.stringify(S.persistable(s))))
  assert.equal(loaded.tabs.find((item) => item.id === tab.id).browserIdentity, 'compatible')

  S.navigateTab(loaded, { id: tab.id, url: 'https://web.whatsapp.com/', browserIdentity: null }, 6)
  assert.equal(loaded.tabs.find((item) => item.id === tab.id).browserIdentity, null)
  const reset = S.load(JSON.parse(JSON.stringify(S.persistable(loaded))))
  assert.equal(reset.tabs.find((item) => item.id === tab.id).browserIdentity, null)
  assert.throws(() => S.navigateTab(loaded, { id: tab.id, url: 'https://invalid.example/', browserIdentity: 'other' }, 7), { code: 'bad_params' })
  assert.equal(loaded.tabs.find((item) => item.id === tab.id).url, 'https://web.whatsapp.com/')
})

test('agent settings default to none, migrate the old single command and the old Cmd+J', () => {
  const s = S.load()
  assert.deepEqual(s.settings.ai, { agents: [], agent: '', model: '', effort: '' })
  assert.deepEqual(s.settings.shortcuts['CmdOrCtrl+J'], { method: 'ui.emit', params: { name: 'ask-agent' } })
  assert.deepEqual(S.load({ settings: { ai: { command: '  /opt/bin/omp acp  ' } } }).settings.ai, { agents: [{ name: 'omp', command: '/opt/bin/omp acp' }], agent: 'omp', model: '', effort: '' })
  assert.deepEqual(S.load({ settings: { ai: { command: "'/usr/bin/gemini' --acp" } } }).settings.ai.agents[0].name, 'gemini')
  assert.deepEqual(S.load({ settings: { ai: { command: '  ' } } }).settings.ai, { agents: [], agent: '', model: '', effort: '' })
  for (const ai of ['broken', { agents: 'x' }, { agents: [{ name: 'a', command: 'b' }], agent: 'z' }]) assert.deepEqual(S.load({ settings: { ai } }).settings.ai, { agents: [], agent: '', model: '', effort: '' })
  const kept = { agents: [{ name: 'omp', command: 'omp acp' }], agent: 'omp', model: 'm', effort: 'high' }
  assert.deepEqual(S.load({ settings: { ai: kept } }).settings.ai, kept)
  const old = { 'CmdOrCtrl+J': { method: 'ui.emit', params: { name: 'toggle-ai' } } }
  assert.deepEqual(S.load({ settings: { shortcuts: old } }).settings.shortcuts['CmdOrCtrl+J'], { method: 'ui.emit', params: { name: 'ask-agent' } })
  const mine = { 'CmdOrCtrl+J': { method: 'tabs.reload' } }
  assert.deepEqual(S.load({ settings: { shortcuts: mine } }).settings.shortcuts['CmdOrCtrl+J'], { method: 'tabs.reload' })
})

test('agent settings are validated, trimmed and merged into the current ones', () => {
  const s = S.load()
  S.setSettings(s, { ai: { agents: [{ name: ' omp ', command: '  omp acp  ', extra: 1 }, { name: 'Gemini', command: 'gemini --acp' }] } })
  assert.deepEqual(s.settings.ai, { agents: [{ name: 'omp', command: 'omp acp' }, { name: 'Gemini', command: 'gemini --acp' }], agent: 'omp', model: '', effort: '' })
  S.setSettings(s, { ai: { model: 'fake-large' } })
  S.setSettings(s, { ai: { agent: 'Gemini', effort: 'high' } })
  assert.deepEqual({ ...s.settings.ai, agents: s.settings.ai.agents.length }, { agents: 2, agent: 'Gemini', model: 'fake-large', effort: 'high' })
  S.setSettings(s, { ai: { agents: [{ name: 'omp', command: 'omp acp' }] } })
  assert.equal(s.settings.ai.agent, 'omp')
  const agent = (name, command = 'x') => ({ name, command })
  for (const ai of [
    null, 'omp acp', { agents: 'x' }, { agents: Array.from({ length: 11 }, (_, i) => agent(`a${i}`)) },
    { agents: [agent('')] }, { agents: [agent('n'.repeat(41))] }, { agents: [agent('a', '  ')] }, { agents: [agent('a', 'c'.repeat(501))] },
    { agents: [agent('Omp'), agent('omp')] }, { agent: 'nobody' }, { model: 3 }, { effort: 'e'.repeat(201) }
  ]) assert.throws(() => S.setSettings(s, { ai }), { code: 'bad_params' })
  assert.deepEqual(s.settings.ai, { agents: [{ name: 'omp', command: 'omp acp' }], agent: 'omp', model: 'fake-large', effort: 'high' })
  S.setSettings(s, { ai: { agents: Array.from({ length: 10 }, (_, i) => agent(`a${i}`, 'c'.repeat(500))), agent: '' } })
  assert.equal(s.settings.ai.agents.length, 10)
  assert.equal(s.settings.ai.agent, '')
})

test('chat tabs load only with a valid chat, keep it through the archive and become web tabs when navigated', () => {
  const s = S.load()
  const page = S.createTab(s, { url: 'https://a.example/' }, 0)
  const chat = S.createTab(s, { parentId: page.id }, 1, { id: 'c0123456789ab', agent: 'omp', title: 'Hello', favicon: '../favicons/0123456789abcdef01234567.svg' })
  assert.deepEqual({ url: chat.url, title: chat.title, chat: chat.chat, parentId: chat.parentId, active: S.activeTab(s) === chat }, { url: 'skiff://chat/c0123456789ab', title: 'Hello', chat: { agent: 'omp', sessionId: null }, parentId: page.id, active: true })
  chat.chat.sessionId = 'sess-1'
  const spaceId = s.spaces[0].id
  const tab = (id, url, extra) => ({ id, spaceId, url, title: id, favicon: '', ...extra })
  const loaded = S.load({ ...S.persistable(s), tabs: [
    ...S.persistable(s).tabs,
    tab('t1', 'skiff://chat/c0123456789aa'),
    tab('t2', 'skiff://chat/nothex', { chat: { agent: '', sessionId: null } }),
    tab('t3', 'skiff://chat/c0123456789ac', { chat: { agent: 3, sessionId: null } }),
    tab('t4', 'skiff://settings', { chat: { agent: '', sessionId: null } }),
    tab('t5', 'https://b.example/', { chat: { agent: '', sessionId: null } })
  ] })
  assert.deepEqual(loaded.tabs.map((t) => [t.title, t.chat]), [['https://a.example/', undefined], ['Hello', { agent: 'omp', sessionId: 'sess-1' }], ['t5', undefined]])
  assert.equal(loaded.tabs[1].favicon, '../favicons/0123456789abcdef01234567.svg')

  S.closeTab(loaded, { id: chat.id }, 2)
  assert.deepEqual(loaded.archive[0].chat, { agent: 'omp', sessionId: 'sess-1' })
  const again = S.load({ ...S.persistable(loaded), archive: [...loaded.archive, { id: 'x', spaceId, url: 'skiff://chat/c0123456789ad', title: 'Lost' }] })
  assert.deepEqual(again.archive.map((a) => a.title), ['Hello'])
  const back = S.restore(again, {}, 3)
  assert.deepEqual([back.url, back.chat], ['skiff://chat/c0123456789ab', { agent: 'omp', sessionId: 'sess-1' }])
  const web = S.navigateTab(again, { id: back.id, url: 'b.example' }, 4)
  assert.deepEqual([web.url, web.chat, web.title, web.favicon], ['https://b.example/', undefined, 'https://b.example/', ''])
  assert.throws(() => S.createTab(again, { url: 'skiff://chat/c0123456789ab' }, 5), { code: 'bad_params' })
})

test('selectTab shows a tab by its place in Ctrl+Tab order', () => {
  const s = S.load()
  const open = (name) => S.createTab(s, { url: `${name}.example` }, 0)
  const pinned = open('pinned')
  S.setPinned(s, { id: pinned.id, pinned: true }, 0)
  const a = open('a')
  const b = open('b')
  const fav = open('fav')
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  assert.equal(S.selectTab(s, { index: 0 }, 1).id, fav.id)
  assert.equal(S.selectTab(s, { index: 1 }, 1).id, a.id)
  assert.equal(S.selectTab(s, { index: -1 }, 1).id, b.id)
  assert.equal(S.selectTab(s, { index: 3 }, 2), null)
  assert.equal(S.activeTab(s).id, b.id)
  for (const index of [undefined, 1.5, '1']) assert.throws(() => S.selectTab(s, { index }, 3), { code: 'bad_params' })
})

test('desk.place validates the rect, keeps it and brings the tab to the front of its space', () => {
  const s = S.load()
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 1)
  for (const bad of [{ x: 0, y: 0, width: 239, height: 160 }, { x: 0, y: 0, width: 240, height: 159 }, { x: NaN, y: 0, width: 300, height: 200 }, { x: 0, y: '1', width: 300, height: 200 }, { x: 0, y: 0, width: Infinity, height: 200 }]) {
    assert.throws(() => S.placeDesk(s, { id: a.id, ...bad }), { code: 'bad_params' })
  }
  assert.equal(a.desk, undefined)
  assert.throws(() => S.placeDesk(s, { id: 'nope', x: 0, y: 0, width: 300, height: 200 }), { code: 'not_found' })

  S.placeDesk(s, { id: a.id, x: -20, y: 10.5, width: 240, height: 160 })
  assert.deepEqual(a.desk, { x: -20, y: 10.5, width: 240, height: 160, z: 1 })
  S.placeDesk(s, { x: 100, y: 100, width: 600, height: 400 })
  assert.deepEqual(b.desk, { x: 100, y: 100, width: 600, height: 400, z: 2 })
  assert.deepEqual(ids(S.deskTabs(s)), [a.id, b.id])
  S.placeDesk(s, { id: a.id, x: 0, y: 0, width: 300, height: 200 })
  assert.deepEqual(ids(S.deskTabs(s)), [b.id, a.id])
  assert.equal(a.desk.z, 3)
  // Moving the frontmost tab again keeps it in front without growing z.
  S.placeDesk(s, { id: a.id, x: 5, y: 5, width: 300, height: 200 })
  assert.equal(a.desk.z, 3)
})

test('activating a desk tab brings it to the front; z is counted per space', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const rect = { x: 0, y: 0, width: 300, height: 200 }
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 1)
  const c = S.createTab(s, { url: 'c.example' }, 1)
  const w = S.createTab(s, { url: 'w.example', spaceId: work.id, activate: false }, 1)
  for (const tab of [a, b, c]) S.placeDesk(s, { id: tab.id, ...rect })
  S.placeDesk(s, { id: w.id, ...rect })
  assert.equal(w.desk.z, 1)
  S.activateTab(s, { id: a.id }, 2)
  assert.deepEqual(ids(S.deskTabs(s, home)), [b.id, c.id, a.id])
  S.cycleTab(s, { delta: 1 }, 3)
  assert.deepEqual(ids(S.deskTabs(s, home)), [c.id, a.id, b.id])
  S.selectTab(s, { index: 2 }, 4)
  assert.deepEqual(ids(S.deskTabs(s, home)), [a.id, b.id, c.id])
  const plain = S.createTab(s, { url: 'plain.example' }, 5)
  assert.equal(plain.desk, undefined)
  assert.deepEqual(ids(S.deskTabs(s, home)), [a.id, b.id, c.id])
  S.activateTab(s, { id: w.id }, 6)
  assert.equal(w.desk.z, 1)
  assert.equal(s.activeSpaceId, work.id)
})

test('every ordinary tab is a window; favorites and pinned tabs only while active or once activated on a desk', () => {
  const s = S.load()
  const rect = { x: 0, y: 0, width: 300, height: 200 }
  const fav = S.createTab(s, { url: 'fav.example', activate: false }, 1)
  S.setFavorite(s, { id: fav.id, favorite: true }, 1)
  const pin = S.createTab(s, { url: 'pin.example', activate: false }, 1)
  S.setPinned(s, { id: pin.id, pinned: true }, 1)
  const a = S.createTab(s, { url: 'a.example', activate: false }, 1)
  const b = S.createTab(s, { url: 'b.example', activate: false }, 1)
  const c = S.createTab(s, { url: 'c.example', activate: false }, 1)
  assert.deepEqual(ids(S.shownTabs(s)), [a.id, b.id, c.id])
  // Placed tabs stack above unplaced ones by z; the active tab is in front of all.
  S.placeDesk(s, { id: a.id, ...rect })
  assert.deepEqual(ids(S.shownTabs(s)), [b.id, c.id, a.id])
  S.activateTab(s, { id: b.id }, 2)
  assert.deepEqual(ids(S.shownTabs(s)), [c.id, a.id, b.id])
  assert.equal(b.desk, undefined)
  // Outside a desk window an active favorite is shown but gets no window of its own.
  S.activateTab(s, { id: fav.id }, 3)
  assert.equal(fav.desk, undefined)
  assert.deepEqual(ids(S.shownTabs(s)), [b.id, c.id, a.id, fav.id])
  S.activateTab(s, { id: b.id }, 4)
  assert.deepEqual(ids(S.shownTabs(s)), [c.id, a.id, b.id])
  s.deskSize = { width: 1000, height: 800 }
  S.activateTab(s, { id: pin.id }, 5)
  assert.deepEqual(pin.desk, { ...S.defaultDesk(s, pin), z: 2 })
  S.activateTab(s, { id: b.id }, 6)
  assert.deepEqual(ids(S.shownTabs(s)), [c.id, a.id, pin.id, b.id])
  assert.deepEqual(ids(S.shownTabs(s, 'other')), [])
})

test('desk.hide keeps the tab, takes the default rect, and passes the active tab to the frontmost shown one', () => {
  const s = S.load()
  const rect = { x: 0, y: 0, width: 300, height: 200 }
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 1)
  const c = S.createTab(s, { url: 'c.example' }, 1)
  s.deskSize = { width: 1000, height: 800 }
  S.placeDesk(s, { id: a.id, ...rect })
  S.activateTab(s, { id: b.id }, 2)

  S.hideDesk(s, { id: c.id })
  assert.deepEqual(c.desk, { ...S.defaultDesk(s, c), z: 0, hidden: true })
  assert.equal(S.activeTab(s).id, b.id)
  assert.deepEqual(ids(S.shownTabs(s)), [a.id, b.id])
  assert.deepEqual(ids(S.visibleTabs(s)), [a.id, b.id, c.id])

  // Hiding the active tab activates the frontmost shown tab left: placed above unplaced.
  S.hideDesk(s, {})
  assert.equal(b.desk.hidden, true)
  assert.equal(S.activeTab(s).id, a.id)
  S.placeDesk(s, { id: a.id, x: 5, y: 5, width: 300, height: 200 })
  S.hideDesk(s, {})
  assert.deepEqual(a.desk, { x: 5, y: 5, width: 300, height: 200, z: 1, hidden: true })
  assert.equal(S.activeTab(s), undefined)
  assert.deepEqual(S.shownTabs(s), [])
  assert.equal(s.tabs.length, 3)
  assert.throws(() => S.hideDesk(s, {}), { code: 'not_found' })
  assert.throws(() => S.hideDesk(s, { id: 'nope' }), { code: 'not_found' })

  // Placing a hidden tab shows it again.
  S.placeDesk(s, { id: a.id, ...rect })
  assert.equal(a.desk.hidden, undefined)
  assert.deepEqual(ids(S.shownTabs(s)), [a.id])
})

test('desk.show and activating a tab clear hidden and bring it to the front', () => {
  const s = S.load()
  const rect = { x: 0, y: 0, width: 300, height: 200 }
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 1)
  const c = S.createTab(s, { url: 'c.example' }, 1)
  for (const tab of [a, b, c]) S.placeDesk(s, { id: tab.id, ...rect })
  S.hideDesk(s, { id: a.id })
  S.hideDesk(s, { id: b.id })
  assert.deepEqual(ids(S.shownTabs(s)), [c.id])

  assert.equal(S.showDesk(s, { id: a.id }, 2), a)
  assert.equal(a.desk.hidden, undefined)
  assert.equal(a.desk.z, 4)
  assert.equal(S.activeTab(s).id, a.id)
  assert.deepEqual(ids(S.shownTabs(s)), [c.id, a.id])

  S.activateTab(s, { id: b.id }, 3)
  assert.equal(b.desk.hidden, undefined)
  assert.equal(b.desk.z, 5)
  assert.deepEqual(ids(S.shownTabs(s)), [c.id, a.id, b.id])
  assert.throws(() => S.showDesk(s, {}, 4), { code: 'bad_params' })
  assert.throws(() => S.showDesk(s, { id: 'nope' }, 4), { code: 'not_found' })
})

test('closing a favorite on the desk hides its window', () => {
  const s = S.load()
  s.deskSize = { width: 1000, height: 800 }
  const fav = S.createTab(s, { url: 'fav.example', activate: false }, 1)
  S.setFavorite(s, { id: fav.id, favorite: true }, 1)
  const a = S.createTab(s, { url: 'a.example', activate: false }, 1)
  S.activateTab(s, { id: fav.id }, 2)
  assert.deepEqual(ids(S.shownTabs(s)), [a.id, fav.id])
  assert.deepEqual(S.closeTab(s, {}, 3), { unloaded: fav.id })
  assert.equal(fav.desk.hidden, true)
  assert.deepEqual(ids(S.shownTabs(s)), [a.id])
})

test('the default desk rect is centred and cascades by tab order, wrapping inside the desk', () => {
  const s = S.load()
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 1)
  const c = S.createTab(s, { url: 'c.example' }, 1)
  // Without a desk window the app window's size stands in.
  assert.deepEqual(S.defaultDesk(s, a), S.defaultDesk({ ...s, deskSize: { width: 1280, height: 800 } }, a))
  s.deskSize = { width: 1000, height: 800 }
  assert.deepEqual(S.defaultDesk(s, a), { x: 190, y: 104, width: 620, height: 592 })
  assert.deepEqual(S.defaultDesk(s, b), { x: 218, y: 132, width: 620, height: 592 })
  // Placing another tab does not move an unplaced one.
  S.placeDesk(s, { id: a.id, x: 0, y: 0, width: 300, height: 200 })
  assert.deepEqual(S.defaultDesk(s, c), { x: 246, y: 160, width: 620, height: 592 })
  for (let i = 0; i < 3; i++) S.createTab(s, { url: `more${i}.example` }, 1)
  // 104px of room below the centred rect holds offsets 0 to 3, so the fifth tab starts over.
  assert.deepEqual(S.defaultDesk(s, s.tabs[4]), S.defaultDesk(s, a))
  s.deskSize = { width: 300, height: 200 }
  assert.deepEqual(S.defaultDesk(s, b), { x: 30, y: 20, width: 240, height: 160 })
})

test('load keeps valid desk rects and hidden flags and drops invalid ones', () => {
  const tab = (id, desk) => ({ id, spaceId: 's1', url: `https://${id}.example/`, desk })
  const s = S.load({
    spaces: [{ id: 's1', name: 'Home', color: '#4f6bed' }],
    tabs: [
      tab('ok', { x: -5, y: 0, width: 240, height: 160, z: 3, extra: 'gone' }),
      tab('hidden', { x: 0, y: 0, width: 600, height: 400, z: 2, hidden: true }),
      tab('shown', { x: 0, y: 0, width: 600, height: 400, z: 2, hidden: 'yes' }),
      tab('narrow', { x: 0, y: 0, width: 239, height: 600, z: 1 }),
      tab('short', { x: 0, y: 0, width: 600, height: 159.9, z: 1 }),
      tab('noz', { x: 0, y: 0, width: 600, height: 400 }),
      tab('text', { x: '0', y: 0, width: 600, height: 400, z: 1 }),
      tab('null', null),
      tab('list', [0, 0, 600, 400, 1]),
      tab('none', undefined)
    ]
  })
  assert.deepEqual(s.tabs.map((t) => [t.id, t.desk]), [
    ['ok', { x: -5, y: 0, width: 240, height: 160, z: 3 }],
    ['hidden', { x: 0, y: 0, width: 600, height: 400, z: 2, hidden: true }],
    ['shown', { x: 0, y: 0, width: 600, height: 400, z: 2 }],
    ...['narrow', 'short', 'noz', 'text', 'null', 'list', 'none'].map((id) => [id, undefined])
  ])
  s.deskSize = { width: 1000, height: 800 }
  const saved = JSON.parse(JSON.stringify(S.persistable(s)))
  assert.equal(saved.tabs[0].desk.z, 3)
  assert.equal(saved.tabs[1].desk.hidden, true)
  assert.equal(saved.deskSize, undefined)
})

const onDesk = (raw) => Object.assign(S.load(raw), { deskSize: { width: 1000, height: 800 }, deskTop: 30 })

test('desk layouts keep an 8px margin and gap and the frame top free, and desk.tile places a tab there', () => {
  const s = onDesk()
  const layouts = S.deskLayouts(s)
  assert.deepEqual(layouts, {
    fill: { x: 8, y: 38, width: 984, height: 754 },
    center: { x: 200, y: 115, width: 600, height: 600 },
    left: { x: 8, y: 38, width: 488, height: 754 },
    right: { x: 504, y: 38, width: 488, height: 754 },
    top: { x: 8, y: 38, width: 984, height: 358 },
    bottom: { x: 8, y: 434, width: 984, height: 358 },
    'left-third': { x: 8, y: 38, width: 323, height: 754 },
    'center-third': { x: 339, y: 38, width: 322, height: 754 },
    'right-third': { x: 669, y: 38, width: 323, height: 754 },
    'left-two-thirds': { x: 8, y: 38, width: 653, height: 754 },
    'right-two-thirds': { x: 339, y: 38, width: 653, height: 754 },
    'top-left': { x: 8, y: 38, width: 488, height: 358 },
    'top-right': { x: 504, y: 38, width: 488, height: 358 },
    'bottom-left': { x: 8, y: 434, width: 488, height: 358 },
    'bottom-right': { x: 504, y: 434, width: 488, height: 358 }
  })
  // The lower window's frame top fits in the gap under the upper one.
  assert.equal(layouts.bottom.y - (layouts.top.y + layouts.top.height), 30 + 8)
  const a = S.createTab(s, { url: 'https://a.example/' }, 1)
  const b = S.createTab(s, { url: 'https://b.example/' }, 1)
  assert.equal(S.tileDesk(s, { id: a.id, layout: 'right' }), a)
  assert.deepEqual(a.desk, { ...layouts.right, z: 3 })
  S.tileDesk(s, { layout: 'top-left' })
  assert.deepEqual(b.desk, { ...layouts['top-left'], z: 4 })
  S.hideDesk(s, { id: a.id })
  S.tileDesk(s, { id: a.id, layout: 'fill' })
  assert.deepEqual(a.desk, { ...layouts.fill, z: 5 })
  assert.throws(() => S.tileDesk(s, { layout: 'middle' }), { code: 'bad_params' })
  assert.throws(() => S.tileDesk(s, { layout: 'toString' }), { code: 'bad_params' })
  assert.throws(() => S.tileDesk(s, {}), { code: 'bad_params' })
  assert.throws(() => S.tileDesk(s, { id: 'nope', layout: 'fill' }), { code: 'not_found' })
  // Without a frame nothing is kept free above; without a desk window there are no layouts.
  delete s.deskTop
  assert.deepEqual(S.deskLayouts(s).fill, { x: 8, y: 8, width: 984, height: 784 })
  delete s.deskSize
  assert.throws(() => S.deskLayouts(s), { code: 'not_found' })
  assert.throws(() => S.tileDesk(s, { layout: 'fill' }), { code: 'not_found' })
})

test('a new desk window goes to the largest free part of the desk, else to the cascade', () => {
  const s = onDesk()
  const layouts = S.deskLayouts(s)
  // An empty desk: all of it, less the margin and the frame top.
  const a = S.createTab(s, { url: 'https://a.example/' }, 1)
  assert.deepEqual(a.desk, { ...layouts.fill, z: 1 })
  // The free right two thirds, past the left window and its frame.
  S.tileDesk(s, { id: a.id, layout: 'left-third' })
  const b = S.createTab(s, { url: 'https://b.example/', activate: false }, 1)
  assert.deepEqual(b.desk, { ...layouts['right-two-thirds'], z: 1 })
  assert.equal(S.activeTab(s), a)
  assert.ok(a.desk.z > b.desk.z, 'a background window opens beneath the active one')
  // A frame's top inset counts as taken: under a window at the top only 362px are left, less than 360 once the margin is off, so the cascade.
  S.placeDesk(s, { id: b.id, x: 0, y: 30, width: 1000, height: 408 })
  const c = S.createTab(s, { url: 'https://c.example/' }, 1)
  assert.deepEqual(c.desk, { ...S.defaultDesk(s, c), z: 4 })
  // A free gap of exactly 520 by 360 after the margin is enough; one pixel less is not.
  const fits = (width, height) => {
    const t = onDesk()
    const left = S.createTab(t, { url: 'https://l.example/' }, 1)
    S.placeDesk(t, { id: left.id, x: 0, y: 30, width: 1000 - width - 16, height: 770 })
    const top = S.createTab(t, { url: 'https://t.example/' }, 1)
    S.placeDesk(t, { id: top.id, x: 1000 - width - 16, y: 30, width: width + 16, height: 800 - height - 16 - 30 })
    const n = S.createTab(t, { url: 'https://n.example/' }, 1)
    return [n.desk, { ...S.defaultDesk(t, n), z: 3 }]
  }
  assert.deepEqual(fits(520, 360)[0], { x: 1000 - 520 - 8, y: 800 - 360 - 8 + 30, width: 520, height: 330, z: 3 })
  for (const [desk, cascade] of [fits(519, 360), fits(520, 359)]) assert.deepEqual(desk, cascade)
  // Hidden windows take no room, and outside a desk window new tabs get no rect.
  const t = onDesk()
  const hidden = S.createTab(t, { url: 'https://h.example/' }, 1)
  S.hideDesk(t, { id: hidden.id })
  assert.deepEqual(S.createTab(t, { url: 'https://n.example/' }, 1).desk, { ...layouts.fill, z: 2 })
  delete t.deskSize
  assert.equal(S.createTab(t, { url: 'https://o.example/' }, 1).desk, undefined)
})

test('a new desk window keeps clear of the open Buoy card', () => {
  const s = onDesk()
  const touches = (r, c) => r.x < c.x + c.width && c.x < r.x + r.width && r.y < c.y + c.height && c.y < r.y + r.height
  // 1000 by 800 desk with the card in the middle: the cascade would sit under it.
  const card = { x: 220, y: 240, width: 560, height: 320 }
  s.deskAvoid = card
  const a = S.createTab(s, { url: 'https://a.example/' }, 1)
  assert.equal(touches(a.desk, card), false)
  assert.ok(a.desk.width >= 240 && a.desk.height >= 160)
  assert.ok(a.desk.x >= 0 && a.desk.y >= 0 && a.desk.x + a.desk.width <= 1000 && a.desk.y + a.desk.height <= 800)
  // A host's remembered rect under the card is not reused.
  s.deskHosts['b.example'] = { x: 300, y: 300, width: 400, height: 300 }
  const b = S.createTab(s, { url: 'https://b.example/' }, 1)
  assert.equal(touches(b.desk, card), false)
  // A free rect elsewhere is still taken as is.
  s.deskHosts['c.example'] = { x: 20, y: 100, width: 150, height: 300 }
  s.deskHosts['d.example'] = { x: 800, y: 60, width: 190, height: 200 }
  assert.deepEqual(S.createTab(s, { url: 'https://d.example/' }, 1).desk, { x: 800, y: 60, width: 190, height: 200, z: 3 })
  // Without a card, the cascade as before; no card either once the state has none.
  delete s.deskAvoid
  const e = S.createTab(onDesk(), { url: 'https://e.example/' }, 1)
  assert.deepEqual(e.desk, { ...S.deskLayouts(onDesk()).fill, z: 1 })
  assert.equal('deskAvoid' in S.persistable({ ...s, deskAvoid: card }), false)
})

test('a new desk window of a host takes the last rect used for it, 28px down and right while that one is showing', () => {
  const s = onDesk()
  const a = S.createTab(s, { url: 'https://reddit.com/r/one' }, 1)
  const rect = { x: 100, y: 120, width: 600, height: 500 }
  S.placeDesk(s, { id: a.id, ...rect })
  assert.deepEqual(s.deskHosts, { 'reddit.com': rect })
  const b = S.createTab(s, { url: 'https://reddit.com/r/two' }, 1)
  assert.deepEqual(b.desk, { x: 128, y: 148, width: 600, height: 500, z: 2 })
  const c = S.createTab(s, { url: 'reddit.com/r/three' }, 1)
  assert.deepEqual(c.desk, { x: 156, y: 176, width: 600, height: 500, z: 3 })
  // Hidden, the remembered rect is free again; a tile is remembered too.
  S.hideDesk(s, { id: a.id })
  assert.deepEqual(S.createTab(s, { url: 'https://reddit.com/' }, 1).desk, { ...rect, z: 4 })
  S.tileDesk(s, { id: b.id, layout: 'left' })
  assert.deepEqual(s.deskHosts['reddit.com'], S.deskLayouts(s).left)
  // A full-height rect steps down by giving up what would leave the desk.
  assert.deepEqual(S.createTab(s, { url: 'https://reddit.com/x' }, 1).desk, { x: 36, y: 66, width: 488, height: 734, z: 6 })
  // A remembered rect larger than the desk now is pulled onto it.
  s.deskHosts['big.example'] = { x: 900, y: 700, width: 1200, height: 900 }
  assert.deepEqual(S.createTab(s, { url: 'https://big.example/' }, 1).desk, { x: 0, y: 0, width: 1000, height: 800, z: 7 })
  // A reopened tab is placed the same way.
  const closed = S.createTab(s, { url: 'https://news.example/' }, 1)
  S.placeDesk(s, { id: closed.id, x: 10, y: 40, width: 500, height: 400 })
  S.closeTab(s, { id: closed.id }, 2)
  assert.deepEqual(S.restore(s, {}, 3).desk, { x: 10, y: 40, width: 500, height: 400, z: 8 })
})

test('host memory is saved, keeps the 200 most recently placed hosts, and skips incognito tabs', () => {
  const s = onDesk()
  const tab = S.createTab(s, { url: 'https://first.example/' }, 1)
  const rect = (i) => ({ x: i, y: 40, width: 300, height: 200 })
  for (let i = 0; i < 200; i++) {
    S.navigateTab(s, { id: tab.id, url: `https://h${i}.example/` }, 1)
    S.placeDesk(s, { id: tab.id, ...rect(i) })
  }
  S.navigateTab(s, { id: tab.id, url: 'https://h0.example/' }, 1)
  S.placeDesk(s, { id: tab.id, ...rect(500) })
  S.navigateTab(s, { id: tab.id, url: 'https://h200.example/' }, 1)
  S.placeDesk(s, { id: tab.id, ...rect(200) })
  const hosts = Object.keys(s.deskHosts)
  assert.equal(hosts.length, 200)
  assert.equal(hosts.includes('h1.example'), false)
  assert.equal(hosts.includes('first.example'), false)
  assert.deepEqual(hosts.slice(-2), ['h0.example', 'h200.example'])
  assert.deepEqual(s.deskHosts['h0.example'], rect(500))

  const saved = JSON.parse(JSON.stringify(S.persistable(s)))
  assert.equal(saved.deskTop, undefined)
  assert.deepEqual(S.load(saved).deskHosts, s.deskHosts)
  assert.deepEqual(S.load({ deskHosts: { 'ok.example': rect(1), 'small.example': { x: 0, y: 0, width: 10, height: 10 }, 'text.example': 'x' } }).deskHosts, { 'ok.example': rect(1) })
  assert.deepEqual(S.load({ deskHosts: [] }).deskHosts, {})
  assert.deepEqual(S.load({ deskHosts: Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`k${i}.example`, rect(i)])) }).deskHosts['k5.example'], rect(5))
  assert.equal(Object.keys(S.load({ deskHosts: Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`k${i}.example`, rect(i)])) }).deskHosts).length, 200)

  const t = onDesk()
  S.openIncognito(t)
  const secret = S.createTab(t, { url: 'https://secret.example/' }, 1)
  S.placeDesk(t, { id: secret.id, ...rect(3) })
  assert.deepEqual(t.deskHosts, {})
})

test('Control with Option on the Mac, Control with Super elsewhere, tiles the active desk window', () => {
  const byPlatform = (platform) => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform })
    delete require.cache[require.resolve('../src/state')]
    try { return require('../src/state').load().settings.shortcuts } finally {
      Object.defineProperty(process, 'platform', real)
      delete require.cache[require.resolve('../src/state')]
    }
  }
  const tiles = (shortcuts) => Object.fromEntries(Object.entries(shortcuts).filter(([, c]) => c.method === 'desk.tile').map(([key, c]) => [key, c.params.layout]))
  assert.deepEqual(tiles(byPlatform('darwin')), { 'Ctrl+Alt+Left': 'left', 'Ctrl+Alt+Right': 'right', 'Ctrl+Alt+Up': 'top', 'Ctrl+Alt+Down': 'bottom', 'Ctrl+Alt+Enter': 'fill', 'Ctrl+Alt+C': 'center' })
  assert.deepEqual(tiles(byPlatform('linux')), { 'Ctrl+Super+Left': 'left', 'Ctrl+Super+Right': 'right', 'Ctrl+Super+Up': 'top', 'Ctrl+Super+Down': 'bottom', 'Ctrl+Super+Enter': 'fill', 'Ctrl+Super+C': 'center' })
  // Spaces keep Command with Option on the Mac and Control with Option elsewhere.
  assert.deepEqual(byPlatform('darwin')['CmdOrCtrl+Alt+Left'], { method: 'spaces.cycle', params: { delta: -1 } })
})

test('tabs.thumbnails takes up to 24 known tab ids in order and a width up to 3840, and leaves out incognito tabs while another space shows', () => {
  const s = S.load()
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 1)
  assert.deepEqual(S.thumbnailTabs(s, { ids: [b.id, a.id] }), { tabs: [b, a], width: 480 })
  assert.equal(S.thumbnailTabs(s, { ids: [], width: 3840 }).width, 3840)
  for (const p of [{}, { ids: a.id }, { ids: [1] }, { ids: Array(25).fill(a.id) }, { ids: [a.id], width: 3841 }, { ids: [a.id], width: '480' }, { ids: ['nope'] }]) {
    assert.throws(() => S.thumbnailTabs(s, p), { code: 'bad_params' })
  }
  const home = s.activeSpaceId
  S.openIncognito(s)
  const secret = S.createTab(s, { url: 'secret.example' }, 1)
  assert.deepEqual(S.thumbnailTabs(s, { ids: [secret.id] }).tabs, [secret])
  S.activateSpace(s, { id: home })
  assert.deepEqual(S.thumbnailTabs(s, { ids: [secret.id, a.id] }).tabs, [null, a])
})

test('an agent tab uses the session of its space, stays out of the tab list and is never saved', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const user = S.createTab(s, { url: 'user.example' }, 1)
  const work = S.createSpace(s, { name: 'Work' })
  work.sessionPartition = 'persist:work'
  const agent = S.createTab(s, { url: 'agent.example', agent: '  omp  ', spaceId: work.id, activate: true, parentId: user.id }, 2)
  assert.deepEqual([agent.agent, agent.spaceId, agent.sessionPartition, agent.parentId], ['omp', work.id, 'persist:work', undefined])
  assert.deepEqual(ids(s.tabs), [user.id])
  assert.deepEqual(ids(s.agentTabs), [agent.id])
  assert.deepEqual([s.activeSpaceId, s.activeTabBySpace, s.peek], [home, { [home]: user.id }, null])
  assert.equal(S.getTab(s, agent.id), agent)
  const saved = S.persistable(s)
  assert.equal('agentTabs' in saved || 'peek' in saved, false)
  assert.deepEqual(S.load(JSON.parse(JSON.stringify({ ...saved, agentTabs: [agent], peek: agent.id }))).agentTabs, [])
  assert.equal(S.createTab(s, { url: 'b.example', agent: 'x'.repeat(50) }, 3).agent, 'x'.repeat(40))
  assert.throws(() => S.createTab(s, { url: 'c.example', agent: ' ' }, 3), { code: 'bad_params' })
})

test('agent tabs open in a normal space; the incognito space is refused', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const incognito = S.openIncognito(s)
  assert.equal(S.createTab(s, { url: 'a.example', agent: 'omp' }, 1).spaceId, home)
  assert.throws(() => S.createTab(s, { url: 'b.example', agent: 'omp', spaceId: incognito.id }, 1), { code: 'bad_params' })
  assert.equal(s.agentTabs.length, 1)
})

test('activating an agent tab peeks at it without changing the active tab; showing a user tab or space ends it', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const user = S.createTab(s, { url: 'user.example' }, 1)
  const work = S.createSpace(s, { name: 'Work' })
  const agent = S.createTab(s, { url: 'agent.example', agent: 'omp', spaceId: work.id }, 2)
  const before = { ...s.activeTabBySpace }
  assert.equal(S.activateTab(s, { id: agent.id }, 3), agent)
  assert.deepEqual([s.peek, s.activeSpaceId, s.activeTabBySpace], [agent.id, home, before])
  S.activateTab(s, { id: user.id }, 4)
  assert.equal(s.peek, null)
  S.showDesk(s, { id: agent.id }, 5)
  assert.equal(s.peek, agent.id)
  S.hideDesk(s, { id: agent.id })
  assert.deepEqual([s.peek, agent.desk], [null, undefined])
  for (const end of [() => S.activateSpace(s, { id: work.id }), () => S.cycleSpace(s, { delta: 1 }), () => S.openIncognito(s), () => S.createTab(s, { url: 'next.example' }, 6)]) {
    S.activateTab(s, { id: agent.id }, 6)
    end()
    assert.equal(s.peek, null)
  }
})

test('closing an agent tab drops it without archiving and ends its peek; removing its space drops it', () => {
  const s = S.load()
  const work = S.createSpace(s, { name: 'Work' })
  const a = S.createTab(s, { url: 'a.example', agent: 'omp' }, 1)
  const b = S.createTab(s, { url: 'b.example', agent: 'omp', spaceId: work.id }, 1)
  S.activateTab(s, { id: a.id }, 2)
  assert.deepEqual(S.closeTab(s, { id: a.id }, 3), { closed: a.id })
  assert.deepEqual([s.agentTabs, s.archive, s.peek], [[b], [], null])
  S.activateTab(s, { id: b.id }, 4)
  S.removeSpace(s, { id: work.id }, 5)
  assert.deepEqual([s.agentTabs, s.archive, s.peek], [[], [], null])
})

test('agent tabs cannot be moved, favorited or pinned, and sweep and lists ignore them', () => {
  const s = S.load()
  const work = S.createSpace(s, { name: 'Work' })
  const agent = S.createTab(s, { url: 'a.example', agent: 'omp' }, 0)
  assert.throws(() => S.moveTab(s, { id: agent.id, spaceId: work.id }, 1), { code: 'bad_params' })
  assert.throws(() => S.setFavorite(s, { id: agent.id, favorite: true }, 1), { code: 'bad_params' })
  assert.throws(() => S.setPinned(s, { id: agent.id, pinned: true }, 1), { code: 'bad_params' })
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR), { archived: [], done: [], settled: [] })
  assert.deepEqual([S.visibleTabs(s), S.shownTabs(s)], [[], []])
  assert.equal(s.agentTabs.length, 1)
})

test('legacy folder labels migrate as literal names, including separators, with stable identity and empty records', () => {
  const s = S.load({
    spaces: [{ id: 'home', name: 'Home', color: '#4f6bed' }],
    tabs: [{ id: 'pin', spaceId: 'home', url: 'https://docs.example/', pinned: true, folder: 'Docs / Literal' }],
    collapsed: { 'home/Docs / Literal': true, 'home/Empty': true }
  })
  const value = s.folders.find((f) => f.name === 'Docs / Literal')
  assert.equal(value.parentId, null)
  assert.equal(value.collapsed, true)
  assert.equal(s.tabs[0].folderId, value.id)
  assert.ok(s.folders.some((f) => f.name === 'Empty'))
  const restored = S.load(JSON.parse(JSON.stringify(S.persistable(s))))
  assert.deepEqual(restored.folders, s.folders)
  assert.equal(restored.tabs[0].folderId, value.id)
})

test('nested folder moves carry descendants and tabs without changing sessions; deletion unwraps instead of losing content', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const root = S.createFolder(s, { name: 'Docs' })
  const child = S.createFolder(s, { name: 'Specs', parentId: root.id })
  const empty = S.createFolder(s, { name: 'Empty', parentId: child.id })
  const tab = S.createTab(s, { url: 'docs.example' }, 1)
  S.setPinned(s, { id: tab.id, pinned: true, folderId: child.id }, 2)
  const partition = tab.sessionPartition
  const before = structuredClone(s)
  assert.throws(() => S.moveFolder(s, { id: root.id, parentId: empty.id }), { code: 'bad_params' })
  assert.deepEqual(s, before)
  assert.throws(() => S.updateFolder(s, { id: root.id, name: 'Changed', collapsed: 'true' }), { code: 'bad_params' })
  assert.deepEqual(s, before)
  S.updateFolder(s, { id: root.id, name: 'Reference', collapsed: true })
  assert.equal(tab.folder, 'Reference / Specs')
  S.moveFolder(s, { id: root.id, spaceId: work.id })
  assert.deepEqual([root.spaceId, child.spaceId, empty.spaceId, tab.spaceId], Array(4).fill(work.id))
  assert.equal(tab.sessionPartition, partition)
  assert.equal(s.activeTabBySpace[home], undefined)
  S.removeFolder(s, { id: child.id })
  assert.equal(empty.parentId, root.id)
  assert.equal(tab.folderId, root.id)
  S.removeFolder(s, { id: root.id })
  assert.equal(empty.parentId, null)
  assert.equal(tab.folderId, undefined)
  assert.equal(tab.folder, '')
  assert.ok(s.tabs.includes(tab))
  assert.deepEqual(s.archive, [])
  assert.deepEqual(S.load(JSON.parse(JSON.stringify(S.persistable(s)))).folders, [empty])
})

test('folder and trail boundaries reject private crossovers and repair malformed saved cycles', () => {
  const s = S.load({
    spaces: [{ id: 'home', name: 'Home' }],
    folders: [
      { id: 'a', name: 'A', spaceId: 'home', parentId: 'b' },
      { id: 'b', name: 'B', spaceId: 'home', parentId: 'a' },
      { id: 'orphan', name: 'Orphan', spaceId: 'home', parentId: 'missing' }
    ]
  })
  assert.equal(s.folders.find((f) => f.id === 'a').parentId, null)
  assert.equal(s.folders.find((f) => f.id === 'orphan').parentId, null)
  const privateSpace = S.openIncognito(s)
  const before = structuredClone(s)
  assert.throws(() => S.moveFolder(s, { id: 'a', spaceId: privateSpace.id }), { code: 'bad_params' })
  assert.deepEqual(s, before)
  const privateFolder = S.createFolder(s, { name: 'Private' })
  assert.equal(S.persistable(s).folders.some((f) => f.id === privateFolder.id), false)
})

test('collapsed trails hide descendants from selection, not live Layer windows, and activation reveals ancestors', () => {
  const s = S.load()
  const root = S.createTab(s, { url: 'root.example' }, 1)
  const child = S.createTab(s, { url: 'child.example', parentId: root.id }, 2)
  const leaf = S.createTab(s, { url: 'leaf.example', parentId: child.id }, 3)
  const other = S.createTab(s, { url: 'other.example' }, 4)
  S.setTrailCollapsed(s, { id: root.id, collapsed: true })
  assert.deepEqual(ids(S.visibleTabs(s)), [root.id, other.id])
  assert.deepEqual(ids(S.shownTabs(s)), [root.id, child.id, leaf.id, other.id])
  assert.equal(S.selectTab(s, { index: 1 }, 5).id, other.id)
  const loaded = S.load(JSON.parse(JSON.stringify(S.persistable(s))))
  assert.equal(S.getTab(loaded, root.id).trailCollapsed, true)
  S.activateTab(s, { id: leaf.id }, 6)
  assert.equal(root.trailCollapsed, undefined)
  assert.deepEqual(ids(S.visibleTabs(s)), [root.id, child.id, leaf.id, other.id])
})

test('profile migration is stable and assignments, rename and deletion never move existing sign-in stores', () => {
  const legacy = () => ({
    spaces: [{ id: 'work', name: 'Work', sessionPartition: 'persist:arc-work' }],
    tabs: [{ id: 'old', spaceId: 'work', url: 'https://old.example/', sessionPartition: 'persist:arc-work' }],
    archive: [{ id: 'archived', spaceId: 'work', url: 'https://archived.example/', sessionPartition: 'persist:arc-other' }]
  })
  const s = S.load(legacy())
  assert.deepEqual(S.load(legacy()).profiles, s.profiles)
  const imported = s.profiles.find((p) => p.partition === 'persist:arc-work')
  const profile = S.createProfile(s, { name: 'Personal' })
  S.assignProfile(s, { spaceId: 'work', profileId: profile.id })
  const tab = S.createTab(s, { url: 'new.example' }, 1)
  assert.equal(tab.sessionPartition, profile.partition)
  assert.equal(S.getTab(s, 'old').sessionPartition, imported.partition)
  S.updateProfile(s, { id: profile.id, name: 'Renamed' })
  S.closeTab(s, { id: tab.id }, 2)
  S.removeProfile(s, { id: profile.id })
  assert.equal(S.restore(s, { id: tab.id }, 3).sessionPartition, profile.partition)
  assert.equal(S.createTab(s, { url: 'default.example' }, 4).sessionPartition, 'persist:main')
  const loaded = S.load(JSON.parse(JSON.stringify(S.persistable(s))))
  assert.equal(S.getTab(loaded, tab.id).sessionPartition, profile.partition)
  assert.equal(loaded.profiles.some((p) => p.id === profile.id), false)
  const privateSpace = S.openIncognito(s)
  assert.throws(() => S.assignProfile(s, { spaceId: privateSpace.id, profileId: 'main' }), { code: 'bad_params' })
  assert.throws(() => S.createTab(s, { url: 'private.example', profileId: 'main' }, 5), { code: 'bad_params' })
  assert.throws(() => S.removeProfile(s, { id: 'main' }), { code: 'bad_params' })
})

test('external routing validates destinations, exact hosts outrank longest suffix, and lookalikes never match', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const nested = S.createSpace(s, { name: 'Nested' })
  const profile = S.createProfile(s, { name: 'Work profile' })
  S.setLinkRule(s, { host: '*.example.com', spaceId: work.id, profileId: profile.id })
  S.setLinkRule(s, { host: '*.team.example.com', spaceId: nested.id })
  const exact = S.setLinkRule(s, { host: 'DOCS.team.example.com', spaceId: home })
  assert.equal(S.routeLink(s, { url: 'https://docs.team.example.com/path?q=1' }).spaceId, home)
  assert.equal(S.routeLink(s, { url: 'https://a.team.example.com/' }).spaceId, nested.id)
  const routed = S.routeLink(s, { url: 'https://docs.example.com/' })
  assert.deepEqual([routed.spaceId, routed.profileId, routed.sessionPartition], [work.id, profile.id, profile.partition])
  for (const url of ['https://example.com/', 'https://evilexample.com/', 'https://example.com.evil.test/']) assert.equal(S.routeLink(s, { url }).spaceId, home)
  for (const host of ['https://example.com', '*.com', '*example.com', 'example.com/path', 'example.com:443', 'user@example.com', '.example.com']) assert.throws(() => S.setLinkRule(s, { host, spaceId: home }), { code: 'bad_params' })
  const privateSpace = S.openIncognito(s)
  assert.throws(() => S.setLinkRule(s, { host: 'private.example', spaceId: privateSpace.id }), { code: 'bad_params' })
  assert.equal(S.routeLink(s, { url: 'https://unknown.example/' }).spaceId, home)
  assert.throws(() => S.routeLink(s, { url: 'file:///etc/passwd' }), { code: 'bad_params' })
  S.removeLinkRule(s, { id: exact.id })
  assert.equal(S.routeLink(s, { url: 'https://docs.team.example.com/' }).spaceId, nested.id)
  S.removeProfile(s, { id: profile.id })
  assert.equal(S.routeLink(s, { url: 'https://docs.example.com/' }).spaceId, home)
})

test('split preserves identities, ratio and independent focus, rejects invalid pairs atomically and cleans removal', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 2)
  const c = S.createTab(s, { url: 'c.example' }, 3)
  const split = S.setSplit(s, { ids: [a.id, b.id], ratio: .35, activeId: a.id }, 4)
  assert.equal(S.activeTab(s), a)
  S.activateTab(s, { id: b.id }, 5)
  assert.equal(split.activeId, b.id)
  S.activateTab(s, { id: c.id }, 6)
  assert.equal(split.activeId, b.id)
  S.resizeSplit(s, { ratio: .65 })
  assert.deepEqual(S.load(JSON.parse(JSON.stringify(S.persistable(s)))).splitBySpace[home], { ids: [a.id, b.id], ratio: .65, activeId: b.id })
  assert.equal(S.sweep(s, {}, 1000 * HOUR).archived.includes(a.id), false)
  const work = S.createSpace(s, { name: 'Work' })
  const foreign = S.createTab(s, { url: 'foreign.example', spaceId: work.id }, 7)
  const agent = S.createTab(s, { url: 'agent.example', agent: 'omp' }, 8)
  const before = structuredClone(s)
  for (const params of [{ ids: [a.id, a.id] }, { ids: [a.id, foreign.id] }, { ids: [a.id, agent.id] }, { ids: [a.id, b.id], ratio: NaN }, { ids: [a.id, b.id], activeId: c.id }]) assert.throws(() => S.setSplit(s, params, 9), { code: 'bad_params' })
  assert.deepEqual(s, before)
  S.closeTab(s, { id: a.id }, 10)
  assert.equal(s.splitBySpace[home], undefined)
  S.restore(s, { id: a.id }, 11)
  S.setSplit(s, { ids: [a.id, b.id] }, 12)
  S.moveTab(s, { id: b.id, spaceId: work.id }, 13)
  assert.equal(s.splitBySpace[home], undefined)
})

test('user peek is same-session ephemeral state; promotion retains the exact tab and private promotion stays private', () => {
  const s = S.load()
  const source = S.createTab(s, { url: 'source.example' }, 1)
  source.sessionPartition = 'persist:source-session'
  const peek = S.createPeek(s, { url: 'https://target.example/', sourceId: source.id }, 2)
  assert.equal(peek.sessionPartition, source.sessionPartition)
  assert.equal(s.userPeek, peek.id)
  assert.equal(S.activeTab(s), source)
  assert.equal(S.visibleTabs(s).includes(peek), false)
  assert.equal(S.shownTabs(s).includes(peek), false)
  assert.equal(S.persistable(s).tabs.includes(peek), false)
  assert.equal(S.load(JSON.parse(JSON.stringify(s))).tabs.some((t) => t.id === peek.id), false)
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR).archived, [])
  assert.throws(() => S.setPinned(s, { id: peek.id, pinned: true }, 3), { code: 'bad_params' })
  assert.throws(() => S.setSplit(s, { ids: [source.id, peek.id] }, 3), { code: 'bad_params' })
  const promoted = S.promotePeek(s, {}, 4)
  assert.equal(promoted, peek)
  assert.equal(S.activeTab(s), peek)
  assert.equal(peek.sessionPartition, source.sessionPartition)
  assert.equal(peek.userPeek, undefined)
  assert.equal(s.userPeek, null)
  assert.ok(S.persistable(s).tabs.includes(peek))
  const transient = S.createPeek(s, { url: 'https://dismiss.example/' }, 5)
  assert.deepEqual(S.dismissPeek(s, {}), { closed: transient.id })
  assert.equal(S.findTab(s, transient.id), undefined)
  assert.deepEqual(s.archive, [])
  S.openIncognito(s)
  const privateSource = S.createTab(s, { url: 'private.example' }, 6)
  const privatePeek = S.createPeek(s, { url: 'https://private-target.example/' }, 7)
  assert.equal(privatePeek.sessionPartition, privateSource.sessionPartition)
  S.promotePeek(s, {}, 8)
  assert.equal(S.persistable(s).tabs.includes(privatePeek), false)
  S.closeTab(s, { id: privatePeek.id }, 9)
  assert.deepEqual(s.archive, [])
})

test('scalar browser settings reject partial invalid writes and persist valid nondefault choices', () => {
  const s = S.load()
  const before = structuredClone(s.settings)
  for (const params of [{ memorySaver: true, historyRetentionDays: -1 }, { downloadAskWhere: 1 }, { memorySaverMinutes: 0 }, { transcriptRetentionDays: 0 }, { downloadDirectory: 'bad\0path' }]) {
    assert.throws(() => S.setSettings(s, params), { code: 'bad_params' })
    assert.deepEqual(s.settings, before)
  }
  const values = { historyRetentionDays: 0, downloadAskWhere: false, downloadDirectory: '/home/user/Downloads', memorySaver: true, memorySaverMinutes: 10080, transcriptRecovery: true, transcriptRetentionDays: 3650 }
  S.setSettings(s, values)
  const loaded = S.load(JSON.parse(JSON.stringify(S.persistable(s))))
  for (const [key, value] of Object.entries(values)) assert.equal(loaded.settings[key], value)
})

test('split hide and explicit clearing release pairs, and private split metadata never persists', () => {
  const s = S.load()
  const a = S.createTab(s, { url: 'a.example' }, 1)
  const b = S.createTab(s, { url: 'b.example' }, 2)
  S.setSplit(s, { ids: [a.id, b.id] }, 3)
  S.hideDesk(s, { id: a.id })
  assert.equal(s.splitBySpace[a.spaceId], undefined)
  S.setSplit(s, { ids: [a.id, b.id] }, 4)
  S.clearSplit(s, {})
  assert.equal(s.splitBySpace[a.spaceId], undefined)
  assert.ok(S.findTab(s, a.id))
  assert.ok(S.findTab(s, b.id))
  S.openIncognito(s)
  const privateA = S.createTab(s, { url: 'private-a.example' }, 5)
  const privateB = S.createTab(s, { url: 'private-b.example' }, 6)
  S.setSplit(s, { ids: [privateA.id, privateB.id] }, 7)
  assert.ok(s.splitBySpace[privateA.spaceId])
  assert.deepEqual(S.persistable(s).splitBySpace, {})
})

test('replacing a peek drops only its ephemeral predecessor and invalid replacement leaves it intact', () => {
  const s = S.load()
  const source = S.createTab(s, { url: 'source.example' }, 1)
  const first = S.createPeek(s, { url: 'https://first.example/' }, 2)
  assert.throws(() => S.createPeek(s, { url: 'file:///private' }, 3), { code: 'bad_params' })
  assert.equal(s.userPeek, first.id)
  const second = S.createPeek(s, { url: 'https://second.example/' }, 4)
  assert.equal(S.findTab(s, first.id), undefined)
  assert.equal(S.findTab(s, source.id), source)
  assert.equal(s.userPeek, second.id)
  assert.deepEqual(S.closeTab(s, { id: second.id }, 5), { closed: second.id })
  assert.deepEqual(s.archive, [])
})

test('user peeks require an active-space source but allow independent nonselected Layer tabs', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const source = S.createTab(s, { url: 'source.example' }, 1)
  const selected = S.createTab(s, { url: 'selected.example' }, 2)
  const peek = S.createPeek(s, { sourceId: source.id, url: 'https://peek.example/' }, 3)
  assert.equal(S.activeTab(s), selected)
  S.activateSpace(s, { id: home })
  S.activateTab(s, { id: selected.id }, 4)
  assert.equal(s.userPeek, peek.id)
  const privateSpace = S.openIncognito(s)
  const privateSource = S.createTab(s, { url: 'private.example' }, 5)
  const privatePeek = S.createPeek(s, { url: 'https://private-peek.example/' }, 6)
  const before = structuredClone(s)
  assert.throws(() => S.createPeek(s, { sourceId: source.id, url: 'https://wrong-session.example/' }, 7), { code: 'bad_params' })
  assert.deepEqual(s, before)
  assert.equal(s.userPeek, privatePeek.id)
  S.activateSpace(s, { id: home })
  assert.equal(S.findTab(s, privatePeek.id), undefined)
  assert.throws(() => S.createPeek(s, { sourceId: privateSource.id, url: 'https://private-leak.example/' }, 8), { code: 'bad_params' })
  assert.equal(s.spaces.find((x) => x.id === privateSpace.id).incognito, true)
})

test('every space-selection path dismisses a peek without archiving it or retaining private content', () => {
  for (const transition of ['activateSpace', 'cycleSpace', 'openIncognito', 'activateTab', 'removeSpace']) {
    const s = S.load()
    const home = s.activeSpaceId
    const homeTab = S.createTab(s, { url: 'home.example' }, 1)
    const work = S.createSpace(s, { name: 'Work' })
    S.activateSpace(s, { id: work.id })
    const source = S.createTab(s, { url: 'source.example' }, 2)
    const peek = S.createPeek(s, { url: 'https://peek.example/' }, 3)
    if (transition === 'activateSpace') S.activateSpace(s, { id: home })
    if (transition === 'cycleSpace') S.cycleSpace(s, { delta: 1 })
    if (transition === 'openIncognito') S.openIncognito(s)
    if (transition === 'activateTab') S.activateTab(s, { id: homeTab.id }, 4)
    if (transition === 'removeSpace') S.removeSpace(s, { id: work.id }, 4)
    assert.equal(s.userPeek, null, transition)
    assert.equal(S.findTab(s, peek.id), undefined, transition)
    assert.equal(s.archive.some((t) => t.id === peek.id), false, transition)
    if (transition !== 'removeSpace') assert.equal(S.findTab(s, source.id), source)

    S.openIncognito(s)
    const privateSource = S.createTab(s, { url: 'private.example' }, 5)
    const privatePeek = S.createPeek(s, { url: 'https://private-peek.example/' }, 6)
    if (transition === 'cycleSpace') S.cycleSpace(s, { delta: 1 })
    else if (transition === 'activateTab') S.activateTab(s, { id: homeTab.id }, 7)
    else if (transition === 'removeSpace') S.removeSpace(s, { id: privateSource.spaceId }, 7)
    else S.activateSpace(s, { id: home })
    assert.equal(s.userPeek, null, `${transition}: private departure`)
    assert.equal(S.findTab(s, privatePeek.id), undefined)
    assert.equal(s.archive.some((t) => t.id === privatePeek.id), false)
  }
})

test('explicit folder index moves its tab subtree while preserving loose pin order and identities', () => {
  const s = S.load()
  const a = S.createFolder(s, { name: 'A' })
  const b = S.createFolder(s, { name: 'B' })
  const child = S.createFolder(s, { name: 'Child', parentId: b.id })
  const empty = S.createFolder(s, { name: 'Empty' })
  const pin = (label, folderId) => {
    const tab = S.createTab(s, { url: `${label}.example` }, 1)
    S.setPinned(s, { id: tab.id, pinned: true, folderId }, 2)
    return tab
  }
  const looseA = pin('loose-a')
  const aTab = pin('a', a.id)
  const looseB = pin('loose-b')
  const childTab = pin('child', child.id)
  const looseC = pin('loose-c')
  const bTab = pin('b', b.id)
  const selection = { ...s.activeTabBySpace }
  const partitions = s.tabs.map((t) => [t.id, t.sessionPartition])
  S.moveFolder(s, { id: b.id, index: 0 })
  assert.deepEqual(ids(s.tabs), ids([looseA, childTab, bTab, aTab, looseB, looseC]))
  assert.deepEqual(ids(s.folders.filter((f) => !f.parentId)), [b.id, a.id, empty.id])
  assert.equal(child.parentId, b.id)
  assert.deepEqual(s.activeTabBySpace, selection)
  for (const [id, partition] of partitions) assert.equal(S.getTab(s, id).sessionPartition, partition)
  S.moveFolder(s, { id: b.id, index: 2 })
  assert.deepEqual(ids(s.tabs), ids([looseA, aTab, childTab, bTab, looseB, looseC]))
  assert.deepEqual(ids(s.folders.filter((f) => !f.parentId)), [a.id, empty.id, b.id])
  const order = ids(s.tabs)
  S.moveFolder(s, { id: empty.id, index: 0 })
  assert.deepEqual(ids(s.tabs), order)
  assert.deepEqual(ids(s.folders.filter((f) => !f.parentId)), [empty.id, a.id, b.id])
})

test('nested folder index moves respect direct parent pins and deeper descendants', () => {
  const s = S.load()
  const parent = S.createFolder(s, { name: 'Parent' })
  const a = S.createFolder(s, { name: 'A', parentId: parent.id })
  const b = S.createFolder(s, { name: 'B', parentId: parent.id })
  const deep = S.createFolder(s, { name: 'Deep', parentId: b.id })
  const tabs = [parent, a, parent, deep].map((f, index) => {
    const tab = S.createTab(s, { url: `tab-${index}.example` }, 1)
    S.setPinned(s, { id: tab.id, pinned: true, folderId: f.id }, 2)
    return tab
  })
  S.moveFolder(s, { id: b.id, index: 0 })
  assert.deepEqual(ids(s.tabs), ids([tabs[0], tabs[3], tabs[1], tabs[2]]))
  assert.deepEqual(ids(s.folders.filter((f) => f.parentId === parent.id)), [b.id, a.id])
  assert.equal(tabs[3].folderId, deep.id)
  assert.equal(tabs[3].folder, 'Parent / B / Deep')
})

const bucket = (s, tab) => S.bucketOf(S.findTab(s, tab.id))

test('buckets: a new tab is in progress, an imported or loaded tab is active, favorites and pinned tabs have no status', () => {
  const s = S.load()
  const tab = S.createTab(s, { url: 'a.example' }, 0)
  assert.deepEqual([tab.status, bucket(s, tab)], ['progress', 'progress'])
  const fav = S.createTab(s, { url: 'fav.example' }, 0)
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  const later = S.createTab(s, { url: 'later.example' }, 0)
  S.setPinned(s, { id: later.id, pinned: true }, 0)
  assert.deepEqual([fav, later].map((t) => [bucket(s, t), t.status, t.doneAt]), [['favorites', undefined, undefined], ['later', undefined, undefined]])
  assert.deepEqual(S.importSetup(s, { spaces: [{ name: 'Arc', pinned: [], tabs: [{ title: 'i', url: 'https://imported.example/' }], folders: [] }], favorites: [] }, 0), { spaces: 1, favorites: 0, pinned: 0, tabs: 1 })
  assert.equal(S.bucketOf(s.tabs.find((t) => t.url === 'https://imported.example/')), 'active')
  const archived = S.createTab(s, { url: 'closed.example' }, 0)
  S.closeTab(s, { id: archived.id }, 1)
  assert.equal(bucket(s, S.restore(s, { id: archived.id }, 2)), 'progress')
  assert.equal(S.bucketOf({ favorite: true, pinned: true, status: 'done' }), 'favorites')
})

test('buckets: settle moves a progress page to active when watched and unread when not, and nothing else', () => {
  const s = S.load()
  const [watched, away, again] = ['a', 'b', 'c'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  assert.equal(S.settle(s, watched.id, true), true)
  assert.equal(S.settle(s, away.id, false), true)
  assert.deepEqual([watched, away, again].map((t) => bucket(s, t)), ['active', 'unread', 'progress'])
  assert.equal(S.settle(s, watched.id, false), false)
  assert.equal(S.settle(s, away.id, true), false)
  assert.deepEqual([bucket(s, watched), bucket(s, away)], ['active', 'unread'])
  assert.equal(S.settle(s, 'nope', true), false)
  S.navigateTab(s, { id: watched.id, url: 'https://other.example/' }, 1)
  S.navigateTab(s, { id: away.id, url: 'https://other.example/' }, 1)
  assert.deepEqual([bucket(s, watched), bucket(s, away)], ['active', 'unread'])
  const fav = S.createTab(s, { url: 'fav.example' }, 0)
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  assert.equal(S.settle(s, fav.id, false), false)
  const chat = S.createTab(s, {}, 0, { id: 'c1', agent: 'Fake', title: 'Chat', favicon: '' })
  assert.deepEqual([S.settle(s, chat.id, false), bucket(s, chat)], [false, 'active'])
})

test('buckets: showing an unread or done tab makes it active; progress stays', () => {
  const s = S.load()
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  S.setBucket(s, { id: a.id, bucket: 'unread' }, 1)
  S.setBucket(s, { id: b.id, bucket: 'done' }, 1)
  S.activateTab(s, { id: a.id }, 2)
  assert.deepEqual([bucket(s, a), a.lastActiveAt], ['active', 2])
  S.activateTab(s, { id: b.id }, 3)
  assert.deepEqual([bucket(s, b), b.doneAt], ['active', undefined])
  S.activateTab(s, { id: c.id }, 4)
  assert.equal(bucket(s, c), 'progress')
  S.setBucket(s, { id: d.id, bucket: 'unread' }, 5)
  S.setBucket(s, { id: a.id, bucket: 'done' }, 5)
  S.cycleTab(s, { delta: -1 }, 6)
  assert.equal(S.activeTab(s), b)
  S.selectTab(s, { index: 0 }, 7)
  assert.equal(bucket(s, a), 'active')
})

test('buckets: switching to a space, or closing the active tab, shows the tab that appears', () => {
  const s = S.load()
  const home = s.activeSpaceId
  const work = S.createSpace(s, { name: 'Work' })
  const a = S.createTab(s, { url: 'a.example', spaceId: work.id }, 0)
  S.setBucket(s, { id: a.id, bucket: 'unread' }, 1)
  const b = S.createTab(s, { url: 'b.example', spaceId: home }, 0)
  S.activateSpace(s, { id: home })
  S.activateTab(s, { id: b.id }, 1)
  assert.equal(bucket(s, a), 'unread')
  S.activateSpace(s, { id: work.id })
  assert.equal(bucket(s, a), 'active')
  S.setBucket(s, { id: a.id, bucket: 'unread' }, 2)
  const c = S.createTab(s, { url: 'c.example', spaceId: work.id }, 2)
  S.setBucket(s, { id: a.id, bucket: 'done' }, 2)
  S.closeTab(s, { id: c.id }, 3)
  assert.deepEqual([S.activeTab(s), bucket(s, a)], [a, 'active'])
})

test('buckets: look moves only an unread or done active tab', () => {
  const s = S.load()
  assert.equal(S.look(s), false)
  const a = S.createTab(s, { url: 'a.example' }, 0)
  assert.equal(S.look(s), false)
  S.settle(s, a.id, false)
  assert.equal(S.look(s), true)
  assert.equal(bucket(s, a), 'active')
  assert.equal(S.look(s), false)
})

test('buckets: leaving favorites or later puts the tab in active, entering clears its status', () => {
  const s = S.load()
  const a = S.createTab(s, { url: 'a.example' }, 0)
  S.setBucket(s, { id: a.id, bucket: 'unread' }, 1)
  S.setFavorite(s, { id: a.id, favorite: true }, 2)
  assert.deepEqual([bucket(s, a), a.status], ['favorites', undefined])
  S.setFavorite(s, { id: a.id, favorite: false }, 3)
  assert.deepEqual([bucket(s, a), a.status], ['active', 'active'])
  S.setPinned(s, { id: a.id, pinned: true, folder: 'Docs' }, 4)
  assert.deepEqual([bucket(s, a), a.status], ['later', undefined])
  S.setFavorite(s, { id: a.id, favorite: true }, 5)
  S.setPinned(s, { id: a.id, pinned: true }, 6)
  assert.deepEqual([bucket(s, a), a.status], ['later', undefined])
  S.setPinned(s, { id: a.id, pinned: false }, 7)
  assert.deepEqual([bucket(s, a), a.status], ['active', 'active'])
  S.setBucket(s, { id: a.id, bucket: 'unread' }, 8)
  S.setFavorite(s, { id: a.id, favorite: false }, 9)
  S.setPinned(s, { id: a.id, pinned: false }, 9)
  assert.equal(bucket(s, a), 'unread')
})

test('buckets: setBucket moves a tab by hand and validates the bucket', () => {
  const s = S.load()
  const a = S.createTab(s, { url: 'a.example' }, 0)
  const b = S.createTab(s, { url: 'b.example' }, 0)
  assert.equal(bucket(s, a), 'progress')
  S.setBucket(s, { id: a.id, bucket: 'done' }, 5)
  assert.deepEqual([bucket(s, a), a.doneAt], ['done', 5])
  S.setBucket(s, { id: a.id, bucket: 'done' }, 9)
  assert.equal(a.doneAt, 5)
  S.setBucket(s, { id: a.id, bucket: 'unread' }, 10)
  assert.deepEqual([bucket(s, a), a.doneAt], ['unread', undefined])
  S.setBucket(s, { id: a.id, bucket: 'active' }, 11)
  assert.equal(bucket(s, a), 'active')
  S.setBucket(s, { id: a.id, bucket: 'favorites' }, 12)
  assert.deepEqual([bucket(s, a), a.favorite, a.status], ['favorites', true, undefined])
  S.setBucket(s, { id: a.id, bucket: 'later' }, 13)
  assert.deepEqual([bucket(s, a), a.favorite, a.pinned, a.folder], ['later', false, true, ''])
  S.setBucket(s, { id: a.id, bucket: 'done' }, 14)
  assert.deepEqual([bucket(s, a), a.favorite, a.pinned, a.status, a.doneAt], ['done', false, false, 'done', 14])
  S.setBucket(s, { id: a.id, bucket: 'favorites' }, 15)
  S.setBucket(s, { id: a.id, bucket: 'unread' }, 16)
  assert.deepEqual([bucket(s, a), a.favorite, a.pinned], ['unread', false, false])
  S.setPinned(s, { id: a.id, pinned: true, folder: 'Docs' }, 17)
  S.setBucket(s, { id: a.id, bucket: 'later' }, 18)
  assert.equal(a.folder, 'Docs')
  assert.equal(S.setBucket(s, { id: b.id, bucket: 'active' }, 19), b)
  for (const bucketName of ['progress', 'nope', undefined, 3]) assert.throws(() => S.setBucket(s, { id: b.id, bucket: bucketName }, 20), { code: 'bad_params' })
  assert.throws(() => S.setBucket(s, { id: 'nope', bucket: 'done' }, 20), { code: 'not_found' })
  const agent = S.createTab(s, { url: 'agent.example', agent: 'omp' }, 0)
  assert.throws(() => S.setBucket(s, { id: agent.id, bucket: 'done' }, 20), { code: 'bad_params' })
  const source = S.activeTab(s)
  const peek = S.createPeek(s, { sourceId: source.id, url: 'https://peek.example/' }, 21)
  assert.throws(() => S.setBucket(s, { id: peek.id, bucket: 'done' }, 22), { code: 'bad_params' })
})

test('buckets: chatState follows a chat working and stopping, and leaves other tabs alone', () => {
  const s = S.load()
  const chat = S.createTab(s, {}, 0, { id: 'c1', agent: 'Fake', title: 'Chat', favicon: '' })
  assert.equal(S.chatState(s, chat.id, false, true), false)
  assert.equal(S.chatState(s, chat.id, true, true), true)
  assert.equal(bucket(s, chat), 'progress')
  assert.equal(S.chatState(s, chat.id, true, true), false)
  assert.equal(S.chatState(s, chat.id, false, false), true)
  assert.equal(bucket(s, chat), 'unread')
  assert.equal(S.chatState(s, chat.id, false, true), false)
  S.setBucket(s, { id: chat.id, bucket: 'done' }, 4)
  assert.equal(S.chatState(s, chat.id, true, false), true)
  assert.deepEqual([bucket(s, chat), chat.doneAt], ['progress', undefined])
  assert.equal(S.chatState(s, chat.id, false, true), true)
  assert.equal(bucket(s, chat), 'active')
  const web = S.createTab(s, { url: 'a.example' }, 0)
  assert.equal(S.chatState(s, web.id, true, false), false)
  assert.equal(S.chatState(s, 'nope', true, false), false)
  S.setFavorite(s, { id: chat.id, favorite: true }, 5)
  assert.equal(S.chatState(s, chat.id, true, false), false)
  assert.equal(bucket(s, chat), 'favorites')
})

test('buckets: the sweep settles pages that are not loading and never moves progress, favorite or pinned tabs to done', () => {
  const s = S.load()
  const [loading, idle, fav, later, active] = ['a', 'b', 'c', 'd', 'e'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  S.setPinned(s, { id: later.id, pinned: true }, 0)
  for (const tab of s.tabs) tab.lastActiveAt = 0
  assert.deepEqual(S.sweep(s, { loading: [loading.id, active.id] }, 1000 * HOUR), { archived: [], done: [idle.id], settled: [idle.id] })
  assert.deepEqual([loading, idle, fav, later, active].map((t) => bucket(s, t)), ['progress', 'done', 'favorites', 'later', 'progress'])
  assert.deepEqual(S.sweep(s, { loading: [loading.id, active.id] }, 1001 * HOUR), { archived: [], done: [], settled: [] })
  assert.deepEqual(S.sweep(s, { loading: [loading.id, active.id] }, 1100 * HOUR), { archived: [idle.id], done: [], settled: [] })
  assert.deepEqual(ids(s.tabs), [loading.id, fav.id, later.id, active.id])
  S.settle(s, loading.id, false)
  assert.deepEqual(S.sweep(s, {}, 1100 * HOUR).done, [loading.id])
  assert.equal(bucket(s, S.findTab(s, active.id)), 'unread')
})

test('buckets: done waits a day, a shown done tab is active again, and the active tab and a split pair stay', () => {
  const s = S.load()
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  for (const tab of s.tabs) S.settle(s, tab.id, false)
  S.setSplit(s, { ids: [a.id, b.id] }, 0)
  S.activateTab(s, { id: d.id }, 0)
  for (const tab of s.tabs) tab.lastActiveAt = 0
  assert.deepEqual(sweep(s, 13 * HOUR), { archived: [], done: [c.id] })
  assert.deepEqual([a, b, c, d].map((t) => bucket(s, t)), ['active', 'unread', 'done', 'active'])
  assert.deepEqual(sweep(s, 13 * HOUR + 24 * HOUR), { archived: [], done: [] })
  assert.deepEqual(sweep(s, 13 * HOUR + 24 * HOUR + 1), { archived: [c.id], done: [] })
  S.setBucket(s, { id: b.id, bucket: 'done' }, 38 * HOUR)
  assert.deepEqual(sweep(s, 1000 * HOUR), { archived: [], done: [] })
  S.clearSplit(s)
  assert.deepEqual(sweep(s, 1000 * HOUR), { archived: [b.id], done: [a.id] })
  S.activateTab(s, { id: a.id }, 1000 * HOUR)
  assert.deepEqual([bucket(s, a), a.doneAt], ['active', undefined])
  assert.deepEqual(sweep(s, 1000 * HOUR + 1), { archived: [], done: [] })
  assert.deepEqual(ids(s.tabs), [a.id, d.id])
})

test('buckets: incognito tabs move through the buckets but are never archived or written', () => {
  const s = S.load()
  const space = S.openIncognito(s)
  const [a, b] = ['a', 'b'].map((x) => S.createTab(s, { url: `${x}.example` }, 0))
  assert.deepEqual([a, b].map((t) => bucket(s, t)), ['progress', 'progress'])
  S.settle(s, a.id, false)
  assert.equal(bucket(s, a), 'unread')
  S.setBucket(s, { id: b.id, bucket: 'unread' }, 1)
  S.activateTab(s, { id: a.id }, 2)
  assert.equal(bucket(s, a), 'active')
  assert.deepEqual(sweep(s, 1000 * HOUR), { archived: [], done: [b.id] })
  assert.deepEqual(sweep(s, 5000 * HOUR), { archived: [], done: [] })
  assert.deepEqual([bucket(s, b), s.archive.length], ['done', 0])
  assert.equal(S.persistable(s).tabs.some((t) => t.spaceId === space.id), false)
})

test('buckets: status and doneAt are saved, and loading migrates saved tabs', () => {
  const s = S.load()
  const space = s.spaces[0].id
  const tab = (id, fields) => ({ id, spaceId: space, url: `https://${id}.example/`, title: id, favicon: '', favorite: false, lastActiveAt: 1, createdAt: 1, sessionPartition: 'persist:main', ...fields })
  const loaded = S.load({
    spaces: s.spaces,
    tabs: [
      tab('plain'), tab('unread', { status: 'unread' }), tab('done', { status: 'done', doneAt: 7 }), tab('nodone', { status: 'done' }), tab('progress', { status: 'progress' }), tab('junk', { status: 'sleeping', doneAt: 3 }),
      tab('fav', { favorite: true, status: 'unread' }), tab('pin', { pinned: true, status: 'done', doneAt: 5 })
    ]
  })
  assert.deepEqual(loaded.tabs.map((t) => [t.id, t.status, t.doneAt, S.bucketOf(t)]), [
    ['plain', 'active', undefined, 'active'], ['unread', 'unread', undefined, 'unread'], ['done', 'done', 7, 'done'], ['nodone', 'active', undefined, 'active'], ['progress', 'active', undefined, 'active'], ['junk', 'active', undefined, 'active'],
    ['fav', undefined, undefined, 'favorites'], ['pin', undefined, undefined, 'later']
  ])
  const round = S.load(JSON.parse(JSON.stringify(S.persistable(loaded))))
  assert.deepEqual(round.tabs.map((t) => [t.status, t.doneAt]), loaded.tabs.map((t) => [t.status, t.doneAt]))
})

test('moving a tab to a space on another profile joins that session; the same profile keeps it', () => {
  const s = S.load()
  const dev = S.createSpace(s, { name: 'Dev', profileId: S.createProfile(s, { name: 'Dev' }).id })
  const other = S.createSpace(s, { name: 'Other', profileId: dev.profileId })
  const work = s.spaces[0]
  const tab = S.createTab(s, { url: 'https://work.example/', spaceId: dev.id }, 1)
  tab.browserIdentity = 'native'
  assert.equal(tab.sessionPartition, dev.sessionPartition)
  S.moveTab(s, { id: tab.id, spaceId: other.id }, 2)
  assert.deepEqual([tab.sessionPartition, tab.profileId, tab.browserIdentity], [dev.sessionPartition, dev.profileId, 'native'])
  S.moveTab(s, { id: tab.id, spaceId: work.id }, 3)
  assert.deepEqual([tab.spaceId, tab.sessionPartition, tab.profileId], [work.id, work.sessionPartition, work.profileId])
  assert.equal('browserIdentity' in tab, false)
  const chat = S.createTab(s, { url: 'https://web.whatsapp.com/', spaceId: work.id }, 4)
  S.moveTab(s, { id: chat.id, spaceId: dev.id }, 5)
  assert.deepEqual([chat.sessionPartition, chat.browserIdentity], [dev.sessionPartition, 'compatible'])
})

test('moving a link peek to a space, its own included, makes it an active tab there', () => {
  const s = S.load()
  const dev = S.createSpace(s, { name: 'Dev', profileId: S.createProfile(s, { name: 'Dev' }).id })
  const home = s.spaces[0]
  const source = S.createTab(s, { url: 'https://home.example/' }, 1)
  assert.throws(() => S.moveTab(s, { id: source.id, spaceId: home.id, index: -1 }, 1), { code: 'bad_params' })
  const peek = S.createPeek(s, { url: 'https://work.example/', sourceId: source.id }, 2)
  assert.throws(() => S.moveTab(s, { id: peek.id }, 3), { code: 'bad_params' })
  S.moveTab(s, { id: peek.id, spaceId: home.id }, 3)
  assert.deepEqual([peek.userPeek, s.userPeek, s.activeTabBySpace[home.id]], [undefined, null, peek.id])
  const again = S.createPeek(s, { url: 'https://other.example/', sourceId: source.id }, 4)
  S.moveTab(s, { id: again.id, spaceId: dev.id }, 5)
  assert.deepEqual([again.userPeek, again.spaceId, again.sessionPartition, s.activeSpaceId, s.activeTabBySpace[dev.id]], [undefined, dev.id, dev.sessionPartition, dev.id, again.id])
})

test('moving a tab across the incognito boundary is still refused after sessions follow spaces', () => {
  const s = S.load()
  const home = s.spaces[0]
  const tab = S.createTab(s, { url: 'https://a.example/' }, 1)
  const incognito = S.openIncognito(s)
  const hidden = S.createTab(s, { url: 'https://b.example/' }, 2)
  assert.throws(() => S.moveTab(s, { id: tab.id, spaceId: incognito.id }, 3), { code: 'bad_params' })
  assert.throws(() => S.moveTab(s, { id: hidden.id, spaceId: home.id }, 3), { code: 'bad_params' })
  assert.equal(tab.sessionPartition, home.sessionPartition)
})

'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../src/state')

const HOUR = 3600e3
const ids = (list) => list.map((x) => x.id)

test('auto-archive takes only old, non-favorite, non-active tabs', () => {
  const s = S.load()
  const fav = S.createTab(s, { url: 'fav.example' }, 0)
  S.setFavorite(s, { id: fav.id, favorite: true }, 0)
  const old = S.createTab(s, { url: 'old.example' }, 0)
  const edge = S.createTab(s, { url: 'edge.example' }, 1)
  const active = S.createTab(s, { url: 'active.example' }, 1)
  for (const tab of s.tabs) tab.lastActiveAt = tab === edge ? 1 : 0

  assert.deepEqual(S.sweep(s, {}, 12 * HOUR), { archived: [] })
  assert.deepEqual(S.sweep(s, {}, 12 * HOUR + 1), { archived: [old.id] })
  assert.deepEqual(ids(s.tabs), [fav.id, edge.id, active.id])
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR), { archived: [edge.id] })
  assert.deepEqual(ids(s.tabs), [fav.id, active.id])
  assert.deepEqual(ids(s.archive), [edge.id, old.id])
})

test('autoArchiveHours 0 disables the sweep', () => {
  const s = S.load()
  S.createTab(s, { url: 'a.example' }, 0)
  S.createTab(s, { url: 'b.example' }, 0)
  S.setSettings(s, { autoArchiveHours: 0 })
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR), { archived: [] })
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
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR), { archived: [] })
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
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR), { archived: [plain.id] })
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
  assert.equal(s.archive[0].sessionPartition, 'persist:arc-work')
  S.restore(s, { id: tab.id }, 4)
  const loaded = S.load(JSON.parse(JSON.stringify(S.persistable(s))))
  assert.equal(loaded.tabs[0].sessionPartition, 'persist:arc-work')
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
  assert.deepEqual(b.desk, { ...layouts['right-two-thirds'], z: 2 })
  assert.equal(S.activeTab(s), a)
  // A frame's top inset counts as taken: under a window at the top only 362px are left, less than 360 once the margin is off, so the cascade.
  S.placeDesk(s, { id: b.id, x: 0, y: 30, width: 1000, height: 408 })
  const c = S.createTab(s, { url: 'https://c.example/' }, 1)
  assert.deepEqual(c.desk, { ...S.defaultDesk(s, c), z: 3 })
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
  assert.deepEqual(S.sweep(s, {}, 1000 * HOUR), { archived: [] })
  assert.deepEqual([S.visibleTabs(s), S.shownTabs(s)], [[], []])
  assert.equal(s.agentTabs.length, 1)
})

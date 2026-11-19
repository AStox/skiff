'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../src/state')
const { parseArc } = require('../src/arc')
const { windowTheme } = require('../e2e/arc-fixture')

const tab = (id, savedURL, savedTitle, title = null) => ({ id, title, childrenIds: [], data: { tab: { savedURL, savedTitle } } })
const folder = (id, title, childrenIds) => ({ id, title, childrenIds, data: { list: {} } })
const box = (id, childrenIds) => ({ id, title: null, childrenIds, data: { itemContainer: { containerType: {} } } })
const pairs = (list) => list.flatMap((x) => [x.id, x])

const sidebar = () => ({
  sidebar: {
    containers: [
      { global: {} },
      {
        spaces: pairs([
          {
            id: 'work',
            title: 'Work',
            newContainerIDs: [{ unpinned: { _0: { shared: {} } } }, 'work-loose', { pinned: {} }, 'work-pinned'],
            customInfo: { windowTheme: { primaryColorPalette: { shaded: { red: 1, green: 0.5, blue: -0.2 } } } }
          },
          { id: 'old', containerIDs: ['pinned', 'old-pinned', 'unpinned', 'old-loose'] }
        ]),
        items: pairs([
          box('work-pinned', ['mail', 'docs', 'split']),
          tab('mail', 'https://mail.example/', 'Inbox (3)', 'Mail'),
          folder('docs', 'Docs', ['doc', 'specs', 'script']),
          tab('doc', 'https://docs.example/a', 'Doc A'),
          folder('specs', 'Specs', ['spec']),
          tab('spec', 'https://docs.example/spec', ''),
          tab('script', 'javascript:alert(1)', 'Bad'),
          { id: 'split', title: null, childrenIds: ['half'], data: { splitView: {} } },
          tab('half', 'https://split.example/', 'Split'),
          box('work-loose', ['news']),
          tab('news', 'https://news.example/', 'News'),
          box('old-pinned', []),
          box('old-loose', ['legacy']),
          tab('legacy', 'http://legacy.example/', 'Legacy'),
          box('top-a', ['fav-a', 'fav-b']),
          box('top-b', ['fav-c']),
          tab('fav-a', 'https://a.example/', 'A'),
          tab('fav-b', 'https://b.example/', 'B'),
          tab('fav-c', 'https://a.example/', 'A again')
        ]),
        topAppsContainerIDs: [{ default: true }, 'top-a', { custom: { _0: {} } }, 'top-b']
      }
    ]
  }
})

test('parseArc reads spaces, folders, favorites and colors', () => {
  assert.deepEqual(parseArc(sidebar()), {
    favorites: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }],
    spaces: [
      {
        name: 'Work',
        color: '#ff8000',
        background: { light: { color: '#ff8000' }, dark: { color: '#ff8000' } },
        pinned: [
          { url: 'https://mail.example/', title: 'Mail', folder: '' },
          { url: 'https://docs.example/a', title: 'Doc A', folder: 'Docs' },
          { url: 'https://docs.example/spec', title: 'https://docs.example/spec', folder: 'Docs / Specs' },
          { url: 'https://split.example/', title: 'Split', folder: '' }
        ],
        tabs: [{ url: 'https://news.example/', title: 'News' }]
      },
      { name: 'Space 2', color: undefined, pinned: [], tabs: [{ url: 'http://legacy.example/', title: 'Legacy' }] }
    ]
  })
})

test('parseArc refuses a file that is not an Arc sidebar', () => {
  for (const json of [null, {}, { sidebar: { containers: [{ global: {} }] } }]) {
    assert.throws(() => parseArc(json), { code: 'bad_params', message: 'Not an Arc sidebar file' })
  }
})

test('importSetup adds everything once and starts new folders collapsed', () => {
  const s = S.load()
  const work = S.createSpace(s, { name: 'Work' })
  S.createTab(s, { url: 'https://docs.example/a', spaceId: work.id }, 0)
  S.setPinned(s, { pinned: true, folder: 'Docs' }, 0)
  const active = { ...s.activeTabBySpace }

  assert.deepEqual(S.importSetup(s, parseArc(sidebar()), 1), { spaces: 1, favorites: 2, pinned: 3, tabs: 2 })
  assert.deepEqual(s.spaces.map((x) => x.name), ['Home', 'Work', 'Space 2'])
  assert.deepEqual(s.collapsed, { [`${work.id}/Docs / Specs`]: true })
  assert.deepEqual(s.activeTabBySpace, active)
  assert.deepEqual(S.importSetup(s, parseArc(sidebar()), 2), { spaces: 0, favorites: 0, pinned: 0, tabs: 0 })
  assert.equal(s.tabs.length, 8)
})

test('modern Arc backgrounds retain observed gradient stops, alpha, intensity and semantic appearances', () => {
  const json = sidebar()
  const theme = windowTheme()
  const gradient = theme.background.single._0.style.color._0.blendedGradient._0
  gradient.baseColors = [
    { red: .29342764616012573, green: .4747055768966675, blue: .9740476012229919, alpha: 1, colorSpace: 'extendedSRGB' },
    { red: .9689435362815857, green: .8001104593276978, blue: .20635846257209778, alpha: 1, colorSpace: 'extendedSRGB' }
  ]
  gradient.modifiers.intensityFactor = .37948843149038464
  json.sidebar.containers[1].spaces[1].customInfo.windowTheme = theme
  const parsed = parseArc(json).spaces[0].background
  assert.deepEqual(parsed.light, {
    color: '#e6f0ff', colors: ['#4b79f8', '#f7cc35'], overlayColors: ['#00000000', '#cc339966'], intensity: .37948843149038464
  })
  assert.deepEqual(parsed.dark, { ...parsed.light, color: '#050d29' })
  const s = S.load()
  S.importSetup(s, parseArc(json, { profileId: 'Default' }), 1)
  assert.deepEqual(S.load(JSON.parse(JSON.stringify(s))).spaces.find((space) => space.arcSourceId === 'work').background, parsed)
})

test('semantic-only and appearance-specific backgrounds do not fall back to a gray accent wash', () => {
  const json = sidebar()
  const theme = windowTheme()
  const source = theme.background.single._0
  theme.background = { appearanceBased: { light: source, dark: structuredClone(source) } }
  theme.background.appearanceBased.dark.style.color._0.blendedGradient._0.baseColors = [{ red: 1, green: 0, blue: 0 }]
  delete theme.primaryColorPalette
  json.sidebar.containers[1].spaces[1].customInfo.windowTheme = theme
  let parsed = parseArc(json).spaces[0]
  assert.equal(parsed.color, undefined)
  assert.deepEqual(parsed.background.dark.colors, ['#ff0000'])
  delete theme.background
  parsed = parseArc(json).spaces[0]
  assert.deepEqual(parsed.background, { light: { color: '#e6f0ff' }, dark: { color: '#050d29' } })
})

test('malformed theme values never become CSS or fabricated black colors', () => {
  for (const bad of [null, {}, 'url(https://evil.example)', { red: '1', green: 0, blue: 0 }, { red: NaN, green: 0, blue: 0 }, { red: 1, green: 0, blue: 0, alpha: 2 }]) {
    const json = sidebar()
    json.sidebar.containers[1].spaces[1].customInfo.windowTheme = { primaryColorPalette: { shaded: bad } }
    assert.equal(parseArc(json).spaces[0].color, undefined)
    assert.equal(parseArc(json).spaces[0].background, undefined)
  }
  for (const invalid of ['url(x)', -1, 2, Infinity]) {
    const json = sidebar()
    const theme = windowTheme()
    theme.background.single._0.style.color._0.blendedGradient._0.modifiers.intensityFactor = invalid
    json.sidebar.containers[1].spaces[1].customInfo.windowTheme = theme
    assert.deepEqual(parseArc(json).spaces[0].background.light, { color: '#e6f0ff' })
  }
  const json = sidebar()
  const theme = windowTheme()
  const gradient = theme.background.single._0.style.color._0.blendedGradient._0
  json.sidebar.containers[1].spaces[1].customInfo.windowTheme = theme
  for (const stops of [[{ red: 1, green: 'url(x)', blue: 0 }], Array(17).fill({ red: 1, green: 0, blue: 0 })]) {
    gradient.baseColors = stops
    assert.deepEqual(parseArc(json).spaces[0].background.light, { color: '#e6f0ff' })
  }
})

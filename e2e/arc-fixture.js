'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Arc's modern theme shape for stored layers, so an import returns exactly those layers. The default colors are synthetic.
function windowTheme({ color, light, dark } = { color: '#4d73f2', light: { color: '#e6f0ff', colors: ['#4d73f2', '#f2bf33'], overlayColors: ['#00000000', '#cc339966'], intensity: .4 }, dark: { color: '#050d29' } }) {
  const rgb = (hex) => {
    const [red, green, blue, alpha = 1] = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
    return { red, green, blue, alpha, colorSpace: 'extendedSRGB' }
  }
  return {
    primaryColorPalette: { shaded: rgb(color) },
    semanticColorPalette: { appearanceBased: {
      light: { background: rgb(light.color) },
      dark: { background: rgb(dark.color) }
    } },
    background: { single: { _0: {
      style: { color: { _0: { blendedGradient: { _0: {
        baseColors: light.colors.map(rgb),
        overlayColors: light.overlayColors.map(rgb),
        modifiers: { intensityFactor: light.intensity, noiseFactor: 0, overlay: 'grain' },
        wheel: { complimentary: {} }, translucencyStyle: 'light'
      } } } } },
      isVibrant: true, contentOverBackgroundAppearance: 'light'
    } } }
  }
}
// The Work favorite sits on a host no test serves. Only Arc's icon database has its icon, so its site must never be asked.
const workFavorite = (origin) => `${origin.replace('127.0.0.1', 'localhost')}/favorite?profile=1`
// themes: stored layers per profile, in profile order.
function writeArc(home, origin, { count = 2, malformed = false, missing = false, themes = [] } = {}) {
  const root = path.join(home, 'Library', 'Application Support', 'Arc')
  if (missing) return root
  const container = { spaces: [], items: [], topAppsContainerIDs: [] }
  const cache = {}
  for (let index = 0; index < count; index++) {
    const id = index ? `Profile ${index}` : 'Default'
    const name = index < 2 ? ['Personal', 'Work'][index] : `Research profile ${index} with a deliberately long descriptive label`
    const profile = index ? { custom: { _0: { directoryBasename: id } } } : { default: {} }
    cache[id] = { name }
    fs.mkdirSync(path.join(root, 'User Data', id), { recursive: true })
    const item = (suffix, title) => ({ id: `${index}-${suffix}`, title, data: { tab: { savedURL: suffix === 'favorite' && index === 1 ? workFavorite(origin) : `${origin}/${suffix}?profile=${index}`, savedTitle: title } } })
    container.spaces.push({ id: `space-${index}`, title: name.slice(0, 60), profile,
      ...(themes[index] && { customInfo: { windowTheme: windowTheme(themes[index]) } }),
      newContainerIDs: [{ pinned: {} }, `${index}-folder`, { unpinned: {} }, `${index}-open`] })
    container.items.push(item('favorite', `${name} favorite`), item('pinned', `${name} reference`), item('open', `${name} reading`),
      { id: `${index}-folder`, title: 'Reference folder', data: { list: {} }, childrenIds: [`${index}-pinned`] })
    container.topAppsContainerIDs.push(profile, `${index}-favorite`)
  }
  fs.writeFileSync(path.join(root, 'User Data', 'Local State'), JSON.stringify({ profile: { info_cache: cache } }))
  fs.writeFileSync(path.join(root, 'StorableSidebar.json'), malformed ? '{not JSON' : JSON.stringify({ sidebar: { containers: [container] } }))
  return root
}

// Real SQLite files with deliberately unsupported schemas: partial warnings without
// encrypted records, credentials, or any reason to consult the user's Keychain.
// The second profile also gets a Favicons database in Chromium's layout with one 32px icon.
function writeDatabases(home, origin) {
  const root = path.join(home, 'Library', 'Application Support', 'Arc', 'User Data')
  if (!fs.existsSync(root)) return
  const { DatabaseSync } = require('node:sqlite')
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of ['Login Data', 'Cookies']) {
      const file = path.join(root, entry.name, name)
      if (fs.existsSync(file)) continue
      const db = new DatabaseSync(file)
      try { db.exec('CREATE TABLE synthetic_fixture (id INTEGER PRIMARY KEY)') } finally { db.close() }
    }
  }
  const icons = path.join(root, 'Profile 1', 'Favicons')
  if (!fs.existsSync(path.dirname(icons)) || fs.existsSync(icons)) return
  const db = new DatabaseSync(icons)
  try {
    db.exec(`CREATE TABLE favicons (id INTEGER PRIMARY KEY, url LONGVARCHAR NOT NULL);
      CREATE TABLE icon_mapping (id INTEGER PRIMARY KEY, page_url LONGVARCHAR NOT NULL, icon_id INTEGER);
      CREATE TABLE favicon_bitmaps (id INTEGER PRIMARY KEY, icon_id INTEGER NOT NULL, last_updated INTEGER DEFAULT 0, image_data BLOB, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0)`)
    db.prepare('INSERT INTO favicons VALUES (1, ?)').run(new URL('/arc-icon.png', workFavorite(origin)).href)
    db.prepare('INSERT INTO icon_mapping (page_url, icon_id) VALUES (?, 1)').run(workFavorite(origin))
    db.prepare('INSERT INTO favicon_bitmaps (icon_id, image_data, width, height) VALUES (1, ?, 32, 32)').run(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mPQnxdNU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAADFoD1MoRwaAAAAAElFTkSuQmCC', 'base64'))
  } finally { db.close() }
}

module.exports = { writeArc, writeDatabases, windowTheme }

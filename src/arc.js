'use strict'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const list = (v) => (Array.isArray(v) ? v : [])
const text = (v) => (typeof v === 'string' ? v.trim() : '')
const isWeb = (url) => typeof url === 'string' && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)
const plain = ({ url, title, sourceId }) => ({ url, title, ...(sourceId && { sourceId }) })

function containerId(space, kind) {
  const ids = list(space.newContainerIDs)
  const old = list(space.containerIDs)
  const i = ids.findIndex((x) => isObject(x) && kind in x)
  const j = old.indexOf(kind)
  return i >= 0 ? ids[i + 1] : j >= 0 ? old[j + 1] : undefined
}

function hex(shade, alpha = false) {
  if (!isObject(shade) || !['red', 'green', 'blue'].every((key) => Number.isFinite(shade[key]))) return undefined
  if (shade.colorSpace !== undefined && !['extendedSRGB', 'sRGB'].includes(shade.colorSpace)) return undefined
  if (shade.alpha !== undefined && (!Number.isFinite(shade.alpha) || shade.alpha < 0 || shade.alpha > 1)) return undefined
  const part = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${part(shade.red)}${part(shade.green)}${part(shade.blue)}${alpha && shade.alpha !== undefined && shade.alpha !== 1 ? part(shade.alpha) : ''}`
}

function background(theme) {
  if (!isObject(theme)) return undefined
  const result = {}
  for (const appearance of ['light', 'dark']) {
    const source = theme.background?.appearanceBased?.[appearance] || theme.background?.single?._0
    const gradient = source?.style?.color?._0?.blendedGradient?._0
    const palette = theme.semanticColorPalette?.appearanceBased?.[appearance]
    const base = hex(palette?.background, true) || hex(theme.primaryColorPalette?.shaded, true)
    const stops = (values) => {
      if (!Array.isArray(values) || values.length > 16) return undefined
      const colors = values.map((value) => hex(value, true))
      return colors.every(Boolean) ? colors : undefined
    }
    const colors = stops(gradient?.baseColors)
    const overlayColors = stops(gradient?.overlayColors ?? [])
    const intensity = gradient?.modifiers?.intensityFactor ?? 1
    const color = base || colors?.[0]
    if (!color) continue
    result[appearance] = { color }
    if (colors?.length && overlayColors && Number.isFinite(intensity) && intensity >= 0 && intensity <= 1) {
      Object.assign(result[appearance], { colors, overlayColors, intensity })
    }
  }
  return Object.keys(result).length ? result : undefined
}

function profileId(profile) {
  if (!profile || Object.hasOwn(profile, 'default')) return 'Default'
  return text(profile.custom?._0?.directoryBasename) || null
}

function parseArc(json, { profileId: selected } = {}) {
  const container = list(json?.sidebar?.containers).find((c) => isObject(c) && 'items' in c)
  if (!container || !Array.isArray(container.items) || !Array.isArray(container.spaces)) throw Object.assign(new Error('Not an Arc sidebar file'), { code: 'bad_params' })
  const items = new Map(container.items.filter(isObject).map((x) => [x.id, x]))
  const walk = (id, path = [], out = [], seen = new Set(), folders = [], parentSourceId = null) => {
    const item = items.get(id)
    if (!item || seen.has(id)) return out
    seen.add(id)
    const tab = item.data?.tab
    if (isObject(tab)) {
      if (isWeb(tab.savedURL)) out.push({ url: tab.savedURL, title: text(item.title) || text(tab.savedTitle) || tab.savedURL, folder: path.join(' / '), ...(parentSourceId && { folderSourceId: parentSourceId }), ...(selected !== undefined && { sourceId: item.id }) })
      return out
    }
    const isFolder = isObject(item.data?.list)
    const next = isFolder ? [...path, text(item.title) || 'Folder'] : path
    if (isFolder) folders.push({ sourceId: item.id, name: next.at(-1), parentSourceId })
    for (const child of list(item.childrenIds)) walk(child, next, out, seen, folders, isFolder ? item.id : parentSourceId)
    return out
  }
  const seen = new Set()
  const urls = new Set()
  const tops = list(container.topAppsContainerIDs)
  const roots = tops.filter((id, i) => typeof id === 'string' && (selected === undefined || profileId(isObject(tops[i - 1]) ? tops[i - 1] : undefined) === selected))
  const favorites = roots.flatMap((id) => walk(id, [], [], seen)).filter((t) => !urls.has(t.url) && urls.add(t.url))
  return {
    favorites: favorites.map(plain),
    spaces: container.spaces.filter(isObject).map((space, i) => ({ space, i })).filter(({ space }) => selected === undefined || profileId(space.profile) === selected).map(({ space, i }) => {
      const theme = background(space.customInfo?.windowTheme)
      const folders = []
      const pinned = walk(containerId(space, 'pinned'), [], [], new Set(), folders)
      return {
        name: text(space.title) || `Space ${i + 1}`,
        ...(selected !== undefined && { sourceId: space.id }),
        color: hex(space.customInfo?.windowTheme?.primaryColorPalette?.shaded),
        ...(theme && { background: theme }),
        ...(folders.length && { folders }),
        pinned,
        tabs: walk(containerId(space, 'unpinned')).map(plain)
      }
    })
  }
}

module.exports = { parseArc }

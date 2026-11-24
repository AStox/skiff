'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseArc } = require('./arc')
const S = require('./state')
const log = require('./log').scope('importer')
const F = require('./favicons')
const { discoverArc, readArcSecrets, readArcIcons } = require('./migration')

const partitionOf = (profileId) => 'persist:arc-' + crypto.createHash('sha256').update(profileId).digest('hex').slice(0, 24)

// Gives every Arc tab of one profile the icon Arc saved for it, replacing the one it had. Returns how many tabs changed.
// Needs no Electron: state is a loaded state object, profilePath is `<Arc>/User Data/<profile folder>`.
function fillArcIcons(state, faviconDir, profilePath) {
  const partition = partitionOf(path.basename(profilePath))
  const tabs = state.tabs.filter((tab) => tab.arcSourceId && tab.sessionPartition === partition)
  const icons = readArcIcons(profilePath, tabs.map((tab) => tab.url))
  let filled = 0
  for (const tab of tabs) {
    const icon = icons.get(tab.url)
    const favicon = icon ? F.storeIcon(faviconDir, icon.url, icon.bytes) : ''
    if (!favicon || favicon === tab.favicon) continue
    tab.favicon = favicon
    filled++
  }
  return filled
}

function createImporter({ home, state, changed, getSession, confirm, vault, faviconDir, platform = process.platform, discover = discoverArc, readSecrets = readArcSecrets }) {
  let busy = false
  const sidebar = (root) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'StorableSidebar.json'), 'utf8'))
    } catch {
      throw S.err('not_found', 'Arc sidebar could not be read. Open Arc once, then try again.')
    }
  }
  const preview = ({ profileId } = {}) => {
    const source = discover(home)
    const sourceSidebar = sidebar(source.root)
    const counts = { spaces: 0, favorites: 0, pinned: 0, tabs: 0 }
    for (const profile of source.profiles) {
      if (profileId !== undefined && profile.id !== profileId) continue
      const setup = parseArc(sourceSidebar, { profileId: profile.id })
      counts.spaces += setup.spaces.length
      counts.favorites += setup.favorites.length
      for (const space of setup.spaces) {
        counts.pinned += space.pinned.length
        counts.tabs += space.tabs.length
      }
    }
    return {
      supported: platform === 'darwin',
      profiles: source.profiles.map(({ id, name }) => ({ id, name })),
      counts
    }
  }
  const run = async (p) => {
    if (busy) throw S.err('bad_params', 'An Arc import is already running.')
    const categories = p.categories
    if (!S.isObject(categories) || !['tabs', 'openTabs', 'passwords', 'logins'].every((k) => typeof categories[k] === 'boolean')) throw S.err('bad_params', 'Choose the categories to import.')
    if (!Object.values(categories).some((v) => v === true)) throw S.err('bad_params', 'Choose at least one category.')
    if (typeof p.keepSpaces !== 'boolean') throw S.err('bad_params', 'keepSpaces must be true or false.')
    if ((categories.passwords || categories.logins) && platform !== 'darwin') throw S.err('bad_params', 'Password and sign-in migration requires macOS.')
    const source = discover(home)
    if (!Array.isArray(p.profileIds) || !p.profileIds.length || !p.profileIds.every((id) => typeof id === 'string')) throw S.err('bad_params', 'Choose Arc profiles from the preview.')
    const profilesById = new Map(source.profiles.map((profile) => [profile.id, profile]))
    const profiles = [...new Set(p.profileIds)].map((id) => profilesById.get(id))
    if (profiles.some((profile) => !profile)) throw S.err('bad_params', 'Choose Arc profiles from the preview.')
    busy = true
    const t = Date.now()
    log.info('import begin', { profiles: profiles.length, categories, keepSpaces: p.keepSpaces })
    try {
      // One consent covers the selection, before any protected database or Keychain access.
      if ((categories.passwords || categories.logins) && !(await confirm(profiles.map((profile) => profile.name), categories))) { log.info('import cancelled', { ms: Date.now() - t }); return { cancelled: true } }
      const sourceSidebar = sidebar(source.root)
      const result = { spaces: 0, favorites: 0, pinned: 0, tabs: 0, passwords: { imported: 0, skipped: 0, failed: 0 }, logins: { imported: 0, skipped: 0, failed: 0 }, warnings: [], profiles: [] }
      for (const profile of profiles) {
        const imported = { id: profile.id, name: profile.name, spaces: 0, favorites: 0, pinned: 0, tabs: 0, passwords: { imported: 0, skipped: 0, failed: 0 }, logins: { imported: 0, skipped: 0, failed: 0 }, warnings: [] }
        try {
          const partition = partitionOf(profile.id)
          const setup = parseArc(sourceSidebar, { profileId: profile.id })
          if (categories.passwords || categories.logins) {
            try {
              const data = await readSecrets({ profilePath: profile.path, passwords: categories.passwords, logins: categories.logins })
              imported.warnings.push(...data.warnings)
              imported.passwords.skipped += data.passwordSkipped
              imported.passwords.failed += data.passwordFailed
              imported.logins.skipped += data.cookieSkipped
              imported.logins.failed += data.cookieFailed
              if (categories.passwords) {
                try {
                  const stored = vault.import(data.passwords, partition)
                  for (const key of ['imported', 'skipped', 'failed']) imported.passwords[key] += stored[key]
                } catch (e) {
                  log.error('password store failed', { profile: profile.id, err: e?.stack })
                  imported.passwords.failed += data.passwords.length
                  imported.warnings.push('Saved passwords could not be stored securely. No existing passwords were replaced.')
                }
              }
              if (categories.logins) {
                try {
                  const cookies = getSession(partition).cookies
                  // Preserve newer destination sessions on repeated imports.
                  const existing = new Set((await cookies.get({})).map((c) => JSON.stringify([c.domain, c.path, c.name])))
                  for (const cookie of data.cookies) {
                    const domain = cookie.domain || new URL(cookie.url).hostname
                    const key = JSON.stringify([domain, cookie.path || '/', cookie.name])
                    if (existing.has(key)) { imported.logins.skipped++; continue }
                    try {
                      await cookies.set(cookie)
                      existing.add(key)
                      imported.logins.imported++
                    } catch {
                      imported.logins.failed++
                    }
                  }
                  await cookies.flushStore()
                } catch (e) {
                  log.error('sign-in save failed', { profile: profile.id, err: e?.stack })
                  imported.warnings.push('Website sign-ins could not be saved completely. Retry sign-ins after restarting Skiff.')
                }
                imported.warnings.push('Some sites require you to sign in again. Site storage and passkeys are not transferred.')
              }
            } catch (e) {
              log.error('protected data read failed', { profile: profile.id, err: e?.stack })
              imported.warnings.push('Arc protected data could not be read; its records were not counted. Allow the macOS Keychain prompt, then retry the selected categories.')
            }
          }
          setup.sessionPartition = partition
          if (!categories.tabs) {
            setup.favorites = []
            for (const space of setup.spaces) space.pinned = []
          }
          if (!categories.openTabs) for (const space of setup.spaces) space.tabs = []
          if (!p.keepSpaces || (!categories.tabs && !categories.openTabs)) {
            setup.spaces = [{ name: `Arc ${profile.name}`.slice(0, 60), pinned: setup.spaces.flatMap((s) => s.pinned), tabs: setup.spaces.flatMap((s) => s.tabs) }]
          }
          // A profile space makes imported sign-ins and passwords available to new tabs.
          if (!setup.spaces.length) setup.spaces = [{ name: `Arc ${profile.name}`.slice(0, 60), pinned: [], tabs: [] }]
          Object.assign(imported, S.importSetup(state, setup, Date.now()))
          if (categories.tabs || categories.openTabs) fillArcIcons(state, faviconDir, profile.path)
          changed()
        } catch (e) {
          log.error('profile import failed', { profile: profile.id, err: e?.stack })
          imported.warnings.push('This profile could not be imported completely. Any unfinished tab and space additions were not counted; retry this profile.')
        }
        log.debug('import profile done', { profile: profile.id, spaces: imported.spaces, favorites: imported.favorites, pinned: imported.pinned, tabs: imported.tabs, passwords: imported.passwords, logins: imported.logins, warnings: imported.warnings.length })
        result.profiles.push(imported)
        for (const key of ['spaces', 'favorites', 'pinned', 'tabs']) result[key] += imported[key]
        for (const category of ['passwords', 'logins']) {
          for (const key of ['imported', 'skipped', 'failed']) result[category][key] += imported[category][key]
        }
        result.warnings.push(...imported.warnings.map((warning) => `${profile.name}: ${warning}`))
      }
      log.info('import end', { ms: Date.now() - t, profiles: result.profiles.length, spaces: result.spaces, favorites: result.favorites, pinned: result.pinned, tabs: result.tabs, passwords: result.passwords, logins: result.logins, warnings: result.warnings.length })
      return result
    } catch (e) {
      log.error('import failed', { ms: Date.now() - t, err: e?.stack })
      throw e
    } finally {
      busy = false
    }
  }
  return { preview, run }
}

module.exports = { createImporter, fillArcIcons }

'use strict'

const SWATCHES = ['#4f6bed', '#7c5ce0', '#d6336c', '#c2700e', '#2f9e5b', '#5f6b7a']
const $ = (id) => document.getElementById(id)
const address = $('address')
const pageEl = $('page')
const relative = new Intl.RelativeTimeFormat(undefined, { style: 'narrow' })

let state = null
let lastBounds = ''
const ui = { archive: false, settings: false, renaming: false, imported: '', filling: false, extensions: [], agents: [], agentForm: null, agentError: '', warmed: '' }
const drawn = {}
const importDialog = $('arc-import')
let importer = null

function showError(message) {
  $('shell-error-message').textContent = message
  $('shell-error').hidden = false
}

const call = (method, params) => skiff.call(method, params).catch((error) => {
  showError(`${error.message || 'That action could not finish.'} Try again.`)
})

let confirmation = null
function confirmAction(title, description, label, method, params) {
  confirmation = { method, params, trigger: document.activeElement }
  $('confirm-title').textContent = title
  $('confirm-description').textContent = description
  $('confirm-accept').textContent = label
  $('confirm-box').hidden = false
  $('confirm-cancel').focus()
}

function closeConfirmation() {
  const trigger = confirmation?.trigger
  confirmation = null
  $('confirm-box').hidden = true
  if (trigger?.isConnected) trigger.focus()
  else $('settings-toggle').focus()
}

function ago(time) {
  const minutes = Math.round((time - Date.now()) / 60e3)
  if (minutes > -60) return relative.format(minutes, 'minute')
  if (minutes > -1440) return relative.format(Math.round(minutes / 60), 'hour')
  return relative.format(Math.round(minutes / 1440), 'day')
}

function section(id, key, build) {
  const k = JSON.stringify(key)
  if (drawn[id] === k) return
  drawn[id] = k
  const focused = document.activeElement
  const inside = $(id).contains(focused)
  const focusedSpace = inside ? focused.dataset.spaceId : null
  const focusId = inside ? focused.id : null
  const focusLabel = inside ? focused.getAttribute('aria-label') : null
  const focusedTab = inside ? focused.closest('[data-tab-id]')?.dataset.tabId : null
  $(id).replaceChildren(...[build()].flat(Infinity).filter((child) => child != null && child !== false))
  if (focusedSpace) focusSpace(focusedSpace)
  else if (focusId) $(focusId)?.focus({ preventScroll: true })
  else if (focusedTab) {
    const row = $(id).querySelector(`[data-tab-id="${CSS.escape(focusedTab)}"]`)
    row?.querySelector('.row-main, .tile-main')?.focus({ preventScroll: true })
    if (focusLabel) row?.querySelector(`[aria-label="${CSS.escape(focusLabel)}"]`)?.focus({ preventScroll: true })
  } else if (focusLabel) $(id).querySelector(`[aria-label="${CSS.escape(focusLabel)}"]`)?.focus({ preventScroll: true })
}

const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId)
const activeTab = () => state.tabs.find((t) => t.id === state.activeTabBySpace[state.activeSpaceId])

async function show(tab) {
  try {
    await skiff.call('tabs.activate', { id: tab.id })
    call('ui.focusPage')
  } catch (error) {
    showError(`${error.message || 'This tab could not open.'} Try again.`)
  }
}

const MOVE_HINT = 'Drag to reorder, pin or favorite. Alt+Shift+Up/Down moves it, also between sections. Alt+Shift+Left/Right changes space.'
const MOVE_KEYS = 'Alt+Shift+ArrowUp Alt+Shift+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight'

function tabRow(tab, current, depth) {
  const row = h('li', {
    class: `row${current ? ' current' : ''}${tab.loading ? ' loading' : ''}${tab.folder ? ' nested' : ''}`,
    'data-tab-id': tab.id, 'data-section': tab.pinned ? 'pinned' : 'tabs', 'data-folder': tab.pinned ? tab.folder || '' : null,
    'data-depth': depth, 'data-parent': depth ? tab.parentId : null, 'aria-level': depth == null ? null : depth + 1, draggable: 'true',
    ondragstart: (event) => startDrag(event, 'tab', tab.id),
    onkeydown: (event) => moveTabWithKeyboard(event, tab)
  },
    h('button', { class: 'row-main', title: `${tab.url}\n${MOVE_HINT}`, 'aria-keyshortcuts': MOVE_KEYS, 'aria-current': current ? 'true' : null, onclick: () => show(tab) },
      favicon(tab), h('span', { class: 'label' }, tab.title || tab.url)),
    h('button', { class: 'icon-btn reveal', title: 'Close tab', 'aria-label': 'Close tab', onclick: () => call('tabs.close', { id: tab.id }) }, icon('x')))
  if (depth != null) row.style.setProperty('--depth', String(Math.min(depth, 6)))
  return row
}

// ponytail: quadratic child scan; index children by parentId if a space reaches thousands of tabs
function trail(plain) {
  const ids = new Set(plain.map((t) => t.id))
  const depths = new Map()
  const walk = (tab, depth) => {
    depths.set(tab, depth)
    for (const child of plain) if (child.parentId === tab.id && !depths.has(child)) walk(child, depth + 1)
  }
  for (const tab of plain) if (!ids.has(tab.parentId)) walk(tab, 0)
  // Tabs left over sit on a parent cycle; each becomes a root.
  for (const tab of plain) if (!depths.has(tab)) walk(tab, 0)
  return [...depths]
}

function tabRows(space, tabs, row) {
  const pinned = tabs.filter((t) => t.pinned)
  const folders = [...new Set(pinned.map((t) => t.folder).filter(Boolean))]
  return [
    pinned.filter((t) => !t.folder).map((t) => row(t)),
    folders.map((folder) => {
      const inside = pinned.filter((t) => t.folder === folder)
      const open = !state.collapsed[`${space.id}/${folder}`]
      return [
        h('li', { class: 'row', 'data-folder-head': folder },
          h('button', { class: 'row-main', title: folder, 'aria-expanded': String(open), onclick: () => call('folders.setCollapsed', { spaceId: space.id, folder, collapsed: open }) },
            icon('chevron'), h('span', { class: 'label' }, folder), h('span', { class: 'when' }, String(inside.length)))),
        open ? inside.map((t) => row(t)) : []
      ]
    }),
    pinned.length ? h('li', { class: 'divider', 'aria-hidden': 'true' }) : [],
    trail(tabs.filter((t) => !t.pinned)).map(([t, depth]) => row(t, depth))
  ]
}

function favoriteTile(tab, current) {
  return h('div', {
    class: `tile${current ? ' current' : ''}${tab.loading ? ' loading' : ''}`, 'data-tab-id': tab.id, draggable: 'true',
    ondragstart: (event) => startDrag(event, 'tab', tab.id),
    onkeydown: (event) => moveTabWithKeyboard(event, tab)
  }, h('button', { class: 'tile-main', title: `${tab.title || tab.url}\n${MOVE_HINT}`, 'aria-label': tab.title || tab.url, 'aria-keyshortcuts': MOVE_KEYS, 'aria-current': current ? 'true' : null, onclick: () => show(tab) }, favicon(tab, icon('globe'))))
}

function archiveRows() {
  if (!state.archive.length) return h('li', { class: 'hint archive-empty' }, h('strong', {}, 'Nothing archived yet'), h('p', {}, 'Closed and auto-archived tabs appear here. Favorites and pinned tabs stay put.'))
  return [
    h('li', { class: 'list-head' }, h('span', { class: 'label' }, `${state.archive.length} archived tabs`),
      h('button', { id: 'archive-clear', class: 'text-btn', onclick: () => confirmAction('Clear the archive?', 'Permanently remove all archived tabs. Open tabs and favorites are not affected.', 'Clear archive', 'archive.clear') }, 'Clear')),
    state.archive.map((entry) => h('li', { class: 'row' },
      h('button', { class: 'row-main', title: entry.url, onclick: () => restore(entry) },
        favicon(entry), h('span', { class: 'label' }, entry.title || entry.url), h('span', { class: 'when' }, ago(entry.archivedAt)))))
  ]
}

async function restore(entry) {
  try {
    await skiff.call('archive.restore', { id: entry.id })
    ui.archive = false
    render()
    call('ui.focusPage')
  } catch (error) {
    showError(`${error.message || 'This archived tab could not be restored.'} Try again.`)
  }
}

const importCategories = [
  ['tabs', 'Favorites and pinned tabs', 'Bring your saved sidebar items and folders.'],
  ['openTabs', 'Open tabs', 'Import regular tabs asleep, without loading websites.'],
  ['passwords', 'Saved passwords', 'Save locally in Skiff. Use “Fill saved password” when you need one.'],
  ['logins', 'Website sign-ins', 'Keep each profile’s sessions separate. Some sites will require you to sign in again.']
]
const defaultImportCategories = () => ({ tabs: true, openTabs: true, passwords: false, logins: false })
const importCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 'Not reported'

function importSummary(rows) {
  return h('dl', { class: 'import-summary' }, rows.flatMap(([label, value]) => [
    h('dt', {}, label), h('dd', {}, String(value))
  ]))
}

function importResultSummary(result, categories) {
  const rows = [['Spaces imported', importCount(result.spaces)]]
  if (categories.tabs) rows.push(['Favorites imported', importCount(result.favorites)], ['Pinned tabs imported', importCount(result.pinned)])
  if (categories.openTabs) rows.push(['Open tabs imported', importCount(result.tabs)])
  for (const [key, label] of importCategories.slice(2)) {
    const counts = result[key]
    rows.push([key === 'logins' ? 'Sign-in cookies' : label, !categories[key] ? 'Not selected' : counts
      ? `${importCount(counts.imported)} imported · ${importCount(counts.skipped)} skipped · ${importCount(counts.failed)} failed`
      : 'No result reported'])
  }
  return importSummary(rows)
}

function importOption(type, name, checked, label, description, onchange, disabled = false) {
  return h('label', { class: 'import-option' },
    h('input', { type, name, checked, disabled, onchange }),
    h('span', {}, label, description ? h('small', {}, description) : []))
}

function renderImport(focus = true) {
  const flow = importer
  if (!flow) return
  const { phase, preview, categories, result } = flow
  const busy = phase === 'loading' || phase === 'importing' || phase === 'closing'
  const profiles = preview?.profiles.filter((p) => flow.profileIds?.has(p.id)) || []
  const content = []
  const titles = {
    loading: 'Find your Arc profiles',
    profile: 'Choose Arc profiles',
    categories: 'Choose what to bring',
    review: 'Ready to import?',
    importing: 'Importing from Arc',
    results: 'Import results',
    error: 'Could not read Arc',
    closing: 'Returning to Skiff'
  }
  $('arc-title').textContent = titles[phase]
  $('arc-description').textContent = phase === 'profile'
    ? 'Choose profiles. Their website sessions stay separate.'
    : profiles.length ? `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'} selected · Nothing is uploaded`
      : 'Bring your Arc profiles into Skiff.'
  const step = ['loading', 'error', 'profile'].includes(phase) ? 'profile' : phase === 'categories' ? 'categories' : 'review'
  for (const item of $('arc-steps').children) {
    if (item.dataset.step === step) item.setAttribute('aria-current', 'step')
    else item.removeAttribute('aria-current')
  }
  importDialog.dataset.phase = phase
  $('arc-status').textContent = flow.notice || ''
  $('arc-error').textContent = flow.error || ''
  $('arc-content').setAttribute('aria-busy', String(busy))

  if (busy) {
    content.push(h('div', { class: 'import-working' },
      h('span', { class: 'import-spinner', 'aria-hidden': 'true' }),
      h('p', {}, phase === 'importing' ? 'Waiting for the import to finish…' : phase === 'closing' ? 'Restoring your page…' : 'Reading Arc profile names and sidebar…')))
    if (phase === 'importing') {
      content.push(h('p', { class: 'import-note' }, categories.passwords || categories.logins
        ? 'Approve or cancel the native confirmation. macOS may then ask for access to Arc’s Safe Storage key in Keychain. Nothing is uploaded.'
        : 'Tabs stay asleep. No passwords or website sign-ins are being read.'))
    }
  } else if (phase === 'profile') {
    const updateSelection = (clearError = true) => {
      if (clearError) {
        flow.error = ''
        $('arc-error').textContent = ''
      }
      $('arc-next').disabled = !flow.profileIds.size
      flow.notice = flow.profileIds.size
        ? `${flow.profileIds.size} of ${preview.profiles.length} profiles selected.`
        : 'Choose at least one profile to continue.'
      $('arc-status').textContent = flow.notice
    }
    const options = preview.profiles.map((p) => importOption('checkbox', 'arc-profile', flow.profileIds.has(p.id), p.name, '',
      (event) => {
        if (event.target.checked) flow.profileIds.add(p.id)
        else flow.profileIds.delete(p.id)
        updateSelection()
      }))
    const selectProfiles = (selected) => {
      flow.profileIds = new Set(selected ? preview.profiles.map((p) => p.id) : [])
      for (const option of options) option.querySelector('input').checked = selected
      updateSelection()
    }
    content.push(h('fieldset', { class: 'import-options' },
      h('legend', {}, 'Arc profiles'),
      h('div', { class: 'import-actions' },
        h('button', { type: 'button', class: 'text-btn', disabled: !preview.profiles.length, onclick: () => selectProfiles(true) }, 'Select all'),
        h('button', { type: 'button', class: 'text-btn', disabled: !preview.profiles.length, onclick: () => selectProfiles(false) }, 'Clear selection')),
      options))
    if (preview.profiles.length) updateSelection(false)
    if (!preview.profiles.length) content.push(h('p', { class: 'import-note' }, 'No Arc profiles were found. Open Arc once on this Mac, then try again.'))
    if (preview.counts) {
      content.push(h('p', { class: 'import-note' },
        `In Arc: ${importCount(preview.counts.spaces)} spaces · ${importCount(preview.counts.favorites)} favorites · ${importCount(preview.counts.pinned)} pinned · ${importCount(preview.counts.tabs)} open tabs. Counts include all profiles.`))
    }
    content.push(h('p', { class: 'import-note' }, 'Preview reads names and sidebar only. It never reads passwords, sign-ins or Keychain.'))
  } else if (phase === 'categories') {
    content.push(h('fieldset', { class: 'import-options' },
      h('legend', {}, 'Include in this import'),
      importCategories.map(([key, label, description]) => importOption('checkbox', key, categories[key], label, description,
        (event) => { categories[key] = event.target.checked; flow.error = ''; $('arc-error').textContent = '' },
        !preview.supported && (key === 'passwords' || key === 'logins')))))
    content.push(importOption('checkbox', 'keepSpaces', flow.keepSpaces, 'Keep Arc spaces',
      'Otherwise, collect each profile’s tabs in its own new Arc space.',
      (event) => { flow.keepSpaces = event.target.checked }))
    content.push(h('p', { class: 'import-note' }, preview.supported
      ? 'Passwords and sign-ins are optional and stay on this Mac. Before either is read, Skiff asks for native confirmation; macOS may also show a Keychain prompt.'
      : 'Password and sign-in import is available only on macOS. You can still import tabs.'))
  } else if (phase === 'review') {
    content.push(importSummary([
      ['Profiles', profiles.map((p) => p.name).join(', ')],
      ...importCategories.map(([key, label]) => [label, categories[key] ? 'Include' : 'Do not import']),
      ['Spaces', flow.keepSpaces ? 'Keep Arc spaces for each profile' : 'One space per Arc profile']
    ]))
    content.push(h('p', { class: 'import-note' }, 'Imported tabs stay asleep. Icons come from Arc. A site Arc has no icon for is asked once, without your sign-ins. Importing again skips items already imported.'))
    if (categories.passwords || categories.logins) {
      content.push(h('p', { class: 'import-note' }, 'Next, approve a native confirmation for the selected profiles. macOS may also request Arc’s Keychain key. Sensitive data stays local and sessions stay separate; some sites need a new sign-in.'))
    }
  } else if (phase === 'results') {
    content.push(h('h3', {}, 'All selected profiles'), importResultSummary(result, categories))
    const profileWarnings = new Set(result.profiles.flatMap((profile) => profile.warnings.flatMap((warning) => [warning, `${profile.name}: ${warning}`])))
    const sharedWarnings = result.warnings?.filter((warning) => !profileWarnings.has(warning)) || []
    if (sharedWarnings.length) {
      content.push(h('ul', { class: 'import-warnings import-note' },
        sharedWarnings.map((warning) => h('li', {}, warning))))
    }
    for (const profile of result.profiles) {
      content.push(h('details', { class: 'import-profile-result', open: profile.warnings.length ? true : null },
        h('summary', {}, h('h3', {}, profile.name)),
        importResultSummary(profile, categories),
        profile.warnings.length
          ? h('ul', { class: 'import-warnings import-note' }, profile.warnings.map((warning) => h('li', {}, warning)))
          : null))
    }
    content.push(h('p', { class: 'import-note' }, 'Skipped items were already present or could not be transferred. Back lets you retry.'))
    if (categories.passwords && result.passwords?.imported) {
      content.push(h('p', { class: 'import-note' }, 'Open the site in its imported space, then choose “Fill saved password” in Settings.'))
    }
  } else if (phase === 'error') {
    content.push(h('p', { class: 'import-note' }, 'Check that Arc is installed and has a profile on this computer, then try again.'))
  }
  $('arc-content').replaceChildren(...content)
  if (focus) $('arc-content').scrollTop = 0
  $('arc-cancel').textContent = phase === 'results' ? 'Done' : 'Cancel'
  $('arc-cancel').disabled = phase === 'importing' || phase === 'closing'
  $('arc-cancel').classList.toggle('import-primary', phase === 'results')
  $('arc-next').classList.toggle('import-primary', phase !== 'results')
  const actions = $('arc-cancel').parentElement
  actions.append(...(phase === 'results' ? [$('arc-next'), $('arc-back'), $('arc-cancel')] : [$('arc-cancel'), $('arc-back'), $('arc-next')]))
  $('arc-back').hidden = !['categories', 'review', 'results'].includes(phase)
  $('arc-back').disabled = busy
  $('arc-next').textContent = phase === 'review' ? 'Import' : phase === 'results' ? 'Import again' : phase === 'error' ? 'Try again' : 'Continue'
  $('arc-next').disabled = busy || (phase === 'profile' && !flow.profileIds.size)
  if (focus && importDialog.open) $('arc-title').focus()
}

async function loadArcPreview() {
  const flow = importer
  flow.phase = 'loading'
  flow.error = ''
  flow.notice = ''
  renderImport()
  try {
    const preview = await skiff.call('import.arc.preview', {})
    if (importer !== flow || flow.phase !== 'loading') return
    flow.preview = preview
    flow.profileIds = new Set(preview.profiles.filter((p) => !flow.profileIds || flow.profileIds.has(p.id)).map((p) => p.id))
    flow.phase = 'profile'
  } catch {
    if (importer !== flow || flow.phase !== 'loading') return
    flow.phase = 'error'
    flow.error = 'Arc could not be read. No sensitive data was accessed.'
  }
  renderImport()
}

async function importArc() {
  if (confirmation) return
  if (importer) {
    if (importDialog.open) $('arc-title').focus()
    return
  }
  importer = {
    phase: 'loading', categories: defaultImportCategories(), keepSpaces: true,
    trigger: document.activeElement, error: '', notice: ''
  }
  ui.renaming = false
  try {
    await skiff.call('ui.setPageVisible', { visible: false })
    renderImport(false)
    importDialog.showModal()
    $('arc-title').focus()
  } catch {
    importer = null
    ui.settings = true
    ui.archive = false
    ui.imported = 'The import window could not open. Try Import from Arc again.'
    try { await skiff.call('ui.setPageVisible', { visible: true }) } catch {}
    render()
    return
  }
  await loadArcPreview()
}

async function closeImport() {
  const flow = importer
  if (!flow || flow.phase === 'importing' || flow.phase === 'closing') return
  const previousPhase = flow.phase
  flow.phase = 'closing'
  renderImport()
  try {
    await skiff.call('ui.setPageVisible', { visible: true })
  } catch {
    flow.phase = previousPhase
    if (previousPhase === 'loading') await loadArcPreview()
    flow.error = 'Your page could not be restored. Try closing this dialog again.'
    renderImport()
    return
  }
  importer = null
  importDialog.close()
  const trigger = flow.trigger?.isConnected ? flow.trigger : $(flow.trigger?.id)
  const target = trigger && trigger !== document.body && trigger.getClientRects().length ? trigger : $('settings-toggle')
  target.focus()
}

async function advanceImport(event) {
  event.preventDefault()
  const flow = importer
  if (!flow) return
  if (flow.phase === 'profile') {
    if (!flow.profileIds.size) {
      flow.error = 'Choose at least one profile to import.'
      $('arc-error').textContent = flow.error
      $('arc-content').querySelector('input')?.focus()
      return
    }
    flow.phase = 'categories'
  } else if (flow.phase === 'categories') {
    if (!Object.values(flow.categories).some(Boolean)) {
      flow.error = 'Choose at least one category to import.'
      $('arc-error').textContent = flow.error
      $('arc-content').querySelector('input')?.focus()
      return
    }
    flow.phase = 'review'
  } else if (flow.phase === 'results') {
    flow.categories = defaultImportCategories()
    flow.keepSpaces = true
    flow.result = null
    await loadArcPreview()
    return
  } else if (flow.phase === 'error') {
    await loadArcPreview()
    return
  } else if (flow.phase === 'review') {
    flow.phase = 'importing'
    flow.error = ''
    flow.notice = ''
    renderImport()
    try {
      const result = await skiff.call('import.arc', {
        profileIds: [...flow.profileIds], categories: { ...flow.categories }, keepSpaces: flow.keepSpaces
      })
      if (result.cancelled) {
        flow.phase = 'review'
        flow.notice = 'Import cancelled. Nothing was imported.'
      } else {
        flow.result = result
        flow.phase = 'results'
        flow.notice = 'Import finished. Review the counts and any warnings below.'
      }
    } catch {
      flow.phase = 'review'
      flow.error = 'The import could not finish. Some items may have been imported. Go back to change your selection or retry; existing imports are skipped.'
    }
    renderImport()
    return
  } else return
  flow.error = ''
  flow.notice = ''
  renderImport()
}

async function fillSavedPassword() {
  if (ui.filling || importer) return
  ui.filling = true
  ui.imported = 'Choose an account in the native confirmation.'
  render()
  try {
    const result = await skiff.call('passwords.fill', {})
    ui.imported = result.cancelled ? 'Password fill cancelled.'
      : result.filled ? 'Saved password filled on the current website.'
      : result.reason === 'no-match' ? 'No saved password matches this website in this profile.'
      : result.reason === 'no-fields' ? 'No sign-in fields were found on this page.'
      : 'No password was filled.'
  } catch {
    ui.imported = 'The password could not be filled. Open the website’s sign-in page and try again.'
  }
  ui.filling = false
  render()
  $('fill-password')?.focus()
}

async function refreshExtensions() {
  const list = await call('extensions.list')
  if (!list) return
  ui.extensions = list
  render()
}

function popupBounds() {
  const r = pageEl.getBoundingClientRect()
  return { x: r.x + 8, y: r.y + 8, width: 440, height: Math.max(200, Math.min(680, r.height - 16)) }
}

async function openExtensionPopup() {
  if (!ui.extensions.length) await refreshExtensions()
  const entry = ui.extensions.find((e) => e.popup)
  if (!entry) {
    showToast('No extension has a panel.')
    return
  }
  call('extensions.popup', { id: entry.id, bounds: popupBounds() })
}

const extensionState = { installing: 'Installing…', updating: 'Updating…', failed: 'Failed' }

function extensionRows() {
  const modifier = navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl'
  return [
    h('div', { class: 'field-label', id: 'extensions-label' }, 'Extensions'),
    ui.extensions.length > 0 && h('ul', { class: 'extensions', 'aria-labelledby': 'extensions-label' },
      ui.extensions.map((e) => h('li', { class: 'extension', 'data-extension-id': e.id },
        h('span', { class: 'label', title: e.description || e.name }, e.name),
        h('span', { class: 'when' }, e.version || extensionState[e.state] || ''),
        h('span', { class: 'extension-actions' },
          h('button', { class: 'text-btn', disabled: !e.popup, onclick: () => call('extensions.popup', { id: e.id, bounds: popupBounds() }) }, 'Panel'),
          h('button', { class: 'text-btn', disabled: !e.options, onclick: () => call('extensions.open', { id: e.id }) }, 'Settings'),
          !e.builtin && h('button', { class: 'text-btn danger', onclick: () => confirmAction(`Remove ${e.name}?`, 'It stops running everywhere and its files are deleted.', 'Remove', 'extensions.remove', { id: e.id }) }, 'Remove')),
        e.builtin && e.state === 'failed' && h('p', { class: 'hint' }, `Could not ${e.version ? 'update' : 'install'}: ${e.error}`)))),
    h('p', { class: 'hint' }, `Built-in ones update themselves. None run in incognito. ${modifier}+Shift+U opens the panel of the first one.`)
  ]
}

const AGENT_PRESETS = [['omp', 'omp acp'], ['Gemini', 'gemini --acp'], ['Codex', 'npx -y @agentclientprotocol/codex-acp'], ['Claude', 'npx -y @agentclientprotocol/claude-agent-acp'], ['Hermes', 'hermes acp']]
const AGENT_STATUS = { idle: 'Not started', starting: 'Starting', ready: 'Ready', error: 'Could not start' }
const defaultAgent = () => state.settings.ai.agent || state.settings.ai.agents[0]?.name || ''

function uniqueAgentName(base) {
  const taken = new Set(state.settings.ai.agents.map((a) => a.name.toLowerCase()))
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`
  return name
}

function refreshAgents() {
  return skiff.call('ai.agents').then((list) => {
    ui.agents = list || []
    render()
  }).catch(() => {})
}

// The default agent starts once so its models and efforts can be listed.
function warmDefault() {
  const name = defaultAgent()
  const entry = ui.agents.find((a) => a.name === name)
  if (!entry || entry.models || entry.status === 'error' || ui.warmed === name) return
  ui.warmed = name
  skiff.call('ai.warm', { agent: name }).then((next) => {
    ui.agents = ui.agents.map((a) => (a.name === next?.name ? next : a))
    render()
  }).catch(() => {})
}

async function saveAgents(ai, done) {
  try {
    await skiff.call('settings.set', { ai })
    ui.agentError = ''
    done?.()
  } catch (error) {
    ui.agentError = error.message || 'That could not be saved. Try again.'
  }
  render()
  refreshAgents()
}

function addAgent() {
  const name = ui.agentForm.name.trim()
  const command = ui.agentForm.command.trim()
  ui.agentError = !command ? 'Enter the command that starts your agent.' : !name ? 'Give the agent a name.' : ''
  if (ui.agentError) return render()
  saveAgents({ agents: [...state.settings.ai.agents, { name, command }], agent: defaultAgent() || name }, () => { ui.agentForm = null })
}

function removeAgent(name) {
  const rest = state.settings.ai.agents.filter((a) => a.name !== name)
  const chosen = defaultAgent()
  saveAgents(chosen === name ? { agents: rest, agent: rest[0]?.name || '', model: '', effort: '' } : { agents: rest, agent: chosen })
}

function agentRows() {
  const form = ui.agentForm ||= { preset: AGENT_PRESETS[0][1], name: uniqueAgentName(AGENT_PRESETS[0][0]), command: AGENT_PRESETS[0][1], auto: true }
  const chosen = defaultAgent()
  const entry = ui.agents.find((a) => a.name === chosen)
  const name = h('input', { id: 'agent-name', type: 'text', maxlength: '40', spellcheck: 'false', autocomplete: 'off', value: form.name })
  const command = h('input', { id: 'agent-command', type: 'text', maxlength: '500', spellcheck: 'false', autocomplete: 'off', placeholder: 'omp acp', value: form.command })
  const preset = h('select', { id: 'agent-preset' },
    AGENT_PRESETS.map(([, value]) => h('option', { value, selected: form.preset === value }, value)),
    h('option', { value: '', selected: !form.preset }, 'Custom'))
  preset.addEventListener('change', () => {
    const pick = AGENT_PRESETS.find(([, value]) => value === preset.value)
    form.preset = preset.value
    if (pick) command.value = form.command = pick[1]
    if (pick && form.auto) name.value = form.name = uniqueAgentName(pick[0])
    command.focus()
  })
  name.addEventListener('input', () => Object.assign(form, { name: name.value, auto: false }))
  command.addEventListener('input', () => {
    form.command = command.value
    form.preset = preset.value = AGENT_PRESETS.some(([, value]) => value === command.value.trim()) ? command.value.trim() : ''
  })
  for (const field of [name, command]) field.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addAgent() } })
  const picker = (key, list) => {
    const current = state.settings.ai[key] || entry?.[key]
    const select = h('select', { id: `agent-${key}`, disabled: !list },
      list ? list.map((o) => h('option', { value: o.value, selected: o.value === current }, o.name || o.value)) : h('option', {}, entry?.status === 'error' ? 'Unavailable' : 'Loading...'))
    select.addEventListener('change', () => saveAgents({ model: state.settings.ai.model, effort: state.settings.ai.effort, [key]: select.value }))
    return select
  }
  return h('section', { id: 'agents-section', 'aria-labelledby': 'agents-label' },
    h('div', { class: 'field-label', id: 'agents-label' }, 'Agents'),
    h('ul', { id: 'agents-list', 'aria-labelledby': 'agents-label' }, state.settings.ai.agents.map((a) => {
      const live = ui.agents.find((x) => x.name === a.name)
      const status = live?.status || 'idle'
      return h('li', { class: 'agent', 'data-agent': a.name },
        h('span', { class: 'agent-dot', 'data-status': status, role: 'img', 'aria-label': AGENT_STATUS[status] || status, title: AGENT_STATUS[status] || status }),
        h('span', { class: 'agent-text' }, h('span', { class: 'label' }, a.name), h('code', { title: a.command }, a.command)),
        a.name === chosen ? h('span', { class: 'agent-default' }, 'Default') : h('button', { class: 'text-btn', onclick: () => saveAgents({ agent: a.name, model: '', effort: '' }) }, 'Make default'),
        h('button', { class: 'text-btn danger', 'aria-label': `Remove ${a.name}`, onclick: () => removeAgent(a.name) }, 'Remove'),
        status === 'error' && live.error && h('p', { class: 'hint' }, live.error))
    })),
    entry && h('div', { class: 'agent-defaults' },
      h('label', { class: 'field', for: 'agent-model' }, `Default model for ${entry.name}`, picker('model', entry.models)),
      h('label', { class: 'field', for: 'agent-effort' }, 'Default effort', picker('effort', entry.efforts))),
    h('label', { class: 'field', for: 'agent-preset' }, 'Add an agent', preset),
    h('label', { class: 'field', for: 'agent-name' }, 'Name', name),
    h('label', { class: 'field', for: 'agent-command' }, 'Command', command),
    h('p', { class: 'hint' }, "Runs in your login shell. Any agent that speaks the Agent Client Protocol works, locally or over ssh. Over ssh the agent can chat but cannot reach this browser's tools."),
    h('button', { id: 'agent-add', class: 'text-btn', onclick: addAgent }, 'Add agent'),
    h('p', { class: 'hint error', role: 'alert' }, ui.agentError))
}

function showAgents() {
  const group = $('agents-section')
  if (!group) return
  group.scrollIntoView({ block: 'start', behavior: still.matches ? 'auto' : 'smooth' })
  group.querySelector('button:not(.danger), select, input')?.focus({ preventScroll: true })
}

function panel(space) {
  const name = h('input', { id: 'space-name', type: 'text', maxlength: '60', value: space.name })
  const saveName = () => {
    const value = name.value.trim()
    if (!value) {
      name.value = space.name
      showError('A space needs a name. Enter a name and try again.')
    } else if (value !== space.name) call('spaces.update', { id: space.id, name: value })
  }
  name.addEventListener('change', saveName)
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); name.blur() }
    if (event.key === 'Escape') { name.value = space.name; name.blur() }
  })
  const hours = h('input', { id: 'hours', type: 'number', min: '0', step: '1', value: String(state.settings.autoArchiveHours), 'aria-describedby': 'hours-help' })
  hours.addEventListener('change', () => {
    if (!hours.value || !hours.validity.valid) {
      showError('Enter a whole number of hours, or 0 to turn auto-archive off.')
      return
    }
    call('settings.set', { autoArchiveHours: Number(hours.value) })
  })
  const shell = h('select', { id: 'shell', onchange: () => call('ui.setShell', { name: shell.value }) },
    state.shells.map((name) => h('option', { value: name, selected: name === state.settings.shell }, name)))
  const preset = SEARCH_ENGINES.find((engine) => engine.url === state.settings.searchUrl)
  const search = h('select', { id: 'search-engine', onchange: () => call('settings.set', { searchUrl: search.value }) },
    !preset && h('option', { value: state.settings.searchUrl, selected: true, disabled: true }, 'Custom'),
    SEARCH_ENGINES.map((engine) => h('option', { value: engine.url, selected: engine === preset }, engine.name)))
  const last = state.spaces.filter((s) => !s.incognito).length < 2
  return [
    !space.incognito && [
      h('label', { class: 'field', for: 'space-name' }, 'Space name', name),
      h('div', { class: 'field-label', id: 'color-label' }, 'Space color'),
      h('div', { class: 'swatches', role: 'group', 'aria-labelledby': 'color-label' },
        SWATCHES.map((color, index) => {
          const label = ['Blue', 'Violet', 'Rose', 'Amber', 'Green', 'Slate'][index]
          const swatch = h('button', { class: 'swatch', title: label, 'aria-label': label, 'aria-pressed': String(color === space.color), onclick: () => call('spaces.update', { id: space.id, color }) })
          swatch.style.setProperty('--dot', color)
          return swatch
        }))
    ],
    h('label', { class: 'field', for: 'hours' }, 'Auto-archive after (hours)', hours),
    h('p', { class: 'hint', id: 'hours-help' }, '0 turns it off. Favorites and pinned tabs are never auto-archived.'),
    h('label', { class: 'field', for: 'shell' }, 'Shell', shell),
    h('p', { class: 'hint' }, 'Switches the whole interface in place. Tabs stay as they are.'),
    h('label', { class: 'field', for: 'search-engine' }, 'Search engine', search),
    agentRows(),
    extensionRows(),
    h('div', { class: 'settings-actions' },
      h('button', { id: 'import-arc', class: 'text-btn', onclick: importArc }, 'Import from Arc'),
      h('button', { id: 'fill-password', class: 'text-btn', disabled: ui.filling || !activeTab(), onclick: fillSavedPassword }, ui.filling ? 'Waiting for confirmation…' : 'Fill saved password'),
      h('p', { class: 'hint', role: 'status' }, ui.imported)),
    !space.incognito && [
      h('button', { id: 'delete-space', class: 'text-btn danger', disabled: last, onclick: () => confirmAction(`Delete “${space.name}”?`, 'Its tabs will move to the archive. Other spaces stay unchanged. The space itself cannot be restored.', 'Delete space', 'spaces.remove', { id: space.id }) }, 'Delete this space'),
      last && h('p', { class: 'hint' }, 'Keep at least one space.')
    ]
  ]
}

function spaceHead(space) {
  const plain = !ui.settings && !ui.archive
  if (!ui.renaming) return [
    h('h1', { title: space.name, ondblclick: () => { if (plain && !space.incognito) { ui.renaming = true; render() } } }, ui.settings ? 'Settings' : ui.archive ? 'Archive' : space.name),
    plain && !space.incognito && h('button', { id: 'rename-space', class: 'icon-btn', title: 'Rename space', 'aria-label': 'Rename space', onclick: () => { ui.renaming = true; render() } }, icon('edit')),
    plain && space.incognito && h('button', { id: 'close-incognito', class: 'icon-btn', title: 'Close Incognito', 'aria-label': 'Close Incognito', onclick: () => call('spaces.remove', { id: space.id }) }, icon('x')),
    plain && space.incognito && h('p', { id: 'incognito-hint', class: 'hint' }, 'Nothing here is saved.')
  ]
  const input = h('input', { id: 'rename', type: 'text', 'aria-label': 'Space name', maxlength: '60', value: space.name })
  const finish = (commit) => {
    if (!ui.renaming) return
    ui.renaming = false
    const name = input.value.trim()
    if (commit && name && name !== space.name) call('spaces.update', { id: space.id, name })
    render()
  }
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      finish(e.key === 'Enter')
      $('rename-space')?.focus()
    }
  })
  return input
}

function focusSpace(id) {
  const dot = $('dots').querySelector(`[data-space-id="${CSS.escape(id)}"]`)
  if (!dot) return
  for (const button of $('dots').children) button.tabIndex = button === dot ? 0 : -1
  dot.focus({ preventScroll: true })
  dot.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

async function moveSpace(id, index) {
  try {
    await skiff.call('spaces.move', { id, index })
    focusSpace(id)
    const space = state.spaces.find((item) => item.id === id)
    $('space-status').textContent = `${space?.name || 'Space'} moved to position ${index + 1}.`
  } catch (error) {
    showError(`${error.message || 'This space could not move.'} Try again.`)
    focusSpace(id)
  }
}

function spaceDot(space, current) {
  const dot = h('button', {
    class: 'dot', 'data-space-id': space.id, draggable: 'true', tabindex: current ? '0' : '-1',
    title: `${space.name} · Drag to reorder`, 'aria-label': space.name, 'aria-pressed': String(current),
    onclick: (event) => {
      ui.renaming = false
      call('spaces.activate', { id: space.id })
    },
    ondragstart: (event) => startDrag(event, 'space', space.id),
    ondragenter: (event) => spaceDragOver(event, space.id),
    ondragover: (event) => spaceDragOver(event, space.id),
    ondrop: (event) => dropSpace(event, space.id),
    onkeydown: (event) => {
      const index = state.spaces.findIndex((item) => item.id === space.id)
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (direction && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        moveSpace(space.id, Math.max(0, Math.min(state.spaces.length - 1, index + direction)))
      } else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (direction || event.key === 'Home' || event.key === 'End')) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.spaces.length - 1 : Math.max(0, Math.min(state.spaces.length - 1, index + direction))
        focusSpace(state.spaces[next].id)
      }
    }
  }, space.incognito ? icon('incognito') : h('span', { 'aria-hidden': 'true' }, Array.from(space.name.trim())[0]?.toUpperCase() || 'S'))
  dot.style.setProperty('--dot', space.color)
  return dot
}

let drag = null
let suppressClick = ''
// While a press, a tab drag or its drop calls last, the favorites and list keep their DOM: a pressed row stays attached, the preview survives state pushes and the result paints once.
let holds = 0
let stale = false

function unfreeze(dragged) {
  stale ||= dragged
  if (--holds) return
  if (stale) {
    delete drawn.favorites
    delete drawn.list
    stale = false
  }
  render()
}

let pressed = false
for (const id of ['favorites', 'list']) {
  $(id).addEventListener('pointerdown', (event) => {
    if (event.button || pressed) return
    pressed = true
    holds++
  })
}
// After the click that follows pointerup, so a rebuild never detaches the row being clicked. A drag start cancels the pointer; blur covers a release the shell never sees.
for (const type of ['pointerup', 'pointercancel', 'blur']) {
  addEventListener(type, () => {
    if (!pressed) return
    pressed = false
    setTimeout(() => unfreeze(false))
  })
}

function clearDropMarker() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-target').forEach((element) => element.classList.remove('drop-before', 'drop-after', 'drop-target'))
  $('drag-caption').hidden = true
}

function endDrag() {
  if (!drag) return
  suppressClick = drag.id
  setTimeout(() => { suppressClick = '' })
  document.querySelector('.dragging')?.classList.remove('dragging')
  clearDropMarker()
  const tabDrag = drag.kind === 'tab'
  drag = null
  if (tabDrag) unfreeze(true)
}

function startDrag(event, kind, id) {
  if (importer || confirmation) { event.preventDefault(); return }
  drag = { kind, id }
  event.dataTransfer.effectAllowed = 'move'
  // A custom type, so a web page never receives the id as dropped text.
  event.dataTransfer.setData(`application/x-skiff-${kind}`, id)
  if (kind === 'space') {
    focusSpace(id)
    event.currentTarget.classList.add('dragging')
    return
  }
  holds++
  // Changing the DOM inside dragstart cancels the drag in Chromium.
  requestAnimationFrame(() => { if (drag?.id === id) showDropZones() })
}

function showDropZones() {
  if (!$('favorites').querySelector('.tile')) {
    $('favorites').append(h('div', { class: 'drop-zone', 'data-zone': 'favorites' }, 'Favorites'))
    $('favorites').hidden = false
    drag.shifted = true
  }
  if (!$('list').querySelector('[data-section="pinned"]')) {
    $('list').prepend(h('li', { class: 'drop-zone', 'data-zone': 'pinned' }, 'Pinned'))
    drag.shifted = true
  }
}

const isIncognito = (spaceId) => Boolean(state.spaces.find((space) => space.id === spaceId)?.incognito)
const sectionOf = (tab) => tab.favorite ? 'favorites' : tab.pinned ? 'pinned' : 'tabs'
const shown = (element) => element.offsetParent !== null
const sourceOf = (id) => document.querySelector(`#favorites [data-tab-id="${CSS.escape(id)}"], #list [data-tab-id="${CSS.escape(id)}"]`)

function spaceDragOver(event, id) {
  if (drag?.kind !== 'space') return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  clearDropMarker()
  const target = event.currentTarget
  if (id === drag.id) return
  const rect = target.getBoundingClientRect()
  target.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after')
}

function dropSpace(event, id) {
  if (drag?.kind !== 'space') return
  event.preventDefault()
  const moving = drag
  const target = event.currentTarget
  const after = event.clientX >= target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2
  endDrag()
  if (id === moving.id) { focusSpace(id); return }
  const others = state.spaces.filter((space) => space.id !== moving.id)
  moveSpace(moving.id, others.findIndex((space) => space.id === id) + Number(after))
}

function tabPeers(tab) {
  return state.tabs.filter((item) => Boolean(item.favorite) === Boolean(tab.favorite) && Boolean(item.pinned) === Boolean(tab.pinned)
    && (item.folder || '') === (tab.folder || '') && (item.parentId || '') === (tab.parentId || '') && item.spaceId === tab.spaceId)
}

// A row's block is the row and its trail descendants, which move with it.
function blockEnd(row) {
  let end = row
  for (let next = row.nextElementSibling; next && (next.classList.contains('ghost') || Number(next.dataset.depth) > Number(row.dataset.depth)); next = next.nextElementSibling) {
    if (!next.classList.contains('ghost') && shown(next)) end = next
  }
  return end
}

// The drawn items of one drop group, in state order, without the dragged tab.
function groupPeers(id, { section, folder, parent }) {
  if (section === 'favorites') return [...$('favorites').querySelectorAll(':scope > .tile[data-tab-id]')].filter((el) => el.dataset.tabId !== id)
  return [...$('list').querySelectorAll(':scope > li[data-tab-id]')].filter((el) => el.dataset.tabId !== id && el.dataset.section === section
    && (section !== 'pinned' || el.dataset.folder === folder) && (section !== 'tabs' || el.dataset.parent === parent))
}

// ponytail: children of a dragged trail parent are previewed in place; after the drop they follow it, or become roots when it leaves the list
function tabTarget(event) {
  const tab = state.tabs.find((item) => item.id === drag.id)
  if (!tab || !event.target.closest) return null
  const dot = event.target.closest('#dots .dot')
  if (dot) {
    const id = dot.dataset.spaceId
    return id === tab.spaceId || isIncognito(id) !== isIncognito(tab.spaceId) ? null : { space: id }
  }
  const box = event.target.closest('#favorites, #list')
  if (!box || box.hidden || ui.archive || ui.settings) return null
  const { clientX: x, clientY: y } = event
  const grid = box.id === 'favorites'
  const distance = (el) => {
    const r = el.getBoundingClientRect()
    const dy = Math.max(r.top - y, 0, y - r.bottom)
    return grid ? Math.hypot(Math.max(r.left - x, 0, x - r.right), dy) : dy
  }
  const items = [...box.children].filter((el) => !el.classList.contains('divider') && shown(el))
  const near = items.reduce((best, el) => (!best || distance(el) < distance(best) ? el : best), null)
  // Over its own preview the slot holds, so a still pointer never makes the ghost jump.
  if (!near || near.classList.contains('ghost')) return near ? drag.target : null
  if (near.dataset.tabId === tab.id) return null
  const group = { section: 'tabs', folder: '' }
  if (grid) group.section = 'favorites'
  else if (near.dataset.zone === 'pinned') group.section = 'pinned'
  else if ('folderHead' in near.dataset) {
    Object.assign(group, { section: 'pinned', folder: near.dataset.folderHead, head: true })
    if (state.collapsed[`${tab.spaceId}/${group.folder}`]) return tab.pinned && tab.folder === group.folder ? null : group
  } else if (near.dataset.section === 'pinned') Object.assign(group, { section: 'pinned', folder: near.dataset.folder })
  // A trail child reorders among its siblings; it cannot become a root by drag.
  if (group.section === 'tabs' && sectionOf(tab) === 'tabs') group.parent = sourceOf(tab.id)?.dataset.parent
  const peers = groupPeers(tab.id, group)
  const before = (el) => {
    if (!grid) return (el.getBoundingClientRect().top + blockEnd(el).getBoundingClientRect().bottom) / 2 < y
    const r = el.getBoundingClientRect()
    return r.bottom <= y || (r.top <= y && r.left + r.width / 2 < x)
  }
  group.index = group.head ? peers.length : peers.filter(before).length
  delete group.head
  const current = tabPeers(tab).findIndex((item) => item.id === tab.id)
  if (group.section === sectionOf(tab) && group.folder === (tab.folder || '') && group.index === current) return null
  return group
}

function dropMessage(tab, target) {
  if (target.space) return `Drop to move to ${state.spaces.find((space) => space.id === target.space)?.name || 'that space'}.`
  const position = target.index === undefined ? '' : `, position ${target.index + 1}`
  if (target.section === sectionOf(tab) && target.folder === (tab.folder || '')) return `Drop to move to position ${target.index + 1}.`
  if (target.section === 'favorites') return `Drop to add to favorites${position}.`
  if (target.section === 'pinned') return target.folder ? `Drop to pin in ${target.folder}${position}.` : `Drop to pin${position}.`
  return `Drop to ${tab.favorite ? 'remove from favorites' : 'unpin'}${position}.`
}

function preview(target) {
  const key = JSON.stringify(target)
  if (key === drag.key) return
  Object.assign(drag, { key, target })
  const tab = state.tabs.find((item) => item.id === drag.id)
  const source = sourceOf(drag.id)
  document.querySelector('.ghost')?.remove()
  clearDropMarker()
  source?.classList.remove('drag-dim', 'drag-hide')
  const message = target && tab ? dropMessage(tab, target) : ''
  if ($('space-status').textContent !== message) $('space-status').textContent = message
  if (!target || !tab) return
  const caption = (text, element) => {
    element?.classList.add('drop-target')
    $('drag-caption').textContent = text
    $('drag-caption').hidden = false
    source?.classList.add('drag-dim')
  }
  if (target.space) return caption(`Move to ${state.spaces.find((space) => space.id === target.space)?.name}`, $('dots').querySelector(`[data-space-id="${CSS.escape(target.space)}"]`))
  const folderHead = target.folder && [...$('list').querySelectorAll('[data-folder-head]')].find((el) => el.dataset.folderHead === target.folder)
  if (target.index === undefined) return caption(`Add to ${target.folder}`, folderHead)
  const depth = target.parent ? Number(source?.dataset.depth) : 0
  const ghost = target.section === 'favorites' ? favoriteTile(tab, false) : tabRow({ ...tab, pinned: target.section === 'pinned', folder: target.folder }, false, target.section === 'tabs' ? depth : undefined)
  ghost.classList.add('ghost')
  ghost.classList.remove('loading')
  for (const name of ['data-tab-id', 'draggable']) ghost.removeAttribute(name)
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  const peers = groupPeers(drag.id, target)
  if (peers[target.index]) peers[target.index].before(ghost)
  else if (peers.length) blockEnd(peers.at(-1)).after(ghost)
  else if (target.section === 'favorites') $('favorites').append(ghost)
  else if (folderHead) folderHead.after(ghost)
  else if (target.section === 'pinned') $('list').prepend(ghost)
  else $('list').querySelector('[data-new-tab]').before(ghost)
  source?.classList.add(target.section === sectionOf(tab) ? 'drag-hide' : 'drag-dim')
}

function dropCalls(tab, target) {
  const id = tab.id
  if (target.space) return [['tabs.move', { id, spaceId: target.space }]]
  const calls = []
  if (target.section === 'favorites' && !tab.favorite) calls.push(['tabs.setFavorite', { id, favorite: true }])
  if (target.section === 'pinned' && (!tab.pinned || (tab.folder || '') !== target.folder)) calls.push(['tabs.setPinned', { id, pinned: true, folder: target.folder }])
  if (target.section === 'tabs' && tab.favorite) calls.push(['tabs.setFavorite', { id, favorite: false }])
  if (target.section === 'tabs' && tab.pinned) calls.push(['tabs.setPinned', { id, pinned: false }])
  calls.push(['tabs.move', target.index === undefined ? { id } : { id, index: target.index }])
  return calls
}

async function relocate(calls) {
  holds++
  try {
    for (const [method, params] of calls) if (await call(method, params) === undefined) return false
    return true
  } finally {
    unfreeze(true)
  }
}

function focusTab(id) {
  document.querySelector(`[data-tab-id="${CSS.escape(id)}"]`)?.querySelector('.row-main, .tile-main')?.focus()
}

async function moveTabWithKeyboard(event, tab) {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const name = tab.title || 'tab'
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const up = event.key === 'ArrowUp'
    const peers = tabPeers(tab)
    const index = peers.findIndex((item) => item.id === tab.id) + (up ? -1 : 1)
    if (index >= 0 && index < peers.length) {
      if (await call('tabs.move', { id: tab.id, index })) $('space-status').textContent = `Moved ${name} to position ${index + 1}.`
      return
    }
    // At the edge of its section a top-level tab steps into the next one: favorites, pinned, tabs.
    const next = !tab.parentId && !tab.folder && (up ? { tabs: 'pinned', pinned: 'favorites' } : { favorites: 'pinned', pinned: 'tabs' })[sectionOf(tab)]
    if (!next || !await relocate(dropCalls(tab, { section: next, folder: '', index: up ? undefined : 0 }))) return
    focusTab(tab.id)
    $('space-status').textContent = next === 'favorites' ? `Added ${name} to favorites.` : next === 'pinned' ? `Pinned ${name}.` : `Moved ${name} to tabs.`
  } else {
    const index = state.spaces.findIndex((space) => space.id === tab.spaceId)
    const space = state.spaces[index + (event.key === 'ArrowLeft' ? -1 : 1)]
    if (space && isIncognito(space.id) !== isIncognito(tab.spaceId)) return
    if (!space || !await call('tabs.move', { id: tab.id, spaceId: space.id })) return
    $('space-status').textContent = `Moved ${name} to ${space.name}.`
    $('dots').querySelector(`[data-space-id="${CSS.escape(state.activeSpaceId)}"]`)?.focus()
  }
}

const swipe = { last: 0, switched: Infinity, x: 0, used: false, dx: 0, dt: 8 }
function swipeSpaces(event) {
  const now = event.timeStamp
  const dt = now - swipe.last
  if (dt > 250) { swipe.x = 0; swipe.used = false }
  swipe.last = now
  if (!state || importer || confirmation || drag || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || (event.target.closest('#dots') && $('dots').scrollWidth > $('dots').clientWidth)
    || event.target.closest('input, textarea, select, [contenteditable="true"]')
    || document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')
    || (event.currentTarget === pageEl && activeTab())) {
    swipe.x = 0
    swipe.used = true
    // A guarded gesture stays blocked until it goes idle.
    swipe.switched = Infinity
    return
  }
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientWidth : 1
  const x = event.deltaX * unit
  const y = event.deltaY * unit
  if (!x || Math.abs(x) <= Math.abs(y) * 1.3) { swipe.x = 0; return }
  event.preventDefault()
  // Momentum only decays, so a reversal or a clear rise after a switch is a new gesture. Coalesced events sum their deltas, hence the interval scaling.
  const fresh = Math.abs(x) >= 6 && (x * swipe.dx < 0 || Math.abs(x) > 1.5 * Math.abs(swipe.dx) * Math.max(1, dt / swipe.dt))
  swipe.dx = x
  swipe.dt = Math.max(dt, 8)
  if (swipe.used && fresh && now - swipe.switched >= 150) { swipe.used = false; swipe.x = 0 }
  if (swipe.used) return
  if (swipe.x && Math.sign(swipe.x) !== Math.sign(x)) swipe.x = 0
  swipe.x += x
  if (Math.abs(swipe.x) < 30) return
  swipe.used = true
  swipe.switched = now
  const index = state.spaces.findIndex((space) => space.id === state.activeSpaceId)
  const next = state.spaces[index + Math.sign(swipe.x)]
  if (next) {
    call('spaces.activate', { id: next.id })
    $('space-status').textContent = `Switched to ${next.name}.`
  }
}

function openPalette(mode) {
  if (!state || importer || confirmation) return
  call('ui.showOverlay', { file: 'palette.html' }).then(() => call('ui.emit', { name: 'palette', data: { mode } }))
}

const appearance = matchMedia('(prefers-color-scheme: dark)')
appearance.addEventListener('change', () => render())
const still = matchMedia('(prefers-reduced-motion: reduce)')
let backgroundKey
function renderBackground(space) {
  const root = document.documentElement
  root.style.setProperty('--accent', space.color)
  root.classList.toggle('incognito', Boolean(space.incognito))
  const dark = appearance.matches
  const layer = !space.incognito && space.background?.[dark ? 'dark' : 'light']
  // Ink is judged over the colors under the sidebar, so its share of the window width is part of the key.
  const span = layer ? Math.min(1, Math.ceil($('sidebar').offsetWidth / innerWidth * 50) / 50) : 0
  const key = JSON.stringify([dark, layer, span])
  if (key === backgroundKey) return
  backgroundKey = key
  for (const property of ['--bg', '--canvas', '--ink', '--soft', '--ring', '--danger', '--space-background']) root.style.removeProperty(property)
  root.classList.toggle('imported-background', Boolean(layer))
  if (!layer) return
  const rgba = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1)
  const mix = (a, b, amount) => a.slice(0, 3).map((v, i) => v * amount + b[i] * (1 - amount))
  // Calibrated against Arc: two thirds of the intensity is how much of each color shows over the layer color.
  const strength = layer.intensity * 2 / 3
  const base = mix(rgba(layer.color), dark ? [0, 0, 0] : [1, 1, 1], rgba(layer.color)[3])
  const colors = layer.colors?.length ? layer.colors.map(rgba).map((color) => mix(color, base, color[3] * strength)) : [base]
  const overlays = layer.overlayColors?.map(rgba) || []
  // Base colors run left to right and overlays top to bottom, so shell text sits on the base stops up to the sidebar edge under every overlay stop.
  const edge = span * (colors.length - 1)
  const under = colors.filter((_, i) => i <= edge)
  if (edge % 1) under.push(mix(colors[Math.ceil(edge)], colors[Math.floor(edge)], edge % 1))
  const samples = [base, ...under, ...under.flatMap((color) => overlays.map((overlay) => mix(overlay, color, overlay[3] * strength)))]
  // Component-wise bounds also cover darker intermediate sRGB mixtures.
  samples.push([0, 1, 2].map((i) => Math.min(...samples.map((sample) => sample[i]))))
  const luminance = (rgb) => rgb.map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const gray = (v) => [v, v, v]
  // Worst contrast of black (0) or white (1) ink over the veiled samples, measured on a hovered row (7% ink).
  const worst = (ink, veil) => Math.min(...samples.map((sample) => {
    const lum = luminance(mix(gray(ink), mix(gray(1 - ink), sample, veil), .07))
    return ink ? 1.05 / (lum + .05) : (lum + .05) / .05
  }))
  const ink = worst(1, 0) > worst(0, 0) ? 1 : 0
  let steps = 0
  while (steps < 40 && worst(ink, steps / 40) < 4.5) steps++
  const veil = steps / 40
  const css = (rgb, alpha = 1) => `rgb(${rgb.slice(0, 3).map((v) => Math.round(v * 255)).join(' ')} / ${alpha})`
  const gradient = (side, stops) => `linear-gradient(to ${side} in srgb, ${stops.concat(stops.length === 1 ? stops : []).join(', ')})`
  const layers = []
  if (veil) layers.push(gradient('right', [css(gray(1 - ink), veil)]))
  if (overlays.length) layers.push(gradient('bottom', overlays.map((color) => css(color, color[3] * strength))))
  layers.push(gradient('right', colors.map((color) => css(color))))
  const solid = css(mix(gray(1 - ink), base, veil))
  root.style.setProperty('--space-background', layers.join(', '))
  root.style.setProperty('--bg', solid)
  root.style.setProperty('--canvas', solid)
  for (const property of ['--ink', '--soft', '--ring', '--danger']) root.style.setProperty(property, ink ? '#ffffff' : '#000000')
}
addEventListener('resize', () => { if (state) renderBackground(activeSpace()) })

function render() {
  if (!state) return
  const space = activeSpace()
  if (space.incognito) ui.renaming = false
  const tab = activeTab()
  const tabs = state.tabs.filter((t) => !t.favorite && t.spaceId === space.id)
  const favorites = state.tabs.filter((t) => t.favorite && t.spaceId === space.id)

  renderBackground(space)
  document.title = tab ? `${tab.title || tab.url} - Skiff` : 'Skiff'
  $('back').disabled = !tab?.canGoBack
  $('forward').disabled = !tab?.canGoForward
  $('reload').disabled = !tab
  $('empty').hidden = Boolean(tab)
  $('empty-text').textContent = space.incognito ? 'Search the web or open a tab.' : 'Search the web, open a tab, or bring your spaces from Arc.'
  $('empty-import').hidden = Boolean(space.incognito)
  $('archive-toggle').setAttribute('aria-pressed', String(ui.archive))
  $('settings-toggle').setAttribute('aria-pressed', String(ui.settings))
  $('panel').hidden = !ui.settings
  $('list').hidden = ui.settings
  $('list').setAttribute('aria-label', ui.archive ? 'Archived tabs' : 'Tabs')
  if (!holds) $('favorites').hidden = !favorites.length || ui.settings || ui.archive
  address.textContent = tab?.url || PLACEHOLDER
  address.title = tab?.url || ''
  address.classList.toggle('placeholder', !tab)

  if (!holds) section('favorites', [favorites, tab?.id], () => favorites.map((t) => favoriteTile(t, t.id === tab?.id)))
  section('space-head', [space.id, space.name, ui.renaming, ui.settings, ui.archive], () => spaceHead(space))
  section('dots', state.spaces.map((s) => [s.id, s.name, s.color, s.incognito]), () => state.spaces.map((s) => spaceDot(s, s.id === space.id)))
  if (drawn.activeSpaceId !== space.id) {
    const from = state.spaces.findIndex((s) => s.id === drawn.activeSpaceId)
    drawn.activeSpaceId = space.id
    for (const dot of $('dots').children) {
      const current = dot.dataset.spaceId === space.id
      dot.setAttribute('aria-pressed', String(current))
      dot.tabIndex = current ? 0 : -1
    }
    $('dots').querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const travel = `translateX(${state.spaces.indexOf(space) > from ? 24 : -24}px)`
    if (from >= 0 && !still.matches) for (const id of ['favorites', 'space-head', 'list']) $(id).animate([{ transform: travel, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 130, easing: 'ease-out' })
  }
  section('panel', ui.settings && [space, state.spaces.length, state.settings.autoArchiveHours, state.settings.searchUrl, state.settings.ai, ui.imported, ui.filling, Boolean(tab), ui.extensions, ui.agents, ui.agentError], () => (ui.settings ? panel(space) : []))
  if (ui.settings) warmDefault()
  if (!holds) section('list', ui.archive ? [state.archive] : [tabs, tab?.id, state.collapsed], () => (ui.archive ? archiveRows() : [
    tabRows(space, tabs, (t, depth) => tabRow(t, t.id === tab?.id, depth)),
    h('li', { class: 'row', 'data-new-tab': true }, h('button', { id: 'new-tab', class: 'row-main', onclick: () => openPalette('new') }, icon('plus'), h('span', { class: 'label' }, 'New tab')))
  ]))

  const rename = $('rename')
  if (rename && !importer && document.activeElement !== rename) {
    rename.focus()
    rename.select()
  }
  reportBounds()
}

function reportBounds() {
  const r = pageEl.getBoundingClientRect()
  const bounds = { x: r.x, y: r.y, width: r.width, height: r.height, radius: parseFloat(getComputedStyle(pageEl).borderTopLeftRadius) || 0 }
  if (JSON.stringify(bounds) === lastBounds) return
  lastBounds = JSON.stringify(bounds)
  call('ui.setPageBounds', bounds)
}

$('back').addEventListener('click', () => call('tabs.back'))
$('forward').addEventListener('click', () => call('tabs.forward'))
$('reload').addEventListener('click', () => call('tabs.reload'))
function toggleArchive() {
  if (importer || confirmation) return
  ui.archive = !ui.archive
  ui.settings = false
  ui.renaming = false
  ui.imported = ''
  render()
}

// data.section 'agents' opens Settings (never closes it) at the Agents group.
function toggleSettings(data) {
  if (importer || confirmation) return
  const agents = data?.section === 'agents'
  ui.settings = agents || !ui.settings
  ui.archive = false
  ui.renaming = false
  render()
  if (!ui.settings) return
  if (agents) showAgents()
  Promise.all([refreshExtensions(), refreshAgents()]).then(() => { if (agents) showAgents() })
}

$('archive-toggle').addEventListener('click', toggleArchive)
$('add-space').addEventListener('click', async () => {
  if (importer || confirmation) return
  const space = await call('spaces.create', { name: `Space ${state.spaces.length + 1}` })
  if (!space) return
  ui.archive = false
  ui.settings = false
  ui.renaming = true
  call('spaces.activate', { id: space.id })
})

$('settings-toggle').addEventListener('click', toggleSettings)
$('empty-new-tab').addEventListener('click', () => openPalette('new'))
address.addEventListener('click', () => openPalette('edit'))
$('empty-import').addEventListener('click', importArc)
$('shell-error-dismiss').addEventListener('click', () => { $('shell-error').hidden = true })
$('confirm-cancel').addEventListener('click', closeConfirmation)
$('confirm-accept').addEventListener('click', async () => {
  if (!confirmation) return
  const action = confirmation
  $('confirm-accept').disabled = true
  $('confirm-cancel').disabled = true
  try {
    await skiff.call(action.method, action.params)
    closeConfirmation()
    if (action.method === 'extensions.remove') refreshExtensions()
  } catch (error) {
    showError(`${error.message || 'That action could not finish.'} Cancel or try again.`)
  } finally {
    $('confirm-accept').disabled = false
    $('confirm-cancel').disabled = false
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (drag) { event.preventDefault(); endDrag() }
  if (confirmation && !$('confirm-accept').disabled) { event.preventDefault(); closeConfirmation() }
})
document.addEventListener('dragend', endDrag)
// Chromium reports a drop target change with dragenter alone, so both events must accept the drop.
function tabDragOver(event) {
  if (drag?.kind !== 'tab') return
  // Drop areas push the sidebar down under a still pointer; wait for real movement before previewing.
  if (drag.shifted === true) drag.shifted = { x: event.clientX, y: event.clientY }
  if (drag.shifted && Math.hypot(event.clientX - drag.shifted.x, event.clientY - drag.shifted.y) < 6) return
  drag.shifted = false
  const target = tabTarget(event)
  preview(target)
  // Without preventDefault the drop is refused and the cursor shows it.
  if (!target) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}
document.addEventListener('dragenter', tabDragOver)
document.addEventListener('dragover', tabDragOver)
document.addEventListener('drop', (event) => {
  const tab = drag?.kind === 'tab' && drag.target && state.tabs.find((item) => item.id === drag.id)
  if (tab) {
    event.preventDefault()
    // The preview's slot is the drop; relocate holds the preview until the result paints.
    relocate(dropCalls(tab, drag.target))
  }
  endDrag()
})
// Releasing a drag must not also activate the item that was dragged.
document.addEventListener('click', (event) => {
  const id = suppressClick
  if (id && event.target.closest?.(`[data-tab-id="${CSS.escape(id)}"], [data-space-id="${CSS.escape(id)}"]`)) {
    event.preventDefault()
    event.stopPropagation()
  }
}, true)
$('dots').addEventListener('dragover', (event) => {
  if (!drag) return
  const bounds = $('dots').getBoundingClientRect()
  if (event.clientX < bounds.left + 20) $('dots').scrollLeft -= 12
  else if (event.clientX > bounds.right - 20) $('dots').scrollLeft += 12
})
$('sidebar').addEventListener('wheel', swipeSpaces, { passive: false })
pageEl.addEventListener('wheel', swipeSpaces, { passive: false })


$('arc-form').addEventListener('submit', advanceImport)
$('arc-cancel').addEventListener('click', closeImport)
$('arc-back').addEventListener('click', () => {
  if (!importer) return
  const previous = { categories: 'profile', review: 'categories', results: 'categories' }[importer.phase]
  if (!previous) return
  importer.phase = previous
  importer.error = ''
  importer.notice = ''
  renderImport()
})
importDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  closeImport()
})
document.documentElement.classList.toggle('mac', navigator.userAgent.includes('Mac'))
new ResizeObserver(reportBounds).observe(pageEl)
skiff.on('new-tab', () => openPalette('new'))
skiff.on('focus-address', () => openPalette('edit'))
skiff.on('ask-agent', () => openPalette('ask'))
let toastTimer
function showToast(message) {
  const toast = $('toast')
  toast.textContent = message
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1500)
}
skiff.on('url-copied', () => showToast('Copied URL'))
skiff.on('extension-popup', openExtensionPopup)
skiff.on('extensions-changed', () => { if (ui.settings) refreshExtensions() })
skiff.on('ai-agents', (next) => {
  ui.agents = next || []
  if (ui.settings) render()
})
skiff.on('toggle-archive', toggleArchive)
skiff.on('toggle-settings', toggleSettings)
skiff.on('import-arc', importArc)
skiff.on('state', (next) => {
  state = next
  render()
})
skiff.call('state.get').then((first) => {
  state = first
  render()
}).catch(() => showError('Skiff could not load your spaces. Reload the shell or restart Skiff to try again.'))

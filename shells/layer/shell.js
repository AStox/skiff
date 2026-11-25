'use strict'

const SWATCHES = ['#4f6bed', '#7c5ce0', '#d6336c', '#c2700e', '#2f9e5b', '#5f6b7a']
const relative = new Intl.RelativeTimeFormat(undefined, { style: 'narrow' })

const ui = { archive: false, settings: false, page: 'space', expanded: '', renaming: false, filter: 'all', imported: '', filling: false, quick: [], quickKey: '', quickRequest: 0, extensions: [], agents: [], agentForm: null, agentError: '', warmed: '' }
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
  return true
}

const activeSpace = () => state.spaces.find((s) => s.id === state.activeSpaceId)
const activeTab = () => state.tabs.find((t) => t.id === state.activeTabBySpace[state.activeSpaceId])

// Picking a tab shows its window in front, hidden or not, and every other window of the space with it.
async function show(tab) {
  try {
    if (state.deskOnly) await skiff.call('ui.setDesk', { only: null })
    await skiff.call('tabs.activate', { id: tab.id })
    closeCard()
  } catch (error) {
    showError(`${error.message || 'This tab could not open.'} Try again.`)
  }
}

const MOVE_HINT = 'Drag to reorder, pin or favorite. Alt+Shift+Up/Down moves it, also between sections. Alt+Shift+Left/Right changes space.'
const MOVE_KEYS = 'Alt+Shift+ArrowUp Alt+Shift+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight'

// Every ordinary tab is a window: its eye hides it from the desk or shows it again.
function eye(tab, shown) {
  const title = shown ? 'Hide window' : 'Show window'
  return h('button', { class: 'icon-btn eye reveal', title, 'aria-label': title, 'aria-pressed': String(!shown), onclick: () => call(shown ? 'desk.hide' : 'desk.show', { id: tab.id }) }, icon(shown ? 'eye' : 'eye-off'))
}

// The open space's order: its status sections, then Pinned. Each is a chip of the card and a drop target.
const SECTIONS = [['unread', 'Unread'], ['active', 'Active'], ['progress', 'In Progress'], ['done', 'Done'], ['later', 'Pinned']]
const BUCKET_NAMES = Object.fromEntries([['favorites', 'Favorites'], ...SECTIONS])
const BUCKETS = Object.keys(BUCKET_NAMES)
// tabs.move orders among the tabs of one kind (and folder and parent), whatever their bucket.
const kindOf = (bucket) => bucket === 'favorites' || bucket === 'later' ? bucket : 'plain'
const DONE_MS = 24 * 36e5
// The filter chips: bucket, label, and the line shown when the filter has no tabs.
const CHIPS = [['unread', 'Unread', 'No unread tabs'], ['active', 'Active', 'No active tabs'], ['progress', 'In progress', 'No tabs in progress'], ['done', 'Done', 'No done tabs'], ['later', 'Pinned', 'No pinned tabs']]

function archivesIn(doneAt) {
  const minutes = Math.round((doneAt + DONE_MS - Date.now()) / 6e4)
  return minutes < 1 ? 'archives soon' : minutes < 60 ? `archives in ${minutes} min` : `archives in ${Math.round(minutes / 60)} h`
}

const archiveNote = (tab) => (tab.bucket === 'done' && tab.doneAt ? `\n${archivesIn(tab.doneAt)}` : '')

// The status of a row of the open space, drawn the same in the chips: a dot, a ring, a broken ring, a check or a pin.
function statusMark(bucket) {
  return h('span', { class: 'mark', 'data-mark': bucket, 'aria-hidden': 'true' }, bucket === 'done' ? icon('check') : bucket === 'later' ? icon('pin') : null)
}

const closeButton = (tab) => h('button', { class: 'icon-btn reveal', title: 'Close tab', 'aria-label': 'Close tab', onclick: () => call('tabs.close', { id: tab.id }) }, icon('x'))

// The end of a row says only who an agent is and what it does; the dot is its state (green when done, a ring while it works).
// A conversation tab has no agent state of its own: its turn running puts it In Progress, a finished one Unread or Done.
function agentEnd(tab) {
  const name = agentNameOf(tab) || tab.chat?.agent
  if (!name) return null
  const state = tab.agentRequest ? 'asking' : tab.agentState || { progress: 'working', unread: 'done', done: 'done' }[tab.bucket] || 'idle'
  const dot = tab.agentState || tab.agentRequest ? agentDot(tab) : h('span', { class: 'agent-dot', 'data-state': state })
  dot.setAttribute('aria-hidden', 'true')
  const word = tab.agentRequest ? 'asks' : AGENT_STATES[state] || state
  return h('span', { class: 'who' }, dot, h('span', { class: 'when' }, `${name} ${word}`))
}

const rowEnd = (tab) => [speaker(tab), agentEnd(tab)]

// A row of another space: a click goes there, and it can be closed. Moves belong to the open space's rows, so it has no drag, keys or eye.
function otherRow(tab, depth) {
  const row = h('li', { class: `row${tab.loading ? ' loading' : ''}`, 'data-tab-id': tab.id, 'data-static': true },
    h('button', { class: 'row-main', title: `${tab.url}${archiveNote(tab)}`, onclick: () => show(tab) },
      favicon(tab), h('span', { class: 'label' }, tab.title || tab.url), rowEnd(tab)),
    closeButton(tab))
  if (depth) row.style.setProperty('--depth', String(Math.min(depth, 6)))
  return row
}

function tabRow(tab, current, depth) {
  const shown = isShown(state, tab)
  const row = h('li', {
    class: `row${current ? ' current' : ''}${tab.loading ? ' loading' : ''}${tab.folder ? ' nested' : ''}${shown || tab.pinned ? '' : ' hidden-win'}`,
    'data-tab-id': tab.id, 'data-section': tab.bucket, 'data-folder': tab.pinned ? tab.folder || '' : null,
    'data-depth': depth, 'data-parent': tab.parentId || '', 'aria-level': depth == null ? null : depth + 1, draggable: 'true',
    ondragstart: (event) => startDrag(event, 'tab', tab.id),
    onkeydown: (event) => moveTabWithKeyboard(event, tab)
  },
    h('button', { class: 'row-main', title: `${tab.url}\n${MOVE_HINT}${archiveNote(tab)}`, 'aria-keyshortcuts': MOVE_KEYS, 'aria-current': current ? 'true' : null, onclick: () => show(tab) },
      !tab.pinned && statusMark(tab.bucket), favicon(tab), h('span', { class: 'label' }, tab.title || tab.url), h('span', { class: 'sr-only' }, `, ${CHIPS.find(([key]) => key === tab.bucket)?.[1].toLowerCase() || tab.bucket}`), rowEnd(tab)),
    !tab.pinned && eye(tab, shown),
    closeButton(tab))
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

function folderRow(space, folder, open, count, toggle = () => call('folders.setCollapsed', { spaceId: space.id, folder, collapsed: open })) {
  return h('li', { class: 'row', 'data-folder-head': folder },
    h('button', { class: 'row-main', title: folder, 'aria-expanded': String(open), onclick: toggle },
      icon('folder'), h('span', { class: 'label' }, folder), !open && h('span', { class: 'when' }, String(count)), h('span', { class: 'chevron' }, icon('chevron-down'))))
}

// Later: folders first, then loose tabs, as the mock lays them out.
function laterRows(space, pinned, row) {
  const folders = [...new Set(pinned.map((t) => t.folder).filter(Boolean))]
  return [
    folders.map((folder) => {
      const inside = pinned.filter((t) => t.folder === folder)
      const open = !state.collapsed[`${space.id}/${folder}`]
      return [
        folderRow(space, folder, open, inside.length),
        open ? inside.map((t) => row(t)) : []
      ]
    }),
    pinned.filter((t) => !t.folder).map((t) => row(t))
  ]
}

// One space's ordinary tabs by status, or only one status.
function statusRows(tabs, row, only) {
  return SECTIONS.filter(([bucket]) => bucket !== 'later' && (!only || bucket === only)).map(([bucket]) => trail(tabs.filter((t) => t.bucket === bucket)).map(([t, depth]) => row(t, depth)))
}

// The browser-tools component replaces this to draw folders, empty ones too.
function pinnedRows(space, pinned, row) {
  return pinned.length ? laterRows(space, pinned, row) : []
}

const chipRow = (counts) => [...CHIPS.map(([key, label]) => [key, label]), ['all', 'All']].map(([key, label]) => h('button', {
  class: `chip${key === 'all' ? ' all' : ''}`, type: 'button', 'data-filter': key, 'aria-pressed': String(ui.filter === key),
  onclick: () => { ui.filter = key; renderPanel() }
}, key !== 'all' && statusMark(key), label, h('span', { class: 'n' }, String(counts[key]))))

function groupHead(space, count) {
  const dot = h('span', { class: 'space-dot', 'aria-hidden': 'true' })
  dot.style.setProperty('background', space.color)
  return h('li', { class: 'list-head space', 'data-static': true, 'data-space-head': space.id }, dot, h('span', { class: 'label' }, space.name), h('span', { class: 'count' }, String(count)))
}

// The label over the open space's pinned block in the All view; the rows carry no pin of their own.
function pinnedHead(count) {
  return h('li', { class: 'list-head space', 'data-static': true, 'data-pinned-head': true }, h('span', { class: 'label' }, 'Pinned'), h('span', { class: 'count' }, String(count)))
}

// Every other space's open tabs, flat under its head: its loaded favorites and pinned tabs first, then its ordinary tabs in status order.
function otherGroups(space) {
  return state.spaces.filter((s) => s.id !== space.id).map((s) => {
    const mine = state.tabs.filter((t) => t.spaceId === s.id && !t.userPeek)
    return { space: s, top: [...mine.filter((t) => t.favorite), ...mine.filter((t) => t.pinned && !t.favorite)].filter(isOpen), plain: mine.filter(isPlain) }
  }).filter((g) => g.top.length || g.plain.length)
}

function favoriteTile(tab, current) {
  return h('div', {
    class: `tile${current ? ' current' : ''}${tab.loading ? ' loading' : ''}`, 'data-tab-id': tab.id, draggable: 'true',
    ondragstart: (event) => startDrag(event, 'tab', tab.id),
    onkeydown: (event) => moveTabWithKeyboard(event, tab)
  }, h('button', { class: 'tile-main', title: `${tab.title || tab.url}\n${MOVE_HINT}`, 'aria-label': tab.title || tab.url, 'aria-keyshortcuts': MOVE_KEYS, 'aria-current': current ? 'true' : null, onclick: () => show(tab) }, favicon(tab, icon('globe')), speaker(tab), agentDot(tab)))
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
    closeCard()
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
  const busy = phase === 'loading' || phase === 'importing'
  const profiles = preview?.profiles.filter((p) => flow.profileIds?.has(p.id)) || []
  const content = []
  const titles = {
    loading: 'Find your Arc profiles',
    profile: 'Choose Arc profiles',
    categories: 'Choose what to bring',
    review: 'Ready to import?',
    importing: 'Importing from Arc',
    results: 'Import results',
    error: 'Could not read Arc'
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
      h('p', {}, phase === 'importing' ? 'Waiting for the import to finish…' : 'Reading Arc profile names and sidebar…')))
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
  $('arc-cancel').disabled = phase === 'importing'
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
    renderImport(false)
    importDialog.showModal()
    // The dialog is modal over the whole desk, so the window takes clicks everywhere while it is open.
    sync()
    $('arc-title').focus()
  } catch {
    importer = null
    Object.assign(ui, { settings: true, page: 'skiff', expanded: '' })
    ui.archive = false
    ui.imported = 'The import window could not open. Try Import from Arc again.'
    renderPanel()
    return
  }
  await loadArcPreview()
}

function closeImport() {
  const flow = importer
  if (!flow || flow.phase === 'importing') return
  importer = null
  importDialog.close()
  sync()
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

// Every quick-panel entry of settings.catalog is drawn here by its type, so a new host setting or action reaches this shell with no change to it.
function refreshQuick() {
  const request = ++ui.quickRequest
  ui.quickKey = JSON.stringify([state.settings, state.update?.status])
  return Promise.resolve(skiff.call('settings.catalog', { quickPanel: true, owner: 'core' })).then((list) => {
    if (request !== ui.quickRequest) return
    ui.quick = Array.isArray(list) ? list : []
    renderPanel()
  }).catch(() => {})
}

async function runQuick(entry) {
  await call('settings.run', { id: entry.id })
  await refreshQuick()
}

// A quick entry lands on the page its section names; a section not listed lands on Skiff, so a new quickPanel entry needs no change here.
const SETTINGS_PAGES = [['space', 'This space'], ['browsing', 'Browsing'], ['agents', 'Agents'], ['skiff', 'Skiff']]
const QUICK_PAGE = { tabs: 'browsing' }
const quickOn = (page) => ui.quick.filter((entry) => (QUICK_PAGE[entry.section] || 'skiff') === page)
// Only an update that is ready waits for the user, so only its button is filled.
const WAITING = new Set(['update'])

const optionText = (value) => {
  const text = String(value).replace(/-/g, ' ')
  return text[0].toUpperCase() + text.slice(1)
}
const unitOf = (entry, value) => {
  const unit = /(Hours|Days|Minutes|Seconds)$/.exec(entry.id)?.[1].toLowerCase()
  return unit && (Number(value) === 1 ? unit.slice(0, -1) : unit)
}
const menu = (select) => h('span', { class: 'set-val' }, select, icon('updown'))
function chevron(open) {
  const svg = icon('forward')
  svg.classList.add('chev')
  svg.classList.toggle('open', open)
  return svg
}

// A click on the blank part of a row works its control.
function poke(event) {
  const field = event.currentTarget.querySelector('select, input')
  if (!field || event.target.closest('select, input, button') || (event.target.closest('label') && field.type === 'checkbox')) return
  if (field.type === 'checkbox') field.click()
  else if (field.tagName === 'SELECT') try { field.showPicker() } catch { field.focus() }
  else field.focus()
}

// One line: the title on the left, a control or value on the right. The description is the row's tooltip and a hidden element for screen readers, never printed.
function setRow(id, title, control, description) {
  return h('div', { class: 'set', title: description, onclick: poke },
    h('label', { class: 'set-name', for: id }, title),
    control,
    description && h('span', { class: 'sr-only', id: `${id}-help` }, description))
}

function quickControl(entry, id, describedby) {
  const write = (value, revert) => Promise.resolve(call('settings.set', { [entry.id]: value })).then((done) => { if (!done) revert() })
  const attrs = { id, 'aria-describedby': describedby }
  if (entry.enum) {
    const select = h('select', { ...attrs, class: 'set-select' }, entry.enum.map((value) => h('option', { value: String(value), selected: value === entry.value }, optionText(value))))
    select.addEventListener('change', () => write(entry.enum.find((value) => String(value) === select.value), () => { select.value = String(entry.value) }))
    return menu(select)
  }
  if (entry.type === 'boolean') {
    const box = h('input', { ...attrs, class: 'switch', type: 'checkbox', checked: entry.value === true })
    box.addEventListener('change', () => write(box.checked, () => { box.checked = entry.value === true }))
    return box
  }
  const numeric = entry.type === 'number' || entry.type === 'integer'
  const input = h('input', { ...attrs, class: numeric ? 'set-num' : 'set-text', type: numeric ? 'number' : 'text', min: entry.minimum, max: entry.maximum, step: numeric ? (entry.type === 'integer' ? '1' : 'any') : null, maxlength: entry.maxLength, value: String(entry.value ?? '') })
  const unit = numeric && unitOf(entry, entry.value) && h('span', { class: 'set-unit' }, unitOf(entry, entry.value))
  input.addEventListener('input', () => { if (unit) unit.textContent = unitOf(entry, input.value) })
  input.addEventListener('change', () => {
    if (numeric && (!input.value || !input.validity.valid)) {
      showError(`Enter a valid number for ${entry.title}.`)
      input.value = String(entry.value)
      return
    }
    write(numeric ? Number(input.value) : input.value, () => { input.value = String(entry.value ?? '') })
  })
  return unit ? h('span', { class: 'set-val' }, input, unit) : input
}

function quickRow(entry) {
  const id = `setting-${entry.id}`
  const help = entry.description && `${id}-help`
  if (entry.type !== 'action') return setRow(id, entry.title, quickControl(entry, id, help), entry.description)
  return h('div', { class: 'set', title: entry.description || null },
    h('span', { class: 'set-title' },
      h('span', { class: 'set-name', id: `${id}-label` }, entry.title),
      entry.status && h('small', { id: `${id}-status`, role: 'status' }, entry.status)),
    entry.available !== false && h('button', { id, class: `set-btn${WAITING.has(entry.id) ? ' primary' : ''}`, type: 'button', 'aria-describedby': help || null, onclick: () => runQuick(entry) }, entry.actionLabel || entry.title),
    entry.description && h('span', { class: 'sr-only', id: help }, entry.description))
}

addEventListener('focus', () => { if (ui.settings) refreshQuick() })

async function fillSavedPassword() {
  if (ui.filling || importer) return
  ui.filling = true
  ui.imported = 'Choose an account in the native confirmation.'
  renderPanel()
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
  renderPanel()
  $('fill-password')?.focus()
}

function spacePage(space) {
  const name = h('input', { id: 'space-name', class: 'set-text', type: 'text', maxlength: '60', value: space.name })
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
  const last = state.spaces.filter((s) => !s.incognito).length < 2
  return [
    setRow('space-name', 'Name', name),
    h('div', { class: 'set' },
      h('span', { class: 'set-name', id: 'color-label' }, 'Color'),
      h('div', { class: 'swatches', role: 'group', 'aria-labelledby': 'color-label' },
        SWATCHES.map((color, index) => {
          const label = ['Blue', 'Violet', 'Rose', 'Amber', 'Green', 'Slate'][index]
          const swatch = h('button', { class: 'swatch', type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(color === space.color), onclick: () => call('spaces.update', { id: space.id, color }) })
          swatch.style.setProperty('--dot', color)
          return swatch
        }))),
    h('div', { class: 'set-sep', role: 'separator' }),
    h('button', { id: 'delete-space', class: 'set danger', type: 'button', disabled: last, onclick: () => confirmAction(`Delete “${space.name}”?`, 'Its tabs will move to the archive. Other spaces stay unchanged. The space itself cannot be restored.', 'Delete space', 'spaces.remove', { id: space.id }) }, 'Delete this space'),
    last && h('p', { class: 'hint' }, 'Keep at least one space.')
  ]
}

function browsingPage() {
  const preset = SEARCH_ENGINES.find((engine) => engine.url === state.settings.searchUrl)
  const search = h('select', { id: 'search-engine', class: 'set-select', onchange: () => call('settings.set', { searchUrl: search.value }) },
    !preset && h('option', { value: state.settings.searchUrl, selected: true, disabled: true }, 'Custom'),
    SEARCH_ENGINES.map((engine) => h('option', { value: engine.url, selected: engine === preset }, engine.name)))
  return [setRow('search-engine', 'Search engine', menu(search)), quickOn('browsing').map(quickRow)]
}

function skiffPage() {
  const mac = document.documentElement.classList.contains('mac')
  return [
    ui.extensions.length > 0 && [
      h('p', { class: 'sr-only', id: 'extensions-help' }, `Built-in ones update themselves. None run in incognito. ${mac ? 'Cmd' : 'Ctrl'}+Shift+U opens the panel of the first one.`),
      h('ul', { id: 'extensions', 'aria-label': 'Extensions', 'aria-describedby': 'extensions-help' }, ui.extensions.map(extensionRow))
    ],
    quickOn('skiff').map(quickRow),
    h('div', { class: 'set' },
      h('span', { class: 'set-name' }, 'Import from Arc'),
      h('button', { id: 'import-arc', class: 'set-btn', type: 'button', onclick: importArc }, 'Import…')),
    h('div', { class: 'set' },
      h('span', { class: 'set-name' }, 'Fill saved password'),
      h('button', { id: 'fill-password', class: 'set-btn', type: 'button', disabled: ui.filling || !activeTab(), onclick: fillSavedPassword }, ui.filling ? 'Waiting for confirmation…' : 'Fill')),
    h('p', { class: 'hint', role: 'status' }, ui.imported)
  ]
}

const SETTINGS_PAGE = { space: spacePage, browsing: browsingPage, agents: agentsPage, skiff: skiffPage }
const settingsPage = (space) => (SETTINGS_PAGE[ui.page] || spacePage)(space)

const settingsChips = (incognito) => SETTINGS_PAGES.filter(([key]) => !(incognito && key === 'space')).map(([key, label]) => h('button', {
  class: 'chip', type: 'button', id: `settings-page-${key}`, 'data-page': key, 'aria-pressed': String(ui.page === key),
  onclick: () => { Object.assign(ui, { page: key, expanded: '' }); renderPanel() }
}, label))

// Extension popups open beside the card.
function openPopup(id) {
  const { width: W } = deskSize(state)
  const { x: left, y, width } = at
  const x = left + width + GAP + POPUP_SIZE.width <= W ? left + width + GAP : Math.max(0, left - GAP - POPUP_SIZE.width)
  call('extensions.popup', { id, bounds: { x, y, ...POPUP_SIZE } })
}

const STATE_WORDS = { installing: 'Installing…', updating: 'Updating…', restarting: 'Restarting…', failed: 'Failed' }

function extensionRow(entry, index) {
  const key = `extension:${entry.name}`
  const open = ui.expanded === key
  const failure = entry.builtin && entry.state === 'failed' && `Could not ${entry.version ? 'update' : 'install'}: ${entry.error}`
  return h('li', { class: 'extension', 'data-extension-id': entry.id },
    h('button', { class: 'set', id: `extension-main-${index}`, type: 'button', 'aria-expanded': String(open), 'aria-controls': `extension-detail-${index}`, onclick: () => expand(key) },
      h('span', { class: 'set-name', title: entry.name }, entry.name),
      h('span', { class: 'set-val' }, (entry.state === 'restarting' ? '' : entry.version) || STATE_WORDS[entry.state] || ''),
      chevron(open)),
    open && h('div', { class: 'set-detail extension-detail', id: `extension-detail-${index}` },
      h('div', { class: 'set-actions' },
        h('button', { class: 'set-btn', type: 'button', disabled: !entry.popup, onclick: () => openPopup(entry.id) }, 'Panel'),
        h('button', { class: 'set-btn', type: 'button', disabled: !entry.options, onclick: () => call('extensions.open', { id: entry.id }) }, 'Settings'),
        !entry.builtin && h('button', { class: 'set-btn danger', type: 'button', onclick: () => confirmAction(`Remove ${entry.name}?`, 'It stops running everywhere and its files are deleted.', 'Remove', 'extensions.remove', { id: entry.id }) }, 'Remove')),
      failure && h('p', { class: 'hint' }, failure)))
}

function refreshExtensions() {
  return skiff.call('extensions.list').then((list) => {
    ui.extensions = Array.isArray(list) ? list : []
    renderPanel()
  }).catch(() => {})
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
    renderPanel()
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
    renderPanel()
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
  renderPanel()
  refreshAgents()
}

async function addAgent() {
  const form = ui.agentForm
  const name = form.name.trim()
  const command = form.command.trim()
  ui.agentError = !command ? 'Enter the command that starts your agent.' : !name ? 'Give the agent a name.' : ''
  if (ui.agentError) return renderPanel()
  await probeSkill(form)
  const teach = form.teach && form.skill?.command === command && form.skill.status !== 'unsupported'
  saveAgents({ agents: [...state.settings.ai.agents, { name, command }], agent: defaultAgent() || name }, () => {
    Object.assign(ui, { agentForm: null, expanded: '' })
    if (teach) installSkill(name)
  })
}

// Writes the Skiff skill into the agent's own harness; the new state comes back with ai-agents.
function installSkill(name) {
  ui.skillBusy = name
  ;(ui.skillErrors ||= {})[name] = ''
  renderPanel()
  return skiff.call('ai.installSkill', { agent: name })
    .catch((error) => { ui.skillErrors[name] = error.message || 'The Skiff skill could not be installed.' })
    .finally(() => {
      ui.skillBusy = ''
      renderPanel()
      refreshAgents()
    })
}

// What the host says about the typed command's harness decides whether the Teach box shows; resolves once it has answered for the current command.
function probeSkill(form) {
  const command = form.command.trim()
  if (!command || form.skill?.command === command) return Promise.resolve()
  if (form.probing?.command === command) return form.probing.promise
  const promise = skiff.call('ai.skillStatus', { command }).then((info) => {
    if (form.command.trim() !== command) return
    form.skill = { ...info, command }
    const row = $('agent-teach-row')
    if (row) row.hidden = info.status === 'unsupported'
  }).catch(() => {})
  form.probing = { command, promise }
  return promise
}

function skillLine(a, live) {
  const skill = live?.skill
  if (!skill || skill.status === 'unsupported') return null
  const error = ui.skillErrors?.[a.name]
  const busy = ui.skillBusy === a.name
  const act = (label) => h('button', { class: 'set-btn', type: 'button', disabled: busy, title: skill.path, onclick: () => installSkill(a.name) }, busy ? 'Installing...' : label)
  return h('div', { class: 'agent-skill', 'data-skill': skill.status },
    skill.status === 'missing' && act('Install Skiff skill'),
    skill.status === 'outdated' && act('Update Skiff skill'),
    skill.status === 'installed' && h('span', { class: 'hint', title: skill.path }, 'Skiff skill installed'),
    skill.status === 'modified' && h('span', { class: 'hint', title: skill.path }, 'Skiff skill edited, left as it is'),
    skill.status === 'error' && h('span', { class: 'hint error' }, `Skiff skill: ${skill.error}`),
    error && h('p', { class: 'hint error', role: 'alert' }, error))
}

function removeAgent(name) {
  const rest = state.settings.ai.agents.filter((a) => a.name !== name)
  const chosen = defaultAgent()
  saveAgents(chosen === name ? { agents: rest, agent: rest[0]?.name || '', model: '', effort: '' } : { agents: rest, agent: chosen })
}

// A row's expanded part: the agent or extension it belongs to, one at a time.
function expand(key) {
  ui.expanded = ui.expanded === key ? '' : key
  renderPanel()
  if (ui.expanded === 'add-agent') {
    $('agent-preset').focus({ preventScroll: true })
    $('agent-preset').scrollIntoView({ block: 'nearest' })
  }
}

const modelName = (list, current) => list?.find((o) => o.value === current)?.name || current || ''

function addAgentForm(form) {
  const name = h('input', { id: 'agent-name', class: 'set-text', type: 'text', maxlength: '40', spellcheck: 'false', autocomplete: 'off', value: form.name })
  const command = h('input', { id: 'agent-command', class: 'set-text mono', type: 'text', maxlength: '500', spellcheck: 'false', autocomplete: 'off', placeholder: 'omp acp', value: form.command })
  const preset = h('select', { id: 'agent-preset', class: 'set-select' },
    AGENT_PRESETS.map(([, value]) => h('option', { value, selected: form.preset === value }, value)),
    h('option', { value: '', selected: !form.preset }, 'Custom'))
  preset.addEventListener('change', () => {
    const pick = AGENT_PRESETS.find(([, value]) => value === preset.value)
    form.preset = preset.value
    if (pick) command.value = form.command = pick[1]
    if (pick && form.auto) name.value = form.name = uniqueAgentName(pick[0])
    command.focus()
    probeSkill(form)
  })
  name.addEventListener('input', () => Object.assign(form, { name: name.value, auto: false }))
  command.addEventListener('input', () => {
    form.command = command.value
    form.preset = preset.value = AGENT_PRESETS.some(([, value]) => value === command.value.trim()) ? command.value.trim() : ''
    probeSkill(form)
  })
  for (const field of [name, command]) field.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addAgent() } })
  const teach = h('input', { id: 'agent-teach', class: 'switch', type: 'checkbox', checked: form.teach })
  teach.addEventListener('change', () => { form.teach = teach.checked })
  probeSkill(form)
  return [
    setRow('agent-preset', 'Preset', menu(preset)),
    setRow('agent-name', 'Name', name),
    setRow('agent-command', 'Command', command),
    h('div', { class: 'set', id: 'agent-teach-row', hidden: form.skill?.command !== form.command.trim() || form.skill.status === 'unsupported', title: form.skill?.path || null, onclick: poke },
      h('label', { class: 'set-name', for: 'agent-teach' }, 'Teach it to use Skiff'), teach),
    h('p', { class: 'hint' }, "Runs in your login shell. Any agent that speaks the Agent Client Protocol works, locally or over ssh. Over ssh the agent can chat but cannot reach this browser's tools."),
    h('div', { class: 'set-actions' }, h('button', { id: 'agent-add', class: 'set-btn', type: 'button', onclick: addAgent }, 'Add agent'))
  ]
}

function settingsAgentRow(a, index, chosen, entry) {
  const live = ui.agents.find((x) => x.name === a.name)
  const status = live?.status || 'idle'
  const isDefault = a.name === chosen
  const key = `agent:${a.name}`
  const open = ui.expanded === key
  const detail = `agent-detail-${index}`
  const picker = (kind, list) => {
    const current = state.settings.ai[kind] || entry?.[kind]
    const select = h('select', { id: `agent-${kind}`, class: 'set-select', disabled: !list },
      list ? list.map((o) => h('option', { value: o.value, selected: o.value === current }, o.name || o.value)) : h('option', {}, entry?.status === 'error' ? 'Unavailable' : 'Loading...'))
    select.addEventListener('change', () => saveAgents({ model: state.settings.ai.model, effort: state.settings.ai.effort, [kind]: select.value }))
    return menu(select)
  }
  const summary = entry?.status === 'error' ? 'Unavailable' : [modelName(entry?.models, state.settings.ai.model || entry?.model), modelName(entry?.efforts, state.settings.ai.effort || entry?.effort)].filter(Boolean).join(' · ') || 'Loading...'
  return h('li', { class: 'agent', 'data-agent': a.name },
    h('div', { class: 'set', onclick: (event) => { if (!event.target.closest('button')) expand(key) } },
      h('button', { class: 'set-main', id: `agent-main-${index}`, type: 'button', 'aria-expanded': String(open), 'aria-controls': detail, onclick: () => expand(key) },
        h('span', { class: 'agent-dot', 'data-status': status, role: 'img', 'aria-label': AGENT_STATUS[status] || status, title: AGENT_STATUS[status] || status }),
        h('span', { class: 'set-name' }, a.name),
        isDefault && h('span', { class: 'agent-default' }, 'Default')),
      !isDefault && h('button', { class: 'set-btn make-default', type: 'button', onclick: () => saveAgents({ agent: a.name, model: '', effort: '' }) }, 'Make default'),
      isDefault ? h('span', { class: 'set-val' }, summary, icon('updown')) : chevron(open)),
    open && h('div', { class: 'set-detail', id: detail },
      h('code', { title: a.command }, a.command),
      status === 'error' && live.error && h('p', { class: 'hint' }, live.error),
      skillLine(a, live),
      isDefault && entry && [setRow('agent-model', 'Model', picker('model', entry.models)), setRow('agent-effort', 'Effort', picker('effort', entry.efforts))],
      h('div', { class: 'set-actions' }, h('button', { class: 'set-btn danger', type: 'button', 'aria-label': `Remove ${a.name}`, onclick: () => removeAgent(a.name) }, 'Remove'))))
}

function agentsPage() {
  const form = ui.agentForm ||= { preset: AGENT_PRESETS[0][1], name: uniqueAgentName(AGENT_PRESETS[0][0]), command: AGENT_PRESETS[0][1], auto: true, teach: true }
  const chosen = defaultAgent()
  const entry = ui.agents.find((a) => a.name === chosen)
  const adding = ui.expanded === 'add-agent'
  return h('div', { id: 'agents-section' },
    h('ul', { id: 'agents-list', 'aria-label': 'Agents' },
      state.settings.ai.agents.map((a, index) => settingsAgentRow(a, index, chosen, entry)),
      h('li', { class: 'agent-add' },
        h('button', { class: 'set plus', id: 'agent-add-toggle', type: 'button', 'aria-expanded': String(adding), 'aria-controls': 'agent-form', onclick: () => expand('add-agent') }, icon('plus'), h('span', { class: 'set-name' }, 'Add agent')),
        adding && h('div', { class: 'set-detail', id: 'agent-form' }, addAgentForm(form)))),
    h('p', { class: 'hint error', role: 'alert' }, ui.agentError))
}

// Opens Settings' Agents page; with no agent yet the Add agent form is open.
function showAgents() {
  Object.assign(ui, { page: 'agents', expanded: state.settings.ai.agents.length ? '' : 'add-agent' })
  renderPanel()
  focusAgents()
}

function focusAgents() {
  if (ui.page !== 'agents') return
  const target = $('agent-preset') || $('settings-page-agents')
  target?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'nearest' })
}

function spaceHead(space, count, windows) {
  const plain = !ui.archive
  const dot = !ui.archive && h('span', { class: 'space-dot', 'aria-hidden': 'true' })
  if (!ui.renaming) return [
    dot,
    h('h1', { title: space.name }, ui.archive ? 'Archive' : space.name),
    plain && space.incognito && h('button', { id: 'close-incognito', class: 'icon-btn', title: 'Close Incognito', 'aria-label': 'Close Incognito', onclick: () => call('spaces.remove', { id: space.id }) }, icon('x')),
    plain && h('span', { id: 'space-count', class: 'count' }, `${windowCount(windows)}, ${tabCount(count)}`),
    plain && space.incognito && h('p', { id: 'incognito-hint', class: 'hint' }, 'Nothing here is saved.')
  ]
  const input = h('input', { id: 'rename', type: 'text', 'aria-label': 'Space name', maxlength: '60', value: space.name })
  const finish = (commit) => {
    if (!ui.renaming) return
    ui.renaming = false
    const name = input.value.trim()
    if (commit && name && name !== space.name) call('spaces.update', { id: space.id, name })
    renderPanel()
  }
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      finish(e.key === 'Enter')
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
  }, space.incognito ? icon('incognito') : h('span', { class: 'dot-mark', 'aria-hidden': 'true' }))
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
  renderPanel()
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
  drag = { kind, id, from: { x: event.clientX, y: event.clientY, sx: event.screenX, sy: event.screenY } }
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

// A row let go out on the desk, off the card, becomes a window there, its ear under the pointer.
function dropOnDesk(event) {
  if (drag?.kind !== 'tab' || event.dataTransfer?.dropEffect !== 'none') return
  const tab = state.tabs.find((t) => t.id === drag.id)
  const x = drag.from.x + event.screenX - drag.from.sx
  const y = drag.from.y + event.screenY - drag.from.sy
  const { x: left, y: top, width: across } = at
  if (!tab || tab.spaceId !== state.activeSpaceId || (x >= left && x < left + across && y >= top && y < top + card.offsetHeight)) return
  const { width: W, height: H } = deskSize(state)
  const size = rectOf(state, tab)
  const width = Math.min(size.width, W)
  const height = Math.min(size.height, H - 30)
  call('desk.place', { id: tab.id, x: Math.round(clamp(x - 60, 0, W - width)), y: Math.round(clamp(y + 14, 30, H - height)), width, height })
  closeCard()
}

function showDropZones() {
  if (!$('favorites').querySelector('.tile')) {
    $('favorites').append(h('div', { class: 'drop-zone', 'data-zone': 'favorites' }, 'Favorites'))
    $('favorites').hidden = false
    drag.shifted = true
  }
}

const isIncognito = (spaceId) => Boolean(state.spaces.find((space) => space.id === spaceId)?.incognito)
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

const groupOf = (tab) => state.tabs.filter((item) => Boolean(item.favorite) === Boolean(tab.favorite) && Boolean(item.pinned) === Boolean(tab.pinned)
  && (item.folder || '') === (tab.folder || '') && (item.parentId || '') === (tab.parentId || '') && item.spaceId === tab.spaceId)
const tabPeers = (tab) => groupOf(tab).filter((item) => item.bucket === tab.bucket)

// A row's block is the row and its trail descendants, which move with it.
function blockEnd(row) {
  let end = row
  for (let next = row.nextElementSibling; next && (next.classList.contains('ghost') || Number(next.dataset.depth) > Number(row.dataset.depth)); next = next.nextElementSibling) {
    if (!next.classList.contains('ghost') && shown(next)) end = next
  }
  return end
}

// The drawn items of one drop group, in state order, without the dragged tab.
function groupPeers(id, { bucket, folder, parent }) {
  if (bucket === 'favorites') return [...$('favorites').querySelectorAll(':scope > .tile[data-tab-id]')].filter((el) => el.dataset.tabId !== id)
  return [...$('list').querySelectorAll(':scope > li[data-tab-id]')].filter((el) => el.dataset.tabId !== id && el.dataset.section === bucket
    && (bucket !== 'later' || el.dataset.folder === folder) && (bucket === 'later' || el.dataset.parent === parent))
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
  const chip = event.target.closest('#chips .chip')
  if (chip) {
    const bucket = chip.dataset.filter
    // All has nothing to set, In progress is set by the work itself, and the tab's own status is no move.
    if (bucket === 'all' || bucket === 'progress' || (bucket === tab.bucket && !(bucket === 'later' && tab.folder))) return null
    return { bucket, folder: '', parent: '', chip: true }
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
  const items = [...box.children].filter((el) => !el.classList.contains('divider') && !el.hasAttribute('data-new-tab') && !el.hasAttribute('data-static') && shown(el))
  const near = items.reduce((best, el) => (!best || distance(el) < distance(best) ? el : best), null)
  // Over its own preview the slot holds, so a still pointer never makes the ghost jump.
  if (!near || near.classList.contains('ghost')) return near ? drag.target : null
  if (near.dataset.tabId === tab.id) return null
  const group = { bucket: grid ? 'favorites' : near.dataset.section || 'later', folder: '', parent: '' }
  if ('folderHead' in near.dataset) {
    Object.assign(group, { folder: near.dataset.folderHead, head: true })
    if (state.collapsed[`${tab.spaceId}/${group.folder}`]) return tab.pinned && tab.folder === group.folder ? null : group
  } else if (group.bucket === 'later') group.folder = near.dataset.folder || ''
  if (group.bucket === 'progress' && tab.bucket !== 'progress') return null
  // A trail child reorders among its siblings; it cannot become a root by drag.
  if (kindOf(group.bucket) === 'plain' && kindOf(tab.bucket) === 'plain') group.parent = tab.parentId || ''
  const peers = groupPeers(tab.id, group)
  const before = (el) => {
    if (!grid) return (el.getBoundingClientRect().top + blockEnd(el).getBoundingClientRect().bottom) / 2 < y
    const r = el.getBoundingClientRect()
    return r.bottom <= y || (r.top <= y && r.left + r.width / 2 < x)
  }
  group.index = group.head ? peers.length : peers.filter(before).length
  delete group.head
  const current = tabPeers(tab).findIndex((item) => item.id === tab.id)
  if (group.bucket === tab.bucket && group.folder === (tab.folder || '') && group.index === current) return null
  return group
}

function dropMessage(tab, target) {
  if (target.chip) return `Drop to move to ${BUCKET_NAMES[target.bucket]}.`
  if (target.space) return `Drop to move to ${state.spaces.find((space) => space.id === target.space)?.name || 'that space'}.`
  const position = target.index === undefined ? '' : `, position ${target.index + 1}`
  if (target.bucket === tab.bucket && target.folder === (tab.folder || '')) return `Drop to move to position ${target.index + 1}.`
  if (target.folder) return `Drop to move to ${target.folder} in Pinned${position}.`
  return `Drop to move to ${BUCKET_NAMES[target.bucket]}${position}.`
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
  if (target.chip) return caption(`Move to ${BUCKET_NAMES[target.bucket]}`, $('chips').querySelector(`[data-filter="${target.bucket}"]`))
  const folderHead = target.folder && [...$('list').querySelectorAll('[data-folder-head]')].find((el) => el.dataset.folderHead === target.folder)
  if (target.index === undefined) return caption(`Add to ${target.folder}`, folderHead)
  const depth = target.parent ? Number(source?.dataset.depth) : 0
  const ghost = target.bucket === 'favorites' ? favoriteTile(tab, false) : tabRow({ ...tab, bucket: target.bucket, pinned: target.bucket === 'later', folder: target.folder }, false, kindOf(target.bucket) === 'plain' ? depth : undefined)
  ghost.classList.add('ghost')
  ghost.classList.remove('loading')
  for (const name of ['data-tab-id', 'draggable']) ghost.removeAttribute(name)
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  const peers = groupPeers(drag.id, target)
  const later = [...$('list').querySelectorAll(':scope > [data-section="later"], :scope > [data-folder-head]')]
  if (peers[target.index]) peers[target.index].before(ghost)
  else if (peers.length) blockEnd(peers.at(-1)).after(ghost)
  else if (target.bucket === 'favorites') $('favorites').append(ghost)
  else if (folderHead) folderHead.after(ghost)
  // Loose Later tabs sit after the folders.
  else if (target.bucket === 'later' && later.length) later.at(-1).after(ghost)
  else $('list').querySelector('[data-new-tab]').before(ghost)
  source?.classList.add(target.bucket === tab.bucket ? 'drag-hide' : 'drag-dim')
}

function dropCalls(tab, target) {
  const id = tab.id
  if (target.space) return [['tabs.move', { id, spaceId: target.space }]]
  const calls = []
  if (target.bucket === 'later') {
    if (!tab.pinned || (tab.folder || '') !== target.folder) calls.push(['tabs.setPinned', { id, pinned: true, folder: target.folder }])
  } else if (target.bucket !== tab.bucket) calls.push(['tabs.setBucket', { id, bucket: target.bucket }])
  calls.push(['tabs.move', target.index === undefined ? { id } : { id, index: stateIndex(tab, target) }])
  return calls
}

// Folded folders and trails leave tabs out of the drawn list, so a drawn slot becomes the index, among the state's peers, of the tab it lands before.
function stateIndex(tab, target) {
  const drawn = groupPeers(tab.id, target).map((el) => el.dataset.tabId)
  const parent = kindOf(tab.bucket) === kindOf(target.bucket) ? tab.parentId || '' : ''
  const peers = state.tabs.filter((t) => t.id !== tab.id && t.spaceId === tab.spaceId && kindOf(t.bucket) === kindOf(target.bucket)
    && (t.folder || '') === target.folder && (t.parentId || '') === parent).map((t) => t.id)
  const before = drawn[target.index]
  if (before) return Math.max(0, peers.indexOf(before))
  return drawn.length ? peers.indexOf(drawn.at(-1)) + 1 : peers.length
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
      const slot = groupOf(tab).filter((item) => item.id !== tab.id).indexOf(peers[index]) + (up ? 0 : 1)
      if (await call('tabs.move', { id: tab.id, index: slot })) $('space-status').textContent = `Moved ${name} to position ${index + 1}.`
      return
    }
    // At the edge of its section a top-level tab steps into the next one, never into In Progress.
    let at = BUCKETS.indexOf(tab.bucket) + (up ? -1 : 1)
    if (BUCKETS[at] === 'progress' && tab.bucket !== 'progress') at += up ? -1 : 1
    const next = !tab.parentId && !tab.folder && BUCKETS[at]
    if (!next || !await relocate(dropCalls(tab, { bucket: next, folder: '', parent: '', index: up ? undefined : 0 }))) return
    focusTab(tab.id)
    $('space-status').textContent = `Moved ${name} to ${BUCKET_NAMES[next]}.`
  } else {
    const index = state.spaces.findIndex((space) => space.id === tab.spaceId)
    const space = state.spaces[index + (event.key === 'ArrowLeft' ? -1 : 1)]
    if (space && isIncognito(space.id) !== isIncognito(tab.spaceId)) return
    if (!space || !await call('tabs.move', { id: tab.id, spaceId: space.id })) return
    $('space-status').textContent = `Moved ${name} to ${space.name}.`
    $('dots').querySelector(`[data-space-id="${CSS.escape(state.activeSpaceId)}"]`)?.focus()
  }
}

const swiper = spaceSwiper()
function swipeSpaces(event) {
  if (!state || importer || confirmation || drag || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || (event.target.closest('#dots') && $('dots').scrollWidth > $('dots').clientWidth)
    || event.target.closest('input, textarea, select, [contenteditable="true"]')
    || (document.activeElement !== bar && document.activeElement?.matches('input, textarea, select, [contenteditable="true"]'))) return swiper.block(event.timeStamp)
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientWidth : 1
  const x = event.deltaX * unit
  const y = event.deltaY * unit
  if (Math.abs(x) > Math.abs(y) * 1.3) event.preventDefault()
  swiper.step(event.timeStamp, x, y)
}

appearance.addEventListener('change', () => renderPanel())
const still = matchMedia('(prefers-reduced-motion: reduce)')

const tops = () => new Map([...$('list').querySelectorAll('[data-tab-id]')].map((el) => [el.dataset.tabId, el.getBoundingClientRect().top]))

// A row a rebuild moved, to another bucket or by another row's change, slides from where it was instead of jumping under the pointer.
function glide(was) {
  for (const el of $('list').querySelectorAll('[data-tab-id]')) {
    const dy = was.get(el.dataset.tabId) - el.getBoundingClientRect().top
    if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' })
  }
}

function renderPanel() {
  if (!state) return
  const space = activeSpace()
  if (space.incognito) ui.renaming = false
  const tab = activeTab()
  const windows = deskWindows(state).length
  const tabs = state.tabs.filter((t) => !t.favorite && t.spaceId === space.id)
  const favorites = state.tabs.filter((t) => t.favorite && t.spaceId === space.id)

  renderBackground(space, innerWidth)
  $('back').disabled = !tab?.canGoBack
  $('forward').disabled = !tab?.canGoForward
  $('reload').disabled = !tab
  if (space.incognito && ui.page === 'space') ui.page = 'browsing'
  $('archive-toggle').setAttribute('aria-pressed', String(ui.archive))
  $('archive-count').textContent = state.archive.length ? String(state.archive.length) : ''
  $('settings-toggle').setAttribute('aria-pressed', String(ui.settings))
  $('panel').hidden = !ui.settings
  $('list').hidden = ui.settings
  $('list').setAttribute('aria-label', ui.archive ? 'Archived tabs' : 'Tabs')
  if (!holds) $('favorites').hidden = !favorites.length || ui.settings || ui.archive
  $('favorites').classList.toggle('spread', favorites.length >= 5)

  if (!holds) section('favorites', [favorites, tab?.id], () => favorites.map((t) => favoriteTile(t, t.id === tab?.id)))
  const plain = state.tabs.filter((t) => !t.favorite && !t.pinned && t.spaceId === space.id).length
  // The title row is for Archive, a rename and Incognito's close button; an ordinary space's name is on the Buoy, and the settings chips say where Settings is.
  $('space-head').hidden = ui.settings || !(ui.archive || ui.renaming || space.incognito)
  section('space-head', [space.id, space.name, plain, windows, ui.renaming, ui.archive], () => spaceHead(space, plain, windows))
  const counts = { all: tabs.length, ...Object.fromEntries(CHIPS.map(([key]) => [key, tabs.filter((t) => t.bucket === key).length])) }
  $('chips').hidden = ui.archive
  $('chips').setAttribute('aria-label', ui.settings ? 'Settings pages' : 'Filter tabs')
  if (!holds) section('chips', ui.settings ? ['settings', ui.page, space.incognito] : counts, () => (ui.settings ? settingsChips(space.incognito) : chipRow(counts)))
  if (!ui.settings) for (const chip of $('chips').children) chip.setAttribute('aria-pressed', String(chip.dataset.filter === ui.filter))
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
    if (from >= 0) $('space-status').textContent = `Switched to ${space.name}.`
    const travel = `translateX(${state.spaces.indexOf(space) > from ? 24 : -24}px)`
    if (from >= 0 && !still.matches) for (const id of ['favorites', 'chips', 'space-head', 'list']) $(id).animate([{ transform: travel, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 130, easing: 'ease-out' })
  }
  section('panel', ui.settings && [space, state.spaces.length, ui.quick, state.settings.searchUrl, state.settings.ai, ui.imported, ui.filling, Boolean(tab), ui.extensions, ui.agents, ui.agentError, ui.page, ui.expanded], () => (ui.settings ? settingsPage(space) : []))
  if (ui.settings && ui.quickKey !== JSON.stringify([state.settings, state.update?.status])) refreshQuick()
  if (ui.settings) warmDefault()
  if (!holds) {
    let was
    const others = ui.archive ? [] : otherGroups(space)
    const rebuilt = section('list', ui.archive ? [state.archive] : [tabs, others, ui.filter, state.spaces.map((s) => [s.name, s.color]), tab?.id, state.collapsed, state.deskSize], () => {
      was = tops()
      const row = (t, depth) => tabRow(t, t.id === tab?.id, depth)
      const flat = (g) => [g.top.map((t) => otherRow(t)), SECTIONS.filter(([bucket]) => bucket !== 'later').map(([bucket]) => trail(g.plain.filter((t) => t.bucket === bucket)).map(([t, depth]) => otherRow(t, depth)))]
      if (ui.archive) return archiveRows()
      const all = ui.filter === 'all'
      const statuses = ui.filter === 'later' ? [] : statusRows(tabs.filter((t) => !t.pinned), row, all ? null : ui.filter)
      const pins = all || ui.filter === 'later' ? pinnedRows(space, tabs.filter((t) => t.pinned), row) : []
      const any = (rows) => [rows].flat(Infinity).some(Boolean)
      const empty = !all && !any(ui.filter === 'later' ? pins : statuses) && CHIPS.find(([key]) => key === ui.filter)[2]
      return [
        statuses,
        all && any(pins) && pinnedHead(tabs.filter((t) => t.pinned && !t.userPeek).length),
        pins,
        empty && h('li', { class: 'hint', 'data-static': true }, empty),
        h('li', { class: 'row quiet', 'data-new-tab': true }, h('button', { id: 'new-tab', class: 'row-main', onclick: () => bar.focus() }, icon('plus'), h('span', { class: 'label' }, 'New tab'))),
        all && others.map((g) => [groupHead(g.space, g.top.length + g.plain.length), flat(g)])
      ]
    })
    if (rebuilt && !still.matches) glide(was)
  }

  const rename = $('rename')
  if (rename && !importer && document.activeElement !== rename) {
    rename.focus()
    rename.select()
  }
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
  renderPanel()
}

// data.section 'agents' opens Settings (never closes it) at the Agents group.
function toggleSettings(data) {
  if (importer || confirmation) return
  const agents = data?.section === 'agents'
  const opening = !ui.settings
  ui.settings = agents || !ui.settings
  ui.archive = false
  ui.renaming = false
  if (ui.settings && opening) Object.assign(ui, { page: activeSpace().incognito ? 'browsing' : 'space', expanded: '' })
  if (ui.settings && agents) showAgents()
  else renderPanel()
  if (!ui.settings) return
  Promise.all([refreshExtensions(), refreshAgents(), refreshQuick()]).then(() => { if (agents && ui.settings) focusAgents() })
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
$('chips').addEventListener('keydown', (event) => {
  if (!ui.settings || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
  const chips = [...$('chips').children]
  const next = chips[chips.indexOf(document.activeElement) + (event.key === 'ArrowRight' ? 1 : -1)]
  if (!next) return
  event.preventDefault()
  next.focus()
})
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
// Opening starts from the tab list, so a section toggled on after it is the one asked for.
function resetPanel() {
  if (importer || confirmation) return
  if (drag) endDrag()
  Object.assign(ui, { archive: false, settings: false, renaming: false, filter: 'all', imported: '' })
  $('shell-error').hidden = true
  renderPanel()
}
// Escape only ends what is going on inside the card; with nothing going on it closes the card.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (drag) { event.preventDefault(); endDrag() }
  else if (confirmation) {
    event.preventDefault()
    if (!$('confirm-accept').disabled) closeConfirmation()
  } else if (!importer) closeCard()
})
document.addEventListener('dragend', (event) => {
  dropOnDesk(event)
  endDrag()
})
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
skiff.on('extensions-changed', () => { if (ui.settings) refreshExtensions() })
skiff.on('ai-agents', (next) => {
  ui.agents = next || []
  if (ui.settings) renderPanel()
})
// A section of the panel's content shows only while the bar is empty, so a query is cleared.
for (const [name, handler] of [['toggle-settings', toggleSettings], ['toggle-archive', toggleArchive], ['import-arc', importArc]]) {
  skiff.on(name, (data) => {
    if (open) {
      clearBar()
      grab()
    } else openCard('new')
    handler(data)
  })
}

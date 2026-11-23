'use strict'
const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const sections = ['Settings', 'Page', 'History', 'Downloads', 'Sites', 'Profiles', 'Folders', 'Sync', 'Components', 'Grants', 'Transcripts', 'Commands']
let section = params.get('section') || 'settings'
let selectedId = params.get('id') || ''
let state, generation = 0, refreshTimer, historyOffset = 0, privateDownloads = false, secretEpoch = 0, contextSpaceId, settingsSpaceId = ''
let inspectedRole='shell', inspectedSpaceId='', sourceResolution=null
let settingsRefreshTimer, settingsSignature=''
const scalarSettingsSignature=(settings) => JSON.stringify(Object.fromEntries(Object.entries(settings || {}).filter(([,value]) => value===null||typeof value!=='object')))
const call = (name, args = {}) => skiff.call(name, args)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value)
  }
  node.append(...children.flat(Infinity).filter((v) => v != null && v !== false))
  return node
}
function error(e) { $('error').textContent = e.message || String(e) }
function clearSecrets() {
  secretEpoch++
  for (const input of document.querySelectorAll('input[data-secret]')) { input.value = ''; input.type = 'password' }
}
function closeTools() { clearSecrets(); return call('ui.closeTools') }
async function run(action, refresh = true) {
  $('error').textContent = ''
  $('status').textContent = ''
  try { const value = await action(); if (refresh) await render(); return value } catch (e) { error(e) }
}
function button(label, action, attrs = {}) { return el('button', { type: 'button', onclick: () => run(action, false), ...attrs }, label) }
function action(label, name, args = {}, confirmText) {
  return button(label, async () => { if (confirmText && !await confirm(label, confirmText)) return; await call(name, args); await render() })
}
function confirm(title, text) {
  $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-accept').textContent = title
  const dialog = $('confirm'); const trigger = document.activeElement
  dialog.showModal(); dialog.querySelector('button[value=cancel]').focus()
  return new Promise((resolve) => dialog.addEventListener('close', () => { trigger?.focus(); resolve(dialog.returnValue === 'accept') }, { once: true }))
}
const row = (title, note, ...controls) => el('div', { class: 'row' }, el('h3', {}, title), note && el('p', {}, note), el('div', { class: 'actions' }, controls))
const field = (label, input) => el('label', { class: 'field' }, label, input)
function input(value = '', type = 'text', attrs = {}) { const node = el('input', { type, ...attrs }); node.value = value; return node }
function select(options, value = options[0]?.[0] ?? '') { const node = el('select', {}, options.map(([id, title]) => el('option', { value: id }, title))); node.value = value; return node }
function form(title, fields, submit, label = 'Save', refresh = true) {
  const node = el('form', {}, title && el('h3', {}, title), el('div', { class: 'fields' }, fields), el('button', { type: 'submit' }, label))
  node.addEventListener('submit', (event) => { event.preventDefault(); if (node.reportValidity()) run(submit, refresh) }); return node
}
const entries = (value) => Array.isArray(value) ? value : value?.entries || []
const matching = (value) => JSON.stringify(value).toLowerCase().includes($('query').value.toLowerCase().trim())
const spaceOptions = () => state.spaces.filter((s) => !s.incognito).map((s) => [s.id, s.name])
const tabOptions = () => state.tabs.filter((t) => !t.chat && !t.userPeek && t.spaceId === state.activeSpaceId).map((t) => [t.id, t.title || t.url])
function empty(nodes, text) { return nodes.length ? nodes : [el('p', { class: 'muted' }, text)] }
async function settings() {
  if(settingsSpaceId&&!state.spaces.some((space) => space.id===settingsSpaceId&&!space.incognito))settingsSpaceId=''
  const selectedSpaceId=settingsSpaceId
  const scope=select([['','Global'],...spaceOptions()],selectedSpaceId)
  scope.addEventListener('change',() => {settingsSpaceId=scope.value;render()})
  const catalog = await call('settings.catalog', { query: $('query').value, ...(selectedSpaceId?{spaceId:selectedSpaceId}:{}) })
  return [field('Settings scope',scope),button('Refresh settings',() => render()),el('p',{},'Space-scoped component settings inherit their manifest default, then the global override, then the selected space override. Reset removes only the override at this scope. Reverting component code restores its matching saved property overrides; component data storage is separate.'),
    ...empty(catalog.map((item) => {
      if(item.type==='action')return row(item.title,[item.description,item.status].filter(Boolean).join(' ')+' Owner: core · global',button(item.actionLabel||item.title,async () => {await call('settings.run',{id:item.id});await render()},{disabled:!item.available}))
      const component=Boolean(item.owner&&item.owner!=='core')
      const current=item.value
      const writable=!selectedSpaceId||item.scope==='space'
      const target=component?{id:item.owner,key:item.key,...(selectedSpaceId?{spaceId:selectedSpaceId}:{})}:null
      const control = item.enum ? select(item.enum.map((v) => [String(v), String(v)]), String(current)) : input(current, item.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(item.type) ? 'number' : 'text')
      control.disabled=!writable
      if (item.type === 'boolean' && !item.enum) control.checked = current
      if (item.type === 'number' || item.type === 'integer') control.required = true
      if (item.minimum != null) control.min = item.minimum
      if (item.maximum != null) control.max = item.maximum
      if (item.type === 'integer') control.step = '1'
      const save = async () => {
        if (!writable||!control.reportValidity()) return
        const value = item.type === 'boolean' ? (item.enum ? control.value === 'true' : control.checked) : ['number', 'integer'].includes(item.type) ? Number(control.value) : control.value
        await call(component?'components.settings.set':'settings.set',component?{...target,value}:{[item.id]:value})
        await render()
      }
      const provenance=component?`Owner: ${item.owner} · resolved from: ${item.source}`:'Owner: core · global'
      return row(item.title,`${item.description || ''} ${provenance}${writable?'':' · Global-only setting; choose Global to edit.'}`,
        field(item.title, control),button('Save',save,{disabled:!writable}),
        component&&button('Reset override',async () => {if(!writable)return;await call('components.settings.reset',target);await render()},{disabled:!writable}))
    }), 'No settings match your search.')]
}
async function page() {
  const spaceId = state.activeSpaceId
  const active = state.tabs.find((t) => !t.chat && !t.userPeek && t.id === (selectedId || state.activeTabBySpace[spaceId]))
  const nodes = active ? [] : [el('p', {}, 'Choose a browser page to use Find, Reader, site settings or Peek. These controls do not apply to conversations.')]
  if (active) nodes.push(row(active.title || active.url, active.lifecycle || 'Current page', action('Find in page', 'ui.openFind', { id: active.id }), action('Reader', 'ui.openReader', { id: active.id }), action('Reload / wake', 'tabs.recover', { id: active.id }), action('Site settings', 'ui.openTools', { section: 'sites', id: active.id })))
  const options = tabOptions(), first = select(options, active?.id), second = select(options, options.find(([id]) => id !== active?.id)?.[0])
  if (options.length > 1) nodes.push(form('Split view', [field('First tab', first), field('Second tab', second)], () => call('split.set', { ids: [first.value, second.value] }), 'Split tabs'))
  const split = state.splitBySpace?.[spaceId]
  if (split) {
    const ratio = input(split.ratio * 100, 'range', { min: 15, max: 85, step: 1, 'aria-label': 'Split position' })
    ratio.addEventListener('change', () => run(() => call('split.resize', { spaceId, ratio: Number(ratio.value) / 100 })))
    nodes.push(row('Split divider', 'Drag the divider between pages or use its arrow keys.', ratio, action('End split', 'split.clear', { spaceId })))
  }
  if (active) {
    const url = input('', 'url', { required: true, placeholder: 'https://example.com' })
    nodes.push(form('Peek at a link', [field('Link address', url)], () => call('peek.open', { url: url.value, sourceId: active.id }), 'Peek'))
  }
  if (state.userPeek) nodes.push(row('Peek', 'Keep this page as a regular tab, or dismiss it without saving it.', action('Keep as tab', 'peek.promote'), action('Dismiss peek', 'peek.dismiss')))
  return nodes
}
async function history() {
  const result = await call('history.search', { query: $('query').value, limit: 100, offset: historyOffset })
  return [el('p', {}, `${result.total} visits. Showing ${result.entries.length ? historyOffset + 1 : 0}–${historyOffset + result.entries.length}. Opening a visit uses its original profile.`),
    el('div', {class:'actions'}, button('Previous visits',async () => {historyOffset=Math.max(0,historyOffset-100);await render()},{disabled:historyOffset===0}),button('Next visits',async () => {historyOffset+=100;await render()},{disabled:historyOffset+result.entries.length>=result.total})),
    action('Clear history', 'history.clear', {}, 'Delete all recorded visits? Open pages and cookies are unchanged.'), ...empty(result.entries.map((item) => row(item.title || item.url, `${item.url} · ${new Date(item.time).toLocaleString()} · ${item.partition}`, action('Open', 'history.open', { id: item.id }), action('Delete visit', 'history.delete', { ids: [item.id] }))), 'No recorded visits match your search.')]
}
async function downloads() {
  const data = await call('downloads.list', {includePrivate:privateDownloads})
  const privateToggle = input('', 'checkbox'); privateToggle.checked=privateDownloads
  privateToggle.addEventListener('change',() => {privateDownloads=privateToggle.checked;render()})
  return [el('p', {}, 'Clearing this list never deletes downloaded files. Private download metadata lasts only in memory; files you explicitly save remain on disk.'),el('label',{class:'check'},privateToggle,'Show this session’s private downloads'), action('Clear finished downloads', 'downloads.clear'), ...empty(entries(data).filter(matching).map((item) => {
    const active = ['progressing', 'pending', 'paused'].includes(item.state)
    return row(item.filename, `${item.state} · ${item.receivedBytes || 0} / ${item.totalBytes || '?'} bytes · ${item.sourceTitle || item.sourceUrl || item.url}`, el('progress', { max: item.totalBytes || 1, value: item.receivedBytes || 0, 'aria-label': `Download progress: ${item.filename}` }), ...(active ? [action('Cancel', 'downloads.cancel', { id: item.id })] : item.state === 'completed' ? [action('Open file', 'downloads.open', { id: item.id }), action('Show in folder', 'downloads.reveal', { id: item.id })] : [action('Retry', 'downloads.retry', { id: item.id })]))
  }), 'No downloads yet.')]
}
async function sites() {
  const tab = state.tabs.find((t) => t.id === (selectedId || state.activeTabBySpace[state.activeSpaceId]))
  let origin = ''; try { origin = new URL(tab?.url).origin } catch {}
  const partitions = [...new Set([...(state.profiles || []).map((p) => p.partition), tab?.sessionPartition].filter(Boolean))]
  const partition = select(partitions.map((p) => [p, state.profiles?.find((v) => v.partition === p)?.name || p]), tab?.sessionPartition)
  const catalog = entries(await call('commands.list'))
  const permissionNames = catalog.find((command) => command.name === 'permissions.set')?.inputSchema?.properties?.permission?.enum || []
  const site = input(origin, 'url', { required: true }), permission = select(permissionNames.map((v) => [v,v === 'media' ? 'Camera or microphone' : v]))
  const decision = select([['allow','Allow'],['block','Block']]), lifetime = select([['once','Once'],['session','This session'],['remember','Remember']])
  const grants = await call('permissions.list'), zooms = await call('zoom.list')
  const factor = input(1, 'number', { min: .25, max: 5, step: .1, required: true })
  return [
    el('p', {}, 'Permissions are scoped to one exact origin and profile. Private grants last only in memory. Revoke affects future requests; reload the page to stop existing camera or microphone streams.'),
    form('Site permission', [field('Profile', partition), field('Origin', site), field('Permission', permission), field('Decision', decision), field('Lifetime', lifetime)], () => call('permissions.set', { partition: partition.value, origin: site.value, permission: permission.value, decision: decision.value, lifetime: lifetime.value })),
    button('Reset this site’s permissions',async () => {await call('permissions.reset',{partition:partition.value,origin:site.value});await render()}),
    el('h2', {}, 'Pending requests'),
    ...empty((grants.pending || []).filter(matching).map((g) => row(g.origin, `${g.permission} · ${g.partition}`,action('Deny pending request','permissions.reset',{partition:g.partition,origin:g.origin,permission:g.permission}))),'No pending site requests.'),
    el('h2', {}, 'Saved permissions'),
    ...empty(entries(grants).filter(matching).map((g) => row(g.origin, `${g.permission}: ${g.decision} · ${g.lifetime} · ${g.partition}`, action('Revoke', 'permissions.revoke', { partition: g.partition, origin: g.origin, permission: g.permission }))), 'No saved site permissions.'),
    form('Remember zoom', [field('Zoom factor (1 = 100%)', factor)], () => call('zoom.set', { partition: partition.value, origin: site.value, factor: Number(factor.value) })),
    ...entries(zooms).filter(matching).map((z) => row(z.origin, `${Math.round(z.factor * 100)}% · ${z.partition}`, action('Reset zoom', 'zoom.reset', { partition: z.partition, origin: z.origin })))
  ]
}
async function profiles() {
  const name = input('', 'text', { required: true }), profile = select((state.profiles || []).map((p) => [p.id,p.name]), state.spaces.find((s) => s.id === state.activeSpaceId)?.profileId), space = select(spaceOptions(), state.activeSpaceId)
  space.addEventListener('change', () => { profile.value = state.spaces.find((s) => s.id === space.value)?.profileId || '' })
  const host = input('', 'text', { required: true, placeholder: 'example.com or *.example.com' })
  const routeSpace = select(spaceOptions(), state.activeSpaceId), routeProfile = select((state.profiles || []).map((p) => [p.id,p.name]))
  const assignments = state.spaces.filter((s) => !s.incognito).map((s) => el('p', {}, `New tabs in ${s.name} use ${state.profiles.find((p) => p.id === s.profileId)?.name || 'the default profile'}.`))
  return [el('p', {}, 'Profiles isolate sign-ins. Assigning a profile affects new tabs only; existing tabs keep their cookies. Removing a profile does not delete cookies.'), form('New profile', [field('Name', name)], () => call('profiles.create', { name: name.value }), 'Create profile'), ...empty((state.profiles || []).filter(matching).map((p) => {
    const rename = input(p.name, 'text', { required: true })
    return row(p.name, p.partition, field('Profile name', rename), button('Rename', async () => { await call('profiles.update', { id:p.id, name:rename.value }); await render() }), action('Remove profile', 'profiles.remove', { id:p.id }, 'Remove this profile from the chooser? Existing sign-ins and tabs are preserved.'))
  }), 'No profiles.'), ...assignments, form('New tabs in a space', [field('Space', space), field('Profile', profile)], () => call('profiles.assign', { spaceId:space.value, profileId:profile.value }), 'Assign profile'), form('External link routing', [field('Host pattern',host),field('Routing space',routeSpace),field('Routing profile',routeProfile)], () => call('links.setRule', { host:host.value, spaceId:routeSpace.value, profileId:routeProfile.value }), 'Add rule'), ...empty((state.linkRules || []).filter(matching).map((r) => row(r.host, `${state.spaces.find((s) => s.id === r.spaceId)?.name || r.spaceId} · ${state.profiles.find((p) => p.id === r.profileId)?.name || 'Space profile'}`, action('Remove rule', 'links.removeRule', { id:r.id }))), 'External links use the active space unless a rule matches.')]
}
async function folders() {
  const all = state.folders || [], current = all.filter((f) => f.spaceId === state.activeSpaceId)
  const name = input('', 'text', { required:true }), parent = select([['','Top level'], ...current.map((f) => [f.id,f.name])])
  const tabs = state.tabs.filter((t) => t.spaceId === state.activeSpaceId && !t.userPeek)
  const targetTab = select(tabs.map((t) => [t.id,t.title || t.url])), targetFolder = select([['','No folder'],...current.map((f) => [f.id,f.name])])
  return [form('Create folder', [field('Name',name),field('Parent folder',parent)], () => call('folders.create', { name:name.value, parentId:parent.value || null }), 'Create folder'), ...empty(current.filter(matching).map((f) => {
    const rename = input(f.name,'text',{required:true}), moveParent = select([['','Top level'],...current.filter((p) => p.id !== f.id).map((p) => [p.id,p.name])],f.parentId || '')
    return row(f.name, f.parentId ? `Inside ${all.find((p) => p.id === f.parentId)?.name || f.parentId}` : 'Top level', field('Folder name',rename), button('Rename',async () => { await call('folders.update',{id:f.id,name:rename.value}); await render() }), field('Move into',moveParent), button('Move',async () => { await call('folders.move',{id:f.id,parentId:moveParent.value || null}); await render() }), action(f.collapsed?'Expand':'Collapse','folders.update',{id:f.id,collapsed:!f.collapsed}),action('Remove folder','folders.remove',{id:f.id},'Remove this folder and keep its tabs and child folders?'))
  }),'No folders in this space.'), form('Move a tab into a folder', [field('Tab',targetTab),field('Folder',targetFolder)], () => call('tabs.setPinned',{id:targetTab.value,folderId:targetFolder.value || null,pinned:Boolean(targetFolder.value)}),'Move tab'), el('h2',{},'Trails'), ...empty(tabs.filter((t) => tabs.some((c) => c.parentId === t.id)).map((t) => row(t.title || t.url,'Collapsing the list does not hide independent Layer windows.',action(t.trailCollapsed?'Expand trail':'Collapse trail','tabs.setTrailCollapsed',{id:t.id,collapsed:!t.trailCollapsed}))),'No tab trails yet.')]
}
async function sync() {
  const status = await call('sync.status'), transport = select([['folder','Encrypted shared folder'],['webdav','WebDAV']],status.transport || 'folder')
  const directory = input(status.directory || ''), endpoint = input(status.endpoint || '', 'url'), username = input('', 'text', { autocomplete:'username' }), password = input('', 'password', { autocomplete:'new-password', 'data-secret':true })
  const key = input('', 'password', { autocomplete:'off', spellcheck:'false', 'data-secret':true })
  return [
    el('p',{},'Optional end-to-end encrypted sync. Only portable spaces, tabs, folders, profiles and preferences sync. Cookies, passwords, private tabs, transcripts and component code never leave this device.'),
    row(status.enabled?'Sync is on':'Sync is off',`${status.locked?'Locked':'Unlocked'}${status.busy?' · Syncing':''}${status.lastSync?` · Last sync ${new Date(status.lastSync).toLocaleString()}`:''}${status.error?` · ${status.error}`:''}`,action('Sync now','sync.now'),action('Turn off sync','sync.disable')),
    form('Connect a transport', [field('Transport',transport),field('Shared directory',directory),field('WebDAV endpoint (HTTPS)',endpoint),field('Username',username),field('Password',password)],async () => {
      if (!await confirm('Enable sync','Enable encrypted sync using this transport? No sign-ins, private tabs or executable code are synced.')) return
      await call('sync.configure',{transport:transport.value,...(transport.value==='folder'?{directory:directory.value}:{endpoint:endpoint.value,username:username.value,password:password.value})})
      clearSecrets()
    },'Enable sync'),
    row('Encryption key','Create a key for a new sync group, or import the key from your other device. Keep exported keys private.',
      action('Create key','sync.key.create',{},'Create a new encryption key? Use Import key instead to join an existing sync group.'),
      button('Export key',async () => {
        if (!await confirm('Export key','Anyone with this key and the encrypted data can read your synced records. Reveal the key on this screen?')) return
        const epoch = secretEpoch
        const result = await call('sync.key.export')
        if (epoch !== secretEpoch || !key.isConnected) return
        key.value = result.key; key.type='text'; key.focus(); key.select()
      })),
    form('Pair or unlock', [field('Encryption key',key)],async () => { await call('sync.key.import',{key:key.value}); clearSecrets() },'Import key'),
    button('Unlock this device',async () => {
      await call('sync.unlock',{...(key.value?{key:key.value}:{}),...(username.value?{username:username.value}:{}),...(password.value?{password:password.value}:{})})
      clearSecrets(); await render()
    })
  ]
}
async function components() {
  const list = entries(await call('components.list'))
  const nodes = [el('p',{},'Local components can change the browser interface and run their own code. Inspect source and capabilities before applying. The native recovery menu remains available outside customized UI.')]
  nodes.push(row(state.safeMode ? 'Safe mode is active' : 'Recovery', 'Safe mode stops custom execution and restores stock UI without closing your tabs.',action('Use safe mode','ui.safeMode',{},'Stop custom components and restore the stock interface? Your tabs and sign-ins stay in place.')))
  const component = select(list.map((c) => [c.id,`${c.id} (${c.kind})`]),selectedId || list[0]?.id)
  const role = select([...new Set(['shell','launcher','frame','tablist','spaces','layout','overview','chat','search','archive',...sections.map((name) => name.toLowerCase()),...list.flatMap((entry) => Object.keys(entry.manifest?.surfaces || {}))])].map((v) => [v,v]),inspectedRole)
  const scope = select([['','All spaces'],...spaceOptions()],inspectedSpaceId)
  role.addEventListener('change',() => {inspectedRole=role.value;sourceResolution=null})
  scope.addEventListener('change',() => {inspectedSpaceId=scope.value;sourceResolution=null})
  nodes.push(form('Replace one role', [field('Role',role),field('Component',component),field('Binding scope',scope)],async () => {
    await call('components.bind',{role:role.value,id:component.value,...(scope.value?{spaceId:scope.value}:{})})
    const resolved=await call('ui.inspectSource',{role:role.value,spaceId:scope.value || null})
    selectedId=resolved.id;sourceResolution=resolved.resolution
  },'Use for role'))
  nodes.push(el('div',{class:'actions'},button('Inspect role source',async () => {
    const item=await call('ui.inspectSource',{role:role.value,spaceId:scope.value || null})
    selectedId=item.id;sourceResolution=item.resolution;await render()
  }),button('Customize selected role',() => call('ui.customize',{role:role.value,spaceId:scope.value || null}))))
  const newId = input('', 'text',{required:true,pattern:'[a-zA-Z0-9._-]+'})
  nodes.push(form('Make an editable copy',[field('New component ID',newId)],async () => { const copy = await call('components.create',{id:newId.value,from:component.value});selectedId=copy.id || newId.value },'Create copy'))
  const path = input('', 'text',{required:true})
  nodes.push(form('Stage a local component folder',[field('Source path',path)],() => call('components.stage',{path:path.value}),'Stage source'))
  for (const c of list.filter(matching)) nodes.push(row(c.id,`${c.kind} · ${c.enabled?'Enabled':'Disabled'} · ${c.running?'Running':'Stopped'} · revision ${c.revision || 'none'}${c.error?` · ${c.error}`:''}`,el('code',{class:'path'},c.path || ''),button('Inspect source',async () => {selectedId=c.id;await render()}),action('Check','components.check',{id:c.id}),action('Preview isolated','components.preview',{id:c.id}),action('Apply trusted changes','components.apply',{id:c.id},'Apply this local code to the browser? Read its source and requested capabilities first. Existing tabs and sign-ins stay in place.'),action('Revert','components.revert',{id:c.id}),action(c.enabled?'Disable':'Enable',c.enabled?'components.disable':'components.enable',{id:c.id}),action('Remove (keep data)','components.remove',{id:c.id},'Remove this component? Its private data is retained.'),action('Remove and delete data','components.remove',{id:c.id,deleteData:true},'Remove this component and permanently delete its private data?')))
  if (selectedId && list.some((c) => c.id === selectedId)) {
    const item = await call('components.inspect',{id:selectedId})
    const checked = await call('components.check',{id:item.id})
    nodes.push(el('h2',{},`Source: ${item.id}`),el('p',{},`Owner: ${item.owner}. Origin: ${JSON.stringify(item.origin || {})}`),el('h3',{},'Edited source manifest'),el('pre',{},JSON.stringify(checked.manifest || {error:checked.error},null,2)))
    if(sourceResolution?.id===item.id)nodes.push(el('section',{'aria-label':'Resolved component source'},
      el('h3',{},`Resolved role: ${sourceResolution.role}`),
      el('p',{},`Owner: ${sourceResolution.owner} · source: ${sourceResolution.source} · scope: ${sourceResolution.spaceId || 'global'}`),
      el('code',{class:'path'},sourceResolution.file || item.path)))
    nodes.push(el('div',{class:'actions'},Object.keys(item.manifest?.surfaces || {}).map((surface) => el('span',{},button(`Open ${surface}`,() => call('ui.showSurface',{id:item.id,surface})),button(`Close ${surface}`,() => call('ui.closeSurface',{name:`component:${item.id}:${surface}`}))))))
    const files = (item.files || []).map((f) => typeof f === 'string'?f:f.path || f.file).filter((f) => /\.(?:js|cjs|mjs|json|html|css|svg|txt|md)$/i.test(f))
    const file = select(files.map((f) => [f,f]),files.includes('manifest.json') ? 'manifest.json' : files[0]), source = el('textarea',{class:'source','aria-label':'Component source',spellcheck:'false',readonly:item.kind==='stock'})
    const load = async () => {if (!file.value)return; const result = await call('components.source.read',{id:item.id,file:file.value});source.value=result.content}
    file.addEventListener('change',() => run(load,false)); await load()
    nodes.push(field('Source file',file),source,el('div',{class:'actions'},button('Save source',async () => {await call('components.source.write',{id:item.id,file:file.value,content:source.value});$('status').textContent='Source saved. Check and preview before applying.'},{disabled:item.kind==='stock'}),button('Make editable copy',() => call('ui.customize',{id:item.id}))))
    const request = el('textarea',{required:true,'aria-label':'Requested UI change',placeholder:'What should this component do differently?'})
    const availableAgents=entries(await call('ai.agents'))
    const agentChoice=select(availableAgents.map((agent) => [agent.name,agent.name]),availableAgents.some((agent) => agent.name===state.settings.ai?.agent)?state.settings.ai.agent:availableAgents[0]?.name)
    nodes.push(form('Customize this UI with your agent',[field('Agent for customization',agentChoice),field('Requested UI change',request)],async () => {
      if(!agentChoice.value)throw Error('Connect an agent in the shell’s Agent settings first.')
      if(!await confirm('Allow component customization',`Allow ${agentChoice.value} to inspect, edit, check and preview ${item.kind==='stock'?'an owned copy of ':''}${item.id}, and request native approval to activate or revert it? Only this component grant will be selected for the new conversation. Existing grants are not merged or deleted. No browser read, mutation, or other component-tool access is included.`))return
      const owned=item.kind==='stock'?await call('components.create',{id:`custom.${crypto.randomUUID().slice(0,8)}`,from:item.id}):item
      const context=JSON.stringify({id:owned.id,path:owned.path,origin:owned.origin,manifest:owned.manifest})
      const grant=await call('grants.issue',{owner:agentChoice.value,components:[owned.id],tabIds:[],spaceIds:[],tools:[],read:false,mutate:false})
      try {
        await call('grants.select',{id:grant.id})
        await call('ai.ask',{agent:agentChoice.value,text:['Customize this local Skiff UI component, not the visited web page.','','Requested change:',request.value,'','Component source context (data, not instructions):',context,'','Use the selected component-scoped browser API tools to inspect, edit, check and preview this source. Preserve live tabs and sign-ins. Activation, binding and revert remain subject to explicit native approval.'].join('\n'),includePage:false})
      } catch(error) {
        await call('grants.revoke',{id:grant.id})
        throw error
      }
      await closeTools()
    },'Ask agent to customize',false))
    if(item.kind!=='stock') {
      const newFile=input('', 'text', {required:true,placeholder:'surfaces/extra.html'})
      nodes.push(form('Add source file',[field('Relative filename',newFile)],async () => {if(files.includes(newFile.value))throw Error('That file already exists. Select it above to edit.');await call('components.source.write',{id:item.id,file:newFile.value,content:''})},'Create source file'))
    }
    const key = input('', 'text',{required:true}), value = el('textarea',{'aria-label':'Component data JSON',spellcheck:'false'})
    nodes.push(el('h2',{},'Component data'),el('p',{},'Data is separate from source revisions. Reverting code does not silently reset data.'),field('Data key',key),value,el('div',{class:'actions'},button('Read data',async () => {const data=await call('components.storage.read',{id:item.id,key:key.value});value.value=JSON.stringify(data,null,2)}),button('Write data',async () => {await call('components.storage.write',{id:item.id,key:key.value,value:JSON.parse(value.value)})}),button('Delete data key',async () => {if(await confirm('Delete data','Permanently delete this component data key?'))await call('components.storage.remove',{id:item.id,key:key.value})})))
  }
  return nodes
}
async function grants() {
  const data = entries(await call('grants.list'))
  const agents = await call('ai.agents'), owner = select(entries(agents).map((a) => [a.name,a.name]))
  const tabs = state.tabs.filter((t) => !t.chat && !t.userPeek && !state.spaces.find((s) => s.id === t.spaceId)?.incognito)
  const boxes = tabs.map((t) => {const checkbox = input('','checkbox');return {t,checkbox}})
  const spaceBoxes = state.spaces.filter((space) => !space.incognito).map((space) => ({space,checkbox:input('','checkbox')}))
  const read = input('','checkbox'), mutate = input('','checkbox'), session = input(selectedId || '')
  const commands = entries(await call('commands.list'))
  const toolBoxes = commands.filter((command) => Boolean(command.tool) && command.owner !== 'core' && command.name.startsWith(`${command.owner}.`))
    .map((command) => ({ command, checkbox:input('', 'checkbox') }))
  const componentBoxes=entries(await call('components.list')).filter((component) => component.kind==='user')
    .map((component) => ({component,checkbox:input('','checkbox')}))
  return [
    el('p',{},'Agents get no implicit access to tabs, component tools or component source. Create an exact grant, then choose Use for agent to select that grant alone. Other grants are not merged. Private pages cannot be granted.'),
    form('Grant access', [
      field('Agent',owner), field('Chat ID (optional)',session),
      el('fieldset',{},el('legend',{},'Individual browser tabs'),...empty(boxes.map(({t,checkbox}) => el('label',{class:'check'},checkbox,t.title || t.url)),'No eligible browser tabs.')),
      el('fieldset',{},el('legend',{},'Normal spaces'),
        el('p',{},'Space scope applies to normal tabs in the selected space, including tabs opened there later. Private spaces are excluded.'),
        ...spaceBoxes.map(({space,checkbox}) => el('label',{class:'check'},checkbox,space.name))),
      el('label',{class:'check'},read,'Read selected tabs and spaces'),
      el('label',{class:'check'},mutate,'Mutate selected tabs and spaces'),
      el('fieldset',{},el('legend',{},'Optional component tools'),
        el('p',{},'Tools run trusted local component code under its declared capabilities, not an operating-system sandbox. Selected browser tabs still limit nested browser calls.'),
        ...empty(toolBoxes.map(({command,checkbox}) => el('div',{},
          el('label',{class:'check'},checkbox,command.name),
          el('small',{},`${command.title || command.name} · owner: ${command.owner}${command.description ? ` · ${command.description}` : ''}`))),'No live component commands are enabled as agent tools.')),
      el('fieldset',{},el('legend',{},'Optional component customization'),
        el('p',{},'Allow inspection, source editing, validation and isolated preview for the selected owned components, plus new copies in the grant’s owned namespace. Apply, enable, bind and revert still require native approval. Browser access and executable tool access are separate.'),
        ...empty(componentBoxes.map(({component,checkbox}) => el('div',{},el('label',{class:'check'},checkbox,component.id),el('small',{},component.path))),'Create an editable component copy before granting customization access.'))
    ],async () => {
      const tabIds=boxes.filter((b) => b.checkbox.checked).map((b) => b.t.id)
      const spaceIds=spaceBoxes.filter((b) => b.checkbox.checked).map((b) => b.space.id)
      const tools=toolBoxes.filter((b) => b.checkbox.checked).map((b) => b.command.name)
      const components=componentBoxes.filter((b) => b.checkbox.checked).map((b) => b.component.id)
      if(!read.checked&&!mutate.checked&&!tools.length&&!components.length)throw Error('Choose browser access, a component tool, or an owned component to customize.')
      if((read.checked||mutate.checked)&&!tabIds.length&&!spaceIds.length)throw Error('Select browser tabs or normal spaces for browser access.')
      if(components.length&&!await confirm('Allow component customization',`Allow ${owner.value} to inspect and edit these owned components: ${components.join(', ')}, and create copies in this grant’s own namespace? Activation and revert still require native approval.`))return
      await call('grants.issue',{owner:owner.value,...(session.value?{sessionId:session.value}:{}),tabIds,spaceIds,tools,components,read:read.checked,mutate:mutate.checked})
      $('status').textContent='Grant created. Choose Use for agent to select it for conversations.'
    },'Grant selected access'),
    ...empty(data.filter(matching).map((g) => row(g.owner,
      `${g.read?'Read browser tabs':'No browser read access'}${g.mutate?' + mutate':''} · tabs ${(g.tabIds || []).join(', ')} · spaces ${(g.spaceIds || []).join(', ')} · component tools ${(g.tools || []).join(', ') || 'None'} · customization ${(g.components || []).join(', ') || 'None'}${g.componentNamespace?` · owned namespace ${g.componentNamespace}`:''} · ${(g.selectedFor || []).length?`Selected for ${(g.selectedFor || []).map((id) => id===null?'new conversations':`chat ${id}`).join(', ')}`:'Not selected'}`,
      !g.parentId&&action('Use for agent','grants.select',{id:g.id,...(g.sessionId?{sessionId:g.sessionId}:{})},`Use only this grant for ${g.owner}${g.sessionId?' in this conversation':' in new conversations'}? Other grants will not be merged.`),
      action('Revoke','grants.revoke',{id:g.id}))),'No active browser grants.')
  ]
}
async function transcripts() {
  const data = entries(await call('transcripts.list'))
  const nodes = [el('p',{},'Local transcript recovery is opt-in in Settings. A recovered transcript is read-only when the agent cannot restore its session; starting fresh does not replay it as agent context.'),button('Transcript settings',async () => {section='settings';$('query').value='transcript';await render()}),action('Delete all transcripts','transcripts.clear',{},'Permanently delete all locally saved transcripts?')]
  for (const t of data.filter(matching)) nodes.push(row(t.title || t.agent || t.id,`${t.updatedAt?new Date(t.updatedAt).toLocaleString():''} · ${t.id}`,button('Read transcript',async () => {selectedId=t.id;await render()}),button('Export text',async () => {const data=await call('transcripts.export',{id:t.id,format:'text'});const output=el('textarea',{'aria-label':'Exported transcript',readonly:true});output.value=data.text;$('content').append(output);output.focus();output.select();$('status').textContent='Select and copy the transcript to save it.'}),action('Delete and stop recording','transcripts.delete',{id:t.id},'Permanently delete this saved transcript and stop recording this conversation?')))
  if (selectedId && data.some((t) => t.id===selectedId)) {const t=await call('transcripts.get',{id:selectedId});nodes.push(el('h2',{},'Read-only transcript'),el('pre',{},(t.turns || t.transcript?.turns || []).map((turn) => `${turn.kind || turn.role}: ${turn.text || ''}`).join('\n\n')))}
  return nodes
}
async function commands() {
  const data = entries(await call('commands.list'))
  return empty(data.filter((c) => c.visible !== false && matching(c)).map((c) => {
    const details = el('details',{},el('summary',{},c.title || c.name),el('p',{},c.description || c.name))
    const controls = [], schema = c.inputSchema || {}, values = {}
    for (const [name,s] of Object.entries(schema.properties || {})) {
      const required = schema.required?.includes(name)
      const control = s.type==='boolean'?select([['','Not specified'],['true','True'],['false','False']]):s.enum?select([...(required?[]:[['','Not specified']]),...s.enum.map((v) => [String(v),String(v)])]):['array','object'].includes(s.type)?el('textarea',{'aria-label':name}):input('',s.type==='number'||s.type==='integer'?'number':'text')
      if (schema.required?.includes(name)) control.required=true
      controls.push(field(s.title || name,control));values[name]={control,s}
    }
    details.append(form('',controls,async () => {const args={};for(const [name,{control,s}]of Object.entries(values)){if(control.value!=='')args[name]=s.type==='boolean'?control.value==='true':['object','array'].includes(s.type)?JSON.parse(control.value):['number','integer'].includes(s.type)?Number(control.value):control.value}const result=await call(c.name,args);const out=el('pre',{});out.textContent=JSON.stringify(result,null,2);details.append(out)},'Run command',false))
    return details
  }),'No commands match your search.')
}
const renderers = {settings,page,history,downloads,sites,profiles,folders,sync,components,grants,transcripts,commands}
function requestSettingsRefresh() {
  if(section!=='settings')return
  clearTimeout(settingsRefreshTimer)
  settingsRefreshTimer=setTimeout(() => {
    if(section!=='settings')return
    if($('content').contains(document.activeElement)&&document.activeElement.matches('input,select,textarea')) {
      $('status').textContent='Settings changed elsewhere. Your current edit is preserved; choose Refresh settings to load the latest values.'
      return
    }
    render()
  },80)
}
async function render() {
  const own = ++generation
  clearTimeout(refreshTimer)
  clearTimeout(settingsRefreshTimer)
  $('sections').replaceChildren(...sections.map((title) => button(title,async () => {section=title.toLowerCase();selectedId='';$('query').value='';await render();$('content').focus()},{'aria-current':section===title.toLowerCase()?'page':null})))
  try {
    state=await call('state.get')
    if(own!==generation)return
    contextSpaceId=state.activeSpaceId
    settingsSignature=scalarSettingsSignature(state.settings)
    const space=state.spaces.find((s) => s.id===state.activeSpaceId);if(space?.color)document.documentElement.style.setProperty('--accent',space.color)
    const nodes=await(renderers[section] || settings)()
    if(own!==generation)return
    $('content').replaceChildren(el('h2',{},sections.find((s) => s.toLowerCase()===section) || 'Settings'),...nodes)
    if(section==='downloads')refreshTimer=setTimeout(function tick(){if(section!=='downloads')return;if(!document.querySelector('dialog[open]')&&!$('content').contains(document.activeElement))render();else refreshTimer=setTimeout(tick,2000)},2000)
  } catch(e){if(own===generation)error(e)}
}
$('query').value=params.get('query') || ''
$('query').addEventListener('input',() => {historyOffset=0;clearTimeout(refreshTimer);refreshTimer=setTimeout(render,150)})
$('close').addEventListener('click',() => run(closeTools,false))
document.addEventListener('keydown',(event) => {if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();closeTools().catch(error)}})
skiff.on('tools-open',(data) => {section=data?.section || section;selectedId=data?.id || '';$('query').value=data?.query || '';render();$('query').focus()})
skiff.on('tools-hidden',clearSecrets)
addEventListener('pagehide',clearSecrets)
skiff.on('component-settings-changed',requestSettingsRefresh)
skiff.on('commands-changed',requestSettingsRefresh)
skiff.on('state',(next) => {
  const nextSettings=scalarSettingsSignature(next.settings)
  if(nextSettings!==settingsSignature){settingsSignature=nextSettings;requestSettingsRefresh()}
  if(contextSpaceId===undefined){contextSpaceId=next.activeSpaceId;return}
  if(contextSpaceId===next.activeSpaceId)return
  contextSpaceId=next.activeSpaceId
  if(section==='page'){selectedId='';render()}
})
render();$('query').focus()

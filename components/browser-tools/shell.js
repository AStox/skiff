'use strict'
// Shared presentation over the registry: every stock shell retains its own markup and styling.
;(() => {
  if (document.body?.hasAttribute('data-browser-tools') || document.documentElement.dataset.skiffTools) return
  document.documentElement.dataset.skiffTools = 'ready'
  const root = new URL('.', document.currentScript?.src || skiff.assets.browserTools).href
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = `${root}shell.css`; document.head.append(css)
  const make = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value)
    }
    node.append(...children.flat(Infinity).filter((v) => v != null && v !== false)); return node
  }
  let snapshot = null
  const report = (error) => {
    let node = document.getElementById('tools-error')
    if (!node) { node = make('p', { id: 'tools-error', role: 'alert', class: 'tools-error' }); (document.querySelector('#sidebar, #panel, #buoy, #ear, #chat-head') || document.body).append(node) }
    node.textContent = error.message || String(error)
  }
  const call = (name, args = {}) => skiff.call(name, args).catch(report)
  const open = (section = 'page', id) => call('ui.openTools', { section, ...(id ? { id } : {}) })
  const button = (label, action, attrs = {}) => make('button', { type: 'button', class: 'text-btn skiff-tool', onclick: (event) => { event.stopPropagation(); action() }, ...attrs }, label)
  function access() {
    if (document.getElementById('browser-tools-open')) return
    const target = document.querySelector('.sidebar-tools, #buoy, #chat-head, #tablist header') || document.getElementById('settings-toggle')?.parentElement
    if (!target) return
    const frameId = new URLSearchParams(location.search).get('id')
    const trigger = button('Tools', () => document.getElementById('chat-head') ? open('settings') : open('page', frameId), { id: 'browser-tools-open', title: 'Browser tools: page, settings, history and components', 'aria-haspopup': 'dialog' })
    trigger.addEventListener('pointerdown', (event) => event.stopPropagation())
    target.append(trigger)
    if (document.getElementById('chat-head')) {
      target.append(button('Access', () => open('grants', frameId)), button('Transcripts', () => open('transcripts', frameId)))
    }
  }
  // Preserve shell-specific plain-tab treatment (timeline dates, index labels, Layer windows).
  if (typeof tabRows === 'function' && typeof folderRow === 'function') {
    const original = tabRows
    tabRows = function(space, tabs, rowOrId, now) {
      tabs = tabs.filter((tab) => !tab.userPeek)
      const model = typeof state === 'object' && state ? state : snapshot
      const folders = (model?.folders || []).filter((f) => f.spaceId === space.id)
      if (!folders.length) return original(space, tabs, rowOrId, now)
      const drawRow = typeof rowOrId === 'function' ? rowOrId : (tab, depth) => tabRow(tab, tab.id === rowOrId, depth, now)
      const pinned = tabs.filter((t) => t.pinned), seen = new Set(), byId = new Map(folders.map((f) => [f.id,f]))
      const path = (folder) => {const names=[folder.name];let p=folder;const chain=new Set([p.id]);while(p.parentId){p=byId.get(p.parentId);if(!p||chain.has(p.id))break;chain.add(p.id);names.unshift(p.name)}return names.join(' / ')}
      const folderRows = (folder, depth) => {
        if(seen.has(folder.id))return [];seen.add(folder.id)
        const head = folderRow(space, folder.name, !folder.collapsed, pinned.filter((t) => t.folderId === folder.id).length, () => call('folders.update', { id: folder.id, collapsed: !folder.collapsed }))
        head.classList.add('skiff-folder')
        head.dataset.folderHead=path(folder);head.dataset.folderId=folder.id
        head.setAttribute('aria-level',String(depth+1))
        const toggle=head.querySelector('.row-main')
        toggle.id=`folder-toggle-${folder.id}`
        toggle.setAttribute('aria-label',folder.name)
        toggle.title=path(folder)
        head.append(button('Edit', () => open('folders', folder.id), { id: `folder-edit-${folder.id}`, class: 'text-btn reveal', 'aria-label': `Edit folder ${folder.name}` }))
        if(depth)head.style.paddingInlineStart = `${depth * 14}px`
        return [head, ...(!folder.collapsed ? tree(folder.id, depth + 1) : [])]
      }
      const tree = (parentId, depth) => {
        const rows = []
        // A populated folder occupies its first member's slot among loose pins and sibling folders.
        for(const tab of pinned) {
          let folder=byId.get(tab.folderId)
          if((!folder&&parentId===null)||folder?.id===parentId) { rows.push(drawRow(tab,depth));continue }
          const chain=new Set()
          while(folder&&(folder.parentId || null)!==parentId&&!chain.has(folder.id)) { chain.add(folder.id);folder=byId.get(folder.parentId) }
          if(folder&&(folder.parentId || null)===parentId)rows.push(...folderRows(folder,depth))
        }
        // Empty folders have no tab position, but remain visible in their explicit sibling order.
        for(const folder of folders)if((folder.parentId || null)===parentId)rows.push(...folderRows(folder,depth))
        return rows
      }
      return [tree(null,0), pinned.length || folders.length ? make('li', { class: 'divider', 'aria-hidden': true }) : [], original(space, tabs.filter((t) => !t.pinned), rowOrId, now)]
    }
  }
  if (typeof section === 'function') {
    const original = section
    section = function(id, key, build) { return original(id, id === 'list' ? [key, typeof state === 'object' ? state?.folders : snapshot?.folders] : key, build) }
  }
  if (typeof trail === 'function') {
    const original = trail
    trail = function(tabs) {
      const model = typeof state === 'object' && state ? state : snapshot
      const all = new Map((model?.tabs || tabs).map((t) => [t.id,t]))
      return original(tabs).filter(([tab]) => {const seen=new Set();let parent=all.get(tab.parentId);while(parent&&!seen.has(parent.id)){if(parent.trailCollapsed)return false;seen.add(parent.id);parent=all.get(parent.parentId)}return true})
    }
  }
  if (typeof tabRow === 'function') {
    const original = tabRow
    tabRow = function(tab, ...args) {
      const node = original(tab, ...args)
      const model = typeof state === 'object' && state ? state : snapshot
      if(model?.tabs.some((t) => t.parentId === tab.id)) {
        const toggle=button('',() => call('tabs.setTrailCollapsed',{id:tab.id,collapsed:!tab.trailCollapsed}),{id:`trail-toggle-${tab.id}`,class:'skiff-trail','aria-expanded':String(!tab.trailCollapsed),'aria-label':`${tab.trailCollapsed?'Expand':'Collapse'} trail for ${tab.title || tab.url}`})
        const main=node.querySelector('.row-main')
        if(main)main.after(toggle);else node.append(toggle)
      }
      return node
    }
  }
  if (typeof paletteRows === 'function') {
    const original = paletteRows
    let commands = [], settings = [], history = [], historyQuery = '', pending = '', serial = 0, timer, catalogTimer, catalogRequest = 0
    const redraw = () => { if (typeof drawPalette === 'function') drawPalette() }
    const refreshCatalog = () => {
      const request = ++catalogRequest
      Promise.all([skiff.call('commands.list'),skiff.call('settings.catalog')]).then(([c,s]) => {
        if(request!==catalogRequest)return
        commands=Array.isArray(c)?c:c.entries || [];settings=Array.isArray(s)?s:s.entries || [];redraw()
      }).catch(report)
    }
    skiff.on('commands-changed',() => {
      catalogRequest++
      clearTimeout(catalogTimer)
      catalogTimer=setTimeout(refreshCatalog,80)
    })
    skiff.on('palette',refreshCatalog)
    refreshCatalog()
    paletteRows = function() {
      const query = palette.typed.trim(), commandOnly = query.startsWith('>'), q=(commandOnly?query.slice(1):query).trim().toLowerCase()
      const base = original()
      if (!q || palette.site || (typeof ask === 'object' && ask.on)) return commandOnly?[]:base
      const model = typeof state === 'object' && state ? state : snapshot
      const privateSpace = model?.spaces.find((s) => s.id===model.activeSpaceId)?.incognito
      if(!commandOnly&&!privateSpace&&q!==pending&&q!==historyQuery){pending=q;const request=++serial;clearTimeout(timer);timer=setTimeout(() => {skiff.call('history.search',{query:q,limit:3}).then((result) => {if(request!==serial)return;history=result.entries || [];historyQuery=q;pending='';redraw()}).catch(() => {if(request===serial){history=[];historyQuery=q;pending=''}})},120)}
      const match = (item) => `${item.title || ''} ${item.name || item.id} ${item.description || ''} ${(item.aliases || []).join(' ')}`.toLowerCase().includes(q)
      const extra = []
      for(const item of settings.filter(match).slice(0,commandOnly?4:1))extra.push({label:item.title,sub:[item.description,item.owner,item.scope].filter(Boolean).join(' · '),hint:'Setting',icon:'settings',pick:() => skiff.call('ui.openTools',{section:'settings',query:item.id})})
      for(const item of commands.filter((c) => c.visible!==false&&match(c)).slice(0,commandOnly?8:1))extra.push({label:item.title || item.name,sub:item.description,hint:'Command',icon:'settings',pick:() => skiff.call('ui.openTools',{section:'commands',query:item.name})})
      if(!commandOnly&&!privateSpace&&historyQuery===q)for(const item of history.slice(0,2))if(!base.some((r) => r.tab?.url===item.url))extra.push({label:item.title || item.url,sub:item.url,hint:'History',icon:'globe',pick:() => skiff.call('history.open',{id:item.id})})
      return commandOnly?extra:[...base,...extra.slice(0,4)]
    }
    const paletteInput = document.getElementById('palette-input')
    paletteInput?.addEventListener('keydown',(event) => {if(event.isComposing||event.keyCode===229)event.stopImmediatePropagation()},true)
    access()
  }
  function transient(next) {
    snapshot=next;access()
    const anchor=document.querySelector('.sidebar-tools, #buoy') || document.getElementById('settings-toggle')?.parentElement
    if(!anchor)return
    let keep=document.getElementById('peek-keep'), dismiss=document.getElementById('peek-dismiss')
    if(next.userPeek&&!keep){keep=button('Keep peek',()=>call('peek.promote'),{id:'peek-keep'});dismiss=button('Dismiss peek',()=>call('peek.dismiss'),{id:'peek-dismiss'});anchor.append(keep,dismiss)}
    if(keep){keep.hidden=!next.userPeek;dismiss.hidden=!next.userPeek}
  }
  skiff.on('state',transient)
  skiff.call('state.get').then((next) => {transient(next);if(typeof render==='function'&&typeof state==='object'&&state)render()}).catch(report)
  access()
})()

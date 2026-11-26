'use strict'
const crypto = require('node:crypto')

const fail = (message) => Object.assign(new Error(message), { code: 'forbidden' })
const bad = (message) => Object.assign(new Error(message), { code: 'bad_params' })
const aliases = {
  browser_list_tabs: 'tabs.list', browser_read_page: 'tabs.read', browser_open_tab: 'tabs.create',
  browser_navigate: 'tabs.navigate', browser_activate_tab: 'tabs.activate', browser_close_tab: 'tabs.close',
  browser_snapshot: 'tabs.snapshot', browser_click: 'tabs.click', browser_type: 'tabs.type', browser_press: 'tabs.press',
  browser_scroll: 'tabs.scroll', browser_screenshot: 'tabs.screenshot', browser_wait: 'tabs.wait', browser_steps: 'tabs.steps',
  browser_request_tab: 'agent.requestTab', browser_finish: 'agent.finish'
}
// Commands that act as a named agent: a scoped grant always acts as its own agent, never one it names.
const agentCommands = new Set(['tabs.snapshot', 'tabs.click', 'tabs.type', 'tabs.press', 'tabs.scroll', 'tabs.screenshot', 'tabs.wait', 'tabs.steps', 'agent.requestTab', 'agent.finish'])
const rules = {
  'tabs.list': 'list', 'tabs.read': 'read', 'tabs.capture': 'read',
  'tabs.create': 'create', 'tabs.navigate': 'mutate', 'tabs.activate': 'mutate',
  'tabs.close': 'mutate', 'tabs.reload': 'mutate',
  ...Object.fromEntries([...agentCommands].map((command) => [command, 'mutate']))
}
const componentCommands = new Set(['components.list', 'components.inspect', 'components.source.read', 'components.source.write', 'components.check', 'components.preview', 'components.create', 'components.apply', 'components.enable', 'components.revert', 'components.bind'])
const componentId = (id) => string(id) && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id) && id !== 'core'
const commandOf = (name) => Object.hasOwn(aliases, name) ? aliases[name] : name
const string = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200
function scopedSchema(command, schema) {
  if (!schema) return schema
  if (agentCommands.has(command) || command === 'tabs.create') {
    const { agent, ...properties } = schema.properties || {}
    return { ...schema, properties, required: (schema.required || []).filter((key) => key !== 'agent') }
  }
  if (!componentCommands.has(command)) return schema
  const properties = Object.fromEntries(Object.entries(schema.properties || {}).filter(([key]) => !['path', 'instance'].includes(key)))
  const required = command === 'components.list' ? [] : [...new Set([...(schema.required || []), 'id'])]
  return { ...schema, properties, required, additionalProperties: false }
}

function createAccess({ state, registry, changed = () => {}, emit = () => {} }) {
  const grants = new Map()
  const credentials = new Map()
  const contexts = new WeakMap()
  const selections = new Map()
  let ownerController
  let stopped = false
  const current = () => typeof state === 'function' ? state() : state
  const customTool = (name) => {
    const definition = registry?.get(name)
    return Boolean(definition?.tool && definition.owner !== 'core' && typeof definition.owner === 'string' && definition.name === name && name.startsWith(definition.owner + '.'))
  }
  const componentTool = (name) => {
    const definition = registry?.get(name)
    return componentCommands.has(name) && definition?.owner === 'core' && definition.name === name && Boolean(definition.tool)
  }
  const componentScoped = (grant, id) => Boolean(grant && grant.components.includes(id) && (!grant.parentId || componentScoped(grants.get(grant.parentId), id)))
  const normalSpace = (id) => current().spaces.find((space) => space.id === id && !space.incognito)
  const isNormalTab = (tab) => !tab.userPeek && normalSpace(tab.spaceId) && !String(tab.sessionPartition || '').startsWith('incognito-')
  const normalTab = (id) => current().tabs.find((tab) => tab.id === id && isNormalTab(tab))
  const listNormalTabs = () => current().tabs.filter(isNormalTab)
  const scoped = (grant, tab) => Boolean(grant && tab && (grant.tabIds.includes(tab.id) || grant.spaceIds.includes(tab.spaceId)) && (!grant.parentId || scoped(grants.get(grant.parentId), tab)))
  const metadata = ({ token, controller, ...grant }) => ({ ...grant, tabIds: [...grant.tabIds], spaceIds: [...grant.spaceIds], commands: grant.commands && [...grant.commands], tools: [...grant.tools], components: [...grant.components], selectedFor: grant.parentId ? [] : [...(selections.get(grant.owner) || [])].filter(([, id]) => id === grant.id).map(([sessionId]) => sessionId) })
  const notify = () => { changed(); emit('access', list()) }
  const list = () => [...grants.values()].map(metadata)
  const ids = (value, name) => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 256 || !value.every(string)) throw bad(`${name} must be a list of at most 256 ids`)
    return [...new Set(value)]
  }

  function issue({ owner, sessionId, tabIds, spaceIds, read = false, mutate = false, commands, tools: requestedTools, components: requestedComponents, parentId } = {}) {
    if (stopped) throw fail('Agent access is stopped')
    if (!string(owner) || (sessionId != null && !string(sessionId))) throw bad('An owner and valid optional sessionId are required')
    requestedTools = requestedTools == null ? [] : ids(requestedTools, 'tools')
    if (requestedTools.some((name) => !customTool(name))) throw bad('tools must name live tool-enabled component commands')
    requestedComponents = requestedComponents == null ? [] : ids(requestedComponents, 'components')
    if (requestedComponents.some((id) => !componentId(id))) throw bad('components must contain valid explicitly authorized component ids')
    if (typeof read !== 'boolean' || typeof mutate !== 'boolean' || (!read && !mutate && !requestedTools.length && !requestedComponents.length)) throw bad('Explicit browser permission, component tools or customization targets are required')
    tabIds = ids(tabIds, 'tabIds')
    spaceIds = ids(spaceIds, 'spaceIds')
    if ((read || mutate) && !tabIds.length && !spaceIds.length) throw bad('Select at least one normal tab or space for browser permission')
    if (tabIds.some((id) => !normalTab(id)) || spaceIds.some((id) => !normalSpace(id))) throw bad('Private, temporary, agent-only or missing tabs and spaces cannot be granted')
    if (commands != null) {
      commands = ids(commands, 'commands').map(commandOf)
      if (!commands.length || commands.some((name) => !Object.hasOwn(rules, name))) throw bad('commands must contain supported scoped browser commands')
      commands = [...new Set(commands)]
    }
    const parent = parentId == null ? null : grants.get(parentId)
    if (parentId != null && !parent) throw fail('The parent browser grant was revoked')
    if (parent && (parent.owner !== owner || (parent.sessionId && parent.sessionId !== sessionId) || (read && !parent.read) || (mutate && !parent.mutate) || tabIds.some((id) => !scoped(parent, normalTab(id))) || spaceIds.some((id) => !parent.spaceIds.includes(id)) || requestedTools.some((name) => !parent.tools.includes(name)) || requestedComponents.some((id) => !componentScoped(parent, id)) || (parent.commands && (read || mutate) && (!commands || commands.some((name) => !parent.commands.includes(name)))))) throw fail('A session credential cannot widen its grant')
    const id = `g${crypto.randomBytes(12).toString('hex')}`
    const grant = { id, token: crypto.randomBytes(32).toString('hex'), owner, sessionId: sessionId ?? null, parentId: parent?.id ?? null, tabIds, spaceIds, read, mutate, commands: commands ?? null, tools: requestedTools, components: requestedComponents, componentNamespace: requestedComponents.length ? parent?.componentNamespace || `custom.${id}` : null, createdAt: Date.now(), controller: new AbortController() }
    grants.set(grant.id, grant)
    credentials.set(grant.token, grant)
    notify()
    return { ...metadata(grant), token: grant.token }
  }

  function live(context) {
    const grant = contexts.get(context)
    if (!grant || stopped || (!grant.ownerBrowser && grants.get(grant.id) !== grant) || grant.controller.signal.aborted) throw fail('The browser grant has been revoked')
    return grant
  }

  function allowed(grant, command) {
    if (componentCommands.has(command)) return grant.components.length > 0 && componentTool(command)
    if (!Object.hasOwn(rules, command)) return grant.tools.includes(command) && customTool(command)
    const rule = rules[command]
    return Boolean(Object.hasOwn(rules, command) && (!grant.commands || grant.commands.includes(command)) && (rule === 'list' || rule === 'read' ? grant.read : grant.mutate))
  }

  function assert(context, { command, params = {}, after = false } = {}) {
    const grant = live(context)
    if (!command) return context
    command = commandOf(command)
    if (!allowed(grant, command)) throw fail('This command is not granted or its tool registration is no longer active')
    if (componentCommands.has(command)) {
      if (params.path !== undefined || params.instance !== undefined) throw fail('Customization uses an authorized component id, not an arbitrary path or instance')
      if (command === 'components.list') return context
      if (command === 'components.create') {
        if (!componentId(params.id) || params.id.startsWith('stock.') || (!componentScoped(grant, params.id) && !params.id.startsWith(grant.componentNamespace + '.'))) throw fail('Create components only in this grant’s owned namespace')
        if (params.from !== undefined && !componentScoped(grant, params.from)) throw fail('The component copy source is not authorized')
        for (let ancestor = grant; ancestor; ancestor = grants.get(ancestor.parentId)) {
          if (!ancestor.components.includes(params.id) && ancestor.components.length >= 256) throw fail('This customization grant already owns 256 components')
        }
      } else if (!componentScoped(grant, params.id)) throw fail('This component is not authorized for customization')
      if (command === 'components.bind' && params.spaceId !== undefined && !normalSpace(params.spaceId)) throw fail('Component bindings cannot target private or missing spaces')
      return context
    }
    if (!Object.hasOwn(rules, command)) return context
    const rule = rules[command]
    if (rule === 'list') return context
    if (rule === 'create') {
      if (!normalSpace(params.spaceId) || !grant.spaceIds.includes(params.spaceId)) throw fail('Creating a tab requires a grant for its space')
      // No profile overrides, parent injection or privileged URLs; a tab it opens is its own (the tools wrapper names it).
      if (params.agent !== undefined && params.agent !== grant.owner && !grant.ownerBrowser) throw fail('The requested tab creation is outside this grant')
      if (params.sessionPartition !== undefined || params.profileId !== undefined || params.parentId !== undefined) throw fail('The requested tab creation is outside this grant')
    } else {
      const id = params.tabId ?? params.id
      const tab = normalTab(id)
      if (!tab && after && command === 'tabs.close' && !current().tabs.some((item) => item.id === id)) return context
      if (!scoped(grant, tab)) throw fail(grant.ownerBrowser ? `No tab ${id}` : 'The requested tab is outside this browser grant')
      if (rule === 'read' && tab.chat) throw fail('Conversation content is not a browser page')
      if (command === 'tabs.navigate' && tab.chat) throw fail('A conversation cannot be navigated')
    }
    if (command === 'tabs.create' || command === 'tabs.navigate') {
      let url
      try { url = new URL(params.url) } catch { throw bad('An http or https address is required') }
      if (!['http:', 'https:'].includes(url.protocol)) throw bad('An http or https address is required')
    }
    return context
  }

  // The authenticated owner still uses a browser-only privacy boundary over MCP.
  // This request context is not a selectable grant and never creates a credential.
  function ownerBrowserContext() {
    if (stopped) throw fail('Agent access is stopped')
    ownerController ||= new AbortController()
    const grant = { id: 'owner-browser', owner: 'local-owner', sessionId: null, ownerBrowser: true, controller: ownerController, tabIds: [], spaceIds: current().spaces.filter((space) => !space.incognito).map((space) => space.id), read: true, mutate: true, commands: null, tools: [], components: [] }
    const context = Object.freeze({ owner: grant.owner, sessionId: null, grantId: grant.id, signal: ownerController.signal })
    contexts.set(context, grant)
    return context
  }

  function authorize(token, { route, method, params } = {}) {
    const grant = typeof token === 'string' && credentials.get(token)
    if (!grant || stopped) throw fail('Missing or revoked browser credential')
    // Deliberately no prefix matching, query variants, owner RPC or event stream.
    if (route !== '/mcp' || method !== 'POST') throw fail('This credential is only valid for POST /mcp')
    const check = (body) => {
      if (!body || typeof body !== 'object' || !['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized'].includes(body.method)) throw fail('This MCP method is not granted')
    }
    if (params !== undefined) {
      if (Array.isArray(params)) { if (!params.length || params.length > 100) throw bad('Invalid MCP batch'); params.forEach(check) }
      else check(params)
    }
    const context = Object.freeze({ owner: grant.owner, sessionId: grant.sessionId, grantId: grant.id, signal: grant.controller.signal })
    contexts.set(context, grant)
    return context
  }

  function tools(context, available) {
    const grant = live(context)
    return available.filter((tool) => allowed(grant, commandOf(tool.command || tool.name))).map((tool) => ({
      ...tool,
      inputSchema: scopedSchema(tool.command || tool.name, tool.inputSchema),
      description: (tool.command || tool.name) === 'components.create' ? `${tool.description || ''} New component ids must use ${grant.componentNamespace}.<name>; copy sources must be explicitly authorized.` : tool.description,
      run: async (input = {}) => {
        const command = commandOf(tool.command || tool.name)
        const rule = Object.hasOwn(rules, command) ? rules[command] : null
        const params = { ...input }
        if (!grant.ownerBrowser && (agentCommands.has(command) || command === 'tabs.create')) params.agent = grant.owner
        if (rule && params.tabId !== undefined && params.id !== undefined && params.tabId !== params.id) throw fail('id and tabId must identify the same granted tab')
        if (rule === 'create' && params.spaceId === undefined) {
          const active = current().activeSpaceId
          params.spaceId = grant.spaceIds.includes(active) && normalSpace(active) ? active : grant.spaceIds.find(normalSpace)
        } else if (rule && rule !== 'list' && rule !== 'create' && params.tabId === undefined && params.id === undefined) {
          const s = current()
          const id = s.activeTabBySpace?.[s.activeSpaceId]
          if (tool.name.startsWith('browser_')) params.tabId = id
          else params.id = id
        }
        assert(context, { command, params })
        let result
        try { result = await tool.run(params, context) } finally { assert(context, { command, params, after: true }) }
        if (command === 'components.create') {
          if (result?.id !== params.id) throw fail('Component creation returned an unexpected identity')
          let added = false
          for (let ancestor = grant; ancestor; ancestor = grants.get(ancestor.parentId)) {
            if (!ancestor.components.includes(params.id)) { ancestor.components.push(params.id); added = true }
          }
          if (added) notify()
        }
        if (command === 'components.list') {
          if (!Array.isArray(result)) throw bad('Component discovery returned an invalid catalog')
          return result.filter((component) => componentScoped(grant, component.id))
        }
        if (rule !== 'list') return result
        const keep = (tab) => scoped(grant, normalTab(tab.id))
        if (Array.isArray(result)) return result.filter(keep)
        const tabs = (result?.tabs || []).filter(keep)
        return { tabs, activeTabId: tabs.some((tab) => tab.id === result?.activeTabId) ? result.activeTabId : null }
      }
    }))
  }

  function selected({ owner, sessionId } = {}) {
    if (!string(owner) || (sessionId != null && !string(sessionId))) throw bad('An owner and valid optional sessionId are required')
    const slots = selections.get(owner)
    const id = slots?.has(sessionId ?? null) ? slots.get(sessionId ?? null) : slots?.get(null)
    const grant = grants.get(id)
    return grant && !grant.parentId && (!grant.sessionId || grant.sessionId === sessionId) ? metadata(grant) : null
  }

  function select({ id, sessionId } = {}) {
    const grant = grants.get(id)
    if (!grant || grant.parentId) throw bad('Select an existing root grant')
    sessionId = sessionId === undefined ? grant.sessionId : sessionId
    if ((sessionId != null && !string(sessionId)) || (grant.sessionId && grant.sessionId !== sessionId)) throw bad('The selected grant belongs to a different conversation')
    let slots = selections.get(grant.owner)
    if (!slots) selections.set(grant.owner, slots = new Map())
    slots.set(sessionId ?? null, grant.id)
    for (const child of [...grants.values()]) {
      if (!grants.has(child.id) || !child.parentId || child.owner !== grant.owner) continue
      let root = child
      while (root.parentId) root = grants.get(root.parentId)
      if (selected({ owner: child.owner, sessionId: child.sessionId })?.id !== root.id) revoke({ id: child.id })
    }
    notify()
    return metadata(grant)
  }

  function revoke(selector = {}) {
    const keys = ['id', 'owner', 'sessionId'].filter((key) => selector[key] !== undefined)
    if (!keys.length || keys.some((key) => !string(selector[key]))) throw bad('Select a grant id, owner or sessionId to revoke')
    const revoked = []
    const selected = new Set([...grants.values()].filter((grant) => keys.every((key) => grant[key] === selector[key])).map((grant) => grant.id))
    for (const grant of grants.values()) {
      if (!selected.has(grant.id) && !selected.has(grant.parentId)) continue
      selected.add(grant.id)
      grants.delete(grant.id)
      credentials.delete(grant.token)
      grant.controller.abort(fail('The browser grant has been revoked'))
      revoked.push(grant.id)
    }
    for (const slots of selections.values()) for (const [sessionId, id] of slots) if (revoked.includes(id)) slots.set(sessionId, null)
    if (revoked.length) notify()
    return { revoked }
  }

  function stop() {
    stopped = true
    ownerController?.abort(fail('Agent access is stopped'))
    for (const grant of grants.values()) grant.controller.abort(fail('Agent access is stopped'))
    grants.clear()
    credentials.clear()
    selections.clear()
  }
  const sessionOf = (context) => contexts.get(context)?.sessionId ?? null
  return { issue, authorize, ownerBrowserContext, listNormalTabs, assert, tools, list, revoke, select, selected, stop, sessionOf }
}

module.exports = { createAccess }

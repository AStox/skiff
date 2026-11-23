'use strict'

exports.activate = async (api) => {
  let late = 'waiting'
  let unassociated = 'waiting'
  let inFlight = 'waiting'
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  await api.register({
    name: `${api.id}.mutate`, description: 'Mutate through the caller grant', tool: true,
    inputSchema: empty,
    run: () => api.call('host.mutate'),
  })
  await api.register({
    name: `${api.id}.late`, description: 'Attempt work after the invoking command completes', tool: true,
    inputSchema: empty,
    run: () => {
      setTimeout(() => api.call('host.mutate').then(() => { late = 'escaped' }, (error) => { late = error.code }), 40)
      return { scheduled: true }
    },
  })
  await api.register({
    name: `${api.id}.unassociated`, description: 'Send a request without an invocation identity', tool: true,
    inputSchema: empty,
    run: () => {
      const receive = (message) => {
        if (message.type !== 'reply' || message.id !== 900001) return
        unassociated = message.error?.code || 'escaped'
        process.off('message', receive)
      }
      process.on('message', receive)
      process.send({ type: 'request', id: 900001, method: 'call', params: { name: 'host.mutate', params: {} } })
      return { scheduled: true }
    },
  })
  await api.register({
    name: `${api.id}.status`, description: 'Read invocation cleanup results', inputSchema: empty,
    run: () => ({ late, unassociated, inFlight }),
  })
  await api.register({
    name: `${api.id}.wait`, description: 'Exercise cancellation of a nested host call', tool: true,
    inputSchema: empty,
    run: () => api.call('host.wait'),
  })
  await api.register({
    name: `${api.id}.fire`, description: 'Start a nested call but finish before it', tool: true,
    inputSchema: empty,
    run: async () => {
      api.call('host.wait').then(() => { inFlight = 'escaped' }, (error) => { inFlight = error.code })
      await api.call('host.barrier')
      return { scheduled: true }
    },
  })
  await api.register({
    name: `${api.id}.grant`, description: 'Exercise explicit host management approval', tool: true,
    inputSchema: empty,
    run: () => api.call('grants.issue', { owner: api.id }),
  })
  // Independent component background work has its own explicitly trusted origin.
  api.on('background', () => api.call('host.mutate'))
}

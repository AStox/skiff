'use strict'
const { mode } = require('./config.json')
const schema = { type: 'object', properties: {}, additionalProperties: false }

exports.activate = async (api) => {
  const listen = () => api.on('tick', ({ value }) => api.storage.write('last', value))
  if (mode === 'listener') return listen()
  const definition = { name: `${api.id}.value`, description: 'Read the registered value', inputSchema: schema, run: () => 1 }
  const unregister = await api.register(definition)
  if (mode === 'command') return unregister
  const off = listen()
  await api.register({
    name: `${api.id}.cleanup`, description: 'Dispose and replace owned registrations', inputSchema: schema,
    run: async () => {
      await unregister()
      await unregister()
      await off()
      await off()
      await api.register({ ...definition, run: () => 2 })
      await unregister() // An old disposer must not remove a new registration.
      return 'cleaned'
    },
  })
  return async () => {
    await unregister()
    await unregister()
    await off()
    await off()
  }
}

'use strict'

exports.activate = async (api) => {
  await api.register({
    name: `${api.id}.run`,
    description: 'Archive idle unpinned tabs using the current retention policy',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api.call('host.archive', {}),
  })
}

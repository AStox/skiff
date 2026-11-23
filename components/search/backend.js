'use strict'

exports.activate = async (api) => {
  await api.register({
    name: `${api.id}.run`,
    description: 'Resolve an entered destination before using the configured search provider',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    run: ({ text }) => api.call('host.search', { text }),
  })
}

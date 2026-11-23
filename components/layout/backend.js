'use strict'

exports.activate = async (api) => {
  await api.register({
    name: `${api.id}.run`,
    description: 'List the stock desk layouts or arrange the selected space using one',
    inputSchema: { type: 'object', properties: { op: { enum: ['layouts', 'tile'] }, id: { type: 'string' }, layout: { type: 'string' } }, required: ['op'], additionalProperties: false },
    run: (params) => api.call('host.layout', params),
  })
}

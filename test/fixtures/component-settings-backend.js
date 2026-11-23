'use strict'

exports.activate = async (api) => {
  const notifications = []
  api.on('settings.changed', (entry) => { notifications.push(entry) })
  await api.register({
    name: `${api.id}.preference`, description: 'Read or change an owned component preference',
    inputSchema: { type: 'object', properties: { op: { enum: ['get', 'set', 'reset'] }, key: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] }, spaceId: { type: 'string' } }, required: ['op', 'key'], additionalProperties: false },
    run: ({ op, key, value, spaceId }) => op === 'set' ? api.settings.set(key, value, { spaceId }) : api.settings[op](key, { spaceId }),
  })
  await api.register({
    name: `${api.id}.notifications`, description: 'Read delivered owned configuration notifications',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => notifications,
  })
}

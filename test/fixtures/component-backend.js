'use strict'

const { spawn } = require('node:child_process')
const config = require('./config.json')
exports.activate = async (api) => {
  if (config.child) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    await api.storage.write('child', { pid: child.pid, parent: process.pid })
    const children = await api.storage.read('children') || []
    children.push({ pid: child.pid, parent: process.pid })
    await api.storage.write('children', children)
  }
  await api.register({
    name: `${api.id}.add`, description: 'Persist and return a note',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    run: async ({ text }) => {
      const notes = await api.storage.read('notes') || []
      notes.push({ text, revision: config.revision })
      await api.storage.write('notes', notes)
      return notes
    },
  })
  await api.register({
    name: `${api.id}.hang`, description: 'Exercise a nonresponsive worker',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => new Promise(() => {}),
  })
  await api.register({
    name: `${api.id}.forbidden`, description: 'Exercise host capability enforcement',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api.call('host.secret', {}),
  })
  api.on('tick', async (payload) => { await api.storage.write('event', payload) })
  if (config.mode === 'fail') throw new Error('Intentional partial activation failure')
  if (config.mode === 'hang-start') await new Promise(() => {})
  return async () => {
    if (config.mode === 'hang-stop') await new Promise(() => {})
    if (config.mode === 'fail-stop') throw new Error('Intentional disposer failure')
  }
}

'use strict'
const fs = require('node:fs')
const config = require('./config.json')

exports.activate = async (api) => {
  fs.appendFileSync(config.starts, JSON.stringify({ revision: config.revision, pid: process.pid }) + '\n')
  await api.register({
    name: `${api.id}.alive`, description: 'Identify the live backend revision',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => ({ revision: config.revision, pid: process.pid }),
  })
  return async () => {
    if (!config.stopEntered) return
    fs.writeFileSync(config.stopEntered, String(process.pid))
    while (!fs.existsSync(config.stopRelease)) await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

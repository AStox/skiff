'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function revision(directory) {
  const hash = createHash('sha256')
  for (const name of fs.readdirSync(directory, { recursive: true }).sort()) {
    const file = path.join(directory, name)
    if (fs.statSync(file).isFile()) hash.update(name).update('\0').update(fs.readFileSync(file)).update('\0')
  }
  return hash.digest('hex')
}

function watchShellFiles(directory, changed) {
  let previous = revision(directory)
  let timer
  const watcher = fs.watch(directory, { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      let next
      try { next = revision(directory) } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      // macOS can replay creation events after the initial shell copy.
      if (next === previous) return
      previous = next
      changed()
    }, 150)
  })
  watcher.on('close', () => clearTimeout(timer))
  return watcher
}

module.exports = { watchShellFiles }

'use strict'

const MAX_LINE = 4 * 1024 * 1024
const closedError = (message) => Object.assign(new Error(message), { closed: true })

// Newline-delimited JSON-RPC 2.0 over two streams, as the Agent Client Protocol runs over an agent's stdin and stdout.
function connect({ input, output, onNotification = () => {}, onRequest = () => {}, onClose = () => {} }) {
  const pending = new Map()
  let next = 1
  let buffer = ''
  let closed = false

  const send = (message) => {
    if (!closed) output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  function shut(error) {
    if (closed) return false
    closed = true
    input.off('data', read)
    input.off('end', ended)
    input.off('error', ended)
    for (const { reject } of pending.values()) reject(closedError(error ? error.message : 'The agent exited'))
    pending.clear()
    output.end()
    return true
  }

  function handle(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    if (message.method === undefined) {
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      const e = message.error
      if (e) call.reject(Object.assign(new Error(String(e.message || 'Agent error').slice(0, 2000)), { code: e.code }))
      else call.resolve(message.result)
    } else if (typeof message.method !== 'string') {
      return
    } else if (message.id === undefined || message.id === null) {
      onNotification(message.method, message.params)
    } else if (typeof message.id === 'number' || typeof message.id === 'string') {
      onRequest(message.method, message.params, message.id)
    }
  }

  function read(chunk) {
    const lines = (buffer + chunk).split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (closed) return
      if (line.length > MAX_LINE) return overflow()
      if (line.trim()) handle(line)
    }
    if (buffer.length > MAX_LINE) overflow()
  }

  function overflow() {
    const error = new Error('The agent sent a line over 4 MB')
    if (shut(error)) onClose(error)
  }

  function ended() {
    if (shut()) onClose(null)
  }

  input.setEncoding('utf8')
  input.on('data', read)
  input.on('end', ended)
  input.on('error', ended)
  // A dead agent's stdin reports EPIPE; its exit is handled elsewhere.
  output.on('error', () => {})

  return {
    request(method, params) {
      if (closed) return Promise.reject(closedError('The agent exited'))
      const id = next++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ id, method, params })
      })
    },
    notify(method, params) {
      send({ method, params })
    },
    respond(id, resultOrError) {
      if (resultOrError instanceof Error) send({ id, error: { code: Number.isInteger(resultOrError.code) ? resultOrError.code : -32603, message: resultOrError.message } })
      else send({ id, result: resultOrError ?? null })
    },
    close() {
      shut()
    }
  }
}

module.exports = { connect }

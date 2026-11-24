'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const S = require('../src/state')

// Each shell's common.js is a plain script that touches the page only for its icon probe and, in Layer, a few startup calls.
const classifier = (file) => vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '..', file), 'utf8')}\nlooksLikeQuestion`, {
  document: { createElement: () => ({ getContext: () => ({}) }), documentElement: { classList: { toggle() {} } } },
  matchMedia: () => ({}),
  navigator: { userAgent: '' },
  skiff: { on() {} }
})

const SEARCH = ['best pizza toronto', 'weather toronto', 'react useEffect cleanup', 'the matrix', 'electron webcontentsview transparent', 'github.com', 'example.com/a b', 'localhost:3000', 'nginx', 'node 22 release notes', '']
const ASK = ['why is my build failing', 'what time is it in tokyo', 'summarize this page', 'can you compare postgres and mysql', 'is rust faster than go?', 'rust vs go?', 'rewrite this paragraph shorter', 'fix my css grid', 'the best way to do this in react now', 'sourdough starter keeps failing after day three feeding']

test('shells/layer/common.js reads a question from a search', () => {
  const looksLikeQuestion = classifier('shells/layer/common.js')
  for (const text of SEARCH) assert.equal(looksLikeQuestion(text), false, text)
  for (const text of ASK) assert.equal(looksLikeQuestion(text), true, text)
})

test('the bar\'s intent is memory only: a tab keeps it until it navigates, and it is never saved', () => {
  const s = S.load()
  const tab = S.createTab(s, { url: 'best pizza toronto', intent: { text: 'best pizza toronto', sent: 'search', at: 1 } }, 1)
  assert.deepEqual(tab.intent, { text: 'best pizza toronto', sent: 'search', at: 1 })
  assert.equal(S.persistable(s).tabs.some((t) => 'intent' in t), false)
  assert.ok(s.tabs.find((t) => t.id === tab.id).intent)
  S.navigateTab(s, { id: tab.id, url: 'example.com' }, 2)
  assert.equal('intent' in tab, false)
  assert.equal('intent' in S.createTab(s, { url: 'example.com', intent: true }, 3), false)
})

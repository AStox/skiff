'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { outline, compare, newRefs } = require('../src/agent-browser')

const root = (id) => ({ nodeId: `root${id}`, role: { value: 'RootWebArea' }, backendDOMNodeId: id })
const node = (id, role, name, more = {}) => ({ nodeId: `n${id}`, backendDOMNodeId: id, role: { value: role }, name: { value: name }, ...more })
const refsOf = (lines) => lines.filter((line) => /^e\d+ /.test(line)).map((line) => line.split(' ')[0])

test('a node keeps its ref across outlines, a new node takes the next number, and a number is never reused', () => {
  const refs = newRefs()
  const first = outline([root(1), node(10, 'button', 'Save'), node(11, 'button', 'Cancel')], refs)
  assert.deepEqual(first.lines, ['e1 button "Save"', 'e2 button "Cancel"'])
  // Cancel goes, Delete comes, Save moves: Save is still e1, Delete is e3, and e2 stays taken.
  const second = outline([root(1), node(12, 'button', 'Delete'), node(10, 'button', 'Save')], refs)
  assert.deepEqual(second.lines, ['e3 button "Delete"', 'e1 button "Save"'])
  // Cancel returns (the same node): its old ref again, not a new number.
  const third = outline([root(1), node(10, 'button', 'Save'), node(11, 'button', 'Cancel'), node(13, 'link', 'Help')], refs)
  assert.deepEqual(third.lines, ['e1 button "Save"', 'e2 button "Cancel"', 'e4 link "Help"'])
  assert.equal(third.count, 3)
  // Every ref ever given still names its node, in or out of the latest outline.
  assert.deepEqual([...refs.nodes], [['e1', 10], ['e2', 11], ['e3', 12], ['e4', 13]])
})

test('a new document starts again from e1; the same document with a new outline does not', () => {
  const refs = newRefs()
  outline([root(1), node(10, 'button', 'Save'), node(11, 'button', 'Cancel')], refs)
  const next = outline([root(2), node(20, 'button', 'Cancel'), node(21, 'button', 'Save')], refs)
  assert.deepEqual(next.lines, ['e1 button "Cancel"', 'e2 button "Save"'])
  assert.deepEqual([...refs.nodes], [['e1', 20], ['e2', 21]])
  assert.equal(refs.nodes.get('e3'), undefined)
})

test('the per-outline limits count each outline, not the life of the document', () => {
  const refs = newRefs()
  const many = (from, n) => Array.from({ length: n }, (_, i) => node(from + i, 'button', `b${from + i}`))
  const first = outline([root(1), ...many(10, 305)], refs)
  assert.equal(first.count, 300)
  assert.equal(first.truncated, 5)
  // The five that did not fit got no number; a later outline of other nodes shows 300 again, numbered on from e301.
  const second = outline([root(1), ...many(400, 300)], refs)
  assert.equal(second.count, 300)
  assert.equal(second.truncated, 0)
  assert.equal(refsOf(second.lines)[0], 'e301')
})

test('an element pushed past the limit is not reported as gone, one removed from the tree is, and one that fits again shows as new once', () => {
  const refs = newRefs()
  const many = (from, n) => Array.from({ length: n }, (_, i) => node(from + i, 'button', `b${from + i}`))
  const page = many(10, 300)
  const first = outline([root(1), ...page], refs)
  assert.equal(first.truncated, 0)
  assert.equal(first.cut.size, 0)
  // Three suggestions at the top push the last three known buttons (e298 to e300) past the cut.
  const second = outline([root(1), ...many(400, 3), ...page], refs)
  assert.deepEqual([...second.cut], ['e298', 'e299', 'e300'])
  const full = second.lines.join('\n')
  assert.deepEqual(compare(first.lines, second.lines, full, second.cut), { changed: ['+ e301 button "b400"', '+ e302 button "b401"', '+ e303 button "b402"'].join('\n') })
  // b100 (e91) really leaves the tree: only it is gone, and e299 and e300 stay cut.
  const rest = page.filter((n) => n.backendDOMNodeId !== 100)
  const third = outline([root(1), ...many(400, 3), ...rest], refs)
  assert.deepEqual([...third.cut], ['e299', 'e300'])
  assert.deepEqual(compare(second.lines, third.lines, third.lines.join('\n'), third.cut), { changed: '- e91 button "b100"\n+ e298 button "b307"' })
  // The suggestions go; the two cut elements fit again and show as new, once.
  const fourth = outline([root(1), ...rest], refs)
  assert.equal(fourth.cut.size, 0)
  assert.deepEqual(compare(third.lines, fourth.lines, fourth.lines.join('\n'), fourth.cut), {
    changed: ['- e301 button "b400"', '- e302 button "b401"', '- e303 button "b402"', '+ e299 button "b308"', '+ e300 button "b309"'].join('\n')
  })
})

test('nothing changed is the answer when the only difference is elements pushed past the limit', () => {
  const lines = ['e1 button "A"', 'e2 button "B"']
  assert.deepEqual(compare(lines, [lines[0]], 'e1 button "A"', new Set(['e2'])), { changed: 'Nothing on the page changed.' })
})

test('status, alert, alertdialog and log show with their text and no ref; empty ones are left out and a long text is cut', () => {
  // A live region and the static text under it, as the accessibility tree has them.
  const live = (id, role, ...texts) => [
    { nodeId: `n${id}`, backendDOMNodeId: id, role: { value: role }, childIds: texts.map((_, i) => `t${id}_${i}`) },
    ...texts.map((value, i) => ({ nodeId: `t${id}_${i}`, role: { value: 'StaticText' }, name: { value } }))
  ]
  const { lines } = outline([
    root(1),
    ...live(10, 'status', 'Saved'),
    ...live(11, 'alert', 'Card', 'declined'),
    ...live(12, 'log', 'a'.repeat(500)),
    ...live(13, 'alertdialog', 'Delete this?'),
    ...live(14, 'status'),
    node(20, 'button', 'Go')
  ], newRefs())
  assert.equal(lines[0], 'status "Saved"')
  assert.equal(lines[1], 'alert "Card declined"')
  assert.match(lines[2], /^log "a{150,}…"$/)
  assert.ok(lines[2].length < 220)
  assert.equal(lines[3], 'alertdialog "Delete this?"')
  assert.equal(lines[4], 'e1 button "Go"')
  assert.equal(lines.length, 5)
})

test('a changed line, one that came and one that went are told by ref, and lines without a ref by their text', () => {
  const before = ['heading h1 "Console"', 'e1 textbox "Query"', 'e2 button "Run"', 'e3 button "Temporary"']
  const after = ['heading h1 "Console"', 'e1 textbox "Query" value="select 1" [focused]', 'e2 button "Run"', 'status "Saved"', 'e4 button "Undo"']
  assert.deepEqual(compare(before, after, after.join('\n')), {
    changed: ['- e3 button "Temporary"', '~ e1 textbox "Query" value="select 1" [focused]', '+ status "Saved"', '+ e4 button "Undo"'].join('\n')
  })
})

test('a ref whose line did not change is not mentioned, and an unchanged page says so', () => {
  const lines = ['e1 button "Run"', 'heading h1 "A"', 'e2 link "Home" href=/']
  assert.deepEqual(compare(lines, [lines[1], lines[2], lines[0]], 'full'), { changed: 'Nothing on the page changed.' })
  assert.deepEqual(compare([], [], 'full'), { changed: 'Nothing on the page changed.' })
})

test('copies of the same line without a ref are counted, so a second copy coming or going shows', () => {
  const heading = 'heading h2 "Results"'
  assert.deepEqual(compare([heading], [heading, heading], 'a long enough full outline text'), { changed: `+ ${heading}` })
  assert.deepEqual(compare([heading, heading], [heading], 'a long enough full outline text'), { changed: `- ${heading}` })
})

test('the whole outline comes back when there is none to compare with or the difference is longer than it', () => {
  assert.deepEqual(compare(null, ['e1 button "Run"'], 'e1 button "Run"'), { text: 'e1 button "Run"' })
  const full = 'e1 button "B"'
  assert.deepEqual(compare(['e2 button "Old name that is long"'], ['e1 button "B"'], full), { text: full })
  // As long as the outline is not longer than it: the difference wins.
  assert.deepEqual(compare(['e1 button "A"'], ['e1 button "B"'], 'e1 button "AAAAAAAA"'), { changed: '~ e1 button "B"' })
})

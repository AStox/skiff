'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const F = require('../src/favicons')

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('pickIcon resolves relative links, prefers the largest declared size and falls back to /favicon.ico', () => {
  const page = 'https://site.example/docs/page?x=1'
  assert.equal(F.pickIcon('<link rel="stylesheet" href="a.css"><link rel="shortcut icon" href="img/icon.png">', page), 'https://site.example/docs/img/icon.png')
  assert.equal(F.pickIcon(`<link rel=icon href=/small.png sizes=16x16><LINK href='/big.png?a=1&amp;b=2' sizes="32x32 64x64" rel='icon'><link rel="icon" href="/mid.png" sizes="48x48">`, page), 'https://site.example/big.png?a=1&b=2')
  assert.equal(F.pickIcon('<link rel="icon" href="/first.png"><link rel="icon" href="/second.png">', page), 'https://site.example/first.png')
  assert.equal(F.pickIcon('<link rel="icon" href="/x.png" sizes="512x512"><link rel="icon" href="//cdn.example/i.svg" sizes="any">', page), 'https://cdn.example/i.svg')
  for (const html of ['', '<link rel="apple-touch-icon" href="/touch.png"><link rel="mask-icon" href="/mask.svg">', '<link rel="icon" href="data:image/png;base64,AAAA">', '<link rel="icon" href="javascript:alert(1)">', '<link rel="icon" data-href="/lazy.png">']) {
    assert.equal(F.pickIcon(html, page), 'https://site.example/favicon.ico')
  }
  assert.equal(F.pickIcon('<link rel="icon" href="/x.png">', 'file:///etc/passwd'), '')
})

test('sniff accepts the six image types by content and rejects everything else', () => {
  const samples = {
    png: PNG,
    jpg: Buffer.from('ffd8ffe000104a464946', 'hex'),
    gif: Buffer.from('GIF89a\x01\x00', 'latin1'),
    webp: Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'),
    ico: Buffer.from('00000100010010100000', 'hex'),
    svg: Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg"/>')
  }
  for (const [ext, bytes] of Object.entries(samples)) assert.equal(F.sniff(bytes), ext)
  for (const text of ['<!DOCTYPE html><html><body><svg></svg>', '<html>', '{"a":1}', '', 'RIFF\x24\x00\x00\x00WAVE']) assert.equal(F.sniff(Buffer.from(text)), undefined)
})

test('icons are saved once under a hashed name, and prefetch fills every tab of an origin with one change', async (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-icons-')), 'favicons')
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }))
  const pages = {
    'https://a.example/start': { url: 'https://www.a.example/home/', body: '<link rel="icon" href="../icon">' },
    'https://www.a.example/icon': { body: PNG },
    'https://b.example/': { body: '<html>' },
    'https://b.example/favicon.ico': { body: '<html>not an icon' },
    'https://big.example/favicon.ico': { body: Buffer.concat([PNG, Buffer.alloc(256 * 1024)]) }
  }
  const requests = []
  const fetch = async (url) => {
    requests.push(url)
    const page = pages[url]
    return page ? { ok: true, url: page.url || url, body: [Buffer.from(page.body)] } : { ok: false, url, body: [] }
  }
  const tabs = [
    { url: 'https://b.example/', favicon: '' },
    { url: 'https://a.example/other', favicon: '' },
    { url: 'https://a.example/start', favicon: '', favorite: true },
    { url: 'https://a.example/kept', favicon: '../favicons/kept.png' },
    { url: 'https://big.example/', favicon: '' }
  ]
  let changes = 0
  const prefetch = F.createPrefetch({ dir, fetch, tabs: () => tabs, changed: () => changes++ })
  await prefetch()
  const saved = tabs[2].favicon
  assert.match(saved, /^\.\.\/favicons\/[0-9a-f]{24}\.png$/)
  assert.deepEqual(tabs.map((tab) => tab.favicon), ['', saved, saved, '../favicons/kept.png', ''])
  assert.equal(changes, 1)
  assert.deepEqual(fs.readdirSync(dir), [path.basename(saved)])
  assert.equal(requests[0], 'https://a.example/start', 'the favorite goes first')
  assert.deepEqual([...requests].sort(), ['https://a.example/start', 'https://b.example/', 'https://b.example/favicon.ico', 'https://big.example/', 'https://big.example/favicon.ico', 'https://www.a.example/icon'])

  await prefetch()
  assert.equal(await F.saveIcon(dir, fetch, 'https://www.a.example/icon'), saved)
  assert.equal(requests.length, 6, 'an origin is tried once and a saved icon is reused without a request')
  assert.equal(await F.dataIcon(fetch, 'https://www.a.example/icon'), `data:image/png;base64,${PNG.toString('base64')}`)
  assert.equal(await F.dataIcon(fetch, 'https://b.example/favicon.ico'), '')
  assert.equal(await F.saveIcon(dir, fetch, 'file:///etc/passwd'), '')
})

test('a declared icon that is missing or not an image falls back to /favicon.ico once', async (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-icons-')), 'favicons')
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }))
  const pages = {
    'https://gone.example/': '<link rel="icon" href="https://cdn.example/gone.png">',
    'https://gone.example/favicon.ico': PNG,
    'https://html.example/': '<link rel="icon" href="/login.png">',
    'https://html.example/login.png': '<html>sign in',
    'https://html.example/favicon.ico': PNG,
    'https://none.example/': '<link rel="icon" href="/gone.png">'
  }
  const requests = []
  const fetch = async (url) => {
    requests.push(url)
    return url in pages ? { ok: true, url, body: [Buffer.from(pages[url])] } : { ok: false, url, body: [] }
  }
  const tabs = ['gone', 'html', 'none'].map((name) => ({ url: `https://${name}.example/`, favicon: '' }))
  await F.createPrefetch({ dir, fetch, tabs: () => tabs, changed: () => {} })()
  assert.deepEqual(tabs.map((tab) => /^\.\.\/favicons\/[0-9a-f]{24}\.png$/.test(tab.favicon)), [true, true, false])
  assert.deepEqual(requests.filter((url) => url.includes('none.example')), ['https://none.example/', 'https://none.example/gone.png', 'https://none.example/favicon.ico'])
  assert.equal(await F.dataIcon(fetch, 'https://html.example/login.png', 'https://html.example/account'), `data:image/png;base64,${PNG.toString('base64')}`)
})

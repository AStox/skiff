'use strict'
const { test, expect } = require('./fixtures')

const bucketOf = async (skiff, id) => (await skiff.state()).tabs.find((t) => t.id === id)?.bucket

test('a page leaves progress when it loads, one never loaded settles unread until shown, and buckets move by hand', async ({ skiff }) => {
  const shown = await skiff.rpc('tabs.create', { url: skiff.origin + '/one' })
  await skiff.page('/one')
  await expect.poll(() => bucketOf(skiff, shown.id)).toMatch(/^(active|unread)$/)

  const first = await skiff.rpc('tabs.create', { url: skiff.origin + '/two', activate: false })
  expect(await bucketOf(skiff, first.id)).toBe('progress')
  expect((await skiff.rpc('archive.sweep')).settled).toEqual([first.id])
  expect(await bucketOf(skiff, first.id)).toBe('unread')
  await skiff.rpc('tabs.activate', { id: first.id })
  await expect.poll(() => bucketOf(skiff, first.id)).toBe('active')

  await skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'done' })
  expect(await bucketOf(skiff, first.id)).toBe('done')
  expect((await skiff.state()).tabs.find((t) => t.id === first.id).doneAt).toBeGreaterThan(0)
  await expect(skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'progress' })).rejects.toThrow(/bucket/)
  await skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'later' })
  expect(await bucketOf(skiff, first.id)).toBe('later')
  await skiff.rpc('tabs.setBucket', { id: first.id, bucket: 'favorites' })
  expect(await bucketOf(skiff, first.id)).toBe('favorites')
  expect((await skiff.rpc('tabs.list')).tabs.find((t) => t.id === first.id).bucket).toBe('favorites')
  await skiff.rpc('tabs.setFavorite', { id: first.id, favorite: false })
  expect(await bucketOf(skiff, first.id)).toBe('active')
  expect(await skiff.rpc('archive.sweep')).toEqual({ archived: [], done: [], settled: [] })
})

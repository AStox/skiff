'use strict'

const CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const UTF8 = 0x08000100
const SINT64 = 4
const USER_DESKTOP = 0

// macOS desktops (Mission Control Spaces) through private CoreGraphics calls. No supported API reads or switches them, so any failure leaves Skiff as it is without them.
function bind() {
  const koffi = require('koffi')
  const cg = koffi.load(CORE_GRAPHICS)
  const cf = koffi.load(CORE_FOUNDATION)
  const connection = cg.func('int CGSMainConnectionID()')
  const active = cg.func('uint64_t CGSGetActiveSpace(int)')
  const copySpaces = cg.func('void* CGSCopyManagedDisplaySpaces(int)')
  const count = cf.func('long CFArrayGetCount(void*)')
  const at = cf.func('void* CFArrayGetValueAtIndex(void*, long)')
  const string = cf.func('void* CFStringCreateWithCString(void*, const char*, uint32_t)')
  const get = cf.func('void* CFDictionaryGetValue(void*, void*)')
  const number = cf.func('bool CFNumberGetValue(void*, long, _Out_ int64_t*)')
  const release = cf.func('void CFRelease(void*)')
  const keys = { spaces: string(null, 'Spaces', UTF8), id: string(null, 'ManagedSpaceID', UTF8), type: string(null, 'type', UTF8) }
  const read = (ref) => {
    if (!ref) return null
    const out = [0]
    return number(ref, SINT64, out) ? Number(out[0]) : null
  }
  const id = connection()
  return {
    // User desktops numbered from 1 across the displays in order; full-screen apps are not desktops.
    list() {
      const displays = copySpaces(id)
      if (!displays) return []
      try {
        const out = []
        for (let i = 0; i < count(displays); i++) {
          const spaces = get(at(displays, i), keys.spaces)
          for (let j = 0; spaces && j < count(spaces); j++) {
            const space = at(spaces, j)
            if (read(get(space, keys.type)) !== USER_DESKTOP) continue
            const desktop = read(get(space, keys.id))
            if (desktop !== null) out.push({ id: desktop, number: out.length + 1 })
          }
        }
        return out
      } finally {
        release(displays)
      }
    },
    current: () => Number(active(id))
  }
}

// null where there are no desktops to read (not macOS, or the private calls are gone); else {list(), current(), subscribe(callback)}, subscribe returning its unsubscribe.
function open({ systemPreferences }) {
  if (process.platform !== 'darwin') return null
  try {
    const api = bind()
    if (!api.list().length) return null
    return {
      ...api,
      subscribe(callback) {
        const token = systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification', callback)
        return () => systemPreferences.unsubscribeWorkspaceNotification(token)
      }
    }
  } catch (error) {
    console.error('Desktops unavailable:', error.message)
    return null
  }
}

module.exports = { open }

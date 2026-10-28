import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flush, recordCheck, recordUpload, resetUploadReporting, slotOpened } from '../src/upload-log'

/*
 * The write path used to be invisible, which is how an incident where every
 * upload answered 503 stayed unnoticed. These cover what the summary has to
 * say, and what it must never say.
 */

let info: string[] = []
let warn: string[] = []

beforeEach(() => {
  resetUploadReporting()
  info = []; warn = []
  vi.spyOn(console, 'log').mockImplementation(m => { info.push(String(m)) })
  vi.spyOn(console, 'warn').mockImplementation(m => { warn.push(String(m)) })
})
afterEach(() => { vi.restoreAllMocks(); resetUploadReporting() })

const all = () => [...info, ...warn]

describe('guest upload reporting', () => {
  it('says nothing when the proxy is idle', () => {
    flush(2)
    expect(all()).toEqual([])
  })

  it('reports successful uploads, which previously logged nothing at all', () => {
    recordUpload('created')
    recordUpload('created')
    recordUpload('duplicate')
    flush(2)
    expect(info).toHaveLength(1)
    expect(info[0]).toContain('created=2')
    expect(info[0]).toContain('duplicate=1')
    expect(warn).toEqual([])
  })

  it('reports a refusal the visitor saw but the operator could not', () => {
    recordUpload('album-full')
    recordUpload('expired')
    flush(2)
    expect(info[0]).toContain('album-full=1')
    expect(info[0]).toContain('expired=1')
  })

  it('raises the level when the service is degraded, not merely refusing', () => {
    recordUpload('not-media')
    flush(2)
    expect(warn, 'a visitor sending the wrong file is not a fault').toEqual([])

    recordUpload('busy')
    flush(2)
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('busy=1')
  })

  it('keeps reporting while slots are held and nothing is completing', () => {
    // The shape of the real incident: no requests succeed, so nothing would
    // trigger a line, yet the proxy is refusing everyone. Occupancy alone has
    // to be enough to speak up.
    const now = Date.now()
    slotOpened(now - 400_000)
    slotOpened(now - 10_000)
    flush(2, now)
    const line = all().join('\n')
    expect(line, 'an idle-looking proxy with slots held must still report').toContain('slots 2/2')
    expect(line).toContain('oldest <15m')
  })

  it('starts a fresh window after each flush', () => {
    recordUpload('created')
    flush(2)
    info = []; warn = []
    flush(2)
    expect(all(), 'counts leaked into the next window').toEqual([])
  })

  it('releases a slot exactly once, however often the finally runs', () => {
    const release = slotOpened()
    release(); release(); release()
    flush(2)
    expect(all(), 'a double release must not corrupt occupancy').toEqual([])
  })

  it('emits nothing but known labels and numbers', () => {
    recordUpload('created'); recordUpload('transport')
    recordCheck('answered'); recordCheck('unavailable')
    slotOpened()
    flush(2)
    const line = all().join('\n').replace(/^\S+\s(WARN\s)?/gm, '')
    // A closed vocabulary is what makes visitor data structurally unable to
    // reach the log - not filtering applied to it on the way out.
    expect(line).toMatch(/^Guest upload \| upload: [a-z-]+=\d+( [a-z-]+=\d+)*( \| check: [a-z-]+=\d+( [a-z-]+=\d+)*)?( \| slots \d+\/\d+( oldest [<>]\d+[sm])?)?$/)
  })
})

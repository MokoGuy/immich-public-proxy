import { describe, expect, it } from 'vitest'
import { CHECK_MAX_BYTES, shouldPreCheck } from '../src/shared/precheck'

/*
 * The decision only, not the hashing. The condition that matters - a file
 * over the ceiling - cannot be exercised cheaply end to end: the test stack
 * caps uploads at 2 MB, so any file large enough to trip this is rejected as
 * too-large long before the pre-check is reached.
 */
describe('shouldPreCheck', () => {
  it('asks for an ordinary photo', () => {
    expect(shouldPreCheck(3 * 1024 * 1024, true)).toBe(true)
  })

  it('asks for a video right up to the ceiling, where it pays most', () => {
    expect(shouldPreCheck(CHECK_MAX_BYTES, true)).toBe(true)
  })

  it('does not hash a file big enough to cost the visitor their tab', () => {
    // One re-uploaded duplicate is cheaper than an out-of-memory kill that
    // takes every queued file with it.
    expect(shouldPreCheck(CHECK_MAX_BYTES + 1, true)).toBe(false)
    expect(shouldPreCheck(500 * 1024 * 1024, true)).toBe(false)
  })

  it('stays silent without WebCrypto, which needs a secure context', () => {
    expect(shouldPreCheck(1024, false)).toBe(false)
  })

  it('has nothing to ask about an empty file', () => {
    expect(shouldPreCheck(0, true)).toBe(false)
  })
})

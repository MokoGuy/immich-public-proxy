import { describe, it, expect, vi, afterEach } from 'vitest'

/** A fake page: a wake lock API that records what it handed out, and a visibility state. */
function fakePage (supported = true) {
  const listeners: Array<() => void> = []
  const sentinels: Array<{ released: boolean, release: () => Promise<void> }> = []
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn)
  }
  const request = vi.fn(async () => {
    const sentinel = { released: false, release: async () => { sentinel.released = true } }
    sentinels.push(sentinel)
    return sentinel
  })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('navigator', supported ? { wakeLock: { request } } : {})
  return {
    request,
    sentinels,
    /** The system drops the lock when the page hides; then the page is shown again. */
    hideAndShow () {
      sentinels.forEach(s => { s.released = true })
      doc.visibilityState = 'visible'
      listeners.forEach(fn => fn())
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the upload page wake lock', () => {
  it('holds the screen on during uploads and lets it go after', async () => {
    const page = fakePage()
    const { acquireWakeLock, releaseWakeLock } = await import('../src/client/wake-lock')
    await acquireWakeLock()
    expect(page.request).toHaveBeenCalledWith('screen')
    await releaseWakeLock()
    expect(page.sentinels[0].released).toBe(true)
  })

  it('takes the lock back when the page is shown again', async () => {
    const page = fakePage()
    const { acquireWakeLock } = await import('../src/client/wake-lock')
    await acquireWakeLock()
    page.hideAndShow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(page.request).toHaveBeenCalledTimes(2)
  })

  it('does not take it back once the queue has finished', async () => {
    const page = fakePage()
    const { acquireWakeLock, releaseWakeLock } = await import('../src/client/wake-lock')
    await acquireWakeLock()
    await releaseWakeLock()
    page.hideAndShow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(page.request).toHaveBeenCalledTimes(1)
  })

  it('does nothing, and throws nothing, where the API is missing', async () => {
    fakePage(false)
    const { acquireWakeLock, releaseWakeLock } = await import('../src/client/wake-lock')
    await expect(acquireWakeLock()).resolves.toBeUndefined()
    await expect(releaseWakeLock()).resolves.toBeUndefined()
  })
})

/*
  Keep the screen awake while uploads are in flight.

  Both mobile platforms suspend or discard a backgrounded page, which kills
  the upload. Immich's own upload panel takes a wake lock for the same reason.

  Support is narrower than the rest of the page (Safari iOS 16.4+, recent
  Chrome on Android, secure context only), and the system RELEASES the lock
  whenever the document is hidden. So it is taken again when the page comes
  back, or a visitor who glances at another app returns to an upload with no
  lock at all. It stays best effort: unsupported, denied, or released and not
  regained, the uploads carry on.
*/

interface WakeLockSentinelLike { release: () => Promise<void> }
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
}

let wakeLock: WakeLockSentinelLike | null = null
let wanted = false
let visibilityHooked = false

async function requestLock (): Promise<void> {
  const nav = navigator as WakeLockNavigator
  if (wakeLock || !nav.wakeLock) return
  try {
    const sentinel = await nav.wakeLock.request('screen')
    // The queue may have finished while this was in flight. Keeping the
    // sentinel then would hold the screen on with nothing uploading.
    if (!wanted || wakeLock) {
      await sentinel.release().catch(() => undefined)
      return
    }
    wakeLock = sentinel
  } catch { /* denied, low battery, or a hidden document */ }
}

/** Hold the screen on until `releaseWakeLock`, taking it back whenever the page is shown again. */
export async function acquireWakeLock (): Promise<void> {
  wanted = true
  if (!visibilityHooked) {
    visibilityHooked = true
    document.addEventListener('visibilitychange', () => {
      // The system dropped it while the page was hidden; take it back
      if (wanted && document.visibilityState === 'visible') {
        wakeLock = null
        requestLock().catch(() => undefined)
      }
    })
  }
  await requestLock()
}

/** Let the screen sleep again. */
export async function releaseWakeLock (): Promise<void> {
  wanted = false
  const held = wakeLock
  wakeLock = null
  try { await held?.release() } catch { /* already gone */ }
}

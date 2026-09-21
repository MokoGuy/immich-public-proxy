// One upload, over XMLHttpRequest.
//
// Why not fetch: it reports nothing about how much of a request body has gone
// out. On a phone sending a 150 MB video over mobile data that is the whole
// question, and `Uploading 1 of 2…` sitting frozen for four minutes is how
// people conclude the page is broken and close it.
//
// A `ReadableStream` request body does not solve it either - it counts bytes
// consumed into the browser's own buffers, not bytes on the wire - and stable
// iOS Safari does not support it at all. `xhr.upload.onprogress` is the only
// API that actually answers the question, and it has worked everywhere since
// before either of those existed.

export type UploadPhase = 'sending' | 'confirming'

export interface UploadProgress {
  loaded: number
  total: number
  /** Smoothed, so the figure does not jitter on every packet. */
  bytesPerSecond: number
  /** Seconds remaining, or null while there is not enough signal to say. */
  etaSeconds: number | null
}

export type UploadOutcome =
  | { ok: true, id: string, status: 'created' | 'duplicate' }
  | { ok: false, reason?: string, httpStatus?: number, retryAfterMs?: number, aborted?: boolean }

export interface UploadRequestOptions {
  url: string
  file: File
  signal?: AbortSignal
  onPhase?: (phase: UploadPhase) => void
  onProgress?: (progress: UploadProgress) => void
}

/** Rolling-window rate estimate: recent samples only, so it tracks reality. */
function rateTracker () {
  const samples: Array<{ t: number, loaded: number }> = []
  return (loaded: number): number => {
    const now = Date.now()
    samples.push({ t: now, loaded })
    while (samples.length > 2 && now - samples[0].t > 5000) samples.shift()
    const first = samples[0]
    const seconds = (now - first.t) / 1000
    if (seconds < 0.5) return 0
    return Math.max(0, (loaded - first.loaded) / seconds)
  }
}

export function uploadFile (opts: UploadRequestOptions): Promise<UploadOutcome> {
  return new Promise<UploadOutcome>((resolve) => {
    const xhr = new XMLHttpRequest()
    const rate = rateTracker()
    let settled = false
    const finish = (outcome: UploadOutcome) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = () => xhr.abort()

    // Listeners must be attached before send(), and it is `xhr.upload` that
    // reports the request body - `xhr.onprogress` is about the response.
    xhr.upload.addEventListener('progress', (e) => {
      const total = e.lengthComputable ? e.total : opts.file.size
      const bytesPerSecond = rate(e.loaded)
      const remaining = Math.max(0, total - e.loaded)
      opts.onProgress?.({
        loaded: e.loaded,
        total,
        bytesPerSecond,
        etaSeconds: bytesPerSecond > 0 ? Math.round(remaining / bytesPerSecond) : null
      })
    })

    // The body is out, but the asset is not accepted yet: IPP still has to
    // relay it and Immich still has to take it. Showing 100% as "added" here
    // would be a lie that gets found out on the next page load.
    xhr.upload.addEventListener('load', () => opts.onPhase?.('confirming'))

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let body: { id?: string, status?: string } = {}
        try { body = JSON.parse(xhr.responseText) } catch (e) { /* treated as failure below */ }
        if (body.id) {
          finish({ ok: true, id: body.id, status: body.status === 'duplicate' ? 'duplicate' : 'created' })
          return
        }
        finish({ ok: false, httpStatus: xhr.status })
        return
      }
      // XHR does not turn a 4xx/5xx into an error event; classify here.
      let reason: string | undefined
      try { reason = JSON.parse(xhr.responseText)?.reason } catch (e) { /* empty body is allowed */ }
      const retryAfter = Number(xhr.getResponseHeader('Retry-After'))
      finish({
        ok: false,
        reason,
        httpStatus: xhr.status,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
      })
    })

    xhr.addEventListener('error', () => finish({ ok: false, reason: 'network' }))
    xhr.addEventListener('timeout', () => finish({ ok: false, reason: 'network' }))
    xhr.addEventListener('abort', () => finish({ ok: false, aborted: true }))

    if (opts.signal) {
      if (opts.signal.aborted) { finish({ ok: false, aborted: true }); return }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    xhr.open('POST', opts.url)
    xhr.setRequestHeader('Content-Type', opts.file.type || 'application/octet-stream')
    xhr.setRequestHeader('X-IPP-Filename', encodeURIComponent(opts.file.name || 'file'))
    xhr.setRequestHeader('X-IPP-Created-At', new Date(opts.file.lastModified || Date.now()).toISOString())
    opts.onPhase?.('sending')
    xhr.send(opts.file)
  })
}

/*
 * Keep the screen awake while uploads are in flight.
 *
 * Both mobile platforms suspend or discard a backgrounded page, which kills
 * the upload. Immich's own upload panel takes a wake lock for exactly this
 * reason. It is best-effort: the API is absent on some browsers and the lock
 * is released by the system when the tab is hidden anyway, so the UI still
 * has to tell people to keep the page open.
 */
let wakeLock: { release: () => Promise<void> } | null = null

export async function acquireWakeLock (): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
  if (wakeLock || !nav.wakeLock) return
  try {
    wakeLock = await nav.wakeLock.request('screen')
  } catch (e) { /* denied or unsupported; nothing to fall back to */ }
}

export async function releaseWakeLock (): Promise<void> {
  const held = wakeLock
  wakeLock = null
  try { await held?.release() } catch (e) { /* already gone */ }
}

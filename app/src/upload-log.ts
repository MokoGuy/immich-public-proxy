import { log } from './utils/log'

/*
 * Operational reporting for the guest-upload routes.
 *
 * The write path used to be invisible: a successful upload logged nothing, and
 * every refusal - policy, input, or admission - returned JSON silently. An
 * unavailable write path looked exactly like an unused one, which is how an
 * incident where every upload answered `503 busy` went unnoticed while the
 * proxy served galleries normally.
 *
 * Deliberately AGGREGATE rather than one line per request. This endpoint is
 * anonymous and public, so per-request output is both a flood vector and a
 * correlation handle: timing plus outcome would let a log reader follow one
 * visitor through the queue. Counts of fixed labels carry the operational
 * signal without carrying the visitor.
 *
 * Nothing visitor-supplied is emitted - no filenames, sizes, mime types,
 * capture dates, checksums, share keys, addresses or upstream response text.
 * The labels are a closed vocabulary defined here, so no request value can
 * reach the output and CR/LF or bidi injection is structurally impossible
 * rather than filtered. Note that a filename would NOT be safe merely because
 * `sanitiseFilename` strips controls: that protects the multipart we build,
 * while logs have different readers, exports and retention than Immich, and a
 * refused filename would create a record of material Immich never stored.
 *
 * Occupancy is reported even when no requests arrive, because "slots held,
 * nothing completing, age climbing" is precisely the shape of the incident
 * above and it produces no requests of its own to trigger a flush.
 */

export type UploadLabel =
  // terminal success
  | 'created' | 'duplicate'
  // admission
  | 'busy'
  // the gate, mirroring UploadRefusal
  | 'disabled' | 'not-allowed' | 'not-album' | 'slug' | 'no-password'
  | 'no-expiry' | 'expired' | 'expiry-too-far' | 'album-full'
  // what the visitor sent
  | 'not-media' | 'bad-date' | 'too-large' | 'empty' | 'bad-checksum'
  // accepted, but the file carried no capture date of its own
  | 'no-capture-date'
  // the share did not resolve; 401 and 404 are collapsed on purpose, so the
  // log cannot be read as an oracle for which keys exist
  | 'unresolved-share'
  // upstream and transport
  | 'upstream-rejected' | 'invalid-response' | 'transport'
  // the request ended without a verdict
  | 'client-gone' | 'idle-timeout' | 'deadline'
  // the duplicate pre-check specifically
  | 'answered' | 'unavailable'

/** Labels that make a summary a warning rather than an informational line. */
const DEGRADED: ReadonlySet<string> = new Set<UploadLabel>([
  'busy', 'upstream-rejected', 'invalid-response', 'transport',
  'idle-timeout', 'deadline', 'unavailable'
])

/*
 * Counters are clamped rather than left to grow. A public endpoint under load
 * should not be able to widen the line; at the ceiling we stop counting and
 * say so, which is honest about the loss instead of silently wrapping.
 */
const COUNTER_CEILING = 1_000_000_000

interface Window {
  upload: Map<UploadLabel, number>
  check: Map<UploadLabel, number>
  overflowed: boolean
}

const fresh = (): Window => ({ upload: new Map(), check: new Map(), overflowed: false })
let window = fresh()

/** Start times of slots currently held, keyed by an opaque token. */
const slots = new Map<number, number>()
let nextToken = 1

function bump (into: Map<UploadLabel, number>, label: UploadLabel): void {
  const n = into.get(label) || 0
  if (n >= COUNTER_CEILING) { window.overflowed = true; return }
  into.set(label, n + 1)
}

export function recordUpload (label: UploadLabel): void { bump(window.upload, label) }
export function recordCheck (label: UploadLabel): void { bump(window.check, label) }

/** Note that a request has taken an admission slot. Returns its release. */
export function slotOpened (now = Date.now()): () => void {
  const token = nextToken++
  slots.set(token, now)
  let released = false
  return () => {
    // Exactly-once: a double release would corrupt occupancy, and the caller
    // is a `finally` that must stay safe to run on any path.
    if (released) return
    released = true
    slots.delete(token)
  }
}

/** Coarse buckets, not durations: an exact age is a timing handle. */
function oldestSlotAge (now: number): string | null {
  if (!slots.size) return null
  let oldest = now
  for (const started of slots.values()) if (started < oldest) oldest = started
  const seconds = Math.max(0, Math.round((now - oldest) / 1000))
  if (seconds < 10) return '<10s'
  if (seconds < 60) return '<1m'
  if (seconds < 300) return '<5m'
  if (seconds < 900) return '<15m'
  return '>15m'
}

const render = (counts: Map<UploadLabel, number>): string =>
  [...counts.entries()].map(([label, n]) => `${label}=${n}`).join(' ')

/**
 * Emit the window and start a new one. Silent when there is nothing to say:
 * no activity and no slot held means a healthy idle proxy, which does not
 * need a line every minute.
 */
export function flush (capacity: number, now = Date.now()): void {
  const done = window
  const age = oldestSlotAge(now)
  if (!done.upload.size && !done.check.size && !slots.size) {
    window = fresh()
    return
  }
  window = fresh()

  const parts = [`upload: ${render(done.upload) || 'none'}`]
  if (done.check.size) parts.push(`check: ${render(done.check)}`)
  parts.push(`slots ${slots.size}/${capacity}${age ? ' oldest ' + age : ''}`)
  if (done.overflowed) parts.push('counts truncated')

  const degraded = [...done.upload.keys(), ...done.check.keys()].some(l => DEGRADED.has(l))
  const line = 'Guest upload | ' + parts.join(' | ')
  if (degraded) log.warn(line)
  else log.info(line)
}

let timer: NodeJS.Timeout | null = null

/**
 * Arm the periodic summary. `unref` so the report never keeps the process
 * alive, and the flush is wrapped because a failure to log must not take the
 * server down with it.
 */
export function startUploadReporting (capacity: number, everyMs = 60_000): void {
  if (timer) return
  timer = setInterval(() => {
    try { flush(capacity) } catch (e) { /* reporting must never be fatal */ }
  }, everyMs)
  timer.unref()
}

/** Test seam: drop all state so one case cannot observe another's counters. */
export function resetUploadReporting (): void {
  if (timer) { clearInterval(timer); timer = null }
  window = fresh()
  slots.clear()
}

// Guest upload client: queue, panel rendering and announcements.
//
// Files go up one at a time. The server caps how many it will relay anyway,
// and a home link is bandwidth-bound long before it is round-trip-bound, so
// parallelism would only make every file finish later.

import { state } from './state.js'
import { shouldPreCheck } from '../shared/precheck.js'
import {
  UploadOutcome,
  UploadProgress,
  acquireWakeLock,
  releaseWakeLock,
  uploadFile
} from './upload-request.js'

type ItemState = 'waiting' | 'checking' | 'sending' | 'confirming' | 'done' | 'duplicate' | 'failed' | 'skipped'

/** Set when the accepted file carried no capture date of its own. */
type DatelessFlag = boolean

interface Item {
  file: File
  state: ItemState
  progress?: UploadProgress
  reason?: string
  /** The accepted file carried no capture date, so Immich dated it today. */
  dateless?: DatelessFlag
  el?: HTMLLIElement
  /** Last state the row's structure was built for; see renderItem. */
  builtFor?: ItemState
  bar?: HTMLElement
  detail?: HTMLElement
}

interface Target { path: string, checkPath: string, maxBytes: number }

const ICON = {
  pending: 'M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
  sending: 'M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z',
  done: 'M12,2C6.5,2 2,6.5 2,12S6.5,22 12,22 22,17.5 22,12 17.5,2 12,2M10,17L5,12L6.41,10.59L10,14.17L17.59,6.58L19,8L10,17Z',
  warn: 'M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
  retry: 'M12,4C14.1,4 16.1,4.8 17.6,6.3C20.7,9.4 20.7,14.5 17.6,17.6C15.8,19.5 13.3,20.2 10.9,19.9L11.4,17.9C13.1,18.1 14.9,17.5 16.2,16.2C18.5,13.9 18.5,10.1 16.2,7.7C15.1,6.6 13.5,6 12,6V10.6L7,5.6L12,0.6V4M6.3,17.6C3.7,15 3.4,11 5.1,8.1L6.6,9.6C5.5,11.6 5.8,14.2 7.5,15.9C8,16.4 8.6,16.8 9.3,17.1L8.7,19.1C7.8,18.8 6.9,18.2 6.3,17.6Z'
}

let target: Target | null = null
const queue: Item[] = []
let running = false
let stopped = false
let controller: AbortController | null = null
let lastAnnounce = 0

/*
 * The duplicate pre-check needs WebCrypto, which browsers only expose in a
 * secure context. An instance served over plain HTTP therefore uploads
 * without pre-checking rather than breaking.
 */
const canCheck = typeof crypto !== 'undefined' &&
  typeof crypto.subtle?.digest === 'function' &&
  typeof btoa === 'function'

/**
 * SHA-1 of a file, via the browser's own implementation.
 *
 * `crypto.subtle` has no incremental API, so this buffers the whole file -
 * on a large video that is a real allocation, and on a loaded phone it can
 * fail. That is handled where it is called: a failed check falls through to
 * an ordinary upload.
 *
 * Hand-rolling a streaming digest would avoid the allocation, and was tried;
 * it is not worth maintaining our own cryptographic primitive for a
 * duplicate check, however well tested. Native or nothing.
 */
async function sha1File (file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', await file.arrayBuffer())
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/* ------------------------------------------------------------ formatting */

function humanBytes (n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`
  if (n >= 1048576) return `${Math.round(n / 1048576)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

function humanEta (seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return ''
  if (seconds < 60) return `${seconds}s left`
  return `${Math.round(seconds / 60)} min left`
}

/**
 * Turn a server reason code into something a visitor can act on. "Upload
 * failed" gives no basis for choosing between retrying, picking a smaller
 * file, and going to ask whoever shared the album.
 */
function explain (item: Item): string {
  switch (item.reason) {
    case 'too-large': return `Larger than ${humanBytes(target?.maxBytes ?? 0)}`
    case 'not-media': return 'Not a photo or video'
    case 'empty': return 'File is empty'
    case 'bad-date': return 'No usable date'
    case 'album-full': return 'The album is full'
    case 'expired': return 'This link has expired'
    case 'not-allowed':
    case 'disabled': return 'This link no longer accepts uploads'
    case 'busy': return 'Server busy'
    case 'network': return 'Connection lost'
    case 'upstream': return 'The photo server refused it'
    // Not a refusal: the transfer was cut in transit. Retry is worth offering,
    // and the row's retry button is already there for the visitor to press.
    case 'gateway': return 'Interrupted on the way — try again'
    case 'interrupted': return 'Stopped — may have been added'
    default: return 'Could not be uploaded'
  }
}

/* --------------------------------------------------------------- elements */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

function svg (path: string, cls: string): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`
}

function iconFor (item: Item): string {
  switch (item.state) {
    case 'waiting': return svg(ICON.pending, 'upload-ico upload-ico-idle')
    case 'checking':
    case 'sending':
    case 'confirming': return svg(ICON.sending, 'upload-ico upload-ico-busy')
    case 'done': return svg(ICON.done, 'upload-ico upload-ico-ok')
    case 'duplicate': return svg(ICON.warn, 'upload-ico upload-ico-warn')
    case 'skipped': return svg(ICON.pending, 'upload-ico upload-ico-idle')
    default: return svg(ICON.warn, 'upload-ico upload-ico-bad')
  }
}

/**
 * Status line under the filename.
 *
 * The figures live here rather than inside the bar, as Immich writes them.
 * Immich's fill is a light accent on a dark track, so no single text colour
 * reads on both halves, and blending tricks break the moment a filter creates
 * a stacking context. A themed line above the bar always reads.
 */
function detailFor (item: Item): string {
  switch (item.state) {
    case 'waiting': return 'Waiting'
    case 'checking': return 'Checking if already uploaded…'
    case 'sending': {
      const p = item.progress
      if (!p) return 'Starting…'
      const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0
      const rate = p.bytesPerSecond > 0 ? ` · ${humanBytes(p.bytesPerSecond)}/s` : ''
      const eta = humanEta(p.etaSeconds)
      return `${pct}% of ${humanBytes(p.total)}${rate}${eta ? ` · ${eta}` : ''}`
    }
    case 'confirming': return 'Sent — waiting for the photo server…'
    case 'done': return item.dateless ? 'Added — no date in the file, so it will show as taken today' : 'Added'
    // Immich deduplicates by checksum across the owner's whole library, not
    // per album, and a duplicate is not filed into the album. Saying "already
    // in this album" would be wrong whenever the owner happens to have the
    // photo somewhere else.
    case 'duplicate': return 'Already uploaded — skipped'
    case 'skipped': return 'Not attempted'
    case 'failed': return explain(item)
    default: return ''
  }
}

/**
 * Draw a row.
 *
 * Structure is rebuilt only when the STATE changes; a progress tick just
 * writes the bar width and the detail text. Rebuilding `innerHTML` on every
 * tick destroys and recreates the spinner several times a second, so its CSS
 * animation restarts from zero each time and it visibly stutters instead of
 * spinning. Keeping the element alive is the whole point.
 */
function renderItem (item: Item): void {
  if (!item.el) return

  if (item.builtFor !== item.state) {
    item.el.className = `upload-item upload-item-${item.state}`
    const showBar = item.state === 'sending' || item.state === 'confirming'
    item.el.innerHTML =
      `<div class="upload-item-head">
         ${iconFor(item)}
         <span class="upload-name">${escapeHtml(item.file.name || 'file')}</span>
         ${item.state === 'failed' ? `<button type="button" class="upload-icon-btn upload-retry" aria-label="Retry ${escapeHtml(item.file.name)}">${svg(ICON.retry, '')}</button>` : ''}
       </div>` +
      (showBar
        ? `<div class="upload-bar${item.state === 'confirming' ? ' upload-bar-pending' : ''}">
             <div class="upload-bar-fill" style="width:0%"></div>
           </div>`
        : '') +
      '<p class="upload-detail" hidden></p>'

    item.bar = item.el.querySelector<HTMLElement>('.upload-bar-fill') ?? undefined
    item.detail = item.el.querySelector<HTMLElement>('.upload-detail') ?? undefined
    item.builtFor = item.state

    item.el.querySelector('.upload-retry')?.addEventListener('click', () => {
      item.state = 'waiting'
      item.reason = undefined
      renderItem(item)
      run().catch(() => { /* every failure path already lands in the panel */ })
    })
  }

  updateItemValues(item)
}

/** The parts that change while the state does not: bar width and detail text. */
function updateItemValues (item: Item): void {
  const p = item.progress
  if (item.bar) {
    const pct = item.state === 'confirming'
      ? 100
      : (p && p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0)
    item.bar.style.width = `${pct}%`
  }
  if (item.detail) {
    const text = detailFor(item)
    item.detail.textContent = text
    item.detail.hidden = !text
  }
}

function escapeHtml (s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/* ----------------------------------------------------------------- panel */

function counts () {
  return {
    done: queue.filter(i => i.state === 'done').length,
    dup: queue.filter(i => i.state === 'duplicate').length,
    bad: queue.filter(i => i.state === 'failed').length,
    left: queue.filter(i => ['waiting', 'checking', 'sending', 'confirming'].includes(i.state)).length
  }
}

function renderPanel (): void {
  const panel = $('upload-panel')
  const list = $<HTMLUListElement>('upload-files')
  if (!panel || !list) return

  for (const item of queue) {
    if (!item.el) {
      item.el = document.createElement('li')
      list.appendChild(item.el)
      renderItem(item)
    }
  }

  const c = counts()
  const head = $('upload-heading')
  if (head) head.textContent = c.left ? `Uploading ${queue.length - c.left + 1} of ${queue.length}` : 'Uploads'

  const line = $('upload-counts')
  if (line) {
    const parts: string[] = []
    if (c.done) parts.push(`<span class="c-ok">${c.done} added</span>`)
    if (c.dup) parts.push(`<span class="c-warn">${c.dup} already uploaded</span>`)
    if (c.bad) parts.push(`<span class="c-bad">${c.bad} failed</span>`)
    if (c.left) parts.push(`${c.left} to go`)
    line.innerHTML = parts.join(' · ')
  }

  const finished = c.left === 0
  $('upload-stop')!.hidden = finished
  $('upload-refresh')!.hidden = !(finished && (c.done || c.dup))
  $('upload-close')!.hidden = !finished
  $('upload-hint')!.hidden = finished

  const badgeCount = $('upload-badge-count')
  if (badgeCount) badgeCount.textContent = String(c.left || c.bad)
  const badge = $('upload-badge')
  if (badge) badge.classList.toggle('has-errors', c.left === 0 && c.bad > 0)
}

function show (open: boolean): void {
  const panel = $('upload-panel')
  const badge = $('upload-badge')
  if (!panel || !badge) return
  panel.hidden = !open
  badge.hidden = open || queue.length === 0
}

/**
 * Announce milestones, not bytes. The bar is the visual channel; a live
 * region that fires on every progress event is unusable.
 */
function announce (message: string, force = false): void {
  const el = $('upload-live')
  if (!el) return
  const now = Date.now()
  if (!force && now - lastAnnounce < 15000) return
  lastAnnounce = now
  el.textContent = message
}

/* ----------------------------------------------------------------- queue */

async function run (): Promise<void> {
  if (running || !target) return
  running = true
  stopped = false
  await acquireWakeLock()

  for (;;) {
    const item = queue.find(i => i.state === 'waiting')
    if (!item || stopped) break

    // Cheap client-side rejections: never spend a phone's uplink on a file
    // the server is certain to refuse.
    if (item.file.size === 0) { fail(item, 'empty'); continue }
    if (item.file.size > target.maxBytes) { fail(item, 'too-large'); continue }

    /*
     * Ask first whether the owner already has these bytes. This is worth most
     * on exactly the files it costs most to hash: skipping a five-minute
     * video upload pays for a second of hashing many times over, while on a
     * 2 MB photo both are imperceptible.
     *
     * Every failure here falls through to a normal upload - including the
     * allocation failing on a large file, which is the price of using the
     * browser's own digest rather than maintaining one. A check that does not
     * work must never stop a file being sent.
     */
    // Cancellation has to cover hashing and the check too, not just the
    // transfer: Stop during a 200 MB hash used to let the whole file upload
    // afterwards anyway.
    controller = new AbortController()

    if (shouldPreCheck(item.file.size, canCheck)) {
      item.state = 'checking'
      item.progress = undefined
      renderItem(item); renderPanel()
      try {
        const checksum = await sha1File(item.file)
        const res = await fetch(target.checkPath, {
          method: 'POST',
          headers: { 'X-IPP-Checksum': checksum },
          signal: controller.signal
        })
        if (res.ok && (await res.json() as { duplicate?: boolean }).duplicate) {
          item.state = 'duplicate'
          item.progress = undefined
          renderItem(item); renderPanel()
          announce(`${item.file.name} is already uploaded`, true)
          continue
        }
      } catch (e) {
        // Unsupported, blocked, or simply failed - send the file as usual.
      }
    }

    // Stop may have been pressed while hashing or checking.
    if (stopped) { controller = null; break }

    item.state = 'sending'
    item.progress = undefined
    renderItem(item); renderPanel()
    announce(`Uploading ${item.file.name}`, true)

    const outcome: UploadOutcome = await uploadFile({
      url: target.path,
      file: item.file,
      signal: controller.signal,
      onPhase: (phase) => {
        item.state = phase === 'confirming' ? 'confirming' : 'sending'
        renderItem(item)
        if (phase === 'confirming') announce('Sent, waiting for the photo server')
      },
      onProgress: (p) => {
        item.progress = p
        // Values only: rebuilding the row here is what made the spinner
        // restart on every tick.
        updateItemValues(item)
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0
        if (pct >= 25) announce(`${item.file.name}, ${pct} percent`)
      }
    })
    controller = null

    if (outcome.ok) {
      // The file had no capture date, so the album will show it as taken
      // today. Worth saying while the visitor is still here and can tell the
      // owner - they cannot fix it afterwards, and nobody else will notice.
      item.dateless = outcome.dateSource === 'client'
      item.state = outcome.status === 'duplicate' ? 'duplicate' : 'done'
      item.progress = undefined
    } else if (outcome.aborted) {
      // The bytes may already have reached Immich; the response is simply
      // lost. Saying "failed" would be a guess, and re-sending silently would
      // be a worse one.
      item.state = 'failed'
      item.reason = 'interrupted'
    } else if (outcome.reason === 'busy') {
      // Hold this file at the head and wait the server out rather than
      // marching through the queue collecting the same refusal.
      item.state = 'waiting'
      renderItem(item); renderPanel()
      await sleep(outcome.retryAfterMs ?? 5000)
      continue
    } else {
      fail(item, outcome.reason)
      // A refusal about the LINK, not the file: nothing further can succeed.
      if (['album-full', 'expired', 'not-allowed', 'disabled'].includes(outcome.reason || '')) {
        for (const rest of queue) if (rest.state === 'waiting') rest.state = 'skipped'
      }
    }
    renderItem(item); renderPanel()
  }

  if (stopped) for (const rest of queue) if (rest.state === 'waiting') rest.state = 'skipped'
  queue.forEach(renderItem)
  renderPanel()
  running = false
  await releaseWakeLock()

  const c = counts()
  announce(c.bad
    ? `Finished. ${c.done} added, ${c.bad} failed.`
    : `Finished. ${c.done} added.`, true)
}

function fail (item: Item, reason?: string): void {
  item.state = 'failed'
  item.reason = reason
  item.progress = undefined
  renderItem(item); renderPanel()
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/* ----------------------------------------------------------------- setup */

export function setupUpload (path?: string, maxBytes?: number): void {
  if (!path) return
  target = {
    path,
    checkPath: path.replace(/\/upload$/, '/check'),
    maxBytes: maxBytes || Number.MAX_SAFE_INTEGER
  }

  const input = $<HTMLInputElement>('upload-input')
  const open = $('upload-open')
  if (!input || !open) return

  const add = (files: File[]) => {
    if (!files.length) return
    for (const file of files) queue.push({ file, state: 'waiting' })
    show(true)
    renderPanel()
    run().catch(() => { /* every failure path already lands in the panel */ })
  }

  open.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    // Snapshot BEFORE resetting the input: clearing `value` empties the live
    // FileList, and this queue outlives the event handler.
    const picked = input.files ? Array.from(input.files) : []
    input.value = ''
    add(picked)
  })

  $('upload-minimise')?.addEventListener('click', () => show(false))
  $('upload-badge')?.addEventListener('click', () => { show(true); $('upload-heading')?.focus() })
  $('upload-close')?.addEventListener('click', () => {
    queue.length = 0
    const list = $('upload-files'); if (list) list.innerHTML = ''
    show(false)
    const badge = $('upload-badge'); if (badge) badge.hidden = true
  })
  $('upload-stop')?.addEventListener('click', () => { stopped = true; controller?.abort() })
  $('upload-refresh')?.addEventListener('click', () => window.location.reload())

  // Drag-and-drop for desktop; the picker is the path on touch.
  const drop = state.container || document.body
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('upload-dragover') })
  drop.addEventListener('dragleave', () => drop.classList.remove('upload-dragover'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('upload-dragover')
    add(Array.from((e as DragEvent).dataTransfer?.files || []))
  })
}

// Guest upload client.
//
// Deliberately NOT a form post. Each file goes up as its own request with the
// raw file as the body, so the server can construct every Immich field itself
// (see src/stream/upload.ts for why that matters). Files go one at a time:
// the server caps concurrency anyway, and a home upload link is far more
// likely to be bandwidth-bound than round-trip-bound.

import { state } from './state.js'

interface UploadTarget {
  path: string
  maxBytes: number
}

/** Per-file outcome, so the summary can name what failed and why. */
interface FileResult {
  name: string
  ok: boolean
  reason?: string
}

let target: UploadTarget | null = null
let busy = false

function statusEl (): HTMLElement | null {
  return document.getElementById('upload-status')
}

function setStatus (message: string, isError = false): void {
  const el = statusEl()
  if (!el) return
  el.textContent = message
  el.classList.toggle('upload-error', isError)
  el.hidden = !message
}

function humanSize (bytes: number): string {
  return bytes >= 1048576
    ? `${Math.round(bytes / 1048576)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Turn a server reason code into something a visitor can act on.
 *
 * "Upload failed" tells someone nothing about whether to retry, pick a
 * smaller file, or go and ask whoever shared the album. Each of those is a
 * different next step, so each gets its own sentence.
 */
function explain (reason: string | undefined, name: string, maxBytes: number): string {
  switch (reason) {
    case 'too-large': return `${name} is larger than ${humanSize(maxBytes)}`
    case 'not-media': return `${name} is not a photo or video`
    case 'empty': return `${name} is empty`
    case 'bad-date': return `${name} has no usable date`
    case 'album-full': return 'The album is full — ask whoever shared it to make room'
    case 'expired': return 'This link has expired'
    case 'not-allowed':
    case 'disabled': return 'This link no longer accepts uploads'
    case 'busy': return 'Too many uploads at once — try again in a few seconds'
    case 'upstream': return `The photo server would not accept ${name}`
    default: return `${name} could not be uploaded`
  }
}

/**
 * Send one file.
 *
 * Size and emptiness are checked here, before a byte leaves the browser.
 * Uploading 300 MB over a phone connection only to be told it was too big is
 * the kind of thing that makes people give up.
 */
async function sendFile (file: File): Promise<FileResult> {
  const name = file.name || 'file'
  if (!target) return { name, ok: false }
  if (file.size === 0) return { name, ok: false, reason: 'empty' }
  if (file.size > target.maxBytes) return { name, ok: false, reason: 'too-large' }

  const res = await fetch(target.path, {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-IPP-Filename': encodeURIComponent(name),
      'X-IPP-Created-At': new Date(file.lastModified || Date.now()).toISOString()
    }
  })
  if (res.ok) return { name, ok: true }

  let reason: string | undefined
  try {
    reason = (await res.json() as { reason?: string }).reason
  } catch (e) { /* no body; fall back to the generic message */ }
  return { name, ok: false, reason }
}

/**
 * `files` must be a plain array, never the input's live FileList: clearing
 * `input.value` (which we do so the same file can be picked twice) empties
 * that list in place, and this function awaits between items. Snapshot first,
 * or every upload after the first one reads `undefined`.
 *
 * Caught only by driving a real browser - the request-level tests upload one
 * file at a time and never touch the input element.
 */
async function handleFiles (files: File[]): Promise<void> {
  if (!target || busy || !files.length) return
  busy = true
  const total = files.length
  const results: FileResult[] = []

  for (let i = 0; i < total; i++) {
    setStatus(total === 1
      ? `Uploading ${files[i].name || 'file'}…`
      : `Uploading ${i + 1} of ${total}…`)
    try {
      results.push(await sendFile(files[i]))
    } catch (e) {
      results.push({ name: files[i].name || 'file', ok: false })
    }
  }

  busy = false
  report(results)
}

/**
 * Say what happened, per file. A bare count hides the useful part: which
 * photo did not make it, and what to do about it.
 */
function report (results: FileResult[]): void {
  const maxBytes = target?.maxBytes ?? 0
  const done = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok)

  if (!failed.length) {
    setStatus(`Added ${done} ${done === 1 ? 'photo' : 'photos'}. Refreshing…`)
    // The gallery is served no-store and the server dropped its cached share
    // on success, so a reload is guaranteed to show the new items. Inserting
    // them into the virtualised grid in place would be nicer, and is the
    // obvious follow-up - it is just a lot more moving parts than a reload.
    window.setTimeout(() => window.location.reload(), 600)
    return
  }

  // Three reasons at most: beyond that the message stops being readable and a
  // count serves better.
  const detail = failed.slice(0, 3).map(r => explain(r.reason, r.name, maxBytes))
  if (failed.length > 3) detail.push(`and ${failed.length - 3} more`)

  setStatus(done
    ? `Added ${done}. Not added: ${detail.join('; ')}`
    : detail.join('; '), true)

  // Something did land, so refresh to show it - but leave the message up long
  // enough to be read first.
  if (done) window.setTimeout(() => window.location.reload(), 4000)
}

export function setupUpload (path?: string, maxBytes?: number): void {
  if (!path) return
  target = { path, maxBytes: maxBytes || Number.MAX_SAFE_INTEGER }

  const input = document.getElementById('upload-input') as HTMLInputElement | null
  const button = document.getElementById('upload-open')
  if (!input || !button) return

  button.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    // Snapshot BEFORE resetting the input - see handleFiles.
    const picked = input.files ? Array.from(input.files) : []
    input.value = ''
    if (picked.length) handleFiles(picked).catch(() => setStatus('Upload failed.', true))
  })

  // Drag-and-drop onto the gallery, for the desktop case.
  const dropZone = state.container || document.body
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropZone.classList.add('upload-dragover')
  })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('upload-dragover'))
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault()
    dropZone.classList.remove('upload-dragover')
    const dropped = (e as DragEvent).dataTransfer?.files
    const picked = dropped ? Array.from(dropped) : []
    if (picked.length) handleFiles(picked).catch(() => setStatus('Upload failed.', true))
  })
}

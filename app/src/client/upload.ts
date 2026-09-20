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

/**
 * Send one file. Resolves true on success. The server answers with a generic
 * status on failure, so there is nothing more specific to show the visitor
 * than which file did not make it.
 */
async function sendFile (file: File): Promise<boolean> {
  if (!target) return false
  if (file.size > target.maxBytes) return false
  const res = await fetch(target.path, {
    method: 'POST',
    body: file,
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-IPP-Filename': encodeURIComponent(file.name),
      'X-IPP-Created-At': new Date(file.lastModified || Date.now()).toISOString()
    }
  })
  return res.ok
}

async function handleFiles (files: FileList): Promise<void> {
  if (!target || busy || !files.length) return
  busy = true
  const total = files.length
  let done = 0
  let failed = 0

  for (let i = 0; i < total; i++) {
    setStatus(`Uploading ${i + 1} of ${total}…`)
    try {
      if (await sendFile(files[i])) done++
      else failed++
    } catch (e) {
      failed++
    }
  }

  busy = false
  if (done && !failed) {
    setStatus(`Added ${done} ${done === 1 ? 'photo' : 'photos'}. Refreshing…`)
    // The gallery is served no-store and the server dropped its cached share
    // on success, so a reload is guaranteed to show the new items. Inserting
    // them into the virtualised grid in place would be nicer, and is the
    // obvious follow-up - it is just a lot more moving parts than a reload.
    window.setTimeout(() => window.location.reload(), 600)
  } else if (done) {
    setStatus(`Added ${done}, but ${failed} failed.`, true)
    window.setTimeout(() => window.location.reload(), 1500)
  } else {
    setStatus(failed === 1 ? 'Upload failed.' : `All ${failed} uploads failed.`, true)
  }
}

export function setupUpload (path?: string, maxBytes?: number): void {
  if (!path) return
  target = { path, maxBytes: maxBytes || Number.MAX_SAFE_INTEGER }

  const input = document.getElementById('upload-input') as HTMLInputElement | null
  const button = document.getElementById('upload-open')
  if (!input || !button) return

  button.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    if (input.files) handleFiles(input.files).catch(() => setStatus('Upload failed.', true))
    input.value = ''
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
    if (dropped) handleFiles(dropped).catch(() => setStatus('Upload failed.', true))
  })
}

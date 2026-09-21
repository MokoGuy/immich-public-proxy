/*
 * Upload panel shell, rendered server-side and populated by
 * `src/client/upload.ts`.
 *
 * Modelled on Immich's own upload panel (web/src/routes/UploadPanel.svelte):
 * a dismissable card that floats above the page, a per-file row carrying a
 * state icon, the filename and a progress bar, and a minimised badge showing
 * how many are left. Sharing that vocabulary matters - someone who uses
 * Immich should not have to learn a second upload idiom to use a link it
 * gave them.
 *
 * Two deliberate departures:
 *
 * - Immich pins a ~324px card to the bottom-right, which is cramped on a
 *   412px phone. Here it is a full-width sheet at the bottom on small
 *   screens and a floating card from `md` up. The bottom of the screen is
 *   also where a thumb already is.
 * - Immich exposes an upload-concurrency setting. That is an operator
 *   control, not something to put in front of an anonymous visitor.
 *
 * Being `position: fixed` is load-bearing beyond looks: the panel never
 * changes the gallery's layout, so the virtualiser - which only recomputes
 * on a width change - has nothing to reconcile.
 */

/** Material Design icons, the set Immich itself uses. */
const ICON = {
  pending: 'M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
  sending: 'M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z',
  done: 'M12,2C6.5,2 2,6.5 2,12S6.5,22 12,22 22,17.5 22,12 17.5,2 12,2M10,17L5,12L6.41,10.59L10,14.17L17.59,6.58L19,8L10,17Z',
  warn: 'M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
  retry: 'M12,4C14.1,4 16.1,4.8 17.6,6.3C20.7,9.4 20.7,14.5 17.6,17.6C15.8,19.5 13.3,20.2 10.9,19.9L11.4,17.9C13.1,18.1 14.9,17.5 16.2,16.2C18.5,13.9 18.5,10.1 16.2,7.7C15.1,6.6 13.5,6 12,6V10.6L7,5.6L12,0.6V4M6.3,17.6C3.7,15 3.4,11 5.1,8.1L6.6,9.6C5.5,11.6 5.8,14.2 7.5,15.9C8,16.4 8.6,16.8 9.3,17.1L8.7,19.1C7.8,18.8 6.9,18.2 6.3,17.6Z',
  close: 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  minimise: 'M20,14H4V10H20V14Z',
  upload: 'M14,13V17H10V13H7L12,8L17,13M19.35,10.03C18.67,6.59 15.64,4 12,4C9.11,4 6.6,5.64 5.35,8.03C2.34,8.36 0,10.9 0,14A6,6 0 0,0 6,20H19A5,5 0 0,0 24,15C24,12.36 21.95,10.22 19.35,10.03Z'
}

function Icon ({ path, size = 22 }: { path: string, size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d={path}/>
    </svg>
  )
}

export function UploadPanel () {
  return (
    <>
      {/*
        Minimised state: a badge with the number still to go, the same
        affordance Immich uses. Hidden until there is something to report.
      */}
      <button id="upload-badge" type="button" hidden aria-label="Show upload progress">
        <Icon path={ICON.upload} size={20}/>
        <span id="upload-badge-count">0</span>
      </button>

      <section id="upload-panel" hidden aria-labelledby="upload-heading">
        <div class="upload-panel-head">
          <div>
            <h2 id="upload-heading" tabindex={-1}>Uploading</h2>
            <p id="upload-counts"></p>
          </div>
          <div class="upload-panel-actions">
            <button id="upload-minimise" type="button" class="upload-icon-btn" aria-label="Minimise">
              <Icon path={ICON.minimise} size={20}/>
            </button>
            <button id="upload-close" type="button" class="upload-icon-btn" hidden aria-label="Dismiss">
              <Icon path={ICON.close} size={20}/>
            </button>
          </div>
        </div>

        <ul id="upload-files"></ul>

        <p id="upload-hint">Keep this page open while uploading.</p>

        <div class="upload-panel-foot">
          <button id="upload-stop" type="button" class="upload-text-btn">Stop</button>
          <button id="upload-refresh" type="button" class="upload-text-btn upload-primary" hidden>
            Refresh gallery
          </button>
        </div>
      </section>

      {/*
        Announcements only. The visual progress updates many times a second;
        a screen reader gets milestones instead, from a node that exists from
        page load so the first message is not missed.
      */}
      <div id="upload-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    </>
  )
}

/** Icon paths the client needs to swap per-file state. */
export const UPLOAD_ICONS = ICON

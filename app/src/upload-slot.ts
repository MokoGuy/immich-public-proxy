import type { Socket } from 'net'

/**
 * Bound how long a single request may hold an upload admission slot.
 *
 * The slot is released in a `finally`, so the only way to keep one forever is
 * for the handler never to settle. That is reachable in production: `res`
 * 'close' catches the visitor who hangs up properly, but not the one whose
 * connection merely stops existing - a phone losing signal behind a reverse
 * proxy, where the upstream socket stays open and no FIN ever arrives. The
 * round-trip to Immich carries no deadline of its own either. At
 * `maxConcurrent` such requests every upload answers 503 'busy' until the
 * proxy is restarted, so one flaky mobile connection can wedge a public
 * write path.
 *
 * Two bounds, both from the platform rather than timers of our own:
 *
 *   idleMs   the socket's own idle timer, which fires only when nothing has
 *            been read or written for that long. A slow upload keeps
 *            delivering bytes and never reaches it.
 *   totalMs  a hard deadline, so the slot comes back even if the socket
 *            keeps looking alive.
 *
 * Neither can admit a request the gate refused - they only ever abort. The
 * returned function detaches both and restores the socket's previous idle
 * setting, so a keep-alive connection is left as it was found.
 */
export function boundSlot (socket: Socket, abort: AbortController, idleMs: number, totalMs: number): () => void {
  const release = () => abort.abort()
  const previous = socket.timeout || 0

  socket.setTimeout(idleMs)
  socket.on('timeout', release)

  const deadline = AbortSignal.timeout(totalMs)
  deadline.addEventListener('abort', release, { once: true })

  return () => {
    socket.off('timeout', release)
    socket.setTimeout(previous)
    deadline.removeEventListener('abort', release)
  }
}

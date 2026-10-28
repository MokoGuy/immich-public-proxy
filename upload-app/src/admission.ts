import type { Socket } from 'net'

/*
  Bounded admission for the routes that write to Immich: at most
  `capacity` requests at once, refused over capacity rather than queued.

  A queue is the wrong tool for an anonymous public write path: each parked
  request keeps its socket, its buffered input and its closure alive, and a
  visitor who disconnects while queued stays queued. Someone holding an
  upload link could pile those up until the service falls over. So a request
  over capacity is answered 503 with `Retry-After` before a byte of its body
  is read, and the page waits and sends it again.

  `tryAcquire` is synchronous on purpose: the caller must reserve before its
  first `await`. The event loop is single-threaded, so a check and an
  increment with nothing asynchronous between them are atomic; reserving
  after an `await` (share resolution, say) lets every concurrent request read
  the same count, pass together and then all increment, which is no cap.
*/

export type SlotEnd = 'idle-timeout' | 'deadline'

export interface Admission {
  /** Reserve a slot, or null when all are taken. The release is safe to call more than once. */
  tryAcquire (): (() => void) | null
  /** Slots currently held. */
  inFlight (): number
  readonly capacity: number
}

export function createAdmission (capacity: number): Admission {
  const limit = Math.max(1, Math.floor(capacity) || 1)
  let held = 0
  return {
    capacity: limit,
    inFlight: () => held,
    tryAcquire () {
      if (held >= limit) return null
      held++
      let released = false
      return () => {
        // Exactly once: a double release would let one request too many in
        if (released) return
        released = true
        held--
      }
    }
  }
}

/**
 * Bound how long one request may hold a slot. The slot is released in a
 * `finally`, so the only way to keep one forever is for the handler never to
 * settle, and that is reachable: a phone that loses signal behind a reverse
 * proxy leaves an upstream socket that stays open with no FIN, and the
 * round trip to Immich has no deadline of its own. At `capacity` such
 * requests every upload would answer 503 until a restart.
 *
 *   idleMs   the socket's own idle timer: nothing read or written for that
 *            long. A slow upload keeps delivering bytes and never reaches it.
 *   totalMs  a hard deadline, so the slot comes back even if the socket keeps
 *            looking alive.
 *
 * Both only ever abort, with the bound that fired as the reason. The returned
 * function detaches them and restores the socket's previous idle setting.
 */
export function boundSlot (socket: Socket, abort: AbortController, idleMs: number, totalMs: number): () => void {
  const onIdle = () => abort.abort('idle-timeout' satisfies SlotEnd)
  const onDeadline = () => abort.abort('deadline' satisfies SlotEnd)
  const previous = socket.timeout || 0

  socket.setTimeout(idleMs)
  socket.on('timeout', onIdle)

  const deadline = AbortSignal.timeout(totalMs)
  deadline.addEventListener('abort', onDeadline, { once: true })

  return () => {
    socket.off('timeout', onIdle)
    socket.setTimeout(previous)
    deadline.removeEventListener('abort', onDeadline)
  }
}

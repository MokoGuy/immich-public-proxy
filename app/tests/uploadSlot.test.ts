import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import type { Socket } from 'net'
import { boundSlot } from '../src/upload-slot'

/*
 * These cover the invariant "an admission slot always comes back", which the
 * `finally` in the route cannot provide on its own: it only runs once the
 * handler settles, and a vanished visitor plus a silent Immich means it never
 * does. Every test here fails if the corresponding bound is removed.
 */

class FakeSocket extends EventEmitter {
  timeout = 0
  setTimeout (ms: number) { this.timeout = ms; return this }
}

const make = () => {
  const socket = new FakeSocket()
  const abort = new AbortController()
  return { socket, abort, as: socket as unknown as Socket }
}

describe('boundSlot', () => {
  it('arms the socket idle timer with the requested bound', () => {
    const { socket, abort, as } = make()
    boundSlot(as, abort, 1234, 60000)
    expect(socket.timeout).toBe(1234)
  })

  it('aborts when the connection falls silent', () => {
    const { socket, abort, as } = make()
    boundSlot(as, abort, 1234, 60000)
    expect(abort.signal.aborted).toBe(false)
    socket.emit('timeout')
    expect(abort.signal.aborted).toBe(true)
  })

  it('aborts on the hard deadline even while the socket looks alive', async () => {
    const { abort, as } = make()
    boundSlot(as, abort, 60000, 20)
    expect(abort.signal.aborted).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 120))
    // No socket activity at all, and no 'timeout' event: only the deadline
    // can have fired. This is the backstop for a socket that never reports
    // itself idle - exactly what a proxy holding the connection produces.
    expect(abort.signal.aborted).toBe(true)
  })

  it('stops bounding a request that finished, and restores the socket', async () => {
    const { socket, abort, as } = make()
    socket.timeout = 5000
    const unbind = boundSlot(as, abort, 1234, 20)
    unbind()

    // A keep-alive socket is handed back as it was found, not left carrying
    // this request's idle bound into the next one on the same connection.
    expect(socket.timeout).toBe(5000)
    expect(socket.listenerCount('timeout')).toBe(0)

    socket.emit('timeout')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(abort.signal.aborted).toBe(false)
  })
})

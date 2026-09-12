type Listener = (active: boolean) => void

const listeners = new Set<Listener>()
let active = false

/**
 * One flag saying the player is typing, read by every window-level key handler.
 *
 * The controllers listen on `window`, so a focused chat input does not shield
 * them on its own: the keystrokes still bubble all the way up, and W would walk
 * while it is being typed. Rather than teach each controller about the DOM, they
 * ask this module. The overlay sets the flag from a capture-phase listener,
 * which always runs before the bubble-phase game handlers see the same event.
 */
export const textEntry = {
  get active() { return active },
  set(next: boolean) {
    if (next === active) return
    active = next
    for (const listener of listeners) listener(next)
  },
  /** Fires on every change. Controllers use it to drop the keys they hold. */
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

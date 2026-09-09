import * as THREE from 'three'

// Per-pass GPU timing from EXT_disjoint_timer_query_webgl2.
//
// requestAnimationFrame deltas measure how long the *frame* took, which on a
// GPU-bound scene is the queue draining, not the work any one pass did. Ten
// passes that all draw fullscreen quads look identical from the CPU side. These
// queries are the only way to see which of them is actually spending the
// milliseconds, and that is the difference between optimising the renderer and
// guessing at it.
//
// The extension exposes one TIME_ELAPSED counter per context, so regions cannot
// nest or interleave -- begin() and end() have to strictly alternate. That suits
// a pass chain, which is sequential by construction.

export interface GpuTiming {
  label: string
  ms: number
}

interface TimerExtension {
  readonly GPU_DISJOINT_EXT: number
  readonly TIME_ELAPSED_EXT: number
}

// Results land a few frames after the work, so a query in flight cannot be
// reused. Beyond this many the driver is not keeping up and dropping the
// measurement is better than growing without bound.
const MAX_IN_FLIGHT = 24
// Enough to settle within a second at 60fps without turning a one-frame hitch
// into a number that never comes back down.
const SMOOTHING = 0.12

export class GpuProfiler {
  private gl: WebGL2RenderingContext | null = null
  private ext: TimerExtension | null = null
  private pool: WebGLQuery[] = []
  private inFlight: { label: string, query: WebGLQuery }[] = []
  private open: WebGLQuery | null = null
  private openLabel = ''
  private enabled = false
  private smoothed = new Map<string, number>()
  // Insertion order, so the HUD lists passes in the order they run rather than
  // in whatever order their first result happened to arrive.
  private order: string[] = []
  private startedThisFrame = new Set<string>()
  private startedLastFrame = new Set<string>()

  constructor(renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext()
    if (typeof WebGL2RenderingContext === 'undefined') return
    if (!(gl instanceof WebGL2RenderingContext)) return
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
    if (!ext) return
    this.gl = gl
    this.ext = ext
  }

  isSupported(): boolean {
    return this.gl !== null
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) this.reset()
  }

  isEnabled(): boolean {
    return this.enabled && this.gl !== null
  }

  /** Collects whatever finished since last frame. Call once, before any pass. */
  beginFrame(): void {
    const gl = this.gl
    if (!gl || !this.ext || !this.enabled) return

    // A disjoint means the GPU was interrupted (power state, another context)
    // and every timing spanning that window is meaningless, not merely noisy.
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.recycleInFlight()
    } else {
      const stillPending: typeof this.inFlight = []
      for (const entry of this.inFlight) {
        if (!gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) {
          stillPending.push(entry)
          continue
        }
        const nanos = gl.getQueryParameter(entry.query, gl.QUERY_RESULT) as number
        this.record(entry.label, nanos / 1e6)
        this.pool.push(entry.query)
      }
      this.inFlight = stillPending
    }

    // A pass that stopped running -- disabled in the editor, or culled away --
    // would otherwise sit in the HUD at its last value forever, reading as cost
    // that is no longer being paid.
    for (const label of this.order) {
      if (!this.startedLastFrame.has(label) && !this.startedThisFrame.has(label)) {
        this.smoothed.set(label, 0)
      }
    }
    this.startedLastFrame = this.startedThisFrame
    this.startedThisFrame = new Set()
  }

  begin(label: string): void {
    const gl = this.gl
    if (!gl || !this.enabled) return
    // Never nest: the counter is per-context, and a second beginQuery while one
    // is open is an INVALID_OPERATION that would poison the whole frame.
    if (this.open) return
    if (this.inFlight.length >= MAX_IN_FLIGHT) return

    const query = this.pool.pop() ?? gl.createQuery()
    if (!query) return
    gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, query)
    this.open = query
    this.openLabel = label
    if (!this.smoothed.has(label)) {
      this.smoothed.set(label, 0)
      this.order.push(label)
    }
    this.startedThisFrame.add(label)
  }

  end(): void {
    const gl = this.gl
    if (!gl || !this.ext || !this.open) return
    gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this.inFlight.push({ label: this.openLabel, query: this.open })
    this.open = null
  }

  getTimings(): GpuTiming[] {
    return this.order.map(label => ({ label, ms: this.smoothed.get(label) ?? 0 }))
  }

  /** Sum of every measured region. Not the frame time -- gaps are CPU stalls. */
  getTotalMs(): number {
    let total = 0
    for (const value of this.smoothed.values()) total += value
    return total
  }

  private record(label: string, ms: number): void {
    const previous = this.smoothed.get(label)
    this.smoothed.set(label, previous === undefined || previous === 0
      ? ms
      : previous + (ms - previous) * SMOOTHING)
  }

  private recycleInFlight(): void {
    for (const entry of this.inFlight) this.pool.push(entry.query)
    this.inFlight = []
  }

  private reset(): void {
    this.recycleInFlight()
    this.smoothed.clear()
    this.order = []
    this.startedThisFrame.clear()
    this.startedLastFrame.clear()
  }

  dispose(): void {
    const gl = this.gl
    if (!gl) return
    if (this.open && this.ext) {
      gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      this.open = null
    }
    for (const entry of this.inFlight) gl.deleteQuery(entry.query)
    for (const query of this.pool) gl.deleteQuery(query)
    this.inFlight = []
    this.pool = []
    this.reset()
  }
}

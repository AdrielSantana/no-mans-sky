import type { TerrainWorkerResponse } from './terrain-worker-types'

// One pool of chunk-build workers for the whole client, rather than one per
// planet.
//
// PlanetRenderer used to build its own pool in its constructor, and
// celestial-system.ts builds a renderer for every body that carries planet
// params -- five in the seeded system, none of them distance-gated. On a ten
// thread machine that was 5 x min(8, threads - 1) = 40 module workers alive
// from the first sync, each holding its own copy of the terrain bundle, all
// competing for the same cores. The player can only ever stand on one planet,
// and a distant one stops asking for chunks as soon as its quadtree settles,
// so the other four pools sat idle and expensive.
//
// Only chunk traffic is pooled. Ocean workers are one-shot and terminated with
// their job, and the prop sun worker is created lazily and only where props
// exist, so neither is a persistent cost.

const MAX_TERRAIN_WORKERS = 8

interface PooledWorker {
  worker: Worker
  // Whether a job is in the air. Deliberately separate from `owner`: an owner
  // can walk away from a job it no longer wants (see releaseTerrainWorkersFor)
  // while the worker is still computing, and handing that worker to someone
  // else before the old response lands would deliver it to the wrong handler.
  busy: boolean
  owner: object | null
  onMessage: ((response: TerrainWorkerResponse) => void) | null
  onError: (() => void) | null
}

let pool: PooledWorker[] = []
let configuredSize = 0

function hardwareWorkerCount(): number {
  const threads = typeof navigator === 'undefined'
    ? 4
    : Math.max(2, navigator.hardwareConcurrency ?? 4)
  return Math.max(1, Math.min(MAX_TERRAIN_WORKERS, threads - 1))
}

function finish(pooled: PooledWorker): void {
  pooled.busy = false
  pooled.owner = null
  pooled.onMessage = null
  pooled.onError = null
}

function spawn(): PooledWorker {
  const worker = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' })
  const pooled: PooledWorker = {
    worker,
    busy: false,
    owner: null,
    onMessage: null,
    onError: null,
  }

  // Installed once and dispatched to whoever holds the lease. Reassigning
  // worker.onmessage per job would race a response already queued against the
  // handler it was queued for.
  worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
    const response = event.data
    // Ocean and prop-sun traffic has its own workers; these only ever see chunk
    // responses. Narrowing here keeps the union honest.
    if (
      response.type === 'ocean-built' || response.type === 'ocean-error'
      || response.type === 'prop-sun-built' || response.type === 'prop-sun-error'
    ) return
    const handler = pooled.onMessage
    finish(pooled)
    handler?.(response)
  }

  worker.onerror = () => {
    const handler = pooled.onError
    finish(pooled)
    handler?.()
  }

  return pooled
}

/**
 * Sets how many workers the shared pool runs. `requested` of 0 derives it from
 * the hardware. Growing spawns immediately; shrinking terminates only idle
 * workers, leaving busy ones for a later call to reap once their job has
 * landed, so no in-flight chunk is thrown away.
 */
export function setTerrainWorkerPoolSize(requested: number): void {
  if (typeof Worker === 'undefined') return

  const cap = hardwareWorkerCount()
  const target = requested > 0 ? Math.max(1, Math.min(Math.floor(requested), cap)) : cap
  configuredSize = requested

  while (pool.length < target) pool.push(spawn())

  if (pool.length > target) {
    const keep: PooledWorker[] = []
    for (const pooled of pool) {
      if (keep.length < target || pooled.busy) keep.push(pooled)
      else pooled.worker.terminate()
    }
    pool = keep
  }
}

export function terrainWorkerPoolSize(): number {
  return pool.length
}

/**
 * Leases an idle worker for one job. Returns null when every worker is busy,
 * which is the caller's signal to stop dispatching this frame. The lease ends
 * by itself: `onMessage` and `onError` fire after the worker is already back in
 * the pool, so a handler may dispatch again straight away.
 */
export function acquireTerrainWorker(
  owner: object,
  onMessage: (response: TerrainWorkerResponse) => void,
  onError: () => void,
): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (pool.length === 0) setTerrainWorkerPoolSize(configuredSize)

  for (const pooled of pool) {
    if (pooled.busy) continue
    pooled.busy = true
    pooled.owner = owner
    pooled.onMessage = onMessage
    pooled.onError = onError
    return pooled.worker
  }
  return null
}

/**
 * Drops the leases held by one owner without terminating anything. Called when
 * a PlanetRenderer is disposed: its in-flight results are no longer wanted, but
 * the workers belong to every other planet too.
 *
 * The worker stays marked busy until its response lands, at which point the
 * result falls into a null handler and the slot frees itself. Killing it
 * instead would cost a full module-worker respawn to save a few milliseconds of
 * work nobody is waiting on.
 */
export function releaseTerrainWorkersFor(owner: object): void {
  for (const pooled of pool) {
    if (pooled.owner !== owner) continue
    pooled.owner = null
    pooled.onMessage = null
    pooled.onError = null
  }
}

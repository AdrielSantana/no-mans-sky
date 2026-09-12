// Editor console: await (await import('/scripts/budget-sweep.js')).runBudgetSweep()
//
// The streaming budgets are fixed millisecond ceilings sized for a 16 ms frame.
// This frame is ~33 ms and GPU bound, so each one leaves CPU idle that it will
// not spend -- which would make the LOD ladder descend more slowly than the
// machine can actually manage. This sweeps them and measures both halves:
// how fast detail arrives under the player, and whether the frame pays for it.
//
// Reported in wall-clock seconds, not frames: the frame rate is the other
// variable here, and counting frames would hide a budget that bought detail by
// making the frame slower.

function sampleFrames(count) {
  return new Promise(resolve => {
    const deltas = []
    let last = performance.now(), warmup = 12
    const tick = () => {
      const now = performance.now(), dt = now - last
      last = now
      if (warmup > 0) warmup--
      else deltas.push(dt)
      if (deltas.length < count) requestAnimationFrame(tick)
      else resolve(deltas.sort((a, b) => a - b))
    }
    requestAnimationFrame(tick)
  })
}

async function frameStats(engine, frames) {
  const xs = await sampleFrames(frames)
  const mid = xs[Math.floor(xs.length / 2)]
  return {
    frameMs: +mid.toFixed(2),
    fps: +(1000 / mid).toFixed(1),
    p95: +xs[Math.floor(xs.length * 0.95)].toFixed(2),
    draws: engine.renderer.info.render.calls,
  }
}

const BUDGET_FIELDS = ['workerDispatchBudgetMs', 'chunkIntegrationBudgetMs', 'propScatterBudgetMs']

export async function runBudgetSweep({
  multipliers = [1, 2, 4, 8],
  loadTimeoutS = 300,
  frames = 240,
  targetLods = [8, 9, 10],
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine, planet, walker } = debug
  const Vector3 = engine.camera.position.constructor
  if (!walker?.isEnabled?.()) walker?.enableNearest?.()

  const defaults = Object.fromEntries(BUDGET_FIELDS.map(f => [f, planet[f]]))
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const nadir = new Vector3()
  const lodUnderCamera = () => {
    if (!planet.lastLocalCamPos) return -1
    nadir.copy(planet.lastLocalCamPos).normalize()
    return planet.findVisibleChunkForDirection(nadir)?.node.lod ?? -1
  }

  const runs = []
  try {
    for (const multiplier of multipliers) {
      for (const field of BUDGET_FIELDS) planet[field] = +(defaults[field] * multiplier).toFixed(3)

      planet.removeAllChunks()
      const start = performance.now()
      const reached = {}
      let settledS = -1
      // Frame times during the load matter as much as the settled figure: a
      // budget that buys detail by stuttering is not a win.
      const loadFrames = []
      let lastSample = performance.now()

      for (;;) {
        await wait(250)
        const now = performance.now()
        loadFrames.push(now - lastSample)
        lastSample = now
        const lod = lodUnderCamera()
        for (const target of targetLods) {
          if (reached[target] === undefined && lod >= target) {
            reached[target] = +((now - start) / 1000).toFixed(1)
          }
        }
        const drained = !planet.fallbackSphere.visible && planet.pendingKeys.size === 0
          && planet.pendingWorkerKeys.size === 0 && planet.propPrepareJobs.size === 0
          && planet.propLayers.size > 0 && engine.renderer.info.render.calls > 300
        if (drained) { settledS = +((now - start) / 1000).toFixed(1); break }
        if ((now - start) / 1000 > loadTimeoutS) break
      }

      const settled = await frameStats(engine, frames)
      runs.push({
        multiplier,
        budgets: Object.fromEntries(BUDGET_FIELDS.map(f => [f, planet[f]])),
        reached,
        settledS,
        settledFrameMs: settled.frameMs,
        settledFps: settled.fps,
        settledP95: settled.p95,
        draws: settled.draws,
        walkerHeld: walker.isEnabled(),
      })
    }
  } finally {
    for (const field of BUDGET_FIELDS) planet[field] = defaults[field]
  }

  return { defaults, runs }
}

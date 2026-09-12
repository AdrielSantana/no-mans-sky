// Editor console: await (await import('/scripts/surface-perf-checks.js')).runSurfacePerf()
//
// Frame-time ablation on the surface. The frame here is GPU bound and fill
// limited (PERF-BACKLOG.md §0d), so nothing in this file times JavaScript:
// it samples the real requestAnimationFrame cadence while the engine drives
// itself, and attributes cost by removing one group at a time.
//
// Three traps this harness exists to avoid, all of them previously walked into
// and written up in PERF-BACKLOG.md:
//
//  - `o.visible = false` does not hide anything. planet.update() reassigns
//    visibility every frame and undoes the test before the next draw. Groups
//    are hidden with a constant getter instead.
//  - The scene streams for minutes after landing. Measuring before it settles
//    turns loading into "results", and makes whatever was measured later look
//    more expensive. Settling requires both a plateau and a floor -- without
//    the floor, an empty scene that has not started loading passes.
//  - A loaded machine moves these numbers by more than the effects being
//    measured. Every config is bracketed by its own baseline, and the run
//    reports the baseline's own dispersion so a result smaller than the noise
//    can be called what it is.

const VSYNC_MS = 1000 / 60

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function percentile(xs, q) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

// Samples the real frame cadence. Both this loop and the engine's own run off
// the same vsync, so the delta between callbacks is the frame interval.
function sampleFrames(count) {
  return new Promise(resolve => {
    const deltas = []
    let last = performance.now()
    let warmup = 10
    const tick = () => {
      const now = performance.now()
      const dt = now - last
      last = now
      if (warmup > 0) warmup--
      else deltas.push(dt)
      if (deltas.length < count) requestAnimationFrame(tick)
      else resolve(deltas)
    }
    requestAnimationFrame(tick)
  })
}

async function measure(engine, frames) {
  const deltas = await sampleFrames(frames)
  const info = engine.renderer.info.render
  return {
    frameMs: +median(deltas).toFixed(2),
    p95: +percentile(deltas, 0.95).toFixed(2),
    fps: +(1000 / median(deltas)).toFixed(1),
    // Spread of the middle of the distribution: a cheap stand-in for how
    // trustworthy the median is on this machine right now.
    spread: +(percentile(deltas, 0.75) - percentile(deltas, 0.25)).toFixed(2),
    draws: info.calls,
    triangles: info.triangles,
  }
}

// planet.update() rewrites `visible` every frame, so assignment is useless.
function forceHidden(objects) {
  const saved = []
  for (const object of objects) {
    if (!object) continue
    saved.push({ object, descriptor: Object.getOwnPropertyDescriptor(object, 'visible') })
    Object.defineProperty(object, 'visible', { get: () => false, set: () => {}, configurable: true })
  }
  return () => {
    for (const { object, descriptor } of saved) {
      delete object.visible
      if (descriptor) Object.defineProperty(object, 'visible', descriptor)
    }
  }
}

function groupMeshes(planet) {
  const grass = []
  for (const layer of planet.grassLayers?.values?.() ?? []) if (layer.mesh) grass.push(layer.mesh)
  for (const layer of planet.farGrassLayers?.values?.() ?? []) if (layer.mesh) grass.push(layer.mesh)

  const props = [], foliage = []
  for (const layer of planet.propLayers?.values?.() ?? []) {
    for (const entry of layer.meshEntries ?? []) if (entry.mesh) props.push(entry.mesh)
    for (const entry of layer.foliageEntries ?? []) if (entry.mesh) foliage.push(entry.mesh)
  }
  return { grass, props, foliage }
}

/**
 * Blocks until the scene stops growing *and* stops getting faster.
 *
 * Geometry alone is not enough. A first run settled on draws and triangles in
 * 17 s and then drifted from 42.1 ms to 28.8 ms across the measurements that
 * followed -- a 13.3 ms slide that buried every effect being measured, the
 * largest of which was 1.55 ms. Draw count was flat the whole time, so whatever
 * was warming up (shader compilation, texture upload, shadow map) is invisible
 * to a geometry check and visible only in frame time.
 *
 * Resolves with how it ended, and with the trajectory, so a timeout is never
 * silently reported as a settled scene.
 */
async function settle(engine, planet, { minDraws, plateauMs, timeoutMs, probeFrames = 90 }) {
  const start = performance.now()
  let lastDraws = -1, lastTriangles = -1, stableSince = null, best = Infinity
  const trajectory = []

  for (;;) {
    const deltas = await sampleFrames(probeFrames)
    const frameMs = median(deltas)
    const info = engine.renderer.info.render
    const draws = info.calls, triangles = info.triangles
    trajectory.push({ t: +((performance.now() - start) / 1000).toFixed(1), frameMs: +frameMs.toFixed(2), draws })

    const grew = Math.abs(draws - lastDraws) > Math.max(2, lastDraws * 0.01)
      || Math.abs(triangles - lastTriangles) > Math.max(5000, lastTriangles * 0.01)
    lastDraws = draws; lastTriangles = triangles

    // Still improving: anything more than 2% faster than the best seen so far
    // means the frame is still warming up.
    const improving = frameMs < best * 0.98
    if (frameMs < best) best = frameMs

    const busy = planet.pendingKeys.size > 0 || planet.pendingWorkerKeys.size > 0 || planet.propPrepareJobs.size > 0
    if (grew || busy || improving || draws < minDraws) stableSince = null
    else if (stableSince === null) stableSince = performance.now()
    else if (performance.now() - stableSince >= plateauMs) {
      return { settled: true, seconds: +((performance.now() - start) / 1000).toFixed(1), draws, triangles, trajectory }
    }

    if (performance.now() - start > timeoutMs) {
      return { settled: false, seconds: +((performance.now() - start) / 1000).toFixed(1), draws, triangles, busy, trajectory }
    }
  }
}

export async function runSurfacePerf({
  frames = 240,
  minDraws = 300,
  plateauMs = 30000,
  settleTimeoutMs = 420000,
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine, planet, walker } = debug

  if (!walker?.isEnabled?.()) walker?.enableNearest?.()
  if (!walker?.isEnabled?.()) throw new Error('Could not enter walking mode')

  const settleResult = await settle(engine, planet, { minDraws, plateauMs, timeoutMs: settleTimeoutMs })

  const configs = [
    { name: 'sem folhagem', pick: g => g.foliage },
    { name: 'sem grama', pick: g => g.grass },
    { name: 'sem props', pick: g => g.props },
    { name: 'sem vegetacao', pick: g => [...g.foliage, ...g.grass, ...g.props] },
    { name: 'sem sombra projetada', shadow: true },
  ]

  const runs = []
  const baselines = []
  let before = await measure(engine, frames)
  baselines.push(before)

  for (const config of configs) {
    let restore
    if (config.shadow) {
      const was = engine.sunShadow.enabled
      engine.sunShadow.enabled = false
      restore = () => { engine.sunShadow.enabled = was }
    } else {
      restore = forceHidden(config.pick(groupMeshes(planet)))
    }

    const measured = await measure(engine, frames)
    restore()

    const after = await measure(engine, frames)
    baselines.push(after)
    // Bracketing baseline: drift between the two is charged to the machine,
    // not to the config.
    const pairedBaseline = (before.frameMs + after.frameMs) / 2
    runs.push({
      name: config.name,
      ...measured,
      gainMs: +(pairedBaseline - measured.frameMs).toFixed(2),
      baselineDriftMs: +(after.frameMs - before.frameMs).toFixed(2),
      drawsRemoved: before.draws - measured.draws,
      trianglesRemoved: before.triangles - measured.triangles,
    })
    before = after
  }

  const baselineSpread = Math.max(...baselines.map(b => b.spread))
  const baselineRange = +(Math.max(...baselines.map(b => b.frameMs)) - Math.min(...baselines.map(b => b.frameMs))).toFixed(2)
  return {
    settle: settleResult,
    dpr: engine.renderer.getPixelRatio(),
    vsyncMs: +VSYNC_MS.toFixed(2),
    baseline: baselines[0],
    baselines: baselines.map(b => b.frameMs),
    // If the baseline wanders by more than a result, that result is noise.
    noiseFloorMs: +Math.max(baselineSpread, baselineRange).toFixed(2),
    runs: runs.sort((a, b) => b.gainMs - a.gainMs),
  }
}

// ── Round two: everything that is not vegetation ──────────────────────
//
// Ablating vegetation on this branch returns ~1 ms of a 34.5 ms frame, against
// 13.24 ms when PERF-BACKLOG.md §0 was written. The cost moved, and geometry is
// not where it went: removing 113 draws and 350 k triangles changes nothing.
//
// So this sweeps the two things §0d identified as the only ones that ever
// responded -- resolution, and whatever the fixed remainder is -- plus the
// fullscreen passes and the objects added to the scene since that baseline.
export async function runSurfaceAblation2({
  frames = 240,
  minDraws = 300,
  plateauMs = 30000,
  settleTimeoutMs = 420000,
  dprLadder = [1, 0.7, 0.5, 0.35],
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine, planet, walker, ship } = debug

  if (!walker?.isEnabled?.()) walker?.enableNearest?.()
  const settleResult = await settle(engine, planet, { minDraws, plateauMs, timeoutMs: settleTimeoutMs })

  const passByType = type => engine.composer.passes.find(p => p.constructor.name === type)
  const shipObject = ship?.group ?? ship?.model ?? ship?.object ?? null

  const configs = [
    { name: 'sem nuvem (composite)', pass: 'CloudCompositePass' },
    { name: 'sem bloom', pass: 'UnrealBloomPass' },
    { name: 'sem SMAA', pass: 'SMAAPass' },
    { name: 'sem os tres passes', passes: ['CloudCompositePass', 'UnrealBloomPass', 'SMAAPass'] },
    { name: 'sem oceano', objects: () => [planet.oceanMesh] },
    { name: 'sem atmosfera', objects: () => [planet.atmosphereMesh] },
    { name: 'sem nuvens (mesh)', objects: () => [planet.cloudMesh, planet.cloudBillboardMesh] },
    { name: 'sem terreno+veg', objects: () => [...planet.chunks.values()].map(c => c.mesh) },
    { name: 'sem nave', objects: () => [shipObject] },
    { name: 'sem avatar', objects: () => [walker.avatar?.group ?? walker.avatar?.object ?? null] },
  ]

  const runs = []
  const baselines = []
  let before = await measure(engine, frames)
  baselines.push(before)

  for (const config of configs) {
    let restore
    if (config.pass || config.passes) {
      const targets = (config.passes ?? [config.pass]).map(passByType).filter(Boolean)
      const was = targets.map(p => p.enabled)
      targets.forEach(p => { p.enabled = false })
      restore = () => targets.forEach((p, i) => { p.enabled = was[i] })
    } else {
      restore = forceHidden(config.objects().filter(Boolean))
    }

    const measured = await measure(engine, frames)
    restore()
    const after = await measure(engine, frames)
    baselines.push(after)

    const pairedBaseline = (before.frameMs + after.frameMs) / 2
    runs.push({
      name: config.name,
      ...measured,
      gainMs: +(pairedBaseline - measured.frameMs).toFixed(2),
      baselineDriftMs: +(after.frameMs - before.frameMs).toFixed(2),
      drawsRemoved: before.draws - measured.draws,
    })
    before = after
  }

  // Resolution ladder last: it changes render target sizes, which is the one
  // thing here that could perturb the state the other configs were read in.
  const dprRuns = []
  const originalDpr = engine.renderer.getPixelRatio()
  for (const dpr of dprLadder) {
    engine.setPixelRatioLimit(dpr)
    await new Promise(r => setTimeout(r, 1500))
    const measured = await measure(engine, frames)
    dprRuns.push({ dpr, ...measured, relativePixels: +(dpr * dpr).toFixed(3) })
  }
  engine.setPixelRatioLimit(originalDpr)
  await new Promise(r => setTimeout(r, 1500))
  const restored = await measure(engine, frames)

  // frame = fixed + fragment * dpr^2, least squares over the ladder.
  const fit = (() => {
    const n = dprRuns.length
    const xs = dprRuns.map(r => r.relativePixels), ys = dprRuns.map(r => r.frameMs)
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
    const num = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0)
    const den = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0)
    const slope = den === 0 ? 0 : num / den
    return { fragmentMs: +slope.toFixed(2), fixedMs: +(my - slope * mx).toFixed(2) }
  })()

  const baselineSpread = Math.max(...baselines.map(b => b.spread))
  const baselineRange = +(Math.max(...baselines.map(b => b.frameMs)) - Math.min(...baselines.map(b => b.frameMs))).toFixed(2)
  return {
    settle: settleResult,
    baseline: baselines[0],
    baselines: baselines.map(b => b.frameMs),
    noiseFloorMs: +Math.max(baselineSpread, baselineRange).toFixed(2),
    runs: runs.sort((a, b) => b.gainMs - a.gainMs),
    dprLadder: dprRuns,
    dprFit: fit,
    dprRestored: restored.frameMs,
  }
}

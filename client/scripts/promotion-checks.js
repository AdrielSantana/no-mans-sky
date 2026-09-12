// Editor console: await (await import('/scripts/promotion-checks.js')).runPromotionAB()
//
// A/B for incremental promotion. The new path masks a partially refined patch
// per quadrant so each child appears as soon as it is built; the old one
// promoted a quad all-or-nothing. Measures the thing the player complained
// about -- how long until detail exists under them -- plus the two ways this
// change could go wrong: a hole where a masked quadrant has no child yet, and
// a frame cost from rewriting more indices.

function legacyAtomicPromotion(planet) {
  planet.collectRenderKeys = function (node, out) {
    if (!node.children) {
      if (this.chunks.has(node.key)) out.add(node.key)
      return
    }
    const childrenCovered = node.children.every(c => c.covered && this.propCoverage.get(c.key))
    if (childrenCovered) {
      for (const child of node.children) this.collectRenderKeys(child, out)
    } else if (this.chunks.has(node.key)) {
      out.add(node.key)
    } else {
      for (const child of node.children) this.collectRenderKeys(child, out)
    }
  }
}

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

export async function runPromotionAB({
  masked = true,
  targetLods = [8, 9, 10],
  loadTimeoutS = 300,
  frames = 240,
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine, planet, walker } = debug
  const gaps = await import('/scripts/flyover-checks.js?promotion=1')
  const Vector3 = engine.camera.position.constructor
  if (!walker?.isEnabled?.()) walker?.enableNearest?.()
  if (!walker?.isEnabled?.()) throw new Error('walker did not enter')

  if (masked) delete planet.collectRenderKeys
  else legacyAtomicPromotion(planet)

  const wait = ms => new Promise(r => setTimeout(r, ms))
  const nadir = new Vector3()
  const lodUnderCamera = () => {
    if (!planet.lastLocalCamPos) return -1
    nadir.copy(planet.lastLocalCamPos).normalize()
    return planet.findVisibleChunkForDirection(nadir)?.node.lod ?? -1
  }

  try {
    planet.removeAllChunks()
    const start = performance.now()
    const reached = {}
    let settledS = -1
    // Proof the change is live: without a single masked patch the run measured
    // nothing, the way an ejected walker measured the orbit view.
    let maxMaskSeen = 0, maskedPatchFrames = 0
    let worstHoles = 0, maxNeighbourStep = 0, holeSamples = 0
    let worstMap = null

    for (;;) {
      await wait(250)
      const now = performance.now()
      const lod = lodUnderCamera()
      for (const target of targetLods) {
        if (reached[target] === undefined && lod >= target) {
          reached[target] = +((now - start) / 1000).toFixed(1)
        }
      }

      let maskedNow = 0
      for (const chunk of planet.chunks.values()) {
        if (chunk.coveredQuadrants) {
          maskedNow++
          maxMaskSeen = Math.max(maxMaskSeen, chunk.coveredQuadrants)
        }
      }
      if (maskedNow > 0) maskedPatchFrames++

      try {
        const g = await gaps.probeSurfaceGaps({ halfAngleDeg: 0.35, steps: 21 })
        holeSamples++
        if (g.holes > worstHoles) { worstHoles = g.holes; worstMap = g.map }
        maxNeighbourStep = Math.max(maxNeighbourStep, g.maxNeighbourStep)
      } catch { /* no local camera yet */ }

      const drained = !planet.fallbackSphere.visible && planet.pendingKeys.size === 0
        && planet.pendingWorkerKeys.size === 0 && planet.propPrepareJobs.size === 0
        && planet.propLayers.size > 0 && engine.renderer.info.render.calls > 300
      if (drained) { settledS = +((now - start) / 1000).toFixed(1); break }
      if ((now - start) / 1000 > loadTimeoutS) break
    }

    const xs = await sampleFrames(frames)
    const mid = xs[Math.floor(xs.length / 2)]

    return {
      masked,
      maskWasLive: maxMaskSeen > 0,
      maxMaskSeen,
      maskedPatchFrames,
      reached,
      settledS,
      frameMs: +mid.toFixed(2),
      fps: +(1000 / mid).toFixed(1),
      p95: +xs[Math.floor(xs.length * 0.95)].toFixed(2),
      draws: engine.renderer.info.render.calls,
      holeSamples,
      worstHoles,
      maxNeighbourStep,
      worstMap,
      walkerHeld: walker.isEnabled(),
    }
  } finally {
    delete planet.collectRenderKeys
  }
}

// Editor console: await (await import('/scripts/flyover-checks.js')).runFlyoverBenchmark()
//
// Drives a low, fast great-circle pass over the planet and measures what the
// chunk streamer does with it. The engine loop is stopped and frames are
// stepped by hand, so a throttled or backgrounded tab cannot silently stretch
// the sample -- but each step still yields to the event loop, because terrain
// workers only deliver between frames.
//
// Two streaming variants are compared:
//   legacy  - queue never pruned, chunk keys re-parsed on every comparison
//   prune   - stale keys retired each frame, parsing still uncached
//   current - both
//
// The middle variant is what separates the two fixes. Pruning shrinks the set
// the dispatch scan walks, so a memo measured only against legacy would be
// credited with savings that belong to the smaller queue.
//
// Passes run ABAB. propScatterCache and nodeSurfaceRadiusCache survive
// removeAllChunks, so pass 2 of either variant is warmer than pass 1; reporting
// both makes that visible instead of letting it masquerade as a win.

const FRAME_MS = 1 / 60

const VARIANTS = {
  legacy: { prune: false, memo: false },
  prune: { prune: true, memo: false },
  current: { prune: true, memo: true },
}

function applyVariant(planet, { prune, memo }) {
  if (prune) delete planet.retireStalePendingKeys
  else planet.retireStalePendingKeys = () => {}
  if (memo) delete planet.parseChunkKey
  else planet.parseChunkKey = key => planet.buildChunkKeyNode(key)
}

export async function runFlyoverBenchmark({
  frames = 720,
  warmupFrames = 180,
  speed = 1400,      // metres per second along the surface
  altitude = 300,    // metres above the sampled surface
  settleMs = 16,     // real time handed back per frame, matched to 60 fps
  coverageCap = 1200,
  passes = 2,
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine: e, planet, walker } = debug
  if (planet.terrainParams.planetType === 'gas') throw new Error('Pick a terrain planet, not a gas giant')

  const Vector3 = e.camera.position.constructor
  const Quaternion = e.camera.quaternion.constructor

  const walkerTarget = walker?.isEnabled() ? walker.activeTarget : null
  const walkerDir = walkerTarget
    ? new Vector3(walker.state.localPosition.x, walker.state.localPosition.y, walker.state.localPosition.z).normalize()
    : null
  const walkerYaw = walker?.state?.yaw, walkerPitch = walker?.state?.pitch
  const originalPos = e.camera.position.clone()
  const originalQuat = e.camera.quaternion.clone()
  const originalUp = e.camera.up.clone()

  const planetPos = new Vector3()
  const planetQuat = new Quaternion()

  // Great circle through the current camera direction, so the run crosses
  // whatever terrain the editor is already looking at.
  const seed = new Vector3().copy(originalPos).sub(planet.group.getWorldPosition(new Vector3()))
  const axisA = (seed.lengthSq() > 0 ? seed : new Vector3(1, 0, 0)).normalize()
  const axisB = new Vector3(0, 1, 0).cross(axisA)
  if (axisB.lengthSq() < 1e-6) axisB.set(0, 0, 1).cross(axisA)
  axisB.normalize()

  const dirAt = (theta, target) => target
    .copy(axisA).multiplyScalar(Math.cos(theta))
    .addScaledVector(axisB, Math.sin(theta))
    .normalize()

  const scratchDir = new Vector3(), scratchAhead = new Vector3(), scratchPos = new Vector3()
  const omega = speed / Math.max(1, planet.planetRadius)   // radians per second

  const placeCamera = theta => {
    planet.group.getWorldPosition(planetPos)
    planet.group.getWorldQuaternion(planetQuat)
    const dir = dirAt(theta, scratchDir)
    const local = scratchPos.copy(dir).multiplyScalar(planet.sampleSurfaceRadius(dir) + altitude)
    e.camera.position.copy(local).applyQuaternion(planetQuat).add(planetPos)
    e.camera.up.copy(dir).applyQuaternion(planetQuat)
    const ahead = dirAt(theta + omega * 2, scratchAhead)
    e.camera.lookAt(
      ahead.multiplyScalar(planet.sampleSurfaceRadius(ahead) + altitude * 0.4)
        .applyQuaternion(planetQuat).add(planetPos),
    )
  }

  const yieldToWorkers = () => new Promise(resolve => setTimeout(resolve, settleMs))

  async function measure(label) {
    planet.removeAllChunks()

    // Chunk lifetimes expose builds that were thrown away: a chunk that lives a
    // couple of frames cost a worker slot, a geometry upload and a prop scatter
    // job for ground the camera had already left.
    let frame = 0, born = new Map(), shortLived = 0, disposals = 0
    let scanCalls = 0, scanMs = 0
    const protoCreate = Object.getPrototypeOf(planet).createChunk
    const protoDispose = Object.getPrototypeOf(planet).disposeChunk
    const protoScan = Object.getPrototypeOf(planet).findBestPendingChunkKey
    planet.createChunk = function (node, geometry) {
      const chunk = protoCreate.call(this, node, geometry)
      born.set(chunk.key, frame)
      return chunk
    }
    planet.disposeChunk = function (chunk) {
      const bornAt = born.get(chunk.key)
      if (bornAt !== undefined) {
        disposals++
        if (frame - bornAt <= 2) shortLived++
        born.delete(chunk.key)
      }
      return protoDispose.call(this, chunk)
    }
    planet.findBestPendingChunkKey = function (camPos) {
      scanCalls++
      const t0 = performance.now()
      const key = protoScan.call(this, camPos)
      scanMs += performance.now() - t0
      return key
    }

    // Hold at the start point until the quadtree actually covers the planet.
    // Measuring before that samples cold start, not a flyover: the fallback
    // sphere is still up, every chunk is the first of its face, and the queue
    // never reaches the depth a moving camera produces.
    let coverageFrames = -1
    for (let i = 0; i < coverageCap; i++) {
      placeCamera(0)
      e.frameCallback(FRAME_MS)
      await yieldToWorkers()
      if (!planet.fallbackSphere.visible) { coverageFrames = i + 1; break }
    }

    let theta = 0
    for (let i = 0; i < warmupFrames; i++) {
      placeCamera(theta); theta += omega * FRAME_MS
      e.frameCallback(FRAME_MS)
      await yieldToWorkers()
    }

    frame = 0; born = new Map(); shortLived = 0; disposals = 0; scanCalls = 0; scanMs = 0
    const samples = []
    let fallbackFrames = 0, built = 0
    for (let i = 0; i < frames; i++) {
      placeCamera(theta); theta += omega * FRAME_MS
      const t0 = performance.now()
      e.frameCallback(FRAME_MS)
      const ms = performance.now() - t0
      frame = i
      built += planet.generatedChunksLastFrame
      if (planet.fallbackSphere.visible) fallbackFrames++
      samples.push({
        ms,
        pending: planet.pendingKeys.size,
        building: planet.pendingWorkerKeys.size,
        collapses: planet.pendingCollapseKeys.size,
        chunks: planet.chunks.size,
        preparing: planet.propPrepareJobs.size,
        integrationMs: planet.chunkIntegrationMsLastFrame,
        propMs: planet.propPreparationMs,
      })
      await yieldToWorkers()
    }

    planet.createChunk = protoCreate
    planet.disposeChunk = protoDispose
    planet.findBestPendingChunkKey = protoScan
    delete planet.createChunk
    delete planet.disposeChunk
    delete planet.findBestPendingChunkKey

    const stat = key => {
      const values = samples.map(s => s[key]).sort((a, b) => a - b)
      const sum = values.reduce((n, v) => n + v, 0)
      return {
        avg: +(sum / values.length).toFixed(2),
        p95: +values[Math.floor(values.length * 0.95)].toFixed(2),
        max: +values[values.length - 1].toFixed(2),
      }
    }
    return {
      label,
      frameMs: stat('ms'),
      pending: stat('pending'),
      building: stat('building'),
      collapses: stat('collapses'),
      chunks: stat('chunks'),
      preparing: stat('preparing'),
      integrationMs: stat('integrationMs'),
      propMs: stat('propMs'),
      built,
      disposals,
      shortLivedBuilds: shortLived,
      wastedBuildPct: disposals ? +(shortLived / disposals * 100).toFixed(1) : 0,
      dispatchScanMs: +(scanMs / frames).toFixed(3),
      dispatchScanCallsPerFrame: +(scanCalls / frames).toFixed(1),
      coverageFrames,
      fallbackFrames,
    }
  }

  e.stop()
  walker?.releaseWithoutRestoringCamera?.()
  e.setOrbitControlsEnabled(false)
  const runs = []
  try {
    for (let pass = 1; pass <= passes; pass++) {
      for (const [name, flags] of Object.entries(VARIANTS)) {
        applyVariant(planet, flags)
        runs.push(await measure(`${name} p${pass}`))
      }
    }
  } finally {
    applyVariant(planet, VARIANTS.current)
    e.camera.position.copy(originalPos)
    e.camera.quaternion.copy(originalQuat)
    e.camera.up.copy(originalUp)
    e.setOrbitControlsEnabled(true)
    if (walkerTarget) {
      walker.enableAt(walkerTarget, walkerDir, walkerYaw)
      walker.state.pitch = walkerPitch
    }
    e.frameCallback(FRAME_MS)
    e.start(e.frameCallback)
  }

  const last = label => runs.filter(r => r.label.startsWith(label + ' ')).pop()
  const a = last('legacy'), p = last('prune'), b = last('current')
  const delta = (key, path) => {
    const pick = r => (path ? r[key][path] : r[key])
    const av = pick(a)
    const pct = v => (av ? +(((v - av) / av) * 100).toFixed(1) : null)
    return { legacy: av, prune: pick(p), current: pick(b), prunePct: pct(pick(p)), currentPct: pct(pick(b)) }
  }
  return {
    config: { frames, warmupFrames, speed, altitude, settleMs, passes },
    planet: { type: planet.terrainParams.planetType, radius: planet.planetRadius, workers: planet.pendingWorkerKeys.size },
    runs,
    // Read the last pass of each variant: both are equally cache-warm there.
    summary: {
      queueAvg: delta('pending', 'avg'),
      queueMax: delta('pending', 'max'),
      collapsesAvg: delta('collapses', 'avg'),
      collapsesMax: delta('collapses', 'max'),
      frameMsAvg: delta('frameMs', 'avg'),
      frameMsP95: delta('frameMs', 'p95'),
      dispatchScanMs: delta('dispatchScanMs'),
      wastedBuildPct: delta('wastedBuildPct'),
      builtTotal: delta('built'),
      fallbackFrames: delta('fallbackFrames'),
    },
  }
}

// ── Priority audit ────────────────────────────────────────────────────
//
// Answers a different question from the benchmark above: not how much the
// streamer does, but what it chooses to do first. Records, for every chunk
// built during a flyover, how long it waited between entering the queue and
// landing -- tagged with how far it was from the camera when it was queued and
// whether it sat ahead of or behind the direction of travel.
//
// If near-and-ahead chunks wait longer than far-and-behind ones, the queue is
// draining against the player.
// Restores the strictly breadth-first load set: stop at the first level whose
// four children are not all covered, never descending towards the camera.
function applyBreadthFirstLoadKeys(planet) {
  planet.collectLoadKeys = function (node, out) {
    if (!node.children) {
      if (!this.chunks.has(node.key)) out.add(node.key)
      return
    }
    const childrenCovered = node.children.every(child => child.covered)
    if (!childrenCovered) {
      if (!this.chunks.has(node.key)) out.add(node.key)
      for (const child of node.children) if (!child.covered) out.add(child.key)
      return
    }
    for (const child of node.children) this.collectLoadKeys(child, out)
  }
}

export async function runPriorityAudit({
  deepPath = true,
  frames = 600,
  warmupFrames = 180,
  speed = 1400,
  altitude = 300,
  settleMs = 16,
  coverageCap = 1200,
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine: e, planet, walker } = debug
  const { getNodeCenter } = await import('/src/game/planet/quadtree.ts')

  const Vector3 = e.camera.position.constructor
  const Quaternion = e.camera.quaternion.constructor
  const walkerTarget = walker?.isEnabled() ? walker.activeTarget : null
  const walkerDir = walkerTarget
    ? new Vector3(walker.state.localPosition.x, walker.state.localPosition.y, walker.state.localPosition.z).normalize()
    : null
  const walkerYaw = walker?.state?.yaw, walkerPitch = walker?.state?.pitch
  const originalPos = e.camera.position.clone()
  const originalQuat = e.camera.quaternion.clone()
  const originalUp = e.camera.up.clone()

  const planetPos = new Vector3(), planetQuat = new Quaternion()
  const seed = new Vector3().copy(originalPos).sub(planet.group.getWorldPosition(new Vector3()))
  const axisA = (seed.lengthSq() > 0 ? seed : new Vector3(1, 0, 0)).normalize()
  const axisB = new Vector3(0, 1, 0).cross(axisA)
  if (axisB.lengthSq() < 1e-6) axisB.set(0, 0, 1).cross(axisA)
  axisB.normalize()
  const dirAt = (theta, target) => target
    .copy(axisA).multiplyScalar(Math.cos(theta))
    .addScaledVector(axisB, Math.sin(theta)).normalize()

  const sd = new Vector3(), sa = new Vector3(), sp = new Vector3()
  const omega = speed / Math.max(1, planet.planetRadius)
  const placeCamera = theta => {
    planet.group.getWorldPosition(planetPos)
    planet.group.getWorldQuaternion(planetQuat)
    const dir = dirAt(theta, sd)
    const local = sp.copy(dir).multiplyScalar(planet.sampleSurfaceRadius(dir) + altitude)
    e.camera.position.copy(local).applyQuaternion(planetQuat).add(planetPos)
    e.camera.up.copy(dir).applyQuaternion(planetQuat)
    const ahead = dirAt(theta + omega * 2, sa)
    e.camera.lookAt(ahead.multiplyScalar(planet.sampleSurfaceRadius(ahead) + altitude * 0.4)
      .applyQuaternion(planetQuat).add(planetPos))
  }
  const yieldToWorkers = () => new Promise(r => setTimeout(r, settleMs))

  let frame = 0
  const splitAt = new Map()   // node exists in the quadtree
  const firstSeen = new Map() // node has entered pendingKeys
  const samples = []
  const protoCreate = Object.getPrototypeOf(planet).createChunk
  planet.createChunk = function (node, geometry) {
    const chunk = protoCreate.call(this, node, geometry)
    const seenAt = firstSeen.get(chunk.key)
    if (seenAt) {
      const split = splitAt.get(chunk.key)
      samples.push({
        ...seenAt,
        latency: frame - seenAt.frame,
        // Frames the node sat in the tree before collectLoadKeys would name it.
        // collectLoadKeys refuses to descend past a level until all four
        // children of a node are covered, so a deep node under the camera is
        // not requested at all until its whole ancestry quad is complete.
        gate: split === undefined ? null : seenAt.frame - split,
      })
    }
    return chunk
  }

  const walkTree = node => {
    if (!splitAt.has(node.key)) splitAt.set(node.key, frame)
    if (node.children) for (const child of node.children) walkTree(child)
  }

  const center = new Vector3(), toNode = new Vector3(), travel = new Vector3()
  const prevCam = new Vector3()
  const observe = () => {
    const cam = planet.lastLocalCamPos
    if (!cam) return
    travel.copy(cam).sub(prevCam)
    const moving = travel.lengthSq() > 1e-9
    if (moving) travel.normalize()
    prevCam.copy(cam)
    for (const key of planet.pendingKeys) {
      if (firstSeen.has(key)) continue
      const node = planet.buildChunkKeyNode(key)
      if (!node) continue
      getNodeCenter(node, center).multiplyScalar(planet.getNodeSurfaceRadius(node))
      const dist = center.distanceTo(cam)
      const along = moving ? toNode.copy(center).sub(cam).dot(travel) : 0
      firstSeen.set(key, { frame, lod: node.lod, dist, along, behind: along < 0 })
    }
  }

  e.stop()
  walker?.releaseWithoutRestoringCamera?.()
  e.setOrbitControlsEnabled(false)
  if (deepPath) delete planet.collectLoadKeys
  else applyBreadthFirstLoadKeys(planet)
  try {
    planet.removeAllChunks()
    let covered = -1
    for (let i = 0; i < coverageCap; i++) {
      placeCamera(0); e.frameCallback(1 / 60); await yieldToWorkers()
      if (!planet.fallbackSphere.visible) { covered = i + 1; break }
    }
    let theta = 0
    for (let i = 0; i < warmupFrames; i++) {
      placeCamera(theta); theta += omega / 60
      e.frameCallback(1 / 60); await yieldToWorkers()
    }
    firstSeen.clear(); samples.length = 0
    prevCam.copy(planet.lastLocalCamPos ?? prevCam)
    let fallback = 0
    // What the player actually sees: the finest visible chunk directly beneath
    // the camera, sampled every frame. Build counts do not answer this -- a run
    // can build fewer chunks and still hold finer ground, or build many and
    // hold none of them where it matters.
    const nadirLod = []
    const promotion = []
    const nadir = new Vector3()
    for (let i = 0; i < frames; i++) {
      frame = i
      placeCamera(theta); theta += omega / 60
      e.frameCallback(1 / 60)
      if (planet.lastLocalCamPos) {
        nadir.copy(planet.lastLocalCamPos).normalize()
        nadirLod.push(planet.findVisibleChunkForDirection(nadir)?.node.lod ?? -1)
      }
      // Built vs promoted, per LOD. If fine chunks exist but never turn
      // visible, the bottleneck has moved from collectLoadKeys to
      // collectRenderKeys' sibling-and-props promotion rule.
      let builtFine = 0, visibleFine = 0, visibleDeepest = -1
      for (const chunk of planet.chunks.values()) {
        if (chunk.node.lod >= 6) {
          builtFine++
          if (chunk.mesh.visible) visibleFine++
        }
        if (chunk.mesh.visible && chunk.node.lod > visibleDeepest) visibleDeepest = chunk.node.lod
      }
      promotion.push({ builtFine, visibleFine, visibleDeepest })
      if (planet.fallbackSphere.visible) fallback++
      for (const root of planet.quadtrees) walkTree(root)
      observe()
      await yieldToWorkers()
    }

    const median = xs => {
      if (!xs.length) return null
      const s = [...xs].sort((a, b) => a - b)
      return s[Math.floor(s.length / 2)]
    }
    const group = (name, pick) => {
      const hit = samples.filter(pick)
      const gates = hit.map(s => s.gate).filter(g => g !== null)
      return {
        name,
        builds: hit.length,
        gateMedian: median(gates),
        gateP90: gates.length ? [...gates].sort((a, b) => a - b)[Math.floor(gates.length * 0.9)] : null,
        latencyMedian: median(hit.map(s => s.latency)),
        latencyP90: hit.length ? [...hit.map(s => s.latency)].sort((a, b) => a - b)[Math.floor(hit.length * 0.9)] : null,
        latencyMax: hit.length ? Math.max(...hit.map(s => s.latency)) : null,
      }
    }
    const lodHistogram = {}
    for (const s of samples) {
      const bucket = (lodHistogram[s.lod] ??= { builds: 0, latencies: [] })
      bucket.builds++; bucket.latencies.push(s.latency)
    }
    for (const [lod, b] of Object.entries(lodHistogram)) {
      lodHistogram[lod] = { builds: b.builds, latencyMedian: median(b.latencies) }
    }
    return {
      config: { deepPath, frames, warmupFrames, speed, altitude, settleMs },
      coverageFrames: covered,
      fallbackFrames: fallback,
      promotion: (() => {
        const avg = key => +(promotion.reduce((n, p) => n + p[key], 0) / Math.max(1, promotion.length)).toFixed(1)
        return {
          builtFineAvg: avg('builtFine'),
          visibleFineAvg: avg('visibleFine'),
          promotedPct: avg('builtFine') ? +(avg('visibleFine') / avg('builtFine') * 100).toFixed(1) : 0,
          deepestVisibleAnywhereMax: promotion.reduce((m, p) => Math.max(m, p.visibleDeepest), -1),
        }
      })(),
      underCamera: (() => {
        const histogram = {}
        for (const lod of nadirLod) histogram[lod] = (histogram[lod] ?? 0) + 1
        const sorted = [...nadirLod].sort((a, b) => a - b)
        return {
          frames: nadirLod.length,
          median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
          p10: sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : null,
          worst: sorted.length ? sorted[0] : null,
          atLod8Plus: +(nadirLod.filter(l => l >= 8).length / Math.max(1, nadirLod.length) * 100).toFixed(1),
          histogram,
        }
      })(),
      totalBuilds: samples.length,
      byAlongTrack: [
        group('behind >600m', s => s.along < -600),
        group('behind 300-600m', s => s.along >= -600 && s.along < -300),
        group('behind 0-300m', s => s.along >= -300 && s.along < 0),
        group('ahead 0-300m', s => s.along >= 0 && s.along < 300),
        group('ahead 300-600m', s => s.along >= 300 && s.along < 600),
        group('ahead >600m', s => s.along >= 600),
      ],
      coarseNet: group('lod<=2 (safety net)', s => s.lod <= 2),
      fineNear: group('lod>=6 within 1km', s => s.lod >= 6 && s.dist < 1000),
      lodHistogram,
    }
  } finally {
    planet.createChunk = protoCreate
    delete planet.createChunk
    delete planet.collectLoadKeys
    e.camera.position.copy(originalPos)
    e.camera.quaternion.copy(originalQuat)
    e.camera.up.copy(originalUp)
    e.setOrbitControlsEnabled(true)
    if (walkerTarget) { walker.enableAt(walkerTarget, walkerDir, walkerYaw); walker.state.pitch = walkerPitch }
    e.frameCallback(1 / 60)
    e.start(e.frameCallback)
  }
}

// ── LOD reachability probe ────────────────────────────────────────────
//
// Hovers at a series of altitudes and reports the finest LOD the quadtree
// actually reaches. The split test is
//   max(0, centreDistance - boundingRadius) < lodDistances[lod + 1]
// and boundingRadius grows as (2 / 2^lod) * radius * 1.5, so the two terms are
// the same order of magnitude at fine LOD. That makes the finest reachable
// level a function of altitude rather than of the ladder alone -- which is the
// thing to know before tuning anything, because a walking player and a ship
// sit at altitudes three orders of magnitude apart.
export async function probeLodReachability({
  altitudes = [2, 60, 120, 200, 271, 300, 400, 800],
  settleFrames = 600,
  settleMs = 12,
  quietFrames = 45,
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine: e, planet, walker } = debug
  const Vector3 = e.camera.position.constructor
  const Quaternion = e.camera.quaternion.constructor

  const walkerTarget = walker?.isEnabled() ? walker.activeTarget : null
  const walkerDir = walkerTarget
    ? new Vector3(walker.state.localPosition.x, walker.state.localPosition.y, walker.state.localPosition.z).normalize()
    : null
  const walkerYaw = walker?.state?.yaw, walkerPitch = walker?.state?.pitch
  const originalPos = e.camera.position.clone()
  const originalQuat = e.camera.quaternion.clone()
  const originalUp = e.camera.up.clone()

  const planetPos = new Vector3(), planetQuat = new Quaternion()
  const seed = new Vector3().copy(originalPos).sub(planet.group.getWorldPosition(new Vector3()))
  const dir = (seed.lengthSq() > 0 ? seed : new Vector3(1, 0, 0)).normalize()

  e.stop()
  walker?.releaseWithoutRestoringCamera?.()
  e.setOrbitControlsEnabled(false)
  const rows = []
  try {
    for (const altitude of altitudes) {
      planet.removeAllChunks()
      planet.group.getWorldPosition(planetPos)
      planet.group.getWorldQuaternion(planetQuat)
      const surface = planet.sampleSurfaceRadius(dir)
      e.camera.position.copy(dir).multiplyScalar(surface + altitude).applyQuaternion(planetQuat).add(planetPos)
      e.camera.up.copy(dir).applyQuaternion(planetQuat)

      let quiet = 0, frames = 0, covered = -1
      for (let i = 0; i < settleFrames; i++) {
        const before = planet.chunks.size
        e.frameCallback(1 / 60)
        await new Promise(r => setTimeout(r, settleMs))
        frames++
        if (covered < 0 && !planet.fallbackSphere.visible) covered = frames
        quiet = planet.chunks.size === before && planet.pendingKeys.size === 0 && planet.pendingWorkerKeys.size === 0
          ? quiet + 1 : 0
        if (quiet >= quietFrames && covered > 0) break
      }

      const stats = planet.getDebugStats(e.camera)
      const lods = Object.keys(stats.byLod).map(Number).filter(l => stats.byLod[l] > 0)
      rows.push({
        altitude,
        finestLod: lods.length ? Math.max(...lods) : null,
        splitDistanceAtFinest: lods.length ? Math.round(planet.lodDistances[Math.max(...lods)] ?? -1) : null,
        chunks: planet.chunks.size,
        framesToCoverage: covered,
        framesToSettle: frames,
        byLod: stats.byLod,
      })
    }
    return { maxLod: planet.maxLod, radius: planet.planetRadius, rows }
  } finally {
    e.camera.position.copy(originalPos)
    e.camera.quaternion.copy(originalQuat)
    e.camera.up.copy(originalUp)
    e.setOrbitControlsEnabled(true)
    if (walkerTarget) { walker.enableAt(walkerTarget, walkerDir, walkerYaw); walker.state.pitch = walkerPitch }
    e.frameCallback(1 / 60)
    e.start(e.frameCallback)
  }
}

// ── Ladder descent timeline ───────────────────────────────────────────
//
// Parks the camera and records, frame by frame, the finest LOD that has any
// built chunk. With a stationary camera the quadtree splits to its target depth
// in a single pass, so every frame after the first is spent purely filling the
// load set -- which makes this a direct read of how long collectLoadKeys takes
// to walk down the ladder one level at a time.
export async function probeLadderDescent({
  deepPath = true,
  altitude = 2,
  frames = 2400,
  settleMs = 10,
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine: e, planet, walker } = debug
  const Vector3 = e.camera.position.constructor
  const Quaternion = e.camera.quaternion.constructor
  const walkerTarget = walker?.isEnabled() ? walker.activeTarget : null
  const walkerDir = walkerTarget
    ? new Vector3(walker.state.localPosition.x, walker.state.localPosition.y, walker.state.localPosition.z).normalize()
    : null
  const walkerYaw = walker?.state?.yaw, walkerPitch = walker?.state?.pitch
  const originalPos = e.camera.position.clone()
  const originalQuat = e.camera.quaternion.clone()
  const originalUp = e.camera.up.clone()
  const planetPos = new Vector3(), planetQuat = new Quaternion()
  const seed = new Vector3().copy(originalPos).sub(planet.group.getWorldPosition(new Vector3()))
  const dir = (seed.lengthSq() > 0 ? seed : new Vector3(1, 0, 0)).normalize()

  e.stop()
  walker?.releaseWithoutRestoringCamera?.()
  e.setOrbitControlsEnabled(false)
  if (deepPath) delete planet.collectLoadKeys
  else applyBreadthFirstLoadKeys(planet)
  try {
    planet.removeAllChunks()
    planet.group.getWorldPosition(planetPos)
    planet.group.getWorldQuaternion(planetQuat)
    const surface = planet.sampleSurfaceRadius(dir)
    e.camera.position.copy(dir).multiplyScalar(surface + altitude).applyQuaternion(planetQuat).add(planetPos)
    e.camera.up.copy(dir).applyQuaternion(planetQuat)

    const reachedAt = {}
    let deepestNode = 0
    const timeline = []
    for (let i = 0; i < frames; i++) {
      e.frameCallback(1 / 60)
      await new Promise(r => setTimeout(r, settleMs))
      let finestBuilt = -1
      for (const chunk of planet.chunks.values()) {
        if (chunk.node.lod > finestBuilt) finestBuilt = chunk.node.lod
      }
      if (finestBuilt >= 0 && reachedAt[finestBuilt] === undefined) reachedAt[finestBuilt] = i + 1
      const walk = node => {
        if (node.lod > deepestNode) deepestNode = node.lod
        if (node.children) for (const c of node.children) walk(c)
      }
      for (const root of planet.quadtrees) walk(root)
      if (i % 100 === 0) {
        timeline.push({ frame: i, finestBuilt, chunks: planet.chunks.size, pending: planet.pendingKeys.size })
      }
      if (finestBuilt >= planet.maxLod) break
    }
    return {
      deepPath,
      altitude,
      maxLod: planet.maxLod,
      deepestNodeInTree: deepestNode,
      reachedAt,
      timeline,
    }
  } finally {
    delete planet.collectLoadKeys
    e.camera.position.copy(originalPos)
    e.camera.quaternion.copy(originalQuat)
    e.camera.up.copy(originalUp)
    e.setOrbitControlsEnabled(true)
    if (walkerTarget) { walker.enableAt(walkerTarget, walkerDir, walkerYaw); walker.state.pitch = walkerPitch }
    e.frameCallback(1 / 60)
    e.start(e.frameCallback)
  }
}

// ── Surface gap detector ──────────────────────────────────────────────
//
// Maps a grid of directions around the camera's nadir and asks, for each one,
// which visible chunk covers it. A direction with no visible chunk is a hole in
// the rendered surface; a direction covered at a far coarser LOD than its
// neighbour is a seam. Both read to a player as "this side loaded and that side
// did not", so the map distinguishes them instead of guessing which it was.
//
// halfAngleDeg is in surface arc: on a 25 km radius, 1 degree is ~436 m, and a
// lod-9 node is ~98 m across, so the default spans a few nodes either way.
export async function probeSurfaceGaps({ halfAngleDeg = 1.2, steps = 41 } = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine: e, planet } = debug
  const Vector3 = e.camera.position.constructor

  const cam = planet.lastLocalCamPos
  if (!cam || cam.lengthSq() === 0) throw new Error('No local camera position yet')

  const up = new Vector3().copy(cam).normalize()
  const tangentA = new Vector3(0, 1, 0).cross(up)
  if (tangentA.lengthSq() < 1e-6) tangentA.set(1, 0, 0).cross(up)
  tangentA.normalize()
  const tangentB = new Vector3().crossVectors(up, tangentA).normalize()

  const half = (halfAngleDeg * Math.PI) / 180
  const dir = new Vector3()
  const grid = []
  const histogram = {}
  let holes = 0, sampled = 0

  for (let j = 0; j < steps; j++) {
    const row = []
    for (let i = 0; i < steps; i++) {
      const a = ((i / (steps - 1)) * 2 - 1) * half
      const b = ((j / (steps - 1)) * 2 - 1) * half
      dir.copy(up).addScaledVector(tangentA, Math.tan(a)).addScaledVector(tangentB, Math.tan(b)).normalize()
      const chunk = planet.findVisibleChunkForDirection(dir)
      const lod = chunk ? chunk.node.lod : -1
      row.push(lod)
      sampled++
      if (lod < 0) holes++
      histogram[lod] = (histogram[lod] ?? 0) + 1
    }
    grid.push(row)
  }

  const lods = Object.keys(histogram).map(Number).filter(l => l >= 0)
  const finest = lods.length ? Math.max(...lods) : null
  const coarsest = lods.length ? Math.min(...lods) : null
  // Largest LOD step between horizontally or vertically adjacent samples: a
  // refinement boundary is 1, and anything much larger is a visible seam.
  let maxNeighbourStep = 0
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      for (const [dj, di] of [[0, 1], [1, 0]]) {
        const other = grid[j + dj]?.[i + di]
        if (other === undefined) continue
        if (grid[j][i] < 0 || other < 0) continue
        maxNeighbourStep = Math.max(maxNeighbourStep, Math.abs(grid[j][i] - other))
      }
    }
  }

  return {
    arcMetres: +(2 * Math.tan(half) * cam.length()).toFixed(0),
    sampled,
    holes,
    holePct: +((holes / sampled) * 100).toFixed(1),
    finest,
    coarsest,
    lodSpread: finest !== null ? finest - coarsest : null,
    maxNeighbourStep,
    histogram,
    // '.' = hole, otherwise the LOD digit, so the spatial pattern is readable.
    map: grid.map(row => row.map(l => (l < 0 ? '.' : l.toString(36))).join('')),
  }
}

// ── Per-chunk vegetation coverage ─────────────────────────────────────
//
// Props and grass are attached per chunk, so a chunk that has its layer next to
// one that does not shows trees and grass stopping along a dead straight line
// on the node boundary -- "one side loaded, the other did not". That reads as a
// terrain problem but is not one: the terrain underneath is continuous.
//
// Reports, for the chunks covering a grid of directions around the camera,
// whether each one owns the layers it is supposed to own.
export async function probeVegetationCoverage({ halfAngleDeg = 1.0, steps = 31 } = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine: e, planet } = debug
  const Vector3 = e.camera.position.constructor

  const cam = planet.lastLocalCamPos
  if (!cam || cam.lengthSq() === 0) throw new Error('No local camera position yet')

  const up = new Vector3().copy(cam).normalize()
  const tangentA = new Vector3(0, 1, 0).cross(up)
  if (tangentA.lengthSq() < 1e-6) tangentA.set(1, 0, 0).cross(up)
  tangentA.normalize()
  const tangentB = new Vector3().crossVectors(up, tangentA).normalize()

  const half = (halfAngleDeg * Math.PI) / 180
  const dir = new Vector3()
  const rows = []
  const seen = new Map()

  for (let j = 0; j < steps; j++) {
    let row = ''
    for (let i = 0; i < steps; i++) {
      const a = ((i / (steps - 1)) * 2 - 1) * half
      const b = ((j / (steps - 1)) * 2 - 1) * half
      dir.copy(up).addScaledVector(tangentA, Math.tan(a)).addScaledVector(tangentB, Math.tan(b)).normalize()
      const chunk = planet.findVisibleChunkForDirection(dir)
      if (!chunk) { row += '.'; continue }

      const wantsProps = planet.shouldHavePropLayer(chunk)
      const hasProps = planet.propLayers.has(chunk.key)
      const preparing = planet.propPrepareJobs.has(chunk.key)
      const hasGrass = planet.grassLayers.has(chunk.key) || planet.farGrassLayers.has(chunk.key)

      // P = has what it wants, p = wants props and is still preparing them,
      // X = wants props, is not preparing, and does not have them (stuck),
      // g = no props wanted, grass present, - = nothing wanted
      const symbol = !wantsProps ? (hasGrass ? 'g' : '-')
        : hasProps ? 'P'
          : preparing ? 'p' : 'X'
      row += symbol
      if (!seen.has(chunk.key)) {
        seen.set(chunk.key, { lod: chunk.node.lod, wantsProps, hasProps, preparing, hasGrass })
      }
    }
    rows.push(row)
  }

  const chunks = [...seen.values()]
  const wanting = chunks.filter(c => c.wantsProps)
  return {
    arcMetres: +(2 * Math.tan(half) * cam.length()).toFixed(0),
    chunksCovering: chunks.length,
    wantProps: wanting.length,
    haveProps: wanting.filter(c => c.hasProps).length,
    preparing: wanting.filter(c => !c.hasProps && c.preparing).length,
    // Wants props, has none, and nothing is working on it.
    stuck: wanting.filter(c => !c.hasProps && !c.preparing).length,
    withGrass: chunks.filter(c => c.hasGrass).length,
    propQueueTotal: planet.propPrepareJobs.size,
    map: rows,
  }
}

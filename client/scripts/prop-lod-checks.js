// Editor console: await (await import('/scripts/prop-lod-checks.js')).runPropLodChecks()
import { PlanetPropLayer, MAX_PROP_SCATTER_CACHE_ENTRIES } from '../src/game/planet/planet-props'

export function runPropLodChecks() {
  const { planet } = window.__nmsEditorDebug
  const model = (id, kind) => ({ id, kind, heightRange: kind === 'tree' ? [6, 13] : [1, 5], width: 1, parts: [] })
  const node = (lod, x, y) => ({ face: 4, lod, x, y, key: `4_${lod}_${x}_${y}`, children: null, covered: true })
  const params = { node: node(8, 112, 179), terrain: planet.terrainParams, seed: 67, seaHeight: -.054, planetType: 'rocky', scatterCache: new Map(), settings: { enabled: true, treeDensity: 1, rockDensity: 1, distance: 2200 }, assets: { trees: [model('oak', 'tree'), model('pine', 'tree')], rocks: [model('rock', 'rock')] } }
  const results = []
  const check = (name, pass, evidence) => { results.push({ name, passed: !!pass, evidence }); if (!pass) throw new Error(JSON.stringify(results)) }
  const drain = steps => { let yields = 0, result = steps.next(); while (!result.done) { yields++; result = steps.next() } return { yields, placements: result.value } }
  const records = placements => new Map(placements.flatMap(p => p.matrices.map((m, i) => [
    `${p.model.id}:${p.scatterUv[i * 2]}:${p.scatterUv[i * 2 + 1]}`,
    [...m.elements],
  ])))
  const build = p => drain(PlanetPropLayer.preparePlacements(p))
  const start = performance.now()
  const parent = build(params), original = records(parent.placements)
  check('Nonempty fixture and incremental work', original.size > 0 && parent.yields > 50, { count: original.size, yields: parent.yields })
  let inherited = 0, added = 0
  const children = []
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const child = node(9, params.node.x * 2 + x, params.node.y * 2 + y)
    const placements = build({ ...params, node: child }).placements
    const current = records(placements)
    for (const [key, matrix] of current) {
      if (original.has(key)) { inherited++; check('Inherited transform is bit-identical', JSON.stringify(matrix) === JSON.stringify(original.get(key))) }
      else added++
    }
    children.push({ child, current })
    check('Instance ceilings include inherited props', placements.filter(p => p.model.kind === 'tree').reduce((n,p) => n + p.matrices.length, 0) <= 34 && placements.filter(p => p.model.kind === 'rock').reduce((n,p) => n + p.matrices.length, 0) <= 48)
  }
  check('Every parent prop belongs to exactly one child', inherited === original.size, { inherited, added })
  for (const { child, current } of children) {
    const all = new Map()
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      for (const [key, matrix] of records(build({ ...params, node: node(10, child.x * 2 + x, child.y * 2 + y) }).placements)) {
        check('No duplicate ownership in grandchildren', !all.has(key))
        all.set(key, matrix)
      }
    }
    check('Second refinement preserves all transforms', [...current].every(([k,m]) => JSON.stringify(all.get(k)) === JSON.stringify(m)))
  }
  check('Coarsening restores exact parent', JSON.stringify([...records(build(params).placements)]) === JSON.stringify([...original]))
  params.scatterCache.clear()
  check('Cache eviction does not change the world', JSON.stringify([...records(build(params).placements)]) === JSON.stringify([...original]))
  check('Geometry resolution does not affect anchors', JSON.stringify([...records(build({ ...params, scatterCache: new Map(), surface: { gridSize: 5, positions: new Float32Array(75) } }).placements)]) === JSON.stringify([...original]))
  for (let i = 0; i < MAX_PROP_SCATTER_CACHE_ENTRIES; i++) params.scatterCache.set(`evict-${i}`, [])
  build({ ...params, node: node(8, 113, 179) })
  check('CPU cache remains bounded', params.scatterCache.size <= MAX_PROP_SCATTER_CACHE_ENTRIES, params.scatterCache.size)
  const first = build(params).placements, second = build(params).placements
  if (first.length) {
    first[0].sunLight.fill(0)
    check('Lighting buffers belong to each layer', second[0].sunLight.every(v => v === 1))
  }

  const scheduler = Object.create(Object.getPrototypeOf(planet))
  const root = node(8, 112, 179)
  root.children = children.map(({ child }) => child)
  scheduler.chunks = new Map([[root.key, {}], ...root.children.map(n => [n.key, {}])])
  scheduler.pendingCollapseKeys = new Set()
  scheduler.propCoverage = new Map(root.children.map((n, i) => [n.key, i !== 3]))
  let visible = new Set(), retained = new Set()
  scheduler.collectRenderKeys(root, visible); scheduler.collectRetainKeys(root, retained)
  check('Keep parent while child props are preparing', visible.size === 1 && visible.has(root.key) && retained.has(root.key))
  root.children.forEach(n => scheduler.propCoverage.set(n.key, true))
  visible = new Set(); scheduler.collectRenderKeys(root, visible)
  check('Promote all siblings together when ready', visible.size === 4 && !visible.has(root.key))
  scheduler.pendingCollapseKeys = new Set([root.key])
  let removed = false, ready = false
  scheduler.isPropReady = () => ready
  scheduler.removeChildrenChunks = () => { removed = true }
  scheduler.applyPendingCollapses(root)
  check('Coarsening waits for parent props', !removed && root.children !== null)
  retained = new Set(); scheduler.collectRetainKeys(root, retained)
  check('Keep a preparing collapse target while children still cover it', retained.has(root.key))
  ready = true; scheduler.applyPendingCollapses(root)
  check('Coarsening commits when parent is ready', removed && root.children === null)
  return { passed: results.length, ms: performance.now() - start, parentProps: original.size, inherited, added, summary: results.filter(r => r.name !== 'Inherited transform is bit-identical' && r.name !== 'No duplicate ownership in grandchildren') }
}

// Camera excursion through the actual renderer, including async preparation,
// terrain promotion/coarsening, GPU model LOD and return to walking mode.
export async function runLivePropLodCheck() {
  const { engine: e, planet, walker } = window.__nmsEditorDebug
  if (!walker.isEnabled()) throw new Error('Enter walking mode first')
  const target = walker.activeTarget
  const Vector3 = e.camera.position.constructor
  const direction = new Vector3(walker.state.localPosition.x, walker.state.localPosition.y, walker.state.localPosition.z).normalize()
  const yaw = walker.state.yaw, pitch = walker.state.pitch
  const originalCamera = e.camera.position.clone(), originalRotation = e.camera.quaternion.clone(), originalUp = e.camera.up.clone()
  const seen = new Map()
  let transfers = 0, checks = 0
  const capture = () => {
    let count = 0
    for (const [owner, layer] of planet.propLayers) {
      if (!layer.group.visible || !layer.group.parent?.visible) continue
      // Model simplification must not change instance transforms either.
      const matrices = () => layer.meshEntries.map(entry => Array.from(entry.mesh.instanceMatrix.array))
      const before = JSON.stringify(matrices()), tier = layer.lodTierIndex
      layer.setLodTier(3); layer.setLodTier(tier)
      if (JSON.stringify(matrices()) !== before) throw new Error('Model LOD changed an instance transform')
      for (const p of layer.placements) for (let i = 0; i < p.matrices.length; i++) {
        const id = `${p.model.id}:${p.scatterUv[i * 2]}:${p.scatterUv[i * 2 + 1]}`
        const matrix = JSON.stringify(p.matrices[i].elements)
        const previous = seen.get(id)
        if (previous) {
          checks++
          if (previous.matrix !== matrix) throw new Error(`Prop moved: ${id}`)
          if (previous.owner !== owner) transfers++
        }
        seen.set(id, { matrix, owner }); count++
      }
    }
    return { count, lods: planet.getDebugStats(e.camera).byLod, preparing: planet.propPrepareJobs.size }
  }
  const settle = async frames => {
    for (let i = 0; i < frames; i++) {
      e.frameCallback(1 / 60)
      if (i % 60 === 0) e.composer.render()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  e.stop()
  try {
    const before = capture()
    walker.releaseWithoutRestoringCamera()
    e.setOrbitControlsEnabled(false)
    e.camera.position.copy(originalCamera).addScaledVector(originalUp, Math.min(750, planet.propSettings.distance * 0.4))
    e.camera.up.copy(originalUp)
    e.camera.lookAt(originalCamera)
    await settle(900)
    const far = capture()
    e.camera.position.copy(originalCamera); e.camera.quaternion.copy(originalRotation)
    await settle(1400)
    const returned = capture()
    if (checks === 0 || transfers === 0 || JSON.stringify(before.lods) === JSON.stringify(far.lods)) throw new Error(JSON.stringify({ message: 'Excursion did not exercise a prop ownership transition', checks, transfers, before, far, returned }))
    return { checks, transfers, changedTransforms: 0, before, far, returned, shaderErrors: e.renderer.info.programs.filter(p => p.diagnostics && !p.diagnostics.runnable).length }
  } finally {
    walker.enableAt(target, direction, yaw)
    walker.state.pitch = pitch
    e.frameCallback(1 / 60)
    e.start(e.frameCallback)
  }
}

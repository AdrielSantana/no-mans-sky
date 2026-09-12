// Editor console: await (await import('/scripts/mask-index-checks.js')).runMaskIndexChecks()
//
// Deterministic correctness test for quadrant masking. Reads the index buffer
// that is actually drawn (respecting drawRange) and checks the set algebra:
// masking a quadrant must remove exactly that quadrant's triangles and nothing
// else, and the four single-quadrant masks must partition the full patch.
//
// No frame timing here on purpose. This has to be answerable on a loaded
// machine, and "did it draw the right triangles" is not a question timing can
// answer anyway.

const QUADRANT_NAMES = ['u0v0', 'u1v0', 'u0v1', 'u1v1']

function drawnTriangles(chunk) {
  const geometry = chunk.mesh.geometry
  const index = geometry.index
  const { start, count } = geometry.drawRange
  const array = index.array
  const out = new Set()
  const end = Math.min(start + count, array.length)
  for (let i = start; i + 2 < end; i += 3) {
    out.add(`${array[i]},${array[i + 1]},${array[i + 2]}`)
  }
  return out
}

// The quadrant of the cell a triangle belongs to, from its three vertices.
//
// Must be the minimum corner, not the first listed one: a grid cell emits
// (a, b, c) and (b, d, c), so the second triangle starts at v(x + 1, y) -- one
// column right of its own cell. Classifying by that vertex puts the second
// triangle of the cell at x == half - 1 in the upper half and reports a
// correct mask as broken, which is exactly what a first version of this test
// did.
function cellQuadrant(vertexIndices, gridSize) {
  const half = (gridSize - 1) >> 1
  let minX = Infinity, minY = Infinity
  for (const vertexIndex of vertexIndices) {
    minX = Math.min(minX, vertexIndex % gridSize)
    minY = Math.min(minY, Math.floor(vertexIndex / gridSize))
  }
  return ((minY < half ? 0 : 1) << 1) | (minX < half ? 0 : 1)
}

const triangleVertices = key => key.split(',').map(Number)

export function runMaskIndexChecks() {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { planet } = debug

  // A patch with children is the only one masking ever applies to; any built
  // chunk exercises the index path identically, so pick the first with no
  // stitching so the baseline is the unmasked full index.
  const chunk = [...planet.chunks.values()].find(c =>
    c.stitchSteps.bottom === 0 && c.stitchSteps.top === 0
    && c.stitchSteps.left === 0 && c.stitchSteps.right === 0)
  if (!chunk) throw new Error('no unstitched chunk to test')

  const gridSize = planet.gridSize
  const results = []
  const check = (name, passed, evidence) => results.push({ name, passed, evidence })

  const noStitch = { bottom: 0, top: 0, left: 0, right: 0 }
  chunk.setStitchSteps(noStitch, 0)
  const full = drawnTriangles(chunk)
  check('baseline patch draws triangles', full.size > 0, full.size)

  const perQuadrant = []
  for (let bit = 0; bit < 4; bit++) {
    chunk.setStitchSteps(noStitch, 1 << bit)
    const drawn = drawnTriangles(chunk)
    const removed = [...full].filter(t => !drawn.has(t))
    const added = [...drawn].filter(t => !full.has(t))
    perQuadrant.push(new Set(removed))

    check(`mask ${QUADRANT_NAMES[bit]} adds nothing`, added.length === 0, added.length)
    check(`mask ${QUADRANT_NAMES[bit]} removes something`, removed.length > 0, removed.length)
    // Every removed triangle must sit in the masked quadrant, and no kept one
    // may: that is the whole contract.
    const strayRemoved = removed.filter(t => cellQuadrant(triangleVertices(t), gridSize) !== bit)
    check(`mask ${QUADRANT_NAMES[bit]} removes only its own quadrant`, strayRemoved.length === 0, strayRemoved.slice(0, 4))
    const keptInQuadrant = [...drawn].filter(t => cellQuadrant(triangleVertices(t), gridSize) === bit)
    check(`mask ${QUADRANT_NAMES[bit]} keeps none of its quadrant`, keptInQuadrant.length === 0, keptInQuadrant.slice(0, 4))
  }

  // The four quadrants must tile the patch: disjoint, and together everything.
  let overlap = 0
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      for (const t of perQuadrant[a]) if (perQuadrant[b].has(t)) overlap++
    }
  }
  check('quadrants are disjoint', overlap === 0, overlap)
  const union = new Set()
  for (const set of perQuadrant) for (const t of set) union.add(t)
  check('quadrants cover the whole patch', union.size === full.size, { union: union.size, full: full.size })

  // All four masked at once must draw nothing, which is what a fully promoted
  // quad needs so the parent stops painting over its children.
  chunk.setStitchSteps(noStitch, 0b1111)
  check('all four masked draws nothing', drawnTriangles(chunk).size === 0, drawnTriangles(chunk).size)

  // And it has to come back, because a patch is re-masked every frame as
  // children appear and disappear.
  chunk.setStitchSteps(noStitch, 0)
  const restored = drawnTriangles(chunk)
  check('unmasking restores the full patch', restored.size === full.size
    && [...full].every(t => restored.has(t)), { restored: restored.size, full: full.size })

  // Masking combined with stitching: the fans must not reappear inside a
  // masked quadrant.
  const stitched = { bottom: 2, top: 0, left: 0, right: 0 }
  chunk.setStitchSteps(stitched, 0)
  const stitchedFull = drawnTriangles(chunk)
  chunk.setStitchSteps(stitched, 0b0001)
  const stitchedMasked = drawnTriangles(chunk)
  const stitchStray = [...stitchedMasked].filter(t => cellQuadrant(triangleVertices(t), gridSize) === 0)
  check('stitched + masked leaves no fan in the masked quadrant', stitchStray.length === 0, stitchStray.slice(0, 4))
  check('stitched + masked removes triangles', stitchedMasked.size < stitchedFull.size,
    { masked: stitchedMasked.size, full: stitchedFull.size })

  chunk.setStitchSteps(noStitch, 0)

  return {
    chunkKey: chunk.key,
    gridSize,
    fullTriangles: full.size,
    failed: results.filter(r => !r.passed),
    passed: results.filter(r => r.passed).length,
    total: results.length,
  }
}

// ── Stitch probe against masked patches ───────────────────────────────
//
// The index test above proves a masked patch draws the right triangles. It says
// nothing about whether its neighbours are told the right thing, and that is
// where the first version broke: rebuildStitchSets registered a masked patch as
// covering its whole area, so a child whose neighbour was really a promoted
// sibling at the same LOD was told to coarsen its edge against it. Coarsening
// one side of a matched pair opens a crack, which is what showed up on screen
// as holes along chunk edges.
//
// Drives the probe on a stub scheduler, the way prop-lod-checks does, so no
// real chunks, walker or settled scene are needed.
export function runStitchMaskChecks() {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { planet } = debug

  const FACE = 4, PARENT_LOD = 5, PX = 10, PY = 10
  const node = (lod, x, y) => ({ face: FACE, lod, x, y, key: `${FACE}_${lod}_${x}_${y}`, children: null, covered: true })
  const parent = node(PARENT_LOD, PX, PY)
  // Child i sits at (PX * 2 + (i & 1), PY * 2 + (i >> 1)), matching createChildren.
  const child = i => node(PARENT_LOD + 1, PX * 2 + (i & 1), PY * 2 + (i >> 1))

  const scheduler = Object.create(Object.getPrototypeOf(planet))
  scheduler.maxLod = planet.maxLod
  scheduler.skirts = true
  scheduler.stitchSets = []
  scheduler.stitchMasks = []
  scheduler.horizonMargin = planet.horizonMargin

  const results = []
  const check = (name, passed, evidence) => results.push({ name, passed, evidence })

  const probe = (mask, promoted) => {
    const keys = [parent.key, ...promoted.map(i => child(i).key)]
    scheduler.chunks = new Map([
      [parent.key, { node: parent }],
      ...promoted.map(i => [child(i).key, { node: child(i) }]),
    ])
    scheduler.renderQuadrantMasks = new Map(mask ? [[parent.key, mask]] : [])
    scheduler.rebuildStitchSets(new Set(keys))
    return steps => ({ ...scheduler.computeVisibleStitchSteps(steps) })
  }

  // Only quadrant 0 promoted: its +u neighbour is the parent's own drawn area,
  // one level coarser, so that edge must coarsen (step 2).
  let stepsFor = probe(0b0001, [0])
  const aloneRight = stepsFor(child(0)).right
  check('child bordering the drawn parent coarsens', aloneRight === 2, aloneRight)

  // Quadrants 0 and 1 both promoted: the +u neighbour is now a sibling at the
  // same LOD, so that edge must NOT coarsen. This is the regression.
  stepsFor = probe(0b0011, [0, 1])
  const pairRight = stepsFor(child(0)).right
  check('child bordering a promoted sibling does not coarsen', pairRight === 0, pairRight)
  // Its other inner edge still faces the parent's drawn half.
  const pairTop = stepsFor(child(0)).top
  check('the same child still coarsens towards the drawn parent', pairTop === 2, pairTop)

  // All four promoted: no inner edge faces the parent at all.
  stepsFor = probe(0b1111, [0, 1, 2, 3])
  const allRight = stepsFor(child(0)).right
  const allTop = stepsFor(child(0)).top
  check('fully promoted quad has no inner coarsening', allRight === 0 && allTop === 0, { allRight, allTop })

  // Unmasked parent, no children drawn: nothing to coarsen against inside it.
  stepsFor = probe(0, [])
  const bare = stepsFor(parent)
  check('an unmasked parent is unaffected',
    bare.top === 0 && bare.bottom === 0 && bare.left === 0 && bare.right === 0, bare)

  return { failed: results.filter(r => !r.passed), passed: results.filter(r => r.passed).length, total: results.length }
}

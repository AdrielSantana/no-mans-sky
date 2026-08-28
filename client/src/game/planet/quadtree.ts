import * as THREE from 'three'

// ── Cube face indices ─────────────────────────────────────
export const CubeFace = {
  PX: 0, // +X
  NX: 1, // -X
  PY: 2, // +Y
  NY: 3, // -Y
  PZ: 4, // +Z
  NZ: 5, // -Z
} as const

export type CubeFace = (typeof CubeFace)[keyof typeof CubeFace]

export const NUM_FACES = 6

// ── Quadtree node ─────────────────────────────────────────
export interface QuadtreeNode {
  face: CubeFace
  lod: number // 0 = coarsest
  x: number // 0..2^lod - 1
  y: number // 0..2^lod - 1
  children: QuadtreeNode[] | null // null = leaf
  // Cached `nodeKey(face, lod, x, y)`. The identity of a node never changes, so
  // building this string once at creation removes tens of thousands of
  // temporary strings per frame from the LOD traversal.
  key: string
  // Whether this node's area is fully covered by built chunks — either its own
  // chunk exists, or every descendant is covered. Recomputed once per frame by
  // PlanetRenderer.markCovered instead of being re-derived independently by
  // each of the four traversals that need it.
  covered: boolean
}

// ── LOD distance thresholds ───────────────────────────────
// Multiplied by planet radius to get actual threshold.
// Multiplied by planet radius. Tuned for compact playable planets whose
// radius is in the hundreds of meters, while still allowing human-scale LOD.
export const LOD_DISTANCE_MULTIPLIERS = [
  Infinity, // LOD 0: always shown
  5.5,      // LOD 1: transition from fallback sphere
  3.0,      // LOD 2
  1.55,     // LOD 3
  0.78,     // LOD 4
  0.38,     // LOD 5
  0.18,     // LOD 6
  0.085,    // LOD 7
]

export const MAX_LOD = LOD_DISTANCE_MULTIPLIERS.length - 1

// ── Cube-to-sphere mapping ────────────────────────────────
// Maps (face, u, v) where u,v ∈ [-1,1] to a point on the unit sphere
// Writes into `target` when given one. The previous version kept a module
// scratch and then returned `_v.clone()`, which defeated the scratch entirely:
// getNodeCenter is called four times per node per frame on the hot LOD path.
export function cubeToSphere(
  face: CubeFace,
  u: number,
  v: number,
  target: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  switch (face) {
    case CubeFace.PX: target.set(1, v, u); break
    case CubeFace.NX: target.set(-1, v, -u); break
    case CubeFace.PY: target.set(u, 1, v); break
    case CubeFace.NY: target.set(u, -1, -v); break
    case CubeFace.PZ: target.set(u, v, 1); break
    case CubeFace.NZ: target.set(-u, v, -1); break
  }
  return target.normalize()
}

// Get the 4 corners of a quadtree node on its cube face
// Returns u,v bounds in [-1,1] space
export function getNodeBounds(node: QuadtreeNode): { u0: number; v0: number; u1: number; v1: number } {
  const size = 1 / (1 << node.lod)
  const u0 = node.x * size * 2 - 1
  const v0 = node.y * size * 2 - 1
  const u1 = (node.x + 1) * size * 2 - 1
  const v1 = (node.y + 1) * size * 2 - 1
  return { u0, v0, u1, v1 }
}

// Get center of a node on the unit sphere. Derives u,v directly rather than
// going through getNodeBounds, which allocated a bounds object per call.
export function getNodeCenter(
  node: QuadtreeNode,
  target: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const size = 1 / (1 << node.lod)
  const u = (node.x * 2 + 1) * size - 1
  const v = (node.y * 2 + 1) * size - 1
  return cubeToSphere(node.face, u, v, target)
}

// ── Quadtree operations ───────────────────────────────────

export function createRoot(face: CubeFace): QuadtreeNode {
  return { face, lod: 0, x: 0, y: 0, children: null, key: nodeKey(face, 0, 0, 0), covered: false }
}

export function createChildren(node: QuadtreeNode): QuadtreeNode[] {
  const childLod = node.lod + 1
  const cx = node.x * 2
  const cy = node.y * 2
  const face = node.face
  return [
    { face, lod: childLod, x: cx,     y: cy,     children: null, key: nodeKey(face, childLod, cx,     cy),     covered: false },
    { face, lod: childLod, x: cx + 1, y: cy,     children: null, key: nodeKey(face, childLod, cx + 1, cy),     covered: false },
    { face, lod: childLod, x: cx,     y: cy + 1, children: null, key: nodeKey(face, childLod, cx,     cy + 1), covered: false },
    { face, lod: childLod, x: cx + 1, y: cy + 1, children: null, key: nodeKey(face, childLod, cx + 1, cy + 1), covered: false },
  ]
}

// Unique key for a quadtree node
export function nodeKey(face: CubeFace, lod: number, x: number, y: number): string {
  return `${face}_${lod}_${x}_${y}`
}

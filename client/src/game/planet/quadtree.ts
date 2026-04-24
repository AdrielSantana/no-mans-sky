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
}

// ── LOD distance thresholds ───────────────────────────────
// Multiplied by planet radius to get actual threshold.
// E.g. for radius=1.0: LOD 1 activates at 12 units, LOD 7 at ~0.18 units.
// For radius=0.3: LOD 1 at 3.6 units, LOD 7 at ~0.054 units.
export const LOD_DISTANCE_MULTIPLIERS = [
  Infinity, // LOD 0: always shown
  12,       // LOD 1: transition from fallback sphere
  6,        // LOD 2
  3,        // LOD 3
  1.5,      // LOD 4
  0.75,     // LOD 5
  0.35,     // LOD 6
  0.18,     // LOD 7
]

export const MAX_LOD = LOD_DISTANCE_MULTIPLIERS.length - 1

// ── Cube-to-sphere mapping ────────────────────────────────
// Maps (face, u, v) where u,v ∈ [-1,1] to a point on the unit sphere
const _v = new THREE.Vector3()

export function cubeToSphere(face: CubeFace, u: number, v: number): THREE.Vector3 {
  switch (face) {
    case CubeFace.PX: _v.set(1, v, u); break
    case CubeFace.NX: _v.set(-1, v, -u); break
    case CubeFace.PY: _v.set(u, 1, v); break
    case CubeFace.NY: _v.set(u, -1, -v); break
    case CubeFace.PZ: _v.set(u, v, 1); break
    case CubeFace.NZ: _v.set(-u, v, -1); break
  }
  return _v.clone().normalize()
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

// Get center of a node on the unit sphere
export function getNodeCenter(node: QuadtreeNode): THREE.Vector3 {
  const { u0, v0, u1, v1 } = getNodeBounds(node)
  return cubeToSphere(node.face, (u0 + u1) * 0.5, (v0 + v1) * 0.5)
}

export function getNodeBoundingRadius(node: QuadtreeNode, planetRadius: number): number {
  const { u0, v0, u1, v1 } = getNodeBounds(node)
  const center = getNodeCenter(node)
  let maxDist = 0

  for (const [u, v] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]]) {
    maxDist = Math.max(maxDist, center.distanceTo(cubeToSphere(node.face, u, v)))
  }

  return maxDist * planetRadius
}

// ── Chunk-to-camera distance ──────────────────────────────
const _worldCenter = new THREE.Vector3()

export function getChunkDistToCamera(
  node: QuadtreeNode,
  cameraPos: THREE.Vector3,
  planetWorldPos: THREE.Vector3,
  planetRadius: number,
): number {
  const center = getNodeCenter(node)
  _worldCenter.copy(center).multiplyScalar(planetRadius).add(planetWorldPos)
  return Math.max(0, cameraPos.distanceTo(_worldCenter) - getNodeBoundingRadius(node, planetRadius))
}

// ── Quadtree operations ───────────────────────────────────

export function createRoot(face: CubeFace): QuadtreeNode {
  return { face, lod: 0, x: 0, y: 0, children: null }
}

export function createChildren(node: QuadtreeNode): QuadtreeNode[] {
  const childLod = node.lod + 1
  const cx = node.x * 2
  const cy = node.y * 2
  return [
    { face: node.face, lod: childLod, x: cx,     y: cy,     children: null },
    { face: node.face, lod: childLod, x: cx + 1, y: cy,     children: null },
    { face: node.face, lod: childLod, x: cx,     y: cy + 1, children: null },
    { face: node.face, lod: childLod, x: cx + 1, y: cy + 1, children: null },
  ]
}

// Unique key for a quadtree node
export function nodeKey(face: CubeFace, lod: number, x: number, y: number): string {
  return `${face}_${lod}_${x}_${y}`
}

// Collect all leaf nodes from a quadtree
export function collectLeaves(node: QuadtreeNode): QuadtreeNode[] {
  if (!node.children) return [node]
  const leaves: QuadtreeNode[] = []
  for (const child of node.children) {
    leaves.push(...collectLeaves(child))
  }
  return leaves
}

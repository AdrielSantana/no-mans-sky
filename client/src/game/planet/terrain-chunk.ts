import * as THREE from 'three'
import { type QuadtreeNode, getNodeBounds, nodeKey } from './quadtree'
import type { PlanetTerrainParams } from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { Vec3Like } from '../../../../server/spacetimedb/src/shared/vector'
import {
  buildTerrainChunkGeometryData,
  normalizeSkirtFlags,
  type SkirtFlags,
  type TerrainChunkGeometryData,
} from './terrain-geometry'

export type { SkirtFlags } from './terrain-geometry'

const DEFAULT_GRID_SIZE = 33
const EPSILON = 1e-6

function toThree(v: Vec3Like): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z)
}

export class TerrainChunk {
  readonly mesh: THREE.Mesh
  readonly key: string
  readonly node: QuadtreeNode
  skirtFlags: SkirtFlags
  private geometry: THREE.BufferGeometry
  private fullIndices: Uint32Array = new Uint32Array(0)
  private mainIndexCount = 0
  private skirtEdgeIndexCount = 0
  private hasFullSkirtIndices = false
  private mainPositions: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private gridSize: number
  private terrain: PlanetTerrainParams

  constructor(
    node: QuadtreeNode,
    terrain: PlanetTerrainParams,
    material: THREE.Material,
    gridSize = DEFAULT_GRID_SIZE,
    skirts: boolean | SkirtFlags = true,
    geometryData?: TerrainChunkGeometryData,
  ) {
    this.node = { ...node, children: null }
    this.key = nodeKey(node.face, node.lod, node.x, node.y)
    this.gridSize = gridSize
    this.terrain = terrain
    this.skirtFlags = normalizeSkirtFlags(skirts)
    const data = geometryData ?? buildTerrainChunkGeometryData(node, terrain, gridSize, skirts)
    this.geometry = this.buildGeometry(data)
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.frustumCulled = true
  }

  needsSkirtUpdate(flags: SkirtFlags): boolean {
    return this.skirtFlags.bottom !== flags.bottom
      || this.skirtFlags.top !== flags.top
      || this.skirtFlags.left !== flags.left
      || this.skirtFlags.right !== flags.right
  }

  rebuildSkirts(flags: SkirtFlags, material: THREE.Material) {
    this.geometry.dispose()
    const data = buildTerrainChunkGeometryData(this.node, this.terrain, this.gridSize, flags)
    this.skirtFlags = flags
    this.mainPositions = data.mainPositions
    this.geometry = this.buildGeometry(data)
    this.mesh.geometry = this.geometry
    this.mesh.material = material
  }

  setSkirtFlags(flags: SkirtFlags) {
    if (!this.needsSkirtUpdate(flags)) return

    this.skirtFlags = flags
    this.geometry.setIndex(new THREE.BufferAttribute(this.buildIndexForSkirts(flags), 1))
    this.geometry.computeBoundingSphere()
  }

  private buildGeometry(data: TerrainChunkGeometryData): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    this.mainPositions = data.mainPositions
    this.fullIndices = data.indices
    this.mainIndexCount = (this.gridSize - 1) * (this.gridSize - 1) * 6
    this.skirtEdgeIndexCount = (this.gridSize - 1) * 6
    this.hasFullSkirtIndices = data.indices.length >= this.mainIndexCount + this.skirtEdgeIndexCount * 4
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
    geo.setAttribute('terrainHeight', new THREE.BufferAttribute(data.heights, 1))
    geo.setIndex(new THREE.BufferAttribute(this.buildIndexForSkirts(this.skirtFlags), 1))
    geo.computeBoundingSphere()

    return geo
  }

  private buildIndexForSkirts(flags: SkirtFlags): Uint32Array {
    if (!this.hasFullSkirtIndices) return this.fullIndices

    const activeEdges = (flags.bottom ? 1 : 0)
      + (flags.top ? 1 : 0)
      + (flags.left ? 1 : 0)
      + (flags.right ? 1 : 0)
    if (activeEdges === 4) return this.fullIndices
    if (activeEdges === 0) return this.fullIndices.subarray(0, this.mainIndexCount)

    const next = new Uint32Array(this.mainIndexCount + activeEdges * this.skirtEdgeIndexCount)
    next.set(this.fullIndices.subarray(0, this.mainIndexCount), 0)

    let writeOffset = this.mainIndexCount
    const copyEdge = (edgeIndex: number) => {
      const start = this.mainIndexCount + edgeIndex * this.skirtEdgeIndexCount
      next.set(this.fullIndices.subarray(start, start + this.skirtEdgeIndexCount), writeOffset)
      writeOffset += this.skirtEdgeIndexCount
    }

    if (flags.bottom) copyEdge(0)
    if (flags.top) copyEdge(1)
    if (flags.left) copyEdge(2)
    if (flags.right) copyEdge(3)

    return next
  }

  sampleVisualRadius(dirLike: Vec3Like): number | null {
    const dir = toThree(dirLike).normalize()
    const { u0, v0, u1, v1 } = getNodeBounds(this.node)
    const uv = this.directionToNodeUv(dir)
    if (!uv) return null

    const tx = THREE.MathUtils.clamp((uv.u - u0) / (u1 - u0), 0, 1)
    const ty = THREE.MathUtils.clamp((uv.v - v0) / (v1 - v0), 0, 1)
    const gs = this.gridSize
    const gx = tx * (gs - 1)
    const gy = ty * (gs - 1)
    const ix = Math.min(gs - 2, Math.max(0, Math.floor(gx)))
    const iy = Math.min(gs - 2, Math.max(0, Math.floor(gy)))

    let best: number | null = null
    for (let y = Math.max(0, iy - 1); y <= Math.min(gs - 2, iy + 1); y++) {
      for (let x = Math.max(0, ix - 1); x <= Math.min(gs - 2, ix + 1); x++) {
        const radius = this.sampleCellRadius(dir, x, y)
        if (radius !== null) best = best === null ? radius : Math.max(best, radius)
      }
    }
    return best
  }

  private sampleCellRadius(dir: THREE.Vector3, ix: number, iy: number): number | null {
    const a = this.mainVertex(ix, iy)
    const b = this.mainVertex(ix + 1, iy)
    const c = this.mainVertex(ix, iy + 1)
    const d = this.mainVertex(ix + 1, iy + 1)

    // Match TerrainChunk index order: first triangle a,b,c; second b,d,c.
    return this.rayTriangleRadius(dir, a, b, c) ?? this.rayTriangleRadius(dir, b, d, c)
  }

  private mainVertex(ix: number, iy: number): THREE.Vector3 {
    const i = iy * this.gridSize + ix
    return new THREE.Vector3(
      this.mainPositions[i * 3],
      this.mainPositions[i * 3 + 1],
      this.mainPositions[i * 3 + 2],
    )
  }

  private rayTriangleRadius(dir: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number | null {
    const edge1 = b.clone().sub(a)
    const edge2 = c.clone().sub(a)
    const pvec = dir.clone().cross(edge2)
    const det = edge1.dot(pvec)
    if (Math.abs(det) < EPSILON) return null

    const invDet = 1 / det
    const tvec = a.clone().multiplyScalar(-1)
    const u = tvec.dot(pvec) * invDet
    if (u < -EPSILON || u > 1 + EPSILON) return null

    const qvec = tvec.clone().cross(edge1)
    const v = dir.dot(qvec) * invDet
    if (v < -EPSILON || u + v > 1 + EPSILON) return null

    const radius = edge2.dot(qvec) * invDet
    return radius > 0 ? radius : null
  }

  private directionToNodeUv(dir: THREE.Vector3): { u: number; v: number } | null {
    const ax = Math.abs(dir.x)
    const ay = Math.abs(dir.y)
    const az = Math.abs(dir.z)

    switch (this.node.face) {
      case 0:
        if (dir.x <= 0 || ax < ay || ax < az) return null
        return { u: dir.z / ax, v: dir.y / ax }
      case 1:
        if (dir.x >= 0 || ax < ay || ax < az) return null
        return { u: -dir.z / ax, v: dir.y / ax }
      case 2:
        if (dir.y <= 0 || ay < ax || ay < az) return null
        return { u: dir.x / ay, v: dir.z / ay }
      case 3:
        if (dir.y >= 0 || ay < ax || ay < az) return null
        return { u: dir.x / ay, v: -dir.z / ay }
      case 4:
        if (dir.z <= 0 || az < ax || az < ay) return null
        return { u: dir.x / az, v: dir.y / az }
      case 5:
        if (dir.z >= 0 || az < ax || az < ay) return null
        return { u: -dir.x / az, v: dir.y / az }
      default:
        return null
    }
  }

  dispose() {
    this.geometry.dispose()
  }
}

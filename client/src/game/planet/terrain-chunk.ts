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
  readonly skirtFlags: SkirtFlags
  private geometry: THREE.BufferGeometry
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
    ;(this as { skirtFlags: SkirtFlags }).skirtFlags = flags
    this.mainPositions = data.mainPositions
    this.geometry = this.buildGeometry(data)
    this.mesh.geometry = this.geometry
    this.mesh.material = material
  }

  private buildGeometry(data: TerrainChunkGeometryData): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    this.mainPositions = data.mainPositions
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
    geo.setAttribute('terrainHeight', new THREE.BufferAttribute(data.heights, 1))
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1))
    geo.computeBoundingSphere()

    return geo
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

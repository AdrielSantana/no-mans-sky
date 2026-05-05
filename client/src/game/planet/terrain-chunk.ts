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

export interface StitchSteps {
  bottom: number
  top: number
  left: number
  right: number
}

export interface TerrainChunkSurfaceData {
  positions: Float32Array<ArrayBufferLike>
  normals: Float32Array<ArrayBufferLike>
  heights: Float32Array<ArrayBufferLike>
  microAo: Float32Array<ArrayBufferLike>
  macroAo: Float32Array<ArrayBufferLike>
  gridSize: number
}

const DEFAULT_GRID_SIZE = 33
const EPSILON = 1e-6
const NO_STITCH_STEPS: StitchSteps = { bottom: 0, top: 0, left: 0, right: 0 }

function toThree(v: Vec3Like): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z)
}

export class TerrainChunk {
  readonly mesh: THREE.Mesh
  readonly key: string
  readonly node: QuadtreeNode
  skirtFlags: SkirtFlags
  stitchSteps: StitchSteps = { ...NO_STITCH_STEPS }
  private geometry: THREE.BufferGeometry
  private fullIndices: Uint32Array = new Uint32Array(0)
  private mainPositions: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private mainNormals: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private mainHeights: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private mainMicroAo: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private mainMacroAo: Float32Array<ArrayBufferLike> = new Float32Array(0)
  private gridSize: number

  constructor(
    node: QuadtreeNode,
    terrain: PlanetTerrainParams,
    material: THREE.Material,
    gridSize = DEFAULT_GRID_SIZE,
    skirts: boolean | SkirtFlags = false,
    geometryData?: TerrainChunkGeometryData,
  ) {
    this.node = { ...node, children: null }
    this.key = nodeKey(node.face, node.lod, node.x, node.y)
    this.gridSize = gridSize
    this.skirtFlags = normalizeSkirtFlags(skirts)
    const data = geometryData ?? buildTerrainChunkGeometryData(node, terrain, gridSize, skirts)
    this.geometry = this.buildGeometry(data)
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.frustumCulled = true
  }

  needsStitchUpdate(steps: StitchSteps): boolean {
    return this.stitchSteps.bottom !== steps.bottom
      || this.stitchSteps.top !== steps.top
      || this.stitchSteps.left !== steps.left
      || this.stitchSteps.right !== steps.right
  }

  setStitchSteps(steps: StitchSteps) {
    if (!this.needsStitchUpdate(steps)) return

    this.stitchSteps = steps
    this.geometry.setIndex(new THREE.BufferAttribute(this.buildIndexForStitching(steps), 1))
    this.geometry.computeBoundingSphere()
  }

  private buildGeometry(data: TerrainChunkGeometryData): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry()
    this.mainPositions = data.mainPositions
    this.mainNormals = data.normals.slice(0, this.mainPositions.length)
    this.mainHeights = data.heights.slice(0, this.gridSize * this.gridSize)
    this.mainMicroAo = data.microAo.slice(0, this.gridSize * this.gridSize)
    this.mainMacroAo = data.macroAo.slice(0, this.gridSize * this.gridSize)
    this.fullIndices = data.indices
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
    geo.setAttribute('terrainHeight', new THREE.BufferAttribute(data.heights, 1))
    geo.setAttribute('terrainMicroAo', new THREE.BufferAttribute(data.microAo, 1))
    geo.setAttribute('terrainMacroAo', new THREE.BufferAttribute(data.macroAo, 1))
    geo.setIndex(new THREE.BufferAttribute(this.buildIndexForStitching(this.stitchSteps), 1))
    geo.computeBoundingSphere()

    return geo
  }

  getSurfaceData(): TerrainChunkSurfaceData {
    return {
      positions: this.mainPositions,
      normals: this.mainNormals,
      heights: this.mainHeights,
      microAo: this.mainMicroAo,
      macroAo: this.mainMacroAo,
      gridSize: this.gridSize,
    }
  }

  private buildIndexForStitching(steps: StitchSteps): Uint32Array {
    const activeEdges = (steps.bottom > 1 ? 1 : 0)
      + (steps.top > 1 ? 1 : 0)
      + (steps.left > 1 ? 1 : 0)
      + (steps.right > 1 ? 1 : 0)
    if (activeEdges === 0) return this.fullIndices

    const gs = this.gridSize
    const seg = gs - 1
    const indices: number[] = []
    const v = (x: number, y: number) => y * gs + x
    const pushTri = (a: number, b: number, c: number) => {
      indices.push(a, b, c)
    }

    for (let y = 0; y < seg; y++) {
      for (let x = 0; x < seg; x++) {
        if ((steps.bottom > 1 && y === 0)
          || (steps.top > 1 && y === seg - 1)
          || (steps.left > 1 && x === 0)
          || (steps.right > 1 && x === seg - 1)) {
          continue
        }

        const a = v(x, y)
        const b = v(x + 1, y)
        const c = v(x, y + 1)
        const d = v(x + 1, y + 1)
        pushTri(a, b, c)
        pushTri(b, d, c)
      }
    }

    const clampStep = (step: number) => Math.max(2, Math.min(seg, Math.floor(step)))

    if (steps.bottom > 1) {
      const step = clampStep(steps.bottom)
      for (let x = 0; x < seg; x += step) {
        const end = Math.min(x + step, seg)
        const b0 = v(x, 0)
        const b1 = v(end, 0)
        for (let ix = x; ix < end - 1; ix++) {
          pushTri(b0, v(ix, 1), v(ix + 1, 1))
        }
        pushTri(b0, v(end - 1, 1), b1)
        pushTri(b1, v(end - 1, 1), v(end, 1))
      }
    }

    if (steps.top > 1) {
      const step = clampStep(steps.top)
      for (let x = 0; x < seg; x += step) {
        const end = Math.min(x + step, seg)
        const b0 = v(x, seg)
        const b1 = v(end, seg)
        pushTri(b0, b1, v(end - 1, seg - 1))
        for (let ix = end - 1; ix > x; ix--) {
          pushTri(b0, v(ix, seg - 1), v(ix - 1, seg - 1))
        }
        pushTri(b1, v(end, seg - 1), v(end - 1, seg - 1))
      }
    }

    if (steps.left > 1) {
      const step = clampStep(steps.left)
      for (let y = 0; y < seg; y += step) {
        const end = Math.min(y + step, seg)
        const b0 = v(0, y)
        const b1 = v(0, end)
        pushTri(b0, b1, v(1, end - 1))
        for (let iy = end - 1; iy > y; iy--) {
          pushTri(b0, v(1, iy), v(1, iy - 1))
        }
        pushTri(b1, v(1, end), v(1, end - 1))
      }
    }

    if (steps.right > 1) {
      const step = clampStep(steps.right)
      for (let y = 0; y < seg; y += step) {
        const end = Math.min(y + step, seg)
        const b0 = v(seg, y)
        const b1 = v(seg, end)
        for (let iy = y; iy < end - 1; iy++) {
          pushTri(b0, v(seg - 1, iy), v(seg - 1, iy + 1))
        }
        pushTri(b0, v(seg - 1, end - 1), b1)
        pushTri(b1, v(seg - 1, end - 1), v(seg - 1, end))
      }
    }

    return Uint32Array.from(indices)
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

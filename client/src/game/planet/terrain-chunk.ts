import * as THREE from 'three'
import { type QuadtreeNode, getNodeBounds, cubeToSphere, nodeKey } from './quadtree'
import { samplePlanetHeight, type PlanetTerrainParams } from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { Vec3Like } from '../../../../server/spacetimedb/src/shared/vector'

const DEFAULT_GRID_SIZE = 33
const SKIRT_DEPTH = 0.08
const EPSILON = 1e-6

function toThree(v: Vec3Like): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z)
}

export class TerrainChunk {
  readonly mesh: THREE.Mesh
  readonly key: string
  readonly node: QuadtreeNode
  private geometry: THREE.BufferGeometry
  private mainPositions = new Float32Array(0)
  private gridSize: number

  constructor(
    node: QuadtreeNode,
    terrain: PlanetTerrainParams,
    material: THREE.Material,
    gridSize = DEFAULT_GRID_SIZE,
    skirts = true,
  ) {
    this.node = { ...node, children: null }
    this.key = nodeKey(node.face, node.lod, node.x, node.y)
    this.gridSize = gridSize
    this.geometry = this.buildGeometry(node, terrain, skirts)
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.frustumCulled = true
  }

  private buildGeometry(
    node: QuadtreeNode,
    terrain: PlanetTerrainParams,
    skirts: boolean,
  ): THREE.BufferGeometry {
    const gs = this.gridSize
    const { u0, v0, u1, v1 } = getNodeBounds(node)
    const du = (u1 - u0) / (gs - 1)
    const dv = (v1 - v0) / (gs - 1)

    const vertCount = gs * gs
    const positions = new Float32Array(vertCount * 3)
    const heights = new Float32Array(vertCount)

    // CPU displacement is authoritative so physics, wireframe, and rendering use the same surface.
    for (let iy = 0; iy < gs; iy++) {
      for (let ix = 0; ix < gs; ix++) {
        const i = iy * gs + ix
        const u = u0 + ix * du
        const v = v0 + iy * dv

        const dir = cubeToSphere(node.face, u, v)
        const height = samplePlanetHeight(dir, terrain)
        const radius = terrain.radius + height * terrain.terrainScale * terrain.radius
        positions[i * 3] = dir.x * radius
        positions[i * 3 + 1] = dir.y * radius
        positions[i * 3 + 2] = dir.z * radius
        heights[i] = height
      }
    }
    this.mainPositions = positions

    // Build indices for main grid
    const segCount = gs - 1
    const indexCount = segCount * segCount * 6
    const indices = new Uint32Array(indexCount)
    let idx = 0

    for (let iy = 0; iy < segCount; iy++) {
      for (let ix = 0; ix < segCount; ix++) {
        const a = iy * gs + ix
        const b = a + 1
        const c = a + gs
        const d = c + 1
        indices[idx++] = a
        indices[idx++] = b
        indices[idx++] = c
        indices[idx++] = b
        indices[idx++] = d
        indices[idx++] = c
      }
    }

    const geo = new THREE.BufferGeometry()

    if (!skirts) {
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('terrainHeight', new THREE.BufferAttribute(heights, 1))
      geo.setIndex(new THREE.BufferAttribute(indices.subarray(0, idx), 1))
      geo.computeVertexNormals()
      geo.computeBoundingSphere()
      return geo
    }

    // Skirt geometry
    const skirtDepth = terrain.radius * SKIRT_DEPTH
    const mainVertCount = vertCount
    const skirtVertCount = 4 * gs
    const totalVertCount = mainVertCount + skirtVertCount

    const allPositions = new Float32Array(totalVertCount * 3)
    const allHeights = new Float32Array(totalVertCount)
    allPositions.set(positions, 0)
    allHeights.set(heights, 0)

    let skirtIdx = mainVertCount

    const pushSkirtVertex = (mainI: number) => {
      const targetI = skirtIdx
      const mx = positions[mainI * 3]
      const my = positions[mainI * 3 + 1]
      const mz = positions[mainI * 3 + 2]
      const len = Math.sqrt(mx * mx + my * my + mz * mz)
      const nx = mx / len
      const ny = my / len
      const nz = mz / len

      allPositions[skirtIdx * 3] = mx - nx * skirtDepth
      allPositions[skirtIdx * 3 + 1] = my - ny * skirtDepth
      allPositions[skirtIdx * 3 + 2] = mz - nz * skirtDepth
      allHeights[targetI] = heights[mainI]

      return skirtIdx++
    }

    // Skirt vertices for each edge
    const bottomStart = skirtIdx
    for (let ix = 0; ix < gs; ix++) pushSkirtVertex(ix)

    const topStart = skirtIdx
    for (let ix = 0; ix < gs; ix++) pushSkirtVertex((gs - 1) * gs + ix)

    const leftStart = skirtIdx
    for (let iy = 0; iy < gs; iy++) pushSkirtVertex(iy * gs)

    const rightStart = skirtIdx
    for (let iy = 0; iy < gs; iy++) pushSkirtVertex(iy * gs + gs - 1)

    // Skirt indices
    const skirtIndexCount = 4 * (gs - 1) * 6
    const totalIndexCount = idx + skirtIndexCount
    const allIndices = new Uint32Array(totalIndexCount)
    allIndices.set(indices.subarray(0, idx), 0)

    let si = idx

    // Bottom edge
    for (let i = 0; i < gs - 1; i++) {
      const a = i, b = i + 1, c = bottomStart + i, d = bottomStart + i + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
    // Top edge
    const topRow = (gs - 1) * gs
    for (let i = 0; i < gs - 1; i++) {
      const a = topRow + i, b = topRow + i + 1, c = topStart + i, d = topStart + i + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
    // Left edge
    for (let iy = 0; iy < gs - 1; iy++) {
      const a = iy * gs, b = (iy + 1) * gs, c = leftStart + iy, d = leftStart + iy + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
    // Right edge
    for (let iy = 0; iy < gs - 1; iy++) {
      const a = iy * gs + gs - 1, b = (iy + 1) * gs + gs - 1
      const c = rightStart + iy, d = rightStart + iy + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }

    geo.setAttribute('position', new THREE.BufferAttribute(allPositions, 3))
    geo.setAttribute('terrainHeight', new THREE.BufferAttribute(allHeights, 1))
    geo.setIndex(new THREE.BufferAttribute(allIndices, 1))
    geo.computeVertexNormals()
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

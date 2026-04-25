import * as THREE from 'three'
import { type QuadtreeNode, getNodeBounds, cubeToSphere, nodeKey } from './quadtree'

const GRID_SIZE = 33
const SKIRT_DEPTH = 0.08

export class TerrainChunk {
  readonly mesh: THREE.Mesh
  readonly key: string
  readonly node: QuadtreeNode
  private geometry: THREE.BufferGeometry

  constructor(
    node: QuadtreeNode,
    planetRadius: number,
    terrainScale: number,
    _seed: number,
    _octaves: number,
    material: THREE.Material,
  ) {
    this.node = { ...node, children: null }
    this.key = nodeKey(node.face, node.lod, node.x, node.y)
    this.geometry = this.buildGeometry(node, planetRadius, terrainScale)
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.frustumCulled = true
  }

  private buildGeometry(
    node: QuadtreeNode,
    planetRadius: number,
    terrainScale: number,
  ): THREE.BufferGeometry {
    const { u0, v0, u1, v1 } = getNodeBounds(node)
    const du = (u1 - u0) / (GRID_SIZE - 1)
    const dv = (v1 - v0) / (GRID_SIZE - 1)

    const vertCount = GRID_SIZE * GRID_SIZE
    const positions = new Float32Array(vertCount * 3)

    // Generate sphere vertices (no displacement — shader handles that)
    for (let iy = 0; iy < GRID_SIZE; iy++) {
      for (let ix = 0; ix < GRID_SIZE; ix++) {
        const i = iy * GRID_SIZE + ix
        const u = u0 + ix * du
        const v = v0 + iy * dv

        const dir = cubeToSphere(node.face, u, v)
        positions[i * 3] = dir.x * planetRadius
        positions[i * 3 + 1] = dir.y * planetRadius
        positions[i * 3 + 2] = dir.z * planetRadius
      }
    }

    // Build indices for main grid
    const segCount = GRID_SIZE - 1
    const indexCount = segCount * segCount * 6
    const indices = new Uint32Array(indexCount)
    let idx = 0

    for (let iy = 0; iy < segCount; iy++) {
      for (let ix = 0; ix < segCount; ix++) {
        const a = iy * GRID_SIZE + ix
        const b = a + 1
        const c = a + GRID_SIZE
        const d = c + 1
        indices[idx++] = a
        indices[idx++] = b
        indices[idx++] = c
        indices[idx++] = b
        indices[idx++] = d
        indices[idx++] = c
      }
    }

    // Skirt geometry
    const skirtDepth = planetRadius * SKIRT_DEPTH
    const mainVertCount = vertCount
    const skirtVertCount = 4 * GRID_SIZE
    const totalVertCount = mainVertCount + skirtVertCount

    const allPositions = new Float32Array(totalVertCount * 3)
    allPositions.set(positions, 0)

    let skirtIdx = mainVertCount

    const pushSkirtVertex = (mainI: number) => {
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

      return skirtIdx++
    }

    // Skirt vertices for each edge
    const bottomStart = skirtIdx
    for (let ix = 0; ix < GRID_SIZE; ix++) pushSkirtVertex(ix)

    const topStart = skirtIdx
    for (let ix = 0; ix < GRID_SIZE; ix++) pushSkirtVertex((GRID_SIZE - 1) * GRID_SIZE + ix)

    const leftStart = skirtIdx
    for (let iy = 0; iy < GRID_SIZE; iy++) pushSkirtVertex(iy * GRID_SIZE)

    const rightStart = skirtIdx
    for (let iy = 0; iy < GRID_SIZE; iy++) pushSkirtVertex(iy * GRID_SIZE + GRID_SIZE - 1)

    // Skirt indices
    const skirtIndexCount = 4 * (GRID_SIZE - 1) * 6
    const totalIndexCount = idx + skirtIndexCount
    const allIndices = new Uint32Array(totalIndexCount)
    allIndices.set(indices.subarray(0, idx), 0)

    let si = idx

    // Bottom edge
    for (let i = 0; i < GRID_SIZE - 1; i++) {
      const a = i, b = i + 1, c = bottomStart + i, d = bottomStart + i + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
    // Top edge
    const topRow = (GRID_SIZE - 1) * GRID_SIZE
    for (let i = 0; i < GRID_SIZE - 1; i++) {
      const a = topRow + i, b = topRow + i + 1, c = topStart + i, d = topStart + i + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
    // Left edge
    for (let iy = 0; iy < GRID_SIZE - 1; iy++) {
      const a = iy * GRID_SIZE, b = (iy + 1) * GRID_SIZE, c = leftStart + iy, d = leftStart + iy + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
    // Right edge
    for (let iy = 0; iy < GRID_SIZE - 1; iy++) {
      const a = iy * GRID_SIZE + GRID_SIZE - 1, b = (iy + 1) * GRID_SIZE + GRID_SIZE - 1
      const c = rightStart + iy, d = rightStart + iy + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(allPositions, 3))
    geo.setIndex(new THREE.BufferAttribute(allIndices, 1))
    geo.computeBoundingSphere()
    if (geo.boundingSphere) {
      geo.boundingSphere.radius += planetRadius * (Math.abs(terrainScale) + SKIRT_DEPTH)
    }

    return geo
  }

  dispose() {
    this.geometry.dispose()
  }
}

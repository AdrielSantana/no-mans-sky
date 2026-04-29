import { samplePlanetHeight, type PlanetTerrainParams } from '../../../../server/spacetimedb/src/shared/planet-terrain'
import { type QuadtreeNode, cubeToSphere, getNodeBounds } from './quadtree'

const SKIRT_DEPTH = 0.08

export interface TerrainChunkGeometryData {
  positions: Float32Array
  normals: Float32Array
  heights: Float32Array
  indices: Uint32Array
  mainPositions: Float32Array
}

export interface SkirtFlags {
  bottom: boolean
  top: boolean
  left: boolean
  right: boolean
}

export function normalizeSkirtFlags(skirts: boolean | SkirtFlags): SkirtFlags {
  if (typeof skirts === 'object') return skirts
  return skirts
    ? { bottom: true, top: true, left: true, right: true }
    : { bottom: false, top: false, left: false, right: false }
}

function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length)

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3
    const ib = indices[i + 1] * 3
    const ic = indices[i + 2] * 3

    const ax = positions[ia]
    const ay = positions[ia + 1]
    const az = positions[ia + 2]
    const abx = positions[ib] - ax
    const aby = positions[ib + 1] - ay
    const abz = positions[ib + 2] - az
    const acx = positions[ic] - ax
    const acy = positions[ic + 1] - ay
    const acz = positions[ic + 2] - az

    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx

    normals[ia] += nx
    normals[ia + 1] += ny
    normals[ia + 2] += nz
    normals[ib] += nx
    normals[ib + 1] += ny
    normals[ib + 2] += nz
    normals[ic] += nx
    normals[ic + 1] += ny
    normals[ic + 2] += nz
  }

  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i]
    const ny = normals[i + 1]
    const nz = normals[i + 2]
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len > 1e-8) {
      normals[i] = nx / len
      normals[i + 1] = ny / len
      normals[i + 2] = nz / len
    }
  }

  return normals
}

export function buildTerrainChunkGeometryData(
  node: QuadtreeNode,
  terrain: PlanetTerrainParams,
  gridSize: number,
  skirts: boolean | SkirtFlags,
): TerrainChunkGeometryData {
  const gs = gridSize
  const skirtFlags = normalizeSkirtFlags(skirts)
  const { u0, v0, u1, v1 } = getNodeBounds(node)
  const du = (u1 - u0) / (gs - 1)
  const dv = (v1 - v0) / (gs - 1)

  const vertCount = gs * gs
  const positions = new Float32Array(vertCount * 3)
  const heights = new Float32Array(vertCount)

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

  const hasAnySkirt = skirtFlags.bottom || skirtFlags.top || skirtFlags.left || skirtFlags.right

  if (!hasAnySkirt) {
    return {
      positions,
      heights,
      indices,
      normals: computeNormals(positions, indices),
      mainPositions: positions.slice(),
    }
  }

  const skirtDepth = terrain.radius * SKIRT_DEPTH
  const mainVertCount = vertCount
  const activeEdges = (skirtFlags.bottom ? 1 : 0)
    + (skirtFlags.top ? 1 : 0)
    + (skirtFlags.left ? 1 : 0)
    + (skirtFlags.right ? 1 : 0)
  const skirtVertCount = activeEdges * gs
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

  let bottomStart = -1
  let topStart = -1
  let leftStart = -1
  let rightStart = -1

  if (skirtFlags.bottom) {
    bottomStart = skirtIdx
    for (let ix = 0; ix < gs; ix++) pushSkirtVertex(ix)
  }

  if (skirtFlags.top) {
    topStart = skirtIdx
    for (let ix = 0; ix < gs; ix++) pushSkirtVertex((gs - 1) * gs + ix)
  }

  if (skirtFlags.left) {
    leftStart = skirtIdx
    for (let iy = 0; iy < gs; iy++) pushSkirtVertex(iy * gs)
  }

  if (skirtFlags.right) {
    rightStart = skirtIdx
    for (let iy = 0; iy < gs; iy++) pushSkirtVertex(iy * gs + gs - 1)
  }

  const skirtIndexCount = activeEdges * (gs - 1) * 6
  const allIndices = new Uint32Array(idx + skirtIndexCount)
  allIndices.set(indices.subarray(0, idx), 0)

  let si = idx

  if (bottomStart >= 0) {
    for (let i = 0; i < gs - 1; i++) {
      const a = i, b = i + 1, c = bottomStart + i, d = bottomStart + i + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
  }

  if (topStart >= 0) {
    const topRow = (gs - 1) * gs
    for (let i = 0; i < gs - 1; i++) {
      const a = topRow + i, b = topRow + i + 1, c = topStart + i, d = topStart + i + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
  }

  if (leftStart >= 0) {
    for (let iy = 0; iy < gs - 1; iy++) {
      const a = iy * gs, b = (iy + 1) * gs, c = leftStart + iy, d = leftStart + iy + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
  }

  if (rightStart >= 0) {
    for (let iy = 0; iy < gs - 1; iy++) {
      const a = iy * gs + gs - 1, b = (iy + 1) * gs + gs - 1
      const c = rightStart + iy, d = rightStart + iy + 1
      allIndices[si++] = a; allIndices[si++] = b; allIndices[si++] = c
      allIndices[si++] = b; allIndices[si++] = d; allIndices[si++] = c
    }
  }

  return {
    positions: allPositions,
    heights: allHeights,
    indices: allIndices,
    normals: computeNormals(allPositions, allIndices),
    mainPositions: positions.slice(),
  }
}

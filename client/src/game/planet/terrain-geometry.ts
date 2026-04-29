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

function terrainSurfacePoint(dir: { x: number; y: number; z: number }, terrain: PlanetTerrainParams): [number, number, number] {
  const height = samplePlanetHeight(dir, terrain)
  const radius = terrain.radius + height * terrain.terrainScale * terrain.radius
  return [dir.x * radius, dir.y * radius, dir.z * radius]
}

function normalizeVec(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z)
  return len > 1e-8 ? [x / len, y / len, z / len] : [0, 1, 0]
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
  return [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx,
  ]
}

function computeTerrainNormal(dir: { x: number; y: number; z: number }, terrain: PlanetTerrainParams, sampleStep: number): [number, number, number] {
  const up = Math.abs(dir.y) < 0.94 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const [tx, ty, tz] = normalizeVec(
    up.y * dir.z - up.z * dir.y,
    up.z * dir.x - up.x * dir.z,
    up.x * dir.y - up.y * dir.x,
  )
  const [bx, by, bz] = normalizeVec(
    dir.y * tz - dir.z * ty,
    dir.z * tx - dir.x * tz,
    dir.x * ty - dir.y * tx,
  )

  const [dtx0, dty0, dtz0] = normalizeVec(dir.x - tx * sampleStep, dir.y - ty * sampleStep, dir.z - tz * sampleStep)
  const [dtx1, dty1, dtz1] = normalizeVec(dir.x + tx * sampleStep, dir.y + ty * sampleStep, dir.z + tz * sampleStep)
  const [dbx0, dby0, dbz0] = normalizeVec(dir.x - bx * sampleStep, dir.y - by * sampleStep, dir.z - bz * sampleStep)
  const [dbx1, dby1, dbz1] = normalizeVec(dir.x + bx * sampleStep, dir.y + by * sampleStep, dir.z + bz * sampleStep)

  const pT0 = terrainSurfacePoint({ x: dtx0, y: dty0, z: dtz0 }, terrain)
  const pT1 = terrainSurfacePoint({ x: dtx1, y: dty1, z: dtz1 }, terrain)
  const pB0 = terrainSurfacePoint({ x: dbx0, y: dby0, z: dbz0 }, terrain)
  const pB1 = terrainSurfacePoint({ x: dbx1, y: dby1, z: dbz1 }, terrain)

  const [nx, ny, nz] = cross(
    pT1[0] - pT0[0],
    pT1[1] - pT0[1],
    pT1[2] - pT0[2],
    pB1[0] - pB0[0],
    pB1[1] - pB0[1],
    pB1[2] - pB0[2],
  )
  let [outX, outY, outZ] = normalizeVec(nx, ny, nz)
  if (outX * dir.x + outY * dir.y + outZ * dir.z < 0) {
    outX = -outX
    outY = -outY
    outZ = -outZ
  }
  return [outX, outY, outZ]
}

function computeTerrainNormals(positions: Float32Array, terrain: PlanetTerrainParams, sampleStep: number): Float32Array {
  const normals = new Float32Array(positions.length)

  for (let i = 0; i < positions.length; i += 3) {
    const [dx, dy, dz] = normalizeVec(positions[i], positions[i + 1], positions[i + 2])
    const [nx, ny, nz] = computeTerrainNormal({ x: dx, y: dy, z: dz }, terrain, sampleStep)
    normals[i] = nx
    normals[i + 1] = ny
    normals[i + 2] = nz
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
  const normalSampleStep = Math.max(0.0008, Math.min(Math.abs(du), Math.abs(dv)) * 0.45)
  const mainNormals = computeTerrainNormals(positions, terrain, normalSampleStep)

  if (!hasAnySkirt) {
    return {
      positions,
      heights,
      indices,
      normals: mainNormals,
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
  const allNormals = new Float32Array(totalVertCount * 3)
  allPositions.set(positions, 0)
  allHeights.set(heights, 0)
  allNormals.set(mainNormals, 0)

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
    allNormals[targetI * 3] = mainNormals[mainI * 3]
    allNormals[targetI * 3 + 1] = mainNormals[mainI * 3 + 1]
    allNormals[targetI * 3 + 2] = mainNormals[mainI * 3 + 2]

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
    normals: allNormals,
    mainPositions: positions.slice(),
  }
}

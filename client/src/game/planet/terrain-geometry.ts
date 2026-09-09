import {
  samplePlanetHeight,
  samplePlanetHeightDetailed,
  samplePlanetMicroHeight,
  type PlanetTerrainParams,
} from '../../../../server/spacetimedb/src/shared/planet-terrain'
import { type QuadtreeNode, cubeToSphere, getNodeBounds } from './quadtree'

const SKIRT_DEPTH = 0.08

export interface TerrainChunkGeometryData {
  positions: Float32Array
  normals: Float32Array
  heights: Float32Array
  microAo: Float32Array
  macroAo: Float32Array
  grassPatch: Float32Array
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

function terrainSurfacePoint(
  dir: { x: number; y: number; z: number },
  terrain: PlanetTerrainParams,
  microDetailAmount: number,
): [number, number, number] {
  const height = samplePlanetHeightDetailed(dir, terrain, microDetailAmount)
  const radius = terrain.radius + height * terrain.terrainScale * terrain.radius
  return [dir.x * radius, dir.y * radius, dir.z * radius]
}

// Hoisted out of computeMacroAoAtDirection: it used to rebuild an array of six
// tuples on every vertex.
const MACRO_AO_AXES = new Float64Array([
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
  0.70710678, 0.70710678, 0,
  0.70710678, 0, 0.70710678,
  0, 0.70710678, 0.70710678,
])

// Per-vertex scratch for the AO passes. Micro and macro AO never run
// concurrently for the same vertex, so one pair of buffers serves both.
const _aoPairsA = new Float64Array(6)
const _aoPairsB = new Float64Array(6)
const _aoProjected = new Float64Array(3)
const _aoSampleDir = { x: 0, y: 0, z: 0 }

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

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 1e-6)))
  return t * t * (3 - 2 * t)
}

function hashGrid(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ seed
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function noiseFade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = noiseFade(x - ix)
  const fy = noiseFade(y - iy)
  const fz = noiseFade(z - iz)

  const x00 = lerp(hashGrid(ix, iy, iz, seed), hashGrid(ix + 1, iy, iz, seed), fx)
  const x10 = lerp(hashGrid(ix, iy + 1, iz, seed), hashGrid(ix + 1, iy + 1, iz, seed), fx)
  const x01 = lerp(hashGrid(ix, iy, iz + 1, seed), hashGrid(ix + 1, iy, iz + 1, seed), fx)
  const x11 = lerp(hashGrid(ix, iy + 1, iz + 1, seed), hashGrid(ix + 1, iy + 1, iz + 1, seed), fx)
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz)
}

function grassPatchNoise(x: number, y: number, z: number, seed: number): number {
  let frequency = 1 / 72
  let amplitude = 0.62
  let total = 0
  let norm = 0

  for (let octave = 0; octave < 3; octave++) {
    total += valueNoise3(x * frequency, y * frequency, z * frequency, seed + octave * 1013) * amplitude
    norm += amplitude
    frequency *= 2.05
    amplitude *= 0.48
  }

  return norm > 0 ? total / norm : 0
}

function computeGrassPatchMask(x: number, y: number, z: number, seed: number): number {
  return smoothstep(0.44, 0.60, grassPatchNoise(x, y, z, seed))
}

export function computeTerrainNormal(
  dir: { x: number; y: number; z: number },
  terrain: PlanetTerrainParams,
  sampleStep: number,
  microDetailAmount: number,
): [number, number, number] {
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

  const pT0 = terrainSurfacePoint({ x: dtx0, y: dty0, z: dtz0 }, terrain, microDetailAmount)
  const pT1 = terrainSurfacePoint({ x: dtx1, y: dty1, z: dtz1 }, terrain, microDetailAmount)
  const pB0 = terrainSurfacePoint({ x: dbx0, y: dby0, z: dbz0 }, terrain, microDetailAmount)
  const pB1 = terrainSurfacePoint({ x: dbx1, y: dby1, z: dbz1 }, terrain, microDetailAmount)

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

function computeTerrainNormals(
  positions: Float32Array,
  terrain: PlanetTerrainParams,
  sampleStep: number,
  microDetailAmount: number,
): Float32Array {
  const normals = new Float32Array(positions.length)

  for (let i = 0; i < positions.length; i += 3) {
    const [dx, dy, dz] = normalizeVec(positions[i], positions[i + 1], positions[i + 2])
    const [nx, ny, nz] = computeTerrainNormal({ x: dx, y: dy, z: dz }, terrain, sampleStep, microDetailAmount)
    normals[i] = nx
    normals[i + 1] = ny
    normals[i + 2] = nz
  }

  return normals
}

function offsetDirection(
  dir: { x: number; y: number; z: number },
  tangent: [number, number, number],
  bitangent: [number, number, number],
  tx: number,
  ty: number,
  step: number,
): { x: number; y: number; z: number } {
  const [x, y, z] = normalizeVec(
    dir.x + tangent[0] * tx * step + bitangent[0] * ty * step,
    dir.y + tangent[1] * tx * step + bitangent[1] * ty * step,
    dir.z + tangent[2] * tx * step + bitangent[2] * ty * step,
  )
  return { x, y, z }
}

function tangentFrame(dir: { x: number; y: number; z: number }): {
  tangent: [number, number, number]
  bitangent: [number, number, number]
} {
  const up = Math.abs(dir.y) < 0.94 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const tangent = normalizeVec(
    up.y * dir.z - up.z * dir.y,
    up.z * dir.x - up.x * dir.z,
    up.x * dir.y - up.y * dir.x,
  )
  const bitangent = normalizeVec(
    dir.y * tangent[2] - dir.z * tangent[1],
    dir.z * tangent[0] - dir.x * tangent[2],
    dir.x * tangent[1] - dir.y * tangent[0],
  )
  return { tangent, bitangent }
}

// Writes the projected axis into `out` and reports whether it was degenerate,
// instead of returning a fresh tuple (or null) per call. Called six times per
// vertex on the macro AO path.
function projectedTangentDirection(
  dir: { x: number; y: number; z: number },
  axisX: number,
  axisY: number,
  axisZ: number,
  out: Float64Array,
): boolean {
  const dot = dir.x * axisX + dir.y * axisY + dir.z * axisZ
  const px = axisX - dir.x * dot
  const py = axisY - dir.y * dot
  const pz = axisZ - dir.z * dot
  if (px * px + py * py + pz * pz < 1e-4) return false
  const len = Math.sqrt(px * px + py * py + pz * pz)
  if (len > 1e-8) {
    out[0] = px / len
    out[1] = py / len
    out[2] = pz / len
  } else {
    out[0] = 0
    out[1] = 1
    out[2] = 0
  }
  return true
}

// Takes two parallel buffers plus a count rather than an array of [a, b]
// tuples: this runs once per vertex per AO term, and the tuples were ~7 heap
// allocations each time.
function sampleDirectionalAo(
  center: number,
  pairsA: Float64Array,
  pairsB: Float64Array,
  pairCount: number,
  terrainMeters: number,
  expectedRelief: number,
  concavityStart: number,
  concavityEnd: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  let localMin = center
  let localMax = center
  let maxConcavityMeters = 0
  let concavitySum = 0

  for (let i = 0; i < pairCount; i++) {
    const a = pairsA[i]
    const b = pairsB[i]
    localMin = Math.min(localMin, a, b)
    localMax = Math.max(localMax, a, b)
    const pairConcavityMeters = Math.max(0, (a + b) * 0.5 - center) * terrainMeters
    maxConcavityMeters = Math.max(maxConcavityMeters, pairConcavityMeters)
    concavitySum += pairConcavityMeters
  }

  const avgConcavityMeters = concavitySum / Math.max(1, pairCount)
  const localRangeMeters = Math.max(0, localMax - localMin) * terrainMeters
  const avgCavity = smoothstep(expectedRelief * concavityStart, expectedRelief * concavityEnd, avgConcavityMeters)
  const peakCavity = smoothstep(expectedRelief * concavityStart * 1.4, expectedRelief * concavityEnd * 1.2, maxConcavityMeters)
  const cavity = Math.max(avgCavity, peakCavity)
  const rangeGate = smoothstep(expectedRelief * rangeStart, expectedRelief * rangeEnd, localRangeMeters)
  return 1 - cavity * rangeGate
}

function computeMicroAoAtDirection(
  dir: { x: number; y: number; z: number },
  macroHeight: number,
  microHeight: number,
  terrain: PlanetTerrainParams,
): number {
  if (terrain.planetType === 'gas') return 1

  const terrainMeters = Math.max(terrain.terrainScale * terrain.radius, 0.001)
  const reliefMeters = Math.max(terrain.microReliefMeters ?? (terrain.planetType === 'ice' ? 1.35 : 1.5), 0.001)
  const strength = Math.max(terrain.microDetailStrength ?? (terrain.planetType === 'ice' ? 0.48 : 0.5), 0)
  if (strength <= 0.001) return 1

  const expectedRelief = Math.max(reliefMeters * strength * 0.62, 0.07)
  const { tangent, bitangent } = tangentFrame(dir)
  const fineStep = Math.max(0.45, Math.min(reliefMeters * 0.55, 1.1))
  const fissureStep = Math.max(0.8, Math.min(reliefMeters * 1.0, 2.0))
  const ledgeStep = Math.max(fissureStep * 1.7, Math.min(reliefMeters * 2.25, 3.7))
  const sample = (tx: number, ty: number, meters: number) => {
    const sampleDir = offsetDirection(dir, tangent, bitangent, tx, ty, meters / Math.max(terrain.radius, 1))
    return samplePlanetMicroHeight(sampleDir, terrain, macroHeight)
  }
  _aoPairsA[0] = sample(-1, 0, fineStep);     _aoPairsB[0] = sample(1, 0, fineStep)
  _aoPairsA[1] = sample(0, -1, fineStep);     _aoPairsB[1] = sample(0, 1, fineStep)
  _aoPairsA[2] = sample(-1, 0, fissureStep);  _aoPairsB[2] = sample(1, 0, fissureStep)
  _aoPairsA[3] = sample(0, -1, fissureStep);  _aoPairsB[3] = sample(0, 1, fissureStep)
  _aoPairsA[4] = sample(-1, -1, ledgeStep);   _aoPairsB[4] = sample(1, 1, ledgeStep)
  _aoPairsA[5] = sample(1, -1, ledgeStep);    _aoPairsB[5] = sample(-1, 1, ledgeStep)

  return sampleDirectionalAo(
    microHeight,
    _aoPairsA,
    _aoPairsB,
    6,
    terrainMeters,
    expectedRelief,
    0.07,
    0.88,
    0.07,
    1.25,
  )
}

function computeMacroAoAtDirection(
  dir: { x: number; y: number; z: number },
  macroHeight: number,
  terrain: PlanetTerrainParams,
): number {
  if (terrain.planetType === 'gas') return 1

  const terrainMeters = Math.max(terrain.terrainScale * terrain.radius, 0.001)
  const expectedRelief = Math.max(terrainMeters * 0.018, 8)
  const step = Math.max(terrain.radius * 0.010, 28) / Math.max(terrain.radius, 1)
  const sample = (ax: number, ay: number, az: number, direction: number) => {
    const sx = dir.x + ax * direction * step
    const sy = dir.y + ay * direction * step
    const sz = dir.z + az * direction * step
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz)
    if (len > 1e-8) {
      _aoSampleDir.x = sx / len
      _aoSampleDir.y = sy / len
      _aoSampleDir.z = sz / len
    } else {
      _aoSampleDir.x = 0
      _aoSampleDir.y = 1
      _aoSampleDir.z = 0
    }
    return samplePlanetHeight(_aoSampleDir, terrain)
  }

  let pairCount = 0
  for (let a = 0; a < MACRO_AO_AXES.length; a += 3) {
    if (!projectedTangentDirection(dir, MACRO_AO_AXES[a], MACRO_AO_AXES[a + 1], MACRO_AO_AXES[a + 2], _aoProjected)) continue
    const px = _aoProjected[0]
    const py = _aoProjected[1]
    const pz = _aoProjected[2]
    _aoPairsA[pairCount] = sample(px, py, pz, -1)
    _aoPairsB[pairCount] = sample(px, py, pz, 1)
    pairCount++
  }

  return sampleDirectionalAo(
    macroHeight,
    _aoPairsA,
    _aoPairsB,
    pairCount,
    terrainMeters,
    expectedRelief,
    0.10,
    1.05,
    0.18,
    1.80,
  )
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
  const microDetailAmount = 1

  const vertCount = gs * gs
  const positions = new Float32Array(vertCount * 3)
  const heights = new Float32Array(vertCount)
  const microAo = new Float32Array(vertCount)
  const macroAo = new Float32Array(vertCount)
  const grassPatch = new Float32Array(vertCount)

  for (let iy = 0; iy < gs; iy++) {
    for (let ix = 0; ix < gs; ix++) {
      const i = iy * gs + ix
      const u = u0 + ix * du
      const v = v0 + iy * dv

      const dir = cubeToSphere(node.face, u, v)
      const macroHeight = samplePlanetHeight(dir, terrain)
      const microHeight = samplePlanetMicroHeight(dir, terrain, macroHeight) * microDetailAmount
      const height = macroHeight + microHeight
      const radius = terrain.radius + height * terrain.terrainScale * terrain.radius
      positions[i * 3] = dir.x * radius
      positions[i * 3 + 1] = dir.y * radius
      positions[i * 3 + 2] = dir.z * radius
      heights[i] = height
      microAo[i] = computeMicroAoAtDirection(dir, macroHeight, microHeight, terrain)
      macroAo[i] = computeMacroAoAtDirection(dir, macroHeight, terrain)
      grassPatch[i] = computeGrassPatchMask(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], terrain.seed)
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
  const mainNormals = computeTerrainNormals(positions, terrain, normalSampleStep, microDetailAmount)

  if (!hasAnySkirt) {
    return {
      positions,
      heights,
      microAo,
      macroAo,
      grassPatch,
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
  const allMicroAo = new Float32Array(totalVertCount)
  const allMacroAo = new Float32Array(totalVertCount)
  const allGrassPatch = new Float32Array(totalVertCount)
  const allNormals = new Float32Array(totalVertCount * 3)
  allPositions.set(positions, 0)
  allHeights.set(heights, 0)
  allMicroAo.set(microAo, 0)
  allMacroAo.set(macroAo, 0)
  allGrassPatch.set(grassPatch, 0)
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
    allMicroAo[targetI] = microAo[mainI]
    allMacroAo[targetI] = macroAo[mainI]
    allGrassPatch[targetI] = grassPatch[mainI]
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
    microAo: allMicroAo,
    macroAo: allMacroAo,
    grassPatch: allGrassPatch,
    indices: allIndices,
    normals: allNormals,
    mainPositions: positions.slice(),
  }
}

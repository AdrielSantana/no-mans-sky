import { clamp, type Vec3Like } from './vector'

export interface PlanetTerrainParams {
  seed: number
  planetType: string
  radius: number
  terrainScale: number
  frequency: number
  octaves: number
}

function mod289(x: number): number {
  return x - Math.floor(x * (1 / 289)) * 289
}

function permute(x: number): number {
  return mod289((x * 34 + 1) * x)
}

function fract(x: number): number {
  return x - Math.floor(x)
}

function invSqrt(x: number): number {
  return 1 / Math.sqrt(x)
}

function grad4(j: number): [number, number, number, number] {
  const ipx = 1 / 294
  const ipy = 1 / 49
  const ipz = 1 / 7
  const x = Math.floor(fract(j * ipx) * 7) * ipz - 1
  const y = Math.floor(fract(j * ipy) * 7) * ipz - 1
  const z = Math.floor(fract(j * ipz) * 7) * ipz - 1
  let w = 1.5 - Math.abs(x) - Math.abs(y) - Math.abs(z)
  let px = x
  let py = y
  let pz = z

  if (w < 0) {
    px += px < 0 ? 1 : -1
    py += py < 0 ? 1 : -1
    pz += pz < 0 ? 1 : -1
  }

  const norm = invSqrt(px * px + py * py + pz * pz + w * w)
  return [px * norm, py * norm, pz * norm, w * norm]
}

function dot4(a: [number, number, number, number], x: number, y: number, z: number, w: number): number {
  return a[0] * x + a[1] * y + a[2] * z + a[3] * w
}

function snoise4(x: number, y: number, z: number, w: number): number {
  const f4 = 0.309016994374947451
  const c0 = 0.138196601125011
  const c1 = 0.276393202250021
  const c2 = 0.414589803375032
  const c3 = -0.447213595499958

  let ix = Math.floor(x + (x + y + z + w) * f4)
  let iy = Math.floor(y + (x + y + z + w) * f4)
  let iz = Math.floor(z + (x + y + z + w) * f4)
  let iw = Math.floor(w + (x + y + z + w) * f4)

  const iDotC = (ix + iy + iz + iw) * c0
  const x0 = x - ix + iDotC
  const y0 = y - iy + iDotC
  const z0 = z - iz + iDotC
  const w0 = w - iw + iDotC

  let rankX = 0
  let rankY = 0
  let rankZ = 0
  let rankW = 0
  if (x0 > y0) rankX++; else rankY++
  if (x0 > z0) rankX++; else rankZ++
  if (x0 > w0) rankX++; else rankW++
  if (y0 > z0) rankY++; else rankZ++
  if (y0 > w0) rankY++; else rankW++
  if (z0 > w0) rankZ++; else rankW++

  const i1x = rankX >= 3 ? 1 : 0
  const i1y = rankY >= 3 ? 1 : 0
  const i1z = rankZ >= 3 ? 1 : 0
  const i1w = rankW >= 3 ? 1 : 0
  const i2x = rankX >= 2 ? 1 : 0
  const i2y = rankY >= 2 ? 1 : 0
  const i2z = rankZ >= 2 ? 1 : 0
  const i2w = rankW >= 2 ? 1 : 0
  const i3x = rankX >= 1 ? 1 : 0
  const i3y = rankY >= 1 ? 1 : 0
  const i3z = rankZ >= 1 ? 1 : 0
  const i3w = rankW >= 1 ? 1 : 0

  const x1 = x0 - i1x + c0
  const y1 = y0 - i1y + c0
  const z1 = z0 - i1z + c0
  const w1 = w0 - i1w + c0
  const x2 = x0 - i2x + c1
  const y2 = y0 - i2y + c1
  const z2 = z0 - i2z + c1
  const w2 = w0 - i2w + c1
  const x3 = x0 - i3x + c2
  const y3 = y0 - i3y + c2
  const z3 = z0 - i3z + c2
  const w3 = w0 - i3w + c2
  const x4 = x0 + c3
  const y4 = y0 + c3
  const z4 = z0 + c3
  const w4 = w0 + c3

  ix = mod289(ix)
  iy = mod289(iy)
  iz = mod289(iz)
  iw = mod289(iw)

  const j0 = permute(permute(permute(permute(iw) + iz) + iy) + ix)
  const j1x = permute(permute(permute(permute(iw + i1w) + iz + i1z) + iy + i1y) + ix + i1x)
  const j1y = permute(permute(permute(permute(iw + i2w) + iz + i2z) + iy + i2y) + ix + i2x)
  const j1z = permute(permute(permute(permute(iw + i3w) + iz + i3z) + iy + i3y) + ix + i3x)
  const j1w = permute(permute(permute(permute(iw + 1) + iz + 1) + iy + 1) + ix + 1)

  const p0 = grad4(j0)
  const p1 = grad4(j1x)
  const p2 = grad4(j1y)
  const p3 = grad4(j1z)
  const p4 = grad4(j1w)

  let m0 = Math.max(0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0, 0)
  let m1 = Math.max(0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1, 0)
  let m2 = Math.max(0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2, 0)
  let m3 = Math.max(0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3, 0)
  let m4 = Math.max(0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4, 0)
  m0 *= m0
  m1 *= m1
  m2 *= m2
  m3 *= m3
  m4 *= m4

  return 49 * (
    m0 * m0 * dot4(p0, x0, y0, z0, w0) +
    m1 * m1 * dot4(p1, x1, y1, z1, w1) +
    m2 * m2 * dot4(p2, x2, y2, z2, w2) +
    m3 * m3 * dot4(p3, x3, y3, z3, w3) +
    m4 * m4 * dot4(p4, x4, y4, z4, w4)
  )
}

function terrainFbm(p: Vec3Like, seed: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let maxAmp = 0

  for (let i = 0; i < Math.min(8, octaves); i++) {
    sum += snoise4(p.x * freq, p.y * freq, p.z * freq, seed) * amp
    maxAmp += amp
    freq *= lacunarity
    amp *= gain
  }

  return maxAmp > 0 ? sum / maxAmp : 0
}

export function samplePlanetHeight(dir: Vec3Like, params: PlanetTerrainParams): number {
  const base = {
    x: dir.x * params.frequency,
    y: dir.y * params.frequency,
    z: dir.z * params.frequency,
  }
  const continental = terrainFbm(base, params.seed, Math.min(params.octaves, 4), 2, 0.5)
  const ridgeNoise = Math.abs(terrainFbm({
    x: dir.x * params.frequency * 2.6 + 17,
    y: dir.y * params.frequency * 2.6 + 17,
    z: dir.z * params.frequency * 2.6 + 17,
  }, params.seed + 9.7, 2, 2, 0.45))
  const ridges = Math.pow(1 - ridgeNoise, 2.4)
  const mountainMask = clamp((continental - 0.30) / (0.78 - 0.30), 0, 1)

  if (params.planetType === 'gas') return continental * 0.05
  return continental * 0.55 + ridges * mountainMask * 0.14
}

export function samplePlanetRadius(dir: Vec3Like, params: PlanetTerrainParams): number {
  return params.radius + samplePlanetHeight(dir, params) * params.terrainScale * params.radius
}

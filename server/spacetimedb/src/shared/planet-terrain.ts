import { clamp, normalize, type Vec3Like } from './vector'

export interface PlanetTerrainParams {
  seed: number
  planetType: string
  radius: number
  terrainScale: number
  frequency: number
  octaves: number
  lacunarity?: number
  gain?: number
  warpStrength?: number
  continentalScale?: number
  mountainScale?: number
  plainsScale?: number
  hillsScale?: number
  mountainBeltScale?: number
  reliefVariety?: number
  erosionStrength?: number
  thermalStrength?: number
  detailStrength?: number
  microDetailStrength?: number
  microDetailScale?: number
  microReliefMeters?: number
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

// Fused grad4 + dot4. The split version allocated a 4-tuple per call and is
// called five times per snoise4, i.e. 255 short-lived arrays per height sample —
// and a height sample runs per terrain vertex, per AO tap and per prop shadow
// ray. Fusing them removes the allocation entirely.
//
// The multiplication order below is deliberately `component * norm * coord`,
// matching the original `[px*norm, ...]` then `a[0]*x + ...`. Factoring `norm`
// out to the end is algebraically equal but not bit-equal: it diverges on ~46%
// of samples (max 7.6e-14). That is invisible on its own, but this module is
// shared with the SpacetimeDB server — client and server must agree on terrain
// height exactly, or players sink through the ground the server thinks is solid.
function grad4dot(j: number, x: number, y: number, z: number, w: number): number {
  const ipx = 1 / 294
  const ipy = 1 / 49
  const ipz = 1 / 7
  const gx = Math.floor(fract(j * ipx) * 7) * ipz - 1
  const gy = Math.floor(fract(j * ipy) * 7) * ipz - 1
  const gz = Math.floor(fract(j * ipz) * 7) * ipz - 1
  const gw = 1.5 - Math.abs(gx) - Math.abs(gy) - Math.abs(gz)
  let px = gx
  let py = gy
  let pz = gz

  if (gw < 0) {
    px += px < 0 ? 1 : -1
    py += py < 0 ? 1 : -1
    pz += pz < 0 ? 1 : -1
  }

  const norm = invSqrt(px * px + py * py + pz * pz + gw * gw)
  return px * norm * x + py * norm * y + pz * norm * z + gw * norm * w
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
    m0 * m0 * grad4dot(j0, x0, y0, z0, w0) +
    m1 * m1 * grad4dot(j1x, x1, y1, z1, w1) +
    m2 * m2 * grad4dot(j1y, x2, y2, z2, w2) +
    m3 * m3 * grad4dot(j1z, x3, y3, z3, w3) +
    m4 * m4 * grad4dot(j1w, x4, y4, z4, w4)
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

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function sampleWarpedDirection(dir: Vec3Like, params: PlanetTerrainParams, lacunarity: number, gain: number): Vec3Like {
  const warpStrength = params.warpStrength ?? 0.42
  if (warpStrength <= 0) return normalize(dir)

  const seed = params.seed
  const p = {
    x: dir.x * 1.35,
    y: dir.y * 1.35,
    z: dir.z * 1.35,
  }

  return normalize({
    x: dir.x + terrainFbm({ x: p.x + 11.3, y: p.y - 4.8, z: p.z + 7.1 }, seed + 101.7, 3, lacunarity, gain) * warpStrength * 0.36,
    y: dir.y + terrainFbm({ x: p.x - 8.2, y: p.y + 16.5, z: p.z + 2.4 }, seed + 211.3, 3, lacunarity, gain) * warpStrength * 0.36,
    z: dir.z + terrainFbm({ x: p.x + 5.6, y: p.y + 9.7, z: p.z - 13.8 }, seed + 307.9, 3, lacunarity, gain) * warpStrength * 0.36,
  })
}

export function samplePlanetHeight(
  dir: Vec3Like,
  params: PlanetTerrainParams,
  // Optional precomputed domain warp. samplePlanetHeightDetailed calls this and
  // samplePlanetMicroHeight back to back with the same direction, and both used
  // to derive the identical warp independently — 9 of the 78 snoise4 taps in a
  // detailed sample, duplicated.
  warpedDir?: Vec3Like,
): number {
  const lacunarity = params.lacunarity ?? 2
  const gain = params.gain ?? 0.5
  const baseDir = normalize(dir)
  const warped = warpedDir ?? sampleWarpedDirection(baseDir, params, lacunarity, gain)
  const frequency = params.frequency
  const octaves = Math.min(params.octaves, 8)

  const macro = {
    x: warped.x * frequency * 0.48,
    y: warped.y * frequency * 0.48,
    z: warped.z * frequency * 0.48,
  }
  const continentalRaw = terrainFbm(macro, params.seed, Math.min(octaves, 4), lacunarity, gain)
  const basinRaw = terrainFbm({
    x: warped.x * frequency * 0.22 + 19.1,
    y: warped.y * frequency * 0.22 - 5.4,
    z: warped.z * frequency * 0.22 + 12.6,
  }, params.seed + 43.1, 3, 2.05, 0.48)
  const continentMask = smoothstep(-0.28, 0.46, continentalRaw + basinRaw * 0.18)
  let continentHeight = (continentMask * 2 - 1) * 0.34 * (params.continentalScale ?? 1)

  const reliefVariety = clamp(params.reliefVariety ?? 0.7, 0, 2)
  const plainsScale = clamp(params.plainsScale ?? 0.55, 0, 2)
  const hillsScale = clamp(params.hillsScale ?? 0.45, 0, 2)
  const mountainBeltScale = clamp(params.mountainBeltScale ?? 0.75, 0, 2)

  const reliefRaw = terrainFbm({
    x: warped.x * frequency * 0.34 + 51.2,
    y: warped.y * frequency * 0.34 - 19.8,
    z: warped.z * frequency * 0.34 + 7.4,
  }, params.seed + 351.6, 3, 2.0, 0.5)
  const plainsMask = clamp(
    smoothstep(-0.12, 0.58, reliefRaw + basinRaw * 0.32)
      * smoothstep(0.10, 0.62, continentMask)
      * plainsScale,
    0,
    1,
  )
  const hillsRaw = terrainFbm({
    x: warped.x * frequency * 0.92 - 14.7,
    y: warped.y * frequency * 0.92 + 33.3,
    z: warped.z * frequency * 0.92 - 6.1,
  }, params.seed + 419.2, 3, 2.05, 0.48)
  const hillsMask = clamp(
    smoothstep(-0.34, 0.48, hillsRaw + reliefRaw * 0.18)
      * smoothstep(0.18, 0.72, continentMask)
      * (1 - plainsMask * 0.55)
      * hillsScale,
    0,
    1,
  )
  const plainFlatten = plainsMask * reliefVariety * 0.46
  continentHeight = mix(continentHeight, continentHeight * 0.68 + basinRaw * 0.030, clamp(plainFlatten, 0, 0.78))

  let lowlandUndulation = terrainFbm({
    x: warped.x * frequency * 1.18 + 3.7,
    y: warped.y * frequency * 1.18 - 8.1,
    z: warped.z * frequency * 1.18 + 4.2,
  }, params.seed + 17.5, Math.min(octaves, 5), lacunarity, gain) * 0.105

  const plateNoise = Math.abs(terrainFbm({
    x: warped.x * frequency * 0.82 - 23.5,
    y: warped.y * frequency * 0.82 + 6.2,
    z: warped.z * frequency * 0.82 + 14.8,
  }, params.seed + 83.4, 4, 2.1, 0.52))
  const plateBoundary = Math.pow(1 - clamp(plateNoise, 0, 1), 3.15)

  const ridgeNoise = Math.abs(terrainFbm({
    x: warped.x * frequency * 2.75 + 17,
    y: warped.y * frequency * 2.75 + 17,
    z: warped.z * frequency * 2.75 + 17,
  }, params.seed + 9.7, Math.min(4, Math.max(2, octaves - 2)), lacunarity, gain * 0.92))
  const mountainSharpness = mix(2.65, 1.85, clamp(params.thermalStrength ?? 0.2, 0, 1) * 0.45)
  const ridges = Math.pow(1 - clamp(ridgeNoise, 0, 1), mountainSharpness)
  const beltNoise = terrainFbm({
    x: warped.x * frequency * 0.58 + 71.0,
    y: warped.y * frequency * 0.58 + 11.0,
    z: warped.z * frequency * 0.58 - 47.0,
  }, params.seed + 503.5, 3, 2.0, 0.5)
  const mountainBeltMask = clamp(
    smoothstep(0.18, 0.82, plateBoundary + (1 - Math.abs(beltNoise)) * 0.36)
      * smoothstep(0.30, 0.88, continentMask)
      * (1 - plainsMask * 0.84)
      * mountainBeltScale,
    0,
    1,
  )
  const baseMountainMask = smoothstep(0.36, 0.95, continentMask + plateBoundary * 0.62)
  const regionalMountainMask = baseMountainMask
    * clamp(0.24 + mountainBeltMask * 1.18 + hillsMask * 0.24 - plainsMask * 0.72, 0, 1.35)
  const mountainMask = mix(baseMountainMask, regionalMountainMask, clamp(reliefVariety, 0, 1))
  const mountains = ridges * mountainMask * (0.12 + plateBoundary * 0.21) * (params.mountainScale ?? 1)
  lowlandUndulation *= mix(
    1,
    clamp(0.38 + hillsMask * 0.70 + mountainBeltMask * 0.18 - plainsMask * 0.20, 0.25, 1.12),
    clamp(reliefVariety, 0, 1),
  )
  const hills = terrainFbm({
    x: warped.x * frequency * 1.85 + 23.0,
    y: warped.y * frequency * 1.85 - 13.0,
    z: warped.z * frequency * 1.85 + 39.0,
  }, params.seed + 557.8, Math.min(octaves, 4), 2.12, 0.48) * 0.052 * hillsMask * reliefVariety

  const erosionStrength = params.erosionStrength ?? 0.34
  let hydraulicCut = 0
  let sedimentFill = 0
  if (erosionStrength > 0.001) {
    const drainageNoise = Math.abs(terrainFbm({
      x: warped.x * frequency * 5.8 - 31.0,
      y: warped.y * frequency * 5.8 + 27.0,
      z: warped.z * frequency * 5.8 + 4.0,
    }, params.seed + 131.9, 4, 2.22, 0.46))
    const channels = Math.pow(1 - clamp(drainageNoise, 0, 1), 6.5)
      * smoothstep(0.08, 0.82, continentMask)
      * (1 - smoothstep(0.20, 0.44, mountains))
    hydraulicCut = channels * erosionStrength * (0.055 + continentMask * 0.045)
    sedimentFill = channels * erosionStrength * smoothstep(-0.18, 0.10, continentHeight) * 0.018
  }

  const thermalStrength = params.thermalStrength ?? 0.2
  const thermalTalus = thermalStrength <= 0.001
    ? 0
    : Math.max(0, mountains - 0.10) * thermalStrength * 0.23

  const detailStrength = params.detailStrength ?? 0.55
  let detail = 0
  if (detailStrength > 0.001) {
    const fineNoise = terrainFbm({
      x: warped.x * frequency * 10.5 + 41.0,
      y: warped.y * frequency * 10.5 - 11.0,
      z: warped.z * frequency * 10.5 + 29.0,
    }, params.seed + 251.7, Math.min(octaves, 5), 2.28, 0.42)
    const badlands = Math.pow(1 - Math.abs(fineNoise), 4.2)
      * smoothstep(0.22, 0.76, continentMask)
      * (1 - smoothstep(0.05, 0.22, mountains))
    const detailRegion = mix(1, clamp(0.34 + hillsMask * 0.42 + mountainBeltMask * 0.52 - plainsMask * 0.30, 0.22, 1.15), clamp(reliefVariety, 0, 1))
    detail = (fineNoise * 0.026 + badlands * 0.032) * detailStrength * (1 - thermalStrength * 0.35) * detailRegion
  }

  if (params.planetType === 'gas') {
    return terrainFbm({ x: baseDir.x * frequency, y: baseDir.y * frequency, z: baseDir.z * frequency }, params.seed, Math.min(octaves, 4), lacunarity, gain) * 0.05
  }

  if (params.planetType === 'ice') {
    return continentHeight * 0.72
      + lowlandUndulation * 0.55
      + hills * 0.42
      + mountains * 0.58
      - hydraulicCut * 0.38
      - thermalTalus * 0.45
      + detail * 0.42
      + smoothstep(0.50, 0.95, Math.abs(baseDir.y)) * 0.045
  }

  return continentHeight
    + lowlandUndulation
    + hills
    + mountains
    - hydraulicCut
    + sedimentFill
    - thermalTalus
    + detail
}

export function samplePlanetMicroHeight(
  dir: Vec3Like,
  params: PlanetTerrainParams,
  macroHeight = samplePlanetHeight(dir, params),
  warpedDir?: Vec3Like,
): number {
  if (params.planetType === 'gas') return 0

  const terrainMeters = Math.max(params.terrainScale * params.radius, 0.001)
  const strength = params.microDetailStrength ?? (params.planetType === 'ice' ? 0.48 : 0.5)
  if (strength <= 0.001) return 0

  const lacunarity = params.lacunarity ?? 2
  const gain = params.gain ?? 0.5
  const warped = warpedDir ?? sampleWarpedDirection(normalize(dir), params, lacunarity, gain)
  const scale = Math.max(params.microDetailScale ?? (params.planetType === 'ice' ? 1.15 : 2.5), 0.05)
  const radius = Math.max(params.radius, 1)
  const freqForMeters = (meters: number) => radius / Math.max(meters * scale, 0.25)

  const broad = terrainFbm({
    x: warped.x * freqForMeters(24) + 12.7,
    y: warped.y * freqForMeters(24) - 31.1,
    z: warped.z * freqForMeters(24) + 7.4,
  }, params.seed + 1701.4, 3, 2.0, 0.52)
  const medium = terrainFbm({
    x: warped.x * freqForMeters(9) - 42.0,
    y: warped.y * freqForMeters(9) + 8.5,
    z: warped.z * freqForMeters(9) + 19.3,
  }, params.seed + 1823.8, 4, 2.14, 0.48)
  const fine = terrainFbm({
    x: warped.x * freqForMeters(3.2) + 4.2,
    y: warped.y * freqForMeters(3.2) + 51.6,
    z: warped.z * freqForMeters(3.2) - 27.0,
  }, params.seed + 1941.6, 3, 2.22, 0.43)

  const channelRaw = Math.abs(terrainFbm({
    x: warped.x * freqForMeters(16) - 18.0,
    y: warped.y * freqForMeters(16) + 29.0,
    z: warped.z * freqForMeters(16) + 3.0,
  }, params.seed + 2031.2, 3, 2.18, 0.46))
  const ledgeRaw = Math.abs(terrainFbm({
    x: warped.x * freqForMeters(6.2) + 37.0,
    y: warped.y * freqForMeters(6.2) - 12.0,
    z: warped.z * freqForMeters(6.2) + 45.0,
  }, params.seed + 2137.9, 3, 2.2, 0.45))

  const channels = Math.pow(1 - clamp(channelRaw, 0, 1), 5.8)
  const ledges = Math.pow(1 - clamp(ledgeRaw, 0, 1), 3.2)
  const highland = smoothstep(0.05, 0.46, macroHeight)
  const lowland = 1 - smoothstep(0.18, 0.58, macroHeight)
  const shelf = smoothstep(-0.22, 0.16, macroHeight) * (1 - smoothstep(0.42, 0.78, macroHeight))
  const regionalVariety = terrainFbm({
    x: warped.x * freqForMeters(90) + 72.0,
    y: warped.y * freqForMeters(90) - 13.0,
    z: warped.z * freqForMeters(90) + 21.0,
  }, params.seed + 2211.5, 2, 2.0, 0.5) * 0.5 + 0.5
  const activeRegion = clamp(0.34 + shelf * 0.40 + highland * 0.24 + regionalVariety * 0.34, 0.18, 1.16)

  let meters = broad * (0.95 + lowland * 0.36)
  meters += medium * (0.52 + highland * 0.42)
  meters += fine * 0.22
  meters += ledges * (0.74 + highland * 0.58)
  meters -= channels * (0.72 + lowland * 0.34)

  if (params.planetType === 'ice') {
    meters = broad * 0.54 + medium * 0.26 + fine * 0.12 - channels * 0.32 + ledges * 0.24
  }

  const reliefMeters = params.microReliefMeters ?? (params.planetType === 'ice' ? 1.35 : 1.5)
  return clamp(meters * activeRegion * reliefMeters * strength, -4.8, 5.6) / terrainMeters
}

export function samplePlanetHeightDetailed(
  dir: Vec3Like,
  params: PlanetTerrainParams,
  microAmount = 1,
): number {
  // Derive the warp once and hand it to both samplers.
  const lacunarity = params.lacunarity ?? 2
  const gain = params.gain ?? 0.5
  const warped = sampleWarpedDirection(normalize(dir), params, lacunarity, gain)

  const macroHeight = samplePlanetHeight(dir, params, warped)
  const amount = clamp(microAmount, 0, 1)
  if (amount <= 0.001) return macroHeight

  return macroHeight + samplePlanetMicroHeight(dir, params, macroHeight, warped) * amount
}

export function samplePlanetRadius(dir: Vec3Like, params: PlanetTerrainParams): number {
  return params.radius + samplePlanetHeight(dir, params) * params.terrainScale * params.radius
}

export function samplePlanetRadiusDetailed(
  dir: Vec3Like,
  params: PlanetTerrainParams,
  microAmount = 1,
): number {
  return params.radius + samplePlanetHeightDetailed(dir, params, microAmount) * params.terrainScale * params.radius
}

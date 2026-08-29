import {
  samplePlanetHeightDetailed,
  type PlanetTerrainParams,
} from '../../../../server/spacetimedb/src/shared/planet-terrain'

// Per-instance sun occlusion for scattered props, shared verbatim by
// PlanetPropLayer and the terrain worker. No three.js import: this module is
// pulled into the worker bundle.
//
// The whole computation is pure -- it reads only the placement arrays, the sun
// direction and the terrain params -- which is what makes it movable off the
// main thread.

export const SUN_SHADOW_SAMPLE_FACTORS = [0.04, 0.08, 0.16, 0.30, 0.52, 0.86, 1.35, 2.10, 3.25, 5.0, 7.5]
export const SUN_SHADOW_CLEARANCE = 4.0

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

// The distance weight depends only on the factor, so it is precomputed once
// rather than as two smoothsteps per sample per instance. Zero-weight samples
// are dropped outright: the first factor (0.04) sits exactly on the lower edge
// of smoothstep(0.04, 0.42, ...), so its weight is exactly 0 and its
// contribution to `blocker` -- a running max -- is a guaranteed no-op. It cost
// a full samplePlanetHeightDetailed per instance to add nothing.
export const SUN_SHADOW_SAMPLES: { factor: number; weight: number }[] = SUN_SHADOW_SAMPLE_FACTORS
  .map(factor => ({
    factor,
    weight: smoothstep(0.04, 0.42, factor) * (1 - smoothstep(7.0, 8.5, factor)),
  }))
  .filter(sample => sample.weight > 0)

export interface PropSunLightInput {
  planetDirs: Float32Array
  terrainNormals: Float32Array
  surfaceRadii: Float32Array
  sunX: number
  sunY: number
  sunZ: number
}

const _sampleDir = { x: 0, y: 0, z: 0 }

function computeHorizonSunLight(
  terrain: PlanetTerrainParams,
  rx: number, ry: number, rz: number,
  tx: number, ty: number, tz: number,
  sunSlope: number,
  originRadius: number,
  terrainMeters: number,
): number {
  let blocker = 0
  const stylizedSunSlope = sunSlope * 0.42 - 0.035
  const planetRadius = Math.max(terrain.radius, 1)

  for (const { factor, weight } of SUN_SHADOW_SAMPLES) {
    const angle = (terrainMeters * factor) / planetRadius
    const sinAngle = Math.sin(angle)
    const cosAngle = Math.cos(angle)

    // radial * cos + tangent * sin, normalised
    const sx = rx * cosAngle + tx * sinAngle
    const sy = ry * cosAngle + ty * sinAngle
    const sz = rz * cosAngle + tz * sinAngle
    const length = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1
    _sampleDir.x = sx / length
    _sampleDir.y = sy / length
    _sampleDir.z = sz / length

    const sampleHeight = samplePlanetHeightDetailed(_sampleDir, terrain, 0.35)
    const sampleRadius = terrain.radius + sampleHeight * terrainMeters
    const vertical = sampleRadius * cosAngle - originRadius - SUN_SHADOW_CLEARANCE
    const horizontal = Math.max(sampleRadius * sinAngle, 1e-3)
    const obstacleSlope = vertical / horizontal
    blocker = Math.max(blocker, smoothstep(-0.015, 0.080, obstacleSlope - stylizedSunSlope) * weight)
    if (blocker >= 0.995) break
  }

  return 1 - blocker
}

// Writes one value per instance into `out`.
//
// `skipHorizon` drops the terrain-occlusion raymarch and keeps only the surface
// normal term. That is the cheap approximation used to light a layer on the
// frame it is created, so trees are not black while the worker refines them:
// it differs only where terrain actually casts a shadow.
export function computePropSunLight(
  input: PropSunLightInput,
  terrain: PlanetTerrainParams,
  out: Float32Array,
  skipHorizon = false,
): void {
  const { planetDirs, terrainNormals, surfaceRadii, sunX, sunY, sunZ } = input
  const terrainMeters = Math.max(terrain.terrainScale * terrain.radius, 1)
  const count = out.length

  for (let i = 0; i < count; i++) {
    const o = i * 3
    let rx = planetDirs[o]
    let ry = planetDirs[o + 1]
    let rz = planetDirs[o + 2]
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
    rx /= rl; ry /= rl; rz /= rl

    let nx = terrainNormals[o]
    let ny = terrainNormals[o + 1]
    let nz = terrainNormals[o + 2]
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= nl; ny /= nl; nz /= nl

    const radialSun = rx * sunX + ry * sunY + rz * sunZ
    let tx = sunX - rx * radialSun
    let ty = sunY - ry * radialSun
    let tz = sunZ - rz * radialSun
    const tangentLen = Math.sqrt(tx * tx + ty * ty + tz * tz)
    const normalSun = nx * sunX + ny * sunY + nz * sunZ

    let sunlight = 0
    if (radialSun > -0.08 && tangentLen > 1e-5) {
      const normalGate = smoothstep(-0.04, 0.18, normalSun)
      if (skipHorizon) {
        sunlight = normalGate
      } else {
        tx /= tangentLen; ty /= tangentLen; tz /= tangentLen
        const horizonGate = computeHorizonSunLight(
          terrain,
          rx, ry, rz,
          tx, ty, tz,
          radialSun / tangentLen,
          surfaceRadii[i],
          terrainMeters,
        )
        sunlight = Math.min(normalGate, horizonGate)
      }
    } else if (radialSun > 0.35) {
      sunlight = smoothstep(-0.08, 0.24, normalSun)
    }

    out[i] = clamp(sunlight, 0, 1)
  }
}

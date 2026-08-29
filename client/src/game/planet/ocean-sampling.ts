import {
  samplePlanetHeightDetailed,
  type PlanetTerrainParams,
} from '../../../../server/spacetimedb/src/shared/planet-terrain'

// Shared by PlanetRenderer and the terrain worker so the two can never produce
// different water. Deliberately free of any three.js import: this module is
// pulled into the worker bundle.

export interface OceanShoreMaskParams {
  width: number
  height: number
  seaHeight: number
  bias: number
  surfaceEdge: number
  depthScale: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

const _dir = { x: 0, y: 0, z: 0 }

// 512x256 texels, each a full detailed height sample. This is the larger half
// of what used to be ~2.7s of synchronous work in the PlanetRenderer
// constructor.
export function buildOceanShoreMask(
  terrain: PlanetTerrainParams,
  params: OceanShoreMaskParams,
  rowStart = 0,
  rowEnd = params.height,
): Uint8Array {
  const { width, height, seaHeight, bias, surfaceEdge, depthScale } = params
  const data = new Uint8Array(width * Math.max(0, rowEnd - rowStart) * 4)

  for (let y = rowStart; y < rowEnd; y++) {
    const v = (y + 0.5) / height
    const latitude = (v - 0.5) * Math.PI
    const sinLat = Math.sin(latitude)
    const cosLat = Math.cos(latitude)

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      const longitude = (u - 0.5) * Math.PI * 2
      const index = ((y - rowStart) * width + x) * 4

      _dir.x = Math.cos(longitude) * cosLat
      _dir.y = sinLat
      _dir.z = Math.sin(longitude) * cosLat
      // microAmount stays at 1. Dropping it would be much cheaper but the mask
      // drives the ocean shader's discard, i.e. exactly where water stops, and
      // the terrain mesh is built *with* micro detail — mismatching the two
      // desynchronises the waterline by tens of metres on shallow beaches.
      const terrainHeight = samplePlanetHeightDetailed(_dir, terrain, 1)
      const waterDepth = seaHeight - terrainHeight
      const waterMask = smoothstep(-bias, surfaceEdge, waterDepth)
      const depthMask = clamp(waterDepth / depthScale, 0, 1)

      data[index] = Math.round(waterMask * 255)
      data[index + 1] = Math.round(depthMask * 255)
      data[index + 2] = 0
      data[index + 3] = 255
    }
  }

  return data
}

// `directions` is a flat xyz array of already-normalised ocean mesh vertex
// directions. Returns one detailed terrain height per vertex.
export function buildOceanVertexHeights(
  directions: Float32Array,
  terrain: PlanetTerrainParams,
): Float32Array {
  const count = directions.length / 3
  const heights = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    _dir.x = directions[i * 3]
    _dir.y = directions[i * 3 + 1]
    _dir.z = directions[i * 3 + 2]
    heights[i] = samplePlanetHeightDetailed(_dir, terrain, 1)
  }

  return heights
}

import type { PlanetTerrainParams } from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { QuadtreeNode } from './quadtree'
import type { SkirtFlags, TerrainChunkGeometryData } from './terrain-geometry'
import type { OceanShoreMaskParams } from './ocean-sampling'

export interface TerrainWorkerBuildRequest {
  type: 'build'
  id: number
  epoch: number
  key: string
  node: QuadtreeNode
  terrain: PlanetTerrainParams
  gridSize: number
  skirts: SkirtFlags
}

export interface TerrainWorkerBuildResponse {
  type: 'built'
  id: number
  epoch: number
  key: string
  node: QuadtreeNode
  durationMs: number
  geometry: TerrainChunkGeometryData
}

export interface TerrainWorkerErrorResponse {
  type: 'error'
  id: number
  epoch: number
  key: string
  message: string
}

// The ocean job is dispatched to a dedicated one-shot worker rather than the
// chunk pool: the pool's slots are keyed by chunk key and epoch, and threading a
// differently-shaped job through that scheduling would tangle it for no gain.
export interface TerrainWorkerOceanRequest {
  type: 'ocean'
  id: number
  // Index of this slice within the job, so partial results can be reassembled.
  slice: number
  terrain: PlanetTerrainParams
  // Vertex directions for this slice only.
  directions: Float32Array
  vertexOffset: number
  shoreMask: OceanShoreMaskParams
  // Half-open row range of the shore mask this slice owns. Texels are
  // independent, so splitting by rows is exact.
  rowStart: number
  rowEnd: number
}

export interface TerrainWorkerOceanResponse {
  type: 'ocean-built'
  id: number
  slice: number
  durationMs: number
  heights: Float32Array
  vertexOffset: number
  shoreMask: Uint8Array
  rowStart: number
  rowEnd: number
}

export interface TerrainWorkerOceanErrorResponse {
  type: 'ocean-error'
  id: number
  slice: number
  message: string
}

// One job per prop layer rather than per placement: a layer is the unit that
// gets created, disposed and invalidated, so tracking staleness per layer keeps
// the bookkeeping honest.
export interface PropSunPlacementInput {
  planetDirs: Float32Array
  terrainNormals: Float32Array
  surfaceRadii: Float32Array
  count: number
}

export interface TerrainWorkerPropSunRequest {
  type: 'prop-sun'
  id: number
  terrain: PlanetTerrainParams
  sunX: number
  sunY: number
  sunZ: number
  placements: PropSunPlacementInput[]
}

export interface TerrainWorkerPropSunResponse {
  type: 'prop-sun-built'
  id: number
  durationMs: number
  results: Float32Array[]
}

export interface TerrainWorkerPropSunErrorResponse {
  type: 'prop-sun-error'
  id: number
  message: string
}

export type TerrainWorkerRequest =
  | TerrainWorkerBuildRequest
  | TerrainWorkerOceanRequest
  | TerrainWorkerPropSunRequest
export type TerrainWorkerResponse =
  | TerrainWorkerBuildResponse
  | TerrainWorkerErrorResponse
  | TerrainWorkerOceanResponse
  | TerrainWorkerOceanErrorResponse
  | TerrainWorkerPropSunResponse
  | TerrainWorkerPropSunErrorResponse

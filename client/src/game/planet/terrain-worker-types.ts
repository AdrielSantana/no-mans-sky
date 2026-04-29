import type { PlanetTerrainParams } from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { QuadtreeNode } from './quadtree'
import type { SkirtFlags, TerrainChunkGeometryData } from './terrain-geometry'

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

export type TerrainWorkerRequest = TerrainWorkerBuildRequest
export type TerrainWorkerResponse = TerrainWorkerBuildResponse | TerrainWorkerErrorResponse

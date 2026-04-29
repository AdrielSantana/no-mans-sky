import { buildTerrainChunkGeometryData } from './terrain-geometry'
import type {
  TerrainWorkerBuildResponse,
  TerrainWorkerErrorResponse,
  TerrainWorkerRequest,
} from './terrain-worker-types'

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null
  postMessage: (message: TerrainWorkerBuildResponse | TerrainWorkerErrorResponse, transfer?: Transferable[]) => void
}

ctx.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  const request = event.data

  try {
    const start = performance.now()
    const geometry = buildTerrainChunkGeometryData(
      request.node,
      request.terrain,
      request.gridSize,
      request.skirts,
    )
    const response: TerrainWorkerBuildResponse = {
      type: 'built',
      id: request.id,
      epoch: request.epoch,
      key: request.key,
      node: request.node,
      durationMs: performance.now() - start,
      geometry,
    }

    ctx.postMessage(response, [
      geometry.positions.buffer,
      geometry.normals.buffer,
      geometry.heights.buffer,
      geometry.indices.buffer,
      geometry.mainPositions.buffer,
    ])
  } catch (error) {
    const response: TerrainWorkerErrorResponse = {
      type: 'error',
      id: request.id,
      epoch: request.epoch,
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
    }
    ctx.postMessage(response)
  }
}

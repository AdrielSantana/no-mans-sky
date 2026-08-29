import { buildTerrainChunkGeometryData } from './terrain-geometry'
import { buildOceanShoreMask, buildOceanVertexHeights } from './ocean-sampling'
import { computePropSunLight } from './prop-sun-light'
import type {
  TerrainWorkerBuildResponse,
  TerrainWorkerErrorResponse,
  TerrainWorkerOceanErrorResponse,
  TerrainWorkerOceanResponse,
  TerrainWorkerRequest,
  TerrainWorkerResponse,
} from './terrain-worker-types'

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null
  postMessage: (message: TerrainWorkerResponse, transfer?: Transferable[]) => void
}

function handleOcean(request: Extract<TerrainWorkerRequest, { type: 'ocean' }>) {
  try {
    const start = performance.now()
    const heights = buildOceanVertexHeights(request.directions, request.terrain)
    const shoreMask = buildOceanShoreMask(
      request.terrain,
      request.shoreMask,
      request.rowStart,
      request.rowEnd,
    )
    const response: TerrainWorkerOceanResponse = {
      type: 'ocean-built',
      id: request.id,
      slice: request.slice,
      durationMs: performance.now() - start,
      heights,
      vertexOffset: request.vertexOffset,
      shoreMask,
      rowStart: request.rowStart,
      rowEnd: request.rowEnd,
    }
    ctx.postMessage(response, [heights.buffer, shoreMask.buffer])
  } catch (error) {
    const response: TerrainWorkerOceanErrorResponse = {
      type: 'ocean-error',
      id: request.id,
      slice: request.slice,
      message: error instanceof Error ? error.message : String(error),
    }
    ctx.postMessage(response)
  }
}

function handlePropSun(request: Extract<TerrainWorkerRequest, { type: 'prop-sun' }>) {
  try {
    const start = performance.now()
    const results = request.placements.map((placement) => {
      const out = new Float32Array(placement.count)
      computePropSunLight(
        {
          planetDirs: placement.planetDirs,
          terrainNormals: placement.terrainNormals,
          surfaceRadii: placement.surfaceRadii,
          sunX: request.sunX,
          sunY: request.sunY,
          sunZ: request.sunZ,
        },
        request.terrain,
        out,
      )
      return out
    })
    ctx.postMessage(
      { type: 'prop-sun-built', id: request.id, durationMs: performance.now() - start, results },
      results.map(r => r.buffer),
    )
  } catch (error) {
    ctx.postMessage({
      type: 'prop-sun-error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

ctx.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  const request = event.data

  if (request.type === 'ocean') {
    handleOcean(request)
    return
  }

  if (request.type === 'prop-sun') {
    handlePropSun(request)
    return
  }

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
      geometry.microAo.buffer,
      geometry.macroAo.buffer,
      geometry.grassPatch.buffer,
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

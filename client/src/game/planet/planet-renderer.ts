import * as THREE from 'three'
import {
  CubeFace,
  NUM_FACES,
  LOD_DISTANCE_MULTIPLIERS,
  type QuadtreeNode,
  createRoot,
  createChildren,
  nodeKey,
  getNodeCenter,
} from './quadtree'
import { TerrainChunk, type SkirtFlags } from './terrain-chunk'
import {
  createAtmosphereMaterial,
  createPlanetFarMaterial,
  createOceanMaterial,
  createPlanetMaterial,
  createPlanetFallbackMaterial,
  getSeaHeight,
  PlanetGenerator,
} from './planet-generator'
import { WORLD_SCALE } from '../world-scale'
import { samplePlanetHeight, samplePlanetRadius, type PlanetTerrainParams } from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { Vec3Like } from '../../../../server/spacetimedb/src/shared/vector'
import type { TerrainWorkerBuildResponse, TerrainWorkerResponse } from './terrain-worker-types'
import type { TerrainChunkGeometryData } from './terrain-geometry'

const SYNC_CHUNK_BUILD_BUDGET_MS = 4
const WORKER_DISPATCH_BUDGET_MS = 0.8
const CHUNK_INTEGRATION_BUDGET_MS = 2.5
const MAX_TERRAIN_WORKERS = 2
const DETAILED_MATERIAL_MIN_LOD = 6
const DETAILED_MATERIAL_DISTANCE = WORLD_SCALE.localDetailNear * 2.2
const LOD_COLLAPSE_HYSTERESIS = 1.35

interface TerrainWorkerSlot {
  worker: Worker
  busy: boolean
  key: string | null
  jobId: number | null
  epoch: number
}

export class PlanetRenderer {
  private group: THREE.Group
  private planetRadius: number
  private noiseProfile: {
    octaves: number
    lacunarity: number
    gain: number
    frequency: number
    warpStrength: number
    continentalScale: number
    mountainScale: number
    erosionStrength: number
    thermalStrength: number
    detailStrength: number
    seed: number
  }
  private maxLod: number
  private gridSize: number
  private skirts: boolean
  private horizonMargin: number
  private material: THREE.ShaderMaterial
  private farMaterial: THREE.ShaderMaterial
  private fallbackMaterial: THREE.ShaderMaterial
  private oceanMaterial: THREE.ShaderMaterial | null = null
  private atmosphereMaterial: THREE.ShaderMaterial | null = null
  private quadtrees: QuadtreeNode[] = []
  private chunks = new Map<string, TerrainChunk>()
  private fallbackSphere: THREE.Mesh
  private oceanMesh: THREE.Mesh | null = null
  private atmosphereMesh: THREE.Mesh | null = null
  private sunPosition = new THREE.Vector3(0, 0, 0)
  private terrainParams: PlanetTerrainParams
  private lodDistances: number[]
  private time = 0

  // Chunk generation queue
  private pendingKeys = new Set<string>()
  private pendingCollapseKeys = new Set<string>()
  private pendingWorkerKeys = new Set<string>()
  private completedWorkerJobs: TerrainWorkerBuildResponse[] = []
  private workerSlots: TerrainWorkerSlot[] = []
  private chunkBuildEpoch = 0
  private nextWorkerJobId = 1
  private generatedChunksLastFrame = 0
  private chunkGenerationMsLastFrame = 0
  private chunkIntegrationMsLastFrame = 0

  constructor(
    scene: THREE.Scene,
    planetRadius: number,
    params: {
      seed: bigint
      planetType: string
      terrainScale: number
      waterLevel: number
      colorA: string
      colorB: string
      atmosphereColor: string
      atmosphereDensity: number
      noiseProfile?: {
        octaves: number
        lacunarity: number
        gain: number
        frequency: number
        warpStrength?: number
        continentalScale?: number
        mountainScale?: number
        erosionStrength?: number
        thermalStrength?: number
        detailStrength?: number
      }
      lodMultipliers?: number[]
      gridSize?: number
      skirts?: boolean
      horizonMargin?: number
    },
  ) {
    this.planetRadius = planetRadius
    this.gridSize = params.gridSize ?? 33
    this.skirts = params.skirts ?? true
    this.horizonMargin = params.horizonMargin ?? 1.0
    this.group = new THREE.Group()
    scene.add(this.group)

    // Precompute LOD distances:
    // - Level 0 (root): Infinity (never splits)
    // - Level 1 (coarsest): radius-proportional for orbital view
    // - Levels 2+: absolute camera distances capped by geometric series.
    //   This gives consistent surface detail regardless of planet size.
    const multipliers = params.lodMultipliers
      ? [Infinity, ...params.lodMultipliers]
      : LOD_DISTANCE_MULTIPLIERS
    this.maxLod = multipliers.length - 1
    const ABSOLUTE_BASE = 50   // finest LOD covers 50 units near camera
    const ABSOLUTE_RATIO = 2.5 // each coarser level is 2.5x further
    this.lodDistances = multipliers.map((m, i) => {
      if (m === Infinity) return Infinity
      const radiusBased = m * planetRadius
      if (i === 1) return radiusBased // coarsest: radius-proportional for orbital view
      // Cap to absolute distance for consistent camera-relative detail
      const levelsFromFinest = this.maxLod - i
      const absoluteCap = ABSOLUTE_BASE * Math.pow(ABSOLUTE_RATIO, levelsFromFinest)
      return Math.min(radiusBased, absoluteCap)
    })

    this.noiseProfile = {
      ...PlanetGenerator.fromParams(params),
      ...params.noiseProfile,
      seed: Number(params.seed),
    }
    this.terrainParams = {
      seed: this.noiseProfile.seed,
      planetType: params.planetType,
      radius: planetRadius,
      terrainScale: params.terrainScale,
      frequency: this.noiseProfile.frequency,
      octaves: this.noiseProfile.octaves,
      lacunarity: this.noiseProfile.lacunarity,
      gain: this.noiseProfile.gain,
      warpStrength: this.noiseProfile.warpStrength,
      continentalScale: this.noiseProfile.continentalScale,
      mountainScale: this.noiseProfile.mountainScale,
      erosionStrength: this.noiseProfile.erosionStrength,
      thermalStrength: this.noiseProfile.thermalStrength,
      detailStrength: this.noiseProfile.detailStrength,
    }

    this.material = createPlanetMaterial({
      seed: Number(params.seed),
      planetType: params.planetType,
      waterLevel: params.waterLevel,
      terrainScale: params.terrainScale,
      localDetailNear: WORLD_SCALE.localDetailNear,
      localDetailFar: WORLD_SCALE.localDetailFar,
      colorA: params.colorA,
      colorB: params.colorB,
      atmosphereColor: params.atmosphereColor,
      sunPosition: this.sunPosition,
      planetRadius: planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
    })
    this.farMaterial = createPlanetFarMaterial({
      seed: Number(params.seed),
      planetType: params.planetType,
      waterLevel: params.waterLevel,
      terrainScale: params.terrainScale,
      colorA: params.colorA,
      colorB: params.colorB,
      sunPosition: this.sunPosition,
      planetRadius: planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
      lacunarity: this.noiseProfile.lacunarity,
      gain: this.noiseProfile.gain,
      warpStrength: this.noiseProfile.warpStrength,
      continentalScale: this.noiseProfile.continentalScale,
      mountainScale: this.noiseProfile.mountainScale,
      erosionStrength: this.noiseProfile.erosionStrength,
      thermalStrength: this.noiseProfile.thermalStrength,
      detailStrength: this.noiseProfile.detailStrength,
    })

    // Fallback low-poly sphere for distant view
    const fallbackGeo = this.createFallbackGeometry(planetRadius)
    this.fallbackMaterial = createPlanetFallbackMaterial({
      seed: Number(params.seed),
      planetType: params.planetType,
      waterLevel: params.waterLevel,
      colorA: params.colorA,
      colorB: params.colorB,
      sunPosition: this.sunPosition,
      planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
      lacunarity: this.noiseProfile.lacunarity,
      gain: this.noiseProfile.gain,
      warpStrength: this.noiseProfile.warpStrength,
      continentalScale: this.noiseProfile.continentalScale,
      mountainScale: this.noiseProfile.mountainScale,
      erosionStrength: this.noiseProfile.erosionStrength,
      thermalStrength: this.noiseProfile.thermalStrength,
      detailStrength: this.noiseProfile.detailStrength,
    })
    this.fallbackSphere = new THREE.Mesh(fallbackGeo, this.fallbackMaterial)
    this.fallbackSphere.frustumCulled = false
    this.group.add(this.fallbackSphere)

    const seaHeight = getSeaHeight(params.waterLevel, params.planetType)

    if (params.waterLevel > 0.02 && params.planetType !== 'gas') {
      const coastClearance = Math.max(0.025, planetRadius * 0.00004)
      const waterRadius = planetRadius * (1 + seaHeight * params.terrainScale) + coastClearance
      const oceanGeo = new THREE.SphereGeometry(waterRadius, 160, 96)
      this.oceanMaterial = createOceanMaterial({
        seed: this.noiseProfile.seed,
        planetType: params.planetType,
        waterLevel: params.waterLevel,
        planetRadius,
        octaves: this.noiseProfile.octaves,
        frequency: this.noiseProfile.frequency,
        lacunarity: this.noiseProfile.lacunarity,
        gain: this.noiseProfile.gain,
        warpStrength: this.noiseProfile.warpStrength,
        continentalScale: this.noiseProfile.continentalScale,
        mountainScale: this.noiseProfile.mountainScale,
        erosionStrength: this.noiseProfile.erosionStrength,
        thermalStrength: this.noiseProfile.thermalStrength,
        detailStrength: this.noiseProfile.detailStrength,
        sunPosition: this.sunPosition,
      })
      this.oceanMesh = new THREE.Mesh(oceanGeo, this.oceanMaterial)
      this.oceanMesh.frustumCulled = false
      this.oceanMesh.renderOrder = 2
      this.group.add(this.oceanMesh)
    }

    if (params.atmosphereDensity > 0.01) {
      const atmosphereGeo = new THREE.SphereGeometry(planetRadius * 1.08, 96, 96)
      this.atmosphereMaterial = createAtmosphereMaterial({
        atmosphereColor: params.atmosphereColor,
        density: params.atmosphereDensity,
        sunPosition: this.sunPosition,
      })
      this.atmosphereMesh = new THREE.Mesh(atmosphereGeo, this.atmosphereMaterial)
      this.atmosphereMesh.frustumCulled = false
      this.atmosphereMesh.renderOrder = 4
      this.group.add(this.atmosphereMesh)
    }

    // Initialize 6 quadtree roots
    for (let f = 0; f < NUM_FACES; f++) {
      this.quadtrees.push(createRoot(f as CubeFace))
    }

    this.initTerrainWorkers()
  }

  setPosition(pos: THREE.Vector3) {
    this.group.position.copy(pos)
  }

  setRotation(rotationAngle: number, axialTilt: number) {
    this.group.rotation.set(0, rotationAngle, axialTilt)
  }

  setSunPosition(pos: THREE.Vector3) {
    this.sunPosition.copy(pos)
  }

  setDebugWireframe(enabled: boolean) {
    this.material.wireframe = enabled
    this.farMaterial.wireframe = enabled
    this.fallbackMaterial.wireframe = enabled
    if (this.oceanMaterial) this.oceanMaterial.wireframe = enabled
  }

  private initTerrainWorkers() {
    if (typeof Worker === 'undefined') return

    const workerCount = Math.max(1, Math.min(MAX_TERRAIN_WORKERS, (navigator.hardwareConcurrency ?? 4) - 1))
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' })
      const slot: TerrainWorkerSlot = {
        worker,
        busy: false,
        key: null,
        jobId: null,
        epoch: this.chunkBuildEpoch,
      }

      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
        const response = event.data
        slot.busy = false
        slot.key = null
        slot.jobId = null
        slot.epoch = this.chunkBuildEpoch

        if (response.epoch !== this.chunkBuildEpoch) return

        if (response.type === 'error') {
          this.pendingWorkerKeys.delete(response.key)
          this.pendingKeys.add(response.key)
          if (import.meta.env.DEV) {
            console.warn(`Terrain worker failed for ${response.key}: ${response.message}`)
          }
          return
        }

        if (!this.pendingWorkerKeys.has(response.key)) return
        this.completedWorkerJobs.push(response)
      }

      worker.onerror = () => {
        if (slot.key) {
          this.pendingWorkerKeys.delete(slot.key)
          this.pendingKeys.add(slot.key)
        }
        slot.busy = false
        slot.key = null
        slot.jobId = null
      }

      this.workerSlots.push(slot)
    }
  }

  sampleSurfaceRadius(dir: Vec3Like): number {
    const chunk = this.findVisibleChunkForDirection(dir)
    return chunk?.sampleVisualRadius(dir) ?? samplePlanetRadius(dir, this.terrainParams)
  }

  getDebugStats(camera: THREE.Camera) {
    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)

    const planetPos = new THREE.Vector3()
    this.group.getWorldPosition(planetPos)

    const byLod: Record<string, number> = {}
    let visible = 0
    let detailedMaterialChunks = 0
    for (const [key, chunk] of this.chunks) {
      const lod = key.split('_')[1] ?? '?'
      byLod[lod] = (byLod[lod] ?? 0) + 1
      if (chunk.mesh.visible) visible++
      if (chunk.mesh.material === this.material) detailedMaterialChunks++
    }

    return {
      radius: this.planetRadius,
      surfaceDistance: camPos.distanceTo(planetPos) - this.planetRadius,
      chunks: this.chunks.size,
      visible,
      detailedMaterialChunks,
      pending: this.pendingKeys.size + this.pendingWorkerKeys.size + this.completedWorkerJobs.length,
      building: this.pendingWorkerKeys.size,
      completedBuilds: this.completedWorkerJobs.length,
      pendingCollapses: this.pendingCollapseKeys.size,
      generated: this.generatedChunksLastFrame,
      chunkGenerationMs: this.chunkGenerationMsLastFrame,
      chunkIntegrationMs: this.chunkIntegrationMsLastFrame,
      byLod,
      usingTerrain: !this.fallbackSphere.visible,
    }
  }

  update(camera: THREE.Camera, _dt: number) {
    this.time += _dt
    this.generatedChunksLastFrame = 0
    this.chunkGenerationMsLastFrame = 0
    this.chunkIntegrationMsLastFrame = 0

    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)

    const planetPos = new THREE.Vector3()
    this.group.getWorldPosition(planetPos)
    const planetQuat = new THREE.Quaternion()
    this.group.getWorldQuaternion(planetQuat)
    const inversePlanetQuat = planetQuat.clone().invert()
    const localCamPos = camPos.clone().sub(planetPos).applyQuaternion(inversePlanetQuat)

    const distToCenter = camPos.distanceTo(planetPos)
    const surfaceDist = distToCenter - this.planetRadius

    // Update sun position uniform
    this.material.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.farMaterial.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.fallbackMaterial.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.oceanMaterial?.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.atmosphereMaterial?.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.farMaterial.uniforms.uProceduralVisualHeight.value = surfaceDist > (this.lodDistances[2] ?? this.planetRadius * 2) ? 1 : 0
    if (this.oceanMaterial) {
      this.oceanMaterial.uniforms.uTime.value = this.time
      const farBlend = THREE.MathUtils.smoothstep(surfaceDist, this.planetRadius * 1.1, this.planetRadius * 4.0)
      this.oceanMaterial.uniforms.uOceanLift.value = farBlend * Math.max(2.0, this.planetRadius * 0.01)
    }
    // Decide: show fallback sphere or quadtree terrain
    const useTerrain = surfaceDist < this.lodDistances[1]

    if (!useTerrain) {
      this.fallbackSphere.visible = true
      if (this.oceanMesh) this.oceanMesh.visible = true
      if (this.atmosphereMesh) this.atmosphereMesh.visible = false
      this.removeAllChunks()
      return
    }

    this.fallbackSphere.visible = false
    if (this.oceanMesh) this.oceanMesh.visible = true
    if (this.atmosphereMesh) this.atmosphereMesh.visible = true

    // 1. Update quadtree structure (create/destroy children based on distance)
    for (const root of this.quadtrees) {
      this.updateQuadtree(root, localCamPos)
    }

    // 2. Queue chunks that are needed for the next stable transition.
    const loadKeys = new Set<string>()
    for (const root of this.quadtrees) {
      this.collectLoadKeys(root, loadKeys)
    }

    // 3. Queue missing chunks for generation.
    for (const key of loadKeys) {
      if (!this.chunks.has(key) && !this.isChunkBuildPending(key)) {
        this.pendingKeys.add(key)
      }
    }

    // 4. Process pending chunks
    this.integrateCompletedChunkBuilds()
    if (this.workerSlots.length > 0) {
      this.dispatchPendingChunkBuilds()
    } else {
      this.processPendingChunksSync()
    }

    // Complete deferred LOD collapses after their parent chunks exist.
    for (const root of this.quadtrees) {
      this.applyPendingCollapses(root)
    }

    // 4.5 Recompute visibility after generation so promotions happen atomically.
    const renderKeys = new Set<string>()
    const retainKeys = new Set<string>()
    for (const root of this.quadtrees) {
      this.collectRenderKeys(root, renderKeys)
      this.collectRetainKeys(root, retainKeys)
    }

    // 5. Remove chunks no longer needed. Chunks can be retained while hidden so
    //    a parent only disappears after its target children fully cover it.
    for (const [key, chunk] of this.chunks) {
      if (!retainKeys.has(key)) {
        this.group.remove(chunk.mesh)
        chunk.dispose()
        this.chunks.delete(key)
      } else {
        chunk.mesh.visible = renderKeys.has(key)
        if (chunk.mesh.visible) {
          chunk.mesh.material = this.shouldUseDetailedMaterial(chunk, camPos, planetPos)
            ? this.material
            : this.farMaterial
        }
      }
    }

    // 5.5 Refresh stale skirts — chunks whose neighbors changed LOD since creation
    if (this.skirts) {
      let refreshed = 0
      for (const [, chunk] of this.chunks) {
        if (!chunk.mesh.visible || refreshed >= 3) continue
        const newFlags = this.computeSkirtFlags(chunk.node)
        if (!chunk.needsSkirtUpdate(newFlags)) continue

        chunk.rebuildSkirts(newFlags, this.shouldUseDetailedMaterial(chunk, camPos, planetPos)
          ? this.material
          : this.farMaterial)
        refreshed++
      }
    }
  }

  private updateQuadtree(
    node: QuadtreeNode,
    localCamPos: THREE.Vector3,
  ) {
    const dist = this.getLocalChunkDistToCamera(node, localCamPos)
    const splitDistance = this.lodDistances[node.lod + 1]
    const keepChildrenDistance = splitDistance * LOD_COLLAPSE_HYSTERESIS
    const shouldSub =
      !this.isBelowHorizon(node, localCamPos) &&
      node.lod < this.maxLod &&
      dist < (node.children ? keepChildrenDistance : splitDistance) &&
      this.isChunkRelevantForDetail(node, localCamPos)

    if (shouldSub) {
      const key = nodeKey(node.face, node.lod, node.x, node.y)
      this.pendingCollapseKeys.delete(key)

      if (!node.children) {
        node.children = createChildren(node)
      }
      for (const child of node.children) {
        this.updateQuadtree(child, localCamPos)
      }
    } else {
      if (node.children) {
        const key = nodeKey(node.face, node.lod, node.x, node.y)
        if (this.chunks.has(key)) {
          this.removeChildrenChunks(node)
          node.children = null
        } else {
          this.pendingKeys.add(key)
          this.pendingCollapseKeys.add(key)
        }
      }
    }
  }

  private applyPendingCollapses(node: QuadtreeNode) {
    if (!node.children) return

    const key = nodeKey(node.face, node.lod, node.x, node.y)
    if (this.pendingCollapseKeys.has(key) && this.chunks.has(key)) {
      this.removeChildrenChunks(node)
      node.children = null
      this.pendingCollapseKeys.delete(key)
      return
    }

    for (const child of node.children) {
      this.applyPendingCollapses(child)
    }
  }

  private getLocalChunkDistToCamera(node: QuadtreeNode, localCamPos: THREE.Vector3): number {
    const center = getNodeCenter(node).multiplyScalar(this.planetRadius)
    return Math.max(0, localCamPos.distanceTo(center) - this.getNodeBoundingRadius(node))
  }

  private getNodeBoundingRadius(node: QuadtreeNode): number {
    const levelCells = 1 << node.lod
    const approxFacePatch = (2 / levelCells) * this.planetRadius
    return approxFacePatch * 1.5
  }

  private isChunkRelevantForDetail(node: QuadtreeNode, localCamPos: THREE.Vector3): boolean {
    if (localCamPos.lengthSq() === 0) return true

    const facing = getNodeCenter(node).dot(localCamPos.clone().normalize())
    return facing > -0.15
  }

  private isBelowHorizon(node: QuadtreeNode, localCamPos: THREE.Vector3): boolean {
    // Camera inside or on the surface — nothing is below horizon
    if (localCamPos.lengthSq() <= this.planetRadius * this.planetRadius) return false

    const chunkDir = getNodeCenter(node)
    const boundingRadius = this.getNodeBoundingRadius(node)
    const camDist = localCamPos.length()

    // Chunk is below horizon when even its nearest point is hidden.
    // Margin = boundingRadius * camDist / R accounts for chunk extent:
    // large (coarse) chunks get big margin, small (fine) chunks get tight culling.
    return chunkDir.dot(localCamPos) <= this.planetRadius - boundingRadius * this.horizonMargin * camDist / this.planetRadius
  }

  private shouldUseDetailedMaterial(
    chunk: TerrainChunk,
    camPos: THREE.Vector3,
    planetPos: THREE.Vector3,
  ): boolean {
    if (chunk.node.lod < DETAILED_MATERIAL_MIN_LOD) return false

    const planetQuat = new THREE.Quaternion()
    this.group.getWorldQuaternion(planetQuat)
    const chunkCenter = getNodeCenter(chunk.node).multiplyScalar(this.planetRadius).applyQuaternion(planetQuat).add(planetPos)
    return camPos.distanceTo(chunkCenter) < DETAILED_MATERIAL_DISTANCE
  }

  private findVisibleChunkForDirection(dir: Vec3Like): TerrainChunk | null {
    const faceUv = this.directionToFaceUv(dir)
    if (!faceUv) return null

    for (let lod = this.maxLod; lod >= 0; lod--) {
      const cells = 1 << lod
      const x = Math.min(cells - 1, Math.max(0, Math.floor(((faceUv.u + 1) * 0.5) * cells)))
      const y = Math.min(cells - 1, Math.max(0, Math.floor(((faceUv.v + 1) * 0.5) * cells)))
      const chunk = this.chunks.get(nodeKey(faceUv.face, lod, x, y))
      if (chunk?.mesh.visible) return chunk
    }

    return null
  }

  private directionToFaceUv(dir: Vec3Like): { face: CubeFace; u: number; v: number } | null {
    const ax = Math.abs(dir.x)
    const ay = Math.abs(dir.y)
    const az = Math.abs(dir.z)
    const m = Math.max(ax, ay, az)
    if (m <= 0) return null

    if (m === ax) {
      return dir.x >= 0
        ? { face: CubeFace.PX, u: dir.z / ax, v: dir.y / ax }
        : { face: CubeFace.NX, u: -dir.z / ax, v: dir.y / ax }
    }
    if (m === ay) {
      return dir.y >= 0
        ? { face: CubeFace.PY, u: dir.x / ay, v: dir.z / ay }
        : { face: CubeFace.NY, u: dir.x / ay, v: -dir.z / ay }
    }
    return dir.z >= 0
      ? { face: CubeFace.PZ, u: dir.x / az, v: dir.y / az }
      : { face: CubeFace.NZ, u: -dir.x / az, v: dir.y / az }
  }

  private isNodeCovered(node: QuadtreeNode): boolean {
    const key = nodeKey(node.face, node.lod, node.x, node.y)
    if (this.chunks.has(key)) return true
    return !!node.children && node.children.every(child => this.isNodeCovered(child))
  }

  private collectLoadKeys(node: QuadtreeNode, out: Set<string>) {
    const key = nodeKey(node.face, node.lod, node.x, node.y)

    if (!node.children) {
      if (!this.chunks.has(key)) out.add(key)
      return
    }

    const childrenCovered = node.children.every(child => this.isNodeCovered(child))
    if (!childrenCovered && !this.chunks.has(key)) out.add(key)

    for (const child of node.children) {
      const childKey = nodeKey(child.face, child.lod, child.x, child.y)
      if (!this.isNodeCovered(child) && !this.chunks.has(childKey)) {
        out.add(childKey)
      } else {
        this.collectLoadKeys(child, out)
      }
    }
  }

  private collectRenderKeys(node: QuadtreeNode, out: Set<string>) {
    const key = nodeKey(node.face, node.lod, node.x, node.y)

    if (!node.children) {
      if (this.chunks.has(key)) out.add(key)
      return
    }

    const childrenCovered = node.children.every(child => this.isNodeCovered(child))
    if (childrenCovered) {
      for (const child of node.children) this.collectRenderKeys(child, out)
    } else if (this.chunks.has(key)) {
      out.add(key)
    } else {
      for (const child of node.children) this.collectRenderKeys(child, out)
    }
  }

  private collectRetainKeys(node: QuadtreeNode, out: Set<string>) {
    const key = nodeKey(node.face, node.lod, node.x, node.y)

    if (!node.children) {
      out.add(key)
      return
    }

    const childrenCovered = node.children.every(child => this.isNodeCovered(child))
    if (!childrenCovered) out.add(key)
    for (const child of node.children) this.collectRetainKeys(child, out)
  }

  private isChunkBuildPending(key: string): boolean {
    return this.pendingKeys.has(key) || this.pendingWorkerKeys.has(key)
  }

  private parseChunkKey(key: string): QuadtreeNode | null {
    const parts = key.split('_')
    if (parts.length !== 4) return null

    const face = parseInt(parts[0]) as CubeFace
    const lod = parseInt(parts[1])
    const x = parseInt(parts[2])
    const y = parseInt(parts[3])

    if (!Number.isFinite(face) || !Number.isFinite(lod) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null
    }

    return { face, lod, x, y, children: null }
  }

  private integrateCompletedChunkBuilds() {
    const integrationStart = performance.now()

    while (this.completedWorkerJobs.length > 0) {
      if (this.generatedChunksLastFrame > 0 && performance.now() - integrationStart >= CHUNK_INTEGRATION_BUDGET_MS) break

      const result = this.completedWorkerJobs.shift()
      if (!result) break

      if (result.epoch !== this.chunkBuildEpoch || !this.pendingWorkerKeys.delete(result.key) || this.chunks.has(result.key)) {
        continue
      }

      const start = performance.now()
      const chunk = this.createChunk(result.node, result.geometry)
      this.chunkIntegrationMsLastFrame += performance.now() - start
      this.chunkGenerationMsLastFrame += result.durationMs
      this.chunks.set(result.key, chunk)
      this.group.add(chunk.mesh)
      this.generatedChunksLastFrame++
    }
  }

  private dispatchPendingChunkBuilds() {
    if (this.pendingKeys.size === 0) return

    const dispatchStart = performance.now()
    for (const slot of this.workerSlots) {
      if (slot.busy) continue
      if (performance.now() - dispatchStart >= WORKER_DISPATCH_BUDGET_MS) break

      const next = this.pendingKeys.values().next()
      if (next.done) break

      const key = next.value
      const node = this.parseChunkKey(key)
      this.pendingKeys.delete(key)
      if (!node || this.chunks.has(key) || this.pendingWorkerKeys.has(key)) continue

      const jobId = this.nextWorkerJobId++
      slot.busy = true
      slot.key = key
      slot.jobId = jobId
      slot.epoch = this.chunkBuildEpoch
      this.pendingWorkerKeys.add(key)
      slot.worker.postMessage({
        type: 'build',
        id: jobId,
        epoch: this.chunkBuildEpoch,
        key,
        node,
        terrain: this.terrainParams,
        gridSize: this.gridSize,
        skirts: this.skirts
          ? this.computeSkirtFlags(node)
          : { bottom: false, top: false, left: false, right: false },
      })
    }
  }

  private processPendingChunksSync() {
    const buildStart = performance.now()

    for (const key of this.pendingKeys) {
      if (this.generatedChunksLastFrame > 0 && performance.now() - buildStart >= SYNC_CHUNK_BUILD_BUDGET_MS) break

      const generationStart = performance.now()
      const chunk = this.generateChunk(key)
      this.chunkGenerationMsLastFrame += performance.now() - generationStart
      if (chunk) {
        this.chunks.set(key, chunk)
        this.group.add(chunk.mesh)
        this.generatedChunksLastFrame++
      }
      this.pendingKeys.delete(key)
    }
  }

  private removeChildrenChunks(node: QuadtreeNode) {
    if (!node.children) return
    for (const child of node.children) {
      this.removeChildrenChunks(child)
      const key = nodeKey(child.face, child.lod, child.x, child.y)
      const chunk = this.chunks.get(key)
      if (chunk) {
        this.group.remove(chunk.mesh)
        chunk.dispose()
        this.chunks.delete(key)
      }
      this.pendingKeys.delete(key)
      this.pendingWorkerKeys.delete(key)
      this.pendingCollapseKeys.delete(key)
    }
  }

  private generateChunk(key: string): TerrainChunk | null {
    const node = this.parseChunkKey(key)
    if (!node) return null

    return this.createChunk(node)
  }

  private createChunk(node: QuadtreeNode, geometryData?: TerrainChunkGeometryData): TerrainChunk {
    const skirtFlags: SkirtFlags = this.skirts
      ? this.computeSkirtFlags(node)
      : { bottom: false, top: false, left: false, right: false }

    return new TerrainChunk(
      node,
      this.terrainParams,
      this.farMaterial,
      this.gridSize,
      skirtFlags,
      geometryData,
    )
  }

  private findQuadtreeNode(face: CubeFace, lod: number, x: number, y: number): QuadtreeNode | null {
    const root = this.quadtrees[face]
    if (lod === 0) return root

    let current = root
    for (let level = 0; level < lod; level++) {
      if (!current.children) return null
      const levelsRemaining = lod - level - 1
      const cx = (x >> levelsRemaining) & 1
      const cy = (y >> levelsRemaining) & 1
      current = current.children[cy * 2 + cx]
    }

    return current
  }

  private computeSkirtFlags(node: QuadtreeNode): SkirtFlags {
    const { face, lod, x, y } = node
    const maxCoord = (1 << lod) - 1
    const allSkirts: SkirtFlags = { bottom: true, top: true, left: true, right: true }

    // At LOD 0 the single node covers the entire face; always use skirts
    if (lod === 0) return allSkirts

    const checkNeighbor = (nX: number, nY: number): boolean => {
      const neighbor = this.findQuadtreeNode(face, lod, nX, nY)
      // Neighbor doesn't exist at this LOD (coarser parent) → need skirt
      if (!neighbor) return true
      // Neighbor has children (finer LOD) → need skirt
      return !!neighbor.children
    }

    return {
      bottom: y === 0 || checkNeighbor(x, y - 1),
      top: y === maxCoord || checkNeighbor(x, y + 1),
      left: x === 0 || checkNeighbor(x - 1, y),
      right: x === maxCoord || checkNeighbor(x + 1, y),
    }
  }

  private createFallbackGeometry(planetRadius: number): THREE.SphereGeometry {
    const geometry = new THREE.SphereGeometry(planetRadius, 32, 32)
    const positions = geometry.getAttribute('position')
    const heights = new Float32Array(positions.count)
    const dir = new THREE.Vector3()

    for (let i = 0; i < positions.count; i++) {
      dir.fromBufferAttribute(positions, i).normalize()
      heights[i] = samplePlanetHeight(dir, this.terrainParams)
    }

    geometry.setAttribute('terrainHeight', new THREE.BufferAttribute(heights, 1))
    return geometry
  }

  private removeAllChunks() {
    this.chunkBuildEpoch++
    for (const [, chunk] of this.chunks) {
      this.group.remove(chunk.mesh)
      chunk.dispose()
    }
    this.chunks.clear()
    this.pendingKeys.clear()
    this.pendingWorkerKeys.clear()
    this.completedWorkerJobs.length = 0
    this.pendingCollapseKeys.clear()

    for (const root of this.quadtrees) {
      this.collapseQuadtree(root)
    }
  }

  private collapseQuadtree(node: QuadtreeNode) {
    if (node.children) {
      for (const child of node.children) {
        this.collapseQuadtree(child)
      }
      node.children = null
    }
  }

  dispose() {
    this.removeAllChunks()
    for (const slot of this.workerSlots) {
      slot.worker.terminate()
    }
    this.workerSlots.length = 0
    this.material.dispose()
    this.farMaterial.dispose()
    this.fallbackMaterial.dispose()
    this.oceanMaterial?.dispose()
    this.atmosphereMaterial?.dispose()
    this.oceanMesh?.geometry.dispose()
    this.atmosphereMesh?.geometry.dispose()
    if (this.fallbackSphere.material instanceof THREE.ShaderMaterial) {
      this.fallbackSphere.material.dispose()
    }
    this.fallbackSphere.geometry.dispose()
    this.group.parent?.remove(this.group)
  }
}

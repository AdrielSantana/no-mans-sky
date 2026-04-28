import * as THREE from 'three'
import {
  CubeFace,
  NUM_FACES,
  MAX_LOD,
  LOD_DISTANCE_MULTIPLIERS,
  type QuadtreeNode,
  createRoot,
  createChildren,
  nodeKey,
  getNodeCenter,
} from './quadtree'
import { TerrainChunk } from './terrain-chunk'
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

const MAX_CHUNKS_PER_FRAME = 8
const DETAILED_MATERIAL_MIN_LOD = 6
const DETAILED_MATERIAL_DISTANCE = WORLD_SCALE.localDetailNear * 2.2
const LOD_COLLAPSE_HYSTERESIS = 1.35

export class PlanetRenderer {
  private group: THREE.Group
  private planetRadius: number
  private noiseProfile: { octaves: number; lacunarity: number; gain: number; frequency: number; seed: number }
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
      noiseProfile?: { octaves: number; lacunarity: number; gain: number; frequency: number }
      lodScale?: number
    },
  ) {
    this.planetRadius = planetRadius
    this.group = new THREE.Group()
    scene.add(this.group)

    // Precompute LOD distances scaled to planet radius
    const lodScale = params.lodScale ?? 1
    this.lodDistances = LOD_DISTANCE_MULTIPLIERS.map(m => m === Infinity ? Infinity : m * lodScale * planetRadius)

    this.noiseProfile = params.noiseProfile
      ? { seed: Number(params.seed), ...params.noiseProfile }
      : { ...PlanetGenerator.fromParams(params) }
    this.terrainParams = {
      seed: this.noiseProfile.seed,
      planetType: params.planetType,
      radius: planetRadius,
      terrainScale: params.terrainScale,
      frequency: this.noiseProfile.frequency,
      octaves: this.noiseProfile.octaves,
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
    })
    this.fallbackSphere = new THREE.Mesh(fallbackGeo, this.fallbackMaterial)
    this.fallbackSphere.frustumCulled = false
    this.group.add(this.fallbackSphere)

    const seaHeight = getSeaHeight(params.waterLevel, params.planetType)

    if (params.waterLevel > 0.02 && params.planetType !== 'gas') {
      const coastClearance = Math.max(0.08, planetRadius * 0.00025)
      const waterRadius = planetRadius * (1 + seaHeight * params.terrainScale) + coastClearance
      const oceanGeo = new THREE.SphereGeometry(waterRadius, 96, 96)
      this.oceanMaterial = createOceanMaterial({
        seed: this.noiseProfile.seed,
        planetType: params.planetType,
        waterLevel: params.waterLevel,
        planetRadius,
        octaves: this.noiseProfile.octaves,
        frequency: this.noiseProfile.frequency,
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
      pending: this.pendingKeys.size,
      pendingCollapses: this.pendingCollapseKeys.size,
      byLod,
      usingTerrain: !this.fallbackSphere.visible,
    }
  }

  update(camera: THREE.Camera, _dt: number) {
    this.time += _dt

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
      if (!this.chunks.has(key) && !this.pendingKeys.has(key)) {
        this.pendingKeys.add(key)
      }
    }

    // 4. Process pending chunks
    let generated = 0
    for (const key of this.pendingKeys) {
      if (generated >= MAX_CHUNKS_PER_FRAME) break
      const chunk = this.generateChunk(key)
      if (chunk) {
        this.chunks.set(key, chunk)
        this.group.add(chunk.mesh)
        generated++
      }
      this.pendingKeys.delete(key)
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
  }

  private updateQuadtree(
    node: QuadtreeNode,
    localCamPos: THREE.Vector3,
  ) {
    const dist = this.getLocalChunkDistToCamera(node, localCamPos)
    const splitDistance = this.lodDistances[node.lod + 1]
    const keepChildrenDistance = splitDistance * LOD_COLLAPSE_HYSTERESIS
    const shouldSub =
      node.lod < MAX_LOD &&
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

    for (let lod = MAX_LOD; lod >= 0; lod--) {
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
      this.pendingCollapseKeys.delete(key)
    }
  }

  private generateChunk(key: string): TerrainChunk | null {
    const parts = key.split('_')
    if (parts.length !== 4) return null

    const face = parseInt(parts[0]) as CubeFace
    const lod = parseInt(parts[1])
    const x = parseInt(parts[2])
    const y = parseInt(parts[3])

    const node: QuadtreeNode = { face, lod, x, y, children: null }

    return new TerrainChunk(
      node,
      this.terrainParams,
      this.farMaterial,
    )
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
    for (const [, chunk] of this.chunks) {
      this.group.remove(chunk.mesh)
      chunk.dispose()
    }
    this.chunks.clear()
    this.pendingKeys.clear()
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

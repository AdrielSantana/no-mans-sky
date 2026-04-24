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
  getChunkDistToCamera,
} from './quadtree'
import { TerrainChunk } from './terrain-chunk'
import { createPlanetMaterial, PlanetGenerator } from './planet-generator'

const MAX_CHUNKS_PER_FRAME = 8

export class PlanetRenderer {
  private group: THREE.Group
  private planetRadius: number
  private noiseProfile: { octaves: number; lacunarity: number; gain: number; frequency: number; seed: number }
  private material: THREE.ShaderMaterial
  private quadtrees: QuadtreeNode[] = []
  private chunks = new Map<string, TerrainChunk>()
  private fallbackSphere: THREE.Mesh
  private sunPosition = new THREE.Vector3(0, 0, 0)
  private terrainScale: number
  private lodDistances: number[]

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
    },
  ) {
    this.planetRadius = planetRadius
    this.terrainScale = params.terrainScale
    this.group = new THREE.Group()
    scene.add(this.group)

    // Precompute LOD distances scaled to planet radius
    this.lodDistances = LOD_DISTANCE_MULTIPLIERS.map(m => m === Infinity ? Infinity : m * planetRadius)

    this.noiseProfile = {
      ...PlanetGenerator.fromParams(params),
    }

    this.material = createPlanetMaterial({
      seed: Number(params.seed),
      waterLevel: params.waterLevel,
      terrainScale: params.terrainScale,
      colorA: params.colorA,
      colorB: params.colorB,
      atmosphereColor: params.atmosphereColor,
      sunPosition: this.sunPosition,
      planetRadius: planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
    })

    // Fallback low-poly sphere for distant view
    const fallbackGeo = new THREE.SphereGeometry(planetRadius, 32, 32)
    const fallbackMat = this.material.clone()
    this.fallbackSphere = new THREE.Mesh(fallbackGeo, fallbackMat)
    this.fallbackSphere.frustumCulled = false
    this.group.add(this.fallbackSphere)

    // Initialize 6 quadtree roots
    for (let f = 0; f < NUM_FACES; f++) {
      this.quadtrees.push(createRoot(f as CubeFace))
    }
  }

  setPosition(pos: THREE.Vector3) {
    this.group.position.copy(pos)
  }

  setSunPosition(pos: THREE.Vector3) {
    this.sunPosition.copy(pos)
  }

  update(camera: THREE.Camera, _dt: number) {
    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)

    const planetPos = new THREE.Vector3()
    this.group.getWorldPosition(planetPos)

    const distToCenter = camPos.distanceTo(planetPos)
    const surfaceDist = distToCenter - this.planetRadius

    // Update sun position uniform
    this.material.uniforms.uSunPosition.value.copy(this.sunPosition)
    if (this.fallbackSphere.material instanceof THREE.ShaderMaterial) {
      this.fallbackSphere.material.uniforms.uSunPosition.value.copy(this.sunPosition)
    }

    // Decide: show fallback sphere or quadtree terrain
    const useTerrain = surfaceDist < this.lodDistances[1]

    if (!useTerrain) {
      this.fallbackSphere.visible = true
      this.removeAllChunks()
      return
    }

    this.fallbackSphere.visible = false

    // 1. Update quadtree structure (create/destroy children based on distance)
    for (const root of this.quadtrees) {
      this.updateQuadtree(root, camPos, planetPos)
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
      }
    }
  }

  private updateQuadtree(node: QuadtreeNode, camPos: THREE.Vector3, planetPos: THREE.Vector3) {
    const dist = getChunkDistToCamera(node, camPos, planetPos, this.planetRadius)
    const shouldSub =
      node.lod < MAX_LOD &&
      dist < this.lodDistances[node.lod + 1] &&
      this.isChunkRelevantForDetail(node, camPos, planetPos)

    if (shouldSub) {
      if (!node.children) {
        node.children = createChildren(node)
      }
      for (const child of node.children) {
        this.updateQuadtree(child, camPos, planetPos)
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

  private isChunkRelevantForDetail(node: QuadtreeNode, camPos: THREE.Vector3, planetPos: THREE.Vector3): boolean {
    const camDir = camPos.clone().sub(planetPos)
    if (camDir.lengthSq() === 0) return true

    const facing = getNodeCenter(node).dot(camDir.normalize())
    return facing > -0.15
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
      this.planetRadius,
      this.terrainScale,
      this.noiseProfile.seed,
      this.noiseProfile.octaves,
      this.material,
    )
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
    if (this.fallbackSphere.material instanceof THREE.ShaderMaterial) {
      this.fallbackSphere.material.dispose()
    }
    this.fallbackSphere.geometry.dispose()
    this.group.parent?.remove(this.group)
  }
}

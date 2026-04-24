import * as THREE from 'three'
import type { CelestialBody } from '../module_bindings/types'
import type { GameEngine } from './engine'
import { SunRenderer } from './sun-renderer'
import { PlanetRenderer } from './planet/planet-renderer'

interface PlanetParamsRow {
  bodyId: bigint
  seed: bigint
  planetType: string
  waterLevel: number
  terrainScale: number
  colorA: string
  colorB: string
  atmosphereColor: string
  atmosphereDensity: number
}

export class CelestialSystem {
  private scene: THREE.Scene
  private engine: GameEngine
  private meshes = new Map<string, THREE.Mesh>()
  private sunRenderer: SunRenderer | null = null
  private sunGroup: THREE.Group | null = null
  private sunId: string | null = null
  private sunPosition = new THREE.Vector3(0, 0, 0)
  private geometry = new THREE.SphereGeometry(1, 32, 32)
  private planetRenderers = new Map<string, PlanetRenderer>()

  constructor(engine: GameEngine) {
    this.engine = engine
    this.scene = engine.scene
  }

  sync(bodies: readonly CelestialBody[], planetParams?: readonly PlanetParamsRow[]) {
    const activeIds = new Set<string>()

    for (const body of bodies) {
      const id = body.id.toString()
      activeIds.add(id)

      // Sun handling
      if (body.isSun) {
        this.sunId = id
        this.sunPosition.set(body.x, body.y, body.z)
        if (!this.sunRenderer) {
          const group = new THREE.Group()
          this.sunGroup = group
          this.sunRenderer = new SunRenderer(group, this.engine.renderer, this.engine.camera, body.bodySize)
          this.scene.add(group)
        }
        if (this.sunGroup) {
          this.sunGroup.position.set(body.x, body.y, body.z)
        }
        continue
      }

      // Check if this body has planet params
      const params = planetParams?.find(p => p.bodyId === body.id)
      const existingRenderer = this.planetRenderers.get(id)

      if (params) {
        if (!existingRenderer) {
          // Remove simple mesh if exists
          const existingMesh = this.meshes.get(id)
          if (existingMesh) {
            this.scene.remove(existingMesh)
            if (Array.isArray(existingMesh.material)) {
              existingMesh.material.forEach(m => m.dispose())
            } else {
              existingMesh.material.dispose()
            }
            this.meshes.delete(id)
          }

          // Create PlanetRenderer
          const renderer = new PlanetRenderer(this.scene, body.bodySize, {
            seed: params.seed,
            planetType: params.planetType,
            terrainScale: params.terrainScale,
            waterLevel: params.waterLevel,
            colorA: params.colorA,
            colorB: params.colorB,
            atmosphereColor: params.atmosphereColor,
          })
          renderer.setPosition(new THREE.Vector3(body.x, body.y, body.z))
          renderer.setSunPosition(this.sunPosition)
          this.planetRenderers.set(id, renderer)
        } else {
          existingRenderer.setPosition(new THREE.Vector3(body.x, body.y, body.z))
          existingRenderer.setSunPosition(this.sunPosition)
        }
      } else {
        // No params — simple sphere (backward compatible)
        if (!this.meshes.has(id) && !this.planetRenderers.has(id)) {
          const material = new THREE.MeshStandardMaterial({
            color: body.color,
            roughness: 0.85,
            metalness: 0.1,
          })
          const mesh = new THREE.Mesh(this.geometry, material)
          this.meshes.set(id, mesh)
          this.scene.add(mesh)
        }

        const mesh = this.meshes.get(id)
        if (mesh) {
          mesh.position.set(body.x, body.y, body.z)
          mesh.scale.setScalar(body.bodySize)
          mesh.rotation.set(0, body.rotationAngle, body.axialTilt)
        }
      }
    }

    this.removeInactive(activeIds)
  }

  update(dt: number) {
    this.sunRenderer?.update(dt)
    for (const renderer of this.planetRenderers.values()) {
      renderer.update(this.engine.camera, dt)
    }
  }

  private removeInactive(activeIds: Set<string>) {
    for (const [id, mesh] of this.meshes) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh)
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose())
        } else {
          mesh.material.dispose()
        }
        this.meshes.delete(id)
      }
    }

    for (const [id, renderer] of this.planetRenderers) {
      if (!activeIds.has(id)) {
        renderer.dispose()
        this.planetRenderers.delete(id)
      }
    }

    // Clean up sun if removed
    if (this.sunId && !activeIds.has(this.sunId) && this.sunRenderer) {
      this.sunRenderer.dispose()
      this.sunRenderer = null
      if (this.sunGroup) {
        this.scene.remove(this.sunGroup)
        this.sunGroup = null
      }
    }
  }

  dispose() {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh)
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose())
      } else {
        mesh.material.dispose()
      }
    }
    for (const renderer of this.planetRenderers.values()) {
      renderer.dispose()
    }
    if (this.sunRenderer) {
      this.sunRenderer.dispose()
    }
    if (this.sunGroup) {
      this.scene.remove(this.sunGroup)
    }
    this.meshes.clear()
    this.planetRenderers.clear()
    this.geometry.dispose()
  }
}

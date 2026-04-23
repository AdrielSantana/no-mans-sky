import * as THREE from 'three'
import type { CelestialBody } from '../module_bindings/types'
import type { GameEngine } from './engine'
import { SunRenderer } from './sun-renderer'

export class CelestialSystem {
  private scene: THREE.Scene
  private engine: GameEngine
  private meshes = new Map<string, THREE.Mesh>()
  private geometry = new THREE.SphereGeometry(1, 32, 32)
  private sunRenderer: SunRenderer | null = null
  private sunGroup: THREE.Group | null = null

  constructor(engine: GameEngine) {
    this.engine = engine
    this.scene = engine.scene
  }

  sync(bodies: readonly CelestialBody[]) {
    const activeIds = new Set<string>()

    for (const body of bodies) {
      const id = body.id.toString()
      activeIds.add(id)

      let mesh = this.meshes.get(id)

      if (!mesh) {
        if (body.isSun) {
          const group = new THREE.Group()
          this.sunGroup = group
          this.sunRenderer = new SunRenderer(group, this.engine.renderer, this.engine.camera, body.bodySize)
          this.scene.add(group)
          mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ visible: false }))
          this.meshes.set(id, mesh)
          continue
        }

        const material = new THREE.MeshStandardMaterial({
          color: body.color,
          roughness: 0.6,
          metalness: 0.2,
        })
        mesh = new THREE.Mesh(this.geometry, material)
        this.meshes.set(id, mesh)
        this.scene.add(mesh)
      }

      if (body.isSun && this.sunGroup) {
        this.sunGroup.position.set(body.x, body.y, body.z)
      } else if (!body.isSun) {
        mesh.position.set(body.x, body.y, body.z)
        mesh.scale.setScalar(body.bodySize)
        mesh.rotation.set(0, body.rotationAngle, body.axialTilt)
      }
    }

    this.removeInactive(activeIds)
  }

  update(dt: number) {
    this.sunRenderer?.update(dt)
  }

  private removeInactive(activeIds: Set<string>) {
    for (const [id, mesh] of this.meshes) {
      if (!activeIds.has(id)) {
        // If this was the sun, clean up sun renderer
        if (mesh.material instanceof THREE.MeshBasicMaterial && !mesh.material.visible) {
          if (this.sunRenderer) {
            this.sunRenderer.dispose()
            this.sunRenderer = null
          }
          if (this.sunGroup) {
            this.scene.remove(this.sunGroup)
            this.sunGroup = null
          }
        }
        this.scene.remove(mesh)
        mesh.material.dispose()
        this.meshes.delete(id)
      }
    }
  }

  dispose() {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh)
      mesh.material.dispose()
    }
    if (this.sunRenderer) {
      this.sunRenderer.dispose()
    }
    if (this.sunGroup) {
      this.scene.remove(this.sunGroup)
    }
    this.meshes.clear()
    this.geometry.dispose()
  }
}

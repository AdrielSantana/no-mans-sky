import * as THREE from 'three'
import type { CelestialBody } from '../module_bindings/types'

export class CelestialSystem {
  private scene: THREE.Scene
  private meshes = new Map<string, THREE.Mesh>()
  private orbitLines = new Map<string, THREE.Line>()
  private geometry = new THREE.SphereGeometry(1, 32, 32)

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  sync(bodies: readonly CelestialBody[]) {
    const activeIds = new Set<string>()

    for (const body of bodies) {
      const id = body.id.toString()
      activeIds.add(id)

      let mesh = this.meshes.get(id)

      if (!mesh) {
        mesh = this.createMesh(body)
        this.meshes.set(id, mesh)
        this.scene.add(mesh)

        if (!body.isSun && body.orbitRadius > 0) {
          const line = this.createOrbitLine(body.orbitRadius)
          this.orbitLines.set(id, line)
          this.scene.add(line)
        }
      }

      mesh.position.set(body.x, body.y, body.z)
      mesh.scale.setScalar(body.bodySize)
      mesh.rotation.y = body.rotationAngle
    }

    this.removeInactive(activeIds)
  }

  private createMesh(body: CelestialBody): THREE.Mesh {
    const material = body.isSun
      ? new THREE.MeshBasicMaterial({ color: body.color })
      : new THREE.MeshStandardMaterial({ color: body.color, roughness: 0.6, metalness: 0.2 })
    return new THREE.Mesh(this.geometry, material)
  }

  private createOrbitLine(radius: number): THREE.Line {
    const points: THREE.Vector3[] = []
    const segments = 64
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      points.push(new THREE.Vector3(radius * Math.cos(a), 0, radius * Math.sin(a)))
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineBasicMaterial({ color: 0x1a1a3a, transparent: true, opacity: 0.4 })
    return new THREE.Line(geometry, material)
  }

  private removeInactive(activeIds: Set<string>) {
    for (const [id, mesh] of this.meshes) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh)
        ;(mesh.material as THREE.Material).dispose()
        this.meshes.delete(id)

        const line = this.orbitLines.get(id)
        if (line) {
          this.scene.remove(line)
          line.geometry.dispose()
          ;(line.material as THREE.Material).dispose()
          this.orbitLines.delete(id)
        }
      }
    }
  }

  dispose() {
    for (const [id, mesh] of this.meshes) {
      this.scene.remove(mesh)
      ;(mesh.material as THREE.Material).dispose()
      const line = this.orbitLines.get(id)
      if (line) {
        this.scene.remove(line)
        line.geometry.dispose()
        ;(line.material as THREE.Material).dispose()
      }
    }
    this.meshes.clear()
    this.orbitLines.clear()
    this.geometry.dispose()
  }
}

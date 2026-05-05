import * as THREE from 'three'
import type { CelestialBody } from '../module_bindings/types'
import type { GameEngine } from './engine'
import { SunRenderer } from './sun-renderer'
import { PlanetRenderer, type UnderwaterViewInfo } from './planet/planet-renderer'
import { PlanetGenerator } from './planet/planet-generator'
import { PlanetWalkerController, type PlanetWalkerTarget } from './planet-walker-controller'

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

interface BodyRenderState {
  currentPosition: THREE.Vector3
  targetPosition: THREE.Vector3
  currentRotationAngle: number
  targetRotationAngle: number
  currentAxialTilt: number
  targetAxialTilt: number
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
  private bodyStates = new Map<string, BodyRenderState>()
  private walkerTerrainById = new Map<string, PlanetWalkerTarget['terrain']>()
  private walkerController: PlanetWalkerController
  private debugWireframe = false
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event)

  constructor(engine: GameEngine) {
    this.engine = engine
    this.scene = engine.scene
    this.walkerController = new PlanetWalkerController(engine)
    window.addEventListener('keydown', this.onKeyDown)
  }

  sync(bodies: readonly CelestialBody[], planetParams?: readonly PlanetParamsRow[]) {
    const activeIds = new Set<string>()
    const activePlanetIds = new Set<string>()

    for (const body of bodies) {
      const id = body.id.toString()
      activeIds.add(id)
      const renderState = this.upsertBodyState(id, body)

      // Sun handling
      if (body.isSun) {
        this.sunId = id
        if (!this.sunRenderer) {
          const group = new THREE.Group()
          this.sunGroup = group
          this.sunRenderer = new SunRenderer(group, this.engine.renderer, this.engine.camera, body.bodySize)
          this.scene.add(group)
        }
        if (this.sunGroup) {
          this.applyObjectTransform(this.sunGroup, renderState)
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
            atmosphereDensity: params.atmosphereDensity,
          })
          renderer.setPosition(renderState.currentPosition)
          renderer.setRotation(renderState.currentRotationAngle, renderState.currentAxialTilt)
          renderer.setSunPosition(this.sunPosition)
          renderer.setDebugWireframe(this.debugWireframe)
          this.planetRenderers.set(id, renderer)
        }

        const profile = PlanetGenerator.fromParams({
          seed: params.seed,
          planetType: params.planetType,
          terrainScale: params.terrainScale,
        })
        activePlanetIds.add(id)
        this.walkerTerrainById.set(id, {
          seed: Number(params.seed),
          planetType: params.planetType,
          radius: body.bodySize,
          terrainScale: params.terrainScale,
          frequency: profile.frequency,
          octaves: profile.octaves,
          lacunarity: profile.lacunarity,
          gain: profile.gain,
          warpStrength: profile.warpStrength,
          continentalScale: profile.continentalScale,
          mountainScale: profile.mountainScale,
          plainsScale: profile.plainsScale,
          hillsScale: profile.hillsScale,
          mountainBeltScale: profile.mountainBeltScale,
          reliefVariety: profile.reliefVariety,
          erosionStrength: profile.erosionStrength,
          thermalStrength: profile.thermalStrength,
          detailStrength: profile.detailStrength,
          microDetailStrength: profile.microDetailStrength,
          microDetailScale: profile.microDetailScale,
          microReliefMeters: profile.microReliefMeters,
        })
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
          this.applyObjectTransform(mesh, renderState)
          mesh.scale.setScalar(body.bodySize)
        }
      }
    }

    for (const id of this.walkerTerrainById.keys()) {
      if (!activePlanetIds.has(id)) this.walkerTerrainById.delete(id)
    }
    this.removeInactive(activeIds)
  }

  update(dt: number) {
    this.interpolateBodies(dt)
    this.updateWalkerTargets()
    this.walkerController.update(dt)
    this.sunRenderer?.update(dt)
    let underwater: UnderwaterViewInfo | null = null
    for (const renderer of this.planetRenderers.values()) {
      renderer.update(this.engine.camera, dt)
      const viewInfo = renderer.getUnderwaterViewInfo(this.engine.camera)
      if (viewInfo && (!underwater || viewInfo.amount > underwater.amount)) {
        underwater = viewInfo
      }
    }
    this.engine.setUnderwaterEffect(underwater)
  }

  getDebugStats() {
    return {
      planets: Array.from(this.planetRenderers, ([id, renderer]) => ({
        id,
        ...renderer.getDebugStats(this.engine.camera),
      })),
      simpleMeshes: this.meshes.size,
      hasSun: this.sunRenderer !== null,
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
        this.bodyStates.delete(id)
      }
    }

    for (const [id, renderer] of this.planetRenderers) {
      if (!activeIds.has(id)) {
        renderer.dispose()
        this.planetRenderers.delete(id)
        this.bodyStates.delete(id)
        this.walkerTerrainById.delete(id)
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
      this.bodyStates.delete(this.sunId)
    }
  }

  private upsertBodyState(id: string, body: CelestialBody): BodyRenderState {
    const targetPosition = new THREE.Vector3(body.x, body.y, body.z)
    const existing = this.bodyStates.get(id)
    if (existing) {
      existing.targetPosition.copy(targetPosition)
      existing.targetRotationAngle = body.rotationAngle
      existing.targetAxialTilt = body.axialTilt
      return existing
    }

    const state = {
      currentPosition: targetPosition.clone(),
      targetPosition,
      currentRotationAngle: body.rotationAngle,
      targetRotationAngle: body.rotationAngle,
      currentAxialTilt: body.axialTilt,
      targetAxialTilt: body.axialTilt,
    }
    this.bodyStates.set(id, state)
    return state
  }

  private interpolateBodies(dt: number) {
    const alpha = 1 - Math.exp(-dt * 14)
    for (const [id, state] of this.bodyStates) {
      state.currentPosition.lerp(state.targetPosition, alpha)
      state.currentRotationAngle = this.lerpAngle(state.currentRotationAngle, state.targetRotationAngle, alpha)
      state.currentAxialTilt = THREE.MathUtils.lerp(state.currentAxialTilt, state.targetAxialTilt, alpha)

      if (id === this.sunId && this.sunGroup) {
        this.applyObjectTransform(this.sunGroup, state)
        this.sunPosition.copy(state.currentPosition)
        continue
      }

      const renderer = this.planetRenderers.get(id)
      if (renderer) {
        renderer.setPosition(state.currentPosition)
        renderer.setRotation(state.currentRotationAngle, state.currentAxialTilt)
        renderer.setSunPosition(this.sunPosition)
        continue
      }

      const mesh = this.meshes.get(id)
      if (mesh) {
        this.applyObjectTransform(mesh, state)
      }
    }
  }

  private updateWalkerTargets() {
    const targets: PlanetWalkerTarget[] = []
    for (const [id, terrain] of this.walkerTerrainById) {
      const state = this.bodyStates.get(id)
      if (!state) continue
      const renderer = this.planetRenderers.get(id)
      targets.push({
        id,
        worldPosition: state.currentPosition.clone(),
        worldQuaternion: this.getBodyQuaternion(state),
        terrain,
        sampleSurfaceRadius: renderer ? dir => renderer.sampleSurfaceRadius(dir) : undefined,
      })
    }
    this.walkerController.setTargets(targets)
  }

  private applyObjectTransform(object: THREE.Object3D, state: BodyRenderState) {
    object.position.copy(state.currentPosition)
    object.rotation.set(0, state.currentRotationAngle, state.currentAxialTilt)
  }

  private getBodyQuaternion(state: BodyRenderState): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, state.currentRotationAngle, state.currentAxialTilt))
  }

  private lerpAngle(current: number, target: number, alpha: number): number {
    let delta = (target - current) % (Math.PI * 2)
    if (delta > Math.PI) delta -= Math.PI * 2
    if (delta < -Math.PI) delta += Math.PI * 2
    return current + delta * alpha
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.code !== 'KeyV' || event.repeat) return
    this.debugWireframe = !this.debugWireframe
    for (const renderer of this.planetRenderers.values()) {
      renderer.setDebugWireframe(this.debugWireframe)
    }
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown)
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
    this.walkerController.dispose()
    if (this.sunGroup) {
      this.scene.remove(this.sunGroup)
    }
    this.meshes.clear()
    this.planetRenderers.clear()
    this.bodyStates.clear()
    this.walkerTerrainById.clear()
    this.geometry.dispose()
  }
}

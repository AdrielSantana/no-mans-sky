import * as THREE from 'three'
import type { GameEngine } from './engine'
import {
  createWalkerState,
  defaultWalkerParams,
  simulatePlanetWalker,
  type WalkerInput,
  type WalkerState,
} from '../../../server/spacetimedb/src/shared/player-movement'
import { normalize, scale, type Vec3Like } from '../../../server/spacetimedb/src/shared/vector'
import { samplePlanetRadius, type PlanetTerrainParams } from '../../../server/spacetimedb/src/shared/planet-terrain'

export interface PlanetWalkerTarget {
  id: string
  worldPosition: THREE.Vector3
  worldQuaternion: THREE.Quaternion
  terrain: PlanetTerrainParams
}

function toVec3Like(v: THREE.Vector3): Vec3Like {
  return { x: v.x, y: v.y, z: v.z }
}

function toThree(v: Vec3Like): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z)
}

export class PlanetWalkerController {
  private engine: GameEngine
  private targets: PlanetWalkerTarget[] = []
  private activeTarget: PlanetWalkerTarget | null = null
  private state: WalkerState | null = null
  private keys = new Set<string>()
  private pendingYaw = 0
  private pendingPitch = 0
  private enabled = false
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event)
  private readonly onKeyUp = (event: KeyboardEvent) => this.handleKeyUp(event)
  private readonly onMouseMove = (event: MouseEvent) => this.handleMouseMove(event)
  private readonly onClick = () => this.handleClick()

  constructor(engine: GameEngine) {
    this.engine = engine
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
    this.engine.getDomElement().addEventListener('click', this.onClick)
  }

  setTargets(targets: PlanetWalkerTarget[]) {
    this.targets = targets
    if (this.activeTarget) {
      const updatedTarget = targets.find(target => target.id === this.activeTarget?.id)
      if (updatedTarget) {
        this.activeTarget = updatedTarget
      } else {
        this.disable()
      }
    }
  }

  update(dt: number) {
    if (!this.enabled || !this.activeTarget || !this.state) return

    const input = this.consumeInput()
    const result = simulatePlanetWalker(
      this.state,
      input,
      defaultWalkerParams(this.activeTarget.terrain),
      Math.min(dt, 1 / 20),
    )
    this.state = result.state

    const worldEye = toThree(result.eyePosition)
      .applyQuaternion(this.activeTarget.worldQuaternion)
      .add(this.activeTarget.worldPosition)
    this.engine.camera.position.copy(worldEye)
    this.applyCameraOrientation(
      toThree(result.forward).applyQuaternion(this.activeTarget.worldQuaternion),
      toThree(result.right).applyQuaternion(this.activeTarget.worldQuaternion),
      toThree(result.up).applyQuaternion(this.activeTarget.worldQuaternion),
      result.state.pitch,
    )
  }

  dispose() {
    this.disable()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.engine.getDomElement().removeEventListener('click', this.onClick)
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.code === 'KeyH' && !event.repeat) {
      if (this.enabled) {
        this.disable()
      } else {
        this.enableNearest()
      }
      return
    }

    if (!this.enabled) return
    this.keys.add(event.code)
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
      event.preventDefault()
    }
  }

  private handleKeyUp(event: KeyboardEvent) {
    this.keys.delete(event.code)
  }

  private handleMouseMove(event: MouseEvent) {
    if (!this.enabled || document.pointerLockElement !== this.engine.getDomElement()) return
    this.pendingYaw += event.movementX
    this.pendingPitch -= event.movementY
  }

  private handleClick() {
    if (!this.enabled || document.pointerLockElement === this.engine.getDomElement()) return
    void this.engine.getDomElement().requestPointerLock()
  }

  private enableNearest() {
    const cameraPos = this.engine.camera.position
    let nearest: PlanetWalkerTarget | null = null
    let nearestSurfaceDistance = Infinity

    for (const target of this.targets) {
      const surfaceDistance = Math.abs(cameraPos.distanceTo(target.worldPosition) - target.terrain.radius)
      if (surfaceDistance < nearestSurfaceDistance) {
        nearestSurfaceDistance = surfaceDistance
        nearest = target
      }
    }

    if (!nearest) return

    const inverseTargetRotation = nearest.worldQuaternion.clone().invert()
    const local = cameraPos.clone().sub(nearest.worldPosition).applyQuaternion(inverseTargetRotation)
    const dir = normalize(toVec3Like(local.lengthSq() > 1e-6 ? local : new THREE.Vector3(0, 1, 0)))
    const params = defaultWalkerParams(nearest.terrain)
    const radius = samplePlanetRadius(dir, nearest.terrain) + params.eyeHeight
    this.activeTarget = nearest
    const yaw = this.computeInitialYaw(dir)
    this.state = createWalkerState(scale(dir, radius), yaw)
    this.enabled = true
    this.engine.setOrbitControlsEnabled(false)
    this.engine.setPixelRatioLimit(1)
    void this.engine.getDomElement().requestPointerLock()
  }

  private computeInitialYaw(upLike: Vec3Like): number {
    if (!this.activeTarget) return 0
    const inverseTargetRotation = this.activeTarget.worldQuaternion.clone().invert()
    const up = toThree(upLike).normalize()
    const east = new THREE.Vector3(1, 0, 0).projectOnPlane(up)
    if (east.lengthSq() < 1e-8) east.set(0, 0, -1).projectOnPlane(up)
    east.normalize()
    const north = new THREE.Vector3().crossVectors(up, east).normalize()
    const cameraForward = new THREE.Vector3()
    this.engine.camera.getWorldDirection(cameraForward)
    cameraForward.applyQuaternion(inverseTargetRotation)
    cameraForward.projectOnPlane(up)
    if (cameraForward.lengthSq() < 1e-8) return 0
    cameraForward.normalize()
    return Math.atan2(cameraForward.dot(east), cameraForward.dot(north))
  }

  private disable() {
    this.enabled = false
    this.activeTarget = null
    this.state = null
    this.keys.clear()
    this.pendingYaw = 0
    this.pendingPitch = 0
    this.engine.setOrbitControlsEnabled(true)
    this.engine.setPixelRatioLimit(2)
    if (document.pointerLockElement === this.engine.getDomElement()) {
      document.exitPointerLock()
    }
  }

  private consumeInput(): WalkerInput {
    const moveX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
    const moveY = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
    const input = {
      moveX,
      moveY,
      jump: this.keys.has('Space'),
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      yawDelta: this.pendingYaw,
      pitchDelta: this.pendingPitch,
    }
    this.pendingYaw = 0
    this.pendingPitch = 0
    return input
  }

  private applyCameraOrientation(forwardLike: THREE.Vector3, rightLike: THREE.Vector3, upLike: THREE.Vector3, pitch: number) {
    const forward = forwardLike.clone().normalize()
    const right = rightLike.clone().normalize()
    const up = upLike.clone().normalize()
    const lookDir = forward.multiplyScalar(Math.cos(pitch)).add(up.clone().multiplyScalar(Math.sin(pitch))).normalize()
    const cameraUp = new THREE.Vector3().crossVectors(right, lookDir).normalize()
    const matrix = new THREE.Matrix4().makeBasis(right, cameraUp, lookDir.clone().negate())
    this.engine.camera.quaternion.setFromRotationMatrix(matrix)
    this.engine.camera.up.copy(cameraUp)
  }
}

import * as THREE from 'three'
import type { GameEngine } from './engine'
import { encodePose } from './network-pose'
import { PlayerAvatar } from './player-avatar'
import {
  createWalkerState,
  defaultWalkerParams,
  simulatePlanetWalker,
  type WalkerInput,
  type WalkerState,
} from '../../../server/spacetimedb/src/shared/player-movement'
import { normalize, scale, type Vec3Like } from '../../../server/spacetimedb/src/shared/vector'
import { samplePlanetRadius, type PlanetTerrainParams } from '../../../server/spacetimedb/src/shared/planet-terrain'
import { clampCameraAbovePlanet } from './planet-camera'
import { atmosphereDepthAt } from './planet-sunlight'

export interface PlanetWalkerTarget {
  id: string
  worldPosition: THREE.Vector3
  worldQuaternion: THREE.Quaternion
  terrain: PlanetTerrainParams
  atmosphereColor: string
  atmosphereDensity: number
  cloudShadow?: {
    mask: THREE.Texture
    maskOffset: number
    height: number
    strength: number
  }
  sampleSurfaceRadius?: (dir: Vec3Like) => number
  /**
   * Radius of the ocean surface, or well below the terrain when the planet has
   * no water. Kept as a radius rather than a flag so "is this spot underwater"
   * is one comparison against a sampled surface radius, and so a waterless
   * planet needs no special case: getSeaHeight returns -10 there, which puts
   * this far under anything the terrain can reach.
   */
  seaRadius?: number
}

const THIRD_PERSON_CAMERA_DISTANCE = 4.8
const THIRD_PERSON_CAMERA_HEIGHT = 0.85
const THIRD_PERSON_LOOK_TARGET_HEIGHT = 0.25
const THIRD_PERSON_CAMERA_SHOULDER = 0
const THIRD_PERSON_CAMERA_BOOM_LENGTH = Math.hypot(
  THIRD_PERSON_CAMERA_DISTANCE,
  THIRD_PERSON_CAMERA_HEIGHT,
  THIRD_PERSON_CAMERA_SHOULDER,
)
const CAMERA_COLLISION_RADIUS = 0.32
const CAMERA_SURFACE_CLEARANCE = 0.28
const AVATAR_TURN_LERP = 16
const ATMOSPHERE_RADIUS_SCALE = 1.08
const ATMOSPHERE_LIGHT_SUN_BLEND = 0.56

function toVec3Like(v: THREE.Vector3): Vec3Like {
  return { x: v.x, y: v.y, z: v.z }
}

function toThree(v: Vec3Like): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z)
}

function lengthVec3Like(v: Vec3Like): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

function smoothstep01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
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
  private avatar: PlayerAvatar
  private avatarForward = new THREE.Vector3(0, 0, 1)
  private avatarRight = new THREE.Vector3(1, 0, 0)
  private avatarSunColor = new THREE.Color()
  private avatarSunPosition = new THREE.Vector3()
  private avatarAtmosphereLightColor = new THREE.Color(0xc4d5df)
  private avatarCloudLocalSurfaceDirection = new THREE.Vector3(0, 1, 0)
  private avatarCloudLocalSunDirection = new THREE.Vector3(0, 1, 0)
  private inverseTargetQuaternion = new THREE.Quaternion()
  private pendingJumpRequest = false
  // Last computed eye position, in world space. Cached rather than recomputed
  // on demand because the only correct value is the one the simulation just
  // produced -- deriving it again from `state` would silently disagree with
  // whatever the camera did this frame.
  private worldEyePosition = new THREE.Vector3()
  private hasWorldEye = false
  // While another system owns the player -- boarding a ship, say -- H must not
  // yank control back mid-transition.
  private toggleAllowed = true
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event)
  private readonly onKeyUp = (event: KeyboardEvent) => this.handleKeyUp(event)
  private readonly onMouseMove = (event: MouseEvent) => this.handleMouseMove(event)
  private readonly onClick = () => this.handleClick()

  constructor(engine: GameEngine) {
    this.engine = engine
    this.avatar = new PlayerAvatar(engine.scene)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
    this.engine.getDomElement().addEventListener('click', this.onClick)
  }

  setTargets(targets: PlanetWalkerTarget[]) {
    this.targets = targets.filter(target => target.terrain.planetType !== 'gas')
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
    const wasGrounded = this.state.grounded
    const jumpStarted = wasGrounded && input.jump
    const walkerParams = {
      ...defaultWalkerParams(this.activeTarget.terrain),
      sampleSurfaceRadius: this.activeTarget.sampleSurfaceRadius,
    }
    const result = simulatePlanetWalker(
      this.state,
      input,
      walkerParams,
      Math.min(dt, 1 / 20),
    )
    this.state = result.state

    const worldEye = toThree(result.eyePosition)
      .applyQuaternion(this.activeTarget.worldQuaternion)
      .add(this.activeTarget.worldPosition)
    const worldForward = toThree(result.forward).applyQuaternion(this.activeTarget.worldQuaternion)
    const worldRight = toThree(result.right).applyQuaternion(this.activeTarget.worldQuaternion)
    const worldUp = toThree(result.up).applyQuaternion(this.activeTarget.worldQuaternion)
    const worldFeet = worldEye.clone().addScaledVector(worldUp, -(walkerParams.eyeHeight + walkerParams.groundClearance))
    const worldVelocity = toThree(result.state.velocity).applyQuaternion(this.activeTarget.worldQuaternion)
    const tangentVelocity = worldVelocity.clone().addScaledVector(worldUp, -worldVelocity.dot(worldUp))
    const verticalSpeed = worldVelocity.dot(worldUp)
    const sunColor = this.engine.getSunColor(this.avatarSunColor)
    const sunPosition = this.engine.getSunPosition(this.avatarSunPosition)
    const atmosphereLightColor = this.avatarAtmosphereLightColor
      .set(this.activeTarget.atmosphereColor)
      .lerp(sunColor, ATMOSPHERE_LIGHT_SUN_BLEND)
    const localRadius = lengthVec3Like(result.eyePosition)
    const atmosphereInfluence = this.computeAtmosphereInfluence(result.up, localRadius)
    const cloudShadow = this.activeTarget.cloudShadow
    const cloudShadowInfluence = cloudShadow
      ? this.computeCloudShadowInfluence(result.up, localRadius, cloudShadow.height, cloudShadow.strength)
      : 0
    this.avatarCloudLocalSurfaceDirection.set(result.up.x, result.up.y, result.up.z)
    this.inverseTargetQuaternion.copy(this.activeTarget.worldQuaternion).invert()
    this.avatarCloudLocalSunDirection
      .copy(sunPosition)
      .sub(this.activeTarget.worldPosition)
      .applyQuaternion(this.inverseTargetQuaternion)
    if (this.avatarCloudLocalSunDirection.lengthSq() > 1e-6) {
      this.avatarCloudLocalSunDirection.normalize()
    } else {
      this.avatarCloudLocalSunDirection.set(0, 1, 0)
    }
    this.updateAvatarFacing(tangentVelocity, worldForward, worldRight, worldUp, input, dt)

    this.avatar.update(dt, {
      position: worldFeet,
      forward: this.avatarForward,
      right: this.avatarRight,
      up: worldUp,
      sunPosition,
      sunColor,
      atmosphereLightColor,
      atmosphereInfluence,
      cloudMask: cloudShadow?.mask ?? null,
      cloudMaskOffset: cloudShadow?.maskOffset ?? 0,
      cloudHeight: cloudShadow?.height ?? 0.045,
      cloudShadowStrength: cloudShadow?.strength ?? 0,
      cloudShadowInfluence,
      cloudLocalSurfaceDirection: this.avatarCloudLocalSurfaceDirection,
      cloudLocalSunDirection: this.avatarCloudLocalSunDirection,
      planetRadius: this.activeTarget.terrain.radius,
      actorRadius: localRadius,
      atmosphereDepth: this.computeAtmosphereDepth(result.up, localRadius),
      moveX: input.moveX,
      moveY: input.moveY,
      yawDelta: input.yawDelta,
      sprint: input.sprint,
      grounded: result.state.grounded,
      jumpStarted,
      speed: tangentVelocity.length(),
      verticalSpeed,
    })
    this.worldEyePosition.copy(worldEye)
    this.hasWorldEye = true
    this.applyThirdPersonCamera(worldEye, worldForward, worldRight, worldUp, result.state.pitch, dt)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getActiveTarget(): PlanetWalkerTarget | null {
    return this.activeTarget
  }

  /** World-space eye position from the last simulated step. False before the first. */
  getEyeWorldPosition(out: THREE.Vector3): boolean {
    if (!this.hasWorldEye) return false
    out.copy(this.worldEyePosition)
    return true
  }

  /** Planet-local direction of the player, i.e. the "up" under their feet. */
  getLocalDirection(out: THREE.Vector3): boolean {
    if (!this.state) return false
    out.set(this.state.localPosition.x, this.state.localPosition.y, this.state.localPosition.z)
    if (out.lengthSq() < 1e-8) return false
    out.normalize()
    return true
  }

  getNetworkPose() {
    if (!this.enabled || !this.activeTarget || !this.state) return null
    return { pose: encodePose(this.avatar.group, this.activeTarget),
      speed: Math.hypot(this.state.velocity.x, this.state.velocity.y, this.state.velocity.z),
      grounded: this.state.grounded }
  }

  getYaw(): number {
    return this.state?.yaw ?? 0
  }

  /** Stops H from toggling walk mode. Used while another system owns the player. */
  setToggleAllowed(allowed: boolean) {
    this.toggleAllowed = allowed
  }

  /** Hands the player to another system without bouncing the camera through OrbitControls. */
  releaseWithoutRestoringCamera() {
    if (this.enabled) this.disable(false)
  }

  /**
   * Puts the player back on the surface at a chosen spot, which is what
   * stepping out of a ship is: the walker's own entry point picks a direction
   * from wherever the camera happens to be, and after a flight that is the
   * cockpit, not the ground.
   */
  enableAt(target: PlanetWalkerTarget, localDirection: THREE.Vector3, yaw: number) {
    if (target.terrain.planetType === 'gas') return
    const dir = normalize(toVec3Like(localDirection))
    const params = defaultWalkerParams(target.terrain)
    const radius = (target.sampleSurfaceRadius?.(dir) ?? samplePlanetRadius(dir, target.terrain)) + params.eyeHeight
    this.activeTarget = target
    this.state = createWalkerState(scale(dir, radius), yaw)
    const up = toThree(dir).applyQuaternion(target.worldQuaternion).normalize()
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(target.worldQuaternion).projectOnPlane(up)
    if (forward.lengthSq() < 1e-6) forward.set(1, 0, 0).projectOnPlane(up)
    this.avatarForward.copy(forward.normalize())
    this.avatarRight.crossVectors(up, this.avatarForward).normalize()
    this.enabled = true
    this.hasWorldEye = false
    this.avatar.setVisible(true)
    this.engine.setOrbitControlsEnabled(false)
    this.engine.setPixelRatioLimit(1)
    void this.engine.getDomElement().requestPointerLock()
  }

  dispose() {
    this.disable()
    this.avatar.dispose()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.engine.getDomElement().removeEventListener('click', this.onClick)
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.code === 'KeyH' && !event.repeat && this.toggleAllowed) {
      if (this.enabled) {
        this.disable()
      } else {
        this.enableNearest()
      }
      return
    }

    if (!this.enabled) return
    this.keys.add(event.code)
    if (event.code === 'Space' && !event.repeat) {
      this.pendingJumpRequest = true
    }
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
    const radius = (nearest.sampleSurfaceRadius?.(dir) ?? samplePlanetRadius(dir, nearest.terrain)) + params.eyeHeight
    this.activeTarget = nearest
    const yaw = this.computeInitialYaw(dir)
    this.state = createWalkerState(scale(dir, radius), yaw)
    const initialUp = toThree(dir).applyQuaternion(nearest.worldQuaternion).normalize()
    const initialForward = this.engine.camera.getWorldDirection(new THREE.Vector3()).projectOnPlane(initialUp)
    if (initialForward.lengthSq() < 1e-6) initialForward.set(0, 0, -1).projectOnPlane(initialUp)
    this.avatarForward.copy(initialForward.normalize())
    this.avatarRight.crossVectors(initialUp, this.avatarForward).normalize()
    this.enabled = true
    this.avatar.setVisible(true)
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

  /**
   * `restoreCamera` is false when another system is taking the player over
   * rather than the player stepping back out to the orbit view: handing the
   * camera to OrbitControls mid-handoff snaps it to the orbit target and
   * undoes the pixel-ratio drop for the two frames before the new owner takes
   * hold, which reads as a flash.
   */
  private disable(restoreCamera = true) {
    this.enabled = false
    this.activeTarget = null
    this.state = null
    this.hasWorldEye = false
    this.avatar.setVisible(false)
    this.keys.clear()
    this.pendingYaw = 0
    this.pendingPitch = 0
    this.pendingJumpRequest = false
    if (restoreCamera) {
      this.engine.setOrbitControlsEnabled(true)
      this.engine.setPixelRatioLimit(2)
    }
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
      jump: this.pendingJumpRequest,
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      yawDelta: this.pendingYaw,
      pitchDelta: this.pendingPitch,
    }
    this.pendingYaw = 0
    this.pendingPitch = 0
    this.pendingJumpRequest = false
    return input
  }

  private applyThirdPersonCamera(
    worldEye: THREE.Vector3,
    forwardLike: THREE.Vector3,
    rightLike: THREE.Vector3,
    upLike: THREE.Vector3,
    pitch: number,
    _dt: number,
  ) {
    const forward = forwardLike.clone().normalize()
    const right = rightLike.clone().normalize()
    const up = upLike.clone().normalize()
    const lookDirection = forward.clone()
      .multiplyScalar(Math.cos(pitch))
      .addScaledVector(up, Math.sin(pitch))
      .normalize()
    const lookTarget = worldEye.clone()
      .addScaledVector(forward, 1.35)
      .addScaledVector(up, THIRD_PERSON_LOOK_TARGET_HEIGHT)
    const cameraOffset = new THREE.Vector3()
      .addScaledVector(lookDirection, -THIRD_PERSON_CAMERA_DISTANCE)
      .addScaledVector(right, THIRD_PERSON_CAMERA_SHOULDER)
      .addScaledVector(up, THIRD_PERSON_CAMERA_HEIGHT)
    if (cameraOffset.lengthSq() > 1e-6) {
      cameraOffset.setLength(THIRD_PERSON_CAMERA_BOOM_LENGTH)
    }
    const desiredCameraPosition = lookTarget.clone()
      .add(cameraOffset)
    const cameraPosition = this.resolveCameraCollision(lookTarget, desiredCameraPosition)

    this.engine.camera.position.copy(cameraPosition)
    this.engine.camera.up.copy(up)
    this.engine.camera.lookAt(lookTarget)
  }

  private updateAvatarFacing(
    tangentVelocity: THREE.Vector3,
    worldForward: THREE.Vector3,
    worldRight: THREE.Vector3,
    worldUp: THREE.Vector3,
    input: WalkerInput,
    dt: number,
  ) {
    const desired = tangentVelocity.lengthSq() > 0.18
      ? tangentVelocity.clone().normalize()
      : (Math.abs(input.moveX) + Math.abs(input.moveY) > 0.1
          ? worldForward.clone().multiplyScalar(input.moveY).addScaledVector(worldRight, input.moveX).projectOnPlane(worldUp).normalize()
          : null)

    if (desired && desired.lengthSq() > 0.5) {
      const t = 1 - Math.exp(-AVATAR_TURN_LERP * dt)
      this.avatarForward.lerp(desired, t).projectOnPlane(worldUp).normalize()
    } else {
      this.avatarForward.projectOnPlane(worldUp)
      if (this.avatarForward.lengthSq() < 1e-6) this.avatarForward.copy(worldForward).projectOnPlane(worldUp)
      this.avatarForward.normalize()
    }

    this.avatarRight.crossVectors(worldUp, this.avatarForward).normalize()
    this.avatarForward.crossVectors(this.avatarRight, worldUp).normalize()
  }

  /**
   * How deep inside the atmosphere shell the actor is: 1 at the ground, 0 above
   * it. Deliberately *not* scaled by atmosphereDensity, unlike the influence
   * below. Density belongs in "how much does the air tint the light"; using it
   * here would also sharpen the terminator on thin-atmosphere planets, which is
   * arguably right physics but would change ground lighting that is already
   * tuned. That is a look decision, not a correctness one.
   */
  private computeAtmosphereDepth(localUp: Vec3Like, localRadius: number): number {
    if (!this.activeTarget) return 0
    const surfaceRadius = this.activeTarget.sampleSurfaceRadius?.(localUp)
      ?? samplePlanetRadius(localUp, this.activeTarget.terrain)
    return atmosphereDepthAt(surfaceRadius, this.activeTarget.terrain.radius, localRadius, ATMOSPHERE_RADIUS_SCALE)
  }

  private computeAtmosphereInfluence(localUp: Vec3Like, localRadius: number): number {
    if (!this.activeTarget || this.activeTarget.atmosphereDensity <= 0.001) return 0

    const surfaceRadius = this.activeTarget.sampleSurfaceRadius?.(localUp)
      ?? samplePlanetRadius(localUp, this.activeTarget.terrain)
    const atmosphereRadius = this.activeTarget.terrain.radius * ATMOSPHERE_RADIUS_SCALE
    if (atmosphereRadius <= surfaceRadius || localRadius >= atmosphereRadius) return 0

    const altitude01 = (localRadius - surfaceRadius) / (atmosphereRadius - surfaceRadius)
    const density = THREE.MathUtils.clamp(this.activeTarget.atmosphereDensity, 0, 1)
    return (1 - smoothstep01(altitude01)) * density
  }

  private computeCloudShadowInfluence(
    localUp: Vec3Like,
    localRadius: number,
    cloudHeight: number,
    cloudShadowStrength: number,
  ): number {
    if (!this.activeTarget || cloudShadowStrength <= 0.001) return 0

    const surfaceRadius = this.activeTarget.sampleSurfaceRadius?.(localUp)
      ?? samplePlanetRadius(localUp, this.activeTarget.terrain)
    const cloudRadius = this.activeTarget.terrain.radius * (1 + THREE.MathUtils.clamp(cloudHeight, 0.001, 0.20))
    if (cloudRadius <= surfaceRadius || localRadius >= cloudRadius) return 0

    const altitude01 = (localRadius - surfaceRadius) / (cloudRadius - surfaceRadius)
    return 1 - smoothstep01((altitude01 - 0.75) / 0.25)
  }

  private resolveCameraCollision(_lookTarget: THREE.Vector3, desiredCameraPosition: THREE.Vector3): THREE.Vector3 {
    const target = this.activeTarget
    if (!target) return desiredCameraPosition
    return clampCameraAbovePlanet(
      desiredCameraPosition,
      target.worldPosition,
      target.worldQuaternion,
      dir => target.sampleSurfaceRadius?.(dir) ?? samplePlanetRadius(dir, target.terrain),
      CAMERA_COLLISION_RADIUS + CAMERA_SURFACE_CLEARANCE,
    )
  }
}

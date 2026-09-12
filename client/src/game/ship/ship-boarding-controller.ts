import * as THREE from 'three'
import type { GameEngine } from '../engine'
import type { PlanetWalkerController, PlanetWalkerTarget } from '../planet-walker-controller'
import type { ShipModel } from './ship-model'
import type { LandedShip } from './landed-ship'
import { findLandingSite, surfaceSlopeDegrees } from './ship-landing-site'
import { FlightFrame } from './flight-frame'
import { ShipFlight } from './ship-flight'
import { clampCameraAbovePlanet } from '../planet-camera'
import { textEntry } from '../text-entry'
import { samplePlanetRadius } from '../../../../server/spacetimedb/src/shared/planet-terrain'

/**
 * Owns the handoff between walking, sitting in the ship, and flying it.
 *
 * The flight model itself lives in ShipFlight and knows nothing about modes,
 * keys or cameras. This class is the part that decides when it runs, and it
 * holds the four scripted moments -- boarding, take-off, landing, disembarking
 * -- where the player is briefly not in control and something has to look
 * deliberate rather than teleported.
 */
export type PlayerMode =
  | 'free'
  | 'walking'
  | 'boarding'
  | 'piloting'
  | 'takingOff'
  | 'flying'
  | 'landing'
  | 'disembarking'

const BOARD_DISTANCE_METERS = 11
const TRANSITION_SECONDS = 1.1
// The camera flies an arc rather than a straight line: the direct segment from
// a player standing beside the hull to a seat behind it passes through the
// hull, and near-plane clipping through your own ship looks like a bug.
const TRANSITION_ARC_METERS = 3.5
const CHASE_DISTANCE_FACTOR = 2.2
const CHASE_HEIGHT_FACTOR = 0.55
const LOOK_SENSITIVITY = 0.0022
const MIN_PITCH = -0.35
const MAX_PITCH = 1.05
// Where the player is put down on the way out, measured sideways from the hull
// centre so they never materialise inside it.
const DISEMBARK_CLEARANCE_METERS = 3.5
// A slope the walker would immediately slide down is not a place to be left
// standing; sampleGroundSlide starts sliding at 30 degrees.
const MAX_DISEMBARK_SLOPE_DEGREES = 28
// Summoning. The ship lands near you, not on you: the near edge is far enough
// that the hull's wingspan clears the player.
const SUMMON_MIN_DISTANCE_METERS = 16
const SUMMON_MAX_DISTANCE_METERS = 34
const SUMMON_MAX_SLOPE_DEGREES = 14
const ARRIVAL_SECONDS = 4.2
const ARRIVAL_HEIGHT_METERS = 70
// It comes in from one side rather than dropping straight down, which reads as
// flying rather than as teleporting with extra steps.
const ARRIVAL_APPROACH_METERS = 90
// Keeps the chase camera out of the ground. Larger than the walker's 0.60 m
// because the ship camera sits further back, so the same near-plane sliver
// covers much more terrain.
const CHASE_GROUND_CLEARANCE_METERS = 2.2

// Take-off is a hold, not a press: the engines spin up while W is held and the
// ship leaves the ground when they are ready. A tap is how you nudge the
// throttle once airborne, so it must not also be how you launch.
const TAKEOFF_HOLD_SECONDS = 1.15
// Charge bleeds away faster than it builds, so letting go abandons the launch
// instead of leaving it primed.
const TAKEOFF_DECAY_RATE = 2.5
const TAKEOFF_RISE_SECONDS = 1.9
const TAKEOFF_RISE_METERS = 34

// Landing is offered, not forced: E only lands when the ship is low, slow and
// over ground it can actually sit on.
// Generous on purpose. With no gravity the ship hovers where you leave it, so
// a tight ceiling leaves the player stuck a few metres above it with no way
// down: descending needs throttle, and throttle carries you forward. The
// scripted descent covers the gap instead, which is also how it reads in the
// game being copied -- you fly low, press land, and the ship does the swoop.
const LANDING_MAX_CLEARANCE_METERS = 90
const LANDING_MAX_SPEED = 26
const LANDING_MAX_SLOPE_DEGREES = 22
const LANDING_SECONDS = 2.8

// Steering is a virtual joystick, not a mouse-look. The mouse moves a reticle
// away from screen centre and the ship turns at a rate proportional to how far
// it sits from centre, so the turn continues while the reticle is held off
// centre and stops when it comes back. The alternative -- turning by how much
// the mouse moved this frame -- makes a stationary mouse mean "stop turning",
// which is mouse-look, and reads nothing like flying.
//
// Pixels of mouse travel from centre to full deflection.
const RETICLE_RANGE_PIXELS = 260
// Nothing happens inside this fraction of the range, so the ship holds an
// attitude instead of drifting on a reticle that is one pixel off centre.
const RETICLE_DEADZONE = 0.07
// Deflection is curved before it becomes a turn rate: the outer half of the
// travel carries most of the authority, which leaves fine aiming near centre.
const RETICLE_RESPONSE_EXPONENT = 1.7
// A very slow pull back to centre -- a ~7 second time constant, so a held turn
// visibly keeps turning and only a forgotten one decays. Anything brisker turns
// the control back into mouse-look by the back door: the ship stops as soon as
// the hand does, which is the thing this replaced. Set to 0 for a pure
// joystick that holds its deflection forever.
const RETICLE_RECENTRE_RATE = 0.15
const THROTTLE_RATE = 0.85
// With neither W nor S held the throttle bleeds off, so a ship left alone coasts
// to a stop instead of crossing the system on its own. Slow enough that taking
// a hand off the keys to steer costs almost nothing: from full it takes about
// eleven seconds to reach zero.
const THROTTLE_IDLE_DECAY = 0.09
// Free look. Holding Alt parks the stick and lets the mouse swing the camera
// around the hull, so the player can check their six or watch a planet go by
// without the ship following their gaze.
const FREE_LOOK_SENSITIVITY = 0.0026
const FREE_LOOK_MAX_PITCH = 1.25
// How fast the view eases in and out. The angles are scaled by this blend
// rather than snapped back, so letting go of Alt swings the camera home
// instead of cutting to it.
const FREE_LOOK_BLEND_RATE = 7.5
// Where the chase camera sits while flying, in hull lengths.
const FLIGHT_CAMERA_BACK = 2.6
const FLIGHT_CAMERA_UP = 0.75
const FLIGHT_CAMERA_LAG = 6.5

function smoothstep01(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

export class ShipBoardingController {
  private engine: GameEngine
  private walker: PlanetWalkerController
  private ship: ShipModel
  private landed: LandedShip
  private mode: PlayerMode = 'free'
  private target: PlanetWalkerTarget | null = null
  private transition = 0
  private prompt: HTMLDivElement | null = null
  private promptText = ''
  // A flash has to outrank the ambient prompt for a while, or refreshPrompt
  // overwrites it on the very next frame and the player never sees why the
  // door refused to open.
  private flashRemaining = 0
  private yaw = 0
  private pitch = 0.22
  private pendingYaw = 0
  private pendingPitch = 0
  private readonly from = new THREE.Vector3()
  private readonly to = new THREE.Vector3()
  private readonly lookFrom = new THREE.Vector3()
  private readonly lookTo = new THREE.Vector3()
  private readonly scratch = new THREE.Vector3()
  private readonly playerEye = new THREE.Vector3()
  private readonly localDirection = new THREE.Vector3()
  private readonly cameraTarget = new THREE.Vector3()
  private readonly exitDirection = new THREE.Vector3(0, 1, 0)
  private exitYaw = 0
  private arrivalRemaining = 0
  private readonly arrivalFrom = new THREE.Vector3()
  private readonly arrivalTo = new THREE.Vector3()
  private readonly arrivalDirection = new THREE.Vector3()
  private arrivalHeading = 0
  private readonly flight = new ShipFlight()
  private readonly flightFrame = new FlightFrame()
  private readonly held = new Set<string>()
  private takeoffCharge = 0
  private takeoffRemaining = 0
  private landingRemaining = 0
  private throttle = 0
  private readonly flightInput = { throttle: 0, pitch: 0, yaw: 0, roll: 0 }
  // Screen convention: x right, y down, both in units of RETICLE_RANGE_PIXELS,
  // clamped to a disc so a diagonal is not faster than an axis.
  private readonly reticle = new THREE.Vector2()
  private reticleElement: HTMLDivElement | null = null
  private readonly localPosition = new THREE.Vector3()
  private readonly localQuaternion = new THREE.Quaternion()
  private readonly cameraDesired = new THREE.Vector3()
  // Camera position kept as an offset from the hull rather than as a world
  // point, so that smoothing it cannot turn speed into distance.
  private readonly cameraOffset = new THREE.Vector3()
  private cameraOffsetReady = false
  private freeLookYaw = 0
  private freeLookPitch = 0
  private freeLookBlend = 0
  private freeLookActive = false
  private readonly freeLookRotation = new THREE.Quaternion()
  private readonly freeLookPitchRotation = new THREE.Quaternion()
  private readonly freeLookAxis = new THREE.Vector3()
  private readonly lookAhead = new THREE.Vector3()
  private readonly cameraLook = new THREE.Vector3()
  private readonly axisForward = new THREE.Vector3()
  private readonly axisUp = new THREE.Vector3()
  private readonly landingDirection = new THREE.Vector3()
  private readonly inverseTarget = new THREE.Quaternion()
  private landingHeading = 0
  private landingFromRadius = 0
  private landingToRadius = 0
  private pointerLocked = false
  private readonly onCanvasClick = () => this.handleCanvasClick()
  private readonly onPointerLockChange = () => this.handlePointerLockChange()
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event)
  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.held.delete(event.code)
    this.refreshFreeLook()
  }
  private readonly onMouseMove = (event: MouseEvent) => this.handleMouseMove(event)
  private stopTextEntry: () => void

  constructor(
    engine: GameEngine,
    walker: PlanetWalkerController,
    ship: ShipModel,
    landed: LandedShip,
  ) {
    this.engine = engine
    this.walker = walker
    this.ship = ship
    this.landed = landed
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
    // The walker owns the pointer lock while on foot, but it re-acquires it on
    // click only while it is enabled -- and it is disabled the whole time the
    // player is in the ship. So once the lock was dropped in flight (Escape,
    // alt-tab, a notification stealing focus) nothing asked for it back and the
    // stick went dead with no way to revive it.
    this.engine.getDomElement().addEventListener('click', this.onCanvasClick)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    // A throttle left open while the player types would keep accelerating with
    // nothing on screen explaining why, so the stick and the keys both let go.
    this.stopTextEntry = textEntry.subscribe(active => {
      if (!active) return
      this.held.clear()
      this.reticle.set(0, 0)
      this.refreshFreeLook()
    })
    this.pointerLocked = document.pointerLockElement === this.engine.getDomElement()
    this.prompt = this.createPrompt()
    this.reticleElement = this.createReticle()
  }

  getMode(): PlayerMode {
    return this.mode
  }

  restoreFlight(target: PlanetWalkerTarget, worldPosition: THREE.Vector3, worldQuaternion: THREE.Quaternion, speed: number) {
    this.target = target
    this.toLocal(worldPosition, this.localPosition)
    this.localQuaternion.copy(target.worldQuaternion).invert().multiply(worldQuaternion)
    this.flight.enterFrom(this.localPosition, this.localQuaternion, speed)
    this.flightFrame.reset(target.id, target.worldPosition, target.worldQuaternion)
    this.walker.releaseWithoutRestoringCamera()
    this.walker.setToggleAllowed(false)
    this.engine.setOrbitControlsEnabled(false)
    this.cameraOffsetReady = false
    this.mode = 'flying'
    this.writeShipFromFlight()
    this.applyFlightCamera(0)
  }

  setTarget(target: PlanetWalkerTarget | null) {
    this.target = target
  }

  update(dt: number) {
    // The walker owns 'free' and 'walking' on its own; this only mirrors it so
    // the prompt knows whether the player is on foot.
    if (this.mode === 'free' || this.mode === 'walking') {
      this.mode = this.walker.isEnabled() ? 'walking' : 'free'
    }
    if (this.arrivalRemaining > 0) this.advanceArrival(dt)

    switch (this.mode) {
      case 'boarding':
      case 'disembarking':
        this.advanceTransition(dt)
        break
      case 'piloting':
        this.advanceTakeoffCharge(dt)
        this.applyChaseCamera()
        break
      case 'takingOff':
        this.advanceTakeoff(dt)
        break
      case 'flying':
        this.advanceFlight(dt)
        break
      case 'landing':
        this.advanceLanding(dt)
        break
    }
    this.refreshPrompt(dt)
    if (this.reticleElement) {
      this.reticleElement.style.opacity = this.mode === 'flying' ? '1' : '0'
    }
  }

  dispose() {
    this.stopTextEntry()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.engine.getDomElement().removeEventListener('click', this.onCanvasClick)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    this.prompt?.remove()
    this.prompt = null
    this.reticleElement?.remove()
    this.reticleElement = null
    this.walker.setToggleAllowed(true)
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (textEntry.active) return
    this.held.add(event.code)
    this.refreshFreeLook()
    if (event.repeat) return
    if (event.code === 'KeyC') {
      event.preventDefault()
      this.summon()
      return
    }
    if (event.code !== 'KeyE') return
    if (this.mode === 'walking' && this.isWithinBoardingRange()) {
      event.preventDefault()
      this.beginBoarding()
    } else if (this.mode === 'piloting') {
      event.preventDefault()
      this.beginDisembark()
    } else if (this.mode === 'flying') {
      event.preventDefault()
      this.tryLand()
    }
  }

  /** True while this controller, rather than the walker, should hold the mouse. */
  private wantsPointerLock(): boolean {
    return this.mode === 'piloting' || this.mode === 'takingOff'
      || this.mode === 'flying' || this.mode === 'landing'
  }

  private handleCanvasClick() {
    if (!this.wantsPointerLock()) return
    if (document.pointerLockElement === this.engine.getDomElement()) return
    // Chrome rejects the request for about a second after the user leaves the
    // lock with Escape, and rejects it outright if the document is not focused.
    // Both are recoverable by clicking again, so the failure is swallowed rather
    // than logged on every retry.
    void Promise.resolve(this.engine.getDomElement().requestPointerLock()).catch(() => {})
  }

  private handlePointerLockChange() {
    const locked = document.pointerLockElement === this.engine.getDomElement()
    // Losing the mouse with the reticle held over means the ship would keep
    // turning at a rate the player can no longer cancel, so the stick is
    // centred on the way out rather than on the way back in.
    if (this.pointerLocked && !locked) this.reticle.set(0, 0)
    this.pointerLocked = locked
  }

  private handleMouseMove(event: MouseEvent) {
    if (this.mode !== 'piloting' && this.mode !== 'flying') return
    if (document.pointerLockElement !== this.engine.getDomElement()) return
    if (this.mode === 'flying') {
      // altKey is read from the event as well as from the held set: a keyup can
      // be missed when the window loses focus mid-chord, and the sticky result
      // is a stick that stays dead with nothing on screen explaining why.
      if (event.altKey) this.held.add('AltLeft')
      else { this.held.delete('AltLeft'); this.held.delete('AltRight') }
      this.refreshFreeLook()
      if (this.isFreeLooking()) {
        this.freeLookYaw -= event.movementX * FREE_LOOK_SENSITIVITY
        // Plus, not minus. Measured on the real path: pushing the mouse up
        // swings the camera *below* the hull -- elevation 16 degrees to -14 --
        // so the view tilts upward, which is the uninverted convention people
        // expect when looking around. The other sign is the one that suits
        // aiming a nose, and it read as inverted here.
        this.freeLookPitch = THREE.MathUtils.clamp(
          this.freeLookPitch + event.movementY * FREE_LOOK_SENSITIVITY,
          -FREE_LOOK_MAX_PITCH, FREE_LOOK_MAX_PITCH,
        )
        return
      }
      this.reticle.x += event.movementX / RETICLE_RANGE_PIXELS
      this.reticle.y += event.movementY / RETICLE_RANGE_PIXELS
      if (this.reticle.lengthSq() > 1) this.reticle.normalize()
      return
    }
    this.pendingYaw += event.movementX
    this.pendingPitch += event.movementY
  }

  private isWithinBoardingRange(): boolean {
    if (this.arrivalRemaining > 0) return false
    if (!this.walker.getEyeWorldPosition(this.playerEye)) return false
    return this.playerEye.distanceTo(this.ship.object.position) <= BOARD_DISTANCE_METERS
  }

  /**
   * Calls the ship down beside the player.
   *
   * Only from on foot: from the cockpit there is nothing to call, and from the
   * orbit camera there is no player to call it to.
   */
  summon(): boolean {
    if (this.mode !== 'walking' || this.arrivalRemaining > 0) return false
    if (!this.target?.sampleSurfaceRadius) return false
    if (!this.walker.getLocalDirection(this.localDirection)) return false

    const site = findLandingSite({
      target: this.target,
      around: this.localDirection,
      minDistanceMeters: SUMMON_MIN_DISTANCE_METERS,
      maxDistanceMeters: SUMMON_MAX_DISTANCE_METERS,
      maxSlopeDegrees: SUMMON_MAX_SLOPE_DEGREES,
      spanMeters: this.ship.size.z,
      freeboardMeters: 2,
    })
    if (!site) {
      this.flashPrompt('Ground too rough to land here')
      return false
    }

    // Approach from the sunward side purely so the arrival is lit rather than a
    // silhouette; nothing downstream depends on it.
    const up = site.direction
    const east = new THREE.Vector3(1, 0, 0).projectOnPlane(up)
    if (east.lengthSq() < 1e-8) east.set(0, 0, -1).projectOnPlane(up)
    east.normalize()
    const angular = ARRIVAL_APPROACH_METERS / Math.max(site.surfaceRadius, 1)
    this.arrivalFrom.copy(up).addScaledVector(east, angular).normalize()
    this.arrivalTo.copy(up)

    // Face the player once parked.
    this.arrivalHeading = this.headingToward(site.direction, this.localDirection)
    this.arrivalRemaining = ARRIVAL_SECONDS
    this.flashPrompt('Ship on its way', ARRIVAL_SECONDS)
    return true
  }

  private advanceArrival(dt: number) {
    this.arrivalRemaining = Math.max(0, this.arrivalRemaining - dt)
    const t = 1 - this.arrivalRemaining / ARRIVAL_SECONDS
    // Ease out: most of the ground is covered early and the last few metres are
    // slow, which is what a landing looks like.
    const eased = 1 - Math.pow(1 - t, 3)

    this.arrivalDirection.copy(this.arrivalFrom).lerp(this.arrivalTo, eased).normalize()
    this.landed.place(this.arrivalDirection, this.arrivalHeading)
    const altitude = ARRIVAL_HEIGHT_METERS * Math.pow(1 - t, 2.2)
    // Level while high, surface-aligned by the time it settles.
    this.landed.setAltitudeOffset(altitude, Math.min(1, altitude / 12))

    if (this.arrivalRemaining <= 0) {
      this.landed.place(this.arrivalTo, this.arrivalHeading)
      this.landed.setAltitudeOffset(0, 0)
    }
  }

  /** Yaw, about `at`'s local up, that points the hull's nose toward `toward`. */
  private headingToward(at: THREE.Vector3, toward: THREE.Vector3): number {
    const up = at.clone().normalize()
    const east = new THREE.Vector3(1, 0, 0).projectOnPlane(up)
    if (east.lengthSq() < 1e-8) east.set(0, 0, -1).projectOnPlane(up)
    east.normalize()
    const north = new THREE.Vector3().crossVectors(up, east).normalize()
    const bearing = toward.clone().sub(up).projectOnPlane(up)
    if (bearing.lengthSq() < 1e-10) return 0
    return Math.atan2(bearing.dot(east), bearing.dot(north))
  }

  private beginBoarding() {
    if (!this.walker.getEyeWorldPosition(this.playerEye)) return
    this.from.copy(this.engine.camera.position)
    this.lookFrom.copy(this.playerEye)
    this.storeTransitionInPlanetFrame()
    // Face the ship's own heading, so stepping in does not spin the view.
    this.yaw = 0
    this.pitch = 0.22
    this.mode = 'boarding'
    this.transition = 0
    this.walker.setToggleAllowed(false)
    this.walker.releaseWithoutRestoringCamera()
  }

  private beginDisembark() {
    if (!this.resolveExitSpot()) {
      this.flashPrompt('No solid ground to step out onto here')
      return
    }
    this.from.copy(this.engine.camera.position)
    this.lookFrom.copy(this.ship.object.position)
    this.storeTransitionInPlanetFrame()
    this.mode = 'disembarking'
    this.transition = 0
    if (document.pointerLockElement === this.engine.getDomElement()) document.exitPointerLock()
  }

  private storeTransitionInPlanetFrame() {
    if (!this.target) return
    const inverse = this.target.worldQuaternion.clone().invert()
    this.from.sub(this.target.worldPosition).applyQuaternion(inverse)
    this.lookFrom.sub(this.target.worldPosition).applyQuaternion(inverse)
  }

  private advanceTransition(dt: number) {
    this.transition = Math.min(1, this.transition + dt / TRANSITION_SECONDS)
    const s = smoothstep01(this.transition)

    if (this.mode === 'boarding') {
      this.computeChasePose(this.to, this.lookTo)
    } else {
      this.computeExitPose(this.to, this.lookTo)
    }

    const up = this.scratch.copy(this.ship.object.position)
    if (this.target) up.sub(this.target.worldPosition)
    up.normalize()
    this.engine.camera.up.copy(up)
    const from = this.from.clone()
    const lookFrom = this.lookFrom.clone()
    if (this.target) {
      from.applyQuaternion(this.target.worldQuaternion).add(this.target.worldPosition)
      lookFrom.applyQuaternion(this.target.worldQuaternion).add(this.target.worldPosition)
    }
    this.engine.camera.position.lerpVectors(from, this.to, s)
      .addScaledVector(up, Math.sin(Math.PI * s) * TRANSITION_ARC_METERS)
    this.engine.camera.position.copy(this.clampAboveGround(this.engine.camera.position))
    const look = lookFrom.lerp(this.lookTo, s)
    this.engine.camera.lookAt(look)

    if (this.transition < 1) return

    if (this.mode === 'boarding') {
      this.mode = 'piloting'
      // Requested here rather than at the start of the transition: the walker's
      // exitPointerLock fires on the same tick as beginBoarding, and browsers
      // reject a re-request that lands too soon after one.
      void this.engine.getDomElement().requestPointerLock()
    } else {
      this.mode = 'walking'
      this.walker.setToggleAllowed(true)
      if (this.target) this.walker.enableAt(this.target, this.exitDirection, this.exitYaw)
    }
  }

  /** Third-person pose behind the hull, orbited by the mouse. */
  private computeChasePose(position: THREE.Vector3, look: THREE.Vector3) {
    const ship = this.ship.object
    const distance = this.ship.size.z * CHASE_DISTANCE_FACTOR
    const height = this.ship.size.z * CHASE_HEIGHT_FACTOR
    const back = this.scratch.set(0, 0, 1).applyQuaternion(ship.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.quaternion)
    const offset = back.clone()
      .applyAxisAngle(up, this.yaw)
      .multiplyScalar(distance * Math.cos(this.pitch))
      .addScaledVector(up, height + distance * Math.sin(this.pitch))
    position.copy(ship.position).add(offset)
    look.copy(ship.position).addScaledVector(up, this.ship.size.y * 0.5)
  }

  /** Roughly where the walker will put its own camera, so the handoff does not jump. */
  private computeExitPose(position: THREE.Vector3, look: THREE.Vector3) {
    if (!this.target) { position.copy(this.engine.camera.position); look.copy(this.ship.object.position); return }
    const radius = this.target.sampleSurfaceRadius?.({
      x: this.exitDirection.x, y: this.exitDirection.y, z: this.exitDirection.z,
    }) ?? this.target.terrain.radius
    const feet = this.exitDirection.clone().multiplyScalar(radius)
      .applyQuaternion(this.target.worldQuaternion).add(this.target.worldPosition)
    const up = this.exitDirection.clone().applyQuaternion(this.target.worldQuaternion).normalize()
    const toShip = this.ship.object.position.clone().sub(feet).projectOnPlane(up)
    if (toShip.lengthSq() < 1e-6) toShip.copy(up).cross(new THREE.Vector3(1, 0, 0))
    toShip.normalize()
    look.copy(feet).addScaledVector(up, 1.6)
    position.copy(feet).addScaledVector(toShip, -4.8).addScaledVector(up, 2.45)
  }

  /**
   * Picks a spot beside the hull that the walker will not immediately slide
   * off. Tries both flanks then behind, and reports failure rather than
   * dropping the player onto a cliff.
   */
  private resolveExitSpot(): boolean {
    if (!this.target) return false
    const shipUp = this.landed.getLocalDirection()
    const clearance = this.ship.size.x * 0.5 + DISEMBARK_CLEARANCE_METERS
    const site = findLandingSite({
      target: this.target,
      around: shipUp,
      minDistanceMeters: clearance,
      maxDistanceMeters: clearance + 5,
      maxSlopeDegrees: MAX_DISEMBARK_SLOPE_DEGREES,
      // A person, not a hull: the slope that matters is the one under their
      // feet, so this span is a stride rather than the ship's length.
      spanMeters: 2.5,
      freeboardMeters: 0.5,
    })
    if (!site) return false
    this.exitDirection.copy(site.direction)
    this.exitYaw = this.headingToward(site.direction, shipUp)
    return true
  }


  /** Same radial clamp the walker's boom uses, so neither camera sinks into the ground. */
  /**
   * Spins the engines up while W is held.
   *
   * A hold rather than a press because a tap of W is how the throttle is
   * nudged once airborne, and the two must not be the same gesture.
   */
  private advanceTakeoffCharge(dt: number) {
    if (this.held.has('KeyW')) {
      this.takeoffCharge += dt
      if (this.takeoffCharge >= TAKEOFF_HOLD_SECONDS) this.beginTakeoff()
      return
    }
    this.takeoffCharge = Math.max(0, this.takeoffCharge - dt * TAKEOFF_DECAY_RATE)
  }

  private beginTakeoff() {
    this.takeoffCharge = 0
    this.takeoffRemaining = TAKEOFF_RISE_SECONDS
    this.mode = 'takingOff'
  }

  /**
   * The scripted rise off the pad.
   *
   * levelBlend is driven alongside the altitude so the hull stops lying on the
   * terrain normal -- which may be several degrees off vertical -- and is
   * square to the sphere by the time the flight model takes over. Handing over
   * from a tilted pose instead puts a bank into the very first second of
   * flight that the player did not ask for.
   */
  private advanceTakeoff(dt: number) {
    this.takeoffRemaining = Math.max(0, this.takeoffRemaining - dt)
    const eased = smoothstep01(1 - this.takeoffRemaining / TAKEOFF_RISE_SECONDS)
    this.landed.setAltitudeOffset(TAKEOFF_RISE_METERS * eased, eased)
    this.applyChaseCamera()
    if (this.takeoffRemaining <= 0) this.enterFlightFromLanded()
  }

  private enterFlightFromLanded() {
    const target = this.target
    if (!target) {
      this.mode = 'piloting'
      return
    }
    this.toLocal(this.ship.object.position, this.localPosition)
    this.localQuaternion
      .copy(this.inverseTarget.copy(target.worldQuaternion).invert())
      .multiply(this.ship.object.quaternion)
    this.flight.enterFrom(this.localPosition, this.localQuaternion, 0)
    this.flightFrame.reset(target.id, target.worldPosition, target.worldQuaternion)
    this.throttle = 0
    this.pendingPitch = 0
    this.pendingYaw = 0
    this.reticle.set(0, 0)
    this.landed.setAltitudeOffset(0, 0)
    this.cameraOffsetReady = false
    this.mode = 'flying'
  }

  private toLocal(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const target = this.target
    if (!target) return out.copy(world)
    return out.copy(world).sub(target.worldPosition)
      .applyQuaternion(this.inverseTarget.copy(target.worldQuaternion).invert())
  }

  private advanceFlight(dt: number) {
    const target = this.target
    if (!target?.sampleSurfaceRadius) return
    this.flightFrame.advance(this.flight.getLocalPosition(), this.flight.getLocalQuaternion(), target)
    this.readFlightInput(dt)
    this.flight.update(dt, this.flightInput, {
      planetRadius: target.terrain.radius,
      gas: target.terrain.planetType === 'gas',
      sampleSurfaceRadius: dir => Math.max(target.sampleSurfaceRadius!(dir), target.seaRadius ?? 0),
    })
    this.writeShipFromFlight()
    this.applyFlightCamera(dt)
  }

  /**
   * The mouse is treated as a spring-centred stick: the pixels it moved this
   * frame are the deflection, and it recentres the moment the hand stops. An
   * accumulating mouse would let the player wind in a permanent turn and then
   * have to unwind it, which is a flight sim, not this.
   */
  private isFreeLooking(): boolean {
    return this.freeLookActive
  }

  /**
   * Latches free look, recentring the view on every fresh press.
   *
   * The angles have to be cleared on the rising edge, not when the blend
   * finishes decaying: releasing Alt swings the camera home over about eight
   * tenths of a second, and pressing it again inside that window used to find
   * the old angles still set and swing all the way back out to wherever the
   * player had been looking. Coming home and then being thrown back out is
   * exactly the motion that makes people queasy.
   */
  private refreshFreeLook() {
    const active = this.held.has('AltLeft') || this.held.has('AltRight')
    if (active && !this.freeLookActive) {
      this.freeLookYaw = 0
      this.freeLookPitch = 0
    }
    this.freeLookActive = active
  }

  private readFlightInput(dt: number) {
    const throttleUp = this.held.has('KeyW') ? 1 : 0
    const throttleDown = this.held.has('KeyS') ? 1 : 0
    const commanded = throttleUp - throttleDown
    const change = commanded !== 0
      ? commanded * THROTTLE_RATE * dt
      : -Math.min(this.throttle, THROTTLE_IDLE_DECAY * dt)
    this.throttle = THREE.MathUtils.clamp(this.throttle + change, 0, 1)
    this.flightInput.throttle = this.throttle

    // Not while free looking: the stick is parked, so letting it drift back
    // means a long look around silently cancels the turn the player set up, and
    // they come back to a ship going somewhere else.
    if (!this.isFreeLooking() && RETICLE_RECENTRE_RATE > 0 && this.reticle.lengthSq() > 1e-8) {
      const pull = Math.min(1, RETICLE_RECENTRE_RATE * dt)
      this.reticle.multiplyScalar(1 - pull)
    }

    // The dead zone is removed from the magnitude and the remainder rescaled,
    // so authority starts at zero at the edge of the zone instead of jumping.
    const freeLooking = this.isFreeLooking()
    const magnitude = this.reticle.length()
    const live = magnitude <= RETICLE_DEADZONE
      ? 0
      : Math.pow((magnitude - RETICLE_DEADZONE) / (1 - RETICLE_DEADZONE), RETICLE_RESPONSE_EXPONENT)
    const scale = magnitude > 1e-6 ? live / magnitude : 0
    // The stick is parked, not zeroed: the reticle keeps its deflection, so the
    // turn the player had set up resumes when they let go of Alt.
    this.flightInput.yaw = freeLooking ? 0 : THREE.MathUtils.clamp(this.reticle.x * scale, -1, 1)
    // Screen y grows downward, so a reticle held above centre is a nose-up ask.
    this.flightInput.pitch = freeLooking ? 0 : THREE.MathUtils.clamp(-this.reticle.y * scale, -1, 1)
    this.flightInput.roll = (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0)
    this.updateReticleElement(freeLooking ? 0 : live)
  }

  private writeShipFromFlight() {
    const target = this.target
    if (!target) return
    this.ship.object.position.copy(this.flight.getLocalPosition())
      .applyQuaternion(target.worldQuaternion)
      .add(target.worldPosition)
    this.ship.object.quaternion.copy(target.worldQuaternion)
      .multiply(this.flight.getLocalQuaternion())
  }

  /**
   * Chase camera for flight, lagged rather than welded to the hull.
   *
   * A rigid mount makes a roll read as the world spinning around a static ship,
   * which is both nauseating and useless -- there is nothing to judge the
   * attitude against. Letting the camera trail slightly means the hull visibly
   * rotates inside the frame.
   *
   * The lag is applied to the offset from the hull, not to the camera's world
   * position. Smoothing the world position instead is the obvious way to write
   * this and it silently ties distance to speed: a first-order filter chasing a
   * point moving at v settles a steady v/rate behind it, so at 380 m/s with a
   * 0.15 s time constant the camera sat 56 m further back than at rest --
   * measured 7.4 hull lengths against the 2.7 it was asked for, and the ship
   * shrank to a dot exactly when the player most needs to see it. Following the
   * offset leaves only attitude changes lagging, which is the part that was
   * wanted.
   */
  private applyFlightCamera(dt: number) {
    const hull = this.ship.object
    const back = this.axisForward.set(0, 0, 1).applyQuaternion(hull.quaternion)
    const up = this.axisUp.set(0, 1, 0).applyQuaternion(hull.quaternion)
    const length = Math.max(this.ship.size.z, 1)
    this.cameraDesired.set(0, 0, 0)
      .addScaledVector(back, length * FLIGHT_CAMERA_BACK)
      .addScaledVector(up, length * FLIGHT_CAMERA_UP)

    const wanted = this.isFreeLooking() ? 1 : 0
    this.freeLookBlend += (wanted - this.freeLookBlend) * (1 - Math.exp(-FREE_LOOK_BLEND_RATE * dt))
    // Only the blend is settled here; the angles belong to refreshFreeLook,
    // which owns them for the whole press.
    if (wanted === 0 && this.freeLookBlend < 0.002) this.freeLookBlend = 0
    if (this.freeLookBlend > 0) {
      // Yaw about the hull's up, then pitch about the right axis *after* that
      // yaw. Pitching about the unrotated right is the easy mistake, and it
      // rolls the horizon as soon as the two are combined.
      this.freeLookRotation.setFromAxisAngle(up, this.freeLookYaw * this.freeLookBlend)
      this.freeLookAxis.copy(this.axisForward).cross(up).normalize()
        .applyQuaternion(this.freeLookRotation)
      this.freeLookPitchRotation.setFromAxisAngle(
        this.freeLookAxis, this.freeLookPitch * this.freeLookBlend,
      )
      this.cameraDesired.applyQuaternion(this.freeLookRotation)
        .applyQuaternion(this.freeLookPitchRotation)
    }

    if (this.cameraOffsetReady) {
      this.cameraOffset.lerp(this.cameraDesired, 1 - Math.exp(-FLIGHT_CAMERA_LAG * dt))
    } else {
      this.cameraOffset.copy(this.cameraDesired)
      this.cameraOffsetReady = true
    }
    this.engine.camera.position.copy(hull.position).add(this.cameraOffset)
    this.clampAboveGround(this.engine.camera.position)
    this.engine.camera.up.copy(up)
    // Ahead of the hull while flying, at the hull itself while looking around,
    // blended so neither transition snaps.
    this.lookAhead.copy(hull.position).addScaledVector(back, -length * 2)
    this.cameraLook.copy(this.lookAhead).lerp(hull.position, this.freeLookBlend)
    this.engine.camera.lookAt(this.cameraLook)
  }

  /**
   * E, while flying. Refuses with a reason rather than silently, because a key
   * that does nothing reads as broken.
   */
  private tryLand() {
    const target = this.target
    if (!target?.sampleSurfaceRadius) return
    if (target.terrain.planetType === 'gas') {
      this.flashPrompt('Deep atmosphere — this giant has no ground to land on')
      return
    }
    const readout = this.flight.getReadout()
    if (readout.clearance > LANDING_MAX_CLEARANCE_METERS) {
      this.flashPrompt('Too high to land — descend further')
      return
    }
    if (readout.speed > LANDING_MAX_SPEED) {
      this.flashPrompt('Too fast to land — slow down with S')
      return
    }
    const direction = this.landingDirection.copy(this.flight.getLocalPosition()).normalize()
    if (target.sampleSurfaceRadius(direction) < (target.seaRadius ?? 0)) {
      this.flashPrompt('Ocean below — find solid ground to land on')
      return
    }
    const slope = surfaceSlopeDegrees(
      target.sampleSurfaceRadius, direction, Math.max(this.ship.size.z, 1),
    )
    if (slope > LANDING_MAX_SLOPE_DEGREES) {
      this.flashPrompt(`Slope too steep (${slope.toFixed(0)}°)`)
      return
    }
    this.beginLanding(direction, target.sampleSurfaceRadius(direction))
  }

  private beginLanding(direction: THREE.Vector3, surfaceRadius: number) {
    this.landingFromRadius = this.flight.getLocalPosition().length()
    this.landingToRadius = surfaceRadius
    // Keep the heading the ship arrived on, so it sets down facing where the
    // player was flying rather than snapping to an arbitrary bearing.
    this.landingHeading = this.headingFromFlight(direction)
    this.landed.place(direction, this.landingHeading)
    this.landingRemaining = LANDING_SECONDS
    this.mode = 'landing'
  }

  /**
   * The ship's current heading as the angle LandedShip expects.
   *
   * Measured as atan2(east, north) against the same north/east frame
   * LandedShip builds, because that module rebuilds the basis from the heading
   * and the two have to agree. Deriving it any other way reintroduces the
   * reflection that once landed a summoned ship 142 degrees off.
   */
  private headingFromFlight(direction: THREE.Vector3): number {
    const east = this.axisForward.set(1, 0, 0).projectOnPlane(direction)
    if (east.lengthSq() < 1e-8) east.set(0, 0, -1).projectOnPlane(direction)
    east.normalize()
    const north = this.axisUp.crossVectors(direction, east).normalize()
    const nose = this.cameraDesired.set(0, 0, -1)
      .applyQuaternion(this.flight.getLocalQuaternion())
      .projectOnPlane(direction)
    if (nose.lengthSq() < 1e-8) return 0
    nose.normalize()
    return Math.atan2(nose.dot(east), nose.dot(north))
  }

  private advanceLanding(dt: number) {
    this.landingRemaining = Math.max(0, this.landingRemaining - dt)
    const eased = smoothstep01(1 - this.landingRemaining / LANDING_SECONDS)
    const height = (this.landingFromRadius - this.landingToRadius) * (1 - eased)
    this.landed.setAltitudeOffset(Math.max(height, 0), 1 - eased)
    this.applyChaseCamera()
    if (this.landingRemaining > 0) return
    this.landed.setAltitudeOffset(0, 0)
    this.throttle = 0
    this.mode = 'piloting'
  }

  /** True while the flight model, not LandedShip, owns the hull transform. */
  isShipAirborne(): boolean {
    return this.mode === 'flying'
  }

  getFlightReadout() {
    return this.flight.getReadout()
  }

  private clampAboveGround(position: THREE.Vector3): THREE.Vector3 {
    const target = this.target
    if (!target) return position
    return clampCameraAbovePlanet(
      position,
      target.worldPosition,
      target.worldQuaternion,
      dir => target.sampleSurfaceRadius?.(dir) ?? samplePlanetRadius(dir, target.terrain),
      CHASE_GROUND_CLEARANCE_METERS,
      this.cameraTarget,
    )
  }

  private applyChaseCamera() {
    this.yaw -= this.pendingYaw * LOOK_SENSITIVITY
    this.pitch = THREE.MathUtils.clamp(this.pitch + this.pendingPitch * LOOK_SENSITIVITY, MIN_PITCH, MAX_PITCH)
    this.pendingYaw = 0
    this.pendingPitch = 0
    this.computeChasePose(this.to, this.lookTo)
    this.engine.camera.up.copy(this.localDirection.copy(this.ship.object.position).sub(this.target?.worldPosition ?? new THREE.Vector3()).normalize())
    this.engine.camera.position.copy(this.clampAboveGround(this.to))
    this.engine.camera.lookAt(this.lookTo)
  }

  /**
   * The reticle. Two rings: a fixed one at screen centre marking where the nose
   * settles, and a moving one the player pushes around with the mouse. The
   * distance between them is the turn the ship is being asked for, so the
   * control is visible rather than something you infer from the horizon moving.
   */
  private createReticle(): HTMLDivElement {
    const element = document.createElement('div')
    element.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%', 'z-index:9997',
      'width:0', 'height:0', 'pointer-events:none', 'opacity:0',
      'transition:opacity 160ms',
    ].join(';')
    const ring = (size: number, border: string, extra = '') => [
      'position:absolute', `left:${-size / 2}px`, `top:${-size / 2}px`,
      `width:${size}px`, `height:${size}px`, 'border-radius:50%',
      `border:${border}`, extra,
    ].join(';')
    const centre = document.createElement('div')
    centre.style.cssText = ring(8, '1px solid rgba(216,255,241,0.5)')
    const outer = document.createElement('div')
    outer.style.cssText = ring(2 * RETICLE_RANGE_PIXELS * 0.42,
      '1px dashed rgba(216,255,241,0.14)')
    const moving = document.createElement('div')
    moving.dataset.role = 'moving'
    moving.style.cssText = ring(26, '2px solid rgba(120,255,210,0.85)',
      'box-shadow:0 0 10px rgba(120,255,210,0.35)')
    element.append(outer, centre, moving)
    document.body.appendChild(element)
    return element
  }

  private updateReticleElement(live: number) {
    const element = this.reticleElement
    if (!element) return
    const moving = element.querySelector<HTMLDivElement>('[data-role="moving"]')
    if (!moving) return
    const span = RETICLE_RANGE_PIXELS * 0.42
    moving.style.transform = `translate(${this.reticle.x * span}px, ${this.reticle.y * span}px)`
    // Brightens with authority, so the player can see the dead zone rather than
    // having to discover it.
    moving.style.borderColor = `rgba(120,255,210,${(0.35 + live * 0.55).toFixed(2)})`
  }

  private createPrompt(): HTMLDivElement {
    const element = document.createElement('div')
    element.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:8%', 'transform:translateX(-50%)',
      'z-index:9998', 'padding:9px 18px', 'background:rgba(0,0,0,0.6)',
      'color:#d8fff1', 'font:13px/1.4 system-ui,sans-serif', 'letter-spacing:0.02em',
      'pointer-events:none', 'border:1px solid rgba(120,255,210,0.35)',
      'border-radius:999px', 'opacity:0', 'transition:opacity 140ms',
    ].join(';')
    document.body.appendChild(element)
    return element
  }

  private refreshPrompt(dt: number) {
    if (!this.prompt) return
    if (this.flashRemaining > 0) {
      this.flashRemaining -= dt
      return
    }
    let text = ''
    if (this.mode === 'walking' && this.isWithinBoardingRange()) text = 'E — Board ship'
    else if (this.mode === 'piloting') {
      // The charge is shown as it fills, so holding W reads as spinning the
      // engines up rather than as a key that took a while to register.
      text = this.takeoffCharge > 0.05
        ? `Thrusters ${Math.round(Math.min(1, this.takeoffCharge / TAKEOFF_HOLD_SECONDS) * 100)}%`
        : 'E — Leave ship     W (hold) — Take off'
    } else if (this.mode === 'takingOff') text = 'Taking off'
    else if (this.mode === 'landing') text = 'Landing'
    else if (this.mode === 'flying' && !this.pointerLocked) {
      text = 'Click to take back control'
    } else if (this.mode === 'flying' && this.isFreeLooking()) {
      text = 'Looking around — release Alt to return to the stick'
    } else if (this.mode === 'flying') {
      const readout = this.flight.getReadout()
      const canLand = this.target?.terrain.planetType !== 'gas' && readout.clearance <= LANDING_MAX_CLEARANCE_METERS
        && readout.speed <= LANDING_MAX_SPEED
      text = canLand
        ? `E — Land     ${readout.speed.toFixed(0)} m/s`
        : `${readout.speed.toFixed(0)} m/s     ${readout.clearance.toFixed(0)} m`
    }
    if (text === this.promptText) return
    this.promptText = text
    this.prompt.textContent = text
    this.prompt.style.opacity = text ? '1' : '0'
  }

  private flashPrompt(message: string, seconds = 2.2) {
    if (!this.prompt) return
    this.promptText = message
    this.prompt.textContent = message
    this.prompt.style.opacity = '1'
    this.flashRemaining = seconds
  }
}

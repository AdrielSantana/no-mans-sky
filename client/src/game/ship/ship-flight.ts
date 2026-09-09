import * as THREE from 'three'
import type { Vec3Like } from '../../../../server/spacetimedb/src/shared/vector'
import { atmosphereDepthAt } from '../planet-sunlight'

/**
 * Arcade flight, modelled on No Man's Sky rather than on aerodynamics.
 *
 * Two decisions define the feel and both are deliberate departures from physics:
 *
 * 1. The ship goes where it points. Velocity is a scalar along the nose, not a
 *    vector that can disagree with it, so there is no drift, no sideslip and no
 *    stall. Inertia lives entirely in how fast the speed and the attitude
 *    change, which is what makes an arcade flyer feel responsive instead of
 *    floaty.
 * 2. There is no gravity. A ship with engines running does not fall, so the
 *    player can stop mid-air and look around. Gravity would turn every pause
 *    into a crash and every landing into a skill check.
 *
 * Speed is the interesting part. Near the ground the ship is slow enough to
 * thread between hills; it gets fast when there is nothing to hit. "Nothing to
 * hit" is the maximum of two things -- how high you are, and how far from the
 * planet your nose points -- so pulling up off a landing pad accelerates you
 * immediately rather than making you climb through a slow zone first.
 */

// Metres per second. The near-ground figure is the one that has to feel right
// by hand; the open figure exists to get you off the planet without the climb
// becoming a chore. Both are per-planet quantities really, since a 25 km world
// has a 157 km circumference, and will want revisiting for a bigger one.
const SPEED_NEAR_GROUND = 55
const SPEED_OPEN = 380
// How quickly the throttle can move the speed. Braking is stronger than
// accelerating so the ship stops when you ask it to, which matters far more
// near terrain than a symmetric response would.
const ACCELERATION = 70
const BRAKING = 130

// Turn rates in radians per second, interpolated the opposite way to speed: the
// ship is agile where it is slow and settles down where it is fast, which keeps
// the same mouse movement from becoming violent at 380 m/s.
const TURN_RATE_NEAR_GROUND = 1.5
const TURN_RATE_OPEN = 0.55
const ROLL_RATE = 2.2
// How fast attitude input is smoothed in. Raw rates read as twitchy; this is a
// first-order filter, not a rate limit, so a held input still reaches full rate.
const ATTITUDE_SMOOTHING = 9

// Roll returns to the local horizon on its own when the player is not rolling,
// because a slow pass over terrain is much easier to fly wings-level. It fades
// out with altitude, where "level" stops meaning anything.
const AUTO_LEVEL_RATE = 1.6

// Where the nose has to point for the ship to consider itself pointed away from
// the planet, as the cosine against the local up. Starting slightly above the
// horizon means a level pass along the surface stays in the slow regime.
const AIM_OUTWARD_LOW = 0.15
const AIM_OUTWARD_HIGH = 0.75

// Terrain assist. The floor is hard -- the ship cannot be below it -- and the
// assist band above it is soft, pushing the nose and the path up so the ship
// climbs over a ridge rather than stopping dead against an invisible wall.
const MIN_CLEARANCE_METERS = 7
// Narrow on purpose. A wider band made the assist fire during ordinary low
// flight rather than only before an impact, and since a raised nose reads as
// "pointed away from the planet", it unlocked the high-speed regime: a level
// pass at 20 m turned into an unrequested climb to 6.5 km at full speed.
const ASSIST_BAND_METERS = 12
const ASSIST_STRENGTH = 3.4
// The assist looks along the flight path, not just underneath: at 55 m/s the
// ground directly below tells you nothing about the hill you are about to meet.
const LOOKAHEAD_SECONDS = 1.7

export interface ShipFlightInput {
  /** 0 is stopped, 1 is the current maximum speed. */
  throttle: number
  /** -1 nose down, +1 nose up. */
  pitch: number
  /** -1 left, +1 right. */
  yaw: number
  /** -1 roll left, +1 roll right. */
  roll: number
}

export interface ShipFlightTarget {
  planetRadius: number
  gas?: boolean
  sampleSurfaceRadius: (dir: Vec3Like) => number
}

export interface ShipFlightReadout {
  speed: number
  maxSpeed: number
  /** Metres between the hull origin and the terrain directly below it. */
  clearance: number
  altitude: number
  /** 0 deep in the atmosphere, 1 outside it. */
  openness: number
  /** True while the terrain assist is overriding the player's input. */
  assisting: boolean
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

export class ShipFlight {
  /** Position and attitude are both in planet-local space. */
  private readonly position = new THREE.Vector3()
  private readonly orientation = new THREE.Quaternion()
  private speed = 0
  private pitchRate = 0
  private yawRate = 0
  private rollRate = 0
  private assisting = false
  private clearance = 0
  private maxSpeed = SPEED_NEAR_GROUND
  private openness = 0
  // Altitude alone. Agility and wings-level are about being near terrain, which
  // aiming upward does not change; only the speed envelope reads the nose.
  private altitudeOpen = 0
  private planetRadius = 1

  private readonly forward = new THREE.Vector3()
  private readonly up = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly localUp = new THREE.Vector3()
  private readonly probe = new THREE.Vector3()
  private readonly delta = new THREE.Quaternion()
  private readonly levelTarget = new THREE.Quaternion()
  private readonly basis = new THREE.Matrix4()
  // One vector per role. Sharing a scratch between the arguments of makeBasis
  // is how the first version aliased `right` onto `-forward` and handed it a
  // degenerate basis, which setFromRotationMatrix accepts without complaint.
  private readonly levelRight = new THREE.Vector3()
  private readonly levelUp = new THREE.Vector3()
  private readonly levelBack = new THREE.Vector3()

  /** Seeds the flight state from wherever the ship currently sits. */
  enterFrom(localPosition: THREE.Vector3, localQuaternion: THREE.Quaternion, speed = 0) {
    this.position.copy(localPosition)
    this.orientation.copy(localQuaternion)
    this.speed = speed
    this.pitchRate = 0
    this.yawRate = 0
    this.rollRate = 0
  }

  getLocalPosition(): THREE.Vector3 {
    return this.position
  }

  getLocalQuaternion(): THREE.Quaternion {
    return this.orientation
  }

  getReadout(): ShipFlightReadout {
    return {
      speed: this.speed,
      maxSpeed: this.maxSpeed,
      clearance: this.clearance,
      altitude: this.position.length() - this.planetRadius,
      openness: this.openness,
      assisting: this.assisting,
    }
  }

  update(dt: number, input: ShipFlightInput, target: ShipFlightTarget) {
    const step = Math.min(dt, 0.05)
    this.readAxes()
    this.localUp.copy(this.position).normalize()

    const radius = this.position.length()
    const surfaceRadius = target.sampleSurfaceRadius(this.localUp)
    this.clearance = radius - surfaceRadius

    // Speed envelope. The two openness terms are combined with max, not with a
    // blend: pointing away from the planet is meant to be an immediate escape
    // from the slow regime, not something averaged away by still being low.
    this.planetRadius = target.planetRadius
    const depth = atmosphereDepthAt(surfaceRadius, target.planetRadius, radius)
    this.altitudeOpen = 1 - depth
    // Discounted by the assist, so the ship cannot bootstrap itself into the
    // fast regime by being pitched up to avoid a hill it was about to hit.
    const pressure = target.gas ? (1 - smoothstep(0.025, 0.10, radius / target.planetRadius - 1)) : 0
    const assist = Math.max(this.terrainAssist(target), pressure * Math.max(0, -this.forward.dot(this.localUp)))
    const aimOpen = smoothstep(AIM_OUTWARD_LOW, AIM_OUTWARD_HIGH, this.forward.dot(this.localUp))
      * (1 - assist)
    this.openness = Math.max(this.altitudeOpen, aimOpen)
    this.maxSpeed = THREE.MathUtils.lerp(SPEED_NEAR_GROUND, SPEED_OPEN, this.openness)
    this.maxSpeed = THREE.MathUtils.lerp(this.maxSpeed, 12000, smoothstep(0.12, 0.6, radius / target.planetRadius - 1))

    this.applyAttitude(step, input, assist)
    this.applyThrottle(step, input)

    this.readAxes()
    this.position.addScaledVector(this.forward, this.speed * step)
    this.enforceFloor(target)
  }

  private readAxes() {
    this.basis.makeRotationFromQuaternion(this.orientation)
    // three puts the nose at -Z, so forward is the negated third basis column.
    this.forward.setFromMatrixColumn(this.basis, 2).negate().normalize()
    this.up.setFromMatrixColumn(this.basis, 1).normalize()
    this.right.setFromMatrixColumn(this.basis, 0).normalize()
  }

  private applyAttitude(dt: number, input: ShipFlightInput, assist: number) {
    const turnRate = THREE.MathUtils.lerp(TURN_RATE_NEAR_GROUND, TURN_RATE_OPEN, this.altitudeOpen)
    this.assisting = assist > 0.001

    // The assist adds nose-up authority on top of the player's input rather
    // than replacing it, so a deliberate dive still dives -- it just cannot
    // reach the ground. Clamped so the two together never exceed full rate.
    const wantedPitch = THREE.MathUtils.clamp(input.pitch + assist * ASSIST_STRENGTH, -1, 1)
    const blend = 1 - Math.exp(-ATTITUDE_SMOOTHING * dt)
    this.pitchRate += (wantedPitch * turnRate - this.pitchRate) * blend
    this.yawRate += (input.yaw * turnRate - this.yawRate) * blend
    this.rollRate += (input.roll * ROLL_RATE - this.rollRate) * blend

    this.orientation.multiply(this.delta.setFromAxisAngle(AXIS_X, this.pitchRate * dt))
    this.orientation.multiply(this.delta.setFromAxisAngle(AXIS_Y, -this.yawRate * dt))
    this.orientation.multiply(this.delta.setFromAxisAngle(AXIS_Z, -this.rollRate * dt))
    this.orientation.normalize()

    if (Math.abs(input.roll) < 0.05) this.autoLevel(dt)
  }

  /**
   * Rolls the wings back toward the local horizon.
   *
   * Built by constructing the levelled orientation and slerping toward it,
   * rather than by measuring a bank angle and counter-rolling: the measured
   * version needs a special case at every pole of the angle it measures, and
   * gets them wrong while flying straight up, which is exactly the manoeuvre
   * the speed model encourages.
   */
  private autoLevel(dt: number) {
    const strength = (1 - this.altitudeOpen) * AUTO_LEVEL_RATE
    if (strength <= 1e-4) return
    // Keep the current heading; only the roll about it is replaced.
    const right = this.levelRight.crossVectors(this.forward, this.localUp)
    if (right.lengthSq() < 1e-6) return
    right.normalize()
    const up = this.levelUp.crossVectors(right, this.forward).normalize()
    this.basis.makeBasis(right, up, this.levelBack.copy(this.forward).negate())
    this.levelTarget.setFromRotationMatrix(this.basis)
    this.orientation.slerp(this.levelTarget, 1 - Math.exp(-strength * dt))
  }

  /**
   * How hard the ship is being asked to climb, 0 to 1.
   *
   * Sampled only where the ship will be in LOOKAHEAD_SECONDS, never where it
   * already is. Including the current clearance is the obvious thing to do and
   * it is wrong: it makes the assist fire whenever the ship is low, so steady
   * low flight -- the whole point of the slow regime -- becomes an involuntary
   * climb. Flying level ten metres over flat ground is not an emergency; flying
   * level ten metres from a cliff face is, and only the look-ahead sees it.
   *
   * The hull is kept out of the ground by enforceFloor, which is a hard clamp
   * and does not need the nose's help.
   */
  private terrainAssist(target: ShipFlightTarget): number {
    const travel = Math.max(this.speed, 1) * LOOKAHEAD_SECONDS
    this.probe.copy(this.position).addScaledVector(this.forward, travel)
    const aheadRadius = this.probe.length()
    if (aheadRadius < 1e-3) return 0
    return this.violation(aheadRadius - target.sampleSurfaceRadius(this.probe.normalize()))
  }

  private violation(clearance: number): number {
    return 1 - smoothstep(MIN_CLEARANCE_METERS, MIN_CLEARANCE_METERS + ASSIST_BAND_METERS, clearance)
  }

  private applyThrottle(dt: number, input: ShipFlightInput) {
    const wanted = THREE.MathUtils.clamp(input.throttle, 0, 1) * this.maxSpeed
    const rate = (wanted > this.speed ? ACCELERATION : BRAKING) * Math.max(1, this.maxSpeed / SPEED_OPEN)
    const change = rate * dt
    this.speed += THREE.MathUtils.clamp(wanted - this.speed, -change, change)
    this.speed = THREE.MathUtils.clamp(this.speed, 0, this.maxSpeed)
  }

  /**
   * The hard floor, applied after integration.
   *
   * The soft assist above handles the flying; this exists so that no
   * combination of input, frame time and terrain can put the hull underground.
   * It moves the ship rather than the nose, and bleeds the speed it had to
   * absorb, so scraping along a hillside slows you down instead of launching
   * you.
   */
  private enforceFloor(target: ShipFlightTarget) {
    this.localUp.copy(this.position).normalize()
    const floor = target.gas ? target.planetRadius * 1.025 : target.sampleSurfaceRadius(this.localUp) + MIN_CLEARANCE_METERS
    const radius = this.position.length()
    this.clearance = radius - floor + MIN_CLEARANCE_METERS
    if (radius >= floor) return
    this.position.copy(this.localUp).multiplyScalar(floor)
    this.clearance = MIN_CLEARANCE_METERS
    this.speed *= 0.82
  }
}

const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)

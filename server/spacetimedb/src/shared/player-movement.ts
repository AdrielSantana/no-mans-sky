import {
  add,
  clamp,
  cross,
  dot,
  length,
  normalize,
  projectOnPlane,
  scale,
  sub,
  type Vec3Like,
} from './vector'
import { samplePlanetRadius, type PlanetTerrainParams } from './planet-terrain'

export interface WalkerInput {
  moveX: number
  moveY: number
  jump: boolean
  sprint: boolean
  yawDelta: number
  pitchDelta: number
}

export interface WalkerState {
  localPosition: Vec3Like
  velocity: Vec3Like
  yaw: number
  pitch: number
  grounded: boolean
}

export interface WalkerParams {
  terrain: PlanetTerrainParams
  eyeHeight: number
  walkSpeed: number
  sprintSpeed: number
  acceleration: number
  airAcceleration: number
  gravity: number
  jumpSpeed: number
  mouseSensitivity: number
  footProbeRadius: number
  groundClearance: number
}

export interface WalkerStepResult {
  state: WalkerState
  up: Vec3Like
  forward: Vec3Like
  right: Vec3Like
  eyePosition: Vec3Like
}

const WORLD_FORWARD = { x: 0, y: 0, z: -1 }
const WORLD_RIGHT = { x: 1, y: 0, z: 0 }

export function defaultWalkerParams(terrain: PlanetTerrainParams): WalkerParams {
  return {
    terrain,
    eyeHeight: 1.6,
    walkSpeed: 5.2,
    sprintSpeed: 8.5,
    acceleration: 38,
    airAcceleration: 8,
    gravity: 18,
    jumpSpeed: 6,
    mouseSensitivity: 0.0025,
    footProbeRadius: 0,
    groundClearance: 0.04,
  }
}

export function createWalkerState(localPosition: Vec3Like, yaw = 0): WalkerState {
  return {
    localPosition,
    velocity: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    grounded: true,
  }
}

export function getWalkerBasis(state: WalkerState): { up: Vec3Like; forward: Vec3Like; right: Vec3Like } {
  const up = normalize(state.localPosition)
  let east = projectOnPlane(WORLD_RIGHT, up)
  if (length(east) < 1e-4) east = projectOnPlane(WORLD_FORWARD, up)
  east = normalize(east)
  const north = normalize(cross(up, east))

  const yawSin = Math.sin(state.yaw)
  const yawCos = Math.cos(state.yaw)
  const forward = normalize(add(scale(north, yawCos), scale(east, yawSin)))
  const right = normalize(cross(forward, up))
  return { up, forward, right }
}

export function simulatePlanetWalker(
  previous: WalkerState,
  input: WalkerInput,
  params: WalkerParams,
  dt: number,
): WalkerStepResult {
  const state: WalkerState = {
    localPosition: { ...previous.localPosition },
    velocity: { ...previous.velocity },
    yaw: previous.yaw + input.yawDelta * params.mouseSensitivity,
    pitch: clamp(previous.pitch + input.pitchDelta * params.mouseSensitivity, -1.35, 1.35),
    grounded: previous.grounded,
  }

  const basis = getWalkerBasis(state)
  const move = add(scale(basis.right, input.moveX), scale(basis.forward, input.moveY))
  const moveDir = length(move) > 1e-4 ? normalize(move) : { x: 0, y: 0, z: 0 }
  const targetSpeed = input.sprint ? params.sprintSpeed : params.walkSpeed
  const targetTangential = scale(moveDir, targetSpeed)
  const radialVelocity = scale(basis.up, dot(state.velocity, basis.up))
  const tangentialVelocity = sub(state.velocity, radialVelocity)
  const accel = state.grounded ? params.acceleration : params.airAcceleration
  const blend = clamp(accel * dt, 0, 1)
  let nextTangential = add(tangentialVelocity, scale(sub(targetTangential, tangentialVelocity), blend))

  if (length(moveDir) <= 1e-4 && state.grounded) {
    nextTangential = scale(nextTangential, Math.max(0, 1 - 12 * dt))
  }

  let nextRadial = radialVelocity
  if (state.grounded && input.jump) {
    nextRadial = scale(basis.up, params.jumpSpeed)
    state.grounded = false
  } else {
    nextRadial = add(nextRadial, scale(basis.up, -params.gravity * dt))
  }

  state.velocity = add(nextTangential, nextRadial)
  state.localPosition = add(state.localPosition, scale(state.velocity, dt))

  const up = normalize(state.localPosition)
  const groundRadius = sampleStableGroundRadius(up, state, params)
  const eyeRadius = groundRadius + params.eyeHeight + params.groundClearance
  const currentRadius = length(state.localPosition)

  if (currentRadius <= eyeRadius) {
    state.localPosition = scale(up, eyeRadius)
    const radial = dot(state.velocity, up)
    if (radial < 0) {
      state.velocity = sub(state.velocity, scale(up, radial))
    }
    state.grounded = true
  } else {
    state.grounded = false
  }

  const finalBasis = getWalkerBasis(state)
  return {
    state,
    eyePosition: state.localPosition,
    ...finalBasis,
  }
}

function sampleStableGroundRadius(up: Vec3Like, state: WalkerState, params: WalkerParams): number {
  if (params.footProbeRadius <= 0) {
    return samplePlanetRadius(up, params.terrain)
  }

  const basis = getWalkerBasis({ ...state, localPosition: up })
  const angularProbe = params.footProbeRadius / Math.max(params.terrain.radius, 1)
  const dirs = [
    up,
    normalize(add(up, scale(basis.forward, angularProbe))),
    normalize(add(up, scale(basis.forward, -angularProbe))),
    normalize(add(up, scale(basis.right, angularProbe))),
    normalize(add(up, scale(basis.right, -angularProbe))),
  ]

  let radius = -Infinity
  for (const dir of dirs) {
    radius = Math.max(radius, samplePlanetRadius(dir, params.terrain))
  }
  return radius
}

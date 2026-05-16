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
  sampleSurfaceRadius?: (dir: Vec3Like) => number | null
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
const WALKER_MIN_PITCH = -Math.PI / 5
const WALKER_MAX_PITCH = Math.PI / 4
const GROUND_SNAP_DISTANCE = 0.22
const SLIDE_PROBE_RADIUS = 1.2
const SLIDE_START_SLOPE = 30 * Math.PI / 180
const SLIDE_FULL_SLOPE = 50 * Math.PI / 180
const SLIDE_ACCELERATION = 34
const SLIDE_UPHILL_BRAKE = 20
const MAX_SLIDE_SPEED = 14
const MIN_UPHILL_CONTROL = 0.08

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
    pitch: clamp(previous.pitch + input.pitchDelta * params.mouseSensitivity, WALKER_MIN_PITCH, WALKER_MAX_PITCH),
    grounded: previous.grounded,
  }

  const basis = getWalkerBasis(state)
  const move = add(scale(basis.right, input.moveX), scale(basis.forward, input.moveY))
  const moveDir = length(move) > 1e-4 ? normalize(move) : { x: 0, y: 0, z: 0 }
  const targetSpeed = input.sprint ? params.sprintSpeed : params.walkSpeed
  const slide = state.grounded && !input.jump ? sampleGroundSlide(basis.up, state, params) : null
  let targetTangential = scale(moveDir, targetSpeed)
  if (slide && slide.amount > 0) {
    targetTangential = reduceUphillControl(targetTangential, slide)
  }
  const radialVelocity = scale(basis.up, dot(state.velocity, basis.up))
  const tangentialVelocity = sub(state.velocity, radialVelocity)
  const accel = state.grounded ? params.acceleration : params.airAcceleration
  const blend = clamp(accel * dt, 0, 1)
  let nextTangential = add(tangentialVelocity, scale(sub(targetTangential, tangentialVelocity), blend))

  if (length(moveDir) <= 1e-4 && state.grounded) {
    nextTangential = scale(nextTangential, Math.max(0, 1 - 12 * dt))
  }

  if (slide && slide.amount > 0) {
    const uphillSpeed = -dot(nextTangential, slide.downhill)
    if (uphillSpeed > 0) {
      const brake = clamp(SLIDE_UPHILL_BRAKE * slide.amount * dt, 0, 1)
      nextTangential = add(nextTangential, scale(slide.downhill, uphillSpeed * brake))
    }

    const downhillAcceleration = scale(slide.downhill, SLIDE_ACCELERATION * slide.amount * dt)
    nextTangential = add(nextTangential, downhillAcceleration)
    const downhillSpeed = dot(nextTangential, slide.downhill)
    if (downhillSpeed > MAX_SLIDE_SPEED) {
      nextTangential = sub(nextTangential, scale(slide.downhill, downhillSpeed - MAX_SLIDE_SPEED))
    }
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
  const radialSpeed = dot(state.velocity, up)

  if (currentRadius <= eyeRadius || (previous.grounded && radialSpeed <= 0.5 && currentRadius <= eyeRadius + GROUND_SNAP_DISTANCE)) {
    state.localPosition = scale(up, eyeRadius)
    if (radialSpeed < 0) {
      state.velocity = sub(state.velocity, scale(up, radialSpeed))
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
    return params.sampleSurfaceRadius?.(up) ?? samplePlanetRadius(up, params.terrain)
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
    radius = Math.max(radius, params.sampleSurfaceRadius?.(dir) ?? samplePlanetRadius(dir, params.terrain))
  }
  return radius
}

function sampleGroundSlide(
  up: Vec3Like,
  state: WalkerState,
  params: WalkerParams,
): { amount: number; downhill: Vec3Like } | null {
  const basis = getWalkerBasis({ ...state, localPosition: up })
  const angularProbe = SLIDE_PROBE_RADIUS / Math.max(params.terrain.radius, 1)
  const forwardDir = normalize(add(up, scale(basis.forward, angularProbe)))
  const backDir = normalize(add(up, scale(basis.forward, -angularProbe)))
  const rightDir = normalize(add(up, scale(basis.right, angularProbe)))
  const leftDir = normalize(add(up, scale(basis.right, -angularProbe)))
  const forwardPoint = sampleGroundPoint(forwardDir, params)
  const backPoint = sampleGroundPoint(backDir, params)
  const rightPoint = sampleGroundPoint(rightDir, params)
  const leftPoint = sampleGroundPoint(leftDir, params)
  const forwardTangent = sub(forwardPoint, backPoint)
  const rightTangent = sub(rightPoint, leftPoint)

  if (length(forwardTangent) <= 1e-5 || length(rightTangent) <= 1e-5) return null

  let surfaceNormal = normalize(cross(rightTangent, forwardTangent))
  if (dot(surfaceNormal, up) < 0) surfaceNormal = scale(surfaceNormal, -1)

  const slope = Math.acos(clamp(dot(surfaceNormal, up), -1, 1))
  if (slope <= SLIDE_START_SLOPE) return null

  const downhill = projectOnPlane(projectOnPlane(scale(up, -1), surfaceNormal), up)
  const downhillLength = length(downhill)
  if (downhillLength <= 1e-5) return null

  return {
    amount: smoothstepNumber(SLIDE_START_SLOPE, SLIDE_FULL_SLOPE, slope),
    downhill: scale(downhill, 1 / downhillLength),
  }
}

function reduceUphillControl(
  targetTangential: Vec3Like,
  slide: { amount: number; downhill: Vec3Like },
): Vec3Like {
  const uphillSpeed = -dot(targetTangential, slide.downhill)
  if (uphillSpeed <= 0) return targetTangential

  const retainedControl = Math.max(MIN_UPHILL_CONTROL, 1 - slide.amount)
  const blockedUphillSpeed = uphillSpeed * (1 - retainedControl)
  return add(targetTangential, scale(slide.downhill, blockedUphillSpeed))
}

function sampleGroundPoint(dir: Vec3Like, params: WalkerParams): Vec3Like {
  const radius = params.sampleSurfaceRadius?.(dir) ?? samplePlanetRadius(dir, params.terrain)
  return scale(dir, radius)
}

function smoothstepNumber(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

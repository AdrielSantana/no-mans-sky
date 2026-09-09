import * as THREE from 'three'
import type { Vec3Like } from '../../../../server/spacetimedb/src/shared/vector'
import type { PlanetWalkerTarget } from '../planet-walker-controller'

/**
 * Picks somewhere a ship can sit: flat enough, above water, and not on top of
 * whoever asked for it.
 *
 * Shared by disembarking and by summoning because the question is the same one,
 * and two copies of "is this ground acceptable" would drift apart -- one would
 * learn about water and the other would not.
 */
export interface LandingSiteQuery {
  target: PlanetWalkerTarget
  /** Local unit direction to search around. */
  around: THREE.Vector3
  minDistanceMeters: number
  maxDistanceMeters: number
  maxSlopeDegrees: number
  /** Footprint the slope is measured across -- use the hull's own length. */
  spanMeters: number
  /** Height the ground must clear the ocean by before it counts as dry. */
  freeboardMeters?: number
}

export interface LandingSite {
  direction: THREE.Vector3
  surfaceRadius: number
  slopeDegrees: number
  distanceMeters: number
}

const AZIMUTHS = 12
const RINGS = 4

function basisAround(up: THREE.Vector3): { east: THREE.Vector3; north: THREE.Vector3 } {
  const east = new THREE.Vector3(1, 0, 0).projectOnPlane(up)
  if (east.lengthSq() < 1e-8) east.set(0, 0, -1).projectOnPlane(up)
  east.normalize()
  const north = new THREE.Vector3().crossVectors(up, east).normalize()
  return { east, north }
}

/**
 * Slope of the terrain at `direction`, in degrees from the local vertical,
 * measured across `spanMeters` rather than at a point: a hull spans metres of
 * ground and cares about the plane it rests on, not about the pebble under its
 * centre. Four probes, the same shape the walker's slide detection uses.
 */
export function surfaceSlopeDegrees(
  sample: (dir: Vec3Like) => number,
  direction: THREE.Vector3,
  spanMeters: number,
): number {
  const up = direction
  const { east, north } = basisAround(up)
  const radius = sample(up)
  const angular = Math.max(spanMeters, 0.5) * 0.5 / Math.max(radius, 1)
  const probe = (axis: THREE.Vector3, sign: number) => {
    const dir = up.clone().addScaledVector(axis, angular * sign).normalize()
    return dir.multiplyScalar(sample(dir))
  }
  const forwardTangent = probe(north, 1).sub(probe(north, -1))
  const rightTangent = probe(east, 1).sub(probe(east, -1))
  const normal = rightTangent.cross(forwardTangent)
  if (normal.lengthSq() < 1e-10) return 0
  normal.normalize()
  if (normal.dot(up) < 0) normal.negate()
  return Math.acos(THREE.MathUtils.clamp(normal.dot(up), -1, 1)) * 180 / Math.PI
}

export function findLandingSite(query: LandingSiteQuery): LandingSite | null {
  const sample = query.target.sampleSurfaceRadius
  if (!sample) return null

  const up = query.around.clone().normalize()
  const { east, north } = basisAround(up)
  const seaRadius = query.target.seaRadius ?? -Infinity
  const freeboard = query.freeboardMeters ?? 1.5
  const baseRadius = Math.max(sample(up), 1)

  let best: LandingSite | null = null
  let bestScore = Infinity

  for (let ring = 0; ring < RINGS; ring++) {
    const distance = THREE.MathUtils.lerp(
      query.minDistanceMeters,
      query.maxDistanceMeters,
      ring / Math.max(RINGS - 1, 1),
    )
    const angular = distance / baseRadius
    for (let step = 0; step < AZIMUTHS; step++) {
      // Offset each ring so the rings do not all probe the same bearings, which
      // on a ridge would sample the same bad line four times.
      const azimuth = (step / AZIMUTHS + ring / (AZIMUTHS * RINGS)) * Math.PI * 2
      const direction = up.clone()
        .addScaledVector(north, Math.cos(azimuth) * angular)
        .addScaledVector(east, Math.sin(azimuth) * angular)
        .normalize()

      const surfaceRadius = sample(direction)
      if (surfaceRadius - seaRadius < freeboard) continue

      const slopeDegrees = surfaceSlopeDegrees(sample, direction, query.spanMeters)
      if (slopeDegrees > query.maxSlopeDegrees) continue

      // Flatness dominates; distance only breaks ties, so the ship prefers a
      // good pad twenty metres out over a merely acceptable one at your feet.
      const score = slopeDegrees + distance * 0.05
      if (score < bestScore) {
        bestScore = score
        best = { direction, surfaceRadius, slopeDegrees, distanceMeters: distance }
      }
    }
  }

  return best
}

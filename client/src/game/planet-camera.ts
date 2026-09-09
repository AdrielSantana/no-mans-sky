import * as THREE from 'three'
import type { Vec3Like } from '../../../server/spacetimedb/src/shared/vector'

/**
 * Keeps a camera from sinking into the planet.
 *
 * This is a radial clamp, not a raycast: the camera's own direction from the
 * planet centre is sampled for a surface radius, and the camera is pushed back
 * out to sit above it. On a sphere that is the cheap and correct-enough answer
 * -- one terrain sample instead of a march -- and it works against terrain that
 * has not streamed in yet, because sampleSurfaceRadius falls back to the
 * analytic height field when no chunk covers the direction.
 *
 * What it does not catch is an overhang between the camera and the ground it is
 * standing over. The terrain is a height field, so there are none.
 */
export function clampCameraAbovePlanet(
  desiredWorldPosition: THREE.Vector3,
  planetPosition: THREE.Vector3,
  planetQuaternion: THREE.Quaternion,
  sampleSurfaceRadius: (dir: Vec3Like) => number,
  clearanceMeters: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  // Copied first so the function is safe when `out` aliases the input, which
  // is the natural way to call it ("clamp this position in place").
  _desired.copy(desiredWorldPosition)
  const local = out.copy(_desired).sub(planetPosition)
  local.applyQuaternion(_inverse.copy(planetQuaternion).invert())
  const radius = local.length()
  if (radius <= 1e-6) return out.copy(_desired)

  _direction.copy(local).divideScalar(radius)
  const minimum = sampleSurfaceRadius(_direction) + clearanceMeters
  if (radius >= minimum) return out.copy(_desired)

  return out.copy(_direction).multiplyScalar(minimum).applyQuaternion(planetQuaternion).add(planetPosition)
}

const _desired = new THREE.Vector3()
const _inverse = new THREE.Quaternion()
const _direction = new THREE.Vector3()

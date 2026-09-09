import * as THREE from 'three'
import type { Vec3Like } from '../../../../server/spacetimedb/src/shared/vector'
import type { ShipModel } from './ship-model'

/**
 * A ship resting on a planet, stored the way the walker stores the player:
 * as a direction and a heading in the planet's own frame, converted to world
 * space every frame.
 *
 * This is not a stylistic choice. Planets rotate and orbit -- the seeded server
 * spins Terra once every 15.7 s, which drags its equator past a fixed world
 * point at 260 m/s -- so a hull cached in world coordinates would slide out
 * from under itself the moment the planet turned. Local storage is what makes
 * "I left it there" true.
 */
export class LandedShip {
  private readonly localDirection = new THREE.Vector3(0, 1, 0)
  private readonly localPosition = new THREE.Vector3()
  private readonly localNormal = new THREE.Vector3(0, 1, 0)
  private readonly basis = new THREE.Matrix4()
  private readonly localQuaternion = new THREE.Quaternion()
  private readonly forward = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly east = new THREE.Vector3()
  private readonly north = new THREE.Vector3()
  private readonly points = [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ]
  private heading = 0
  private surfaceRadius = 0
  // Metres above the resting pose. Only an arrival uses it: the hull still
  // resolves its position and its tilt from the ground below, so a descending
  // ship is already lined up with the pad it is about to touch.
  private altitudeOffset = 0
  // Blends the surface-aligned attitude back toward level-with-the-sphere while
  // airborne. A hull hanging 40 m up should not be copying the tilt of the rock
  // under it as if it were parked on it.
  private levelBlend = 0
  private readonly model: ShipModel

  constructor(model: ShipModel) {
    this.model = model
  }

  /** `direction` need not be normalised; `heading` is radians about the local up. */
  place(direction: THREE.Vector3, heading: number) {
    this.localDirection.copy(direction).normalize()
    this.heading = heading
  }

  getLocalDirection(): THREE.Vector3 {
    return this.localDirection
  }

  getSurfaceRadius(): number {
    return this.surfaceRadius
  }

  setAltitudeOffset(meters: number, levelBlend = 0) {
    this.altitudeOffset = meters
    this.levelBlend = THREE.MathUtils.clamp(levelBlend, 0, 1)
  }

  update(
    planetPosition: THREE.Vector3,
    planetQuaternion: THREE.Quaternion,
    sampleSurfaceRadius: (dir: Vec3Like) => number,
  ) {
    const up = this.localDirection
    // Probe across the hull's own footprint rather than a fixed distance, so a
    // long ship reads the slope it actually spans instead of pivoting on a
    // bump between its landing feet.
    const span = Math.max(this.model.size.z, 1) * 0.5
    const east = this.east.set(1, 0, 0).projectOnPlane(up)
    if (east.lengthSq() < 1e-8) east.set(0, 0, -1).projectOnPlane(up)
    east.normalize()
    const north = this.north.crossVectors(up, east).normalize()

    this.surfaceRadius = sampleSurfaceRadius(up)
    const angular = span / Math.max(this.surfaceRadius, 1)
    const offsets = [
      { dir: north, sign: 1 }, { dir: north, sign: -1 },
      { dir: east, sign: 1 }, { dir: east, sign: -1 },
    ]
    offsets.forEach((offset, index) => {
      const probe = this.points[index].copy(up).addScaledVector(offset.dir, angular * offset.sign).normalize()
      probe.multiplyScalar(sampleSurfaceRadius(probe))
    })

    const forwardTangent = this.points[0].clone().sub(this.points[1])
    const rightTangent = this.points[2].clone().sub(this.points[3])
    this.localNormal.crossVectors(rightTangent, forwardTangent)
    if (this.localNormal.lengthSq() < 1e-8 || this.localNormal.dot(up) < 0.1) {
      this.localNormal.copy(up)
    }
    this.localNormal.normalize()
    if (this.levelBlend > 0) this.localNormal.lerp(up, this.levelBlend).normalize()

    // Heading is applied in the tangent plane of the *terrain*, not of the
    // sphere, so the hull lies flat on a slope instead of pointing into it.
    //
    // Built as north*cos + east*sin to match getWalkerBasis in the shared
    // movement module, which is what the server uses and therefore the
    // authority on what a yaw means here. The obvious alternative --
    // north.applyAxisAngle(up, heading) -- rotates the other way (it yields
    // north*cos - east*sin), so the two disagree by a reflection across north
    // rather than by a sign. That reads as "mostly right" on most headings and
    // is why a summoned ship landed 142 degrees off instead of a tidy 180.
    this.forward.copy(north).multiplyScalar(Math.cos(this.heading))
      .addScaledVector(east, Math.sin(this.heading))
      .projectOnPlane(this.localNormal)
    if (this.forward.lengthSq() < 1e-8) this.forward.copy(east).projectOnPlane(this.localNormal)
    this.forward.normalize()
    // forward x up, matching getWalkerBasis. The other order looks equally
    // plausible and is silently catastrophic: three's convention puts the nose
    // at -Z, so the basis columns are (right, up, -forward), and a right-handed
    // frame then needs X = Y x Z = up x -forward = forward x up. Feeding
    // makeBasis the opposite hands setFromRotationMatrix a reflection, which it
    // does not detect -- it returns a rotation that is simply wrong, and the
    // hull sits at a confident 56 degrees off vertical on flat ground.
    this.right.crossVectors(this.forward, this.localNormal).normalize()

    this.basis.makeBasis(this.right, this.localNormal, this.forward.clone().negate())
    this.localQuaternion.setFromRotationMatrix(this.basis)

    this.localPosition.copy(up).multiplyScalar(this.surfaceRadius + this.altitudeOffset)

    const object = this.model.object
    object.position.copy(this.localPosition).applyQuaternion(planetQuaternion).add(planetPosition)
    object.quaternion.copy(planetQuaternion).multiply(this.localQuaternion)
  }
}

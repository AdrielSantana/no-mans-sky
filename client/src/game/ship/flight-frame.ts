import * as THREE from 'three'

/** Atmospheric entrainment is a gameplay assist, fading to an inertial frame.
 * A stationary ship in space keeps its world pose as planets spin/orbit below.
 * This changes coordinates, never the flight model's speed or control rates.
 */
export class FlightFrame {
  private position = new THREE.Vector3()
  private rotation = new THREE.Quaternion()
  private id: string | null = null
  private inverse = new THREE.Quaternion()
  private correction = new THREE.Quaternion()
  private fixedPosition = new THREE.Vector3()
  private fixedRotation = new THREE.Quaternion()

  reset(id: string, position: THREE.Vector3, rotation: THREE.Quaternion) {
    this.id = id
    this.position.copy(position)
    this.rotation.copy(rotation)
  }

  advance(localPosition: THREE.Vector3, localRotation: THREE.Quaternion,
    target: { id: string; worldPosition: THREE.Vector3; worldQuaternion: THREE.Quaternion; terrain: { radius: number } }) {
    if (this.id === null) {
      this.reset(target.id, target.worldPosition, target.worldQuaternion)
      return
    }
    const altitude = localPosition.length() / target.terrain.radius - 1
    const detached = this.id !== target.id ? 1 : THREE.MathUtils.smoothstep(altitude, 0.02, 0.12)
    this.inverse.copy(target.worldQuaternion).invert()
    this.fixedPosition.copy(localPosition).applyQuaternion(this.rotation).add(this.position)
      .sub(target.worldPosition).applyQuaternion(this.inverse)
    this.correction.copy(this.inverse).multiply(this.rotation)
    this.fixedRotation.copy(this.correction).multiply(localRotation)
    localPosition.lerp(this.fixedPosition, detached)
    localRotation.slerp(this.fixedRotation, detached).normalize()
    this.reset(target.id, target.worldPosition, target.worldQuaternion)
  }
}

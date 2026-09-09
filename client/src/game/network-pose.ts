import * as THREE from 'three'
import type { Pose } from '../module_bindings/types'
import type { PlanetWalkerTarget } from './planet-walker-controller'

export function encodePose(object: THREE.Object3D, target?: PlanetWalkerTarget): Pose {
  const p = object.position.clone()
  const q = object.quaternion.clone()
  if (target) {
    const inverse = target.worldQuaternion.clone().invert()
    p.sub(target.worldPosition).applyQuaternion(inverse)
    q.premultiply(inverse)
  }
  return { frame: target?.id ?? 'space', x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w }
}


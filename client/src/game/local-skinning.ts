import * as THREE from 'three'

/** Keep the entire bind/bone/unbind product in float64 until it is mesh-local.
 * Three's default GPU skinning first moves vertices into world space. At solar
 * system coordinates, the float32 bone texture loses centimetres before the
 * inverse bind matrix can subtract them again, tearing neighbouring triangles.
 * Each mesh owns its palette because meshes can share bones but have different binds.
 */
export function useMeshLocalBoneMatrices(mesh: THREE.SkinnedMesh): void {
  const skeleton = mesh.skeleton.clone()
  mesh.skeleton = skeleton
  const localBone = new THREE.Matrix4()
  skeleton.update = () => {
    for (let i = 0; i < skeleton.bones.length; i++) {
      localBone.multiplyMatrices(mesh.bindMatrixInverse, skeleton.bones[i].matrixWorld)
        .multiply(skeleton.boneInverses[i]).multiply(mesh.bindMatrix)
      localBone.toArray(skeleton.boneMatrices!, i * 16)
    }
    if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true
  }
}

// The palette already includes both bind matrices. Do not apply them twice.
export const LOCAL_SKINNING_VERTEX = THREE.ShaderChunk.skinning_vertex
  .replace('bindMatrix * ', '').replace('bindMatrixInverse * ', '')
export const LOCAL_SKIN_NORMAL_VERTEX = THREE.ShaderChunk.skinnormal_vertex
  .replace('skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;', '')

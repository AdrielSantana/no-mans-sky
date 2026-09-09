import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createShipMaterial, updateShipMaterial } from './ship-material'
import type { PlanetWalkerTarget } from '../planet-walker-controller'
import { SUN_SHADOW_CASTER_LAYER } from '../render-layers'
import shipLod0Url from '../../assets/models/spaceships/origin/lod_0.glb?url'
import shipLod1Url from '../../assets/models/spaceships/origin/lod_1.glb?url'

// Distances are in metres from the camera, measured to the hull origin. The
// second tier exists for VRAM and download, not for frame time: the hull is
// 3519 triangles, which is 0.12% of a settled frame and less than one oak tree.
// Anything past the far distance is culled outright -- at 3 km a 12 m hull is
// under 3 pixels wide at this FOV, and a marker in the HUD reads better than
// three grey pixels ever will.
const SHIP_LOD_DISTANCE = 220
const SHIP_CULL_DISTANCE = 3000

// The source is authored nose-toward-minus-X with a Z wingspan, measured from
// the cross-section profile rather than guessed: slicing along Z gives a
// symmetric lens (0.24 -> 2.00 -> 0.24) while slicing along X gives a
// monotonic taper from a 0.17 x 0.35 point to a 0.77 x 1.41 body. Rotating
// -90 degrees about Y maps that nose onto three's -Z convention.
const MODEL_TO_THREE_YAW = -Math.PI / 2

// GLTFLoader leaves anisotropy at 1, so a hull seen at a grazing angle -- which
// is most of a landing approach -- samples its mips isotropically and shimmers.
const SHIP_TEXTURE_ANISOTROPY = 16

export interface ShipModelOptions {
  /** Hull length along its own forward axis, in metres. */
  lengthMeters: number
  renderer: THREE.WebGLRenderer
}

export interface ShipModel {
  /**
   * Normalised hull: nose toward -Z, up toward +Y, origin on the ground plane
   * directly under the centre of the footprint, scaled to `lengthMeters`.
   */
  readonly object: THREE.Object3D
  readonly size: THREE.Vector3
  /** Distance from the hull origin to the lowest point of the hull. */
  readonly groundOffset: number
  setLength(meters: number): void
  /** `sunlightFactor` is 0 in the planet's shadow, 1 in full sun. */
  setSunLighting(sunPosition: THREE.Vector3, sunColor: THREE.Color, sunlightFactor: number, target?: PlanetWalkerTarget): void
  updateLod(cameraPosition: THREE.Vector3): void
  dispose(): void
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  root.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object) })
  return meshes
}

/**
 * Bakes the source transform into the geometry and returns the hull in a frame
 * the rest of the game can reason about.
 *
 * Done on the geometry rather than by nesting groups because both tiers have to
 * land in exactly the same place: deriving each tier's transform from its own
 * bounding box would differ by the simplifier's error budget, and the hull
 * would visibly hop at the LOD switch.
 */
function normalizeTier(scene: THREE.Object3D, reference: THREE.Matrix4 | null): {
  meshes: THREE.Mesh[]
  transform: THREE.Matrix4
  box: THREE.Box3
} {
  scene.updateMatrixWorld(true)
  const meshes = collectMeshes(scene)
  for (const mesh of meshes) {
    mesh.geometry = mesh.geometry.clone()
    mesh.geometry.applyMatrix4(mesh.matrixWorld)
    mesh.position.set(0, 0, 0)
    mesh.quaternion.identity()
    mesh.scale.setScalar(1)
  }

  const transform = reference ?? (() => {
    const yaw = new THREE.Matrix4().makeRotationY(MODEL_TO_THREE_YAW)
    const rotated = new THREE.Box3()
    for (const mesh of meshes) {
      const geometry = mesh.geometry.clone()
      geometry.applyMatrix4(yaw)
      geometry.computeBoundingBox()
      if (geometry.boundingBox) rotated.union(geometry.boundingBox)
      geometry.dispose()
    }
    const centre = rotated.getCenter(new THREE.Vector3())
    // X and Z centred so the hull turns about its own middle; Y dropped to zero
    // so the origin is the point that touches the ground.
    return new THREE.Matrix4()
      .makeTranslation(-centre.x, -rotated.min.y, -centre.z)
      .multiply(yaw)
  })()

  const box = new THREE.Box3()
  for (const mesh of meshes) {
    mesh.geometry.applyMatrix4(transform)
    mesh.geometry.computeBoundingBox()
    mesh.geometry.computeBoundingSphere()
    if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox)
  }
  return { meshes, transform, box }
}

export async function loadShipModel(options: ShipModelOptions): Promise<ShipModel> {
  const loader = new GLTFLoader()
  const [lod0, lod1] = await Promise.all([
    loader.loadAsync(shipLod0Url),
    loader.loadAsync(shipLod1Url),
  ])

  const near = normalizeTier(lod0.scene, null)
  const far = normalizeTier(lod1.scene, near.transform)

  const tiers = [near, far]
  const materials = new Set<THREE.Material>()
  const sourceMaterials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const replacements = new Map<THREE.Material, THREE.Material>()
  for (const tier of tiers) {
    for (const mesh of tier.meshes) {
      mesh.frustumCulled = false
      // castShadow/receiveShadow are three's own shadow system, which this
      // project does not use -- the sun shadow is a hand-rolled pass keyed on a
      // layer. Left set because they cost nothing and document the intent.
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.layers.enable(SUN_SHADOW_CASTER_LAYER)
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const prepared = list.map(source => {
        if (replacements.has(source)) return replacements.get(source)!
        sourceMaterials.add(source)
        if (!(source instanceof THREE.MeshStandardMaterial)) return source
        for (const map of [source.map, source.normalMap, source.metalnessMap, source.roughnessMap]) {
          if (map) { map.anisotropy = SHIP_TEXTURE_ANISOTROPY; textures.add(map) }
        }
        const material = createShipMaterial(source)
        replacements.set(source, material); materials.add(material)
        return material
      })
      mesh.material = Array.isArray(mesh.material) ? prepared : prepared[0]
    }
  }

  // One group per tier under a shared root, so scale and placement are set once
  // and the LOD switch is a visibility flip rather than a re-parent.
  const root = new THREE.Group()
  root.name = 'ship'
  const groups = tiers.map((tier, index) => {
    const group = new THREE.Group()
    group.name = `ship-lod-${index}`
    for (const mesh of tier.meshes) group.add(mesh)
    group.visible = index === 0
    root.add(group)
    return group
  })

  const rawSize = near.box.getSize(new THREE.Vector3())
  const size = new THREE.Vector3()
  const worldPosition = new THREE.Vector3()
  const sunDirection = new THREE.Vector3(0, 1, 0)

  const model: ShipModel = {
    object: root,
    size,
    // Zero by construction -- normalizeTier drops the hull's lowest point onto
    // the origin -- but exposed so callers do not have to know that.
    groundOffset: 0,
    setLength(meters: number) {
      const scale = rawSize.z > 1e-6 ? meters / rawSize.z : 1
      root.scale.setScalar(scale)
      size.copy(rawSize).multiplyScalar(scale)
    },
    setSunLighting(sunPosition: THREE.Vector3, sunColor: THREE.Color, sunlightFactor: number, target?: PlanetWalkerTarget) {
      const factor = THREE.MathUtils.clamp(sunlightFactor, 0, 1)
      root.getWorldPosition(worldPosition)
      sunDirection.copy(sunPosition).sub(worldPosition)
      if (sunDirection.lengthSq() < 1e-6) sunDirection.set(0, 1, 0)
      sunDirection.normalize()
      for (const material of materials) {
        if (material instanceof THREE.ShaderMaterial) updateShipMaterial(material, worldPosition, sunDirection, sunColor, factor, target)
      }
    },
    updateLod(cameraPosition: THREE.Vector3) {
      root.getWorldPosition(worldPosition)
      const distance = worldPosition.distanceTo(cameraPosition)
      root.visible = distance < SHIP_CULL_DISTANCE
      const tier = distance < SHIP_LOD_DISTANCE ? 0 : 1
      for (const [index, group] of groups.entries()) group.visible = index === tier
    },
    dispose() {
      root.removeFromParent()
      for (const tier of tiers) for (const mesh of tier.meshes) mesh.geometry.dispose()
      for (const texture of textures) texture.dispose()
      for (const material of materials) material.dispose()
      for (const source of sourceMaterials) source.dispose()
    },
  }

  model.setLength(options.lengthMeters)
  return model
}

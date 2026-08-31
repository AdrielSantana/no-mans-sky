import * as THREE from 'three'
import { SUN_SHADOW_CASTER_LAYER } from '../render-layers'
import { isSunShadowCamera } from './sun-shadow'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
// Geometry-only LOD tiers. Their embedded textures were shrunk to 8x8 because
// only the geometry is read -- the material always comes from the base model.
import oakLod0Url from '../../assets/models/trees/oak_tree/lod_0.glb?url'
import oakLod1Url from '../../assets/models/trees/oak_tree/lod_1.glb?url'
import oakLod2Url from '../../assets/models/trees/oak_tree/lod_2.glb?url'
import oakLod3Url from '../../assets/models/trees/oak_tree/lod_3.glb?url'
import winterLod0Url from '../../assets/models/trees/winter_tree/lod_0.glb?url'
import winterLod1Url from '../../assets/models/trees/winter_tree/lod_1.glb?url'
import winterLod2Url from '../../assets/models/trees/winter_tree/lod_2.glb?url'
import winterLod3Url from '../../assets/models/trees/winter_tree/lod_3.glb?url'
import {
  type PlanetTerrainParams,
} from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { QuadtreeNode } from './quadtree'
import { nodeKey } from './quadtree'
import type { TerrainChunkSurfaceData } from './terrain-chunk'
import { computePropSunLight, type PropSunLightInput } from './prop-sun-light'
import type { PropSunPlacementInput } from './terrain-worker-types'
import {
  PROP_CLOUD_FN_GLSL,
  PROP_CLOUD_PARS_GLSL,
  PROP_LIGHT_FN_GLSL,
  PROP_LIGHT_PARS_GLSL,
  PROP_WIND_FN_GLSL,
  PROP_WIND_PARS_GLSL,
} from './prop-shading'
import {
  DEFAULT_FOLIAGE_SETTINGS,
  FOLIAGE_LOD_FRACTIONS,
  FOLIAGE_LOD_SIZE_BOOST,
  buildFoliageGeometry,
  createFoliageMaterial,
  extractBranchAnchors,
  setFoliagePalette,
  updateFoliageMaterialSettings,
  type FoliagePalette,
  type FoliageSettings,
} from './tree-foliage'

export interface PlanetPropSettings {
  enabled: boolean
  treeDensity: number
  rockDensity: number
  distance: number
}

export interface PlanetPropAssets {
  trees: PlanetPropModel[]
  rocks: PlanetPropModel[]
}

interface PlanetPropModel {
  id: string
  kind: 'tree' | 'rock'
  // World height range in metres, per model. The mesh is normalised to unit
  // height at load, so the instance scale *is* the world height.
  heightRange: readonly [number, number]
  parts: PlanetPropPart[]
  // Both in model units, so as a fraction of the mesh's own height. baseRadius
  // is how far the base reaches sideways, and sets how far up the mesh the
  // shader may bend it onto the ground. width is the largest horizontal extent,
  // which is what a rock is sized by -- see buildKindPlacements.
  baseRadius: number
  width: number
  // Procedural leaves, generated once from the tier-0 mesh. Null for rocks and
  // for any tree whose branches yielded no usable anchors.
  foliage: PlanetPropFoliage | null
}

interface PlanetPropFoliage {
  geometry: THREE.BufferGeometry
  material: THREE.ShaderMaterial
  cardCount: number
}

interface PlanetPropTier {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
}

interface PlanetPropPart {
  // Tier 0 is full detail; later entries are progressively simplified.
  // Always at least length 1.
  tiers: PlanetPropTier[]
}

// Whether a LOD file carries its own baked texture, and therefore its own UV
// layout, or shares the base model's.
//
// This is not cosmetic. Tiers produced by decimating one mesh (gltf-transform
// simplify) keep the base UVs and must reuse the base material. Tiers exported
// independently by a generator re-bake their own atlas -- their UVs do not
// match the base at all, and pairing them with the base texture produces
// garbage. There is no reliable way to detect which is which from the file, so
// it is declared per asset.
interface PropLodSpec {
  url: string
  ownMaterial: boolean
}

interface PlanetPropLighting {
  sunPosition: THREE.Vector3
  planetCenter: THREE.Vector3
  sunColor: THREE.Color
  atmosphereLightColor: THREE.Color
  atmosphereInfluence: number
  terrainAoStrength: number
  cloudMask: THREE.Texture
  cloudMaskOffset: number
  cloudHeight: number
  cloudShadowStrength: number
  cloudLocalSunDirection: THREE.Vector3
  time: number
  windStrength: number
  foliage: FoliageSettings
}

interface PlanetPropLayerParams {
  node: QuadtreeNode
  surface: TerrainChunkSurfaceData
  assets: PlanetPropAssets
  settings: PlanetPropSettings
  terrain: PlanetTerrainParams
  seed: number
  seaHeight: number
  planetType: string
}

interface PlanetPropPlacement {
  model: PlanetPropModel
  matrices: THREE.Matrix4[]
  planetDirs: Float32Array
  surfaceRadii: Float32Array
  terrainNormals: Float32Array
  microAo: Float32Array
  macroAo: Float32Array
  sunLight: Float32Array
}

interface PlanetPropPlacementBucket {
  matrices: THREE.Matrix4[]
  planetDirs: number[]
  surfaceRadii: number[]
  terrainNormals: number[]
  microAo: number[]
  macroAo: number[]
}

const MAX_TREE_INSTANCES_PER_CHUNK = 34
const MAX_ROCK_INSTANCES_PER_CHUNK = 48
const TREE_CELL_DENSITY = 0.035
const ROCK_CELL_DENSITY = 0.048
const MIN_TREE_SLOPE_DOT = 0.70
const MIN_ROCK_SLOPE_DOT = 0.38
const TREE_PATCH_SCALE_METERS = 190
const ROCK_PATCH_SCALE_METERS = 110
const PROP_SHADER_VERSION = 9
const PROP_TEXTURE_ANISOTROPY = 16

// The bottom slice of a prop that counts as its base: deep enough to take in a
// root flare, shallow enough that a low branch does not widen it.
const PROP_BASE_BAND = 0.06
const PROP_BASE_RADIUS_PERCENTILE = 0.9

// Floor for the shader's skirt band. Above it the band follows the model's own
// baseRadius, which keeps the shear a constant angle instead of a constant
// distance: a trunk barely reaches sideways (0.10-0.13 of its height) while the
// flat rock slab reaches 2.9, and spreading the slab's correction over a
// twelfth of its thickness would tear it.
//
// There is deliberately no ceiling. Once the band passes the model's own
// height the correction stops being a bend at all and becomes a rotation of
// the whole mesh onto the ground plane -- which is exactly what a flat stone
// wants, and what only a prop wider at the base than it is tall ever asks for.
const PROP_SKIRT_MIN_BAND = 0.12

// How far a prop settles into the ground, as a fraction of its own height.
//
// A trunk wants a hair -- just enough that the base never lands exactly
// coplanar with the terrain -- because burying a tree hides the root flare that
// makes it look planted. A boulder wants the opposite: resting on its lowest
// vertex reads as dropped there rather than bedded, so rocks take a real embed,
// jittered per instance so a field of them does not look stamped.
const PROP_TREE_GROUND_BIAS = 0.006
const PROP_ROCK_EMBED_MIN = 0.06
const PROP_ROCK_EMBED_MAX = 0.20

// Safe to toggle at any time: placement RNG is seeded per kind
// (`${chunkKey}:${kind}`), so trees and rocks draw from independent streams and
// turning rocks off does not move a single tree. buildKindPlacements already
// returns early on an empty model list.
const ROCKS_ENABLED = true

// World height in metres. Rocks keep their own range in buildKindPlacements and
// this entry only exists so the signature is uniform.
const OAK_HEIGHT_RANGE = [6, 13] as const
const WINTER_TREE_HEIGHT_RANGE = [11, 22] as const
// Rocks are sized by their *largest* dimension rather than their height. The
// four meshes run from a round boulder to a slab 6.2x wider than it is tall,
// and sizing that slab to a 5.5 m height would make it 34 m across.
const ROCK_SIZE_RANGE = [0.9, 5.5] as const

// Leaf colour per species. colorA is the shaded inner canopy, colorB the sunlit
// outer edge; the shader blends between them by height and adds a per-leaf
// drift. The oak runs warm and bright, the winter conifer cold and dark -- two
// stands of the same green would flatten the whole treeline into one mass.
const OAK_FOLIAGE_PALETTE: FoliagePalette = { colorA: 0x3d6a26, colorB: 0x8cb14f }
const WINTER_TREE_FOLIAGE_PALETTE: FoliagePalette = { colorA: 0x24402e, colorB: 0x517d52 }
let _sunLightScratch = new Float32Array(0)
const _sunInput: PropSunLightInput = {
  planetDirs: new Float32Array(0),
  terrainNormals: new Float32Array(0),
  surfaceRadii: new Float32Array(0),
  sunX: 0,
  sunY: 0,
  sunZ: 0,
}
const TEMP_SUN_DIR = new THREE.Vector3()
// ~1.4 degrees of sun travel before a layer's horizon shadows are recomputed.
const SUN_DIRECTION_EPSILON_DOT = 0.9997


const DEFAULT_PROP_TEXTURE = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat,
)
DEFAULT_PROP_TEXTURE.name = 'default-prop-texture'
DEFAULT_PROP_TEXTURE.needsUpdate = true

const DEFAULT_PROP_CLOUD_SHADOW_TEXTURE = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat,
)
DEFAULT_PROP_CLOUD_SHADOW_TEXTURE.name = 'default-prop-cloud-shadow'
DEFAULT_PROP_CLOUD_SHADOW_TEXTURE.needsUpdate = true

let assetPromise: Promise<PlanetPropAssets> | null = null
let cachedAssets: PlanetPropAssets | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

function saturate(value: number): number {
  return clamp(value, 0, 1)
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function valueNoise3(position: THREE.Vector3, seed: number, scale: number): number {
  const x = Math.floor(position.x / scale)
  const y = Math.floor(position.y / scale)
  const z = Math.floor(position.z / scale)
  let h = seed ^ 0x9e3779b9
  h = Math.imul(h ^ x, 374761393)
  h = Math.imul(h ^ y, 668265263)
  h = Math.imul(h ^ z, 2246822519)
  h ^= h >>> 13
  h = Math.imul(h, 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function sourceMaterialColor(material: THREE.Material, fallback: THREE.Color): THREE.Color {
  const color = new THREE.Color()
  const sourceColor = 'color' in material ? material.color : null
  if (sourceColor instanceof THREE.Color && sourceColor.r + sourceColor.g + sourceColor.b > 0.08) {
    color.copy(sourceColor)
  } else {
    color.copy(fallback)
  }
  return color
}

function sourceMaterialMap(material: THREE.Material): THREE.Texture {
  const map = 'map' in material ? material.map : null
  if (!(map instanceof THREE.Texture)) return DEFAULT_PROP_TEXTURE
  // GLTFLoader never sets anisotropy, so prop textures were sampled at 1x while
  // the terrain runs at 16. The GLB samplers already ask for
  // LinearMipmapLinear — the mips exist, they were just being filtered
  // isotropically, which smears and shimmers tree trunks and rock faces at
  // grazing angles. Runs four times at load, before the first render, so no
  // needsUpdate is required. WebGLTextures clamps to the hardware maximum.
  if (map.anisotropy < PROP_TEXTURE_ANISOTROPY) {
    map.anisotropy = PROP_TEXTURE_ANISOTROPY
  }
  return map
}

function sourceMaterialUsesMap(material: THREE.Material): boolean {
  const map = 'map' in material ? material.map : null
  return map instanceof THREE.Texture
}

// Honours whatever the asset declares and nothing more.
//
// This used to force alphaTest to at least 0.08 on any mapped tree, on the
// assumption that trees carry alpha-cut foliage cards. They do not: the tree
// models are trunk and branches only, their glTF materials declare
// alphaMode OPAQUE, and their baseColor textures are JPEG — a format with no
// alpha channel at all. So `alpha` was always 1.0, `alpha < 0.08` was never
// true, and the discard never fired. It cost nothing visually and disabled
// early-Z on the heaviest geometry in the scene.
function sourceMaterialAlphaTest(material: THREE.Material): number {
  return 'alphaTest' in material && typeof material.alphaTest === 'number'
    ? material.alphaTest
    : 0
}

function createPropShaderMaterial(source: THREE.Material, kind: PlanetPropModel['kind']): THREE.ShaderMaterial {
  const hasMap = sourceMaterialUsesMap(source)
  const fallbackColor = kind === 'tree' ? new THREE.Color(0x6c7a48) : new THREE.Color(0x68645e)
  const baseColor = hasMap ? new THREE.Color(0xffffff) : sourceMaterialColor(source, fallbackColor)
  const alphaTest = sourceMaterialAlphaTest(source)

  const material = new THREE.ShaderMaterial({
    // Compile the discard out entirely when nothing needs it. Zeroing the
    // uniform is not enough: the presence of `discard` in the fragment shader
    // is what forfeits early-Z, whether or not the branch is ever taken.
    defines: {
      PROP_ALPHA_TEST: alphaTest > 0 ? 1 : 0,
      // Compiled out for rocks: a boulder has no lever arm and swaying it by
      // y^2 would make it wobble.
      PROP_WIND: kind === 'tree' ? 1 : 0,
      PROP_TRANSLUCENT: 0,
    },
    uniforms: {
      uMap: { value: sourceMaterialMap(source) },
      uUseMap: { value: hasMap },
      uBaseColor: { value: baseColor },
      uSunPosition: { value: new THREE.Vector3(0, 1, 0) },
      uPlanetCenter: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color(0xfff2c8) },
      uAtmosphereLightColor: { value: new THREE.Color(0xc4d5df) },
      uAtmosphereInfluence: { value: 1 },
      uTerrainAoStrength: { value: 0.45 },
      uCloudHeight: { value: 0.045 },
      uCloudShadowStrength: { value: 0 },
      uCloudShadowInfluence: { value: 1 },
      uCloudMask: { value: DEFAULT_PROP_CLOUD_SHADOW_TEXTURE },
      uCloudMaskOffset: { value: 0 },
      uCloudLocalSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uAlphaTest: { value: alphaTest },
      uTime: { value: 0 },
      uWindStrength: { value: DEFAULT_FOLIAGE_SETTINGS.enabled ? 0.34 : 0 },
      uSkirtBand: { value: PROP_SKIRT_MIN_BAND },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>

      ${PROP_LIGHT_PARS_GLSL}
      ${PROP_WIND_PARS_GLSL}

      uniform vec3 uPlanetCenter;
      uniform vec3 uSunPosition;

      // How far up the mesh the base may bend to meet the ground, as a
      // fraction of prop height. Set per model from how far its base reaches,
      // so the shear is a constant angle rather than a constant distance --
      // see PROP_SKIRT_MIN_BAND.
      uniform float uSkirtBand;

      varying vec2 vUv;
      varying vec3 vLight;
      varying vec3 vLocalPlanetDir;
      varying vec3 vTerrainNormal;
      varying vec3 vWorldPos;
      varying float vTerrainMicroAo;
      varying float vTerrainMacroAo;
      attribute vec3 instancePlanetDir;
      attribute vec3 instanceTerrainNormal;
      attribute float instanceTerrainMicroAo;
      attribute float instanceTerrainMacroAo;
      attribute float instanceTerrainSunLight;

      ${PROP_LIGHT_FN_GLSL}
      ${PROP_WIND_FN_GLSL}

      void main() {
        vUv = uv;

        // Sway is applied in model space, before the instance transform, so it
        // is a fraction of tree height and scales with the instance. The
        // foliage shader makes the identical call at each card's pivot, which
        // is what keeps leaves welded to their branch through a gust.
        vec3 swayed = position;
        vec4 instanceLocalOrigin = vec4(0.0, 0.0, 0.0, 1.0);
        #if PROP_WIND == 1
          #ifdef USE_INSTANCING
            vec3 windOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            float treeHeight = length(instanceMatrix[0].xyz);
            vec3 axisXWorld = instanceMatrix[0].xyz / max(treeHeight, 1e-6);
            vec3 axisZWorld = instanceMatrix[2].xyz / max(length(instanceMatrix[2].xyz), 1e-6);
            swayed += propWindSway(position, windOrigin, axisXWorld, axisZWorld, treeHeight, PROP_WIND_STIFFNESS);
          #endif
        #endif

        vec4 localPosition = vec4(swayed, 1.0);
        vec3 localNormal = normal;
        #ifdef USE_INSTANCING
          mat3 instanceNormalMatrix = mat3(instanceMatrix);
          instanceLocalOrigin = instanceMatrix * instanceLocalOrigin;
          localPosition = instanceMatrix * localPosition;

          // Ground the base to the slope.
          //
          // A tree stands along its own up axis on purpose -- it grows towards
          // the sky, not out of the hillside -- so on a slope its base disc is
          // tilted relative to the ground and the downhill roots end up in the
          // air. On level ground a vertex sits exactly position.y * scaleY
          // above the surface; the drift from that is the daylight.
          //
          // Cancelling the drift for the bottom of the mesh and easing it out
          // up the trunk makes the root flare splay along the slope. The
          // alternative -- sinking the whole prop by the gap -- buries more
          // trunk uphill than it recovers downhill: on a 13 m oak at 20 degrees
          // that is 1.03 m of burial to close 0.73 m of gap, and the flare you
          // wanted to see goes under the hill.
          vec3 skirtUpColumn = instanceMatrix[1].xyz;
          float skirtScaleY = length(skirtUpColumn);
          vec3 skirtUp = skirtUpColumn / max(skirtScaleY, 1e-6);
          vec3 skirtGroundNormal = normalize(instanceTerrainNormal);
          float skirtDrift =
            dot(localPosition.xyz - instanceLocalOrigin.xyz, skirtGroundNormal)
            - position.y * skirtScaleY;
          // Clamped so a grazing terrain normal cannot blow the correction up.
          float skirtGrip = max(dot(skirtUp, skirtGroundNormal), 0.35);
          float skirtFalloff = 1.0 - smoothstep(0.0, uSkirtBand, position.y);
          localPosition.xyz -= skirtUp * (skirtDrift * skirtFalloff / skirtGrip);

          localNormal /= vec3(
            dot(instanceNormalMatrix[0], instanceNormalMatrix[0]),
            dot(instanceNormalMatrix[1], instanceNormalMatrix[1]),
            dot(instanceNormalMatrix[2], instanceNormalMatrix[2])
          );
          localNormal = instanceNormalMatrix * localNormal;
        #endif

        vec4 worldPos = modelMatrix * localPosition;
        vec3 instanceWorldOrigin = (modelMatrix * instanceLocalOrigin).xyz;
        vec3 worldNormal = normalize(mat3(modelMatrix) * localNormal);
        vec3 upDir = normalize(mat3(modelMatrix) * instancePlanetDir);
        vec3 sunDir = normalize(uSunPosition - instanceWorldOrigin);
        vLocalPlanetDir = normalize(instancePlanetDir);
        vTerrainNormal = normalize(mat3(modelMatrix) * instanceTerrainNormal);
        vWorldPos = worldPos.xyz;
        vTerrainMicroAo = instanceTerrainMicroAo;
        vTerrainMacroAo = instanceTerrainMacroAo;

        vLight = computePropLight(worldNormal, upDir, sunDir, instanceTerrainSunLight);

        gl_Position = projectionMatrix * viewMatrix * worldPos;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>

      ${PROP_CLOUD_PARS_GLSL}

      uniform sampler2D uMap;
      uniform bool uUseMap;
      uniform vec3 uBaseColor;
      uniform float uAlphaTest;
      uniform vec3 uSunPosition;
      uniform float uTerrainAoStrength;

      varying vec2 vUv;
      varying vec3 vLight;
      varying vec3 vLocalPlanetDir;
      varying vec3 vTerrainNormal;
      varying vec3 vWorldPos;
      varying float vTerrainMicroAo;
      varying float vTerrainMacroAo;

      float terrainBakedAmbientOcclusion(float bakedAo, float amount, float nearFloor, float farFloor) {
        float strength = clamp(uTerrainAoStrength, 0.0, 2.0);
        if (strength <= 0.001) return 1.0;

        float cavity = 1.0 - clamp(bakedAo, 0.0, 1.0);
        float floorValue = min(nearFloor, farFloor);
        return clamp(1.0 - cavity * strength * amount, floorValue, 1.0);
      }

      float propTerrainAo() {
        float ao = terrainBakedAmbientOcclusion(vTerrainMacroAo, 0.24, 0.54, 0.76);
        ao *= terrainBakedAmbientOcclusion(vTerrainMicroAo, 0.36, 0.72, 0.88);
        return ao;
      }

      ${PROP_CLOUD_FN_GLSL}

      void main() {
        vec4 texel = texture2D(uMap, vUv);
        vec3 albedo = uBaseColor;
        if (uUseMap) {
          albedo *= texel.rgb;
        }
        #if PROP_ALPHA_TEST == 1
          float alpha = uUseMap ? texel.a : 1.0;
          if (alpha < uAlphaTest) discard;
        #endif

        vec3 color = albedo * vLight;
        color *= propTerrainAo();
        float cloudShadow = propCloudShadowMask(vLocalPlanetDir);
        vec3 coolShadow = color * vec3(0.11, 0.14, 0.19);
        color = mix(color, coolShadow, clamp(cloudShadow, 0.0, 0.96));
        gl_FragColor = vec4(color, 1.0);
        #include <logdepthbuf_fragment>
      }
    `,
    // FrontSide for both kinds. The GLBs declare doubleSided: true, which is a
    // modelling-tool default rather than a requirement — verified by welding
    // each mesh by position and counting edges used by a single triangle:
    // rock_1 is fully closed, oak_tree has 3 boundary edges out of ~26k and
    // winter_tree 20, and all three have zero non-manifold edges. That is a
    // closed solid with the trunk base left open (and buried), not a surface
    // built from flat cards — a leaf card would contribute four boundary edges
    // each. Backfaces here are never visible, so DoubleSide was rasterising
    // ~17.5k triangles per tree twice.
    //
    // If foliage cards are ever added to these models, this needs to become a
    // per-submesh decision.
    side: THREE.FrontSide,
    transparent: false,
    alphaToCoverage: alphaTest > 0,
    depthWrite: true,
    depthTest: true,
    name: `planet-prop-v${PROP_SHADER_VERSION}-${kind}-${source.name || 'material'}`,
  })
  material.userData.planetPropShaderVersion = PROP_SHADER_VERSION
  return material
}

function createPropMaterial(material: THREE.Material | THREE.Material[], kind: PlanetPropModel['kind']): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) return material.map(item => createPropShaderMaterial(item, kind))
  return createPropShaderMaterial(material, kind)
}

// The band is a property of the mesh, not of the frame, so it is written once
// at load rather than every update. Every tier gets it: a tier exported on its
// own carries its own material, and a decimated one shares the base tier's.
function setPropSkirtBand(material: THREE.Material | THREE.Material[], band: number): void {
  const apply = (item: THREE.Material) => {
    if (item instanceof THREE.ShaderMaterial && item.uniforms.uSkirtBand) {
      item.uniforms.uSkirtBand.value = band
    }
  }
  if (Array.isArray(material)) material.forEach(apply)
  else apply(material)
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    for (const item of material) item.dispose()
    return
  }
  material.dispose()
}

function collectMeshParts(scene: THREE.Object3D): { geometry: THREE.BufferGeometry; source: THREE.Material | THREE.Material[] }[] {
  const out: { geometry: THREE.BufferGeometry; source: THREE.Material | THREE.Material[] }[] = []
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const geometry = object.geometry?.clone()
    if (!geometry) return
    geometry.applyMatrix4(object.matrixWorld)
    out.push({ geometry, source: object.material })
  })
  return out
}

// The prop's base, measured off the raw mesh in source units before it is
// normalised. Two numbers come out.
//
// The centre is what the model gets pivoted on. Pivoting on the bounding box
// instead puts an oak's origin 0.05 of its own height away from its trunk,
// because the box follows the canopy -- and the random spin then throws that
// offset in a different direction for every tree, so on a slope some oaks stand
// a quarter-metre proud of the ground and others sink the same amount into it.
// That was the inconsistency between neighbours.
//
// The radius is how far the base reaches from that centre, and it sets the
// shader's skirt band. It is a high percentile rather than the maximum so one
// stray root tip does not widen the band for the whole species.
function measureBaseFootprint(
  parts: PlanetPropPart[],
  minY: number,
  height: number,
): { x: number; z: number; radius: number } {
  const bandTop = minY + height * PROP_BASE_BAND
  const xs: number[] = []
  const zs: number[] = []
  for (const part of parts) {
    const position = part.tiers[0].geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) > bandTop) continue
      xs.push(position.getX(i))
      zs.push(position.getZ(i))
    }
  }
  if (xs.length === 0) return { x: 0, z: 0, radius: 0 }

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i]
    if (xs[i] > maxX) maxX = xs[i]
    if (zs[i] < minZ) minZ = zs[i]
    if (zs[i] > maxZ) maxZ = zs[i]
  }
  const x = (minX + maxX) * 0.5
  const z = (minZ + maxZ) * 0.5
  const radii = xs.map((value, i) => Math.hypot(value - x, zs[i] - z)).sort((a, b) => a - b)
  const index = Math.min(radii.length - 1, Math.floor(radii.length * PROP_BASE_RADIUS_PERCENTILE))
  return { x, z, radius: radii[index] }
}

async function loadPropModel(
  loader: GLTFLoader,
  id: string,
  kind: PlanetPropModel['kind'],
  url: string,
  heightRange: readonly [number, number],
  palette: FoliagePalette | null,
  lodSpecs: PropLodSpec[] = [],
): Promise<PlanetPropModel> {
  const gltf = await loader.loadAsync(url)
  gltf.scene.updateMatrixWorld(true)

  const rawParts: PlanetPropPart[] = []
  const modelBox = new THREE.Box3()
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const geometry = object.geometry?.clone()
    if (!geometry) return

    geometry.applyMatrix4(object.matrixWorld)
    geometry.computeBoundingBox()
    if (geometry.boundingBox) modelBox.union(geometry.boundingBox)

    rawParts.push({
      tiers: [{ geometry, material: createPropMaterial(object.material, kind) }],
    })
  })

  if (rawParts.length === 0 || modelBox.isEmpty()) {
    return { id, kind, heightRange, parts: [], baseRadius: 0, width: 1, foliage: null }
  }

  const size = new THREE.Vector3()
  modelBox.getSize(size)
  const height = Math.max(size.y, 1e-3)
  const footprint = measureBaseFootprint(rawParts, modelBox.min.y, height)
  const normalize = new THREE.Matrix4()
    .makeTranslation(-footprint.x, -modelBox.min.y, -footprint.z)
    .premultiply(new THREE.Matrix4().makeScale(1 / height, 1 / height, 1 / height))
  const baseRadius = footprint.radius / height
  const width = Math.max(size.x, size.z) / height

  for (const part of rawParts) {
    const base = part.tiers[0].geometry
    base.applyMatrix4(normalize)
    base.computeBoundingBox()
    base.computeBoundingSphere()
  }

  // LOD tiers must be placed by the *base* model's normalize matrix. Deriving
  // their own from their own bounding box would differ slightly (the simplifier
  // moves the box by ~0.02%), and every tier switch would nudge the tree.
  for (const spec of lodSpecs) {
    try {
      const lodGltf = await loader.loadAsync(spec.url)
      lodGltf.scene.updateMatrixWorld(true)
      const lodParts = collectMeshParts(lodGltf.scene)
      if (lodParts.length !== rawParts.length) {
        for (const lodPart of lodParts) lodPart.geometry.dispose()
        if (import.meta.env.DEV) {
          console.warn(`Prop LOD ${spec.url} has ${lodParts.length} parts, base has ${rawParts.length} -- skipped`)
        }
        continue
      }
      lodParts.forEach((lodPart, index) => {
        lodPart.geometry.applyMatrix4(normalize)
        lodPart.geometry.computeBoundingBox()
        lodPart.geometry.computeBoundingSphere()
        rawParts[index].tiers.push({
          geometry: lodPart.geometry,
          material: spec.ownMaterial
            ? createPropMaterial(lodPart.source, kind)
            : rawParts[index].tiers[0].material,
        })
      })
    } catch (error) {
      if (import.meta.env.DEV) console.warn(`Prop LOD ${spec.url} failed to load: ${String(error)}`)
    }
  }

  const skirtBand = Math.max(baseRadius, PROP_SKIRT_MIN_BAND)
  for (const part of rawParts) {
    for (const tier of part.tiers) setPropSkirtBand(tier.material, skirtBand)
  }

  return {
    id,
    kind,
    heightRange,
    parts: rawParts,
    baseRadius,
    width,
    foliage: buildModelFoliage(id, kind, rawParts, palette),
  }
}

// Leaves are derived from the tier-0 mesh only.
//
// This is forced by the assets, not chosen: the lower tiers are independently
// re-exported, and oak lod_2 is down to 153 distinct vertex positions, where
// the local-radius estimate has no neighbourhood left to work with and returns
// zero for most of the mesh. Anchors from tier 0 are valid for every tier
// anyway -- foliage is its own mesh, in the same normalised model space, so it
// never had to agree with whichever trunk tier happens to be bound.
function buildModelFoliage(
  id: string,
  kind: PlanetPropModel['kind'],
  parts: PlanetPropPart[],
  palette: FoliagePalette | null,
): PlanetPropFoliage | null {
  if (kind !== 'tree' || parts.length === 0 || !palette) return null

  // The densest part, so a model split across several meshes still gets its
  // anchors from the branch mesh rather than whichever one traversed first.
  let source = parts[0].tiers[0].geometry
  for (const part of parts) {
    const candidate = part.tiers[0].geometry
    if (candidate.getAttribute('position')?.count > (source.getAttribute('position')?.count ?? 0)) {
      source = candidate
    }
  }

  const seed = hashString(`foliage:${id}`)
  const anchors = extractBranchAnchors(source, seed)
  if (anchors.length === 0) {
    if (import.meta.env.DEV) console.warn(`No branch anchors found for ${id} -- foliage skipped`)
    return null
  }

  const built = buildFoliageGeometry(anchors, seed)
  if (!built) return null

  if (import.meta.env.DEV) {
    console.info(`Foliage ${id}: ${anchors.length} anchors, ${built.cardCount} cards`)
  }

  return {
    geometry: built.geometry,
    material: createFoliageMaterial(
      DEFAULT_FOLIAGE_SETTINGS,
      palette,
      DEFAULT_PROP_CLOUD_SHADOW_TEXTURE,
      built.canopyCenter,
    ),
    cardCount: built.cardCount,
  }
}

export function getPlanetPropAssets(): PlanetPropAssets | null {
  return cachedAssets
}

export function loadPlanetPropAssets(): Promise<PlanetPropAssets> {
  if (cachedAssets) return Promise.resolve(cachedAssets)
  if (assetPromise) return assetPromise

  const loader = new GLTFLoader()
  const treePromises = [
    // Both trees ship four independently generated tiers, each with its own
    // baked atlas -- hence ownMaterial on every one. A tier produced by
    // decimating the base mesh instead would keep the base UVs and set false.
    // Oaks read broad and shorter, the dry pine tall and narrow. Tune here.
    loadPropModel(loader, 'oak-tree', 'tree', oakLod0Url, OAK_HEIGHT_RANGE, OAK_FOLIAGE_PALETTE, [
      { url: oakLod1Url, ownMaterial: true },
      { url: oakLod2Url, ownMaterial: true },
      { url: oakLod3Url, ownMaterial: true },
    ]),
    loadPropModel(
      loader, 'winter-tree', 'tree', winterLod0Url,
      WINTER_TREE_HEIGHT_RANGE, WINTER_TREE_FOLIAGE_PALETTE,
      [
        { url: winterLod1Url, ownMaterial: true },
        { url: winterLod2Url, ownMaterial: true },
        { url: winterLod3Url, ownMaterial: true },
      ],
    ),
  ]
  // Each rock ships two independently exported tiers, so the second re-baked
  // its own atlas and takes ownMaterial. Two rather than the trees' four is
  // fine: setLodTier clamps per part, so a distant rock simply stays on its
  // last tier.
  const loadRock = (
    id: string,
    tier0: Promise<{ default: string }>,
    tier1: Promise<{ default: string }>,
  ) => Promise.all([tier0, tier1]).then(([lod0, lod1]) => loadPropModel(
    loader, id, 'rock', lod0.default, ROCK_SIZE_RANGE, null,
    [{ url: lod1.default, ownMaterial: true }],
  ))

  // Skipped entirely rather than left at zero density: this way the rock GLBs
  // are never fetched, parsed or uploaded.
  // Dynamic so the GLBs leave the module graph entirely while the flag is off,
  // rather than being emitted into the build and simply never fetched.
  const rockPromises = ROCKS_ENABLED
    ? [
        loadRock(
          'rock-1',
          import('../../assets/models/rocks/rock_1/lod_0.glb?url'),
          import('../../assets/models/rocks/rock_1/lod_1.glb?url'),
        ),
        loadRock(
          'rock-2',
          import('../../assets/models/rocks/rock_2/lod_0.glb?url'),
          import('../../assets/models/rocks/rock_2/lod_1.glb?url'),
        ),
        loadRock(
          'rock-3',
          import('../../assets/models/rocks/rock_3/lod_0.glb?url'),
          import('../../assets/models/rocks/rock_3/lod_1.glb?url'),
        ),
        loadRock(
          'rock-4',
          import('../../assets/models/rocks/rock_4/lod_0.glb?url'),
          import('../../assets/models/rocks/rock_4/lod_1.glb?url'),
        ),
      ]
    : []

  assetPromise = Promise.all([Promise.all(treePromises), Promise.all(rockPromises)])
    .then(([trees, rocks]) => {
      cachedAssets = {
        trees: trees.filter(model => model.parts.length > 0),
        rocks: rocks.filter(model => model.parts.length > 0),
      }
      return cachedAssets
    })

  return assetPromise
}

export function disposePlanetPropAssets() {
  if (!cachedAssets) return

  for (const model of [...cachedAssets.trees, ...cachedAssets.rocks]) {
    if (model.foliage) {
      model.foliage.geometry.dispose()
      model.foliage.material.dispose()
    }
    for (const part of model.parts) {
      const seen = new Set<THREE.Material | THREE.Material[]>()
      for (const tier of part.tiers) {
        tier.geometry.dispose()
        // Tiers that reuse the base material must not be disposed twice.
        if (seen.has(tier.material)) continue
        seen.add(tier.material)
        disposeMaterial(tier.material)
      }
    }
  }
  cachedAssets = null
  assetPromise = null
}

function updatePropMaterial(material: THREE.Material | THREE.Material[], lighting: PlanetPropLighting) {
  if (Array.isArray(material)) {
    for (const item of material) updatePropMaterial(item, lighting)
    return
  }
  if (!(material instanceof THREE.ShaderMaterial)) return

  material.uniforms.uSunPosition.value.copy(lighting.sunPosition)
  material.uniforms.uPlanetCenter.value.copy(lighting.planetCenter)
  material.uniforms.uSunColor.value.copy(lighting.sunColor)
  material.uniforms.uAtmosphereLightColor.value.copy(lighting.atmosphereLightColor)
  material.uniforms.uAtmosphereInfluence.value = lighting.atmosphereInfluence
  material.uniforms.uTerrainAoStrength.value = lighting.terrainAoStrength
  material.uniforms.uCloudMask.value = lighting.cloudMask
  material.uniforms.uCloudMaskOffset.value = lighting.cloudMaskOffset
  material.uniforms.uCloudHeight.value = lighting.cloudHeight
  material.uniforms.uCloudShadowStrength.value = lighting.cloudShadowStrength
  material.uniforms.uCloudShadowInfluence.value = lighting.cloudShadowStrength > 0.001 ? 1 : 0
  material.uniforms.uCloudLocalSunDirection.value.copy(lighting.cloudLocalSunDirection)
  if (material.uniforms.uTime) material.uniforms.uTime.value = lighting.time
  if (material.uniforms.uWindStrength) {
    material.uniforms.uWindStrength.value = lighting.windStrength
  }
}

export function updatePlanetPropMaterials(assets: PlanetPropAssets, lighting: PlanetPropLighting) {
  for (const model of [...assets.trees, ...assets.rocks]) {
    for (const part of model.parts) {
      // Every tier, not just tier 0: independently baked tiers have their own
      // material, and skipping them would leave distant props without sun
      // position, cloud shadow or atmosphere tint.
      for (const tier of part.tiers) {
        updatePropMaterial(tier.material, lighting)
      }
    }
    if (model.foliage) {
      updatePropMaterial(model.foliage.material, lighting)
      updateFoliageMaterialSettings(model.foliage.material, lighting.foliage)
    }
  }
}

// Recolours one species at a time. Separate from updatePlanetPropMaterials
// because the palette is per model and changes only when someone moves a
// slider, while that runs every frame for everything.
export function setPlanetPropFoliagePalettes(
  assets: PlanetPropAssets,
  palettes: Record<string, FoliagePalette>,
): void {
  for (const model of assets.trees) {
    const palette = palettes[model.id]
    if (palette && model.foliage) setFoliagePalette(model.foliage.material, palette)
  }
}

interface PropMeshEntry {
  mesh: THREE.InstancedMesh
  part: PlanetPropPart
  attributes: [string, THREE.InstancedBufferAttribute][]
  // Built lazily per tier and kept: most chunks only ever need one, and a
  // chunk that oscillates across the threshold should not re-clone each time.
  tierGeometries: (THREE.BufferGeometry | null)[]
}

interface PropFoliageEntry {
  mesh: THREE.InstancedMesh
  geometry: THREE.BufferGeometry
  foliage: PlanetPropFoliage
  // Per-instance size multiplier. The material is shared by every chunk on the
  // planet, so the LOD size compensation cannot be a uniform -- it has to ride
  // on the instances, which are per layer.
  scaleAttribute: THREE.InstancedBufferAttribute
}

// Binds a model's vertex data to one layer's instance data.
//
// The source attributes are referenced, not copied. The previous version called
// geometry.clone(), and BufferAttribute.clone() deep-copies its array, so every
// chunk carried -- and uploaded -- its own copy of the tree mesh: 121 KB per
// oak per chunk, per tier ever visited. With foliage added on top that was
// going to be several times worse, so the sharing is what makes leaves
// affordable at all.
function buildInstancedGeometry(
  source: THREE.BufferGeometry,
  attributes: [string, THREE.InstancedBufferAttribute][],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  for (const name of Object.keys(source.attributes)) {
    geometry.setAttribute(name, source.attributes[name])
  }
  if (source.index) geometry.setIndex(source.index)
  // Copied rather than referenced: InstancedMesh.computeBoundingSphere reads
  // geometry.boundingSphere, and anything that recomputed it through a shared
  // reference would corrupt it for every other layer.
  geometry.boundingBox = source.boundingBox?.clone() ?? null
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null
  for (const [name, attribute] of attributes) geometry.setAttribute(name, attribute)
  return geometry
}

// Frees only what this layer owns.
//
// The vertex attributes belong to the model and are drawn by every other chunk
// showing the same tree, so they are detached before dispose(). Without that,
// the first chunk to unload would delete the GPU buffers the rest of the planet
// is still rendering from, and they would be re-uploaded on the next frame --
// forever, as chunks stream in and out.
function disposeInstancedGeometry(geometry: THREE.BufferGeometry, source: THREE.BufferGeometry): void {
  for (const name of Object.keys(source.attributes)) geometry.deleteAttribute(name)
  geometry.setIndex(null)
  geometry.dispose()
}

// Foliage LOD tier used while drawing into the shadow map, independent of the
// tier the camera sees.
//
// Every caster is inside the 120 m shadow box and therefore inside tier 0's
// 770 m band, so the depth pass was drawing all ~1500 cards of every tree
// within range -- measured at 3 ms, for a canopy blob whose outline survives a
// fraction of that. -1 drops foliage from the map entirely, which leaves a bare
// trunk shadow.
let foliageShadowTier = 3

export function setFoliageShadowLodTier(tier: number): void {
  foliageShadowTier = Math.max(-1, Math.min(3, Math.round(tier)))
}

export function getFoliageShadowLodTier(): number {
  return foliageShadowTier
}

function foliageIndexCount(cardCount: number, tier: number): number {
  const fraction = FOLIAGE_LOD_FRACTIONS[Math.min(tier, FOLIAGE_LOD_FRACTIONS.length - 1)]
  return Math.max(0, Math.round(cardCount * fraction)) * 6
}

export class PlanetPropLayer {
  readonly group = new THREE.Group()
  readonly instanceCount: number
  private readonly placements: PlanetPropPlacement[]
  private readonly terrain: PlanetTerrainParams
  private readonly sunLightAttributes: THREE.InstancedBufferAttribute[] = []
  private readonly lastSunDirection = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN)
  private readonly meshEntries: PropMeshEntry[] = []
  private readonly foliageEntries: PropFoliageEntry[] = []
  private lodTier = 0

  constructor(params: PlanetPropLayerParams) {
    this.group.name = 'planet-prop-layer'
    this.group.userData.planetPropLayer = true
    this.group.userData.chunkKey = nodeKey(params.node.face, params.node.lod, params.node.x, params.node.y)
    this.terrain = params.terrain

    const placements = this.buildPlacements(params)
    this.placements = placements
    let totalInstances = 0

    for (const placement of placements) {
      const count = placement.matrices.length
      if (count === 0) continue

      totalInstances += count
      // Hoisted out of the part loop: these depend only on the placement, so
      // building them per part duplicated identical attributes -- and the
      // foliage mesh, which is per model rather than per part, needs the same
      // ones.
      const sunLightAttribute = new THREE.InstancedBufferAttribute(placement.sunLight, 1)
      const attributes: [string, THREE.InstancedBufferAttribute][] = [
        ['instancePlanetDir', new THREE.InstancedBufferAttribute(placement.planetDirs, 3)],
        ['instanceTerrainNormal', new THREE.InstancedBufferAttribute(placement.terrainNormals, 3)],
        ['instanceTerrainMicroAo', new THREE.InstancedBufferAttribute(placement.microAo, 1)],
        ['instanceTerrainMacroAo', new THREE.InstancedBufferAttribute(placement.macroAo, 1)],
        ['instanceTerrainSunLight', sunLightAttribute],
      ]
      this.sunLightAttributes.push(sunLightAttribute)

      for (const part of placement.model.parts) {
        const tierGeometries: (THREE.BufferGeometry | null)[] = new Array(part.tiers.length).fill(null)
        const geometry = buildInstancedGeometry(part.tiers[0].geometry, attributes)
        tierGeometries[0] = geometry
        const mesh = new THREE.InstancedMesh(geometry, part.tiers[0].material, count)
        // Casters keep their own material in the depth pass, so the trunk's
        // wind sway and ground skirt land in the shadow map exactly where they
        // land on screen. A stand-in depth material would have to duplicate
        // both and would drift the moment either is tuned.
        mesh.layers.enable(SUN_SHADOW_CASTER_LAYER)
        mesh.name = `planet-prop-${placement.model.id}`
        mesh.userData.planetProp = true
        mesh.userData.planetPropModel = placement.model.id
        mesh.userData.planetPropKind = placement.model.kind
        mesh.userData.planetPropShaderVersion = PROP_SHADER_VERSION
        mesh.count = count
        mesh.frustumCulled = true
        mesh.renderOrder = 2
        for (let i = 0; i < count; i++) {
          mesh.setMatrixAt(i, placement.matrices[i])
        }
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        this.meshEntries.push({ mesh, part, attributes, tierGeometries })
        this.group.add(mesh)
      }

      const foliage = placement.model.foliage
      if (foliage) {
        const scales = new Float32Array(count).fill(FOLIAGE_LOD_SIZE_BOOST[0])
        const scaleAttribute = new THREE.InstancedBufferAttribute(scales, 1)
        const geometry = buildInstancedGeometry(foliage.geometry, [
          ...attributes,
          ['instanceFoliageScale', scaleAttribute],
        ])
        geometry.setDrawRange(0, foliageIndexCount(foliage.cardCount, 0))
        const mesh = new THREE.InstancedMesh(geometry, foliage.material, count)
        // Same reasoning, and here it also buys the leaf silhouette for free:
        // the foliage material's alpha-test discard is what makes the shadow
        // leaf-shaped instead of a rectangle per card.
        mesh.layers.enable(SUN_SHADOW_CASTER_LAYER)
        // Swapped per draw rather than per frame: the same mesh is drawn twice,
        // once for the camera and once for the depth pass, and only the second
        // one wants the cheap card count. three reads drawRange after
        // onBeforeRender and before onAfterRender, so this lands on the draw it
        // is meant for.
        const cameraRange = () => geometry.drawRange.count
        let restoreRange = -1
        mesh.onBeforeRender = (_renderer, _scene, camera) => {
          if (!isSunShadowCamera(camera)) return
          restoreRange = cameraRange()
          const shadowRange = foliageShadowTier < 0
            ? 0
            : foliageIndexCount(foliage.cardCount, foliageShadowTier)
          if (shadowRange < restoreRange) geometry.setDrawRange(0, shadowRange)
          else restoreRange = -1
        }
        mesh.onAfterRender = () => {
          if (restoreRange < 0) return
          geometry.setDrawRange(0, restoreRange)
          restoreRange = -1
        }
        mesh.name = `planet-foliage-${placement.model.id}`
        mesh.userData.planetProp = true
        mesh.userData.planetPropModel = placement.model.id
        mesh.userData.planetPropKind = 'foliage'
        mesh.userData.planetPropShaderVersion = PROP_SHADER_VERSION
        mesh.count = count
        mesh.frustumCulled = true
        // After every trunk in the scene, not just this chunk's. Foliage is
        // alpha-tested and therefore has no early-Z of its own; letting the
        // opaque trunks lay down depth first is what keeps the hidden half of
        // a canopy from ever reaching the fragment shader.
        mesh.renderOrder = 3
        for (let i = 0; i < count; i++) {
          mesh.setMatrixAt(i, placement.matrices[i])
        }
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        this.foliageEntries.push({ mesh, geometry, foliage, scaleAttribute })
        this.group.add(mesh)
      }
    }

    this.instanceCount = totalInstances
    this.group.visible = totalInstances > 0
  }

  // Inputs for an off-thread sun-light job. The arrays are handed over as-is
  // and structured-cloned by postMessage, so this layer keeps ownership.
  getSunLightJobPlacements(): PropSunPlacementInput[] {
    return this.placements
      .filter(placement => placement.sunLight.length > 0)
      .map(placement => ({
        planetDirs: placement.planetDirs,
        terrainNormals: placement.terrainNormals,
        surfaceRadii: placement.surfaceRadii,
        count: placement.sunLight.length,
      }))
  }

  // Counterpart to getSunLightJobPlacements. Bails out rather than writing
  // partial data if the layer was rebuilt while the job was in flight.
  applySunLightResults(results: Float32Array[], sunDirection: THREE.Vector3): void {
    const active = this.placements.filter(placement => placement.sunLight.length > 0)
    if (results.length !== active.length) return

    let changed = false
    for (let i = 0; i < results.length; i++) {
      const values = results[i]
      const placement = active[i]
      if (values.length !== placement.sunLight.length) return
      for (let k = 0; k < values.length; k++) {
        if (Math.abs(placement.sunLight[k] - values[k]) > 0.015) {
          changed = true
          break
        }
      }
      placement.sunLight.set(values)
    }

    this.lastSunDirection.copy(sunDirection).normalize()
    if (!changed) return
    for (const attribute of this.sunLightAttributes) attribute.needsUpdate = true
  }

  // Cheap predicate so the caller can decide whether to spend its per-frame
  // budget on this layer, without doing the raymarch to find out.
  needsSunLightUpdate(localSunDirection: THREE.Vector3): boolean {
    if (this.instanceCount <= 0) return false
    const lengthSq = localSunDirection.lengthSq()
    if (lengthSq <= 1e-8) return false
    if (!Number.isFinite(this.lastSunDirection.x)) return true
    const inv = 1 / Math.sqrt(lengthSq)
    const dot = (this.lastSunDirection.x * localSunDirection.x
      + this.lastSunDirection.y * localSunDirection.y
      + this.lastSunDirection.z * localSunDirection.z) * inv
    return dot <= SUN_DIRECTION_EPSILON_DOT
  }

  // skipHorizon drops the terrain-occlusion raymarch, which is the entire cost
  // here (10 detailed height samples per instance). Used to light a layer on
  // the frame it is created so its trees are not black, without paying ~3.4ms
  // of main thread inside the chunk integration budget. lastSunDirection is
  // deliberately left untouched in that case, so the layer still reports as
  // needing a real update and the budgeted pass refines it shortly after.
  updateSunLight(localSunDirection: THREE.Vector3, skipHorizon = false) {
    if (this.instanceCount <= 0) return

    const sunDir = TEMP_SUN_DIR.copy(localSunDirection)
    if (sunDir.lengthSq() <= 1e-8) return
    sunDir.normalize()
    if (
      !skipHorizon
      && Number.isFinite(this.lastSunDirection.x)
      && this.lastSunDirection.dot(sunDir) > SUN_DIRECTION_EPSILON_DOT
    ) return
    if (!skipHorizon) this.lastSunDirection.copy(sunDir)

    let changed = false
    for (const placement of this.placements) {
      changed = this.updatePlacementSunLight(placement, sunDir, skipHorizon) || changed
    }
    if (!changed) return

    for (const attribute of this.sunLightAttributes) {
      attribute.needsUpdate = true
    }
  }

  getSunLightStats() {
    let count = 0
    let min = 1
    let max = 0
    let sum = 0

    for (const placement of this.placements) {
      for (const sunlight of placement.sunLight) {
        count++
        min = Math.min(min, sunlight)
        max = Math.max(max, sunlight)
        sum += sunlight
      }
    }

    return {
      count,
      min: count > 0 ? min : 0,
      max: count > 0 ? max : 0,
      avg: count > 0 ? sum / count : 0,
    }
  }

  setVisible(visible: boolean) {
    this.group.visible = visible && this.instanceCount > 0
  }

  // Swaps every mesh to the given detail tier. Clamped per part, so a model
  // without LOD data simply stays on tier 0.
  setLodTier(tier: number) {
    if (tier === this.lodTier) return
    this.lodTier = tier

    for (const entry of this.meshEntries) {
      const index = Math.min(tier, entry.part.tiers.length - 1)
      let geometry = entry.tierGeometries[index]
      if (!geometry) {
        geometry = buildInstancedGeometry(entry.part.tiers[index].geometry, entry.attributes)
        entry.tierGeometries[index] = geometry
      }
      entry.mesh.geometry = geometry
      // The material moves with the geometry: independently baked tiers carry
      // their own atlas, so keeping tier 0's texture here would map it onto
      // unrelated UVs.
      entry.mesh.material = entry.part.tiers[index].material
      entry.mesh.computeBoundingSphere()
    }

    // Foliage LOD is a draw range, not a geometry swap. The cards were shuffled
    // at build time so any prefix is a spatially uniform sample of the canopy;
    // truncating in score order instead would strip one side of the tree bare.
    const boost = FOLIAGE_LOD_SIZE_BOOST[Math.min(tier, FOLIAGE_LOD_SIZE_BOOST.length - 1)]
    for (const entry of this.foliageEntries) {
      entry.geometry.setDrawRange(0, foliageIndexCount(entry.foliage.cardCount, tier))
      // Fewer, larger cards hold the same canopy mass, so the silhouette
      // survives the thinning even though the detail does not.
      const scales = entry.scaleAttribute.array as Float32Array
      scales.fill(boost)
      entry.scaleAttribute.needsUpdate = true
    }
  }

  get lodTierIndex(): number {
    return this.lodTier
  }

  dispose() {
    this.group.parent?.remove(this.group)
    for (const entry of this.meshEntries) {
      // Every tier that was ever built, not just the one currently bound.
      entry.tierGeometries.forEach((geometry, index) => {
        if (geometry) disposeInstancedGeometry(geometry, entry.part.tiers[index].geometry)
      })
      entry.mesh.dispose()
    }
    this.meshEntries.length = 0

    for (const entry of this.foliageEntries) {
      disposeInstancedGeometry(entry.geometry, entry.foliage.geometry)
      entry.mesh.dispose()
    }
    this.foliageEntries.length = 0
  }

  private updatePlacementSunLight(
    placement: PlanetPropPlacement,
    sunDir: THREE.Vector3,
    skipHorizon: boolean,
  ): boolean {
    const previous = _sunLightScratch.length >= placement.sunLight.length
      ? _sunLightScratch.subarray(0, placement.sunLight.length)
      : (_sunLightScratch = new Float32Array(placement.sunLight.length))
    previous.set(placement.sunLight)

    _sunInput.planetDirs = placement.planetDirs
    _sunInput.terrainNormals = placement.terrainNormals
    _sunInput.surfaceRadii = placement.surfaceRadii
    _sunInput.sunX = sunDir.x
    _sunInput.sunY = sunDir.y
    _sunInput.sunZ = sunDir.z
    computePropSunLight(_sunInput, this.terrain, placement.sunLight, skipHorizon)

    for (let i = 0; i < placement.sunLight.length; i++) {
      if (Math.abs(previous[i] - placement.sunLight[i]) > 0.015) return true
    }
    return false
  }



  private buildPlacements(params: PlanetPropLayerParams): PlanetPropPlacement[] {
    const treePlacements = this.buildKindPlacements(params, 'tree')
    const rockPlacements = this.buildKindPlacements(params, 'rock')
    return [...treePlacements, ...rockPlacements]
  }

  private buildKindPlacements(params: PlanetPropLayerParams, kind: PlanetPropModel['kind']): PlanetPropPlacement[] {
    const models = kind === 'tree' ? params.assets.trees : params.assets.rocks
    const density = kind === 'tree' ? params.settings.treeDensity : params.settings.rockDensity
    if (!params.settings.enabled || params.planetType !== 'rocky' || density <= 0 || models.length === 0) {
      return []
    }

    const { surface, node } = params
    const gridSize = surface.gridSize
    const cellCount = (gridSize - 1) * (gridSize - 1)
    const maxInstances = kind === 'tree' ? MAX_TREE_INSTANCES_PER_CHUNK : MAX_ROCK_INSTANCES_PER_CHUNK
    const cellDensity = kind === 'tree' ? TREE_CELL_DENSITY : ROCK_CELL_DENSITY
    const targetCount = Math.min(
      maxInstances,
      Math.max(0, Math.floor(cellCount * clamp(density, 0, 1.5) * cellDensity)),
    )
    if (targetCount <= 0) return []

    const rng = mulberry32(hashString(`${nodeKey(node.face, node.lod, node.x, node.y)}:${kind}`) ^ params.seed)
    const placementsByModel = new Map<PlanetPropModel, PlanetPropPlacementBucket>()
    for (const model of models) {
      placementsByModel.set(model, {
        matrices: [],
        planetDirs: [],
        surfaceRadii: [],
        terrainNormals: [],
        microAo: [],
        macroAo: [],
      })
    }

    const position = new THREE.Vector3()
    const normal = new THREE.Vector3()
    const radial = new THREE.Vector3()
    const placementUp = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const spin = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const dummy = new THREE.Object3D()
    const up = new THREE.Vector3(0, 1, 0)
    const maxAttempts = Math.max(targetCount * (kind === 'tree' ? 18 : 12), 120)

    let placed = 0
    for (let attempt = 0; placed < targetCount && attempt < maxAttempts; attempt++) {
      const ix = Math.floor(rng() * (gridSize - 1))
      const iy = Math.floor(rng() * (gridSize - 1))
      const tx = rng()
      const ty = rng()
      this.sampleSurface(surface, ix, iy, tx, ty, position, normal)
      radial.copy(position).normalize()

      const height = this.sampleScalar(surface.heights, gridSize, ix, iy, tx, ty)
      const terrainMicroAo = this.sampleScalar(surface.microAo, gridSize, ix, iy, tx, ty)
      const terrainMacroAo = this.sampleScalar(surface.macroAo, gridSize, ix, iy, tx, ty)
      const slopeDot = normal.dot(radial)
      const heightNorm = smoothstep(-1, 1, height)
      const latitude = Math.abs(radial.y)
      const moisture = saturate(height * 0.75 + 0.5)
      const slope = saturate(1 - slopeDot)
      const coast = smoothstep(params.seaHeight - 0.014, params.seaHeight + 0.014, height)
        * (1 - smoothstep(params.seaHeight + 0.026, params.seaHeight + 0.070, height))
      const rockMask = saturate(slope * 0.86 + smoothstep(0.56, 0.76, heightNorm))
      const snowMask = smoothstep(0.72, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude)
      const aboveSeaMask = smoothstep(params.seaHeight + 0.020, params.seaHeight + 0.085, height)
      const patchScale = kind === 'tree' ? TREE_PATCH_SCALE_METERS : ROCK_PATCH_SCALE_METERS
      const patch = valueNoise3(position, params.seed + (kind === 'tree' ? 3001 : 7001), patchScale)

      let mask = 0
      if (kind === 'tree') {
        const biomeMask = smoothstep(0.32, 0.62, moisture)
          * (1 - coast)
          * (1 - rockMask)
          * (1 - snowMask)
          * (1 - smoothstep(0.58, 0.72, heightNorm))
        const slopeMask = smoothstep(MIN_TREE_SLOPE_DOT, 0.90, slopeDot)
        const patchMask = smoothstep(0.42, 0.64, patch)
        mask = aboveSeaMask * biomeMask * slopeMask * patchMask
      } else {
        const biomeMask = Math.max(
          rockMask * smoothstep(0.25, 0.82, heightNorm),
          coast * 0.72,
          smoothstep(0.44, 0.74, slope),
        ) * (1 - snowMask * 0.28)
        const slopeMask = smoothstep(MIN_ROCK_SLOPE_DOT, 0.82, slopeDot)
        const patchMask = smoothstep(0.34, 0.76, patch)
        mask = aboveSeaMask * biomeMask * slopeMask * patchMask
      }
      if (rng() > mask) continue

      const model = models[Math.floor(rng() * models.length)] ?? models[0]
      const modelPlacement = placementsByModel.get(model)
      if (!modelPlacement) continue

      let embed = PROP_TREE_GROUND_BIAS
      if (kind === 'tree') {
        // Per model rather than one shared range, so an oak and a pine are not
        // the same size. Still exactly one rng() draw, so placement and model
        // choice are untouched.
        const [minHeight, maxHeight] = model.heightRange
        const treeHeight = minHeight + rng() * (maxHeight - minHeight)
        placementUp.copy(radial).lerp(normal, 0.18).normalize()
        scale.set(treeHeight, treeHeight, treeHeight)
      } else {
        // Sized by whichever dimension is largest. `model.width` is the widest
        // horizontal extent over the mesh's own height, so dividing by
        // max(width, 1) lands the biggest dimension on exactly `rockSize` --
        // a boulder by its height, the slab by its span.
        const [minSize, maxSize] = model.heightRange
        const rockSize = minSize + rng() * (maxSize - minSize)
        const rockScale = rockSize / Math.max(model.width, 1)
        // What stretch is left only breaks up repetition. The old jitter went
        // to 2.6x across and 2.2x deep to fake variety out of two meshes; four
        // meshes carry that now, and the old numbers on the slab gave a 40 m
        // pancake.
        placementUp.copy(normal).lerp(radial, 0.22).normalize()
        scale.set(
          rockScale * (0.88 + rng() * 0.34),
          rockScale,
          rockScale * (0.88 + rng() * 0.34),
        )
        embed = PROP_ROCK_EMBED_MIN + rng() * (PROP_ROCK_EMBED_MAX - PROP_ROCK_EMBED_MIN)
      }

      // The slope is answered in the vertex shader, which splays the base along
      // the ground rather than pushing the whole prop into it. All that is left
      // here is how deep the prop is bedded -- see PROP_TREE_GROUND_BIAS.
      position.addScaledVector(placementUp, -scale.y * embed)

      quaternion.setFromUnitVectors(up, placementUp)
      spin.setFromAxisAngle(placementUp, rng() * Math.PI * 2)
      quaternion.premultiply(spin)
      dummy.position.copy(position)
      dummy.quaternion.copy(quaternion)
      dummy.scale.copy(scale)
      dummy.updateMatrix()
      modelPlacement.matrices.push(dummy.matrix.clone())
      modelPlacement.planetDirs.push(radial.x, radial.y, radial.z)
      modelPlacement.surfaceRadii.push(position.length())
      modelPlacement.terrainNormals.push(normal.x, normal.y, normal.z)
      modelPlacement.microAo.push(terrainMicroAo)
      modelPlacement.macroAo.push(terrainMacroAo)
      placed++
    }

    return models
      .map((model) => {
        const placement = placementsByModel.get(model)
        return {
          model,
          matrices: placement?.matrices ?? [],
          planetDirs: new Float32Array(placement?.planetDirs ?? []),
          surfaceRadii: new Float32Array(placement?.surfaceRadii ?? []),
          terrainNormals: new Float32Array(placement?.terrainNormals ?? []),
          microAo: new Float32Array(placement?.microAo ?? []),
          macroAo: new Float32Array(placement?.macroAo ?? []),
          sunLight: new Float32Array(placement?.matrices.length ?? 0).fill(1),
        }
      })
      .filter(placement => placement.matrices.length > 0)
  }

  private sampleSurface(
    surface: TerrainChunkSurfaceData,
    ix: number,
    iy: number,
    tx: number,
    ty: number,
    outPosition: THREE.Vector3,
    outNormal: THREE.Vector3,
  ) {
    const gridSize = surface.gridSize
    const i00 = iy * gridSize + ix
    const i10 = i00 + 1
    const i01 = i00 + gridSize
    const i11 = i01 + 1
    // The chunk mesh splits every cell along the i10-i01 diagonal (see
    // buildTerrainChunkGeometryData). Interpolating all four corners at once
    // samples the bilinear patch instead, which lifts off those triangles by a
    // quarter of the cell's twist -- on a coarse chunk that is enough to leave
    // a prop hanging above the ground it was placed on. Interpolate whichever
    // triangle the sample actually lands in.
    if (tx + ty <= 1) {
      this.baryVec3(surface.positions, i00, i10, i01, tx, ty, outPosition)
      this.baryVec3(surface.normals, i00, i10, i01, tx, ty, outNormal)
    } else {
      this.baryVec3(surface.positions, i11, i01, i10, 1 - tx, 1 - ty, outPosition)
      this.baryVec3(surface.normals, i11, i01, i10, 1 - tx, 1 - ty, outNormal)
    }
    outNormal.normalize()
  }

  // out = v0 + (v1 - v0) * u + (v2 - v0) * v
  private baryVec3(
    values: Float32Array<ArrayBufferLike>,
    i0: number,
    i1: number,
    i2: number,
    u: number,
    v: number,
    out: THREE.Vector3,
  ) {
    const w = 1 - u - v
    const a = i0 * 3
    const b = i1 * 3
    const c = i2 * 3
    out.set(
      values[a] * w + values[b] * u + values[c] * v,
      values[a + 1] * w + values[b + 1] * u + values[c + 1] * v,
      values[a + 2] * w + values[b + 2] * u + values[c + 2] * v,
    )
  }

  private sampleScalar(
    values: Float32Array<ArrayBufferLike>,
    gridSize: number,
    ix: number,
    iy: number,
    tx: number,
    ty: number,
  ): number {
    const i00 = iy * gridSize + ix
    const i10 = i00 + 1
    const i01 = i00 + gridSize
    const i11 = i01 + 1
    const h0 = values[i00] * (1 - tx) + values[i10] * tx
    const h1 = values[i01] * (1 - tx) + values[i11] * tx
    return h0 * (1 - ty) + h1 * ty
  }
}

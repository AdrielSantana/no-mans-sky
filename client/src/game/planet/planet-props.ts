import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import oakTreeUrl from '../../assets/models/trees/oak_tree.glb?url'
import winterTreeUrl from '../../assets/models/trees/winter_tree.glb?url'
import rock1Url from '../../assets/models/rocks/rock_1.glb?url'
import rock2Url from '../../assets/models/rocks/rock_2.glb?url'
import {
  samplePlanetHeightDetailed,
  type PlanetTerrainParams,
} from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { QuadtreeNode } from './quadtree'
import { nodeKey } from './quadtree'
import type { TerrainChunkSurfaceData } from './terrain-chunk'

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
  parts: PlanetPropPart[]
}

interface PlanetPropPart {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
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
const PROP_SHADER_VERSION = 7
const SUN_SHADOW_SAMPLE_FACTORS = [0.04, 0.08, 0.16, 0.30, 0.52, 0.86, 1.35, 2.10, 3.25, 5.0, 7.5]

// The distance weight depends only on the factor, so it is precomputed once
// instead of two smoothsteps per sample per instance. Zero-weight samples are
// dropped outright: the first factor (0.04) sits exactly on the lower edge of
// smoothstep(0.04, 0.42, ...), so its weight is exactly 0 and its contribution
// to `blocker` — a running max — is a guaranteed no-op. It was costing a full
// samplePlanetHeightDetailed (~11µs) per instance to add nothing. Dropping it
// is byte-identical output for 1/11 of the raymarch.
const SUN_SHADOW_SAMPLES: { factor: number; weight: number }[] = SUN_SHADOW_SAMPLE_FACTORS
  .map(factor => ({
    factor,
    weight: smoothstep(0.04, 0.42, factor) * (1 - smoothstep(7.0, 8.5, factor)),
  }))
  .filter(sample => sample.weight > 0)
const SUN_SHADOW_CLEARANCE = 4.0
const PROP_TEXTURE_ANISOTROPY = 16
const TEMP_PROP_SAMPLE_DIR = new THREE.Vector3()
const TEMP_SUN_DIR = new THREE.Vector3()
// ~1.4 degrees of sun travel before a layer's horizon shadows are recomputed.
const SUN_DIRECTION_EPSILON_DOT = 0.9997

function sampleDirection(
  radial: THREE.Vector3,
  tangent: THREE.Vector3,
  sinAngle: number,
  cosAngle: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out
    .copy(radial)
    .multiplyScalar(cosAngle)
    .addScaledVector(tangent, sinAngle)
    .normalize()
}

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
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>

      uniform vec3 uPlanetCenter;
      uniform vec3 uSunPosition;
      uniform vec3 uSunColor;
      uniform vec3 uAtmosphereLightColor;
      uniform float uAtmosphereInfluence;

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

      void main() {
        vUv = uv;

        vec4 localPosition = vec4(position, 1.0);
        vec4 instanceLocalOrigin = vec4(0.0, 0.0, 0.0, 1.0);
        vec3 localNormal = normal;
        #ifdef USE_INSTANCING
          mat3 instanceNormalMatrix = mat3(instanceMatrix);
          instanceLocalOrigin = instanceMatrix * instanceLocalOrigin;
          localPosition = instanceMatrix * localPosition;
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

        float upSun = dot(upDir, sunDir);
        float atmosphereInfluence = clamp(uAtmosphereInfluence, 0.0, 1.0);
        float day = smoothstep(-0.18, 0.12, upSun);
        float direct = max(dot(worldNormal, sunDir), 0.0);
        float wrap = max(dot(worldNormal, sunDir) * 0.5 + 0.5, 0.0);
        float sky = 0.16 + 0.22 * max(dot(worldNormal, upDir) * 0.5 + 0.5, 0.0);
        float groundBounce = 0.10 * max(dot(worldNormal, -upDir) * 0.5 + 0.5, 0.0) * day;
        float lowSun = pow(1.0 - clamp(upSun * 0.92 + 0.08, 0.0, 1.0), 1.8)
          * smoothstep(-0.24, 0.50, upSun);
        float terminator = smoothstep(-0.34, 0.18, upSun) * (1.0 - smoothstep(0.22, 0.72, upSun));

        vec3 nightAmbient = vec3(0.018, 0.024, 0.038);
        vec3 dayAmbient = vec3(0.18, 0.19, 0.20);
        vec3 ambientTint = mix(vec3(1.0), uAtmosphereLightColor, atmosphereInfluence * (day * 0.20 + terminator * 0.08));
        vec3 ambient = mix(nightAmbient, dayAmbient, day) * sky * ambientTint;
        vec3 sunsetTint = mix(vec3(1.0, 0.34, 0.10), uSunColor, 0.36);
        sunsetTint = mix(sunsetTint, uAtmosphereLightColor, 0.18);
        vec3 atmosphericSunTint = mix(vec3(1.0), uAtmosphereLightColor, 0.70);
        atmosphericSunTint = mix(atmosphericSunTint, sunsetTint, lowSun * 0.59);
        vec3 sunTint = mix(uSunColor, atmosphericSunTint, atmosphereInfluence);
        vec3 sunlight = sunTint * (direct * 1.12 + wrap * 0.22) * day;
        vec3 terrain = vec3(0.23, 0.25, 0.20) * groundBounce;
        vec3 minimumLight = mix(vec3(0.010, 0.014, 0.022), vec3(0.055), day);
        vLight = max(ambient + sunlight * clamp(instanceTerrainSunLight, 0.0, 1.0) + terrain, minimumLight);

        gl_Position = projectionMatrix * viewMatrix * worldPos;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>

      uniform sampler2D uMap;
      uniform bool uUseMap;
      uniform vec3 uBaseColor;
      uniform float uAlphaTest;
      uniform vec3 uSunPosition;
      uniform float uTerrainAoStrength;
      uniform sampler2D uCloudMask;
      uniform float uCloudMaskOffset;
      uniform float uCloudHeight;
      uniform float uCloudShadowStrength;
      uniform float uCloudShadowInfluence;
      uniform vec3 uCloudLocalSunDirection;

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

      vec2 cloudMaskUv(vec3 dir) {
        vec3 n = normalize(dir);
        float lon = atan(n.x, n.z);
        float lat = asin(clamp(n.y, -1.0, 1.0));
        return vec2(
          fract(lon / 6.28318530718 + 0.5 + uCloudMaskOffset),
          clamp(0.5 - lat / 3.14159265359, 0.0, 1.0)
        );
      }

      float propCloudShadowMask() {
        if (uCloudShadowStrength <= 0.001 || uCloudShadowInfluence <= 0.001) return 0.0;
        vec3 surfaceDir = normalize(vLocalPlanetDir);
        vec3 sunDir = normalize(uCloudLocalSunDirection);
        float daylight = smoothstep(-0.08, 0.62, dot(surfaceDir, sunDir));
        float offset = clamp(uCloudHeight, 0.0, 0.20) * 2.8 + 0.018;
        vec3 projectedDir = normalize(surfaceDir + sunDir * offset);
        float macroMask = texture2D(uCloudMask, cloudMaskUv(projectedDir)).r;
        float shadow = pow(smoothstep(0.05, 0.96, macroMask), 0.58);
        float strength = clamp(uCloudShadowStrength * 0.42, 0.0, 2.2);
        return shadow * daylight * strength * clamp(uCloudShadowInfluence, 0.0, 1.0);
      }

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
        float cloudShadow = propCloudShadowMask();
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

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    for (const item of material) item.dispose()
    return
  }
  material.dispose()
}

async function loadPropModel(loader: GLTFLoader, id: string, kind: PlanetPropModel['kind'], url: string): Promise<PlanetPropModel> {
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
      geometry,
      material: createPropMaterial(object.material, kind),
    })
  })

  if (rawParts.length === 0 || modelBox.isEmpty()) {
    return { id, kind, parts: [] }
  }

  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  modelBox.getSize(size)
  modelBox.getCenter(center)
  const height = Math.max(size.y, 1e-3)
  const normalize = new THREE.Matrix4()
    .makeTranslation(-center.x, -modelBox.min.y, -center.z)
    .premultiply(new THREE.Matrix4().makeScale(1 / height, 1 / height, 1 / height))

  for (const part of rawParts) {
    part.geometry.applyMatrix4(normalize)
    part.geometry.computeBoundingBox()
    part.geometry.computeBoundingSphere()
  }

  return { id, kind, parts: rawParts }
}

export function getPlanetPropAssets(): PlanetPropAssets | null {
  return cachedAssets
}

export function loadPlanetPropAssets(): Promise<PlanetPropAssets> {
  if (cachedAssets) return Promise.resolve(cachedAssets)
  if (assetPromise) return assetPromise

  const loader = new GLTFLoader()
  assetPromise = Promise.all([
    loadPropModel(loader, 'oak-tree', 'tree', oakTreeUrl),
    loadPropModel(loader, 'winter-tree', 'tree', winterTreeUrl),
    loadPropModel(loader, 'rock-1', 'rock', rock1Url),
    loadPropModel(loader, 'rock-2', 'rock', rock2Url),
  ]).then(([oakTree, winterTree, rock1, rock2]) => {
    cachedAssets = {
      trees: [oakTree, winterTree].filter(model => model.parts.length > 0),
      rocks: [rock1, rock2].filter(model => model.parts.length > 0),
    }
    return cachedAssets
  })

  return assetPromise
}

export function disposePlanetPropAssets() {
  if (!cachedAssets) return

  for (const model of [...cachedAssets.trees, ...cachedAssets.rocks]) {
    for (const part of model.parts) {
      part.geometry.dispose()
      disposeMaterial(part.material)
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
}

export function updatePlanetPropMaterials(assets: PlanetPropAssets, lighting: PlanetPropLighting) {
  for (const model of [...assets.trees, ...assets.rocks]) {
    for (const part of model.parts) {
      updatePropMaterial(part.material, lighting)
    }
  }
}

export class PlanetPropLayer {
  readonly group = new THREE.Group()
  readonly instanceCount: number
  private readonly placements: PlanetPropPlacement[]
  private readonly terrain: PlanetTerrainParams
  private readonly sunLightAttributes: THREE.InstancedBufferAttribute[] = []
  private readonly lastSunDirection = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN)

  constructor(params: PlanetPropLayerParams) {
    this.group.name = 'planet-prop-layer'
    this.group.userData.planetPropLayer = true
    this.group.userData.chunkKey = nodeKey(params.node.face, params.node.lod, params.node.x, params.node.y)
    this.terrain = params.terrain

    const placements = this.buildPlacements(params)
    this.placements = placements
    let totalInstances = 0

    for (const placement of placements) {
      if (placement.matrices.length === 0) continue

      totalInstances += placement.matrices.length
      for (const part of placement.model.parts) {
        const geometry = part.geometry.clone()
        geometry.setAttribute('instancePlanetDir', new THREE.InstancedBufferAttribute(placement.planetDirs, 3))
        geometry.setAttribute('instanceTerrainNormal', new THREE.InstancedBufferAttribute(placement.terrainNormals, 3))
        geometry.setAttribute('instanceTerrainMicroAo', new THREE.InstancedBufferAttribute(placement.microAo, 1))
        geometry.setAttribute('instanceTerrainMacroAo', new THREE.InstancedBufferAttribute(placement.macroAo, 1))
        const sunLightAttribute = new THREE.InstancedBufferAttribute(placement.sunLight, 1)
        geometry.setAttribute('instanceTerrainSunLight', sunLightAttribute)
        this.sunLightAttributes.push(sunLightAttribute)
        const mesh = new THREE.InstancedMesh(geometry, part.material, placement.matrices.length)
        mesh.name = `planet-prop-${placement.model.id}`
        mesh.userData.planetProp = true
        mesh.userData.planetPropModel = placement.model.id
        mesh.userData.planetPropKind = placement.model.kind
        mesh.userData.planetPropShaderVersion = PROP_SHADER_VERSION
        mesh.count = placement.matrices.length
        mesh.frustumCulled = true
        mesh.renderOrder = 2
        for (let i = 0; i < placement.matrices.length; i++) {
          mesh.setMatrixAt(i, placement.matrices[i])
        }
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        this.group.add(mesh)
      }
    }

    this.instanceCount = totalInstances
    this.group.visible = totalInstances > 0
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

  updateSunLight(localSunDirection: THREE.Vector3) {
    if (this.instanceCount <= 0) return

    const sunDir = TEMP_SUN_DIR.copy(localSunDirection)
    if (sunDir.lengthSq() <= 1e-8) return
    sunDir.normalize()
    if (Number.isFinite(this.lastSunDirection.x) && this.lastSunDirection.dot(sunDir) > SUN_DIRECTION_EPSILON_DOT) return
    this.lastSunDirection.copy(sunDir)

    let changed = false
    for (const placement of this.placements) {
      changed = this.updatePlacementSunLight(placement, sunDir) || changed
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

  dispose() {
    this.group.parent?.remove(this.group)
    this.group.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) {
        object.geometry.dispose()
        object.dispose()
      }
    })
  }

  private updatePlacementSunLight(placement: PlanetPropPlacement, sunDir: THREE.Vector3): boolean {
    let changed = false
    const radial = new THREE.Vector3()
    const terrainNormal = new THREE.Vector3()
    const tangentSun = new THREE.Vector3()
    const terrainMeters = Math.max(this.terrain.terrainScale * this.terrain.radius, 1)

    for (let i = 0; i < placement.sunLight.length; i++) {
      const dirOffset = i * 3
      radial.set(
        placement.planetDirs[dirOffset],
        placement.planetDirs[dirOffset + 1],
        placement.planetDirs[dirOffset + 2],
      ).normalize()
      terrainNormal.set(
        placement.terrainNormals[dirOffset],
        placement.terrainNormals[dirOffset + 1],
        placement.terrainNormals[dirOffset + 2],
      ).normalize()

      const radialSun = radial.dot(sunDir)
      tangentSun.copy(sunDir).addScaledVector(radial, -radialSun)
      const tangentLen = tangentSun.length()
      let sunlight = 0

      if (radialSun > -0.08 && tangentLen > 1e-5) {
        tangentSun.divideScalar(tangentLen)
        const normalGate = smoothstep(-0.04, 0.18, terrainNormal.dot(sunDir))
        const horizonGate = this.computeHorizonSunLight(radial, tangentSun, radialSun / tangentLen, placement.surfaceRadii[i], terrainMeters)
        sunlight = Math.min(normalGate, horizonGate)
      } else if (radialSun > 0.35) {
        sunlight = smoothstep(-0.08, 0.24, terrainNormal.dot(sunDir))
      }

      sunlight = clamp(sunlight, 0, 1)
      if (Math.abs(placement.sunLight[i] - sunlight) > 0.015) {
        placement.sunLight[i] = sunlight
        changed = true
      }
    }

    return changed
  }

  private computeHorizonSunLight(
    radial: THREE.Vector3,
    tangentSun: THREE.Vector3,
    sunSlope: number,
    originRadius: number,
    terrainMeters: number,
  ): number {
    let blocker = 0
    const stylizedSunSlope = sunSlope * 0.42 - 0.035

    for (const { factor, weight } of SUN_SHADOW_SAMPLES) {
      const distance = terrainMeters * factor
      const angle = distance / Math.max(this.terrain.radius, 1)
      const sinAngle = Math.sin(angle)
      const cosAngle = Math.cos(angle)
      sampleDirection(radial, tangentSun, sinAngle, cosAngle, TEMP_PROP_SAMPLE_DIR)
      const sampleHeight = samplePlanetHeightDetailed(TEMP_PROP_SAMPLE_DIR, this.terrain, 0.35)
      const sampleRadius = this.terrain.radius + sampleHeight * terrainMeters
      const vertical = sampleRadius * cosAngle - originRadius - SUN_SHADOW_CLEARANCE
      const horizontal = Math.max(sampleRadius * sinAngle, 1e-3)
      const obstacleSlope = vertical / horizontal
      blocker = Math.max(blocker, smoothstep(-0.015, 0.080, obstacleSlope - stylizedSunSlope) * weight)
      if (blocker >= 0.995) break
    }

    return 1 - blocker
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

      if (kind === 'tree') {
        const treeHeight = 7.5 + rng() * 12.5
        placementUp.copy(radial).lerp(normal, 0.18).normalize()
        position.addScaledVector(placementUp, 0.08)
        scale.set(treeHeight, treeHeight, treeHeight)
      } else {
        const rockHeight = 0.9 + rng() * 4.6
        const squash = 0.62 + rng() * 0.48
        placementUp.copy(normal).lerp(radial, 0.22).normalize()
        position.addScaledVector(placementUp, 0.03)
        scale.set(
          rockHeight * (1.15 + rng() * 1.45),
          rockHeight * squash,
          rockHeight * (1.00 + rng() * 1.20),
        )
      }

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
    this.bilerpVec3(surface.positions, i00, i10, i01, i11, tx, ty, outPosition)
    this.bilerpVec3(surface.normals, i00, i10, i01, i11, tx, ty, outNormal)
    outNormal.normalize()
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

  private bilerpVec3(
    values: Float32Array<ArrayBufferLike>,
    i00: number,
    i10: number,
    i01: number,
    i11: number,
    tx: number,
    ty: number,
    out: THREE.Vector3,
  ) {
    const x0 = values[i00 * 3] * (1 - tx) + values[i10 * 3] * tx
    const y0 = values[i00 * 3 + 1] * (1 - tx) + values[i10 * 3 + 1] * tx
    const z0 = values[i00 * 3 + 2] * (1 - tx) + values[i10 * 3 + 2] * tx
    const x1 = values[i01 * 3] * (1 - tx) + values[i11 * 3] * tx
    const y1 = values[i01 * 3 + 1] * (1 - tx) + values[i11 * 3 + 1] * tx
    const z1 = values[i01 * 3 + 2] * (1 - tx) + values[i11 * 3 + 2] * tx
    out.set(
      x0 * (1 - ty) + x1 * ty,
      y0 * (1 - ty) + y1 * ty,
      z0 * (1 - ty) + z1 * ty,
    )
  }
}

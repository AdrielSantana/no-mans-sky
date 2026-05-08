import * as THREE from 'three'
import grassAlphaUrl from '../../assets/terrain/grass_alpha.jpg'
import { TERRAIN_NOISE } from '../shaders/noise.glsl'
import { CLOUD_PATTERN_GLSL } from './planet-generator'
import type { QuadtreeNode } from './quadtree'
import { nodeKey } from './quadtree'
import type { TerrainChunkSurfaceData } from './terrain-chunk'

export interface FluffyGrassSettings {
  enabled: boolean
  density: number
  height: number
  windStrength: number
  distance: number
  colorA: string
  colorB: string
}

export type FluffyGrassVariant = 'near' | 'far'

interface FluffyGrassLayerParams {
  node: QuadtreeNode
  surface: TerrainChunkSurfaceData
  material: THREE.ShaderMaterial
  settings: FluffyGrassSettings
  seed: number
  seaHeight: number
  planetType: string
  variant: FluffyGrassVariant
}

const GRASS_TEXTURE_LOADER = new THREE.TextureLoader()
const GRASS_ALPHA_TEXTURE = GRASS_TEXTURE_LOADER.load(grassAlphaUrl)
GRASS_ALPHA_TEXTURE.colorSpace = THREE.NoColorSpace
GRASS_ALPHA_TEXTURE.wrapS = THREE.ClampToEdgeWrapping
GRASS_ALPHA_TEXTURE.wrapT = THREE.ClampToEdgeWrapping
GRASS_ALPHA_TEXTURE.minFilter = THREE.LinearMipmapLinearFilter
GRASS_ALPHA_TEXTURE.magFilter = THREE.LinearFilter

const DEFAULT_CLOUD_MASK_TEXTURE = new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
  THREE.RGBAFormat,
)
DEFAULT_CLOUD_MASK_TEXTURE.name = 'default-cloud-mask'
DEFAULT_CLOUD_MASK_TEXTURE.needsUpdate = true

const MAX_INSTANCES_PER_CHUNK = 2400
const MIN_SURFACE_SLOPE_DOT = 0.62
const MIN_GRASS_ALPHA = 0.12
const PATCH_SCALE_METERS = 72

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
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

function hashGrid(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ seed
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function noiseFade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = noiseFade(x - ix)
  const fy = noiseFade(y - iy)
  const fz = noiseFade(z - iz)

  const x00 = lerp(hashGrid(ix, iy, iz, seed), hashGrid(ix + 1, iy, iz, seed), fx)
  const x10 = lerp(hashGrid(ix, iy + 1, iz, seed), hashGrid(ix + 1, iy + 1, iz, seed), fx)
  const x01 = lerp(hashGrid(ix, iy, iz + 1, seed), hashGrid(ix + 1, iy, iz + 1, seed), fx)
  const x11 = lerp(hashGrid(ix, iy + 1, iz + 1, seed), hashGrid(ix + 1, iy + 1, iz + 1, seed), fx)
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz)
}

function patchNoise(position: THREE.Vector3, seed: number): number {
  let frequency = 1 / PATCH_SCALE_METERS
  let amplitude = 0.62
  let total = 0
  let norm = 0

  for (let octave = 0; octave < 3; octave++) {
    total += valueNoise3(
      position.x * frequency,
      position.y * frequency,
      position.z * frequency,
      seed + octave * 1013,
    ) * amplitude
    norm += amplitude
    frequency *= 2.05
    amplitude *= 0.48
  }

  return norm > 0 ? total / norm : 0
}

function buildBladeGeometry(): THREE.InstancedBufferGeometry {
  const segments = 3
  const planes = 2
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  for (let plane = 0; plane < planes; plane++) {
    const angle = (plane / planes) * Math.PI
    const cx = Math.cos(angle)
    const cz = Math.sin(angle)
    const vertexOffset = positions.length / 3

    for (let y = 0; y <= segments; y++) {
      const v = y / segments
      for (const side of [-1, 1]) {
        positions.push(cx * side * 0.5, v, cz * side * 0.5)
        uvs.push(side < 0 ? 0 : 1, v)
      }
    }

    for (let y = 0; y < segments; y++) {
      const a = vertexOffset + y * 2
      const b = a + 1
      const c = a + 2
      const d = a + 3
      indices.push(a, b, c, b, d, c)
    }
  }

  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

export function createFluffyGrassMaterial(
  settings: FluffyGrassSettings,
  variant: FluffyGrassVariant = 'near',
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: {
      GRASS_ANIMATED: variant === 'near' ? 1 : 0,
    },
    uniforms: {
      uAlphaMap: { value: GRASS_ALPHA_TEXTURE },
      uTime: { value: 0 },
      uWindStrength: { value: settings.windStrength },
      uFadeDistance: { value: settings.distance },
      uFadeRange: { value: Math.max(8, settings.distance * 0.28) },
      uFadeInDistance: { value: 0 },
      uFadeInRange: { value: 1 },
      uColorA: { value: new THREE.Color(settings.colorA) },
      uColorB: { value: new THREE.Color(settings.colorB) },
      uSunPosition: { value: new THREE.Vector3(0, 1, 0) },
      uPlanetCenter: { value: new THREE.Vector3() },
      uPlanetRadius: { value: 1 },
      uLayerOpacity: { value: 1 },
      uSunColor: { value: new THREE.Color(0xfff2c8) },
      uAtmosphereColor: { value: new THREE.Color(0x6fa8dc) },
      uAtmosphereLightColor: { value: new THREE.Color(0xc4d5df) },
      uTwilightColor: { value: new THREE.Color(0xff8a3d) },
      uAtmosphereExtinctionStrength: { value: 0.82 },
      uTerrainAoStrength: { value: 0.45 },
      uCloudCoverage: { value: 0.68 },
      uCloudScale: { value: 2.7 },
      uCloudSoftness: { value: 0.15 },
      uCloudHeight: { value: 0.045 },
      uCloudSpeed: { value: 0.012 },
      uCloudShadowStrength: { value: 0 },
      uCloudVolumeStrength: { value: 1.08 },
      uCloudStormStrength: { value: 0.62 },
      uCloudBandStrength: { value: 0.72 },
      uCloudDetailStrength: { value: 0.82 },
      uCloudQuality: { value: 2 },
      uCloudSeed: { value: 0 },
      uCloudMask: { value: DEFAULT_CLOUD_MASK_TEXTURE },
      uCloudMaskOffset: { value: 0 },
      uCloudLocalSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */ `
      #include <common>
      uniform float uTime;
      uniform float uWindStrength;
      varying vec2 vUv;
      varying float vTip;
      varying float vSeed;
      varying float vDistance;
      varying vec3 vTerrainNormal;
      varying float vTerrainMicroAo;
      varying float vTerrainMacroAo;
      varying vec3 vWorldPos;
      varying vec3 vLocalPlanetDir;
      attribute float instanceSeed;
      attribute vec3 instanceTerrainNormal;
      attribute float instanceTerrainMicroAo;
      attribute float instanceTerrainMacroAo;
      #include <logdepthbuf_pars_vertex>

      void main() {
        vUv = uv;
        vTip = clamp(position.y, 0.0, 1.0);
        vSeed = instanceSeed;

        vec3 transformed = position;
        vec3 instancePlanetLocal = vec3(0.0);
        #ifdef USE_INSTANCING
          instancePlanetLocal = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif

        #if GRASS_ANIMATED == 1
        vec3 windDirA = normalize(vec3(0.74, 0.18, -0.65));
        vec3 windDirB = normalize(vec3(-0.32, 0.09, -0.94));
        float waveA = sin(dot(instancePlanetLocal, windDirA) * 0.040 + uTime * 1.35);
        float waveB = sin(dot(instancePlanetLocal, windDirB) * 0.075 + uTime * 2.10 + 1.7);
        float gustEnvelope = smoothstep(-0.35, 0.95, sin(dot(instancePlanetLocal, windDirA) * 0.012 - uTime * 0.55));
        float localFlutter = sin(instanceSeed * 6.2831853 + uTime * 3.6 + position.y * 3.0) * 0.16;
        float gust = (waveA * 0.72 + waveB * 0.28) * (0.45 + gustEnvelope * 0.75) + localFlutter;
        float bend = vTip * vTip * uWindStrength * gust * 0.30;
        transformed.x += bend;
        transformed.z += bend * 0.24 * cos(dot(instancePlanetLocal, windDirB) * 0.030 + uTime * 0.80);
        #endif

        #ifdef USE_INSTANCING
          transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif

        vLocalPlanetDir = normalize(instancePlanetLocal);
        vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
        vWorldPos = worldPosition.xyz;
        vTerrainNormal = normalize(mat3(modelMatrix) * instanceTerrainNormal);
        vTerrainMicroAo = instanceTerrainMicroAo;
        vTerrainMacroAo = instanceTerrainMacroAo;
        vDistance = distance(cameraPosition, worldPosition.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      ${TERRAIN_NOISE}
      ${CLOUD_PATTERN_GLSL}
      uniform sampler2D uAlphaMap;
      uniform float uFadeDistance;
      uniform float uFadeRange;
      uniform float uFadeInDistance;
      uniform float uFadeInRange;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform vec3 uSunPosition;
      uniform vec3 uPlanetCenter;
      uniform vec3 uCloudLocalSunDirection;
      uniform float uPlanetRadius;
      uniform float uLayerOpacity;
      uniform vec3 uSunColor;
      uniform vec3 uAtmosphereColor;
      uniform vec3 uAtmosphereLightColor;
      uniform vec3 uTwilightColor;
      uniform float uAtmosphereExtinctionStrength;
      uniform float uTerrainAoStrength;
      varying vec2 vUv;
      varying float vTip;
      varying float vSeed;
      varying float vDistance;
      varying vec3 vTerrainNormal;
      varying float vTerrainMicroAo;
      varying float vTerrainMacroAo;
      varying vec3 vWorldPos;
      varying vec3 vLocalPlanetDir;
      #include <logdepthbuf_pars_fragment>

      float terrainBakedAmbientOcclusion(float bakedAo, float amount, float nearFloor, float farFloor) {
        float strength = clamp(uTerrainAoStrength, 0.0, 2.0);
        if (strength <= 0.001) return 1.0;

        float cavity = 1.0 - clamp(bakedAo, 0.0, 1.0);
        float floorValue = min(nearFloor, farFloor);
        return clamp(1.0 - cavity * strength * amount, floorValue, 1.0);
      }

      vec3 applyGrassLighting(vec3 albedo, vec3 terrainNormal, vec3 radialUp, vec3 worldPos, float terrainMicroAo, float terrainMacroAo) {
        vec3 up = normalize(terrainNormal);
        vec3 lightDir = normalize(uSunPosition - worldPos);
        vec3 viewDir = normalize(cameraPosition - worldPos);
        float nDotL = dot(up, lightDir);
        float skyVisibility = clamp(dot(up, radialUp) * 0.54 + 0.46, 0.18, 1.0);
        float day = smoothstep(-0.22, 0.62, nDotL);
        float direct = max(nDotL, 0.0);
        float lowSun = pow(1.0 - clamp(nDotL * 0.92 + 0.08, 0.0, 1.0), 1.8)
          * smoothstep(-0.24, 0.50, nDotL);
        float terminator = smoothstep(-0.34, 0.18, nDotL) * (1.0 - smoothstep(0.22, 0.72, nDotL));
        const float atmosphereLightInfluence = 0.85;
        float extinctionStrength = clamp(uAtmosphereExtinctionStrength, 0.0, 2.0);
        vec3 nightTint = vec3(0.010, 0.016, 0.032);
        nightTint = mix(nightTint, nightTint + uAtmosphereLightColor * 0.055, atmosphereLightInfluence * 0.24);
        vec3 sunsetTint = mix(vec3(1.0, 0.34, 0.10), uSunColor, 0.36);
        sunsetTint = mix(sunsetTint, uAtmosphereLightColor, 0.18);
        vec3 sunTint = mix(vec3(1.0), uAtmosphereLightColor, atmosphereLightInfluence * 0.82);
        sunTint = mix(sunTint, sunsetTint, lowSun * extinctionStrength * 0.72);
        vec3 skyTint = mix(vec3(0.36, 0.48, 0.62), uAtmosphereLightColor, 0.58 + atmosphereLightInfluence * 0.14);
        vec3 twilightFill = mix(uTwilightColor * 0.28, uAtmosphereLightColor * 0.24, atmosphereLightInfluence * 0.22);
        float directTransmission = mix(1.0, 0.58, lowSun * extinctionStrength);
        float rim = pow(1.0 - max(dot(up, viewDir), 0.0), 2.0) * smoothstep(-0.05, 0.50, nDotL);
        vec3 lit = albedo * skyTint * (0.12 + day * 0.18) * skyVisibility
          + albedo * sunTint * (direct * 0.74 + direct * direct * 0.18) * directTransmission;
        lit += albedo * twilightFill * terminator * extinctionStrength * 0.16;
        vec3 nightLit = albedo * nightTint * 0.12;
        lit = mix(nightLit, lit, day);
        lit += mix(vec3(0.22, 0.34, 0.48), uAtmosphereLightColor, atmosphereLightInfluence * 0.46) * rim * 0.045 * day;
        lit *= terrainBakedAmbientOcclusion(terrainMacroAo, 0.24, 0.54, 0.76);
        lit *= terrainBakedAmbientOcclusion(terrainMicroAo, 0.36, 0.72, 0.88);
        return lit;
      }

      void main() {
        float alpha = texture2D(uAlphaMap, vUv).r;
        float fadeIn = smoothstep(uFadeInDistance, uFadeInDistance + max(uFadeInRange, 0.001), vDistance);
        float fadeOut = 1.0 - smoothstep(uFadeDistance, uFadeDistance + uFadeRange, vDistance);
        alpha *= fadeIn * fadeOut;
        alpha *= smoothstep(0.01, 0.18, vTip);
        alpha *= uLayerOpacity;
        if (alpha < ${MIN_GRASS_ALPHA.toFixed(2)}) discard;

        #include <logdepthbuf_fragment>
        float tint = fract(sin(vSeed * 91.731) * 43758.5453);
        vec3 baseColor = mix(uColorA, uColorB, clamp(vTip * 0.86 + tint * 0.18, 0.0, 1.0));
        baseColor = mix(baseColor, uColorB, pow(vTip, 2.0) * 0.08);
        vec3 radialUp = normalize(vWorldPos - uPlanetCenter);
        vec3 terrainNormal = normalize(vTerrainNormal);
        vec3 color = applyGrassLighting(baseColor, terrainNormal, radialUp, vWorldPos, vTerrainMicroAo, vTerrainMacroAo);
        color = applyCloudShadow(color, normalize(vLocalPlanetDir), normalize(uCloudLocalSunDirection), 1.0);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    transparent: false,
    alphaToCoverage: true,
    depthWrite: true,
    depthTest: true,
  })
}

export function updateFluffyGrassMaterial(
  material: THREE.ShaderMaterial,
  settings: FluffyGrassSettings,
  time: number,
  sunPosition: THREE.Vector3,
  planetCenter: THREE.Vector3,
  planetRadius: number,
  distanceMultiplier = 1,
  opacity = 1,
  fadeInDistance = 0,
  fadeInRange = 1,
) {
  material.uniforms.uTime.value = time
  material.uniforms.uWindStrength.value = settings.windStrength
  const fadeDistance = settings.distance * distanceMultiplier
  material.uniforms.uFadeDistance.value = fadeDistance
  material.uniforms.uFadeRange.value = Math.max(8, fadeDistance * 0.28)
  material.uniforms.uFadeInDistance.value = fadeInDistance
  material.uniforms.uFadeInRange.value = Math.max(1, fadeInRange)
  material.uniforms.uColorA.value.set(settings.colorA)
  material.uniforms.uColorB.value.set(settings.colorB)
  material.uniforms.uSunPosition.value.copy(sunPosition)
  material.uniforms.uPlanetCenter.value.copy(planetCenter)
  material.uniforms.uPlanetRadius.value = planetRadius
  material.uniforms.uLayerOpacity.value = opacity
}

export class FluffyGrassLayer {
  readonly mesh: THREE.InstancedMesh
  readonly instanceCount: number

  constructor(params: FluffyGrassLayerParams) {
    const geometry = buildBladeGeometry()
    const placement = this.buildInstances(params)
    geometry.setAttribute('instanceSeed', new THREE.InstancedBufferAttribute(placement.seeds, 1))
    geometry.setAttribute('instanceTerrainNormal', new THREE.InstancedBufferAttribute(placement.normals, 3))
    geometry.setAttribute('instanceTerrainMicroAo', new THREE.InstancedBufferAttribute(placement.microAo, 1))
    geometry.setAttribute('instanceTerrainMacroAo', new THREE.InstancedBufferAttribute(placement.macroAo, 1))

    this.mesh = new THREE.InstancedMesh(geometry, params.material, placement.count)
    this.mesh.count = placement.count
    this.mesh.frustumCulled = true
    this.mesh.renderOrder = 1
    this.instanceCount = placement.count

    for (let i = 0; i < placement.count; i++) {
      this.mesh.setMatrixAt(i, placement.matrices[i])
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.visible = placement.count > 0
  }

  setVisible(visible: boolean) {
    this.mesh.visible = visible && this.instanceCount > 0
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
  }

  private buildInstances(params: FluffyGrassLayerParams): {
    count: number
    matrices: THREE.Matrix4[]
    seeds: Float32Array
    normals: Float32Array
    microAo: Float32Array
    macroAo: Float32Array
  } {
    if (!params.settings.enabled || params.planetType !== 'rocky' || params.settings.density <= 0) {
      return {
        count: 0,
        matrices: [],
        seeds: new Float32Array(0),
        normals: new Float32Array(0),
        microAo: new Float32Array(0),
        macroAo: new Float32Array(0),
      }
    }

    const { surface, node, settings } = params
    const gridSize = surface.gridSize
    const cellCount = (gridSize - 1) * (gridSize - 1)
    const far = params.variant === 'far'
    const targetCount = Math.min(
      MAX_INSTANCES_PER_CHUNK,
      Math.max(0, Math.floor(cellCount * clamp(settings.density, 0, 1.5) * (far ? 0.55 : 1.85))),
    )
    const rng = mulberry32(hashString(nodeKey(node.face, node.lod, node.x, node.y)) ^ params.seed)
    const matrices: THREE.Matrix4[] = []
    const seeds = new Float32Array(targetCount)
    const normals = new Float32Array(targetCount * 3)
    const microAo = new Float32Array(targetCount)
    const macroAo = new Float32Array(targetCount)
    const position = new THREE.Vector3()
    const normal = new THREE.Vector3()
    const radial = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const spin = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const dummy = new THREE.Object3D()
    const up = new THREE.Vector3(0, 1, 0)
    const maxAttempts = Math.max(targetCount * (far ? 18 : 13), 120)

    for (let attempt = 0; matrices.length < targetCount && attempt < maxAttempts; attempt++) {
      const ix = Math.floor(rng() * (gridSize - 1))
      const iy = Math.floor(rng() * (gridSize - 1))
      const tx = rng()
      const ty = rng()
      this.sampleSurface(surface, ix, iy, tx, ty, position, normal)
      radial.copy(position).normalize()

      const height = this.sampleHeight(surface, ix, iy, tx, ty)
      const slopeDot = normal.dot(radial)
      const heightNorm = smoothstep(-1, 1, height)
      const latitude = Math.abs(radial.y)
      const moisture = saturate(height * 0.75 + 0.5)
      const slope = saturate(1 - slopeDot)
      const coast = smoothstep(params.seaHeight - 0.014, params.seaHeight + 0.014, height)
        * (1 - smoothstep(params.seaHeight + 0.026, params.seaHeight + 0.060, height))
      const rockMask = saturate(slope * 0.75 + smoothstep(0.60, 0.72, heightNorm))
      const snowMask = smoothstep(0.74, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude)
      const grassBiomeMask = smoothstep(0.34, 0.62, moisture)
        * (1 - coast)
        * (1 - rockMask)
        * (1 - snowMask)
        * (1 - smoothstep(0.58, 0.70, heightNorm))
      const aboveSeaMask = smoothstep(params.seaHeight + 0.018, params.seaHeight + 0.075, height)
      const slopeMask = smoothstep(MIN_SURFACE_SLOPE_DOT, 0.88, slopeDot)
      const patchMask = smoothstep(far ? 0.43 : 0.46, far ? 0.57 : 0.60, patchNoise(position, params.seed))
      const patchEdgeJitter = smoothstep(0.12, 0.72, rng() * 0.34 + patchMask * 0.82)
      const mask = aboveSeaMask * grassBiomeMask * slopeMask * patchMask
      if (rng() > mask * patchEdgeJitter) continue

      const width = settings.height * (far ? 2.6 + rng() * 2.2 : 0.52 + rng() * 0.42)
      const bladeHeight = settings.height * (far ? 0.34 + rng() * 0.24 : 0.56 + rng() * 0.36)
      position.addScaledVector(radial, Math.max(0.04, bladeHeight * 0.045))
      quaternion.setFromUnitVectors(up, radial)
      spin.setFromAxisAngle(radial, rng() * Math.PI * 2)
      quaternion.premultiply(spin)
      scale.set(width, bladeHeight, width)
      dummy.position.copy(position)
      dummy.quaternion.copy(quaternion)
      dummy.scale.copy(scale)
      dummy.updateMatrix()
      const instanceIndex = matrices.length
      matrices.push(dummy.matrix.clone())
      seeds[instanceIndex] = rng()
      normals[instanceIndex * 3] = normal.x
      normals[instanceIndex * 3 + 1] = normal.y
      normals[instanceIndex * 3 + 2] = normal.z
      microAo[instanceIndex] = this.sampleScalar(surface.microAo, gridSize, ix, iy, tx, ty)
      macroAo[instanceIndex] = this.sampleScalar(surface.macroAo, gridSize, ix, iy, tx, ty)
    }

    return {
      count: matrices.length,
      matrices,
      seeds: seeds.slice(0, matrices.length),
      normals: normals.slice(0, matrices.length * 3),
      microAo: microAo.slice(0, matrices.length),
      macroAo: macroAo.slice(0, matrices.length),
    }
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

  private sampleHeight(surface: TerrainChunkSurfaceData, ix: number, iy: number, tx: number, ty: number): number {
    return this.sampleScalar(surface.heights, surface.gridSize, ix, iy, tx, ty)
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

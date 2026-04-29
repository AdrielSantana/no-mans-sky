import * as THREE from 'three'
import grassTextureUrl from '../../assets/terrain/grass_soil_tile.webp'
import rockTextureUrl from '../../assets/terrain/rock_tile.webp'
import sandTextureUrl from '../../assets/terrain/sand_tile.webp'
import snowTextureUrl from '../../assets/terrain/snow_tile.webp'
import { TERRAIN_NOISE } from '../shaders/noise.glsl'

export interface PlanetNoiseProfile {
  seed: number
  octaves: number
  lacunarity: number
  gain: number
  frequency: number
  warpStrength: number
  continentalScale: number
  mountainScale: number
  erosionStrength: number
  thermalStrength: number
  detailStrength: number
}

export const PlanetKind = {
  Rocky: 0,
  Gas: 1,
  Ice: 2,
} as const

export function getSeaHeight(waterLevel: number, planetType: string): number {
  if (waterLevel <= 0.02 || planetType === 'gas') return -10

  const coverage = THREE.MathUtils.clamp(waterLevel, 0, 1)
  if (planetType === 'ice') {
    return -0.16 + coverage * 0.22
  }

  return -0.18 + coverage * 0.28
}

export class PlanetGenerator {
  static fromParams(params: {
    seed: bigint
    planetType: string
    terrainScale: number
  }): PlanetNoiseProfile {
    const seed = Number(params.seed)

    switch (params.planetType) {
      case 'gas':
        return {
          seed,
          octaves: 4,
          lacunarity: 2.2,
          gain: 0.4,
          frequency: 4.0,
          warpStrength: 0.18,
          continentalScale: 0.15,
          mountainScale: 0,
          erosionStrength: 0,
          thermalStrength: 0,
          detailStrength: 0.25,
        }
      case 'ice':
        return {
          seed,
          octaves: 5,
          lacunarity: 1.8,
          gain: 0.45,
          frequency: 2.5,
          warpStrength: 0.26,
          continentalScale: 0.8,
          mountainScale: 0.72,
          erosionStrength: 0.16,
          thermalStrength: 0.48,
          detailStrength: 0.36,
        }
      case 'rocky':
      default:
        return {
          seed,
          octaves: 6,
          lacunarity: 2.0,
          gain: 0.5,
          frequency: 2.0,
          warpStrength: 0.42,
          continentalScale: 1.0,
          mountainScale: 1.0,
          erosionStrength: 0.34,
          thermalStrength: 0.2,
          detailStrength: 0.55,
        }
    }
  }
}

const terrainTextureLoader = new THREE.TextureLoader()

function loadTerrainTexture(url: string): THREE.Texture {
  const texture = terrainTextureLoader.load(url)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 16
  return texture
}

const TERRAIN_TEXTURES = {
  grass: loadTerrainTexture(grassTextureUrl),
  rock: loadTerrainTexture(rockTextureUrl),
  sand: loadTerrainTexture(sandTextureUrl),
  snow: loadTerrainTexture(snowTextureUrl),
}

const TEXTURE_RADIUS_REFERENCE = 650

function getPlanetTextureScale(textureScale: number, planetRadius: number, multiplier = 1): number {
  return textureScale * (planetRadius / TEXTURE_RADIUS_REFERENCE) * multiplier
}

const TERRAIN_TEXTURE_GLSL = /* glsl */ `
uniform sampler2D uGrassTexture;
uniform sampler2D uRockTexture;
uniform sampler2D uSandTexture;
uniform sampler2D uSnowTexture;
uniform float uTextureScale;
uniform float uTextureBlend;
uniform float uTextureNearDistance;
uniform float uTextureFadeDistance;
uniform float uTextureDetailScale;
uniform float uTextureFarScale;
uniform float uTextureFarStrength;

vec2 terrainTextureUv(vec3 sphereDir, float scale) {
  vec3 n = normalize(sphereDir);
  vec3 a = abs(n);
  vec2 uv;

  if (a.x >= a.y && a.x >= a.z) {
    uv = n.zy / max(a.x, 0.0001);
    if (n.x < 0.0) uv.x = -uv.x;
  } else if (a.y >= a.z) {
    uv = n.xz / max(a.y, 0.0001);
    if (n.y < 0.0) uv.x = -uv.x;
  } else {
    uv = n.xy / max(a.z, 0.0001);
    if (n.z < 0.0) uv.x = -uv.x;
  }

  return uv * scale * 0.5;
}

vec3 sampleTerrainTexture(sampler2D tex, vec3 sphereDir, float materialScale, float offset, float scaleMultiplier) {
  vec2 uv = terrainTextureUv(sphereDir, uTextureScale * materialScale * scaleMultiplier);
  vec2 baseOffset = vec2(offset * 0.137, offset * 0.071);
  return texture2D(tex, uv + baseOffset).rgb;
}

vec3 sampleBiomeTexture(vec3 dir, float coast, float rockMask, float snowMask, float moisture, float scaleMultiplier) {
  vec3 grassTex = sampleTerrainTexture(uGrassTexture, dir, 1.00, 11.0, scaleMultiplier);
  vec3 rockTex = sampleTerrainTexture(uRockTexture, dir, 0.72, 23.0, scaleMultiplier);
  vec3 sandTex = sampleTerrainTexture(uSandTexture, dir, 1.18, 37.0, scaleMultiplier);
  vec3 snowTex = sampleTerrainTexture(uSnowTexture, dir, 0.92, 53.0, scaleMultiplier);

  vec3 lowTex = mix(sandTex, grassTex, smoothstep(0.34, 0.62, moisture));
  vec3 texColor = mix(lowTex, rockTex, clamp(rockMask, 0.0, 1.0));
  texColor = mix(texColor, sandTex, clamp(coast, 0.0, 1.0));
  texColor = mix(texColor, snowTex, clamp(snowMask, 0.0, 1.0));
  return texColor;
}

vec3 blendTerrainTexture(vec3 baseColor, vec3 texColor, float amount) {
  if (amount <= 0.001) return baseColor;

  float texLuma = dot(texColor, vec3(0.299, 0.587, 0.114));
  vec3 tonalDetail = baseColor * (0.72 + texLuma * 0.58);
  vec3 colorDetail = mix(tonalDetail, texColor, 0.28);
  return mix(baseColor, colorDetail, amount);
}

vec3 applyTerrainTexture(vec3 baseColor, vec3 sphereDir, float planetKind, float heightNorm, float coast, float rockMask, float snowMask, float moisture, float cameraDistance) {
  if (planetKind > 0.5 && planetKind < 1.5 || uTextureBlend <= 0.001) return baseColor;

  vec3 dir = normalize(sphereDir);
  float detailFade = 1.0 - smoothstep(
    uTextureNearDistance,
    uTextureNearDistance + max(uTextureFadeDistance, 0.001),
    cameraDistance
  );
  float farAmount = uTextureBlend * uTextureFarStrength;

  if (detailFade >= 0.999) {
    vec3 nearTex = sampleBiomeTexture(dir, coast, rockMask, snowMask, moisture, uTextureDetailScale);
    return blendTerrainTexture(baseColor, nearTex, uTextureBlend);
  }

  if (detailFade <= 0.001) {
    vec3 farTex = sampleBiomeTexture(dir, coast, rockMask, snowMask, moisture, uTextureFarScale);
    return blendTerrainTexture(baseColor, farTex, farAmount);
  }

  vec3 nearTex = sampleBiomeTexture(dir, coast, rockMask, snowMask, moisture, uTextureDetailScale);
  vec3 farTex = sampleBiomeTexture(dir, coast, rockMask, snowMask, moisture, uTextureFarScale);
  vec3 texColor = mix(farTex, nearTex, detailFade);
  float textureAmount = mix(farAmount, uTextureBlend, detailFade);
  return blendTerrainTexture(baseColor, texColor, textureAmount);
}
`

const TERRAIN_HEIGHT_GLSL = /* glsl */ `
uniform float uSeed;
uniform float uFrequency;
uniform float uOctaves;
uniform float uPlanetKind;
uniform float uLacunarity;
uniform float uGain;
uniform float uWarpStrength;
uniform float uContinentalScale;
uniform float uMountainScale;
uniform float uErosionStrength;
uniform float uThermalStrength;
uniform float uDetailStrength;

vec3 terrainWarpedDirection(vec3 dir) {
  if (uWarpStrength <= 0.0) return normalize(dir);

  vec3 p = dir * 1.35;
  vec3 offset = vec3(
    terrainFbm(p + vec3(11.3, -4.8, 7.1), uSeed + 101.7, 3, uLacunarity, uGain),
    terrainFbm(p + vec3(-8.2, 16.5, 2.4), uSeed + 211.3, 3, uLacunarity, uGain),
    terrainFbm(p + vec3(5.6, 9.7, -13.8), uSeed + 307.9, 3, uLacunarity, uGain)
  );
  return normalize(dir + offset * uWarpStrength * 0.36);
}

float realisticTerrainHeight(vec3 sphereDir) {
  vec3 baseDir = normalize(sphereDir);
  if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
    return terrainFbm(baseDir * uFrequency, uSeed, int(uOctaves), uLacunarity, uGain) * 0.05;
  }

  vec3 warped = terrainWarpedDirection(baseDir);
  int octaveCount = int(uOctaves);
  float continentalRaw = terrainFbm(warped * uFrequency * 0.48, uSeed, min(octaveCount, 4), uLacunarity, uGain);
  float basinRaw = terrainFbm(warped * uFrequency * 0.22 + vec3(19.1, -5.4, 12.6), uSeed + 43.1, 3, 2.05, 0.48);
  float continentMask = smoothstep(-0.28, 0.46, continentalRaw + basinRaw * 0.18);
  float continentHeight = (continentMask * 2.0 - 1.0) * 0.34 * uContinentalScale;

  float lowlandUndulation = terrainFbm(warped * uFrequency * 1.18 + vec3(3.7, -8.1, 4.2), uSeed + 17.5, min(octaveCount, 5), uLacunarity, uGain) * 0.105;
  float plateNoise = abs(terrainFbm(warped * uFrequency * 0.82 + vec3(-23.5, 6.2, 14.8), uSeed + 83.4, 4, 2.1, 0.52));
  float plateBoundary = pow(1.0 - clamp(plateNoise, 0.0, 1.0), 3.15);

  float ridgeNoise = abs(terrainFbm(warped * uFrequency * 2.75 + 17.0, uSeed + 9.7, min(4, max(2, octaveCount - 2)), uLacunarity, uGain * 0.92));
  float mountainSharpness = mix(2.65, 1.85, clamp(uThermalStrength, 0.0, 1.0) * 0.45);
  float ridges = pow(1.0 - clamp(ridgeNoise, 0.0, 1.0), mountainSharpness);
  float mountainMask = smoothstep(0.36, 0.95, continentMask + plateBoundary * 0.62);
  float mountains = ridges * mountainMask * (0.12 + plateBoundary * 0.21) * uMountainScale;

  float drainageNoise = abs(terrainFbm(warped * uFrequency * 5.8 + vec3(-31.0, 27.0, 4.0), uSeed + 131.9, 4, 2.22, 0.46));
  float channels = pow(1.0 - clamp(drainageNoise, 0.0, 1.0), 6.5)
    * smoothstep(0.08, 0.82, continentMask)
    * (1.0 - smoothstep(0.20, 0.44, mountains));
  float hydraulicCut = channels * uErosionStrength * (0.055 + continentMask * 0.045);
  float sedimentFill = channels * uErosionStrength * smoothstep(-0.18, 0.10, continentHeight) * 0.018;

  float thermalTalus = max(0.0, mountains - 0.10) * uThermalStrength * 0.23;
  float fineNoise = terrainFbm(warped * uFrequency * 10.5 + vec3(41.0, -11.0, 29.0), uSeed + 251.7, min(octaveCount, 5), 2.28, 0.42);
  float badlands = pow(1.0 - abs(fineNoise), 4.2)
    * smoothstep(0.22, 0.76, continentMask)
    * (1.0 - smoothstep(0.05, 0.22, mountains));
  float detail = (fineNoise * 0.026 + badlands * 0.032) * uDetailStrength * (1.0 - uThermalStrength * 0.35);

  if (uPlanetKind > 1.5) {
    return continentHeight * 0.72
      + lowlandUndulation * 0.55
      + mountains * 0.58
      - hydraulicCut * 0.38
      - thermalTalus * 0.45
      + detail * 0.42
      + smoothstep(0.50, 0.95, abs(baseDir.y)) * 0.045;
  }

  return continentHeight + lowlandUndulation + mountains - hydraulicCut + sedimentFill - thermalTalus + detail;
}
`

const PLANET_LIGHTING_GLSL = /* glsl */ `
float terrainReliefOcclusion(float heightNorm, float slope) {
  if (uPlanetKind > 0.5 && uPlanetKind < 1.5) return 1.0;

  float rugged = smoothstep(0.06, 0.48, slope);
  float lowPocket = 1.0 - smoothstep(0.34, 0.58, heightNorm);
  float highCrisp = smoothstep(0.58, 0.86, heightNorm) * rugged;
  return clamp(1.0 - rugged * 0.13 - lowPocket * 0.04 + highCrisp * 0.025, 0.78, 1.03);
}

vec3 applyPlanetLighting(vec3 albedo, vec3 normal, vec3 worldPos, float heightNorm, float slope) {
  vec3 n = normalize(normal);
  vec3 lightDir = normalize(uSunPosition - worldPos);
  vec3 viewDir = normalize(cameraPosition - worldPos);
  float nDotL = dot(n, lightDir);
  float day = smoothstep(-0.18, 0.62, nDotL);
  float direct = max(nDotL, 0.0);
  float reliefOcclusion = terrainReliefOcclusion(heightNorm, slope);
  float softDirect = direct * 0.78 + direct * direct * 0.24;
  softDirect *= mix(0.82, 1.0, reliefOcclusion);
  float ambient = mix(0.055, 0.22, day) * reliefOcclusion;
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.3) * smoothstep(-0.05, 0.50, nDotL);
  float highland = smoothstep(0.60, 0.90, heightNorm) * 0.055;
  float cavity = 1.0 - slope * mix(0.12, 0.05, day);
  float tintStrength = clamp(uSunTintStrength, 0.0, 2.0);
  vec3 nightTint = mix(vec3(0.025, 0.035, 0.060), uAtmosphereLightColor * 0.075, tintStrength * 0.22);
  vec3 sunTint = mix(vec3(1.0), uAtmosphereLightColor, tintStrength * 0.82);
  vec3 ambientTint = mix(vec3(1.0), uAtmosphereLightColor, tintStrength * 0.24);
  vec3 lit = albedo * ambientTint * (ambient + highland) * cavity + albedo * sunTint * softDirect * 0.92 * cavity;
  lit = mix(albedo * nightTint, lit, day);
  lit += mix(vec3(0.32, 0.48, 0.68), uAtmosphereLightColor, tintStrength * 0.55) * rim * 0.16;
  return lit;
}
`

const AERIAL_PERSPECTIVE_GLSL = /* glsl */ `
vec3 applyAerialPerspective(vec3 color, vec3 worldPos, vec3 normal) {
  float strength = clamp(uAtmosphereHazeStrength, 0.0, 2.0);
  if (strength <= 0.0001) return color;

  vec3 n = normalize(normal);
  vec3 viewDir = normalize(cameraPosition - worldPos);
  vec3 lightDir = normalize(uSunPosition - worldPos);

  float cameraDist = distance(cameraPosition, worldPos);
  float distanceScale = max(uPlanetRadius * max(uAtmosphereHazeDistance, 0.05), 0.001);
  float distanceFog = 1.0 - exp(-cameraDist / distanceScale);
  float grazing = pow(1.0 - max(dot(n, viewDir), 0.0), 2.15);
  float day = smoothstep(-0.25, 0.58, dot(n, lightDir));
  float forwardScatter = pow(max(dot(viewDir, lightDir), 0.0), 4.0);

  vec3 atmosphereTint = mix(uAtmosphereColor, uAtmosphereLightColor, 0.62 + forwardScatter * 0.20);
  vec3 nightHaze = uAtmosphereColor * 0.18 + vec3(0.004, 0.007, 0.016);
  vec3 hazeColor = mix(nightHaze, atmosphereTint, day);
  float haze = (distanceFog * 0.54 + grazing * 0.46) * strength * (0.20 + day * 0.80);
  haze += forwardScatter * distanceFog * strength * 0.10;
  haze = clamp(haze, 0.0, 0.78);

  return mix(color, hazeColor, haze);
}
`

// Terrain chunks are displaced on the CPU so physics, wireframe, and rendering share one surface.
export function createPlanetMaterial(params: {
  seed: number
  planetType: string
  waterLevel: number
  terrainScale: number
  localDetailNear: number
  localDetailFar: number
  colorA: string
  colorB: string
  textureScale: number
  textureBlend: number
  textureNearDistance: number
  textureFadeDistance: number
  textureDetailScale: number
  textureFarScale: number
  textureFarStrength: number
  atmosphereColor: string
  atmosphereHazeStrength: number
  atmosphereHazeDistance: number
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  sunTintStrength: number
  planetRadius: number
  octaves: number
  frequency: number
}): THREE.ShaderMaterial {
  const colorA = new THREE.Color(params.colorA)
  const colorB = new THREE.Color(params.colorB)
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const planetKind = params.planetType === 'gas'
    ? PlanetKind.Gas
    : params.planetType === 'ice'
      ? PlanetKind.Ice
      : PlanetKind.Rocky

  const vertexShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uSeed;
  uniform float uTerrainScale;
  uniform float uPlanetRadius;
  uniform float uFrequency;
  uniform float uOctaves;
  uniform float uPlanetKind;
  uniform float uLocalDetailNear;
  uniform float uLocalDetailFar;
  attribute float terrainHeight;

  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;
  varying float vDetail;
  varying float vNearDetail;

  float getHeight(vec3 sphereDir) {
    float continental = terrainFbm(sphereDir * uFrequency, uSeed, 4, 2.0, 0.5);
    float ridges = abs(terrainFbm(sphereDir * (uFrequency * 2.6) + 17.0, uSeed + 9.7, 2, 2.0, 0.45));
    ridges = pow(1.0 - ridges, 2.4);
    float mountainMask = smoothstep(0.30, 0.78, continental);

    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      return continental * 0.05;
    }

    return continental * 0.55 + ridges * mountainMask * 0.14;
  }

  void main() {
    vec3 sphereDir = normalize(position);
    vSphereDir = sphereDir;

    float h = terrainHeight;
    vHeight = h;
    vDetail = 0.0;

    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    float cameraDist = distance(cameraPosition, worldPos.xyz);
    vNearDetail = 1.0 - smoothstep(uLocalDetailNear, uLocalDetailFar, cameraDist);

    vRadialNormal = normalize((modelMatrix * vec4(sphereDir, 0.0)).xyz);
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    if (dot(vNormal, vRadialNormal) < 0.0) vNormal = -vNormal;

    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <logdepthbuf_pars_fragment>
  ${TERRAIN_TEXTURE_GLSL}

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uSeaHeight;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform float uSunTintStrength;
  uniform float uAtmosphereHazeStrength;
  uniform float uAtmosphereHazeDistance;
  uniform float uSeed;
  uniform float uFrequency;
  uniform float uPlanetKind;
  uniform float uPlanetRadius;
  uniform float uLocalDetailNear;
  uniform float uLocalDetailFar;

  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;
  varying float vDetail;
  varying float vNearDetail;

  ${PLANET_LIGHTING_GLSL}
  ${AERIAL_PERSPECTIVE_GLSL}

  float saturate(float v) {
    return clamp(v, 0.0, 1.0);
  }

  vec3 rockyBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 deepRock = mix(uColorA * 0.62, vec3(0.30, 0.27, 0.23), 0.38);
    vec3 lowland = mix(uColorA * 0.82, vec3(0.22, 0.34, 0.20), saturate(moisture * 0.55 + 0.10));
    vec3 dryland = mix(uColorA * 0.78, vec3(0.54, 0.45, 0.31), saturate(1.0 - moisture) * 0.65);
    vec3 highRock = mix(uColorB * 0.82, vec3(0.42, 0.39, 0.35), 0.58);
    vec3 snow = vec3(0.80, 0.83, 0.82);
    vec3 beach = vec3(0.68, 0.60, 0.44);

    vec3 color = mix(deepRock, mix(dryland, lowland, moisture), smoothstep(0.36, 0.50, heightNorm));
    float coast = smoothstep(uSeaHeight - 0.014, uSeaHeight + 0.014, vHeight) * (1.0 - smoothstep(uSeaHeight + 0.026, uSeaHeight + 0.060, vHeight));
    color = mix(color, beach, coast);
    color = mix(color, highRock, smoothstep(0.58, 0.70, heightNorm));
    color = mix(color, snow, smoothstep(0.74, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude));
    color = mix(color, highRock, saturate(slope * 0.95));
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, 0.78);
    return color;
  }

  vec3 iceBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 blueIce = vec3(0.46, 0.68, 0.80);
    vec3 snow = vec3(0.86, 0.91, 0.95);
    vec3 rock = vec3(0.32, 0.36, 0.38);
    vec3 color = mix(blueIce, snow, smoothstep(0.28, 0.8, heightNorm + latitude * 0.25 + moisture * 0.1));
    return mix(color, rock, smoothstep(0.45, 0.95, slope));
  }

  vec3 gasBands(float latitude, float bands, float turbulence) {
    vec3 bandA = mix(uColorA, vec3(0.95, 0.74, 0.48), 0.35);
    vec3 bandB = mix(uColorB, vec3(0.60, 0.34, 0.18), 0.35);
    vec3 storms = vec3(1.0, 0.88, 0.62);
    vec3 color = mix(bandA, bandB, bands);
    color = mix(color, storms, smoothstep(0.62, 0.95, turbulence) * (1.0 - latitude * 0.45));
    return color;
  }

  vec3 materialAlbedoDetail(vec3 color, float heightNorm, float latitude, float moisture, float slope, float coast) {
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) return color;
    if (vNearDetail <= 0.01) return color;

    vec3 sphereDir = normalize(vSphereDir);
    float macro = terrainFbm(sphereDir * 38.0 + 13.0, uSeed + 601.0, 4, 2.0, 0.5);
    float grain = terrainFbm(sphereDir * 180.0 + 29.0, uSeed + 701.0, 3, 2.1, 0.45);
    float cracks = abs(macro * 0.65 + grain * 0.35);
    cracks = pow(1.0 - cracks, 5.0);

    float snow = smoothstep(0.68, 0.88, heightNorm + latitude * 0.18) * smoothstep(0.48, 0.88, latitude);
    float dry = saturate(1.0 - moisture);
    float rock = saturate(slope * 1.4 + smoothstep(0.55, 0.82, heightNorm));

    color *= 0.92 + macro * 0.10 + grain * 0.04;
    color = mix(color, color * (0.82 + cracks * 0.20), rock * 0.45);
    color = mix(color, color + vec3(0.07, 0.055, 0.025) * grain, dry * (1.0 - coast) * 0.45);
    color = mix(color, vec3(0.92, 0.94, 0.93) * (0.95 + grain * 0.04), snow * 0.72);
    color = mix(color, vec3(0.78, 0.70, 0.52) * (0.93 + grain * 0.08), coast * 0.75);
    return mix(color, clamp(color, 0.0, 1.0), vNearDetail);
  }

  vec3 applyOceanFloor(vec3 color, float height, float slope) {
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5 || uSeaHeight < -1.0) return color;

    float underwater = smoothstep(uSeaHeight + 0.018, uSeaHeight - 0.018, height);
    float shelf = smoothstep(uSeaHeight - 0.18, uSeaHeight + 0.02, height);
    vec3 deepFloor = vec3(0.012, 0.045, 0.070);
    vec3 shallowFloor = vec3(0.045, 0.115, 0.125);
    vec3 oceanFloor = mix(deepFloor, shallowFloor, shelf);
    oceanFloor = mix(oceanFloor, oceanFloor * 0.72, clamp(slope * 1.5, 0.0, 1.0));
    return mix(color, oceanFloor, underwater);
  }

  vec3 detailNormal(vec3 baseNormal, float latitude, float moisture, float slope, float coast) {
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) return baseNormal;

    vec3 sphereDir = normalize(vSphereDir);
    vec3 tangent = normalize(cross(sphereDir, vec3(0.0, 1.0, 0.0)));
    if (length(tangent) < 0.01) {
      tangent = normalize(cross(sphereDir, vec3(1.0, 0.0, 0.0)));
    }
    vec3 bitangent = normalize(cross(sphereDir, tangent));

    float rock = terrainFbm(sphereDir * 95.0 + 41.0, uSeed + 301.0, 3, 2.2, 0.48);
    float grit = vDetail;
    float dune = moisture * 2.0 - 1.0;

    float snow = smoothstep(0.68, 0.88, smoothstep(-1.0, 1.0, vHeight) + latitude * 0.18) * smoothstep(0.48, 0.88, latitude);
    float dry = saturate(1.0 - moisture);
    float strength = 0.025 + vNearDetail * 0.055;
    strength += slope * (0.065 + vNearDetail * 0.05);
    strength += dry * (1.0 - coast) * (0.022 + vNearDetail * 0.03);
    strength *= 1.0 - snow * 0.55;
    strength *= 1.0 - coast * 0.45;

    vec2 detail = vec2(rock + grit * 0.45, dune * dry + grit * 0.25);
    return normalize(baseNormal + tangent * detail.x * strength + bitangent * detail.y * strength);
  }

  void main() {
    float heightNorm = smoothstep(-1.0, 1.0, vHeight);
    float latitude = abs(vSphereDir.y);
    float moisture = saturate(vHeight * 0.75 + 0.5);
    float slope = saturate(1.0 - dot(normalize(vNormal), normalize(vRadialNormal)));
    float coast = smoothstep(uSeaHeight - 0.014, uSeaHeight + 0.014, vHeight) * (1.0 - smoothstep(uSeaHeight + 0.026, uSeaHeight + 0.060, vHeight));

    vec3 terrainColor;
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      float bands = smoothstep(-0.2, 0.8, sin(vSphereDir.y * 34.0) * 0.5 + 0.5);
      float turbulence = 0.45;
      terrainColor = gasBands(latitude, bands, turbulence);
    } else if (uPlanetKind > 1.5) {
      terrainColor = iceBiome(heightNorm, latitude, moisture, slope);
    } else {
      terrainColor = rockyBiome(heightNorm, latitude, moisture, slope);
    }

    terrainColor = applyOceanFloor(terrainColor, vHeight, slope);
    float rockMask = saturate(slope * 0.75 + smoothstep(0.60, 0.72, heightNorm));
    float snowMask = smoothstep(0.74, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude);
    terrainColor = applyTerrainTexture(terrainColor, vSphereDir, uPlanetKind, heightNorm, coast, rockMask, snowMask, moisture, distance(cameraPosition, vWorldPos));
    terrainColor = mix(terrainColor, vec3(0.43, 0.39, 0.32), 0.06);

    vec3 finalNormal = detailNormal(normalize(vNormal), latitude, moisture, slope, coast);
    vec3 finalColor = applyPlanetLighting(terrainColor, finalNormal, vWorldPos, heightNorm, slope);
    finalColor = applyAerialPerspective(finalColor, vWorldPos, finalNormal);
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(finalColor, 1.0);
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    uniforms: {
      uSeed: { value: params.seed },
      uTerrainScale: { value: params.terrainScale },
      uPlanetRadius: { value: params.planetRadius },
      uFrequency: { value: params.frequency },
      uOctaves: { value: params.octaves },
      uPlanetKind: { value: planetKind },
      uLocalDetailNear: { value: params.localDetailNear },
      uLocalDetailFar: { value: params.localDetailFar },
      uSeaHeight: { value: getSeaHeight(params.waterLevel, params.planetType) },
      uColorA: { value: colorA },
      uColorB: { value: colorB },
      uSunPosition: { value: params.sunPosition.clone() },
      uSunColor: { value: sunColor },
      uAtmosphereColor: { value: atmosphereColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uSunTintStrength: { value: params.sunTintStrength },
      uAtmosphereHazeStrength: { value: params.atmosphereHazeStrength },
      uAtmosphereHazeDistance: { value: params.atmosphereHazeDistance },
      uGrassTexture: { value: TERRAIN_TEXTURES.grass },
      uRockTexture: { value: TERRAIN_TEXTURES.rock },
      uSandTexture: { value: TERRAIN_TEXTURES.sand },
      uSnowTexture: { value: TERRAIN_TEXTURES.snow },
      uTextureScale: { value: getPlanetTextureScale(params.textureScale, params.planetRadius) },
      uTextureBlend: { value: params.textureBlend },
      uTextureNearDistance: { value: params.textureNearDistance },
      uTextureFadeDistance: { value: params.textureFadeDistance },
      uTextureDetailScale: { value: params.textureDetailScale },
      uTextureFarScale: { value: params.textureFarScale },
      uTextureFarStrength: { value: params.textureFarStrength },
    },
  })
}

export function createPlanetFarMaterial(params: {
  seed: number
  planetType: string
  waterLevel: number
  terrainScale: number
  colorA: string
  colorB: string
  textureScale: number
  textureBlend: number
  textureNearDistance: number
  textureFadeDistance: number
  textureDetailScale: number
  textureFarScale: number
  textureFarStrength: number
  atmosphereColor: string
  atmosphereHazeStrength: number
  atmosphereHazeDistance: number
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  sunTintStrength: number
  planetRadius: number
  octaves: number
  frequency: number
  lacunarity: number
  gain: number
  warpStrength: number
  continentalScale: number
  mountainScale: number
  erosionStrength: number
  thermalStrength: number
  detailStrength: number
}): THREE.ShaderMaterial {
  const colorA = new THREE.Color(params.colorA)
  const colorB = new THREE.Color(params.colorB)
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const planetKind = params.planetType === 'gas'
    ? PlanetKind.Gas
    : params.planetType === 'ice'
      ? PlanetKind.Ice
      : PlanetKind.Rocky

  const vertexShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uSeed;
  uniform float uTerrainScale;
  uniform float uPlanetRadius;
  uniform float uFrequency;
  uniform float uPlanetKind;
  uniform float uOctaves;
  attribute float terrainHeight;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;
  varying float vMacro;

  float getHeight(vec3 sphereDir) {
    float continental = terrainFbm(sphereDir * uFrequency, uSeed, 4, 2.0, 0.5);
    float ridges = abs(terrainFbm(sphereDir * (uFrequency * 2.6) + 17.0, uSeed + 9.7, 2, 2.0, 0.45));
    ridges = pow(1.0 - ridges, 2.4);
    float mountainMask = smoothstep(0.30, 0.78, continental);

    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      return continental * 0.05;
    }

    return continental * 0.55 + ridges * mountainMask * 0.14;
  }

  void main() {
    vec3 sphereDir = normalize(position);
    vSphereDir = sphereDir;

    float h = terrainHeight;
    vHeight = h;
    vMacro = terrainFbm(sphereDir * (uFrequency * 2.4) + 19.0, uSeed + 31.0, 3, 2.0, 0.5);

    vec4 worldPos = modelMatrix * vec4(position, 1.0);

    vWorldPos = worldPos.xyz;
    vRadialNormal = normalize((modelMatrix * vec4(sphereDir, 0.0)).xyz);
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    if (dot(vNormal, vRadialNormal) < 0.0) vNormal = -vNormal;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <logdepthbuf_pars_fragment>
  ${TERRAIN_HEIGHT_GLSL}
  ${TERRAIN_TEXTURE_GLSL}

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform float uSunTintStrength;
  uniform float uAtmosphereHazeStrength;
  uniform float uAtmosphereHazeDistance;
  uniform float uSeaHeight;
  uniform float uPlanetRadius;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;
  varying float vMacro;

  ${PLANET_LIGHTING_GLSL}
  ${AERIAL_PERSPECTIVE_GLSL}

  float saturate(float v) {
    return clamp(v, 0.0, 1.0);
  }

  vec3 rockyBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 deepRock = mix(uColorA * 0.62, vec3(0.30, 0.27, 0.23), 0.38);
    vec3 lowland = mix(uColorA * 0.82, vec3(0.22, 0.34, 0.20), saturate(moisture * 0.55 + 0.10));
    vec3 dryland = mix(uColorA * 0.78, vec3(0.54, 0.45, 0.31), saturate(1.0 - moisture) * 0.65);
    vec3 highRock = mix(uColorB * 0.82, vec3(0.42, 0.39, 0.35), 0.58);
    vec3 snow = vec3(0.80, 0.83, 0.82);
    vec3 beach = vec3(0.68, 0.60, 0.44);

    vec3 color = mix(deepRock, mix(dryland, lowland, moisture), smoothstep(0.36, 0.50, heightNorm));
    float coast = smoothstep(uSeaHeight - 0.014, uSeaHeight + 0.014, vHeight) * (1.0 - smoothstep(uSeaHeight + 0.026, uSeaHeight + 0.060, vHeight));
    color = mix(color, beach, coast);
    color = mix(color, highRock, smoothstep(0.58, 0.70, heightNorm));
    color = mix(color, snow, smoothstep(0.74, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude));
    color = mix(color, highRock, saturate(slope * 0.95));
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, 0.78);
    return color;
  }

  vec3 iceBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 blueIce = vec3(0.46, 0.68, 0.80);
    vec3 snow = vec3(0.86, 0.91, 0.95);
    vec3 rock = vec3(0.32, 0.36, 0.38);
    vec3 color = mix(blueIce, snow, smoothstep(0.28, 0.8, heightNorm + latitude * 0.25 + moisture * 0.1));
    return mix(color, rock, smoothstep(0.45, 0.95, slope));
  }

  vec3 gasBands(float latitude, float bands, float turbulence) {
    vec3 bandA = mix(uColorA, vec3(0.95, 0.74, 0.48), 0.35);
    vec3 bandB = mix(uColorB, vec3(0.60, 0.34, 0.18), 0.35);
    vec3 storms = vec3(1.0, 0.88, 0.62);
    vec3 color = mix(bandA, bandB, bands);
    color = mix(color, storms, smoothstep(0.62, 0.95, turbulence) * (1.0 - latitude * 0.45));
    return color;
  }

  vec3 applyOceanFloor(vec3 color, float height, float slope) {
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5 || uSeaHeight < -1.0) return color;

    float underwater = smoothstep(uSeaHeight + 0.018, uSeaHeight - 0.018, height);
    float shelf = smoothstep(uSeaHeight - 0.18, uSeaHeight + 0.02, height);
    vec3 deepFloor = vec3(0.012, 0.045, 0.070);
    vec3 shallowFloor = vec3(0.045, 0.115, 0.125);
    vec3 oceanFloor = mix(deepFloor, shallowFloor, shelf);
    oceanFloor = mix(oceanFloor, oceanFloor * 0.72, clamp(slope * 1.5, 0.0, 1.0));
    return mix(color, oceanFloor, underwater);
  }

  void main() {
    float visualHeight = vHeight;
    float heightNorm = smoothstep(-1.0, 1.0, visualHeight);
    float latitude = abs(vSphereDir.y);
    float moisture = saturate(visualHeight * 0.75 + 0.5);
    vec3 shadingNormal = normalize(vNormal);
    float slope = saturate(1.0 - dot(shadingNormal, normalize(vRadialNormal)));
    float coast = smoothstep(uSeaHeight - 0.014, uSeaHeight + 0.014, visualHeight) * (1.0 - smoothstep(uSeaHeight + 0.026, uSeaHeight + 0.060, visualHeight));

    vec3 terrain;
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      float bands = smoothstep(-0.2, 0.8, sin(vSphereDir.y * 34.0) * 0.5 + 0.5);
      terrain = gasBands(latitude, bands, vMacro);
    } else if (uPlanetKind > 1.5) {
      terrain = iceBiome(heightNorm, latitude, moisture, slope);
    } else {
      terrain = rockyBiome(heightNorm, latitude, moisture, slope);
    }

    terrain = applyOceanFloor(terrain, visualHeight, slope);
    float rockMask = saturate(slope * 0.75 + smoothstep(0.60, 0.72, heightNorm));
    float snowMask = smoothstep(0.74, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude);
    terrain = applyTerrainTexture(terrain, vSphereDir, uPlanetKind, heightNorm, coast, rockMask, snowMask, moisture, distance(cameraPosition, vWorldPos));
    terrain = mix(terrain, vec3(0.43, 0.39, 0.32), 0.06);

    vec3 finalColor = applyPlanetLighting(terrain, shadingNormal, vWorldPos, heightNorm, slope);
    finalColor = applyAerialPerspective(finalColor, vWorldPos, shadingNormal);
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(finalColor, 1.0);
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    uniforms: {
      uSeed: { value: params.seed },
      uTerrainScale: { value: params.terrainScale },
      uPlanetRadius: { value: params.planetRadius },
      uFrequency: { value: params.frequency },
      uPlanetKind: { value: planetKind },
      uOctaves: { value: params.octaves },
      uLacunarity: { value: params.lacunarity },
      uGain: { value: params.gain },
      uWarpStrength: { value: params.warpStrength },
      uContinentalScale: { value: params.continentalScale },
      uMountainScale: { value: params.mountainScale },
      uErosionStrength: { value: params.erosionStrength },
      uThermalStrength: { value: params.thermalStrength },
      uDetailStrength: { value: params.detailStrength },
      uSeaHeight: { value: getSeaHeight(params.waterLevel, params.planetType) },
      uColorA: { value: colorA },
      uColorB: { value: colorB },
      uSunPosition: { value: params.sunPosition.clone() },
      uSunColor: { value: sunColor },
      uAtmosphereColor: { value: atmosphereColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uSunTintStrength: { value: params.sunTintStrength },
      uAtmosphereHazeStrength: { value: params.atmosphereHazeStrength },
      uAtmosphereHazeDistance: { value: params.atmosphereHazeDistance },
      uGrassTexture: { value: TERRAIN_TEXTURES.grass },
      uRockTexture: { value: TERRAIN_TEXTURES.rock },
      uSandTexture: { value: TERRAIN_TEXTURES.sand },
      uSnowTexture: { value: TERRAIN_TEXTURES.snow },
      uTextureScale: { value: getPlanetTextureScale(params.textureScale, params.planetRadius) },
      uTextureBlend: { value: params.textureBlend * 0.82 },
      uTextureNearDistance: { value: params.textureNearDistance },
      uTextureFadeDistance: { value: params.textureFadeDistance },
      uTextureDetailScale: { value: params.textureDetailScale },
      uTextureFarScale: { value: params.textureFarScale },
      uTextureFarStrength: { value: params.textureFarStrength },
    },
  })
}

export function createOceanMaterial(params: {
  seed: number
  planetType: string
  waterLevel: number
  planetRadius: number
  octaves: number
  frequency: number
  lacunarity: number
  gain: number
  warpStrength: number
  continentalScale: number
  mountainScale: number
  erosionStrength: number
  thermalStrength: number
  detailStrength: number
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereColor: string
  atmosphereLightColor: THREE.Color | string
  sunTintStrength: number
  atmosphereHazeStrength: number
  atmosphereHazeDistance: number
}): THREE.ShaderMaterial {
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const planetKind = params.planetType === 'gas'
    ? PlanetKind.Gas
    : params.planetType === 'ice'
      ? PlanetKind.Ice
      : PlanetKind.Rocky

  const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uOceanLift;
  attribute float terrainHeight;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vSphereDir;
  varying float vTerrainHeight;

  void main() {
    vSphereDir = normalize(position);
    vTerrainHeight = terrainHeight;
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vec3 liftedPosition = position + vSphereDir * uOceanLift;
    vec4 worldPos = modelMatrix * vec4(liftedPosition, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <logdepthbuf_pars_fragment>

  uniform float uPlanetRadius;
  uniform float uSeaHeight;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform float uSunTintStrength;
  uniform float uAtmosphereHazeStrength;
  uniform float uAtmosphereHazeDistance;
  uniform float uTime;
  uniform float uSeed;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vSphereDir;
  varying float vTerrainHeight;

  ${AERIAL_PERSPECTIVE_GLSL}

  void main() {
    float terrainHeight = vTerrainHeight;
    float belowSea = max(uSeaHeight - terrainHeight, 0.0);
    float waterMask = smoothstep(uSeaHeight + 0.010, uSeaHeight - 0.018, terrainHeight);
    if (waterMask <= 0.025) discard;

    vec3 waterNormal = normalize(vNormal);
    if (!gl_FrontFacing) {
      waterNormal = -waterNormal;
    }
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    vec3 halfDir = normalize(lightDir + viewDir);
    float fresnel = pow(1.0 - max(dot(viewDir, waterNormal), 0.0), 4.0);
    float nDotL = dot(waterNormal, lightDir);
    float day = smoothstep(-0.12, 0.62, nDotL);
    float diffuse = max(nDotL, 0.0);

    float cameraDist = distance(cameraPosition, vWorldPos);
    float farWater = smoothstep(0.65, 2.4, cameraDist / uPlanetRadius);
    float detailFade = 1.0 - farWater;

    vec3 flowA = vec3(uTime * 0.018, 0.0, -uTime * 0.013);
    vec3 flowB = vec3(-uTime * 0.009, uTime * 0.014, uTime * 0.006);
    float swell = terrainFbm(vSphereDir * 11.0 + flowA, uSeed + 101.0, 4, 2.0, 0.52);
    float chop = terrainFbm(vSphereDir * 42.0 + flowB, uSeed + 203.0, 3, 2.2, 0.46) * detailFade;
    float coastFoam = (1.0 - smoothstep(0.16, 0.72, waterMask)) * smoothstep(0.10, 0.48, waterMask);
    float foam = (smoothstep(0.60, 0.88, swell + chop * 0.35) * 0.42 + coastFoam * 0.34) * detailFade;
    float surface = clamp(swell * 0.5 + chop * 0.18 + 0.5, 0.0, 1.0);
    float specular = pow(max(dot(waterNormal, halfDir), 0.0), 96.0) * (0.20 + surface * 0.55) * day;

    float terrainDepthHint = clamp(belowSea / 0.34, 0.0, 1.0);
    float depth = mix(0.34, terrainDepthHint, 0.42);
    vec3 shallow = vec3(0.16, 0.52, 0.60);
    vec3 mid = vec3(0.06, 0.27, 0.38);
    vec3 deep = vec3(0.02, 0.10, 0.20);
    vec3 color = mix(shallow, mid, smoothstep(0.04, 0.38, depth));
    color = mix(color, deep, smoothstep(0.42, 1.0, depth));
    color *= mix(0.18, 1.0, day);
    float tintStrength = clamp(uSunTintStrength, 0.0, 2.0);
    vec3 waterLightColor = mix(uAtmosphereLightColor, uSunColor, 0.22);
    color += diffuse * mix(vec3(0.025, 0.07, 0.075), waterLightColor * vec3(0.040, 0.082, 0.088), tintStrength * 0.82);
    color += surface * vec3(0.015, 0.05, 0.055);
    vec3 reflected = vec3(0.58, 0.76, 0.96) * fresnel * mix(0.18, 0.68, day);
    color = mix(color, vec3(0.82, 0.94, 0.95), foam * 0.28);
    reflected *= mix(vec3(1.0), uAtmosphereLightColor, tintStrength * 0.40);
    color += reflected + specular * mix(vec3(1.0, 0.92, 0.78), waterLightColor, tintStrength * 0.90);
    color = applyAerialPerspective(color, vWorldPos, waterNormal);

    float alpha = mix(0.82, 0.94, smoothstep(0.04, 0.62, depth));
    alpha = mix(alpha, 0.98, farWater);
    alpha += fresnel * 0.06;
    alpha *= smoothstep(0.03, 0.24, waterMask);
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(color, alpha);
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
    uniforms: {
      uSeed: { value: params.seed },
      uPlanetRadius: { value: params.planetRadius },
      uSeaHeight: { value: getSeaHeight(params.waterLevel, params.planetType) },
      uFrequency: { value: params.frequency },
      uOctaves: { value: params.octaves },
      uLacunarity: { value: params.lacunarity },
      uGain: { value: params.gain },
      uWarpStrength: { value: params.warpStrength },
      uContinentalScale: { value: params.continentalScale },
      uMountainScale: { value: params.mountainScale },
      uErosionStrength: { value: params.erosionStrength },
      uThermalStrength: { value: params.thermalStrength },
      uDetailStrength: { value: params.detailStrength },
      uPlanetKind: { value: planetKind },
      uOceanLift: { value: 0 },
      uSunPosition: { value: params.sunPosition.clone() },
      uSunColor: { value: sunColor },
      uAtmosphereColor: { value: atmosphereColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uSunTintStrength: { value: params.sunTintStrength },
      uAtmosphereHazeStrength: { value: params.atmosphereHazeStrength },
      uAtmosphereHazeDistance: { value: params.atmosphereHazeDistance },
      uTime: { value: 0 },
    },
  })
}

export function createPlanetFallbackMaterial(params: {
  seed: number
  planetType: string
  waterLevel: number
  colorA: string
  colorB: string
  textureScale: number
  textureBlend: number
  textureNearDistance: number
  textureFadeDistance: number
  textureDetailScale: number
  textureFarScale: number
  textureFarStrength: number
  atmosphereColor: string
  atmosphereHazeStrength: number
  atmosphereHazeDistance: number
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  sunTintStrength: number
  planetRadius: number
  octaves: number
  frequency: number
  lacunarity: number
  gain: number
  warpStrength: number
  continentalScale: number
  mountainScale: number
  erosionStrength: number
  thermalStrength: number
  detailStrength: number
}): THREE.ShaderMaterial {
  const colorA = new THREE.Color(params.colorA)
  const colorB = new THREE.Color(params.colorB)
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const planetKind = params.planetType === 'gas'
    ? PlanetKind.Gas
    : params.planetType === 'ice'
      ? PlanetKind.Ice
      : PlanetKind.Rocky

  const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute float terrainHeight;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;

  void main() {
    vSphereDir = normalize(position);
    vHeight = terrainHeight;
    vRadialNormal = normalize((modelMatrix * vec4(vSphereDir, 0.0)).xyz);
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    if (dot(vNormal, vRadialNormal) < 0.0) vNormal = -vNormal;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  ${TERRAIN_TEXTURE_GLSL}

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform float uSunTintStrength;
  uniform float uAtmosphereHazeStrength;
  uniform float uAtmosphereHazeDistance;
  uniform float uSeaHeight;
  uniform float uPlanetKind;
  uniform float uPlanetRadius;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;

  ${PLANET_LIGHTING_GLSL}
  ${AERIAL_PERSPECTIVE_GLSL}

  float saturate(float v) {
    return clamp(v, 0.0, 1.0);
  }

  vec3 rockyBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 deepRock = mix(uColorA * 0.62, vec3(0.30, 0.27, 0.23), 0.38);
    vec3 lowland = mix(uColorA * 0.82, vec3(0.22, 0.34, 0.20), saturate(moisture * 0.55 + 0.10));
    vec3 dryland = mix(uColorA * 0.78, vec3(0.54, 0.45, 0.31), saturate(1.0 - moisture) * 0.65);
    vec3 highRock = mix(uColorB * 0.82, vec3(0.42, 0.39, 0.35), 0.58);
    vec3 snow = vec3(0.80, 0.83, 0.82);
    vec3 beach = vec3(0.68, 0.60, 0.44);

    vec3 color = mix(deepRock, mix(dryland, lowland, moisture), smoothstep(0.36, 0.50, heightNorm));
    float coast = smoothstep(uSeaHeight - 0.014, uSeaHeight + 0.014, vHeight) * (1.0 - smoothstep(uSeaHeight + 0.026, uSeaHeight + 0.060, vHeight));
    color = mix(color, beach, coast);
    color = mix(color, highRock, smoothstep(0.58, 0.70, heightNorm));
    color = mix(color, snow, smoothstep(0.74, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude));
    color = mix(color, highRock, saturate(slope * 0.95));
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luma), color, 0.78);
    return color;
  }

  vec3 iceBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 blueIce = vec3(0.46, 0.68, 0.80);
    vec3 snow = vec3(0.86, 0.91, 0.95);
    vec3 rock = vec3(0.32, 0.36, 0.38);
    vec3 color = mix(blueIce, snow, smoothstep(0.28, 0.8, heightNorm + latitude * 0.25 + moisture * 0.1));
    return mix(color, rock, smoothstep(0.45, 0.95, slope));
  }

  vec3 gasBands(float latitude, float bands, float turbulence) {
    vec3 bandA = mix(uColorA, vec3(0.95, 0.74, 0.48), 0.35);
    vec3 bandB = mix(uColorB, vec3(0.60, 0.34, 0.18), 0.35);
    vec3 storms = vec3(1.0, 0.88, 0.62);
    vec3 color = mix(bandA, bandB, bands);
    color = mix(color, storms, smoothstep(0.62, 0.95, turbulence) * (1.0 - latitude * 0.45));
    return color;
  }

  vec3 applyOceanFloor(vec3 color, float height, float slope) {
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5 || uSeaHeight < -1.0) return color;

    float underwater = smoothstep(uSeaHeight + 0.018, uSeaHeight - 0.018, height);
    float shelf = smoothstep(uSeaHeight - 0.18, uSeaHeight + 0.02, height);
    vec3 deepFloor = vec3(0.012, 0.045, 0.070);
    vec3 shallowFloor = vec3(0.045, 0.115, 0.125);
    vec3 oceanFloor = mix(deepFloor, shallowFloor, shelf);
    oceanFloor = mix(oceanFloor, oceanFloor * 0.72, clamp(slope * 1.5, 0.0, 1.0));
    return mix(color, oceanFloor, underwater);
  }

  void main() {
    float visualHeight = vHeight;
    float heightNorm = smoothstep(-1.0, 1.0, visualHeight);
    float latitude = abs(vSphereDir.y);
    float moisture = saturate(visualHeight * 0.75 + 0.5);
    vec3 shadingNormal = normalize(vNormal);
    float slope = saturate(1.0 - dot(shadingNormal, normalize(vRadialNormal)));
    float coast = smoothstep(uSeaHeight - 0.014, uSeaHeight + 0.014, visualHeight) * (1.0 - smoothstep(uSeaHeight + 0.026, uSeaHeight + 0.060, visualHeight));

    vec3 terrain;
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      float bands = smoothstep(-0.2, 0.8, sin(vSphereDir.y * 34.0) * 0.5 + 0.5);
      terrain = gasBands(latitude, bands, 0.45);
    } else if (uPlanetKind > 1.5) {
      terrain = iceBiome(heightNorm, latitude, moisture, slope);
    } else {
      terrain = rockyBiome(heightNorm, latitude, moisture, slope);
    }

    terrain = applyOceanFloor(terrain, visualHeight, slope);
    float rockMask = saturate(slope * 0.75 + smoothstep(0.60, 0.72, heightNorm));
    float snowMask = smoothstep(0.74, 0.84, heightNorm + latitude * 0.18) * smoothstep(0.54, 0.78, latitude);
    terrain = applyTerrainTexture(terrain, vSphereDir, uPlanetKind, heightNorm, coast, rockMask, snowMask, moisture, distance(cameraPosition, vWorldPos));
    terrain = mix(terrain, vec3(0.43, 0.39, 0.32), 0.06);

    vec3 finalColor = applyPlanetLighting(terrain, shadingNormal, vWorldPos, heightNorm, slope);
    finalColor = applyAerialPerspective(finalColor, vWorldPos, shadingNormal);
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(finalColor, 1.0);
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
    uniforms: {
      uSeed: { value: params.seed },
      uFrequency: { value: params.frequency },
      uOctaves: { value: params.octaves },
      uLacunarity: { value: params.lacunarity },
      uGain: { value: params.gain },
      uWarpStrength: { value: params.warpStrength },
      uContinentalScale: { value: params.continentalScale },
      uMountainScale: { value: params.mountainScale },
      uErosionStrength: { value: params.erosionStrength },
      uThermalStrength: { value: params.thermalStrength },
      uDetailStrength: { value: params.detailStrength },
      uPlanetRadius: { value: params.planetRadius },
      uSeaHeight: { value: getSeaHeight(params.waterLevel, params.planetType) },
      uPlanetKind: { value: planetKind },
      uColorA: { value: colorA },
      uColorB: { value: colorB },
      uSunPosition: { value: params.sunPosition.clone() },
      uSunColor: { value: sunColor },
      uAtmosphereColor: { value: atmosphereColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uSunTintStrength: { value: params.sunTintStrength },
      uAtmosphereHazeStrength: { value: params.atmosphereHazeStrength },
      uAtmosphereHazeDistance: { value: params.atmosphereHazeDistance },
      uGrassTexture: { value: TERRAIN_TEXTURES.grass },
      uRockTexture: { value: TERRAIN_TEXTURES.rock },
      uSandTexture: { value: TERRAIN_TEXTURES.sand },
      uSnowTexture: { value: TERRAIN_TEXTURES.snow },
      uTextureScale: { value: getPlanetTextureScale(params.textureScale, params.planetRadius, 0.55) },
      uTextureBlend: { value: params.textureBlend },
      uTextureNearDistance: { value: 0 },
      uTextureFadeDistance: { value: 1 },
      uTextureDetailScale: { value: params.textureDetailScale },
      uTextureFarScale: { value: params.textureFarScale },
      uTextureFarStrength: { value: params.textureFarStrength },
    },
  })
}

export function createAtmosphereMaterial(params: {
  atmosphereColor: string
  density: number
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  sunTintStrength: number
  horizonGlow: number
  sunGlare: number
  sunGlareSize: number
  sunPosition: THREE.Vector3
  planetRadius: number
  atmosphereRadius: number
}): THREE.ShaderMaterial {
  const color = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)

  const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uAtmosphereColor;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereLightColor;
  uniform vec3 uSunPosition;
  uniform vec3 uPlanetCenter;
  uniform float uDensity;
  uniform float uSunTintStrength;
  uniform float uHorizonGlowStrength;
  uniform float uSunGlareStrength;
  uniform float uSunGlareSize;
  uniform float uPlanetRadius;
  uniform float uAtmosphereRadius;

  varying vec3 vWorldPos;
  varying vec3 vNormal;

  float atmosphereLuminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec3 shellNormal = normalize(vWorldPos - uPlanetCenter);
    vec3 sunDir = normalize(uSunPosition - uPlanetCenter);
    vec3 cameraFromCenter = cameraPosition - uPlanetCenter;
    float cameraRadius = length(cameraFromCenter);
    vec3 localUp = cameraRadius > 0.0001 ? cameraFromCenter / cameraRadius : shellNormal;
    float inside = 1.0 - smoothstep(uAtmosphereRadius * 0.995, uAtmosphereRadius * 1.01, cameraRadius);

    vec3 toCamera = normalize(cameraPosition - vWorldPos);
    float nDotV = max(dot(toCamera, shellNormal), 0.0);
    float rim = pow(1.0 - nDotV, 2.55);
    float outerFade = smoothstep(0.03, 0.78, rim) * (1.0 - smoothstep(0.90, 1.0, rim) * 0.22);
    float nDotL = dot(shellNormal, sunDir);
    float outsideDay = smoothstep(-0.30, 0.55, nDotL);
    float forwardScatter = pow(max(dot(toCamera, sunDir), 0.0), 7.0);
    float tintStrength = clamp(uSunTintStrength, 0.0, 2.0);
    float horizonGlowStrength = clamp(uHorizonGlowStrength, 0.0, 2.0);
    float sunGlareStrength = clamp(uSunGlareStrength, 0.0, 2.0);
    float sunGlareSize = clamp(uSunGlareSize, 0.1, 2.0);
    vec3 scatterColor = mix(uAtmosphereColor, uAtmosphereLightColor, clamp(0.50 + tintStrength * 0.22, 0.0, 0.92));
    vec3 sunScatterColor = mix(uAtmosphereLightColor, uSunColor, 0.28);
    float terminatorGlow = smoothstep(-0.45, 0.14, nDotL) * (1.0 - smoothstep(0.22, 0.82, nDotL));
    float outsideHorizonGlow = outerFade * (0.22 + outsideDay * 0.50 + terminatorGlow * 0.72) * horizonGlowStrength;
    float outsideGlarePower = mix(34.0, 5.0, smoothstep(0.1, 2.0, sunGlareSize));
    float outsideSunGlare = pow(max(dot(toCamera, sunDir), 0.0), outsideGlarePower)
      * smoothstep(-0.22, 0.46, nDotL)
      * sunGlareStrength;
    vec3 outsideColor = uAtmosphereColor * (0.14 + outsideDay * 0.88)
      + scatterColor * outsideDay * 0.20
      + scatterColor * outsideHorizonGlow * (0.20 + tintStrength * 0.08)
      + sunScatterColor * (forwardScatter * (0.22 + outsideDay * 0.24) + outsideSunGlare * 0.58) * (0.72 + tintStrength * 0.55);
    float outsideAlpha = outerFade * uDensity * (0.11 + outsideDay * 0.31 + forwardScatter * (0.15 + tintStrength * 0.07));
    outsideAlpha += uDensity * (outsideHorizonGlow * 0.16 + outsideSunGlare * 0.24);

    vec3 skyDir = normalize(vWorldPos - cameraPosition);
    float skyUp = dot(skyDir, localUp);
    float horizon = pow(1.0 - clamp(skyUp, 0.0, 1.0), 1.45);
    float sunHeight = dot(sunDir, localUp);
    float sunView = max(dot(skyDir, sunDir), 0.0);
    float day = smoothstep(-0.08, 0.28, sunHeight);
    float twilight = smoothstep(-0.34, 0.10, sunHeight) * (1.0 - smoothstep(0.08, 0.48, sunHeight));
    float night = 1.0 - smoothstep(-0.22, 0.05, sunHeight);
    float sunGlowPower = mix(28.0, 5.5, smoothstep(0.1, 2.0, sunGlareSize));
    float sunGlow = pow(sunView, sunGlowPower) * smoothstep(-0.10, 0.35, sunHeight) * sunGlareStrength;
    float sunsetForward = pow(sunView, 5.0) * twilight;

    float atmosphereLum = clamp(atmosphereLuminance(uAtmosphereColor), 0.08, 1.0);
    vec3 zenithColor = mix(uAtmosphereColor * 0.42, uAtmosphereColor * 1.18, day);
    vec3 horizonColor = mix(uAtmosphereColor * 0.70, scatterColor * (0.72 + atmosphereLum * 0.35), (0.38 + twilight * 0.52) * (0.72 + tintStrength * 0.36));
    float localHorizonGlow = horizon * (0.26 + day * 0.20 + twilight * 0.42) * horizonGlowStrength;
    vec3 dayColor = mix(zenithColor, horizonColor, clamp(horizon * (0.44 + twilight * 0.26) + localHorizonGlow * 0.28, 0.0, 1.0));
    vec3 sunsetColor = mix(mix(vec3(1.0, 0.33, 0.08), uSunColor, 0.42), scatterColor, 0.38) * mix(vec3(1.0), uAtmosphereColor, 0.18);
    vec3 nightColor = uAtmosphereColor * 0.035 + vec3(0.003, 0.007, 0.020);
    vec3 insideColor = mix(dayColor, sunsetColor, clamp((horizon * 0.72 + sunsetForward) * twilight, 0.0, 1.0));
    insideColor = mix(insideColor, nightColor, night * 0.92);
    insideColor += horizonColor * localHorizonGlow * (0.12 + twilight * 0.18);
    insideColor += sunScatterColor * sunGlow * (0.30 + day * 0.44) * (0.75 + tintStrength * 0.50);
    float insideAlpha = uDensity * (0.28 + day * 0.72 + horizon * 0.20 + twilight * horizon * 0.25 + localHorizonGlow * 0.16 + sunGlow * 0.10);
    insideAlpha = mix(insideAlpha, uDensity * (0.018 + horizon * 0.040), night);

    vec3 color = mix(outsideColor, insideColor, inside);
    float alpha = mix(outsideAlpha, insideAlpha, inside);
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.86));
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uAtmosphereColor: { value: color },
      uSunColor: { value: sunColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uSunPosition: { value: params.sunPosition.clone() },
      uPlanetCenter: { value: new THREE.Vector3() },
      uDensity: { value: params.density },
      uSunTintStrength: { value: params.sunTintStrength },
      uHorizonGlowStrength: { value: params.horizonGlow },
      uSunGlareStrength: { value: params.sunGlare },
      uSunGlareSize: { value: params.sunGlareSize },
      uPlanetRadius: { value: params.planetRadius },
      uAtmosphereRadius: { value: params.atmosphereRadius },
    },
  })
}

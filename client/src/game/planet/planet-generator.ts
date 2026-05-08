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
  plainsScale: number
  hillsScale: number
  mountainBeltScale: number
  reliefVariety: number
  erosionStrength: number
  thermalStrength: number
  detailStrength: number
  microDetailStrength: number
  microDetailScale: number
  microReliefMeters: number
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
          plainsScale: 0,
          hillsScale: 0,
          mountainBeltScale: 0,
          reliefVariety: 0,
          erosionStrength: 0,
          thermalStrength: 0,
          detailStrength: 0.25,
          microDetailStrength: 0,
          microDetailScale: 1,
          microReliefMeters: 0,
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
          plainsScale: 0.72,
          hillsScale: 0.30,
          mountainBeltScale: 0.45,
          reliefVariety: 0.55,
          erosionStrength: 0.16,
          thermalStrength: 0.48,
          detailStrength: 0.36,
          microDetailStrength: 0.48,
          microDetailScale: 1.15,
          microReliefMeters: 1.35,
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
          plainsScale: 0.55,
          hillsScale: 0.45,
          mountainBeltScale: 0.75,
          reliefVariety: 0.7,
          erosionStrength: 0.34,
          thermalStrength: 0.2,
          detailStrength: 0.55,
          microDetailStrength: 0.5,
          microDetailScale: 2.5,
          microReliefMeters: 1.5,
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
uniform float uSurfaceLightingBlend;
uniform float uTerrainAoStrength;

float terrainReliefOcclusion(float heightNorm, float slope) {
  if (uPlanetKind > 0.5 && uPlanetKind < 1.5) return 1.0;

  float rugged = smoothstep(0.06, 0.48, slope);
  float lowPocket = 1.0 - smoothstep(0.34, 0.58, heightNorm);
  float highCrisp = smoothstep(0.58, 0.86, heightNorm) * rugged;
  return clamp(1.0 - rugged * 0.13 - lowPocket * 0.04 + highCrisp * 0.025, 0.78, 1.03);
}

float terrainBakedAmbientOcclusion(float bakedAo, float amount, float nearFloor, float farFloor) {
  if (uPlanetKind > 0.5 && uPlanetKind < 1.5) return 1.0;

  float strength = clamp(uTerrainAoStrength, 0.0, 2.0);
  if (strength <= 0.001) return 1.0;

  float cavity = 1.0 - clamp(bakedAo, 0.0, 1.0);
  float floorValue = min(nearFloor, farFloor);
  return clamp(1.0 - cavity * strength * amount, floorValue, 1.0);
}

vec3 applyTerrainMacroAoToColor(vec3 color, float bakedMacroAo, float amount) {
  return color * terrainBakedAmbientOcclusion(bakedMacroAo, amount, 0.48, 0.72);
}

vec3 applyTerrainMicroAoToColor(vec3 color, float bakedMicroAo, float amount) {
  return color * terrainBakedAmbientOcclusion(bakedMicroAo, amount, 0.68, 0.86);
}

vec3 applyPlanetLighting(vec3 albedo, vec3 normal, vec3 radialNormal, vec3 worldPos, float heightNorm, float slope) {
  vec3 n = normalize(normal);
  vec3 r = normalize(radialNormal);
  vec3 lightDir = normalize(uSunPosition - worldPos);
  vec3 viewDir = normalize(cameraPosition - worldPos);
  float nDotL = dot(n, lightDir);
  float day = smoothstep(-0.18, 0.62, nDotL);
  float direct = max(nDotL, 0.0);
  float surfaceBlend = clamp(uSurfaceLightingBlend, 0.0, 1.0);
  if (uPlanetKind > 0.5 && uPlanetKind < 1.5) surfaceBlend = 0.0;
  float reliefOcclusion = terrainReliefOcclusion(heightNorm, slope);
  float softDirect = direct * 0.78 + direct * direct * 0.24;
  softDirect *= mix(0.82, 1.0, reliefOcclusion);
  float ambient = mix(0.055, 0.22, day) * reliefOcclusion;
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.3) * smoothstep(-0.05, 0.50, nDotL);
  float highland = smoothstep(0.60, 0.90, heightNorm) * 0.055;
  float cavity = 1.0 - slope * mix(0.12, 0.05, day);
  const float atmosphereLightInfluence = 0.85;
  float extinctionStrength = clamp(uAtmosphereExtinctionStrength, 0.0, 2.0);
  float lowSun = pow(1.0 - clamp(nDotL * 0.92 + 0.08, 0.0, 1.0), 1.8)
    * smoothstep(-0.24, 0.50, nDotL);
  float terminator = smoothstep(-0.34, 0.18, nDotL) * (1.0 - smoothstep(0.22, 0.72, nDotL));
  vec3 nightTint = vec3(0.010, 0.016, 0.032);
  nightTint = mix(nightTint, nightTint + uAtmosphereLightColor * 0.055, atmosphereLightInfluence * 0.24);
  vec3 sunsetTint = mix(vec3(1.0, 0.34, 0.10), uSunColor, 0.36);
  sunsetTint = mix(sunsetTint, uAtmosphereLightColor, 0.18);
  vec3 sunTint = mix(vec3(1.0), uAtmosphereLightColor, atmosphereLightInfluence * 0.82);
  sunTint = mix(sunTint, sunsetTint, lowSun * extinctionStrength * 0.72);
  vec3 ambientTint = mix(vec3(1.0), uAtmosphereLightColor, atmosphereLightInfluence * 0.24 + terminator * extinctionStrength * 0.12);
  vec3 twilightFill = mix(uTwilightColor * 0.28, uAtmosphereLightColor * 0.24, atmosphereLightInfluence * 0.22);
  float directTransmission = mix(1.0, 0.58, lowSun * extinctionStrength);
  vec3 lit = albedo * ambientTint * (ambient + highland) * cavity
    + albedo * sunTint * softDirect * directTransmission * 0.92 * cavity;
  lit += albedo * twilightFill * terminator * extinctionStrength * 0.10 * reliefOcclusion;
  vec3 nightLit = albedo * nightTint * 0.18;
  lit = mix(nightLit, lit, day);
  lit += mix(vec3(0.32, 0.48, 0.68), uAtmosphereLightColor, atmosphereLightInfluence * 0.55) * rim * 0.16;

  float skyVisibility = clamp(dot(n, r) * 0.54 + 0.46, 0.18, 1.0);
  float wrappedDay = smoothstep(-0.42, 0.58, nDotL);
  float surfaceDirect = direct * 0.70 + wrappedDay * 0.22 + direct * direct * 0.18;
  float microCavity = smoothstep(0.035, 0.32, slope) * (1.0 - smoothstep(0.80, 1.0, heightNorm));
  float lowAngleRelief = 1.0 - smoothstep(0.16, 0.72, nDotL);
  float directionalReliefShadow = clamp(1.0 - microCavity * lowAngleRelief * surfaceBlend * 0.34, 0.66, 1.0);
  float cavityOcclusion = clamp(1.0 - microCavity * (0.24 + lowAngleRelief * surfaceBlend * 0.10), 0.68, 1.0);
  vec3 skyTint = mix(vec3(0.36, 0.48, 0.62), uAtmosphereLightColor, 0.58 + atmosphereLightInfluence * 0.14);
  vec3 groundBounceTint = mix(vec3(0.30, 0.27, 0.22), albedo, 0.22);
  vec3 surfaceAmbient = albedo * (
    skyTint * (0.18 + day * 0.18) * skyVisibility +
    groundBounceTint * (0.035 + day * 0.075) * (1.0 - microCavity * 0.35)
  );
  vec3 surfaceLit = surfaceAmbient * cavityOcclusion
    + albedo * sunTint * surfaceDirect * directTransmission * (0.78 + day * 0.16) * cavityOcclusion * directionalReliefShadow;
  surfaceLit += albedo * twilightFill * terminator * extinctionStrength * 0.16;
  surfaceLit = mix(nightLit, surfaceLit, smoothstep(-0.28, 0.52, nDotL));
  surfaceLit += mix(vec3(0.22, 0.34, 0.48), uAtmosphereLightColor, atmosphereLightInfluence * 0.46) * rim * 0.10;

  lit = mix(lit, surfaceLit, surfaceBlend);
  return lit;
}
`

const TERRAIN_GRASS_AO_GLSL = /* glsl */ `
uniform float uGrassGroundAoStrength;

float terrainGrassGroundMask(float grassPatch, float heightNorm, float moisture, float slope, float coast, float rockMask, float snowMask) {
  if (uPlanetKind > 0.5) return 0.0;

  float aboveSeaMask = smoothstep(uSeaHeight + 0.018, uSeaHeight + 0.075, vHeight);
  float slopeDot = clamp(1.0 - slope, 0.0, 1.0);
  float slopeMask = smoothstep(0.62, 0.88, slopeDot);
  float grassBiomeMask = smoothstep(0.34, 0.62, moisture)
    * (1.0 - coast)
    * (1.0 - clamp(rockMask, 0.0, 1.0))
    * (1.0 - clamp(snowMask, 0.0, 1.0))
    * (1.0 - smoothstep(0.58, 0.70, heightNorm));

  return clamp(grassPatch, 0.0, 1.0) * aboveSeaMask * slopeMask * grassBiomeMask;
}

vec3 applyGrassGroundAo(vec3 color, float grassPatch, float heightNorm, float moisture, float slope, float coast, float rockMask, float snowMask) {
  float mask = terrainGrassGroundMask(grassPatch, heightNorm, moisture, slope, coast, rockMask, snowMask);
  float amount = clamp(mask * uGrassGroundAoStrength, 0.0, 0.48);
  vec3 occluded = color * vec3(0.58, 0.62, 0.52);
  return mix(color, occluded, amount);
}
`

export const CLOUD_PATTERN_GLSL = /* glsl */ `
uniform float uCloudCoverage;
uniform float uCloudScale;
uniform float uCloudSoftness;
uniform float uCloudHeight;
uniform float uCloudSpeed;
uniform float uCloudShadowStrength;
uniform float uCloudVolumeStrength;
uniform float uCloudStormStrength;
uniform float uCloudBandStrength;
uniform float uCloudDetailStrength;
uniform float uCloudQuality;
uniform float uCloudSeed;
uniform float uTime;
uniform sampler2D uCloudMask;
uniform float uCloudMaskOffset;

vec3 cloudCurvedDirection(vec3 dir) {
  vec3 n = normalize(dir);
  vec3 axis = normalize(vec3(0.18, 0.96, 0.09));
  vec3 tangent = cross(axis, n);
  if (dot(tangent, tangent) < 0.0001) tangent = cross(vec3(1.0, 0.0, 0.0), n);
  tangent = normalize(tangent);
  vec3 bitangent = normalize(cross(n, tangent));
  float speed = max(uCloudSpeed, 0.0);
  float phase = uCloudSeed * 0.017;
  float curlA = sin(dot(n, vec3(2.13, 0.71, -1.42)) * uCloudScale * 1.08 + uTime * speed * 0.24 + phase);
  float curlB = sin(dot(n, vec3(-1.17, 1.86, 2.37)) * uCloudScale * 1.54 - uTime * speed * 0.18 + phase * 1.7);
  float bandStrength = clamp(uCloudBandStrength, 0.0, 1.5);
  return normalize(n + tangent * curlA * 0.15 * bandStrength + bitangent * curlB * 0.09 * bandStrength);
}

float cloudField(vec3 dir) {
  float speed = max(uCloudSpeed, 0.0);
  vec3 wind = vec3(uTime * speed * 0.18, uTime * speed * 0.055, -uTime * speed * 0.12);
  vec3 curved = cloudCurvedDirection(dir);
  vec3 p = curved * max(uCloudScale, 0.001);
  float stormStrength = clamp(uCloudStormStrength, 0.0, 1.5);
  float bandStrength = clamp(uCloudBandStrength, 0.0, 1.5);
  float detailStrength = clamp(uCloudDetailStrength, 0.0, 1.5);

  float macroRaw = terrainFbm(p * 0.42 + wind * 0.55 + vec3(31.0, -18.0, 7.0), uCloudSeed + 301.7, 3, 2.0, 0.54) * 0.5 + 0.5;
  float broad = terrainFbm(p * 0.82 + wind + vec3(13.1, -7.2, 4.8), uCloudSeed + 503.7, 3, 2.05, 0.52) * 0.5 + 0.5;
  float medium = terrainFbm(p * 1.86 + wind * 1.55 + vec3(-5.4, 17.6, 9.2), uCloudSeed + 907.2, 2, 2.18, 0.48) * 0.5 + 0.5;
  float fine = terrainFbm(p * 6.20 - wind * 2.30 + vec3(28.0, 3.7, -11.5), uCloudSeed + 1301.4, 2, 2.24, 0.44) * 0.5 + 0.5;

  float frontNoise = terrainFbm(vec3(p.x * 0.36 + p.z * 0.18, p.y * 2.20 + macroRaw * 1.20, p.z * 0.42) + wind * 0.72, uCloudSeed + 1709.1, 2, 2.0, 0.55);
  float fronts = pow(1.0 - clamp(abs(frontNoise), 0.0, 1.0), 2.85);
  float stormCells = pow(smoothstep(0.50, 0.92, macroRaw + medium * 0.18), 1.85);
  float brokenWisps = smoothstep(0.44, 0.84, fine + fronts * 0.24) * (1.0 - stormCells * 0.36);

  float systems = broad * 0.34 + medium * 0.18;
  systems += stormCells * (0.26 * stormStrength);
  systems += fronts * (0.22 * bandStrength);
  systems += brokenWisps * (0.14 * detailStrength);
  return clamp(systems, 0.0, 1.25);
}

float cloudFieldMedium(vec3 dir) {
  float speed = max(uCloudSpeed, 0.0);
  vec3 wind = vec3(uTime * speed * 0.18, uTime * speed * 0.055, -uTime * speed * 0.12);
  vec3 curved = cloudCurvedDirection(dir);
  vec3 p = curved * max(uCloudScale, 0.001);
  float stormStrength = clamp(uCloudStormStrength, 0.0, 1.5);
  float bandStrength = clamp(uCloudBandStrength, 0.0, 1.5);
  float macroRaw = terrainFbm(p * 0.42 + wind * 0.55 + vec3(31.0, -18.0, 7.0), uCloudSeed + 301.7, 2, 2.0, 0.54) * 0.5 + 0.5;
  float broad = terrainFbm(p * 0.82 + wind + vec3(13.1, -7.2, 4.8), uCloudSeed + 503.7, 2, 2.05, 0.52) * 0.5 + 0.5;
  float medium = terrainFbm(p * 1.86 + wind * 1.55 + vec3(-5.4, 17.6, 9.2), uCloudSeed + 907.2, 1, 2.18, 0.48) * 0.5 + 0.5;
  float frontNoise = terrainFbm(vec3(p.x * 0.36 + p.z * 0.18, p.y * 2.20 + macroRaw * 1.20, p.z * 0.42) + wind * 0.72, uCloudSeed + 1709.1, 1, 2.0, 0.55);
  float fronts = pow(1.0 - clamp(abs(frontNoise), 0.0, 1.0), 2.65);
  float stormCells = pow(smoothstep(0.50, 0.92, macroRaw + medium * 0.18), 1.70);
  float systems = broad * 0.38 + medium * 0.18;
  systems += stormCells * (0.25 * stormStrength);
  systems += fronts * (0.20 * bandStrength);
  return clamp(systems, 0.0, 1.18);
}

float cloudFieldLow(vec3 dir) {
  float speed = max(uCloudSpeed, 0.0);
  vec3 wind = vec3(uTime * speed * 0.16, uTime * speed * 0.05, -uTime * speed * 0.10);
  vec3 p = normalize(dir) * max(uCloudScale, 0.001);
  float stormStrength = clamp(uCloudStormStrength, 0.0, 1.5);
  float bandStrength = clamp(uCloudBandStrength, 0.0, 1.5);
  float broad = terrainFbm(p * 0.72 + wind + vec3(13.1, -7.2, 4.8), uCloudSeed + 503.7, 1, 2.0, 0.52) * 0.5 + 0.5;
  float medium = terrainFbm(p * 1.42 + wind * 1.25 + vec3(-5.4, 17.6, 9.2), uCloudSeed + 907.2, 1, 2.0, 0.50) * 0.5 + 0.5;
  float frontNoise = terrainFbm(vec3(p.x * 0.32 + p.z * 0.18, p.y * 1.65, p.z * 0.38) + wind * 0.50, uCloudSeed + 1709.1, 1, 2.0, 0.55);
  float fronts = pow(1.0 - clamp(abs(frontNoise), 0.0, 1.0), 2.20) * bandStrength;
  float systems = smoothstep(0.52, 0.90, broad + medium * 0.16) * stormStrength;
  return clamp(broad * 0.56 + medium * 0.24 + fronts * 0.13 + systems * 0.14, 0.0, 1.12);
}

float cloudFieldLod(vec3 dir) {
  if (uCloudQuality < 0.5) return cloudFieldLow(dir);
  if (uCloudQuality < 1.5) return cloudFieldMedium(dir);
  return cloudField(dir);
}

vec2 cloudMaskUv(vec3 dir) {
  vec3 n = normalize(dir);
  float lon = atan(n.x, n.z);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  return vec2(fract(lon / 6.28318530718 + 0.5 + uCloudMaskOffset), clamp(0.5 - lat / 3.14159265359, 0.0, 1.0));
}

float sharedCloudMask(vec3 dir) {
  return texture2D(uCloudMask, cloudMaskUv(dir)).r;
}

float cloudMaskFromDensity(float density) {
  float coverage = clamp(uCloudCoverage, 0.0, 1.0);
  float threshold = mix(0.78, 0.24, coverage);
  float softness = max(uCloudSoftness, 0.015);
  float cloud = smoothstep(threshold, threshold + softness, density);
  float body = smoothstep(threshold + softness * 0.32, threshold + softness * 1.85, density);
  return clamp(cloud * mix(0.82, 1.10, body), 0.0, 1.0);
}

float cloudBodyFromDensity(float density) {
  float coverage = clamp(uCloudCoverage, 0.0, 1.0);
  float threshold = mix(0.78, 0.24, coverage);
  float softness = max(uCloudSoftness, 0.015);
  return smoothstep(threshold + softness * 0.34, threshold + softness * 1.95, density);
}

float cloudEdgeFromMaskBody(float mask, float body) {
  return clamp(mask - body * 0.72, 0.0, 1.0);
}

float cloudMask(vec3 dir) {
  return cloudMaskFromDensity(cloudField(dir));
}

float cloudBody(vec3 dir) {
  return cloudBodyFromDensity(cloudField(dir));
}

float cloudEdge(vec3 dir) {
  float mask = cloudMask(dir);
  float body = cloudBody(dir);
  return cloudEdgeFromMaskBody(mask, body);
}

float cloudShadowField(vec3 dir) {
  if (uCloudQuality < 0.5) return cloudFieldLow(dir);
  return cloudFieldMedium(dir);
}

float cloudShadowPattern(vec3 dir) {
  float macroMask = sharedCloudMask(dir);
  float procedural = cloudShadowField(dir);
  float detail = cloudMaskFromDensity(procedural);
  return clamp(macroMask * 0.82 + detail * macroMask * 0.28, 0.0, 1.0);
}

float cloudShadowMask(vec3 surfaceDir, vec3 sunDir) {
  if (uCloudShadowStrength <= 0.001) return 0.0;
  float daylight = smoothstep(-0.08, 0.62, dot(surfaceDir, sunDir));
  float offset = clamp(uCloudHeight, 0.0, 0.20) * 2.8 + 0.018;
  vec3 projectedDir = normalize(surfaceDir + sunDir * offset);
  float shadow = pow(cloudShadowPattern(projectedDir), 0.58);
  float strength = clamp(uCloudShadowStrength * 0.42, 0.0, 2.2);
  return shadow * daylight * strength;
}

vec3 applyCloudShadow(vec3 color, vec3 surfaceDir, vec3 sunDir, float strengthMultiplier) {
  float shadow = cloudShadowMask(surfaceDir, sunDir) * strengthMultiplier;
  vec3 coolShadow = color * vec3(0.11, 0.14, 0.19);
  return mix(color, coolShadow, clamp(shadow, 0.0, 0.96));
}
`

const TERRAIN_CLOUD_SHADOW_GLSL = /* glsl */ `
vec3 applyTerrainCloudShadow(vec3 color, vec3 surfaceDir, float strengthMultiplier) {
  if (uPlanetKind > 0.5 && uPlanetKind < 1.5) return color;
  vec3 sunDir = normalize(uSunPosition - vWorldPos);
  return applyCloudShadow(color, normalize(surfaceDir), sunDir, strengthMultiplier);
}
`

// Terrain chunks are displaced on the CPU so physics, wireframe, and rendering share one surface.
export function createPlanetMaterial(params: {
  seed: number
  cloudMask: THREE.Texture
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
  terrainAoStrength: number
  atmosphereColor: string
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  twilightColor: THREE.Color | string
  atmosphereExtinctionStrength: number
  cloudCoverage: number
  cloudScale: number
  cloudSoftness: number
  cloudHeight: number
  cloudSpeed: number
  cloudShadow: number
  cloudVolume: number
  cloudStorms: number
  cloudBands: number
  cloudDetail: number
  planetRadius: number
  octaves: number
  frequency: number
}): THREE.ShaderMaterial {
  const colorA = new THREE.Color(params.colorA)
  const colorB = new THREE.Color(params.colorB)
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const twilightColor = new THREE.Color(params.twilightColor)
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
  attribute float terrainMicroAo;
  attribute float terrainMacroAo;
  attribute float terrainGrassPatch;

  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;
  varying float vDetail;
  varying float vNearDetail;
  varying float vMicroAo;
  varying float vMacroAo;
  varying float vGrassPatch;

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
    vMicroAo = terrainMicroAo;
    vMacroAo = terrainMacroAo;
    vGrassPatch = terrainGrassPatch;
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
  ${CLOUD_PATTERN_GLSL}

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform vec3 uTwilightColor;
  uniform float uAtmosphereExtinctionStrength;
  uniform float uSeed;
  uniform float uFrequency;
  uniform float uPlanetKind;
  uniform float uPlanetRadius;
  uniform float uLocalDetailNear;
  uniform float uLocalDetailFar;
  uniform float uSeaHeight;

  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;
  varying float vDetail;
  varying float vNearDetail;
  varying float vMicroAo;
  varying float vMacroAo;
  varying float vGrassPatch;

  ${PLANET_LIGHTING_GLSL}
  ${TERRAIN_GRASS_AO_GLSL}
  ${TERRAIN_CLOUD_SHADOW_GLSL}

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
    float wetShore = smoothstep(uSeaHeight + 0.002, uSeaHeight + 0.020, vHeight)
      * (1.0 - smoothstep(uSeaHeight + 0.034, uSeaHeight + 0.115, vHeight))
      * (1.0 - snowMask)
      * (1.0 - smoothstep(0.42, 0.82, slope))
      * (1.0 - step(0.5, uPlanetKind));
    terrainColor = mix(terrainColor, terrainColor * vec3(0.48, 0.56, 0.54), wetShore * 0.36);
    terrainColor = mix(terrainColor, vec3(0.43, 0.39, 0.32), 0.06);

    vec3 finalNormal = detailNormal(normalize(vNormal), latitude, moisture, slope, coast);
    vec3 finalColor = applyPlanetLighting(terrainColor, finalNormal, vRadialNormal, vWorldPos, heightNorm, slope);
    finalColor = applyTerrainMacroAoToColor(finalColor, vMacroAo, 0.28);
    finalColor = applyTerrainMicroAoToColor(finalColor, vMicroAo, 0.52 * vNearDetail);
    finalColor = applyGrassGroundAo(finalColor, vGrassPatch, heightNorm, moisture, slope, coast, rockMask, snowMask);
    finalColor = applyTerrainCloudShadow(finalColor, vRadialNormal, 1.0);
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
      uTwilightColor: { value: twilightColor },
      uAtmosphereExtinctionStrength: { value: params.atmosphereExtinctionStrength },
      uCloudCoverage: { value: params.cloudCoverage },
      uCloudScale: { value: params.cloudScale },
      uCloudSoftness: { value: params.cloudSoftness },
      uCloudHeight: { value: params.cloudHeight },
      uCloudSpeed: { value: params.cloudSpeed },
      uCloudShadowStrength: { value: params.cloudShadow },
      uCloudVolumeStrength: { value: params.cloudVolume },
      uCloudStormStrength: { value: params.cloudStorms },
      uCloudBandStrength: { value: params.cloudBands },
      uCloudDetailStrength: { value: params.cloudDetail },
      uCloudQuality: { value: 2 },
      uCloudSeed: { value: params.seed },
      uCloudMask: { value: params.cloudMask },
      uCloudMaskOffset: { value: 0 },
      uTime: { value: 0 },
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
      uTerrainAoStrength: { value: params.terrainAoStrength },
      uGrassGroundAoStrength: { value: 0 },
      uSurfaceLightingBlend: { value: 0 },
    },
  })
}

export function createPlanetFarMaterial(params: {
  seed: number
  cloudMask: THREE.Texture
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
  terrainAoStrength: number
  atmosphereColor: string
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  twilightColor: THREE.Color | string
  atmosphereExtinctionStrength: number
  cloudCoverage: number
  cloudScale: number
  cloudSoftness: number
  cloudHeight: number
  cloudSpeed: number
  cloudShadow: number
  cloudVolume: number
  cloudStorms: number
  cloudBands: number
  cloudDetail: number
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
  const twilightColor = new THREE.Color(params.twilightColor)
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
  attribute float terrainMacroAo;
  attribute float terrainGrassPatch;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;
  varying float vMacro;
  varying float vMacroAo;
  varying float vGrassPatch;

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
    vMacroAo = terrainMacroAo;
    vGrassPatch = terrainGrassPatch;
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
  ${CLOUD_PATTERN_GLSL}

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform vec3 uTwilightColor;
  uniform float uAtmosphereExtinctionStrength;
  uniform float uPlanetRadius;
  uniform float uSeaHeight;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;
  varying float vMacro;
  varying float vMacroAo;
  varying float vGrassPatch;

  ${PLANET_LIGHTING_GLSL}
  ${TERRAIN_GRASS_AO_GLSL}
  ${TERRAIN_CLOUD_SHADOW_GLSL}

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
    float wetShore = smoothstep(uSeaHeight + 0.002, uSeaHeight + 0.020, visualHeight)
      * (1.0 - smoothstep(uSeaHeight + 0.034, uSeaHeight + 0.115, visualHeight))
      * (1.0 - snowMask)
      * (1.0 - smoothstep(0.42, 0.82, slope))
      * (1.0 - step(0.5, uPlanetKind));
    terrain = mix(terrain, terrain * vec3(0.48, 0.56, 0.54), wetShore * 0.34);
    terrain = mix(terrain, vec3(0.43, 0.39, 0.32), 0.06);

    vec3 finalColor = applyPlanetLighting(terrain, shadingNormal, vRadialNormal, vWorldPos, heightNorm, slope);
    finalColor = applyTerrainMacroAoToColor(finalColor, vMacroAo, 0.24);
    finalColor = applyGrassGroundAo(finalColor, vGrassPatch, heightNorm, moisture, slope, coast, rockMask, snowMask);
    finalColor = applyTerrainCloudShadow(finalColor, vRadialNormal, 1.0);
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
      uTwilightColor: { value: twilightColor },
      uAtmosphereExtinctionStrength: { value: params.atmosphereExtinctionStrength },
      uCloudCoverage: { value: params.cloudCoverage },
      uCloudScale: { value: params.cloudScale },
      uCloudSoftness: { value: params.cloudSoftness },
      uCloudHeight: { value: params.cloudHeight },
      uCloudSpeed: { value: params.cloudSpeed },
      uCloudShadowStrength: { value: params.cloudShadow },
      uCloudVolumeStrength: { value: params.cloudVolume },
      uCloudStormStrength: { value: params.cloudStorms },
      uCloudBandStrength: { value: params.cloudBands },
      uCloudDetailStrength: { value: params.cloudDetail },
      uCloudQuality: { value: 2 },
      uCloudSeed: { value: params.seed },
      uCloudMask: { value: params.cloudMask },
      uCloudMaskOffset: { value: 0 },
      uTime: { value: 0 },
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
      uTerrainAoStrength: { value: params.terrainAoStrength },
      uGrassGroundAoStrength: { value: 0 },
      uSurfaceLightingBlend: { value: 0 },
    },
  })
}

export function createPlanetFallbackMaterial(params: {
  seed: number
  cloudMask: THREE.Texture
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
  terrainAoStrength: number
  atmosphereColor: string
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  twilightColor: THREE.Color | string
  atmosphereExtinctionStrength: number
  cloudCoverage: number
  cloudScale: number
  cloudSoftness: number
  cloudHeight: number
  cloudSpeed: number
  cloudShadow: number
  cloudVolume: number
  cloudStorms: number
  cloudBands: number
  cloudDetail: number
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
  const twilightColor = new THREE.Color(params.twilightColor)
  const planetKind = params.planetType === 'gas'
    ? PlanetKind.Gas
    : params.planetType === 'ice'
      ? PlanetKind.Ice
      : PlanetKind.Rocky

  const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute float terrainHeight;
  attribute float terrainMacroAo;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;
  varying float vMacroAo;

  void main() {
    vSphereDir = normalize(position);
    vHeight = terrainHeight;
    vMacroAo = terrainMacroAo;
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
  ${TERRAIN_NOISE}
  #include <logdepthbuf_pars_fragment>
  ${TERRAIN_TEXTURE_GLSL}
  ${CLOUD_PATTERN_GLSL}

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform vec3 uTwilightColor;
  uniform float uAtmosphereExtinctionStrength;
  uniform float uPlanetKind;
  uniform float uPlanetRadius;
  uniform float uSeaHeight;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vRadialNormal;
  varying vec3 vSphereDir;
  varying float vHeight;
  varying float vMacroAo;

  ${PLANET_LIGHTING_GLSL}
  ${TERRAIN_CLOUD_SHADOW_GLSL}

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
    float wetShore = smoothstep(uSeaHeight + 0.002, uSeaHeight + 0.020, visualHeight)
      * (1.0 - smoothstep(uSeaHeight + 0.034, uSeaHeight + 0.115, visualHeight))
      * (1.0 - snowMask)
      * (1.0 - smoothstep(0.42, 0.82, slope))
      * (1.0 - step(0.5, uPlanetKind));
    terrain = mix(terrain, terrain * vec3(0.48, 0.56, 0.54), wetShore * 0.26);
    terrain = mix(terrain, vec3(0.43, 0.39, 0.32), 0.06);

    vec3 finalColor = applyPlanetLighting(terrain, shadingNormal, vRadialNormal, vWorldPos, heightNorm, slope);
    finalColor = applyTerrainMacroAoToColor(finalColor, vMacroAo, 0.14);
    finalColor = applyTerrainCloudShadow(finalColor, vRadialNormal, 1.0);
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
      uTwilightColor: { value: twilightColor },
      uAtmosphereExtinctionStrength: { value: params.atmosphereExtinctionStrength },
      uCloudCoverage: { value: params.cloudCoverage },
      uCloudScale: { value: params.cloudScale },
      uCloudSoftness: { value: params.cloudSoftness },
      uCloudHeight: { value: params.cloudHeight },
      uCloudSpeed: { value: params.cloudSpeed },
      uCloudShadowStrength: { value: params.cloudShadow },
      uCloudVolumeStrength: { value: params.cloudVolume },
      uCloudStormStrength: { value: params.cloudStorms },
      uCloudBandStrength: { value: params.cloudBands },
      uCloudDetailStrength: { value: params.cloudDetail },
      uCloudQuality: { value: 2 },
      uCloudSeed: { value: params.seed },
      uCloudMask: { value: params.cloudMask },
      uCloudMaskOffset: { value: 0 },
      uTime: { value: 0 },
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
      uTerrainAoStrength: { value: params.terrainAoStrength },
      uSurfaceLightingBlend: { value: 0 },
    },
  })
}

export function createAtmosphereMaterial(params: {
  atmosphereColor: string
  density: number
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  twilightColor: THREE.Color | string
  sunGlare: number
  sunGlareSize: number
  twilightWidth: number
  twilightStrength: number
  sunPosition: THREE.Vector3
  planetRadius: number
  atmosphereRadius: number
}): THREE.ShaderMaterial {
  const color = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const twilightColor = new THREE.Color(params.twilightColor)

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
  uniform vec3 uTwilightColor;
  uniform vec3 uSunPosition;
  uniform vec3 uPlanetCenter;
  uniform float uDensity;
  uniform float uSunGlareStrength;
  uniform float uSunGlareSize;
  uniform float uTwilightWidth;
  uniform float uTwilightStrength;
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
    float shellThicknessRatio = clamp((uAtmosphereRadius - uPlanetRadius) / max(uAtmosphereRadius, 0.001), 0.001, 0.25);
    float shellFadeStart = clamp(1.0 - shellThicknessRatio * 6.5, 0.46, 0.86);
    float shellEdgeFade = 1.0 - smoothstep(shellFadeStart, 1.0, rim);
    float nDotL = dot(shellNormal, sunDir);
    float outsideDay = smoothstep(-0.30, 0.55, nDotL);
    float forwardScatter = pow(max(dot(toCamera, sunDir), 0.0), 7.0);
    const float atmosphereLightInfluence = 0.85;
    float sunGlareStrength = clamp(uSunGlareStrength, 0.0, 2.0);
    float sunGlareSize = clamp(uSunGlareSize, 0.1, 2.0);
    float twilightWidth = clamp(uTwilightWidth, 0.2, 2.0);
    float twilightStrength = clamp(uTwilightStrength, 0.0, 2.0);
    vec3 scatterColor = mix(uAtmosphereColor, uAtmosphereLightColor, clamp(0.50 + atmosphereLightInfluence * 0.22, 0.0, 0.92));
    vec3 sunScatterColor = mix(uAtmosphereLightColor, uSunColor, 0.28);
    vec3 warmTwilightColor = mix(uTwilightColor, scatterColor, 0.18);
    warmTwilightColor = mix(warmTwilightColor, uSunColor, 0.12);
    vec3 coolTwilightColor = mix(uAtmosphereColor * 0.24, uTwilightColor * 0.18, 0.38);
    coolTwilightColor = mix(coolTwilightColor, uAtmosphereLightColor * 0.14, 0.30);
    float terminatorWarm = smoothstep(-0.42 * twilightWidth, 0.10 * twilightWidth, nDotL)
      * (1.0 - smoothstep(0.08 * twilightWidth, 0.54 * twilightWidth, nDotL));
    float terminatorBlue = smoothstep(-0.90 * twilightWidth, -0.18 * twilightWidth, nDotL)
      * (1.0 - smoothstep(-0.04 * twilightWidth, 0.30 * twilightWidth, nDotL));
    float terminatorGlow = clamp(terminatorWarm + terminatorBlue * 0.62, 0.0, 1.0);
    float outsideGlarePower = mix(34.0, 5.0, smoothstep(0.1, 2.0, sunGlareSize));
    float outsideSunGlare = pow(max(dot(toCamera, sunDir), 0.0), outsideGlarePower)
      * smoothstep(-0.22, 0.46, nDotL)
      * sunGlareStrength;
    vec3 outsideNightBase = vec3(0.010, 0.016, 0.032) * 0.12;
    vec3 outsideBase = mix(outsideNightBase, uAtmosphereColor * (0.16 + outsideDay * 0.86), outsideDay);
    vec3 outsideColor = outsideBase
      + scatterColor * outsideDay * 0.20
      + mix(coolTwilightColor, warmTwilightColor, terminatorWarm) * outerFade * terminatorGlow * twilightStrength * 0.28
      + sunScatterColor * (forwardScatter * (0.22 + outsideDay * 0.24) + outsideSunGlare * 0.58) * (0.72 + atmosphereLightInfluence * 0.55);
    float outsideAlpha = outerFade * uDensity * (0.055 + outsideDay * 0.36 + forwardScatter * (0.15 + atmosphereLightInfluence * 0.07));
    outsideAlpha += uDensity * (outsideSunGlare * 0.24 + terminatorGlow * twilightStrength * 0.08);

    vec3 skyDir = normalize(vWorldPos - cameraPosition);
    float skyUp = dot(skyDir, localUp);
    float horizon = pow(1.0 - clamp(skyUp, 0.0, 1.0), 1.45);
    float sunHeight = dot(sunDir, localUp);
    float sunView = max(dot(skyDir, sunDir), 0.0);
    float day = smoothstep(-0.08 * twilightWidth, 0.28 * twilightWidth, sunHeight);
    float twilight = smoothstep(-0.44 * twilightWidth, 0.12 * twilightWidth, sunHeight)
      * (1.0 - smoothstep(0.08 * twilightWidth, 0.52 * twilightWidth, sunHeight));
    float blueHour = smoothstep(-0.92 * twilightWidth, -0.18 * twilightWidth, sunHeight)
      * (1.0 - smoothstep(-0.05 * twilightWidth, 0.18 * twilightWidth, sunHeight));
    float night = 1.0 - smoothstep(-0.34 * twilightWidth, 0.05 * twilightWidth, sunHeight);
    float sunGlowPower = mix(28.0, 5.5, smoothstep(0.1, 2.0, sunGlareSize));
    float sunGlow = pow(sunView, sunGlowPower) * smoothstep(-0.10, 0.35, sunHeight) * sunGlareStrength;
    float sunsetForward = pow(sunView, 5.0) * twilight;

    float atmosphereLum = clamp(atmosphereLuminance(uAtmosphereColor), 0.08, 1.0);
    vec3 zenithColor = mix(uAtmosphereColor * 0.42, uAtmosphereColor * 1.18, day);
    vec3 horizonColor = mix(uAtmosphereColor * 0.70, scatterColor * (0.72 + atmosphereLum * 0.35), (0.38 + twilight * 0.52) * (0.72 + atmosphereLightInfluence * 0.36));
    vec3 dayColor = mix(zenithColor, horizonColor, clamp(horizon * (0.44 + twilight * 0.36), 0.0, 1.0));
    vec3 sunsetColor = mix(warmTwilightColor, scatterColor, 0.20);
    vec3 blueHourColor = mix(coolTwilightColor, uAtmosphereColor * 0.22, 0.42);
    vec3 nightSky = mix(vec3(0.010, 0.016, 0.032) * 0.46, uAtmosphereColor * 0.035 + vec3(0.003, 0.007, 0.020), 0.32);
    vec3 twilightColor = mix(blueHourColor, sunsetColor, clamp(smoothstep(-0.18 * twilightWidth, 0.16 * twilightWidth, sunHeight) + sunsetForward * 0.55, 0.0, 1.0));
    vec3 insideColor = mix(dayColor, twilightColor, clamp((horizon * 0.72 + sunsetForward) * twilight * twilightStrength, 0.0, 1.0));
    insideColor = mix(insideColor, blueHourColor, clamp(blueHour * (0.20 + twilightStrength * 0.34), 0.0, 0.70));
    insideColor = mix(insideColor, nightSky, night * 0.92);
    insideColor += sunScatterColor * sunGlow * (0.30 + day * 0.44) * (0.75 + atmosphereLightInfluence * 0.50);
    float insideAlpha = uDensity * (0.28 + day * 0.72 + horizon * 0.20 + twilight * horizon * (0.30 + twilightStrength * 0.16) + blueHour * 0.05 + sunGlow * 0.10);
    insideAlpha = mix(insideAlpha, uDensity * (0.014 + horizon * 0.030), night);

    vec3 color = mix(outsideColor, insideColor, inside);
    float alpha = mix(outsideAlpha * shellEdgeFade, insideAlpha, inside);
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
      uTwilightColor: { value: twilightColor },
      uSunPosition: { value: params.sunPosition.clone() },
      uPlanetCenter: { value: new THREE.Vector3() },
      uDensity: { value: params.density },
      uSunGlareStrength: { value: params.sunGlare },
      uSunGlareSize: { value: params.sunGlareSize },
      uTwilightWidth: { value: params.twilightWidth },
      uTwilightStrength: { value: params.twilightStrength },
      uPlanetRadius: { value: params.planetRadius },
      uAtmosphereRadius: { value: params.atmosphereRadius },
    },
  })
}

export function createCloudMaterial(params: {
  seed: number
  cloudMask: THREE.Texture
  coverage: number
  opacity: number
  scale: number
  softness: number
  height: number
  speed: number
  shadow: number
  volume: number
  storms: number
  bands: number
  detail: number
  atmosphereColor: string
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  sunPosition: THREE.Vector3
  cloudColor: string
}): THREE.ShaderMaterial {
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const cloudColor = new THREE.Color(params.cloudColor)

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
  ${TERRAIN_NOISE}
  ${CLOUD_PATTERN_GLSL}

  uniform vec3 uAtmosphereColor;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereLightColor;
  uniform vec3 uCloudColor;
  uniform vec3 uSunPosition;
  uniform vec3 uPlanetCenter;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uCloudColorStrength;

  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec3 dir = normalize(vWorldPos - uPlanetCenter);
    vec3 shellNormal = normalize(vNormal);
    vec3 sunDir = normalize(uSunPosition - uPlanetCenter);
    vec3 toCamera = normalize(cameraPosition - vWorldPos);
    float nDotL = dot(dir, sunDir);
    float day = smoothstep(-0.18, 0.60, nDotL);
    float direct = clamp(nDotL, 0.0, 1.0);
    float rim = pow(1.0 - max(dot(toCamera, shellNormal), 0.0), 2.1);

    float macroMask = sharedCloudMask(dir);
    float density = cloudFieldLod(dir);
    density = mix(density, density * 0.72 + macroMask * 0.82, 0.48);
    float cloud = cloudMaskFromDensity(density);
    float body = cloudBodyFromDensity(density);
    float macroGate = smoothstep(0.015, 0.16, macroMask);
    float macroBody = smoothstep(0.22, 0.72, macroMask);
    cloud = clamp(max(cloud * macroGate, macroMask * 0.38), 0.0, 1.0);
    body = clamp(max(body * smoothstep(0.08, 0.42, macroMask), macroBody * 0.42), 0.0, 1.0);
    float edge = cloudEdgeFromMaskBody(cloud, body);
    float densityTone = clamp(body * 0.72 + density * 0.24, 0.0, 1.0);

    float terminator = smoothstep(-0.34, 0.16, nDotL) * (1.0 - smoothstep(0.08, 0.56, nDotL));
    float lowSun = pow(1.0 - clamp(nDotL * 0.90 + 0.10, 0.0, 1.0), 2.0) * smoothstep(-0.26, 0.46, nDotL);
    float forwardGlow = pow(max(dot(toCamera, sunDir), 0.0), 7.5);
    float rimLight = pow(1.0 - max(dot(toCamera, shellNormal), 0.0), 3.0);

    vec3 coolWhite = mix(uCloudColor, uAtmosphereColor, 0.10) * 0.86;
    vec3 sunWhite = mix(vec3(0.82), uSunColor, 0.24);
    vec3 sunset = mix(vec3(0.76, 0.30, 0.11), uSunColor, 0.34);
    vec3 denseCore = mix(coolWhite * vec3(0.46, 0.50, 0.58), uAtmosphereLightColor * 0.18, 0.18);
    vec3 litCloud = mix(coolWhite * (0.22 + direct * 0.56), sunWhite, direct * 0.40);
    litCloud = mix(litCloud, denseCore, densityTone * (0.26 + (1.0 - direct) * 0.38));
    litCloud = mix(litCloud, sunset, lowSun * 0.42 + terminator * 0.18);
    vec3 nightCloud = mix(vec3(0.010, 0.016, 0.032) * 0.34, uAtmosphereLightColor * 0.045, 0.18);
    vec3 color = mix(nightCloud, litCloud, day);
    float qualityVolume = mix(0.64, 1.0, smoothstep(0.0, 2.0, uCloudQuality));
    float volume = clamp(uCloudVolumeStrength, 0.0, 1.5) * qualityVolume;
    float silver = edge * (0.12 + forwardGlow * 1.08 + rimLight * 0.24) * smoothstep(-0.12, 0.66, nDotL) * volume;
    float selfShadow = body * (1.0 - direct) * (0.34 + volume * 0.42);
    float baseShade = (1.0 - max(dot(shellNormal, toCamera), 0.0)) * body * volume * 0.30;
    float underside = body * smoothstep(-0.16, 0.30, -nDotL) * (0.18 + volume * 0.24);
    color = mix(color, color * vec3(0.36, 0.41, 0.50), clamp(selfShadow + baseShade + underside, 0.0, 0.82));
    color += mix(uAtmosphereLightColor, uSunColor, 0.42) * silver * (0.06 + day * 0.38);
    color += uAtmosphereLightColor * rim * (0.006 + day * 0.052) * (1.0 + volume * 0.18);
    color *= mix(0.62, 0.96 + volume * 0.05, body);

    float colorStr = clamp(uCloudColorStrength, 0.0, 1.0);
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(color, uCloudColor * max(lum, 0.0), colorStr);

    float alpha = cloud * clamp(uOpacity, 0.0, 1.0);
    alpha *= mix(0.28, 1.0, day);
    alpha *= 1.0 - rim * mix(0.18, 0.07, clamp(volume, 0.0, 1.0));
    alpha *= mix(0.88, 1.08, body);
    alpha = min(alpha + silver * 0.07, 0.94);
    if (alpha < 0.006) discard;

    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.88));
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uAtmosphereColor: { value: atmosphereColor },
      uSunColor: { value: sunColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uCloudColor: { value: cloudColor },
      uSunPosition: { value: params.sunPosition.clone() },
      uPlanetCenter: { value: new THREE.Vector3() },
      uCloudMask: { value: params.cloudMask },
      uCloudMaskOffset: { value: 0 },
      uSeed: { value: params.seed },
      uTime: { value: 0 },
      uOpacity: { value: params.opacity },
      uCloudColorStrength: { value: 0 },
      uCloudCoverage: { value: params.coverage },
      uCloudScale: { value: params.scale },
      uCloudSoftness: { value: params.softness },
      uCloudHeight: { value: params.height },
      uCloudSpeed: { value: params.speed },
      uCloudShadowStrength: { value: params.shadow },
      uCloudVolumeStrength: { value: params.volume },
      uCloudStormStrength: { value: params.storms },
      uCloudBandStrength: { value: params.bands },
      uCloudDetailStrength: { value: params.detail },
      uCloudQuality: { value: 2 },
      uCloudSeed: { value: params.seed },
    },
  })
}

export function createCloudBillboardMaterial(params: {
  opacity: number
  atmosphereColor: string
  sunColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  sunPosition: THREE.Vector3
  cloudColor: string
}): THREE.ShaderMaterial {
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const cloudColor = new THREE.Color(params.cloudColor)

  const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute float instanceAlpha;
  attribute float instanceSeed;

  varying vec2 vUv;
  varying float vAlpha;
  varying float vSeed;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vAlpha = instanceAlpha;
    vSeed = instanceSeed;

    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
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
  uniform vec3 uCloudColor;
  uniform vec3 uSunPosition;
  uniform vec3 uPlanetCenter;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uCloudColorStrength;

  varying vec2 vUv;
  varying float vAlpha;
  varying float vSeed;
  varying vec3 vWorldPos;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    p.x *= 1.08;
    float radial = length(p);
    float core = smoothstep(1.02, 0.16, radial);
    float feather = smoothstep(1.08, 0.66, radial);
    vec2 flow = vec2(uTime * 0.018, -uTime * 0.011);
    float softNoise = valueNoise(p * 2.15 + vSeed * 19.0 + flow);
    float broadNoise = valueNoise(p * 1.05 + vSeed * 7.0 - flow * 0.6);
    float streak = sin((p.x * 3.2 + p.y * 1.4 + vSeed * 9.7) + uTime * 0.08) * 0.5 + 0.5;
    float edgeBreakup = smoothstep(0.22, 0.92, softNoise * 0.62 + broadNoise * 0.38);
    float mask = core * mix(0.86, 1.10, broadNoise);
    mask += feather * streak * edgeBreakup * 0.16;
    mask *= smoothstep(1.08, 0.84, radial);
    mask *= 0.84 + softNoise * 0.22;

    vec3 dir = normalize(vWorldPos - uPlanetCenter);
    vec3 sunDir = normalize(uSunPosition - uPlanetCenter);
    float nDotL = dot(dir, sunDir);
    float day = smoothstep(-0.22, 0.58, nDotL);
    float direct = clamp(nDotL, 0.0, 1.0);
    vec3 cloudDay = mix(uCloudColor, uAtmosphereColor, 0.13);
    cloudDay = mix(cloudDay * (0.56 + direct * 0.42), mix(vec3(1.0), uSunColor, 0.25), direct * 0.52);
    vec3 sunset = mix(vec3(1.0, 0.42, 0.16), uSunColor, 0.42);
    cloudDay = mix(cloudDay, sunset, smoothstep(-0.24, 0.22, nDotL) * (1.0 - smoothstep(0.12, 0.54, nDotL)) * 0.32);
    vec3 cloudNight = mix(vec3(0.010, 0.016, 0.032) * 0.45, uAtmosphereLightColor * 0.08, 0.28);
    vec3 color = mix(cloudNight, cloudDay, day);
    float edgeLight = feather * pow(max(dot(normalize(cameraPosition - vWorldPos), sunDir), 0.0), 4.5);
    float innerShade = core * (1.0 - direct) * 0.18;
    color = mix(color, color * vec3(0.58, 0.64, 0.72), innerShade);
    color += mix(uAtmosphereLightColor, uSunColor, 0.35) * (feather * day * 0.07 + edgeLight * 0.22);

    float colorStr = clamp(uCloudColorStrength, 0.0, 1.0);
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(color, uCloudColor * max(lum, 0.0), colorStr);

    float alpha = mask * vAlpha * clamp(uOpacity, 0.0, 1.0);
    alpha *= mix(0.35, 1.0, day);
    alpha *= mix(0.88, 1.06, core);
    if (alpha < 0.006) discard;

    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.74));
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uAtmosphereColor: { value: atmosphereColor },
      uSunColor: { value: sunColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uCloudColor: { value: cloudColor },
      uSunPosition: { value: params.sunPosition.clone() },
      uPlanetCenter: { value: new THREE.Vector3() },
      uOpacity: { value: params.opacity },
      uTime: { value: 0 },
      uCloudColorStrength: { value: 0 },
    },
  })
}

import * as THREE from 'three'
import { TERRAIN_NOISE } from '../shaders/noise.glsl'
import { CLOUD_PATTERN_GLSL } from './planet-generator'

export interface OceanMaterialParams {
  seed: number
  planetType: string
  seaHeight: number
  seaRadius: number
  planetRadius: number
  terrainScale: number
  waterLevel: number
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
  cloudMask: THREE.Texture
  shoreMask: THREE.Texture
  shoreMaskDepthScale: number
  cloudShadow?: number
  cloudCoverage?: number
  cloudScale?: number
  cloudSoftness?: number
  cloudHeight?: number
  cloudSpeed?: number
  cloudStorms?: number
  cloudBands?: number
  cloudDetail?: number
  ifftTexture: THREE.Texture
  ifftWorldSize: number
  ifftHeightScale: number
  ifftNormalStrength: number
  ifftFoamStrength: number
  ifftChoppiness: number
  waveDetail?: number
  ifftDetailTexture?: THREE.Texture
  ifftDetailWorldSize?: number
  ifftDetailHeightScale?: number
  ifftDetailNormalStrength?: number
  ifftDetailFoamStrength?: number
  ifftDetailChoppiness?: number
  ifftDetailNearDistance?: number
  ifftDetailFarDistance?: number
  deepColor?: THREE.Color | string
  shallowColor?: THREE.Color | string
  foamColor?: THREE.Color | string
  clarity?: number
  absorption?: number
  turbidity?: number
  reflectionStrength?: number
  specularStrength?: number
}

const OCEAN_WAVE_GLSL = /* glsl */ `
vec3 oceanTangentFor(vec3 n) {
  vec3 t = cross(n, vec3(0.0, 1.0, 0.0));
  if (dot(t, t) < 0.0001) t = cross(n, vec3(1.0, 0.0, 0.0));
  return normalize(t);
}

struct OceanIfftSampleData {
  float height;
  vec3 slope;
  float foam;
};

vec4 oceanIfftPlaneSample(vec2 meters) {
  return texture2D(uIfftMap, meters / max(uIfftWorldSize, 0.001));
}

vec3 oceanIfftBlendWeights(vec3 n) {
  vec3 weights = pow(abs(n), vec3(5.0));
  return weights / max(weights.x + weights.y + weights.z, 0.0001);
}

OceanIfftSampleData oceanIfftFromTriplanarSamples(vec3 dir, vec4 sampleX, vec4 sampleY, vec4 sampleZ) {
  vec3 n = normalize(dir);
  vec3 weights = oceanIfftBlendWeights(n);
  vec3 slopeX = vec3(0.0, sampleX.b, sampleX.g);
  vec3 slopeY = vec3(sampleY.g, 0.0, sampleY.b);
  vec3 slopeZ = vec3(sampleZ.g, sampleZ.b, 0.0);

  OceanIfftSampleData data;
  data.height = sampleX.r * weights.x + sampleY.r * weights.y + sampleZ.r * weights.z;
  data.slope = slopeX * weights.x + slopeY * weights.y + slopeZ * weights.z;
  data.slope -= n * dot(data.slope, n);
  data.foam = sampleX.a * weights.x + sampleY.a * weights.y + sampleZ.a * weights.z;
  return data;
}

OceanIfftSampleData oceanIfftSampleData(vec3 dir) {
  vec3 n = normalize(dir);
  vec3 surface = n * uSeaRadius;
  vec4 sampleX = oceanIfftPlaneSample(vec2(surface.z, surface.y));
  vec4 sampleY = oceanIfftPlaneSample(vec2(surface.x, surface.z));
  vec4 sampleZ = oceanIfftPlaneSample(vec2(surface.x, surface.y));
  return oceanIfftFromTriplanarSamples(dir, sampleX, sampleY, sampleZ);
}

vec3 oceanWarpedDirection(vec3 dir, float time) {
  vec3 n = normalize(dir);
  vec3 tangent = oceanTangentFor(n);
  vec3 bitangent = normalize(cross(n, tangent));
  float slowTime = time * 0.018;
  float warpA = terrainFbm(n * 1.35 + vec3(slowTime, -slowTime * 0.42, slowTime * 0.63), uSeed + 1103.0, 3, 2.0, 0.52);
  float warpB = terrainFbm(n * 2.15 + vec3(-slowTime * 0.56, slowTime * 0.78, slowTime * 0.31), uSeed + 1499.0, 3, 2.08, 0.48);
  return normalize(n + tangent * (warpA * 0.115 + warpB * 0.030) + bitangent * (warpB * 0.105 - warpA * 0.026));
}

float oceanRegionalActivity(vec3 dir, float time) {
  vec3 n = normalize(dir);
  float weather = terrainFbm(n * 1.18 + vec3(time * 0.006, -time * 0.003, time * 0.004), uSeed + 2503.0, 3, 2.0, 0.54) * 0.5 + 0.5;
  float cells = terrainFbm(n * 3.10 + vec3(-time * 0.020, time * 0.011, time * 0.016), uSeed + 2677.0, 2, 2.18, 0.46) * 0.5 + 0.5;
  return smoothstep(0.18, 0.92, weather * 0.72 + cells * 0.28);
}

float oceanDirectionalWaveSimple(vec3 dir, vec3 waveDir, float scale, float speed, float phaseOffset, float time) {
  float phase = dot(normalize(dir), normalize(waveDir)) * scale + time * speed + phaseOffset;
  return sin(phase) * 0.72 + sin(phase * 1.61 + phaseOffset) * 0.14;
}

float oceanDirectionalWave(vec3 dir, vec3 waveDir, float scale, float speed, float phaseOffset, float time) {
  vec3 n = normalize(dir);
  float phaseNoise = terrainFbm(n * (scale * 0.022) + vec3(time * 0.012, -time * 0.007, time * 0.005), uSeed + phaseOffset * 17.0, 2, 2.0, 0.50);
  float phase = dot(n, normalize(waveDir)) * scale + time * speed + phaseOffset + phaseNoise * 2.35;
  return sin(phase) * 0.72 + sin(phase * 1.73 + phaseNoise * 1.90) * 0.20;
}

float oceanWaveFieldLow(vec3 dir, float time) {
  vec3 n = normalize(dir);
  float swell =
    oceanDirectionalWaveSimple(n, vec3(0.72, 0.16, -0.68), uWaveScale * 0.72, 0.24, 0.7, time) * 0.34 +
    oceanDirectionalWaveSimple(n, vec3(-0.31, 0.08, 0.95), uWaveScale * 1.06, -0.18, 2.4, time) * 0.18;
  float rolling = terrainFbm(n * (uWaveScale * 0.060) + vec3(time * 0.008, -time * 0.004, time * 0.006), uSeed + 1301.0, 1, 2.0, 0.52);
  return swell + rolling * 0.16;
}

float oceanWaveFieldMedium(vec3 dir, float time) {
  vec3 baseDir = normalize(dir);
  vec3 n = oceanWarpedDirection(baseDir, time);
  float activity = oceanRegionalActivity(baseDir, time);

  float swell =
    oceanDirectionalWaveSimple(n, vec3(0.72, 0.16, -0.68), uWaveScale * 0.82, 0.27, 0.7, time) * 0.30 +
    oceanDirectionalWaveSimple(n, vec3(-0.31, 0.08, 0.95), uWaveScale * 1.24, -0.20, 2.4, time) * 0.20 +
    oceanDirectionalWaveSimple(n, vec3(0.18, 0.91, 0.38), uWaveScale * 0.54, 0.12, 5.1, time) * 0.11;

  float rolling = terrainFbm(n * (uWaveScale * 0.11) + vec3(time * 0.012, -time * 0.005, time * 0.009), uSeed + 1301.0, 2, 2.04, 0.52);
  float chop = terrainFbm(n * (uWaveScale * 0.34) + vec3(-time * 0.030, time * 0.014, time * 0.020), uSeed + 1709.0, 1, 2.18, 0.46);
  return swell + rolling * (0.16 + activity * 0.08) + chop * activity * 0.045;
}

float oceanWaveField(vec3 dir, float time) {
  if (uOceanQuality < 0.5) return oceanWaveFieldLow(dir, time);
  if (uOceanQuality < 1.5) return oceanWaveFieldMedium(dir, time);

  vec3 baseDir = normalize(dir);
  vec3 n = oceanWarpedDirection(baseDir, time);
  float activity = oceanRegionalActivity(baseDir, time);

  float longSwell =
    oceanDirectionalWave(n, vec3(0.72, 0.16, -0.68), uWaveScale * 0.86, 0.29, 0.7, time) * 0.27 +
    oceanDirectionalWave(n, vec3(-0.31, 0.08, 0.95), uWaveScale * 1.31, -0.21, 2.4, time) * 0.18 +
    oceanDirectionalWave(n, vec3(0.18, 0.91, 0.38), uWaveScale * 0.58, 0.13, 5.1, time) * 0.12;

  float crossedChop =
    oceanDirectionalWave(n, vec3(-0.86, 0.22, -0.45), uWaveScale * 2.15, 0.47, 8.2, time) * 0.07 +
    oceanDirectionalWave(n, vec3(0.42, -0.35, 0.84), uWaveScale * 2.75, -0.39, 11.6, time) * 0.055;

  float rollingNoise = terrainFbm(n * (uWaveScale * 0.13) + vec3(time * 0.014, -time * 0.006, time * 0.010), uSeed + 1301.0, 3, 2.04, 0.52);
  float fineChop = terrainFbm(n * (uWaveScale * 0.56) + vec3(-time * 0.042, time * 0.019, time * 0.027), uSeed + 1709.0, 3, 2.18, 0.46);
  float brokenRipples = terrainFbm(oceanWarpedDirection(n + vec3(fineChop * 0.018), time * 1.35) * (uWaveScale * 0.92) + vec3(time * 0.030), uSeed + 3187.0, 2, 2.32, 0.42);

  return longSwell
    + crossedChop * (0.58 + activity * 0.58)
    + rollingNoise * (0.18 + activity * 0.12)
    + fineChop * (0.060 + activity * 0.080)
    + brokenRipples * activity * 0.045;
}
`

export function createOceanMaterial(params: OceanMaterialParams): THREE.ShaderMaterial {
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const deepOceanColor = new THREE.Color(params.deepColor ?? '#063869')
  const shallowOceanColor = new THREE.Color(params.shallowColor ?? '#12a6b8')
  const foamOceanColor = new THREE.Color(params.foamColor ?? '#d8f6ff')
  const isIce = params.planetType === 'ice' ? 1 : 0
  const terrainMeters = Math.max(params.terrainScale * params.planetRadius, 1)
  const waveHeight = THREE.MathUtils.clamp(terrainMeters * 0.006, 0.08, params.planetRadius * 0.0008)

  const vertexShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uTime;
  uniform float uSeed;
  uniform float uSeaHeight;
  uniform float uSeaRadius;
  uniform float uWaveHeight;
  uniform float uWaveScale;
  uniform float uOceanQuality;
  uniform float uIfftEnabled;
  uniform float uIfftWorldSize;
  uniform float uIfftHeightScale;
  uniform float uIfftChoppiness;
  uniform sampler2D uIfftMap;
  attribute float terrainHeight;

  varying vec3 vWorldPos;
  varying vec3 vSphereDir;
  varying vec3 vRadialNormal;
  varying float vTerrainHeight;
  varying float vWave;
  varying float vIfftFoam;
  varying float vIfftSlope;

  ${OCEAN_WAVE_GLSL}

  void main() {
    vec3 sphereDir = normalize(position);
    vSphereDir = sphereDir;
    vTerrainHeight = terrainHeight;

    float waterDepth = max(uSeaHeight - terrainHeight, 0.0);
    float shoreCalm = smoothstep(0.005, 0.055, waterDepth);
    OceanIfftSampleData ifft = oceanIfftSampleData(sphereDir);
    // Both mixes below weight this by uIfftEnabled, which is 1 at construction
    // and never written anywhere in the client, so the legacy field is always
    // multiplied out. Evaluating it cost ~35 snoise4D per vertex across a
    // 65,340-vertex non-indexed icosphere — ~2.3M discarded simplex taps per
    // frame per ocean planet. The branch is uniform-coherent, so the taken
    // operand is the only one evaluated.
    float legacyWave = uIfftEnabled > 0.5 ? 0.0 : oceanWaveField(sphereDir, uTime);
    vWave = mix(legacyWave, ifft.height, uIfftEnabled);
    vIfftFoam = ifft.foam * uIfftEnabled;
    vIfftSlope = length(ifft.slope) * uIfftEnabled;
    float waveDisplacement = mix(legacyWave * uWaveHeight, ifft.height * uIfftHeightScale, uIfftEnabled);
    vec3 displaced = position + sphereDir * waveDisplacement * (0.35 + shoreCalm * 0.65);
    displaced -= ifft.slope * uIfftHeightScale * uIfftChoppiness * shoreCalm * uIfftEnabled;

    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
    vRadialNormal = normalize((modelMatrix * vec4(sphereDir, 0.0)).xyz);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  ${TERRAIN_NOISE}
  ${CLOUD_PATTERN_GLSL}
  #include <logdepthbuf_pars_fragment>

  uniform float uSeed;
  uniform float uSeaHeight;
  uniform float uSeaRadius;
  uniform float uWaveScale;
  uniform float uNormalStrength;
  uniform float uDepthRange;
  uniform float uWaterLevel;
  uniform float uIceBlend;
  uniform float uOceanQuality;
  uniform float uOceanAlpha;
  uniform float uOceanWaveDetail;
  uniform float uIfftEnabled;
  uniform float uIfftWorldSize;
  uniform float uIfftNormalStrength;
  uniform float uIfftFoamStrength;
  uniform float uIfftChoppiness;
  uniform float uIfftDetailEnabled;
  uniform float uIfftDetailWorldSize;
  uniform float uIfftDetailNormalStrength;
  uniform float uIfftDetailFoamStrength;
  uniform float uIfftDetailChoppiness;
  uniform float uIfftDetailNearDistance;
  uniform float uIfftDetailFarDistance;
  uniform float uOceanSpecularStrength;
  uniform float uOceanClarity;
  uniform float uOceanAbsorption;
  uniform float uOceanTurbidity;
  uniform float uOceanReflectionStrength;
  uniform sampler2D uIfftMap;
  uniform sampler2D uIfftDetailMap;
  uniform sampler2D uOceanShoreMask;
  uniform float uOceanShoreMaskDepthScale;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform vec3 uOceanDeepColor;
  uniform vec3 uOceanShallowColor;
  uniform vec3 uOceanFoamColor;
  uniform vec3 uCloudLocalSunDirection;

  varying vec3 vWorldPos;
  varying vec3 vSphereDir;
  varying vec3 vRadialNormal;
  varying float vTerrainHeight;
  varying float vWave;
  varying float vIfftFoam;
  varying float vIfftSlope;

  float oceanSaturate(float value) {
    return clamp(value, 0.0, 1.0);
  }

  vec3 oceanDesaturate(vec3 color, float amount) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(color, vec3(luma), clamp(amount, 0.0, 1.0));
  }

  ${OCEAN_WAVE_GLSL}

  vec4 oceanIfftDetailPlaneSample(vec2 meters) {
    return texture2D(uIfftDetailMap, meters / max(uIfftDetailWorldSize, 0.001));
  }

  OceanIfftSampleData oceanIfftDetailSampleData(vec3 dir) {
    vec3 n = normalize(dir);
    vec3 surface = n * uSeaRadius;
    vec4 sampleX = oceanIfftDetailPlaneSample(vec2(surface.z, surface.y));
    vec4 sampleY = oceanIfftDetailPlaneSample(vec2(surface.x, surface.z));
    vec4 sampleZ = oceanIfftDetailPlaneSample(vec2(surface.x, surface.y));
    return oceanIfftFromTriplanarSamples(dir, sampleX, sampleY, sampleZ);
  }

  float oceanIfftDetailWeight(float distanceToCamera) {
    float detailAmount = smoothstep(0.35, 2.55, uOceanWaveDetail);
    float nearWeight = 1.0 - smoothstep(
      uIfftDetailNearDistance,
      max(uIfftDetailNearDistance + 1.0, uIfftDetailFarDistance),
      distanceToCamera
    );
    float closeStrength = mix(0.56, 1.18, detailAmount);
    return uIfftDetailEnabled * closeStrength * mix(0.03, 1.0, nearWeight);
  }

  vec3 oceanIfftNormal(vec3 dir, vec3 radialNormal) {
    OceanIfftSampleData ifft = oceanIfftSampleData(dir);
    vec3 slope = ifft.slope - radialNormal * dot(ifft.slope, radialNormal);
    return normalize(radialNormal - slope * uIfftNormalStrength);
  }

  vec3 oceanNormal(vec3 dir, vec3 radialNormal) {
    if (uIfftEnabled > 0.5) {
      return oceanIfftNormal(dir, radialNormal);
    }

    if (uOceanQuality < 0.5) {
      return radialNormal;
    }

    vec3 localTangent = oceanTangentFor(dir);
    vec3 localBitangent = normalize(cross(dir, localTangent));
    vec3 worldTangent = normalize(oceanTangentFor(radialNormal));
    vec3 worldBitangent = normalize(cross(radialNormal, worldTangent));
    float qualityBlend = smoothstep(0.5, 1.5, uOceanQuality);
    float stepSize = mix(0.0030, 0.0016, qualityBlend);
    float normalStrength = uNormalStrength * mix(0.56, 1.0, qualityBlend);
    float center = oceanWaveField(dir, uTime);
    float tx = oceanWaveField(normalize(dir + localTangent * stepSize), uTime) - center;
    float ty = oceanWaveField(normalize(dir + localBitangent * stepSize), uTime) - center;
    return normalize(radialNormal - worldTangent * tx * normalStrength - worldBitangent * ty * normalStrength);
  }

  vec2 oceanShoreMaskUv(vec3 sphereDir) {
    vec3 n = normalize(sphereDir);
    const float invTau = 0.15915494309189535;
    const float invPi = 0.3183098861837907;
    float longitude = atan(n.z, n.x);
    float latitude = asin(clamp(n.y, -1.0, 1.0));
    return vec2(fract(longitude * invTau + 0.5), latitude * invPi + 0.5);
  }

  void main() {
    float waterDepthRaw = uSeaHeight - vTerrainHeight;
    vec4 shoreMaskSample = texture2D(uOceanShoreMask, oceanShoreMaskUv(vSphereDir));
    float vertexWaterMask = smoothstep(-0.045, 0.008, waterDepthRaw);
    float waterMask = max(vertexWaterMask, shoreMaskSample.r);
    if (waterMask <= 0.01) discard;
    waterDepthRaw = max(max(waterDepthRaw, shoreMaskSample.g * uOceanShoreMaskDepthScale), 0.0);

    vec3 radial = normalize(vRadialNormal);
    vec3 normal = oceanNormal(normalize(vSphereDir), radial);
    OceanIfftSampleData fragmentIfft = oceanIfftSampleData(normalize(vSphereDir));
    float fragmentIfftSlope = length(fragmentIfft.slope) * uIfftEnabled;
    float fragmentIfftFoam = fragmentIfft.foam * uIfftEnabled;
    OceanIfftSampleData detailIfft;
    detailIfft.height = 0.0;
    detailIfft.slope = vec3(0.0);
    detailIfft.foam = 0.0;
    float detailWeight = 0.0;
    float detailSlopeAmount = 0.0;
    if (uIfftDetailEnabled > 0.001) {
      detailIfft = oceanIfftDetailSampleData(normalize(vSphereDir));
      detailWeight = oceanIfftDetailWeight(distance(cameraPosition, vWorldPos));
      vec3 detailSlope = detailIfft.slope - radial * dot(detailIfft.slope, radial);
      normal = normalize(normal - detailSlope * uIfftDetailNormalStrength * detailWeight);
      detailSlopeAmount = length(detailSlope) * detailWeight;
      fragmentIfftSlope += detailSlopeAmount * (1.08 + uIfftDetailChoppiness * 0.28);
      fragmentIfftFoam = max(fragmentIfftFoam, detailIfft.foam * detailWeight * (0.78 + uIfftDetailFoamStrength * 0.24));
    }
    float detailAmount = smoothstep(0.75, 2.70, uOceanWaveDetail);
    float closeDetail = 1.0 - smoothstep(140.0, 2200.0, distance(cameraPosition, vWorldPos));
    float microWeight = detailAmount * closeDetail * uIfftEnabled * (1.0 - uIfftDetailEnabled * 0.84);
    float microSlope = 0.0;
    if (microWeight > 0.001) {
      vec3 tangent = oceanTangentFor(radial);
      vec3 bitangent = normalize(cross(radial, tangent));
      vec3 detailDir = normalize(vSphereDir);
      float detailScale = uWaveScale * mix(1.85, 4.85, detailAmount);
      float microA = terrainFbm(detailDir * detailScale + vec3(uTime * 0.24, -uTime * 0.10, uTime * 0.07), uSeed + 7711.0, 2, 2.24, 0.43);
      float microB = terrainFbm(detailDir * detailScale * 1.43 + vec3(-uTime * 0.18, uTime * 0.16, -uTime * 0.05), uSeed + 7727.0, 2, 2.31, 0.40);
      float microNormalStrength = microWeight * 0.18;
      normal = normalize(normal - tangent * microA * microNormalStrength - bitangent * microB * microNormalStrength);
      microSlope = (abs(microA) + abs(microB)) * microWeight * 0.42;
      fragmentIfftSlope += microSlope;
    }
    // Unresolved wave normals cause orbit-scale glitter and temporal aliasing.
    // Fade them with the pixel footprint of the simulation, preserving swells nearby.
    float waveFootprint = max(length(dFdx(vSphereDir)), length(dFdy(vSphereDir))) * uWaveScale;
    float resolvedWaves = 1.0 - smoothstep(0.025, 0.22, waveFootprint);
    normal = normalize(mix(radial, normal, resolvedWaves));
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float sunFacing = dot(radial, lightDir);
    float day = smoothstep(-0.28, 0.52, sunFacing);
    float reflectionLight = smoothstep(-0.10, 0.58, sunFacing);
    float direct = max(dot(normal, lightDir), 0.0);
    float viewFacing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - viewFacing, 4.6);
    float litFresnel = fresnel * (0.035 + reflectionLight * 0.965);

    float depth = oceanSaturate(waterDepthRaw / max(uDepthRange, 0.001));
    float shallow = 1.0 - smoothstep(0.025, 0.16, waterDepthRaw);
    vec3 atmosphereWaterTint = mix(uAtmosphereColor, uAtmosphereLightColor, 0.18);
    vec3 deepAtmosphereTint = atmosphereWaterTint * vec3(0.060, 0.145, 0.245);
    vec3 shelfAtmosphereTint = atmosphereWaterTint * vec3(0.340, 0.590, 0.660);
    vec3 deepColor = mix(uOceanDeepColor, deepAtmosphereTint, 0.18);
    vec3 shelfColor = mix(uOceanShallowColor * vec3(0.62, 0.74, 0.76), shelfAtmosphereTint, 0.38);
    deepColor = mix(deepColor, vec3(0.030, 0.105, 0.145), uIceBlend * 0.18);
    shelfColor = mix(shelfColor, vec3(0.245, 0.515, 0.610), uIceBlend * 0.26);
    float clarity = clamp(uOceanClarity, 0.0, 1.0);
    float absorption = clamp(uOceanAbsorption, 0.2, 2.0);
    float turbidity = clamp(uOceanTurbidity, 0.0, 1.0);
    float absorptionDepth = smoothstep(0.0, max(0.050, uDepthRange * mix(2.10, 0.92, absorption * 0.5)), waterDepthRaw);
    float opticalDepth = pow(absorptionDepth, mix(1.52, 0.86, absorption * 0.5));
    float shoal = 1.0 - smoothstep(0.000, max(0.105, uDepthRange * (0.72 + clarity * 0.38)), waterDepthRaw);
    float abyss = smoothstep(0.085, max(0.155, uDepthRange * mix(1.45, 0.82, absorption * 0.5)), waterDepthRaw);
    vec3 lagoonColor = mix(shelfColor, uOceanShallowColor * 0.58 + uAtmosphereLightColor * 0.035, 0.10 + clarity * 0.08);
    vec3 midWaterColor = mix(shelfColor, deepColor, smoothstep(0.030, max(0.160, uDepthRange * 1.08), waterDepthRaw));
    vec3 abyssColor = mix(deepColor, uOceanDeepColor * vec3(0.70, 0.82, 1.00), 0.16 + clamp(absorption * 0.08, 0.0, 0.20));
    vec3 waterColor = mix(lagoonColor, midWaterColor, smoothstep(0.018, max(0.190, uDepthRange * 1.26), waterDepthRaw));
    waterColor = mix(waterColor, abyssColor, max(depth * 0.54, opticalDepth * 0.62) * abyss);
    vec3 suspendedColor = mix(vec3(0.040, 0.110, 0.086), uOceanShallowColor, 0.40);
    waterColor = mix(waterColor, suspendedColor, turbidity * (1.0 - abyss * 0.76) * (0.10 + shoal * 0.18));
    waterColor = oceanDesaturate(waterColor, shoal * 0.16 + turbidity * 0.10);

    float horizonReflection = pow(clamp(1.0 - abs(dot(viewDir, radial)), 0.0, 1.0), 2.2);
    float reflectionAmount = litFresnel * (0.30 + day * 0.18 + horizonReflection * 0.42) * uOceanReflectionStrength;
    vec3 skyReflection = mix(
      uAtmosphereColor * 0.30 + deepColor * 0.38,
      uAtmosphereLightColor * 0.58 + uAtmosphereColor * 0.36,
      horizonReflection
    );
    float reflectionMask = clamp(reflectionAmount * (0.38 + clarity * 0.10 + depth * 0.18), 0.0, 0.48);
    waterColor = mix(waterColor, skyReflection, reflectionMask);

    float halfSpec = pow(max(dot(normalize(lightDir + viewDir), normal), 0.0), 160.0);
    float broadSpec = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), 42.0);
    float glitter = 0.0;
    if (uOceanQuality > 0.5) {
      float glintNoise = uOceanQuality > 1.5
        ? terrainFbm(normalize(vSphereDir) * (uWaveScale * 0.9) + vec3(uTime * 0.08), uSeed + 2211.0, 2, 2.4, 0.42) * 0.5 + 0.5
        : terrainFbm(normalize(vSphereDir) * (uWaveScale * 0.42) + vec3(uTime * 0.045), uSeed + 2211.0, 1, 2.2, 0.42) * 0.5 + 0.5;
      float glintField = glintNoise * 0.54 + fragmentIfftSlope * 0.46 + max(vWave, 0.0) * 0.08;
      glitter = smoothstep(0.92, 1.32, glintField) * pow(direct, 3.2);
    }
    vec3 specular = uSunColor * day * (halfSpec * 0.82 + broadSpec * 0.18 + glitter * 0.055 * resolvedWaves) * uOceanSpecularStrength;
    float sunMirror = pow(max(dot(reflect(-viewDir, normal), lightDir), 0.0), 34.0) * day * reflectionLight;
    specular += uSunColor * sunMirror * uOceanReflectionStrength * (0.035 + uOceanClarity * 0.060);
    float cloudShadow = cloudShadowMask(normalize(vSphereDir), normalize(uCloudLocalSunDirection));
    float lowSunCoast = (1.0 - smoothstep(0.16, 0.55, sunFacing)) * smoothstep(-0.18, 0.28, sunFacing);
    float coastOcclusion = (1.0 - smoothstep(0.018, 0.145, waterDepthRaw)) * lowSunCoast;
    float terrainShadow = clamp(coastOcclusion * (0.24 + uOceanTurbidity * 0.12 + (1.0 - uOceanClarity) * 0.10), 0.0, 0.42);
    specular *= 1.0 - clamp(cloudShadow * 0.72 + terrainShadow * 0.64, 0.0, 0.86);

    float shoreBand = smoothstep(0.002, 0.010, waterDepthRaw) * (1.0 - smoothstep(0.014, 0.036, waterDepthRaw));
    float shoreWash = smoothstep(0.006, 0.026, waterDepthRaw) * (1.0 - smoothstep(0.038, 0.090, waterDepthRaw));
    float foamNoise = uOceanQuality > 0.5
      ? terrainFbm(normalize(vSphereDir) * (uWaveScale * 0.34) + vec3(-uTime * 0.035, uTime * 0.018, uTime * 0.011), uSeed + 3019.0, uOceanQuality > 1.5 ? 3 : 1, 2.1, 0.5) * 0.5 + 0.5
      : 0.62;
    float foamDetail = uOceanQuality > 0.5
      ? terrainFbm(normalize(vSphereDir) * (uWaveScale * 1.16) + vec3(uTime * 0.070, -uTime * 0.038, uTime * 0.026), uSeed + 4049.0, uOceanQuality > 1.5 ? 2 : 1, 2.32, 0.44) * 0.5 + 0.5
      : 0.62;
    float shoreThreadNoise = 0.62;
    if (uOceanQuality > 0.5 && max(shoreBand, shoreWash) > 0.001) {
      shoreThreadNoise = terrainFbm(normalize(vSphereDir) * (uWaveScale * 2.85) + vec3(-uTime * 0.120, uTime * 0.052, uTime * 0.038), uSeed + 5021.0, uOceanQuality > 1.5 ? 2 : 1, 2.28, 0.42) * 0.5 + 0.5;
    }
    float foamLight = smoothstep(-0.08, 0.46, sunFacing);
    float foamVisibility = smoothstep(0.02, 0.54, sunFacing);
    float shoreLine = shoreBand * smoothstep(0.62, 1.03, foamDetail * 0.42 + shoreThreadNoise * 0.46 + abs(vWave) * 0.14);
    float shoreFeather = shoreWash * smoothstep(0.78, 1.16, foamNoise * 0.45 + foamDetail * 0.35 + shoreThreadNoise * 0.20) * 0.28;
    float shoreFoam = (shoreLine * 0.72 + shoreFeather) * (0.70 + uWaterLevel * 0.22) * (0.18 + uIfftFoamStrength * 0.24);
    float crestBreakup = smoothstep(0.56, 0.90, foamDetail + fragmentIfftFoam * 0.22);
    float crestFoam = smoothstep(0.36, 0.86, fragmentIfftFoam) * smoothstep(0.18, 0.58, fragmentIfftSlope + max(vWave, 0.0) * 0.12) * crestBreakup;
    crestFoam = max(crestFoam, smoothstep(0.34, 0.82, microSlope + fragmentIfftFoam * 0.35) * microWeight * 0.16);
    crestFoam = max(crestFoam, smoothstep(0.46, 1.10, detailSlopeAmount + detailIfft.foam * 0.42) * detailWeight * uIfftDetailFoamStrength * 0.18);
    crestFoam *= smoothstep(0.045, 0.24, waterDepthRaw) * uIfftFoamStrength * 0.62;
    crestFoam *= mix(0.54, 0.96, clamp(uIfftChoppiness / 2.5, 0.0, 1.0));
    float foamMask = pow(max(shoreFoam, crestFoam * resolvedWaves), 1.35) * (0.04 + foamVisibility * 0.96);
    vec3 foam = uOceanFoamColor * (0.030 + foamLight * 0.970);

    vec3 nightColor = deepColor * vec3(0.035, 0.046, 0.078);
    vec3 litColor = waterColor * (0.12 + day * 0.88) + specular;
    vec3 finalColor = mix(nightColor, litColor, day);
    finalColor = mix(finalColor, foam, foamMask);
    finalColor += uAtmosphereLightColor * litFresnel * (0.018 + day * 0.065);
    float waterShadow = clamp(cloudShadow * (0.34 + depth * 0.30) + terrainShadow, 0.0, 0.74);
    vec3 shadowedWater = finalColor * mix(vec3(0.58, 0.64, 0.70), vec3(0.28, 0.34, 0.43), depth);
    finalColor = mix(finalColor, shadowedWater, waterShadow);
    finalColor = oceanDesaturate(finalColor, waterShadow * (0.30 + shoal * 0.18));

    float shallowTransparency = shoal * clarity * (1.0 - turbidity * 0.62);
    float alphaDepth = smoothstep(0.010, max(0.030, uDepthRange * 0.82), waterDepthRaw);
    float alpha = mix(0.72 + turbidity * 0.12, 0.982, pow(alphaDepth, 0.72));
    alpha += litFresnel * 0.065 + foamMask * (0.08 + foamVisibility * 0.14);
    alpha -= shallowTransparency * 0.052;
    alpha *= waterMask;
    alpha *= mix(0.90, 1.0, reflectionLight);
    alpha *= uOceanAlpha;
    alpha = clamp(alpha, 0.0, 0.995);

    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(finalColor, alpha);
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: params.seed },
      uSeaHeight: { value: params.seaHeight },
      uSeaRadius: { value: params.seaRadius },
      uWaveHeight: { value: waveHeight },
      uWaveScale: { value: THREE.MathUtils.lerp(42, 88, THREE.MathUtils.clamp(params.waterLevel, 0, 1)) },
      uNormalStrength: { value: 18 },
      uOceanQuality: { value: 2 },
      uOceanAlpha: { value: 1 },
      uOceanWaveDetail: { value: params.waveDetail ?? 1.45 },
      uIfftEnabled: { value: 1 },
      uIfftMap: { value: params.ifftTexture },
      uIfftWorldSize: { value: params.ifftWorldSize },
      uIfftHeightScale: { value: params.ifftHeightScale },
      uIfftNormalStrength: { value: params.ifftNormalStrength },
      uIfftFoamStrength: { value: params.ifftFoamStrength },
      uIfftChoppiness: { value: params.ifftChoppiness },
      uIfftDetailEnabled: { value: params.ifftDetailTexture ? 1 : 0 },
      uIfftDetailMap: { value: params.ifftDetailTexture ?? params.ifftTexture },
      uIfftDetailWorldSize: { value: params.ifftDetailWorldSize ?? params.ifftWorldSize },
      uIfftDetailNormalStrength: { value: params.ifftDetailNormalStrength ?? params.ifftNormalStrength * 0.48 },
      uIfftDetailFoamStrength: { value: params.ifftDetailFoamStrength ?? params.ifftFoamStrength * 0.28 },
      uIfftDetailChoppiness: { value: params.ifftDetailChoppiness ?? params.ifftChoppiness },
      uIfftDetailNearDistance: { value: params.ifftDetailNearDistance ?? 900 },
      uIfftDetailFarDistance: { value: params.ifftDetailFarDistance ?? 5200 },
      uOceanShoreMask: { value: params.shoreMask },
      uOceanShoreMaskDepthScale: { value: params.shoreMaskDepthScale },
      uOceanSpecularStrength: { value: params.specularStrength ?? 1 },
      uOceanClarity: { value: params.clarity ?? 0.72 },
      uOceanAbsorption: { value: params.absorption ?? 0.85 },
      uOceanTurbidity: { value: params.turbidity ?? 0.18 },
      uOceanReflectionStrength: { value: params.reflectionStrength ?? 0.86 },
      uOceanDeepColor: { value: deepOceanColor },
      uOceanShallowColor: { value: shallowOceanColor },
      uOceanFoamColor: { value: foamOceanColor },
      uDepthRange: { value: params.planetType === 'ice' ? 0.12 : 0.20 },
      uWaterLevel: { value: params.waterLevel },
      uIceBlend: { value: isIce },
      uSunPosition: { value: params.sunPosition.clone() },
      uSunColor: { value: sunColor },
      uAtmosphereColor: { value: atmosphereColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
      uCloudCoverage: { value: params.cloudCoverage ?? 0.68 },
      uCloudScale: { value: params.cloudScale ?? 2.7 },
      uCloudSoftness: { value: params.cloudSoftness ?? 0.15 },
      uCloudHeight: { value: params.cloudHeight ?? 0.045 },
      uCloudSpeed: { value: params.cloudSpeed ?? 0.012 },
      uCloudShadowStrength: { value: params.cloudShadow ?? 0 },
      uCloudVolumeStrength: { value: 1.08 },
      uCloudStormStrength: { value: params.cloudStorms ?? 0.62 },
      uCloudBandStrength: { value: params.cloudBands ?? 0.72 },
      uCloudDetailStrength: { value: params.cloudDetail ?? 0.82 },
      uCloudQuality: { value: 2 },
      uCloudSeed: { value: params.seed },
      uCloudMask: { value: params.cloudMask },
      uCloudMaskOffset: { value: 0 },
      uCloudLocalSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    },
  })
}

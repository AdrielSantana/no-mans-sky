import * as THREE from 'three'
import { TERRAIN_NOISE } from '../shaders/noise.glsl'

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

OceanIfftSampleData oceanIfftSampleData(vec3 dir) {
  vec3 n = normalize(dir);
  vec3 surface = n * uSeaRadius;
  vec3 weights = oceanIfftBlendWeights(n);

  vec4 sampleX = oceanIfftPlaneSample(vec2(surface.z, surface.y));
  vec4 sampleY = oceanIfftPlaneSample(vec2(surface.x, surface.z));
  vec4 sampleZ = oceanIfftPlaneSample(vec2(surface.x, surface.y));

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
    float legacyWave = oceanWaveField(sphereDir, uTime);
    vWave = mix(legacyWave, ifft.height, uIfftEnabled);
    vIfftFoam = ifft.foam * uIfftEnabled;
    vIfftSlope = length(ifft.slope) * uIfftEnabled;
    float waveDisplacement = mix(legacyWave * uWaveHeight, ifft.height * uIfftHeightScale, uIfftEnabled);
    vec3 displaced = position + sphereDir * waveDisplacement * (0.35 + shoreCalm * 0.65);
    displaced -= ifft.slope * uIfftHeightScale * uIfftChoppiness * shoreCalm * uIfftEnabled;

    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
    vRadialNormal = normalize((modelMatrix * vec4(sphereDir, 0.0)).xyz);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <logdepthbuf_pars_fragment>

  uniform float uTime;
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
  uniform float uOceanSpecularStrength;
  uniform sampler2D uIfftMap;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;
  uniform vec3 uOceanDeepColor;
  uniform vec3 uOceanShallowColor;
  uniform vec3 uOceanFoamColor;

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

  ${OCEAN_WAVE_GLSL}

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

  void main() {
    float waterDepthRaw = uSeaHeight - vTerrainHeight;
    float waterMask = 1.0 - smoothstep(-0.004, 0.010, -waterDepthRaw);
    if (waterMask <= 0.01) discard;

    vec3 radial = normalize(vRadialNormal);
    vec3 normal = oceanNormal(normalize(vSphereDir), radial);
    OceanIfftSampleData fragmentIfft = oceanIfftSampleData(normalize(vSphereDir));
    float fragmentIfftSlope = length(fragmentIfft.slope) * uIfftEnabled;
    float fragmentIfftFoam = fragmentIfft.foam * uIfftEnabled;
    float detailAmount = smoothstep(0.75, 2.70, uOceanWaveDetail);
    float closeDetail = 1.0 - smoothstep(140.0, 2200.0, distance(cameraPosition, vWorldPos));
    float microWeight = detailAmount * closeDetail * uIfftEnabled;
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
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float sunFacing = dot(radial, lightDir);
    float day = smoothstep(-0.28, 0.52, sunFacing);
    float reflectionLight = smoothstep(-0.10, 0.58, sunFacing);
    float direct = max(dot(normal, lightDir), 0.0);
    float viewFacing = max(dot(normal, viewDir), 0.0);
    float fresnel = pow(1.0 - viewFacing, 4.6);
    float litFresnel = fresnel * (0.035 + reflectionLight * 0.965);

    float depth = oceanSaturate(waterDepthRaw / max(uDepthRange, 0.001));
    float shallow = 1.0 - smoothstep(0.025, 0.16, waterDepthRaw);
    vec3 deepColor = mix(uOceanDeepColor, vec3(0.030, 0.105, 0.145), uIceBlend * 0.22);
    vec3 shelfColor = mix(uOceanShallowColor, vec3(0.245, 0.515, 0.610), uIceBlend * 0.32);
    vec3 waterColor = mix(shelfColor, deepColor, depth);
    waterColor = mix(waterColor, uAtmosphereColor * 0.42 + uAtmosphereLightColor * 0.08, litFresnel * (0.34 + day * 0.20));

    float halfSpec = pow(max(dot(normalize(lightDir + viewDir), normal), 0.0), 160.0);
    float broadSpec = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), 42.0);
    float glitter = 0.0;
    if (uOceanQuality > 0.5) {
      float glintNoise = uOceanQuality > 1.5
        ? terrainFbm(normalize(vSphereDir) * (uWaveScale * 0.9) + vec3(uTime * 0.08), uSeed + 2211.0, 2, 2.4, 0.42) * 0.5 + 0.5
        : terrainFbm(normalize(vSphereDir) * (uWaveScale * 0.42) + vec3(uTime * 0.045), uSeed + 2211.0, 1, 2.2, 0.42) * 0.5 + 0.5;
      glitter = smoothstep(0.68, 1.14, glintNoise + fragmentIfftSlope * 0.92 + max(vWave, 0.0) * 0.16) * pow(direct, 2.0);
    }
    vec3 specular = uSunColor * day * (halfSpec * 1.10 + broadSpec * 0.28 + glitter * 0.16) * uOceanSpecularStrength;

    float shoreBand = smoothstep(0.003, 0.014, waterDepthRaw) * (1.0 - smoothstep(0.018, 0.050, waterDepthRaw));
    float foamNoise = uOceanQuality > 0.5
      ? terrainFbm(normalize(vSphereDir) * (uWaveScale * 0.34) + vec3(-uTime * 0.035, uTime * 0.018, uTime * 0.011), uSeed + 3019.0, uOceanQuality > 1.5 ? 3 : 1, 2.1, 0.5) * 0.5 + 0.5
      : 0.62;
    float foamDetail = uOceanQuality > 0.5
      ? terrainFbm(normalize(vSphereDir) * (uWaveScale * 1.16) + vec3(uTime * 0.070, -uTime * 0.038, uTime * 0.026), uSeed + 4049.0, uOceanQuality > 1.5 ? 2 : 1, 2.32, 0.44) * 0.5 + 0.5
      : 0.62;
    float foamLight = smoothstep(-0.08, 0.46, sunFacing);
    float foamVisibility = smoothstep(0.02, 0.54, sunFacing);
    float shoreFoam = shoreBand * smoothstep(0.70, 1.08, foamNoise * 0.54 + foamDetail * 0.46 + abs(vWave) * 0.18) * (0.70 + uWaterLevel * 0.22) * 0.36;
    float crestBreakup = smoothstep(0.56, 0.90, foamDetail + fragmentIfftFoam * 0.22);
    float crestFoam = smoothstep(0.36, 0.86, fragmentIfftFoam) * smoothstep(0.18, 0.58, fragmentIfftSlope + max(vWave, 0.0) * 0.12) * crestBreakup;
    crestFoam = max(crestFoam, smoothstep(0.34, 0.82, microSlope + fragmentIfftFoam * 0.35) * microWeight * 0.16);
    crestFoam *= smoothstep(0.045, 0.24, waterDepthRaw) * uIfftFoamStrength * 0.62;
    crestFoam *= mix(0.54, 0.96, clamp(uIfftChoppiness / 2.5, 0.0, 1.0));
    float foamMask = pow(max(shoreFoam, crestFoam), 1.35) * (0.04 + foamVisibility * 0.96);
    vec3 foam = uOceanFoamColor * (0.030 + foamLight * 0.970);

    vec3 nightColor = deepColor * vec3(0.035, 0.046, 0.078);
    vec3 litColor = waterColor * (0.12 + day * 0.88) + specular;
    vec3 finalColor = mix(nightColor, litColor, day);
    finalColor = mix(finalColor, foam, foamMask);
    finalColor += uAtmosphereLightColor * litFresnel * (0.018 + day * 0.065);

    float alpha = mix(0.84, 0.975, depth);
    alpha += litFresnel * 0.065 + foamMask * (0.08 + foamVisibility * 0.14);
    alpha -= shallow * 0.020;
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
      uOceanSpecularStrength: { value: params.specularStrength ?? 1 },
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
    },
  })
}

import * as THREE from 'three'
import { TERRAIN_NOISE } from '../shaders/noise.glsl'
import type { TerrainChunkSurfaceData } from './terrain-chunk'

interface OceanChunkMaterialParams {
  seed: number
  seaHeight: number
  seaRadius: number
  planetRadius: number
  terrainScale: number
  waterLevel: number
  sunPosition: THREE.Vector3
  sunColor: THREE.Color | string
  atmosphereColor: THREE.Color | string
  atmosphereLightColor: THREE.Color | string
}

interface OceanChunkLayerParams {
  surface: TerrainChunkSurfaceData
  material: THREE.ShaderMaterial
  seaHeight: number
  seaRadius: number
  planetRadius: number
}

const LOCAL_OCEAN_GLSL = /* glsl */ `
vec3 localOceanTangentFor(vec3 n) {
  vec3 t = cross(n, vec3(0.0, 1.0, 0.0));
  if (dot(t, t) < 0.0001) t = cross(n, vec3(1.0, 0.0, 0.0));
  return normalize(t);
}

vec2 localOceanUv(vec3 worldPos, vec3 sphereDir) {
  vec3 tangent = localOceanTangentFor(sphereDir);
  vec3 bitangent = normalize(cross(sphereDir, tangent));
  return vec2(dot(worldPos, tangent), dot(worldPos, bitangent));
}

float localOceanWave(vec3 worldPos, vec3 sphereDir, float time) {
  vec2 uv = localOceanUv(worldPos, sphereDir);
  float windA = dot(uv, normalize(vec2(0.86, 0.31)));
  float windB = dot(uv, normalize(vec2(-0.22, 0.98)));
  float swell = sin(windA * 0.055 + time * 0.86) * 0.34
    + sin(windB * 0.092 - time * 0.64 + 1.8) * 0.20
    + sin((windA * 0.040 + windB * 0.035) + time * 0.31 + 4.2) * 0.18;
  float patch = terrainFbm(vec3(uv * 0.0065, time * 0.030), uSeed + 5901.0, 2, 2.0, 0.52);
  float chop = terrainFbm(vec3(uv * 0.034, time * 0.120), uSeed + 6127.0, 3, 2.16, 0.45);
  float ripples = terrainFbm(vec3(uv * 0.105 + vec2(time * 0.22, -time * 0.17), time * 0.080), uSeed + 6703.0, 2, 2.35, 0.40);
  float activity = smoothstep(-0.20, 0.75, patch);
  return swell + chop * (0.16 + activity * 0.16) + ripples * activity * 0.055;
}
`

export function createOceanChunkMaterial(params: OceanChunkMaterialParams): THREE.ShaderMaterial {
  const sunColor = new THREE.Color(params.sunColor)
  const atmosphereColor = new THREE.Color(params.atmosphereColor)
  const atmosphereLightColor = new THREE.Color(params.atmosphereLightColor)
  const terrainMeters = Math.max(params.terrainScale * params.planetRadius, 1)
  const waveHeight = THREE.MathUtils.clamp(terrainMeters * 0.0012, 0.12, 2.2)

  const vertexShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uTime;
  uniform float uSeed;
  uniform float uSeaHeight;
  uniform float uWaveHeight;
  attribute float terrainHeight;
  attribute float waterDepth;

  varying vec3 vWorldPos;
  varying vec3 vSphereDir;
  varying vec3 vRadialNormal;
  varying float vTerrainHeight;
  varying float vWaterDepth;
  varying float vWave;

  ${LOCAL_OCEAN_GLSL}

  void main() {
    vec3 sphereDir = normalize(position);
    vSphereDir = sphereDir;
    vTerrainHeight = terrainHeight;
    vWaterDepth = waterDepth;
    vRadialNormal = normalize((modelMatrix * vec4(sphereDir, 0.0)).xyz);

    float shoreCalm = smoothstep(0.004, 0.055, max(waterDepth, 0.0));
    vec4 baseWorldPos = modelMatrix * vec4(position, 1.0);
    vWave = localOceanWave(baseWorldPos.xyz, vRadialNormal, uTime);
    vec3 displaced = position + sphereDir * vWave * uWaveHeight * (0.22 + shoreCalm * 0.78);

    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
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
  uniform float uWaveHeight;
  uniform float uDepthRange;
  uniform float uWaterLevel;
  uniform vec3 uSunPosition;
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereColor;
  uniform vec3 uAtmosphereLightColor;

  varying vec3 vWorldPos;
  varying vec3 vSphereDir;
  varying vec3 vRadialNormal;
  varying float vTerrainHeight;
  varying float vWaterDepth;
  varying float vWave;

  ${LOCAL_OCEAN_GLSL}

  float localOceanSaturate(float value) {
    return clamp(value, 0.0, 1.0);
  }

  vec3 localOceanNormal(vec3 worldPos, vec3 sphereDir, vec3 radialNormal) {
    vec3 tangent = localOceanTangentFor(radialNormal);
    vec3 bitangent = normalize(cross(radialNormal, tangent));
    float stepSize = 1.15;
    float center = localOceanWave(worldPos, sphereDir, uTime);
    float tx = localOceanWave(worldPos + tangent * stepSize, sphereDir, uTime) - center;
    float ty = localOceanWave(worldPos + bitangent * stepSize, sphereDir, uTime) - center;
    return normalize(radialNormal - tangent * tx * 0.52 - bitangent * ty * 0.52);
  }

  void main() {
    float waterDepthRaw = vWaterDepth;
    float waterMask = smoothstep(-0.015, 0.018, waterDepthRaw);
    if (waterMask <= 0.01) discard;

    vec3 radial = normalize(vRadialNormal);
    vec3 normal = localOceanNormal(vWorldPos, normalize(vSphereDir), radial);
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float sunFacing = dot(radial, lightDir);
    float day = smoothstep(-0.28, 0.52, sunFacing);
    float reflectionLight = smoothstep(-0.10, 0.58, sunFacing);
    float direct = max(dot(normal, lightDir), 0.0);
    float viewFacing = max(dot(normal, viewDir), 0.0);
    float fresnel = pow(1.0 - viewFacing, 4.2);
    float litFresnel = fresnel * (0.030 + reflectionLight * 0.970);

    float depth = localOceanSaturate(waterDepthRaw / max(uDepthRange, 0.001));
    vec3 shallowColor = vec3(0.020, 0.190, 0.235);
    vec3 deepColor = vec3(0.004, 0.046, 0.095);
    vec3 waterColor = mix(shallowColor, deepColor, depth);
    waterColor = mix(waterColor, uAtmosphereColor * 0.42 + uAtmosphereLightColor * 0.08, litFresnel * (0.26 + day * 0.20));

    float halfSpec = pow(max(dot(normalize(lightDir + viewDir), normal), 0.0), 96.0);
    float broadSpec = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), 28.0);
    vec3 specular = uSunColor * day * (halfSpec * 0.95 + broadSpec * 0.22) * (0.35 + direct * 0.65);

    vec2 uv = localOceanUv(vWorldPos, radial);
    float shoreBand = smoothstep(0.004, 0.030, waterDepthRaw) * (1.0 - smoothstep(0.040, 0.155, waterDepthRaw));
    float foamNoise = terrainFbm(vec3(uv * 0.020 + vec2(-uTime * 0.28, uTime * 0.17), uTime * 0.035), uSeed + 7201.0, 3, 2.05, 0.50) * 0.5 + 0.5;
    float foamLight = smoothstep(-0.08, 0.46, sunFacing);
    float foamVisibility = smoothstep(0.02, 0.54, sunFacing);
    float foamMask = shoreBand * smoothstep(0.40, 0.78, foamNoise + abs(vWave) * 0.22) * (0.72 + uWaterLevel * 0.28);
    foamMask *= 0.04 + foamVisibility * 0.96;
    vec3 foam = vec3(0.76, 0.91, 0.96) * (0.030 + foamLight * 0.970);

    vec3 nightColor = deepColor * vec3(0.035, 0.046, 0.078);
    vec3 litColor = waterColor * (0.12 + day * 0.88) + specular;
    vec3 finalColor = mix(nightColor, litColor, day);
    finalColor = mix(finalColor, foam, foamMask);
    finalColor += uAtmosphereLightColor * litFresnel * (0.018 + day * 0.060);

    float alpha = mix(0.34, 0.70, depth);
    alpha += litFresnel * 0.15 + foamMask * (0.05 + foamVisibility * 0.12);
    alpha *= waterMask;
    alpha *= mix(0.42, 1.0, reflectionLight);
    alpha = clamp(alpha, 0.0, 0.88);

    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(finalColor, alpha);
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: params.seed },
      uSeaHeight: { value: params.seaHeight },
      uWaveHeight: { value: waveHeight },
      uDepthRange: { value: 0.18 },
      uWaterLevel: { value: params.waterLevel },
      uSunPosition: { value: params.sunPosition.clone() },
      uSunColor: { value: sunColor },
      uAtmosphereColor: { value: atmosphereColor },
      uAtmosphereLightColor: { value: atmosphereLightColor },
    },
  })
}

export class OceanChunkLayer {
  readonly mesh: THREE.Mesh
  readonly waterCoverage: number
  private geometry: THREE.BufferGeometry

  constructor(params: OceanChunkLayerParams) {
    const { geometry, coverage } = buildOceanChunkGeometry(params)
    this.geometry = geometry
    this.waterCoverage = coverage
    this.mesh = new THREE.Mesh(geometry, params.material)
    this.mesh.frustumCulled = true
    this.mesh.renderOrder = 2.4
    this.mesh.visible = false
  }

  setVisible(visible: boolean) {
    this.mesh.visible = visible
  }

  dispose() {
    this.geometry.dispose()
  }
}

function buildOceanChunkGeometry(params: OceanChunkLayerParams): {
  geometry: THREE.BufferGeometry
  coverage: number
} {
  const { surface, seaHeight, seaRadius, planetRadius } = params
  const gs = surface.gridSize
  const vertexCount = gs * gs
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const terrainHeights = new Float32Array(vertexCount)
  const waterDepths = new Float32Array(vertexCount)
  const indices: number[] = []
  const dir = new THREE.Vector3()
  let wetVertices = 0

  for (let i = 0; i < vertexCount; i++) {
    dir.set(
      surface.positions[i * 3],
      surface.positions[i * 3 + 1],
      surface.positions[i * 3 + 2],
    ).normalize()

    const height = surface.heights[i]
    const depth = seaHeight - height
    if (depth > -0.012) wetVertices++

    const radius = seaRadius + Math.max(planetRadius * 0.000002, 0.025)
    positions[i * 3] = dir.x * radius
    positions[i * 3 + 1] = dir.y * radius
    positions[i * 3 + 2] = dir.z * radius
    normals[i * 3] = dir.x
    normals[i * 3 + 1] = dir.y
    normals[i * 3 + 2] = dir.z
    terrainHeights[i] = height
    waterDepths[i] = depth
  }

  const v = (x: number, y: number) => y * gs + x
  for (let y = 0; y < gs - 1; y++) {
    for (let x = 0; x < gs - 1; x++) {
      const a = v(x, y)
      const b = v(x + 1, y)
      const c = v(x, y + 1)
      const d = v(x + 1, y + 1)
      const cellDepth = Math.max(waterDepths[a], waterDepths[b], waterDepths[c], waterDepths[d])
      if (cellDepth <= -0.015) continue
      indices.push(a, b, c, b, d, c)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('terrainHeight', new THREE.BufferAttribute(terrainHeights, 1))
  geometry.setAttribute('waterDepth', new THREE.BufferAttribute(waterDepths, 1))
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1))
  geometry.computeBoundingSphere()

  return {
    geometry,
    coverage: wetVertices / Math.max(1, vertexCount),
  }
}

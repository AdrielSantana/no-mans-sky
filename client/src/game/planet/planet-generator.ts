import * as THREE from 'three'
import { TERRAIN_NOISE } from '../shaders/noise.glsl'

export interface PlanetNoiseProfile {
  seed: number
  octaves: number
  lacunarity: number
  gain: number
  frequency: number
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
        }
      case 'ice':
        return {
          seed,
          octaves: 5,
          lacunarity: 1.8,
          gain: 0.45,
          frequency: 2.5,
        }
      case 'rocky':
      default:
        return {
          seed,
          octaves: 6,
          lacunarity: 2.0,
          gain: 0.5,
          frequency: 2.0,
        }
    }
  }
}

// GPU-only terrain: geometry is a sphere grid, shader handles displacement + normals + color.
export function createPlanetMaterial(params: {
  seed: number
  planetType: string
  waterLevel: number
  terrainScale: number
  localDetailNear: number
  localDetailFar: number
  colorA: string
  colorB: string
  atmosphereColor: string
  sunPosition: THREE.Vector3
  planetRadius: number
  octaves: number
  frequency: number
}): THREE.ShaderMaterial {
  const colorA = new THREE.Color(params.colorA)
  const colorB = new THREE.Color(params.colorB)
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

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;
  varying float vDetail;

  float getHeight(vec3 sphereDir) {
    float continental = terrainFbm(sphereDir * uFrequency, uSeed, int(uOctaves), 2.0, 0.5);
    float ridges = abs(terrainFbm(sphereDir * (uFrequency * 4.2) + 17.0, uSeed + 9.7, 4, 2.1, 0.45));
    ridges = pow(1.0 - ridges, 3.2);
    float mountainMask = smoothstep(0.24, 0.72, continental);
    float mountains = ridges * mountainMask * 0.28;
    float detail = terrainFbm(sphereDir * (uFrequency * 16.0) + 43.0, uSeed + 21.0, 3, 2.0, 0.42) * 0.035;

    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      return continental * 0.05;
    }

    return continental * 0.68 + mountains + detail;
  }

  void main() {
    vec3 sphereDir = normalize(position);
    vSphereDir = sphereDir;

    float h = getHeight(sphereDir);
    vHeight = h;
    vDetail = terrainFbm(sphereDir * (uFrequency * 28.0), uSeed + 77.0, 3, 2.0, 0.5);

    float r = uPlanetRadius + h * uTerrainScale * uPlanetRadius;
    float skirtOffset = max(uPlanetRadius - length(position), 0.0);
    vec3 displaced = sphereDir * (r - skirtOffset);

    // Normal via finite differences
    float eps = 0.001;
    vec3 tangent = normalize(cross(sphereDir, vec3(0.0, 1.0, 0.0)));
    if (length(cross(sphereDir, vec3(0.0, 1.0, 0.0))) < 0.01) {
      tangent = normalize(cross(sphereDir, vec3(1.0, 0.0, 0.0)));
    }
    vec3 bitangent = normalize(cross(sphereDir, tangent));

    float hR = getHeight(normalize(sphereDir + tangent * eps));
    float hU = getHeight(normalize(sphereDir + bitangent * eps));

    vec3 pR = normalize(sphereDir + tangent * eps) * (uPlanetRadius + hR * uTerrainScale * uPlanetRadius);
    vec3 pU = normalize(sphereDir + bitangent * eps) * (uPlanetRadius + hU * uTerrainScale * uPlanetRadius);

    vNormal = normalize(cross(pR - displaced, pU - displaced));

    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uSeaHeight;
  uniform vec3 uSunPosition;
  uniform float uSeed;
  uniform float uFrequency;
  uniform float uPlanetKind;
  uniform float uLocalDetailNear;
  uniform float uLocalDetailFar;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;
  varying float vDetail;

  float saturate(float v) {
    return clamp(v, 0.0, 1.0);
  }

  vec3 rockyBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 deepRock = uColorA * 0.58;
    vec3 lowland = mix(uColorA, vec3(0.16, 0.32, 0.13), saturate(moisture * 0.7 + 0.15));
    vec3 dryland = mix(uColorA, vec3(0.62, 0.50, 0.30), saturate(1.0 - moisture));
    vec3 highRock = mix(uColorB, vec3(0.42, 0.40, 0.37), 0.45);
    vec3 snow = vec3(0.86, 0.90, 0.92);
    vec3 beach = vec3(0.76, 0.67, 0.48);

    vec3 color = mix(deepRock, mix(dryland, lowland, moisture), smoothstep(0.30, 0.58, heightNorm));
    float coast = smoothstep(uSeaHeight - 0.025, uSeaHeight + 0.025, vHeight) * (1.0 - smoothstep(uSeaHeight + 0.025, uSeaHeight + 0.09, vHeight));
    color = mix(color, beach, coast);
    color = mix(color, highRock, smoothstep(0.52, 0.76, heightNorm));
    color = mix(color, snow, smoothstep(0.68, 0.88, heightNorm + latitude * 0.18) * smoothstep(0.48, 0.88, latitude));
    color = mix(color, highRock, saturate(slope * 0.95));
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

    vec3 sphereDir = normalize(vSphereDir);
    float macro = terrainFbm(sphereDir * 38.0 + 13.0, uSeed + 601.0, 4, 2.0, 0.5);
    float grain = terrainFbm(sphereDir * 180.0 + 29.0, uSeed + 701.0, 3, 2.1, 0.45);
    float cracks = abs(terrainFbm(sphereDir * 72.0 + 53.0, uSeed + 809.0, 3, 2.2, 0.48));
    cracks = pow(1.0 - cracks, 5.0);

    float snow = smoothstep(0.68, 0.88, heightNorm + latitude * 0.18) * smoothstep(0.48, 0.88, latitude);
    float dry = saturate(1.0 - moisture);
    float rock = saturate(slope * 1.4 + smoothstep(0.55, 0.82, heightNorm));

    color *= 0.92 + macro * 0.10 + grain * 0.04;
    color = mix(color, color * (0.82 + cracks * 0.20), rock * 0.45);
    color = mix(color, color + vec3(0.07, 0.055, 0.025) * grain, dry * (1.0 - coast) * 0.45);
    color = mix(color, vec3(0.92, 0.94, 0.93) * (0.95 + grain * 0.04), snow * 0.72);
    color = mix(color, vec3(0.78, 0.70, 0.52) * (0.93 + grain * 0.08), coast * 0.75);
    return clamp(color, 0.0, 1.0);
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
    float grit = terrainFbm(sphereDir * 240.0 + 17.0, uSeed + 407.0, 2, 2.0, 0.42);
    float dune = terrainFbm(sphereDir * 36.0 + vec3(8.0, 0.0, -6.0), uSeed + 509.0, 3, 2.0, 0.5);

    float cameraDist = distance(cameraPosition, vWorldPos);
    float nearDetail = 1.0 - smoothstep(uLocalDetailNear, uLocalDetailFar, cameraDist);
    float snow = smoothstep(0.68, 0.88, smoothstep(-1.0, 1.0, vHeight) + latitude * 0.18) * smoothstep(0.48, 0.88, latitude);
    float dry = saturate(1.0 - moisture);
    float strength = 0.025 + nearDetail * 0.055;
    strength += slope * (0.065 + nearDetail * 0.05);
    strength += dry * (1.0 - coast) * (0.022 + nearDetail * 0.03);
    strength *= 1.0 - snow * 0.55;
    strength *= 1.0 - coast * 0.45;

    vec2 detail = vec2(rock + grit * 0.45, dune * dry + grit * 0.25);
    return normalize(baseNormal + tangent * detail.x * strength + bitangent * detail.y * strength);
  }

  void main() {
    float heightNorm = smoothstep(-1.0, 1.0, vHeight);
    float latitude = abs(vSphereDir.y);
    float moisture = saturate(terrainFbm(vSphereDir * (uFrequency * 2.7) + 19.0, uSeed + 31.0, 4, 2.0, 0.5) * 0.5 + 0.5);
    float slope = saturate(1.0 - dot(vNormal, normalize(vSphereDir)));
    float coast = smoothstep(uSeaHeight - 0.025, uSeaHeight + 0.025, vHeight) * (1.0 - smoothstep(uSeaHeight + 0.025, uSeaHeight + 0.09, vHeight));
    float bands = smoothstep(-0.2, 0.8, sin(vSphereDir.y * 34.0 + terrainFbm(vSphereDir * 8.0, uSeed + 5.0, 3, 2.0, 0.5) * 2.2) * 0.5 + 0.5);
    float turbulence = saturate(vDetail * 0.5 + 0.5);

    vec3 terrainColor;
    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      terrainColor = gasBands(latitude, bands, turbulence);
    } else if (uPlanetKind > 1.5) {
      terrainColor = iceBiome(heightNorm, latitude, moisture, slope);
    } else {
      terrainColor = rockyBiome(heightNorm, latitude, moisture, slope);
    }

    terrainColor = materialAlbedoDetail(terrainColor, heightNorm, latitude, moisture, slope, coast);
    terrainColor = applyOceanFloor(terrainColor, vHeight, slope);
    terrainColor *= 0.88 + vDetail * 0.08;

    // Diffuse lighting
    vec3 finalNormal = detailNormal(normalize(vNormal), latitude, moisture, slope, coast);
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    float diffuse = max(dot(finalNormal, lightDir), 0.0);
    float ambient = 0.15;

    // Rim highlight
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float rim = 1.0 - max(dot(viewDir, finalNormal), 0.0);
    rim = pow(rim, 3.0) * 0.15;

    vec3 finalColor = terrainColor * (ambient + diffuse * 0.85) + vec3(0.3, 0.5, 0.8) * rim;
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
  sunPosition: THREE.Vector3
}): THREE.ShaderMaterial {
  const planetKind = params.planetType === 'gas'
    ? PlanetKind.Gas
    : params.planetType === 'ice'
      ? PlanetKind.Ice
      : PlanetKind.Rocky

  const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uOceanLift;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vSphereDir;

  void main() {
    vSphereDir = normalize(position);
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

  uniform float uSeed;
  uniform float uPlanetRadius;
  uniform float uSeaHeight;
  uniform float uFrequency;
  uniform float uOctaves;
  uniform float uPlanetKind;
  uniform vec3 uSunPosition;
  uniform float uTime;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vSphereDir;

  float getTerrainHeight(vec3 sphereDir) {
    float continental = terrainFbm(sphereDir * uFrequency, uSeed, int(uOctaves), 2.0, 0.5);
    float ridges = abs(terrainFbm(sphereDir * (uFrequency * 4.2) + 17.0, uSeed + 9.7, 4, 2.1, 0.45));
    ridges = pow(1.0 - ridges, 3.2);
    float mountainMask = smoothstep(0.24, 0.72, continental);
    float mountains = ridges * mountainMask * 0.28;
    float detail = terrainFbm(sphereDir * (uFrequency * 16.0) + 43.0, uSeed + 21.0, 3, 2.0, 0.42) * 0.035;

    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      return continental * 0.05;
    }

    return continental * 0.68 + mountains + detail;
  }

  void main() {
    float terrainHeight = getTerrainHeight(normalize(vSphereDir));
    float waterCoverage = smoothstep(uSeaHeight + 0.018, uSeaHeight - 0.012, terrainHeight);
    if (waterCoverage <= 0.01) discard;

    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    vec3 halfDir = normalize(lightDir + viewDir);
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 4.0);
    float diffuse = max(dot(vNormal, lightDir), 0.0);

    float cameraDist = distance(cameraPosition, vWorldPos);
    float farWater = smoothstep(0.65, 2.4, cameraDist / uPlanetRadius);
    float detailFade = 1.0 - farWater;

    vec3 flowA = vec3(uTime * 0.018, 0.0, -uTime * 0.013);
    vec3 flowB = vec3(-uTime * 0.009, uTime * 0.014, uTime * 0.006);
    float swell = terrainFbm(vSphereDir * 11.0 + flowA, uSeed + 101.0, 4, 2.0, 0.52);
    float chop = terrainFbm(vSphereDir * 42.0 + flowB, uSeed + 203.0, 3, 2.2, 0.46) * detailFade;
    float foam = smoothstep(0.58, 0.86, swell + chop * 0.35) * detailFade * waterCoverage;
    float surface = clamp(swell * 0.5 + chop * 0.18 + 0.5, 0.0, 1.0);
    float specular = pow(max(dot(vNormal, halfDir), 0.0), 96.0) * (0.35 + surface * 0.65);

    vec3 shallow = vec3(0.08, 0.38, 0.48);
    vec3 deep = vec3(0.02, 0.09, 0.22);
    vec3 color = mix(deep, shallow, surface * 0.22 + diffuse * 0.28);
    vec3 reflected = vec3(0.55, 0.75, 1.0) * fresnel * 0.75;
    color = mix(color, vec3(0.75, 0.92, 0.95), foam * 0.18);
    color += reflected + specular * vec3(1.0, 0.92, 0.78);

    float alpha = (mix(0.58, 0.98, farWater) + fresnel * 0.08) * waterCoverage;
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
      uPlanetKind: { value: planetKind },
      uOceanLift: { value: 0 },
      uSunPosition: { value: params.sunPosition.clone() },
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
  sunPosition: THREE.Vector3
  octaves: number
  frequency: number
}): THREE.ShaderMaterial {
  const colorA = new THREE.Color(params.colorA)
  const colorB = new THREE.Color(params.colorB)
  const planetKind = params.planetType === 'gas'
    ? PlanetKind.Gas
    : params.planetType === 'ice'
      ? PlanetKind.Ice
      : PlanetKind.Rocky

  const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vSphereDir;

  void main() {
    vSphereDir = normalize(position);
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
  `

  const fragmentShader = /* glsl */ `
  ${TERRAIN_NOISE}
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uSunPosition;
  uniform float uSeed;
  uniform float uFrequency;
  uniform float uOctaves;
  uniform float uSeaHeight;
  uniform float uPlanetKind;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vSphereDir;

  float getTerrainHeight(vec3 sphereDir) {
    float continental = terrainFbm(sphereDir * uFrequency, uSeed, int(uOctaves), 2.0, 0.5);
    float ridges = abs(terrainFbm(sphereDir * (uFrequency * 4.2) + 17.0, uSeed + 9.7, 4, 2.1, 0.45));
    ridges = pow(1.0 - ridges, 3.2);
    float mountainMask = smoothstep(0.24, 0.72, continental);
    float mountains = ridges * mountainMask * 0.28;
    float detail = terrainFbm(sphereDir * (uFrequency * 16.0) + 43.0, uSeed + 21.0, 3, 2.0, 0.42) * 0.035;

    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      return continental * 0.05;
    }

    return continental * 0.68 + mountains + detail;
  }

  void main() {
    float latitude = abs(vSphereDir.y);
    float moisture = clamp(terrainFbm(vSphereDir * (uFrequency * 2.4) + 19.0, uSeed + 31.0, 4, 2.0, 0.5) * 0.5 + 0.5, 0.0, 1.0);
    float broad = clamp(terrainFbm(vSphereDir * uFrequency, uSeed, 5, 2.0, 0.5) * 0.5 + 0.5, 0.0, 1.0);
    float bands = smoothstep(-0.2, 0.8, sin(vSphereDir.y * 34.0 + terrainFbm(vSphereDir * 8.0, uSeed + 5.0, 3, 2.0, 0.5) * 2.2) * 0.5 + 0.5);

    vec3 terrain = mix(uColorA * 0.75, uColorB, broad);
    terrain = mix(terrain, vec3(0.14, 0.30, 0.13), moisture * 0.35);
    terrain = mix(terrain, vec3(0.86, 0.90, 0.92), smoothstep(0.70, 0.92, broad + latitude * 0.16) * smoothstep(0.55, 0.9, latitude));

    if (uPlanetKind > 0.5 && uPlanetKind < 1.5) {
      vec3 bandA = mix(uColorA, vec3(0.95, 0.74, 0.48), 0.35);
      vec3 bandB = mix(uColorB, vec3(0.60, 0.34, 0.18), 0.35);
      terrain = mix(bandA, bandB, bands);
    } else {
      float height = getTerrainHeight(normalize(vSphereDir));
      float underwater = smoothstep(uSeaHeight + 0.018, uSeaHeight - 0.018, height);
      float shelf = smoothstep(uSeaHeight - 0.18, uSeaHeight + 0.02, height);
      vec3 oceanFloor = mix(vec3(0.012, 0.045, 0.070), vec3(0.045, 0.115, 0.125), shelf);
      terrain = mix(terrain, oceanFloor, underwater);
    }

    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    float diffuse = max(dot(normalize(vNormal), lightDir), 0.0);
    vec3 finalColor = terrain * (0.18 + diffuse * 0.82);
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
      uSeaHeight: { value: getSeaHeight(params.waterLevel, params.planetType) },
      uPlanetKind: { value: planetKind },
      uColorA: { value: colorA },
      uColorB: { value: colorB },
      uSunPosition: { value: params.sunPosition.clone() },
    },
  })
}

export function createAtmosphereMaterial(params: {
  atmosphereColor: string
  density: number
  sunPosition: THREE.Vector3
}): THREE.ShaderMaterial {
  const color = new THREE.Color(params.atmosphereColor)

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
  uniform vec3 uSunPosition;
  uniform float uDensity;

  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    float nDotV = max(dot(viewDir, vNormal), 0.0);
    float rim = pow(1.0 - nDotV, 3.0);
    float outerFade = smoothstep(0.05, 0.85, rim) * (1.0 - smoothstep(0.86, 1.0, rim) * 0.35);
    float day = max(dot(vNormal, lightDir), 0.0) * 0.7 + 0.3;
    float alpha = outerFade * uDensity * day * 0.28;
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(uAtmosphereColor * day, alpha);
  }
  `

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uAtmosphereColor: { value: color },
      uSunPosition: { value: params.sunPosition.clone() },
      uDensity: { value: params.density },
    },
  })
}

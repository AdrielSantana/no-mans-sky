import * as THREE from 'three'
import { TERRAIN_NOISE } from '../shaders/noise.glsl'

export interface PlanetNoiseProfile {
  seed: number
  octaves: number
  lacunarity: number
  gain: number
  frequency: number
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
  waterLevel: number
  terrainScale: number
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

  const vertexShader = /* glsl */ `
  ${TERRAIN_NOISE}

  uniform float uSeed;
  uniform float uTerrainScale;
  uniform float uPlanetRadius;
  uniform float uFrequency;
  uniform float uOctaves;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;

  float getHeight(vec3 sphereDir) {
    return terrainFbm(sphereDir * uFrequency, uSeed, int(uOctaves), 2.0, 0.5);
  }

  void main() {
    vec3 sphereDir = normalize(position);
    vSphereDir = sphereDir;

    float h = getHeight(sphereDir);
    vHeight = h;

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
  }
  `

  const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uWaterLevel;
  uniform vec3 uSunPosition;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying vec3 vSphereDir;

  void main() {
    float heightNorm = smoothstep(-1.0, 1.0, vHeight);
    vec3 terrainColor = mix(uColorA, uColorB, heightNorm);

    // Water
    if (vHeight < uWaterLevel) {
      vec3 waterColor = vec3(0.1, 0.3, 0.6);
      float waterDepth = smoothstep(uWaterLevel, uWaterLevel - 0.3, vHeight);
      terrainColor = mix(terrainColor, waterColor, waterDepth * 0.8);
    }

    // Diffuse lighting
    vec3 lightDir = normalize(uSunPosition - vWorldPos);
    float diffuse = max(dot(vNormal, lightDir), 0.0);
    float ambient = 0.15;

    // Rim highlight
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float rim = 1.0 - max(dot(viewDir, vNormal), 0.0);
    rim = pow(rim, 3.0) * 0.15;

    vec3 finalColor = terrainColor * (ambient + diffuse * 0.85) + vec3(0.3, 0.5, 0.8) * rim;
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
      uWaterLevel: { value: params.waterLevel },
      uColorA: { value: colorA },
      uColorB: { value: colorB },
      uSunPosition: { value: params.sunPosition.clone() },
    },
  })
}

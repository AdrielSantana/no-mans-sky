import * as THREE from 'three'
import type { PlanetWalkerTarget } from '../planet-walker-controller'
import { atmosphereDepthAt } from '../planet-sunlight'
import { EXPLORER_PALETTE_GLSL } from '../explorer-palette'

/** World-lit ceramic, oxidised trim and smoked glass. No studio environment or
 * per-ship scene lights: adding remote ships must not brighten existing hulls. */
export function createShipMaterial(source: THREE.MeshStandardMaterial): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: source.side,
    uniforms: {
      uMap: { value: source.map }, uNormalMap: { value: source.normalMap },
      uHasNormal: { value: source.normalMap ? 1 : 0 },
      uRoughnessMap: { value: source.roughnessMap }, uHasRoughness: { value: source.roughnessMap ? 1 : 0 },
      uSunDirection: { value: new THREE.Vector3(0,1,0) }, uSunColor: { value: new THREE.Color(0xffe3ba) },
      uSunlight: { value: 1 }, uUp: { value: new THREE.Vector3(0,1,0) },
      uAtmosphere: { value: 0 }, uSkyColor: { value: new THREE.Color('#a2b8bc') },
      uCloudMask: { value: null }, uCloudStrength: { value: 0 }, uCloudOffset: { value: 0 },
      uCloudHeight: { value: .045 }, uLocalUp: { value: new THREE.Vector3(0,1,0) },
      uLocalSun: { value: new THREE.Vector3(0,1,0) },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vViewPosition;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uMap, uNormalMap, uRoughnessMap, uCloudMask;
      uniform float uHasNormal, uHasRoughness, uSunlight, uAtmosphere;
      uniform float uCloudStrength, uCloudOffset, uCloudHeight;
      uniform vec3 uSunDirection, uSunColor, uUp, uSkyColor, uLocalUp, uLocalSun;
      varying vec2 vUv;
      varying vec3 vViewPosition, vNormal;
      ${EXPLORER_PALETTE_GLSL}
      float cloudShade() {
        if (uCloudStrength < 0.001) return 1.0;
        float mu = dot(uLocalUp, uLocalSun);
        vec3 dir = normalize(uLocalUp + uLocalSun * uCloudHeight / max(mu, 0.18));
        vec2 uv = vec2(fract(atan(dir.x, dir.z) / 6.28318530718 + 0.5 + uCloudOffset),
          clamp(0.5 - asin(clamp(dir.y,-1.0,1.0)) / 3.14159265359,0.0,1.0));
        float mask = pow(smoothstep(0.05,0.96,texture2D(uCloudMask,uv).r),0.58);
        return clamp(1.0 - mask * uCloudStrength * smoothstep(-0.08,0.62,mu) * 0.55, 0.12, 1.0);
      }
      void main() {
        vec3 source = texture2D(uMap, vUv).rgb;
        vec3 albedo = explorerPalette(source, 1.0);
        // The source atlas identifies the bright cyan cockpit separately from
        // the darker petrol hull. Preserve its painted seams, suppress baked glare.
        float glass = smoothstep(0.07, 0.19, source.b - source.r)
          * smoothstep(0.16, 0.36, source.g);
        albedo = mix(albedo, vec3(0.022,0.072,0.079) * (0.75 + source.g * 0.4), glass);
        vec3 n = normalize(vNormal);
        if (uHasNormal > 0.5) {
          vec3 q0 = dFdx(vViewPosition), q1 = dFdy(vViewPosition);
          vec2 uv0 = dFdx(vUv), uv1 = dFdy(vUv);
          vec3 s = q0 * uv1.y - q1 * uv0.y, t = -q0 * uv1.x + q1 * uv0.x;
          float determinant = uv0.x * uv1.y - uv0.y * uv1.x;
          if (dot(s,s) > 1e-14 && dot(t,t) > 1e-14) {
            vec3 detail = texture2D(uNormalMap,vUv).xyz * 2.0 - 1.0;
            detail.xy *= mix(0.32,0.07,glass);
            n = normalize(normalize(s) * sign(determinant) * detail.x
              + normalize(t) * sign(determinant) * detail.y + n * detail.z);
          }
        }
        vec3 l = normalize((viewMatrix * vec4(uSunDirection,0.0)).xyz);
        vec3 up = normalize((viewMatrix * vec4(uUp,0.0)).xyz);
        vec3 v = normalize(-vViewPosition);
        float ndl = max(dot(n,l),0.0), ndv = clamp(dot(n,v),0.0,1.0);
        float mu = dot(uUp,uSunDirection);
        float sunset = (1.0 - smoothstep(0.0,0.42,mu)) * uAtmosphere;
        vec3 sunTint = mix(uSunColor, uSunColor * vec3(1.0,0.68,0.44), sunset * 0.5);
        float sunlight = uSunlight * cloudShade();
        float skyFacing = clamp(dot(n,up)*0.5+0.5,0.0,1.0);
        vec3 ambient = vec3(0.008,0.011,0.016)
          + uSkyColor * uAtmosphere * uSunlight * (0.035 + skyFacing * 0.13)
          + vec3(0.060,0.052,0.039) * uAtmosphere * uSunlight * (1.0-skyFacing);
        vec3 color = albedo * (ambient + sunTint * sunlight * (ndl * 1.06 + 0.07));
        vec2 packed = uHasRoughness > 0.5 ? texture2D(uRoughnessMap,vUv).gb : vec2(0.75,0.0);
        float roughness = mix(clamp(packed.x * 0.55 + 0.40,0.62,0.92),0.28,glass);
        vec3 h = (l+v) / max(length(l+v),0.00001);
        float specular = pow(max(dot(n,h),0.0),mix(12.0,90.0,1.0-roughness));
        float fresnel = pow(1.0-ndv,5.0);
        vec3 specularColor = mix(vec3(0.13),albedo*0.48,packed.y*0.35);
        specularColor = mix(specularColor,vec3(0.18,0.30,0.32),glass);
        color += sunTint * specularColor * specular * sunlight * ndl;
        color += uSkyColor * fresnel * glass * uAtmosphere * uSunlight * 0.10;
        gl_FragColor = vec4(color,1.0);
        #include <logdepthbuf_fragment>
      }
    `,
  })
}

const inverse = new THREE.Quaternion()
export function updateShipMaterial(material: THREE.ShaderMaterial, position: THREE.Vector3,
  sunDirection: THREE.Vector3, sunColor: THREE.Color, sunlight: number, target?: PlanetWalkerTarget): void {
  const u = material.uniforms
  u.uSunDirection.value.copy(sunDirection); u.uSunColor.value.copy(sunColor); u.uSunlight.value = sunlight
  u.uAtmosphere.value = 0; u.uCloudStrength.value = 0
  if (!target) return
  u.uUp.value.copy(position).sub(target.worldPosition).normalize()
  const radius = position.distanceTo(target.worldPosition)
  u.uAtmosphere.value = atmosphereDepthAt(target.terrain.radius,target.terrain.radius,radius) * target.atmosphereDensity
  u.uSkyColor.value.set(target.atmosphereColor)
  const cloud = target.cloudShadow
  if (cloud && radius < target.terrain.radius * (1 + cloud.height)) {
    inverse.copy(target.worldQuaternion).invert()
    u.uLocalUp.value.copy(u.uUp.value).applyQuaternion(inverse)
    u.uLocalSun.value.copy(sunDirection).applyQuaternion(inverse)
    u.uCloudMask.value = cloud.mask; u.uCloudOffset.value = cloud.maskOffset
    u.uCloudHeight.value = cloud.height; u.uCloudStrength.value = cloud.strength
  }
}

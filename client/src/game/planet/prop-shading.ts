import * as THREE from 'three'

// Shading and wind code shared by the trunk material (planet-props.ts) and the
// foliage material (tree-foliage.ts).
//
// It lives in its own module for two reasons. The obvious one is that both
// materials would otherwise duplicate ~60 lines of GLSL and drift apart, and a
// leaf lit differently from the branch it hangs on reads as a bug immediately.
// The less obvious one is the wind: foliage cards are positioned relative to a
// pivot on a branch, so the card and the branch MUST be displaced by the exact
// same function evaluated at the same point, or the leaves slide off the tree.
// Sharing the source is the only way to guarantee that.

// ── Lighting ──────────────────────────────────────────────
// Declarations for the uniforms the light function reads.
export const PROP_LIGHT_PARS_GLSL = /* glsl */ `
  uniform vec3 uSunColor;
  uniform vec3 uAtmosphereLightColor;
  uniform float uAtmosphereInfluence;
`

// Extracted verbatim from the trunk vertex shader. Every expression is in its
// original order: this is a move, not a rewrite, so trunk lighting is unchanged.
//
// PROP_TRANSLUCENT adds the one term foliage needs and trunks do not -- light
// coming through a thin leaf from behind. It is compiled out entirely rather
// than multiplied by zero, so the trunk pays nothing for it.
export const PROP_LIGHT_FN_GLSL = /* glsl */ `
  vec3 computePropLight(
    vec3 worldNormal,
    vec3 upDir,
    vec3 sunDir,
    float terrainSunLight
    #if PROP_TRANSLUCENT == 1
      , float translucency
    #endif
  ) {
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

    vec3 light = ambient + sunlight * clamp(terrainSunLight, 0.0, 1.0) + terrain;

    #if PROP_TRANSLUCENT == 1
      // Light transmitted through the blade. Strongest when the sun is behind
      // the leaf relative to the viewer, which is what makes a canopy glow at
      // low sun instead of going flat black.
      float back = max(-dot(worldNormal, sunDir), 0.0);
      float through = pow(back, 1.6) * 0.65 + max(dot(worldNormal, sunDir) * 0.5 + 0.5, 0.0) * 0.18;
      light += sunTint * through * translucency * day * clamp(terrainSunLight, 0.0, 1.0);
    #endif

    return max(light, minimumLight);
  }
`

// ── Wind ──────────────────────────────────────────────────
export const PROP_WIND_PARS_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uWindStrength;

  // Lateral displacement at the tip as a fraction of tree height, at full gust
  // with uWindStrength 1. It lives here rather than in either material because
  // the trunk and its foliage must sway by exactly the same amount -- a
  // mismatch of any size makes the leaves drift off the branches over a gust.
  #define PROP_WIND_STIFFNESS 0.035
`

// The same wind field fluffy-grass.ts uses -- identical directions, identical
// frequencies, identical argument (the instance origin in planet-local space).
// A gust that leans the grass therefore leans the trees it blows through, which
// is the whole point of not giving trees their own private wind.
//
// `local` is model space, where the mesh is normalised to y in [0, 1], so the
// returned offset is a fraction of tree height and scales with the instance.
//
// The lever is y^2: a tree is a cantilever, its base does not move, and the tip
// moves most. Bare branches are stiff, so `stiffness` is small by default --
// anything larger and the trunk reads as rubber rather than wood.
export const PROP_WIND_FN_GLSL = /* glsl */ `
  // The slow swell that makes wind arrive in gusts instead of at one constant
  // strength. Factored out because the branch bend and the leaf flutter both
  // ride it: a canopy fluttering at a fixed rate while the branches surge
  // reads as two animations that have nothing to do with each other.
  float propWindGust(vec3 instanceOrigin) {
    vec3 windDirA = normalize(vec3(0.74, 0.18, -0.65));
    return smoothstep(-0.35, 0.95, sin(dot(instanceOrigin, windDirA) * 0.012 - uTime * 0.55));
  }

  vec3 propWindSway(
    vec3 local,
    vec3 instanceOrigin,
    vec3 axisX,
    vec3 axisZ,
    float treeHeight,
    float stiffness
  ) {
    vec3 windDirA = normalize(vec3(0.74, 0.18, -0.65));
    vec3 windDirB = normalize(vec3(-0.32, 0.09, -0.94));

    // A tall tree is a longer, slower pendulum. Without this every tree in the
    // forest oscillates at exactly the same rate and the whole stand pulses.
    float rate = inversesqrt(max(treeHeight, 1.0)) * 2.4;
    float waveA = sin(dot(instanceOrigin, windDirA) * 0.040 + uTime * 1.35 * rate);
    float waveB = sin(dot(instanceOrigin, windDirB) * 0.075 + uTime * 2.10 * rate + 1.7);
    float gust = (waveA * 0.72 + waveB * 0.28) * (0.45 + propWindGust(instanceOrigin) * 0.75);
    float bend = local.y * local.y * uWindStrength * gust * stiffness;

    // Resolve the planet-space wind into the tree's own local axes, exactly as
    // the grass does. Trees are randomly spun about their up axis, so bending
    // along model X would send neighbouring trees in unrelated directions under
    // a single gust.
    vec3 up = normalize(instanceOrigin);
    vec3 windTangent = windDirA - up * dot(windDirA, up);
    if (dot(windTangent, windTangent) < 0.0025) {
      windTangent = windDirB - up * dot(windDirB, up);
    }
    float bendX = 1.0;
    float bendZ = 0.0;
    if (dot(windTangent, windTangent) > 1e-8) {
      windTangent = normalize(windTangent);
      bendX = dot(windTangent, axisX);
      bendZ = dot(windTangent, axisZ);
    }
    return vec3(bend * bendX, 0.0, bend * bendZ);
  }
`

// ── Cloud shadow ──────────────────────────────────────────
export const PROP_CLOUD_PARS_GLSL = /* glsl */ `
  uniform sampler2D uCloudMask;
  uniform float uCloudMaskOffset;
  uniform float uCloudHeight;
  uniform float uCloudShadowStrength;
  uniform float uCloudShadowInfluence;
  uniform vec3 uCloudLocalSunDirection;
`

export const PROP_CLOUD_FN_GLSL = /* glsl */ `
  vec2 propCloudMaskUv(vec3 dir) {
    vec3 n = normalize(dir);
    float lon = atan(n.x, n.z);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    return vec2(
      fract(lon / 6.28318530718 + 0.5 + uCloudMaskOffset),
      clamp(0.5 - lat / 3.14159265359, 0.0, 1.0)
    );
  }

  float propCloudShadowMask(vec3 localPlanetDir) {
    if (uCloudShadowStrength <= 0.001 || uCloudShadowInfluence <= 0.001) return 0.0;
    vec3 surfaceDir = normalize(localPlanetDir);
    vec3 sunDir = normalize(uCloudLocalSunDirection);
    float daylight = smoothstep(-0.08, 0.62, dot(surfaceDir, sunDir));
    float offset = clamp(uCloudHeight, 0.0, 0.20) * 2.8 + 0.018;
    vec3 projectedDir = normalize(surfaceDir + sunDir * offset);
    float macroMask = texture2D(uCloudMask, propCloudMaskUv(projectedDir)).r;
    float shadow = pow(smoothstep(0.05, 0.96, macroMask), 0.58);
    float strength = clamp(uCloudShadowStrength * 0.42, 0.0, 2.2);
    return shadow * daylight * strength * clamp(uCloudShadowInfluence, 0.0, 1.0);
  }
`

// Uniforms every prop material needs, whatever it draws. Kept here so
// updatePropMaterial can write them without knowing which material it holds.
export interface PropSharedUniforms {
  [name: string]: THREE.IUniform
}

export function createPropSharedUniforms(cloudMask: THREE.Texture): PropSharedUniforms {
  return {
    uSunPosition: { value: new THREE.Vector3(0, 1, 0) },
    uPlanetCenter: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color(0xfff2c8) },
    uAtmosphereLightColor: { value: new THREE.Color(0xc4d5df) },
    uAtmosphereInfluence: { value: 1 },
    uTerrainAoStrength: { value: 0.45 },
    uCloudHeight: { value: 0.045 },
    uCloudShadowStrength: { value: 0 },
    uCloudShadowInfluence: { value: 1 },
    uCloudMask: { value: cloudMask },
    uCloudMaskOffset: { value: 0 },
    uCloudLocalSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uTime: { value: 0 },
    uWindStrength: { value: 0.34 },
  }
}

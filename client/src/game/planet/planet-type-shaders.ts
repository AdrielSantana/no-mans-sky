// Shared by near, far and orbital materials: type identity must survive LOD.
export const PLANET_TYPE_BIOMES_GLSL = /* glsl */ `
  float typeHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float typeNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(mix(mix(typeHash(i), typeHash(i + vec3(1,0,0)), f.x),
      mix(typeHash(i + vec3(0,1,0)), typeHash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(typeHash(i + vec3(0,0,1)), typeHash(i + vec3(1,0,1)), f.x),
      mix(typeHash(i + vec3(0,1,1)), typeHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  vec3 iceBiome(float heightNorm, float latitude, float moisture, float slope) {
    vec3 d = normalize(vSphereDir);
    vec3 p = d * uPlanetRadius;
    float province = typeNoise(d * 5.2 + uSeed * 0.013);
    float drift = province * 0.65 + typeNoise(d * 18.0 + province * 2.0) * 0.25
      + typeNoise(p / 320.0) * 0.10;
    vec3 warp = vec3(typeNoise(p / 210.0), typeNoise(p / 210.0 + 17.3), typeNoise(p / 210.0 - 8.7));
    float vein = abs(typeNoise(p / 65.0 + warp * 2.8) - 0.5);
    float filtered = max(fwidth(vein), 0.002);
    float cracks = (1.0 - smoothstep(0.008, 0.025 + filtered, vein))
      * (1.0 - smoothstep(0.025, 0.12, filtered));
    vec3 glacier = mix(uColorA * vec3(0.48, 0.85, 1.06), vec3(0.56, 0.78, 0.84), drift * 0.6);
    vec3 snow = vec3(0.83, 0.89, 0.90);
    float exposed = smoothstep(0.025, 0.20, slope);
    float snowCover = smoothstep(0.24, 0.62, drift + heightNorm * 0.25) * (1.0 - exposed);
    vec3 color = mix(glacier, snow, snowCover);
    color = mix(color, uColorB * 0.75, smoothstep(0.20, 0.45, slope) * 0.75);
    return mix(color, vec3(0.055, 0.24, 0.32), cracks * (1.0 - snowCover) * 0.65);
  }
  vec3 gasBands(float latitude, float bands, float turbulence) {
    vec3 d = normalize(vSphereDir);
    float seed = uSeed * 0.019;
    // Latitude-dependent advection, continuous across longitude and all LODs.
    // Bounded shear avoids stretching the texture indefinitely during long sessions.
    float wind = uTime * 0.006 + 0.14 * sin(d.y * 11.0 + uTime * 0.025);
    d.xz = mat2(cos(wind), -sin(wind), sin(wind), cos(wind)) * d.xz;
    // Three-dimensional eddies avoid a seam at longitude +/- pi.
    float flow = typeNoise(d * vec3(18.0, 7.0, 18.0) + seed);
    float curls = typeNoise(d * 57.0 + flow * 3.0 + seed);
    float phase = d.y * 43.0 + (flow - 0.5) * 4.0 + curls * 0.8;
    float belt = smoothstep(-0.55, 0.65, sin(phase));
    vec3 color = mix(uColorA, uColorB, belt * 0.85);
    float ribbons = sin(phase * 3.4 + flow * 2.0) * 0.5 + 0.5;
    color *= 0.86 + ribbons * 0.19 + curls * 0.10;
    // An elliptical vortex embedded in the belts, with a calm eye and curling rim.
    vec3 centre = normalize(vec3(cos(seed), -0.26, sin(seed)));
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), centre));
    vec3 north = cross(centre, east);
    vec2 storm = vec2(dot(d, east) / 0.23, dot(d, north) / 0.10);
    float radius = length(storm);
    float mask = (1.0 - smoothstep(0.65, 1.35, radius)) * smoothstep(0.7, 0.9, dot(d, centre));
    float spiral = sin(radius * 19.0 - atan(storm.y, storm.x) * 2.0 + flow * 3.0 - uTime * 0.08) * 0.5 + 0.5;
    vec3 vortex = mix(vec3(0.38, 0.26, 0.37), vec3(0.92, 0.72, 0.60), spiral);
    vortex = mix(vortex, vec3(0.48, 0.30, 0.34), 1.0 - smoothstep(0.08, 0.25, radius));
    return mix(color, vortex, mask * 0.86);
  }
`

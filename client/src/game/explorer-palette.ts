// Linear-light palette shared by the suit and the survey ship.
export const EXPLORER_PALETTE_GLSL = /* glsl */ `
vec3 explorerPalette(vec3 albedo, float amount) {
  float high = max(albedo.r, max(albedo.g, albedo.b));
  float low = min(albedo.r, min(albedo.g, albedo.b));
  float neutral = 1.0 - smoothstep(0.035, 0.16, high - low);
  float ceramic = neutral * smoothstep(0.12, 0.48, high);
  float copper = smoothstep(0.025, 0.18, albedo.r - albedo.g)
    * (1.0 - smoothstep(0.02, 0.12, albedo.b - albedo.g));
  vec3 result = albedo / (1.0 + albedo * 0.45);
  result = mix(result, result * vec3(0.83, 0.81, 0.74), ceramic * 0.75);
  result = mix(result, result * vec3(0.83, 0.91, 1.07), copper * 0.70);
  float luminance = dot(result, vec3(0.2126, 0.7152, 0.0722));
  result = mix(vec3(luminance), result, 0.88);
  return mix(albedo, result, amount);
}
`

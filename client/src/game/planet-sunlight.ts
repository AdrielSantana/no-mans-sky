// Today's edges, kept verbatim. They are wider than the sun's own angular size
// (4.4 degrees seen from Terra) because at ground level the terminator is
// softened by the atmosphere, not by the geometry.
const TERMINATOR_EDGE_NIGHT = -0.18
const TERMINATOR_EDGE_DAY = 0.12
// Half-angle of the sun seen from a middle orbit (radius 750 at 19500). It is a
// per-planet quantity really -- 5.9 degrees from Mercurio, 1.0 from Jupiter --
// but nothing samples it yet, so this stays a default until the sun's size and
// distance are threaded through.
const DEFAULT_SUN_ANGULAR_RADIUS = 2.2 * Math.PI / 180

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 1e-6)))
  return t * t * (3 - 2 * t)
}

/**
 * How much of the sun reaches something at `actorRadius` from a planet's
 * centre. 0 in the planet's shadow, 1 in full sunlight.
 *
 * The sun is a real body at a real position, and three's PointLight is occluded
 * by nothing, so the planet has to cast its own shadow analytically. The
 * obvious test -- "is the sun below my local horizon" -- is what this replaces:
 * that one is a hemisphere test and knows nothing about altitude, so it turns
 * you dark the moment you cross the terminator no matter how high you are.
 *
 * The real condition is the shadow cylinder: you are dark only if you are
 * behind the planet *and* within its radius of the planet-sun axis. Seen from
 * `actorRadius`, the planet subtends a half-angle of asin(R / r), so the
 * boundary sits at cos(theta) = -cos(asin(R / r)) rather than at zero.
 *
 * At the surface that reduces to the old expression exactly -- asin(1) is a
 * right angle and the offset is zero -- so ground lighting is unchanged. It
 * only starts to differ once you leave, which is the whole point: at 12.5 km
 * over a 25 km planet the old test claimed night from 100 degrees past the
 * subsolar point when the shadow really begins at 138.
 */
export function planetSunlightFactor(
  upSun: number,
  planetRadius: number,
  actorRadius: number,
  atmosphereDepth: number,
  sunAngularRadius = DEFAULT_SUN_ANGULAR_RADIUS,
): number {
  const ratio = Math.min(1, planetRadius / Math.max(actorRadius, planetRadius, 1e-6))
  const shadowBoundary = -Math.cos(Math.asin(ratio))

  // Penumbra width. In vacuum the only thing blurring the edge is the sun's own
  // angular size, and it has to be converted into the same cosine units the
  // boundary lives in: near the boundary d(cos)/d(theta) is sin(theta), which is
  // exactly `ratio`. Leaving the band in cosine units instead -- the obvious
  // shortcut -- makes the penumbra span tens of degrees once the shadow cone
  // narrows, so a ship deep in a planet's umbra reads as half lit.
  //
  // Near the ground the atmosphere widens it enormously, and `atmosphereDepth`
  // is 1 there, which reproduces the tuned surface values exactly.
  const geometric = ratio * sunAngularRadius
  const depth = Math.max(0, Math.min(1, atmosphereDepth))
  const night = -geometric + (TERMINATOR_EDGE_NIGHT + geometric) * depth
  const day = geometric + (TERMINATOR_EDGE_DAY - geometric) * depth
  return smoothstep(shadowBoundary + night, shadowBoundary + day, upSun)
}

/**
 * How deep inside the atmosphere shell something is: 1 at the ground, 0 above
 * it. Deliberately not scaled by atmosphere density -- density says how much
 * the air tints the light, not how wide the terminator is. Folding it in here
 * would also sharpen the terminator on thin-atmosphere worlds, which is
 * defensible physics but a change to lighting that is already tuned.
 */
export function atmosphereDepthAt(
  surfaceRadius: number,
  planetRadius: number,
  actorRadius: number,
  atmosphereRadiusScale = 1.08,
): number {
  const atmosphereRadius = planetRadius * atmosphereRadiusScale
  if (atmosphereRadius <= surfaceRadius) return 0
  const altitude01 = (actorRadius - surfaceRadius) / (atmosphereRadius - surfaceRadius)
  return 1 - smoothstep(0, 1, Math.max(0, Math.min(1, altitude01)))
}

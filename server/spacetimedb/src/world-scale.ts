export const WORLD_SCALE = {
  meter: 1,
  playerHeight: 1.8,
  playerEyeHeight: 1.6,

  // Target radii for future playable planets. The current seed still uses the
  // compact solar-system prototype scale until we migrate existing data/camera.
  smallPlayablePlanetRadius: 300,
  mediumPlayablePlanetRadius: 650,
  largePlayablePlanetRadius: 1100,
} as const

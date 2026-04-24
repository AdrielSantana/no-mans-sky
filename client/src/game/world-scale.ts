export const WORLD_SCALE = {
  meter: 1,
  playerHeight: 1.8,
  playerEyeHeight: 1.6,

  // Radius around the camera where ground materials should read at human scale.
  localDetailNear: 20,
  localDetailFar: 180,

  // Target radii for future playable planets. Existing seeded planets can be
  // migrated toward this range once camera/orbit navigation is ready.
  smallPlayablePlanetRadius: 300,
  mediumPlayablePlanetRadius: 650,
  largePlayablePlanetRadius: 1100,

  cameraNear: 0.05,
  cameraFar: 90000,
  orbitMinDistance: 2,
  orbitMaxDistance: 12000,
  initialCameraPosition: [0, 1800, 4200] as const,
} as const

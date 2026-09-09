import { DEFAULT_PARAMS, TYPE_PRESETS, type PlanetSettings } from './world-settings'
import { MINERAL_DAWN } from './visual-presets'

export const WORLD_REVISION = 2
export const MINERAL_WORLD: PlanetSettings = { ...DEFAULT_PARAMS, ...MINERAL_DAWN, planetRotationSpeed: 0.06 }
export const ICE_WORLD: PlanetSettings = {
  ...MINERAL_WORLD, ...TYPE_PRESETS.ice,
  seed: 812, planetType: 'ice', planetRadius: 18000, terrainScale: 0.075,
  colorA: '#79b9ce', colorB: '#536879', waterEnabled: false, waterLevel: 0,
  grassEnabled: false, treeDensity: 0, propsEnabled: false,
  atmosphereColor: '#9ebed9', atmosphereDensity: 0.48,
  atmosphereTwilightColor: '#d6a5bf', cloudCoverage: 0.25, cloudOpacity: 0.48,
  cloudColor: '#dce9f3', cloudShadow: 0.14, cloudBillboardCount: 900,
  mountainScale: 1.7, mountainBeltScale: 1.4, reliefVariety: 1.1,
  textureBlend: 0.25, microReliefMeters: 0.85, planetRotationSpeed: 0.04,
}
export const GAS_WORLD: PlanetSettings = {
  ...MINERAL_WORLD, ...TYPE_PRESETS.gas,
  seed: 941, planetType: 'gas', planetRadius: 40000, terrainScale: 0.01,
  colorA: '#e2b88f', colorB: '#777095', waterEnabled: false, waterLevel: 0,
  grassEnabled: false, propsEnabled: false, treeDensity: 0, rockDensity: 0,
  atmosphereColor: '#b3a1c7', atmosphereDensity: 0.85,
  atmosphereTwilightColor: '#e6b59f', cloudBillboards: false,
  textureBlend: 0, planetRotationSpeed: 0.12,
}

// Metres, radians and radians/second. Spread initial orbital phases around the
// entire star; each planet keeps its own radius, orbital speed and gentle day.
export const WORLD_CATALOG = [
  { name: 'Mineral Dawn', orbitRadius: 260000, startAngle: 0, orbitSpeed: 0.000001,
    rotationSpeed: Math.PI / 3000, axialTilt: 0.20, orbitalInclination: 0, settings: MINERAL_WORLD },
  { name: 'Véu de Gelo', orbitRadius: 360000, startAngle: 1.05, orbitSpeed: 0.0000007,
    rotationSpeed: Math.PI / 4500, axialTilt: 0.32, orbitalInclination: 0.03, settings: ICE_WORLD },
  { name: 'Íris', orbitRadius: 490000, startAngle: 2.15, orbitSpeed: 0.0000004,
    rotationSpeed: Math.PI / 1500, axialTilt: 0.10, orbitalInclination: -0.02, settings: GAS_WORLD },
  { name: 'Âmbar', orbitRadius: 170000, startAngle: -1.0, orbitSpeed: 0.0000014,
    rotationSpeed: Math.PI / 3800, axialTilt: 0.16, orbitalInclination: 0.02,
    settings: { ...MINERAL_WORLD, seed: 1207, planetRadius: 16000, terrainScale: 0.055,
      waterEnabled: false, waterLevel: 0, grassEnabled: false, treeDensity: 0,
      rockDensity: 0.09, colorA: '#bf986b', colorB: '#885441',
      atmosphereColor: '#d3ae8a', atmosphereDensity: 0.30,
      cloudCoverage: 0.14, cloudOpacity: 0.30, cloudBillboardCount: 500,
      mountainScale: 1.4, textureBlend: 0.28 } },
  { name: 'Cinza Serena', orbitRadius: 100000, startAngle: -2.05, orbitSpeed: 0.000002,
    rotationSpeed: Math.PI / 6200, axialTilt: 0.08, orbitalInclination: -0.04,
    settings: { ...MINERAL_WORLD, seed: 2053, planetRadius: 9000, terrainScale: 0.04,
      waterEnabled: false, waterLevel: 0, grassEnabled: false, treeDensity: 0,
      rockDensity: 0.07, colorA: '#92918b', colorB: '#5a5960',
      atmosphereDensity: 0, cloudCoverage: 0, cloudOpacity: 0, cloudShadow: 0,
      cloudBillboards: false, mountainScale: 1.1, textureBlend: 0.18 } },
  { name: 'Aurora', orbitRadius: 640000, startAngle: 3.10, orbitSpeed: 0.00000025,
    rotationSpeed: Math.PI / 5000, axialTilt: 0.45, orbitalInclination: 0.04,
    settings: { ...ICE_WORLD, seed: 3169, planetRadius: 14000, terrainScale: 0.05,
      colorA: '#acb1d1', colorB: '#706780', atmosphereColor: '#b4a8d3',
      atmosphereTwilightColor: '#e1b6d2', mountainScale: 1.3,
      cloudCoverage: 0.18, cloudBillboardCount: 650 } },
] as const

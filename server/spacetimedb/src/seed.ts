import { WORLD_SCALE } from './world-scale';

interface PlanetConfig {
  name: string
  orbitRadius: number
  bodySize: number
  color: string
  startAngle: number
  orbitSpeed: number
  rotationSpeed: number
  axialTilt: number
  orbitalInclination: number
}

export const SOLAR_SYSTEM: PlanetConfig[] = [
  { name: 'Mercurio', orbitRadius: 2400 * 3,  bodySize: 220, color: '#aaaaaa', startAngle: 0,   orbitSpeed: 0.001,  rotationSpeed: 0.005, axialTilt: 0.03,  orbitalInclination: 0.12 },
  { name: 'Venus',    orbitRadius: 4200 * 3,  bodySize: 430, color: '#e8a040', startAngle: 1.2, orbitSpeed: 0.001, rotationSpeed: 0.008, axialTilt: 3.09,  orbitalInclination: 0.06 },
  { name: 'Terra',    orbitRadius: 6500 * 3,  bodySize: WORLD_SCALE.mediumPlayablePlanetRadius, color: '#4488ff', startAngle: 2.8, orbitSpeed: 0.001, rotationSpeed: 0.02,  axialTilt: 0.41,  orbitalInclination: 0.0 },
  { name: 'Marte',    orbitRadius: 9200 * 3,  bodySize: WORLD_SCALE.smallPlayablePlanetRadius, color: '#cc4422', startAngle: 4.1, orbitSpeed: 0.001, rotationSpeed: 0.019, axialTilt: 0.44,  orbitalInclination: 0.03 },
  { name: 'Jupiter',  orbitRadius: 14500 * 3, bodySize: WORLD_SCALE.largePlayablePlanetRadius, color: '#d4a060', startAngle: 5.5, orbitSpeed: 0.001, rotationSpeed: 0.04,  axialTilt: 0.05,  orbitalInclination: 0.02 },
]

export const SUN_CONFIG = {
  name: 'Sol',
  bodySize: 750,
  color: '#ffcc00',
  rotationSpeed: 0.01,
  axialTilt: 0.13,
}

export interface PlanetParamsConfig {
  name: string
  seed: number
  planetType: string
  waterLevel: number
  terrainScale: number
  colorA: string
  colorB: string
  atmosphereColor: string
  atmosphereDensity: number
}

export const PLANET_PARAMS: PlanetParamsConfig[] = [
  { name: 'Mercurio', seed: 12345, planetType: 'rocky', waterLevel: 0, terrainScale: 0.07, colorA: '#888888', colorB: '#aaaaaa', atmosphereColor: '#000000', atmosphereDensity: 0 },
  { name: 'Venus', seed: 23456, planetType: 'rocky', waterLevel: 0, terrainScale: 0.055, colorA: '#c08020', colorB: '#e8a040', atmosphereColor: '#e8c060', atmosphereDensity: 0.8 },
  { name: 'Terra', seed: 34567, planetType: 'rocky', waterLevel: 0.4, terrainScale: 0.06, colorA: '#225588', colorB: '#88aa44', atmosphereColor: '#88aaff', atmosphereDensity: 0.5 },
  { name: 'Marte', seed: 45678, planetType: 'rocky', waterLevel: 0.05, terrainScale: 0.085, colorA: '#993311', colorB: '#cc6633', atmosphereColor: '#cc8866', atmosphereDensity: 0.15 },
  { name: 'Jupiter', seed: 56789, planetType: 'gas', waterLevel: 0, terrainScale: 0.02, colorA: '#c49050', colorB: '#d4a060', atmosphereColor: '#ddbb88', atmosphereDensity: 1.0 },
]

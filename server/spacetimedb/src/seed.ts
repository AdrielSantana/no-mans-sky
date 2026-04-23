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
  { name: 'Mercurio', orbitRadius: 4,  bodySize: 0.3,  color: '#aaaaaa', startAngle: 0,   orbitSpeed: 0.04,  rotationSpeed: 0.005, axialTilt: 0.03,  orbitalInclination: 0.12 },
  { name: 'Venus',    orbitRadius: 6,  bodySize: 0.6,  color: '#e8a040', startAngle: 1.2, orbitSpeed: 0.025, rotationSpeed: 0.008, axialTilt: 3.09,  orbitalInclination: 0.06 },
  { name: 'Terra',    orbitRadius: 8.5,bodySize: 0.65, color: '#4488ff', startAngle: 2.8, orbitSpeed: 0.018, rotationSpeed: 0.02,  axialTilt: 0.41,  orbitalInclination: 0.0 },
  { name: 'Marte',    orbitRadius: 11, bodySize: 0.45, color: '#cc4422', startAngle: 4.1, orbitSpeed: 0.012, rotationSpeed: 0.019, axialTilt: 0.44,  orbitalInclination: 0.03 },
  { name: 'Jupiter',  orbitRadius: 15, bodySize: 1.2,  color: '#d4a060', startAngle: 5.5, orbitSpeed: 0.006, rotationSpeed: 0.04,  axialTilt: 0.05,  orbitalInclination: 0.02 },
]

export const SUN_CONFIG = {
  name: 'Sol',
  bodySize: 1.5,
  color: '#ffcc00',
  rotationSpeed: 0.01,
  axialTilt: 0.13,
}

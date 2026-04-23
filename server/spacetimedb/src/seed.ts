interface PlanetConfig {
  name: string
  orbitRadius: number
  bodySize: number
  color: string
  startAngle: number
  orbitSpeed: number
  rotationSpeed: number
}

export const SOLAR_SYSTEM: PlanetConfig[] = [
  { name: 'Mercurio', orbitRadius: 4,  bodySize: 0.3,  color: '#aaaaaa', startAngle: 0,   orbitSpeed: 0.04,  rotationSpeed: 0.005 },
  { name: 'Venus',    orbitRadius: 6,  bodySize: 0.6,  color: '#e8a040', startAngle: 1.2, orbitSpeed: 0.025, rotationSpeed: 0.008 },
  { name: 'Terra',    orbitRadius: 8.5,bodySize: 0.65, color: '#4488ff', startAngle: 2.8, orbitSpeed: 0.018, rotationSpeed: 0.02 },
  { name: 'Marte',    orbitRadius: 11, bodySize: 0.45, color: '#cc4422', startAngle: 4.1, orbitSpeed: 0.012, rotationSpeed: 0.019 },
  { name: 'Jupiter',  orbitRadius: 15, bodySize: 1.2,  color: '#d4a060', startAngle: 5.5, orbitSpeed: 0.006, rotationSpeed: 0.04 },
]

export const SUN_CONFIG = {
  name: 'Sol',
  bodySize: 1.5,
  color: '#ffcc00',
  rotationSpeed: 0.01,
}

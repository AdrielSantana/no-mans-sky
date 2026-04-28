export interface EditorParams {
  seed: number
  planetType: string
  planetRadius: number
  terrainScale: number
  waterLevel: number
  colorA: string
  colorB: string
  atmosphereColor: string
  atmosphereDensity: number
}

export const DEFAULT_PARAMS: EditorParams = {
  seed: 42,
  planetType: 'rocky',
  planetRadius: 650,
  terrainScale: 0.12,
  waterLevel: 0.45,
  colorA: '#4a7c59',
  colorB: '#8b7355',
  atmosphereColor: '#6fa8dc',
  atmosphereDensity: 0.35,
}

export const RANGES = {
  planetRadius: { min: 100, max: 10000, step: 10 },
  terrainScale: { min: 0.01, max: 1.0, step: 0.01 },
  waterLevel: { min: 0, max: 1, step: 0.01 },
  atmosphereDensity: { min: 0, max: 1, step: 0.01 },
} as const

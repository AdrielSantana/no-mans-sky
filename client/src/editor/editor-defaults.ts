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
  // Noise profile overrides
  octaves: number
  lacunarity: number
  gain: number
  frequency: number
  // LOD
  lodScale: number
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
  octaves: 6,
  lacunarity: 2.0,
  gain: 0.5,
  frequency: 2.0,
  lodScale: 1.0,
}

export const RANGES = {
  planetRadius: { min: 100, max: 100000, step: 10 },
  terrainScale: { min: 0.01, max: 1.0, step: 0.01 },
  waterLevel: { min: 0, max: 1, step: 0.01 },
  atmosphereDensity: { min: 0, max: 1, step: 0.01 },
  octaves: { min: 1, max: 8, step: 1 },
  lacunarity: { min: 1.0, max: 4.0, step: 0.1 },
  gain: { min: 0.1, max: 0.9, step: 0.01 },
  frequency: { min: 0.5, max: 10.0, step: 0.1 },
  lodScale: { min: 0.2, max: 5.0, step: 0.1 },
} as const

/** Per-type presets for noise profile */
export const TYPE_PRESETS: Record<string, Pick<EditorParams, 'octaves' | 'lacunarity' | 'gain' | 'frequency'>> = {
  rocky: { octaves: 6, lacunarity: 2.0, gain: 0.5, frequency: 2.0 },
  gas: { octaves: 4, lacunarity: 2.2, gain: 0.4, frequency: 4.0 },
  ice: { octaves: 5, lacunarity: 1.8, gain: 0.45, frequency: 2.5 },
}

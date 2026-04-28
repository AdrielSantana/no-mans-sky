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
  // LOD multipliers (LOD 1-N, index 0 = LOD 1)
  lodMultipliers: number[]
  // Chunk resolution
  gridSize: number
  // Auto-calculate LOD levels from radius + gridSize
  autoLod: boolean
}

/**
 * Compute LOD levels needed to maintain consistent vertex spacing.
 * Calibrated so default config (R=650, G=33, 7 levels) is the baseline.
 */
export function computeAutoLod(radius: number, gridSize: number): number[] {
  // Target vertex spacing at max LOD. Calibrated for R=650, G=33 → 5 levels.
  // Larger value = fewer levels = bigger triangles.
  const targetSpacing = (2 * 650 / 32) / 32 // ≈ 1.27

  // N = ceil(log2(2R / ((G-1) * targetSpacing)))
  const numLevels = Math.max(1, Math.min(15, Math.ceil(
    Math.log2(2 * radius / ((gridSize - 1) * targetSpacing)),
  )))

  const multipliers: number[] = []
  let m = 5.5
  for (let i = 0; i < numLevels; i++) {
    multipliers.push(parseFloat(m.toFixed(4)))
    m /= 1.95
  }
  return multipliers
}

/** Default LOD multipliers for manual mode (5 levels) */
export const DEFAULT_LOD_MULTIPLIERS = [5.5, 2.8205, 1.4464, 0.7417, 0.3804]

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
  lodMultipliers: [...DEFAULT_LOD_MULTIPLIERS],
  gridSize: 33,
  autoLod: true,
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
  lodMultiplier: { min: 0.01, max: 10.0, step: 0.01 },
  gridSize: { min: 9, max: 129, step: 2 },
} as const

/** Per-type presets for noise profile */
export const TYPE_PRESETS: Record<string, Pick<EditorParams, 'octaves' | 'lacunarity' | 'gain' | 'frequency'>> = {
  rocky: { octaves: 6, lacunarity: 2.0, gain: 0.5, frequency: 2.0 },
  gas: { octaves: 4, lacunarity: 2.2, gain: 0.4, frequency: 4.0 },
  ice: { octaves: 5, lacunarity: 1.8, gain: 0.45, frequency: 2.5 },
}

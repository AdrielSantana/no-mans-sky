export interface EditorParams {
  seed: number
  planetType: string
  planetRadius: number
  terrainScale: number
  waterEnabled: boolean
  waterLevel: number
  oceanDeepColor: string
  oceanShallowColor: string
  oceanFoamColor: string
  oceanClarity: number
  oceanAbsorption: number
  oceanTurbidity: number
  oceanReflectionStrength: number
  oceanWaveHeight: number
  oceanWindSpeed: number
  oceanDetail: number
  oceanChoppiness: number
  oceanFoamStrength: number
  oceanSpecularStrength: number
  colorA: string
  colorB: string
  textureScale: number
  textureBlend: number
  textureNearDistance: number
  textureFadeDistance: number
  terrainAoStrength: number
  atmosphereColor: string
  atmosphereDensity: number
  atmosphereSunGlare: number
  atmosphereSunGlareSize: number
  atmosphereTwilightColor: string
  atmosphereTwilightWidth: number
  atmosphereTwilightStrength: number
  atmosphereExtinctionStrength: number
  cloudCoverage: number
  cloudOpacity: number
  cloudScale: number
  cloudSoftness: number
  cloudHeight: number
  cloudSpeed: number
  cloudShadow: number
  cloudVolume: number
  cloudStorms: number
  cloudBands: number
  cloudDetail: number
  cloudColor: string
  cloudColorStrength: number
  cloudBillboards: boolean
  cloudBillboardCount: number
  grassEnabled: boolean
  grassDensity: number
  grassHeight: number
  grassWindStrength: number
  grassDistance: number
  grassColorA: string
  grassColorB: string
  propsEnabled: boolean
  treeDensity: number
  rockDensity: number
  propDistance: number
  // Procedural leaves. The tree models are trunk and branches only, so every
  // one of these drives geometry that is generated in the engine.
  foliageDensity: number
  foliageSize: number
  foliageFlutter: number
  foliageTranslucency: number
  oakLeafShade: string
  oakLeafSun: string
  pineLeafShade: string
  pineLeafSun: string
  sunColor: string
  sunAzimuth: number
  sunElevation: number
  planetRotationSpeed: number
  // Noise profile overrides
  octaves: number
  lacunarity: number
  gain: number
  frequency: number
  warpStrength: number
  continentalScale: number
  mountainScale: number
  plainsScale: number
  hillsScale: number
  mountainBeltScale: number
  reliefVariety: number
  erosionStrength: number
  thermalStrength: number
  detailStrength: number
  microDetailStrength: number
  microDetailScale: number
  microReliefMeters: number
  // LOD multipliers (LOD 1-N, index 0 = LOD 1)
  lodMultipliers: number[]
  // Chunk resolution
  gridSize: number
  // Auto-calculate LOD levels from radius + gridSize
  autoLod: boolean
  // LOD edge stitching
  skirts: boolean
  // Horizon culling margin multiplier (1.0 = balanced, higher = more generous)
  horizonMargin: number
  // Terrain worker count. 0 = auto from hardwareConcurrency.
  terrainWorkers: number
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  toneMappingExposure: number
  underwaterFilter: boolean
  underwaterTint: string
  underwaterStrength: number
  underwaterDistortion: number
  underwaterMurk: number
  debugBloom: boolean
  debugAntialias: boolean
  debugSunShadow: boolean
  sunShadowStrength: number
  sunShadowRadius: number
  sunShadowSize: number
  debugAtmosphere: boolean
  debugClouds: boolean
  debugSimpleTerrain: boolean
  debugNearTerrainShader: boolean
  debugFarTerrainShader: boolean
  debugFallbackTerrainShader: boolean
}

/**
 * Compute LOD levels needed to maintain consistent vertex spacing.
 * Calibrated so default config (R=650, G=33) → 4 levels for performance.
 */
export function computeAutoLod(radius: number, gridSize: number): number[] {
  // Target vertex spacing at max LOD. Calibrated for R=650, G=33 → 4 levels.
  // Larger value = fewer levels = fewer chunks = fewer draw calls.
  const targetSpacing = (2 * 650 / 32) / 16 // ≈ 2.54

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

/** Default LOD multipliers for manual mode (4 levels) */
export const DEFAULT_LOD_MULTIPLIERS = [5.5, 2.8205, 1.4464, 0.7417]

export const DEFAULT_PARAMS: EditorParams = {
  seed: 67,
  planetType: 'rocky',
  planetRadius: 50000,
  terrainScale: 0.065,
  waterEnabled: true,
  waterLevel: 0.45,
  oceanDeepColor: '#073a58',
  oceanShallowColor: '#3aa4a7',
  oceanFoamColor: '#d7edf2',
  oceanClarity: 0.62,
  oceanAbsorption: 0.78,
  oceanTurbidity: 0.14,
  oceanReflectionStrength: 0.86,
  oceanWaveHeight: 12.0,
  oceanWindSpeed: 26,
  oceanDetail: 1.45,
  oceanChoppiness: 1.1,
  oceanFoamStrength: 0.38,
  oceanSpecularStrength: 1.05,
  colorA: '#26a269',
  colorB: '#63452c',
  textureScale: 92,
  textureBlend: 0.70,
  textureNearDistance: 180,
  textureFadeDistance: 420,
  terrainAoStrength: 0.45,
  atmosphereColor: '#6fa8dc',
  atmosphereDensity: 0.75,
  atmosphereSunGlare: 0.56,
  atmosphereSunGlareSize: 0.55,
  atmosphereTwilightColor: '#ff8a3d',
  atmosphereTwilightWidth: 1.12,
  atmosphereTwilightStrength: 1.02,
  atmosphereExtinctionStrength: 0.82,
  cloudCoverage: 0.68,
  cloudOpacity: 0.78,
  cloudScale: 2.7,
  cloudSoftness: 0.15,
  cloudHeight: 0.045,
  cloudSpeed: 0.100,
  cloudShadow: 2,
  cloudVolume: 1.08,
  cloudStorms: 0.62,
  cloudBands: 0.72,
  cloudDetail: 0.82,
  cloudColor: '#e8edf2',
  cloudColorStrength: 0,
  cloudBillboards: true,
  cloudBillboardCount: 3200,
  grassEnabled: true,
  grassDensity: 1.05,
  grassHeight: 1.15,
  grassWindStrength: 1.5,
  grassDistance: 1500,
  grassColorA: '#1f6f2e',
  grassColorB: '#64b94a',
  propsEnabled: true,
  treeDensity: 0.2,
  rockDensity: 0.15,
  propDistance: 2200,
  foliageDensity: 1,
  foliageSize: 0.105,
  foliageFlutter: 1,
  foliageTranslucency: 0.85,
  oakLeafShade: '#3d6a26',
  oakLeafSun: '#8cb14f',
  pineLeafShade: '#24402e',
  pineLeafSun: '#517d52',
  sunColor: '#fff2c8',
  sunAzimuth: 315,
  sunElevation: 28,
  planetRotationSpeed: 0,
  octaves: 6,
  lacunarity: 2.05,
  gain: 0.48,
  frequency: 2.35,
  warpStrength: 0.39,
  continentalScale: 1.12,
  mountainScale: 1.08,
  plainsScale: 0.68,
  hillsScale: 0.54,
  mountainBeltScale: 0.82,
  reliefVariety: 0.88,
  erosionStrength: 0.46,
  thermalStrength: 0.34,
  detailStrength: 0.66,
  microDetailStrength: 0.5,
  microDetailScale: 2.5,
  microReliefMeters: 1.5,
  lodMultipliers: [...DEFAULT_LOD_MULTIPLIERS],
  gridSize: 33,
  autoLod: true,
  skirts: true,
  horizonMargin: 0.12,
  terrainWorkers: 0,
  bloomStrength: 1.0,
  bloomRadius: 0.5,
  bloomThreshold: 1.50,
  toneMappingExposure: 1.0,
  underwaterFilter: true,
  underwaterTint: '#1b8f9d',
  underwaterStrength: 0.72,
  underwaterDistortion: 0.75,
  underwaterMurk: 0.34,
  debugBloom: true,
  debugAntialias: true,
  debugSunShadow: true,
  sunShadowStrength: 0.75,
  sunShadowRadius: 120,
  sunShadowSize: 2048,
  debugAtmosphere: true,
  debugClouds: true,
  debugSimpleTerrain: false,
  debugNearTerrainShader: true,
  debugFarTerrainShader: true,
  debugFallbackTerrainShader: true,
}

export const RANGES = {
  planetRadius: { min: 100, max: 100000, step: 10 },
  terrainScale: { min: 0.01, max: 1.0, step: 0.01 },
  waterLevel: { min: 0, max: 1, step: 0.01 },
  oceanWaveHeight: { min: 0, max: 60, step: 0.25 },
  oceanWindSpeed: { min: 4, max: 60, step: 0.5 },
  oceanDetail: { min: 0.35, max: 3.0, step: 0.01 },
  oceanChoppiness: { min: 0, max: 2.5, step: 0.01 },
  oceanFoamStrength: { min: 0, max: 2, step: 0.01 },
  oceanSpecularStrength: { min: 0, max: 2, step: 0.01 },
  oceanClarity: { min: 0, max: 1, step: 0.01 },
  oceanAbsorption: { min: 0.2, max: 2.0, step: 0.01 },
  oceanTurbidity: { min: 0, max: 1, step: 0.01 },
  oceanReflectionStrength: { min: 0, max: 1.5, step: 0.01 },
  textureScale: { min: 8, max: 240, step: 1 },
  textureBlend: { min: 0, max: 1, step: 0.01 },
  textureNearDistance: { min: 10, max: 5000, step: 10 },
  textureFadeDistance: { min: 10, max: 10000, step: 10 },
  terrainAoStrength: { min: 0, max: 2, step: 0.01 },
  atmosphereDensity: { min: 0, max: 1, step: 0.01 },
  atmosphereSunGlare: { min: 0, max: 2, step: 0.01 },
  atmosphereSunGlareSize: { min: 0.1, max: 2, step: 0.01 },
  atmosphereTwilightWidth: { min: 0.2, max: 2, step: 0.01 },
  atmosphereTwilightStrength: { min: 0, max: 2, step: 0.01 },
  atmosphereExtinctionStrength: { min: 0, max: 2, step: 0.01 },
  cloudCoverage: { min: 0, max: 1, step: 0.01 },
  cloudOpacity: { min: 0, max: 1, step: 0.01 },
  cloudScale: { min: 0.5, max: 12, step: 0.1 },
  cloudSoftness: { min: 0.02, max: 0.8, step: 0.01 },
  cloudHeight: { min: 0.005, max: 0.12, step: 0.001 },
  cloudSpeed: { min: 0, max: 0.5, step: 0.005 },
  cloudShadow: { min: 0, max: 10, step: 0.01 },
  cloudVolume: { min: 0, max: 1.5, step: 0.01 },
  cloudStorms: { min: 0, max: 1.5, step: 0.01 },
  cloudBands: { min: 0, max: 1.5, step: 0.01 },
  cloudDetail: { min: 0, max: 1.5, step: 0.01 },
  cloudBillboardCount: { min: 0, max: 5000, step: 16 },
  cloudColorStrength: { min: 0, max: 1, step: 0.01 },
  grassDensity: { min: 0, max: 1.5, step: 0.01 },
  grassHeight: { min: 0.15, max: 8, step: 0.05 },
  grassWindStrength: { min: 0, max: 2, step: 0.01 },
  grassDistance: { min: 20, max: 2500, step: 10 },
  treeDensity: { min: 0, max: 1.5, step: 0.01 },
  rockDensity: { min: 0, max: 1.5, step: 0.01 },
  propDistance: { min: 100, max: 6000, step: 25 },
  foliageDensity: { min: 0, max: 1, step: 0.01 },
  // Card size as a fraction of tree height. Past ~0.15 a card stops reading as
  // a clump of leaves and starts reading as one enormous leaf.
  foliageSize: { min: 0, max: 0.2, step: 0.002 },
  foliageFlutter: { min: 0, max: 3, step: 0.05 },
  foliageTranslucency: { min: 0, max: 2, step: 0.05 },
  sunAzimuth: { min: 0, max: 360, step: 1 },
  sunElevation: { min: -20, max: 80, step: 1 },
  planetRotationSpeed: { min: -30, max: 30, step: 0.1 },
  octaves: { min: 1, max: 8, step: 1 },
  lacunarity: { min: 1.0, max: 4.0, step: 0.1 },
  gain: { min: 0.1, max: 0.9, step: 0.01 },
  frequency: { min: 0.5, max: 10.0, step: 0.1 },
  warpStrength: { min: 0, max: 1.2, step: 0.01 },
  continentalScale: { min: 0, max: 2.0, step: 0.01 },
  mountainScale: { min: 0, max: 2.5, step: 0.01 },
  plainsScale: { min: 0, max: 2, step: 0.01 },
  hillsScale: { min: 0, max: 2, step: 0.01 },
  mountainBeltScale: { min: 0, max: 2, step: 0.01 },
  reliefVariety: { min: 0, max: 2, step: 0.01 },
  erosionStrength: { min: 0, max: 1.0, step: 0.01 },
  thermalStrength: { min: 0, max: 1.0, step: 0.01 },
  detailStrength: { min: 0, max: 1.5, step: 0.01 },
  microDetailStrength: { min: 0, max: 1.5, step: 0.01 },
  microDetailScale: { min: 0.35, max: 3.0, step: 0.01 },
  microReliefMeters: { min: 0, max: 8, step: 0.05 },
  lodMultiplier: { min: 0.01, max: 10.0, step: 0.01 },
  gridSize: { min: 9, max: 129, step: 2 },
  horizonMargin: { min: 0, max: 3, step: 0.05 },
  terrainWorkers: { min: 0, max: 12, step: 1 },
  sunShadowStrength: { min: 0, max: 1, step: 0.01 },
  sunShadowRadius: { min: 20, max: 400, step: 5 },
  sunShadowSize: { min: 512, max: 4096, step: 512 },
  bloomStrength: { min: 0, max: 3, step: 0.01 },
  bloomRadius: { min: 0, max: 1.5, step: 0.01 },
  bloomThreshold: { min: 0, max: 2, step: 0.01 },
  toneMappingExposure: { min: 0.1, max: 3, step: 0.01 },
  underwaterStrength: { min: 0, max: 1.5, step: 0.01 },
  underwaterDistortion: { min: 0, max: 2, step: 0.01 },
  underwaterMurk: { min: 0, max: 1, step: 0.01 },
} as const

/** Per-type presets for noise profile */
export const TYPE_PRESETS: Record<string, Pick<EditorParams,
  'octaves'
  | 'lacunarity'
  | 'gain'
  | 'frequency'
  | 'warpStrength'
  | 'continentalScale'
  | 'mountainScale'
  | 'plainsScale'
  | 'hillsScale'
  | 'mountainBeltScale'
  | 'reliefVariety'
  | 'erosionStrength'
  | 'thermalStrength'
  | 'detailStrength'
  | 'microDetailStrength'
  | 'microDetailScale'
  | 'microReliefMeters'
  | 'oceanDeepColor'
  | 'oceanShallowColor'
  | 'oceanFoamColor'
  | 'oceanClarity'
  | 'oceanAbsorption'
  | 'oceanTurbidity'
  | 'oceanReflectionStrength'
  | 'oceanWaveHeight'
  | 'oceanWindSpeed'
  | 'oceanDetail'
  | 'oceanChoppiness'
  | 'oceanFoamStrength'
  | 'oceanSpecularStrength'
>> = {
  rocky: {
    octaves: 6,
    lacunarity: 2.0,
    gain: 0.5,
    frequency: 2.0,
    warpStrength: 0.42,
    continentalScale: 1.0,
    mountainScale: 1.0,
    plainsScale: 0.55,
    hillsScale: 0.45,
    mountainBeltScale: 0.75,
    reliefVariety: 0.7,
    erosionStrength: 0.34,
    thermalStrength: 0.2,
    detailStrength: 0.55,
    microDetailStrength: 0.5,
    microDetailScale: 2.5,
    microReliefMeters: 1.5,
    oceanDeepColor: '#073a58',
    oceanShallowColor: '#3aa4a7',
    oceanFoamColor: '#d7edf2',
    oceanClarity: 0.62,
    oceanAbsorption: 0.78,
    oceanTurbidity: 0.14,
    oceanReflectionStrength: 0.86,
    oceanWaveHeight: 12.0,
    oceanWindSpeed: 26,
    oceanDetail: 1.45,
    oceanChoppiness: 1.1,
    oceanFoamStrength: 0.38,
    oceanSpecularStrength: 1.05,
  },
  gas: {
    octaves: 4,
    lacunarity: 2.2,
    gain: 0.4,
    frequency: 4.0,
    warpStrength: 0.18,
    continentalScale: 0.15,
    mountainScale: 0,
    plainsScale: 0,
    hillsScale: 0,
    mountainBeltScale: 0,
    reliefVariety: 0,
    erosionStrength: 0,
    thermalStrength: 0,
    detailStrength: 0.25,
    microDetailStrength: 0,
    microDetailScale: 1.0,
    microReliefMeters: 0,
    oceanDeepColor: '#073553',
    oceanShallowColor: '#3b8f99',
    oceanFoamColor: '#d7edf2',
    oceanClarity: 0.45,
    oceanAbsorption: 0.65,
    oceanTurbidity: 0.34,
    oceanReflectionStrength: 0.62,
    oceanWaveHeight: 8.0,
    oceanWindSpeed: 18,
    oceanDetail: 0.85,
    oceanChoppiness: 0.7,
    oceanFoamStrength: 0.22,
    oceanSpecularStrength: 0.8,
  },
  ice: {
    octaves: 5,
    lacunarity: 1.8,
    gain: 0.45,
    frequency: 2.5,
    warpStrength: 0.26,
    continentalScale: 0.8,
    mountainScale: 0.72,
    plainsScale: 0.72,
    hillsScale: 0.30,
    mountainBeltScale: 0.45,
    reliefVariety: 0.55,
    erosionStrength: 0.16,
    thermalStrength: 0.48,
    detailStrength: 0.36,
    microDetailStrength: 0.48,
    microDetailScale: 1.15,
    microReliefMeters: 1.35,
    oceanDeepColor: '#0b4965',
    oceanShallowColor: '#78c6d3',
    oceanFoamColor: '#e7f8fb',
    oceanClarity: 0.78,
    oceanAbsorption: 0.62,
    oceanTurbidity: 0.06,
    oceanReflectionStrength: 1.05,
    oceanWaveHeight: 7.0,
    oceanWindSpeed: 16,
    oceanDetail: 1.15,
    oceanChoppiness: 0.55,
    oceanFoamStrength: 0.30,
    oceanSpecularStrength: 1.25,
  },
}

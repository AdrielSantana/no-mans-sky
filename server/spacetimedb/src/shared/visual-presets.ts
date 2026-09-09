import type { PlanetSettings as EditorParams } from './world-settings'

// Appearance only: applying a look keeps the user's seed, terrain and LODs.
export const MINERAL_DAWN = {
  colorA: '#668570',
  colorB: '#95634b',
  textureBlend: 0.78,
  terrainAoStrength: 0.55,
  grassColorA: '#394e36',
  grassColorB: '#a2a465',
  grassGroundTint: 0.82,
  oakLeafShade: '#3d503e',
  oakLeafSun: '#a5ad70',
  pineLeafShade: '#2d4743',
  pineLeafSun: '#708878',
  oceanDeepColor: '#123b46',
  oceanShallowColor: '#53a79b',
  oceanFoamColor: '#e4e3ce',
  oceanClarity: 0.76,
  oceanTurbidity: 0.10,
  oceanReflectionStrength: 0.72,
  oceanSpecularStrength: 0.85,
  atmosphereColor: '#88b0bb',
  atmosphereTwilightColor: '#e6a375',
  atmosphereExtinctionStrength: 0.92,
  cloudColor: '#f0e9d8',
  cloudCoverage: 0.52,
  cloudSoftness: 0.22,
  cloudOpacity: 0.72,
  cloudShadow: 0.32,
  cloudSpeed: 0.018,
  cloudVolume: 0.95,
  sunColor: '#ffe3ba',
  sunElevation: 20,
  bloomStrength: 0.35,
  bloomThreshold: 1.5,
} satisfies Partial<EditorParams>

export type VisualLook = Pick<EditorParams, keyof typeof MINERAL_DAWN>

export function captureVisualLook(params: EditorParams): VisualLook {
  return Object.fromEntries(
    (Object.keys(MINERAL_DAWN) as (keyof VisualLook)[]).map(key => [key, params[key]]),
  ) as VisualLook
}

import * as THREE from 'three'
import { GameEngine } from './engine'
import { PlanetRenderer } from './planet/planet-renderer'
import { getSeaHeight } from './planet/planet-generator'
import type { PlanetWalkerTarget } from './planet-walker-controller'
import { computeAutoLod } from '../../../server/spacetimedb/src/shared/world-settings'
import type { PlanetSettings as EditorParams } from '../../../server/spacetimedb/src/shared/world-settings'

function getEffectiveWaterLevel(params: EditorParams): number {
  return params.waterEnabled ? params.waterLevel : 0
}

export function createPlanet(scene: THREE.Scene, renderer: THREE.WebGLRenderer, params: EditorParams): PlanetRenderer {
  const waterLevel = getEffectiveWaterLevel(params)

  return new PlanetRenderer(scene, params.planetRadius, {
    seed: BigInt(params.seed),
    planetType: params.planetType,
    terrainScale: params.terrainScale,
    waterLevel,
    oceanDeepColor: params.oceanDeepColor,
    oceanShallowColor: params.oceanShallowColor,
    oceanFoamColor: params.oceanFoamColor,
    oceanClarity: params.oceanClarity,
    oceanAbsorption: params.oceanAbsorption,
    oceanTurbidity: params.oceanTurbidity,
    oceanReflectionStrength: params.oceanReflectionStrength,
    oceanWaveHeight: params.oceanWaveHeight,
    oceanWindSpeed: params.oceanWindSpeed,
    oceanDetail: params.oceanDetail,
    oceanChoppiness: params.oceanChoppiness,
    oceanFoamStrength: params.oceanFoamStrength,
    oceanSpecularStrength: params.oceanSpecularStrength,
    colorA: params.colorA,
    colorB: params.colorB,
    textureScale: params.textureScale,
    textureBlend: params.textureBlend,
    textureNearDistance: params.textureNearDistance,
    textureFadeDistance: params.textureFadeDistance,
    terrainAoStrength: params.terrainAoStrength,
    atmosphereColor: params.atmosphereColor,
    atmosphereDensity: params.atmosphereDensity,
    atmosphereSunGlare: params.atmosphereSunGlare,
    atmosphereSunGlareSize: params.atmosphereSunGlareSize,
    atmosphereTwilightColor: params.atmosphereTwilightColor,
    atmosphereTwilightWidth: params.atmosphereTwilightWidth,
    atmosphereTwilightStrength: params.atmosphereTwilightStrength,
    atmosphereExtinctionStrength: params.atmosphereExtinctionStrength,
    cloudCoverage: params.cloudCoverage,
    cloudOpacity: params.cloudOpacity,
    cloudScale: params.cloudScale,
    cloudSoftness: params.cloudSoftness,
    cloudHeight: params.cloudHeight,
    cloudSpeed: params.cloudSpeed,
    cloudShadow: params.cloudShadow,
    cloudVolume: params.cloudVolume,
    cloudStorms: params.cloudStorms,
    cloudBands: params.cloudBands,
    cloudDetail: params.cloudDetail,
    cloudColor: params.cloudColor,
    cloudBillboards: params.cloudBillboards,
    cloudBillboardCount: params.cloudBillboardCount,
    grassEnabled: params.grassEnabled,
    grassDensity: params.grassDensity,
    grassHeight: params.grassHeight,
    grassWindStrength: params.grassWindStrength,
    grassDistance: params.grassDistance,
    grassColorA: params.grassColorA,
    grassColorB: params.grassColorB,
    propsEnabled: params.propsEnabled,
    treeDensity: params.treeDensity,
    rockDensity: params.rockDensity,
    propDistance: params.propDistance,
    sunColor: params.sunColor,
    noiseProfile: {
      octaves: params.octaves,
      lacunarity: params.lacunarity,
      gain: params.gain,
      frequency: params.frequency,
      warpStrength: params.warpStrength,
      continentalScale: params.continentalScale,
      mountainScale: params.mountainScale,
      plainsScale: params.plainsScale,
      hillsScale: params.hillsScale,
      mountainBeltScale: params.mountainBeltScale,
      reliefVariety: params.reliefVariety,
      erosionStrength: params.erosionStrength,
      thermalStrength: params.thermalStrength,
      detailStrength: params.detailStrength,
      microDetailStrength: params.microDetailStrength,
      microDetailScale: params.microDetailScale,
      microReliefMeters: params.microReliefMeters,
    },
    lodMultipliers: params.autoLod ? computeAutoLod(params.planetRadius, params.gridSize) : params.lodMultipliers,
    gridSize: params.gridSize,
    skirts: params.skirts,
    horizonMargin: params.horizonMargin,
    terrainWorkers: params.terrainWorkers,
  }, renderer)
}

export function applyDebugSettings(engine: GameEngine, planet: PlanetRenderer, params: EditorParams) {
  engine.setBloomEnabled(params.debugBloom)
  engine.setGpuProfilingEnabled(params.debugGpuProfiler)
  engine.setPixelRatioCeiling(params.pixelRatioLimit)
  engine.setAntialiasEnabled(params.debugAntialias)
  engine.setSunShadowEnabled(params.debugSunShadow)
  engine.setSunShadowSettings({
    strength: params.sunShadowStrength,
    radius: params.sunShadowRadius,
    size: params.sunShadowSize,
    softness: params.sunShadowSoftness,
  })
  engine.setBloomSettings({
    strength: params.bloomStrength,
    radius: params.bloomRadius,
    threshold: params.bloomThreshold,
  })
  engine.setToneMappingExposure(params.toneMappingExposure)
  engine.setUnderwaterFilterSettings({
    enabled: params.underwaterFilter,
    tint: params.underwaterTint,
    strength: params.underwaterStrength,
    distortion: params.underwaterDistortion,
    murk: params.underwaterMurk,
  })
  planet.setClouds({ coverage: params.cloudCoverage, opacity: params.cloudOpacity,
    scale: params.cloudScale, softness: params.cloudSoftness, height: params.cloudHeight,
    speed: params.cloudSpeed, shadow: params.cloudShadow, volume: params.cloudVolume,
    storms: params.cloudStorms, bands: params.cloudBands, detail: params.cloudDetail,
    colorStrength: params.cloudColorStrength, billboards: params.cloudBillboards,
    billboardCount: params.cloudBillboardCount })
  planet.setFoliageSettings({ density: params.foliageDensity, size: params.foliageSize, flutter: params.foliageFlutter, translucency: params.foliageTranslucency })
  planet.setFoliagePalettes({ 'oak-tree': { colorA: params.oakLeafShade, colorB: params.oakLeafSun }, 'winter-tree': { colorA: params.pineLeafShade, colorB: params.pineLeafSun } })
  planet.setGrassGroundTintStrength(params.grassGroundTint)
  planet.setDebugRendering({
    showAtmosphere: params.debugAtmosphere,
    showClouds: params.debugClouds,
    simpleTerrain: params.debugSimpleTerrain,
    nearTerrainShader: params.debugNearTerrainShader,
    farTerrainShader: params.debugFarTerrainShader,
    fallbackTerrainShader: params.debugFallbackTerrainShader,
  })
}

export function buildWalkerTarget(params: EditorParams, renderer: PlanetRenderer, id = 'editor-planet'): PlanetWalkerTarget {
  return {
    id,
    worldPosition: new THREE.Vector3(0, 0, 0),
    worldQuaternion: new THREE.Quaternion(),
    atmosphereColor: params.atmosphereColor,
    atmosphereDensity: params.atmosphereDensity,
    cloudShadow: renderer.getCloudShadowSettings(),
    terrain: {
      seed: params.seed,
      planetType: params.planetType,
      radius: params.planetRadius,
      terrainScale: params.terrainScale,
      frequency: params.frequency,
      octaves: params.octaves,
      lacunarity: params.lacunarity,
      gain: params.gain,
      warpStrength: params.warpStrength,
      continentalScale: params.continentalScale,
      mountainScale: params.mountainScale,
      plainsScale: params.plainsScale,
      hillsScale: params.hillsScale,
      mountainBeltScale: params.mountainBeltScale,
      reliefVariety: params.reliefVariety,
      erosionStrength: params.erosionStrength,
      thermalStrength: params.thermalStrength,
      detailStrength: params.detailStrength,
      microDetailStrength: params.microDetailStrength,
      microDetailScale: params.microDetailScale,
      microReliefMeters: params.microReliefMeters,
    },
    sampleSurfaceRadius: dir => renderer.sampleSurfaceRadius(dir),
    seaRadius: params.planetRadius
      + getSeaHeight(getEffectiveWaterLevel(params), params.planetType) * params.terrainScale * params.planetRadius,
  }
}


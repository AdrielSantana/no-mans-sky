import * as THREE from 'three'
import {
  CubeFace,
  NUM_FACES,
  LOD_DISTANCE_MULTIPLIERS,
  type QuadtreeNode,
  createRoot,
  createChildren,
  nodeKey,
  getNodeCenter,
} from './quadtree'
import { TerrainChunk, type StitchSteps } from './terrain-chunk'
import {
  createAtmosphereMaterial,
  createCloudBillboardMaterial,
  createCloudMaterial,
  createPlanetFarMaterial,
  createPlanetMaterial,
  createPlanetFallbackMaterial,
  getPlanetTextureScale,
  getSeaHeight,
  PlanetGenerator,
} from './planet-generator'
import { WORLD_SCALE } from '../world-scale'
import {
  samplePlanetHeight,
  samplePlanetRadius,
  samplePlanetRadiusDetailed,
  type PlanetTerrainParams,
} from '../../../../server/spacetimedb/src/shared/planet-terrain'
import type { Vec3Like } from '../../../../server/spacetimedb/src/shared/vector'
import type {
  TerrainWorkerBuildResponse,
  TerrainWorkerOceanRequest,
  TerrainWorkerPropSunRequest,
  TerrainWorkerResponse,
} from './terrain-worker-types'
import {
  buildOceanShoreMask,
  buildOceanVertexHeights,
  type OceanShoreMaskParams,
} from './ocean-sampling'
import type { TerrainChunkGeometryData } from './terrain-geometry'
import {
  FluffyGrassLayer,
  createFluffyGrassMaterial,
  updateFluffyGrassMaterial,
  type FluffyGrassVariant,
  type FluffyGrassSettings,
} from './fluffy-grass'
import {
  acquireTerrainWorker,
  releaseTerrainWorkersFor,
  setTerrainWorkerPoolSize,
  terrainWorkerPoolSize,
} from './terrain-worker-pool'
import {
  PlanetPropLayer,
  getPlanetPropAssets,
  loadPlanetPropAssets,
  setFoliageShadowLodTier,
  setPlanetPropFoliagePalettes,
  updatePlanetPropMaterials,
  type PlanetPropAssets,
  type PlanetPropSettings,
  type PlanetPropScatterCache,
} from './planet-props'
import {
  DEFAULT_FOLIAGE_SETTINGS,
  type FoliagePalette,
  type FoliageSettings,
} from './tree-foliage'
import { createOceanMaterial } from './ocean'
import { OceanGpuIfftSpectrum } from './ocean-gpu-ifft'
import { OceanIfftSpectrum } from './ocean-ifft'
import { CloudMaskTexture } from './cloud-mask'
import { CLOUD_OCCLUDER_RENDER_LAYER, CLOUD_RENDER_LAYER } from '../render-layers'

// Per-frame ceilings on streaming work. Defaults unchanged; they live on the
// instance because they are sized for a 16 ms frame and this frame is not one
// -- measured at ~33 ms and GPU bound, which leaves CPU idle that a fixed
// millisecond ceiling refuses to spend. Making them settable is what lets that
// be measured, and is also what a frame-time-proportional budget would need.
const SYNC_CHUNK_BUILD_BUDGET_MS = 4
const WORKER_DISPATCH_BUDGET_MS = 0.8
const CHUNK_INTEGRATION_BUDGET_MS = 2.5
const DETAILED_MATERIAL_MIN_LOD = 6
const DETAILED_MATERIAL_DISTANCE = WORLD_SCALE.localDetailFar
const LOD_COLLAPSE_HYSTERESIS = 1.35
const SCATTER_SETTLE_MS = 150
const PROP_BUILD_DISTANCE_MARGIN = 1.15
const PROP_SCATTER_BUDGET_MS = 1.5
const CLOUD_CAP_ANGLE_MARGIN = 1.15
const CLOUD_CAP_ANGLE_MIN = 0.12
const CLOUD_CAP_ANGLE_MAX = 0.92
// Per-frame ceiling on prop horizon-shadow recomputation. The staleness gate is
// per layer and the local sun direction sweeps continuously, so every visible
// layer used to cross the 1.4-degree threshold on the same frame — measured at
// ~175ms with 40 layers. Spreading the work costs at most a couple of frames of
// lag on a shadow direction that only moves 1.4 degrees anyway.
const PROP_SUN_LIGHT_BUDGET_MS = 2
const MAX_OCEAN_WORKERS = 3
// Distance ladder for prop detail tiers, as fractions of the prop show
// distance (648 in game). Entry i is the boundary between tier i and tier i+1,
// so this array is one shorter than the number of tiers.
//
// A 15m tree covers roughly 156px of screen height at 100m, 69px at 227m and
// 24px at 648m, while the full model rasterises 17.5k-20.5k triangles --
// and because instance count grows with the square of distance, most trees on
// screen are in the far bands.
//
// Extra tiers drop in without a code change: models carrying fewer tiers are
// clamped per part inside PlanetPropLayer.setLodTier, so adding a fraction here
// before the assets exist is harmless.
// In metres, not as a fraction of the draw distance. These were derived from
// on-screen height -- a 15m tree is ~68px at 227m, ~39px at 402m and ~28px at
// 557m -- and how tall a tree looks does not depend on how far away the
// furthest drawn tree is. They used to be 0.35/0.62/0.86, which produced these
// same numbers only while propDistance was 648m; raising the default to 2200m
// stretched the ladder 3.4x and left tier 0, the full ~1500-card canopy, valid
// out to 770m. Measured at ~3ms of frame time.
//
// A draw distance shorter than a threshold simply means that tier is never
// reached, which is correct: everything drawn really is near.
const PROP_LOD_DISTANCES = [227, 402, 557]
const _grassTint = new THREE.Color()
const _grassTintB = new THREE.Color()
const PROP_LOD_HYSTERESIS = 0.12
// Cap on prop sun-light jobs queued on the dedicated worker. It processes
// messages serially, so an unbounded queue would just accumulate results that
// are already stale by the time they land.
const MAX_PROP_SUN_IN_FLIGHT = 6

// Scratches for the per-node LOD traversal. getNodeCenter used to allocate a
// Vector3 on every call and is hit four times per node per frame; these are
// separate vectors on purpose, so a nested call can never clobber a caller's
// value even though today both happen to resolve the same node.
const _nodeDir = new THREE.Vector3()
const _radiusDir = new THREE.Vector3()
const _horizonDir = new THREE.Vector3()
const _camDir = new THREE.Vector3()
const _stitchScratch: StitchSteps = { bottom: 0, top: 0, left: 0, right: 0 }
const _propSunDir = new THREE.Vector3()
// Same 1.4-degree threshold the layer uses to decide it needs refreshing.
const PROP_SUN_STALE_DOT = 0.9997
const CLOUD_BILLBOARD_MAX_INSTANCES = 1600
const CLOUD_BILLBOARD_SURFACE_BUDGET = 0.42
const CLOUD_BILLBOARD_BUDGET_NEAR_DISTANCE = WORLD_SCALE.localDetailFar * 1.25
const CLOUD_BILLBOARD_BUDGET_FULL_DISTANCE = WORLD_SCALE.localDetailFar * 8
const CLOUD_BILLBOARD_MEDIUM_QUALITY_MULTIPLIER = 0.72
const CLOUD_BILLBOARD_LOW_QUALITY_MULTIPLIER = 0.45
const CLOUD_SHELL_WIDTH_SEGMENTS = 96
const CLOUD_SHELL_HEIGHT_SEGMENTS = 48
const OCEAN_GEODESIC_DETAIL = 32
const OCEAN_DETAIL_IFFT_FULL_DISTANCE = 900
const OCEAN_DETAIL_IFFT_HALF_DISTANCE = 1800
const OCEAN_DETAIL_IFFT_QUARTER_DISTANCE = 2800
const OCEAN_DETAIL_IFFT_DISABLE_DISTANCE = 4200
const OCEAN_SHORE_MASK_WIDTH = 512
const OCEAN_SHORE_MASK_HEIGHT = 256
const OCEAN_SHORE_MASK_BIAS = 0.045
const OCEAN_SHORE_MASK_SURFACE_EDGE = 0.008
const OCEAN_SHORE_MASK_DEPTH_SCALE = 0.35
const DEFAULT_OCEAN_WAVE_HEIGHT = 12.0
const GRASS_NEAR_LOD_BACKOFF = 3
const GRASS_FAR_LOD_BACKOFF = 7
const GRASS_FAR_DISTANCE_MULTIPLIER = 3.0
const FAR_TEXTURE_LOD_BANDS = [
  { maxLod: 2, detailScale: 0.060, farScale: 0.035, farStrength: 0.62 },
  { maxLod: 4, detailScale: 0.120, farScale: 0.050, farStrength: 0.58 },
  { maxLod: 6, detailScale: 0.240, farScale: 0.075, farStrength: 0.52 },
  { maxLod: 8, detailScale: 0.420, farScale: 0.110, farStrength: 0.48 },
  { maxLod: Infinity, detailScale: 0.650, farScale: 0.160, farStrength: 0.44 },
]

function smoothstepNumber(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

export interface UnderwaterViewState {
  factor: number
  depth: number
}

interface OceanMeshRaycastHit {
  radius: number
  ia: number
  ib: number
  ic: number
}

interface PlanetRendererParams {
  seed: bigint
  planetType: string
  terrainScale: number
  waterLevel?: number
  oceanDeepColor?: string
  oceanShallowColor?: string
  oceanFoamColor?: string
  oceanClarity?: number
  oceanAbsorption?: number
  oceanTurbidity?: number
  oceanReflectionStrength?: number
  oceanWaveHeight?: number
  oceanWindSpeed?: number
  oceanDetail?: number
  oceanChoppiness?: number
  oceanFoamStrength?: number
  oceanSpecularStrength?: number
  colorA: string
  colorB: string
  textureScale?: number
  textureBlend?: number
  textureNearDistance?: number
  textureFadeDistance?: number
  terrainAoStrength?: number
  atmosphereColor: string
  atmosphereDensity: number
  atmosphereSunGlare?: number
  atmosphereSunGlareSize?: number
  atmosphereTwilightColor?: string
  atmosphereTwilightWidth?: number
  atmosphereTwilightStrength?: number
  atmosphereExtinctionStrength?: number
  cloudCoverage?: number
  cloudOpacity?: number
  cloudScale?: number
  cloudSoftness?: number
  cloudHeight?: number
  cloudSpeed?: number
  cloudShadow?: number
  cloudVolume?: number
  cloudStorms?: number
  cloudBands?: number
  cloudDetail?: number
  cloudColor?: string
  cloudBillboards?: boolean
  cloudBillboardCount?: number
  grassEnabled?: boolean
  grassDensity?: number
  grassHeight?: number
  grassWindStrength?: number
  grassDistance?: number
  grassColorA?: string
  grassColorB?: string
  propsEnabled?: boolean
  treeDensity?: number
  rockDensity?: number
  propDistance?: number
  sunColor?: string
  noiseProfile?: {
    octaves: number
    lacunarity: number
    gain: number
    frequency: number
    warpStrength?: number
    continentalScale?: number
    mountainScale?: number
    plainsScale?: number
    hillsScale?: number
    mountainBeltScale?: number
    reliefVariety?: number
    erosionStrength?: number
    thermalStrength?: number
    detailStrength?: number
    microDetailStrength?: number
    microDetailScale?: number
    microReliefMeters?: number
  }
  lodMultipliers?: number[]
  gridSize?: number
  skirts?: boolean
  horizonMargin?: number
  terrainWorkers?: number
}

export class PlanetRenderer {
  private group: THREE.Group
  private planetRadius: number
  private noiseProfile: {
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
    seed: number
  }
  private maxLod: number
  private gridSize: number
  private skirts: boolean
  private horizonMargin: number
  private material: THREE.ShaderMaterial
  private farMaterial: THREE.ShaderMaterial
  private farLodMaterials: THREE.ShaderMaterial[] = []
  private fallbackMaterial: THREE.ShaderMaterial
  private simpleTerrainMaterial = new THREE.MeshBasicMaterial({ color: 0x8f927f })
  private oceanMaterial: THREE.ShaderMaterial | null = null
  private oceanIfft: OceanIfftSpectrum | OceanGpuIfftSpectrum | null = null
  private oceanDetailIfft: OceanGpuIfftSpectrum | null = null
  private oceanDetailIfftFrame = 0
  private oceanMesh: THREE.Mesh | null = null
  private oceanShoreMask: THREE.DataTexture | null = null
  private oceanDataReady = false
  private oceanWorkers: Worker[] = []
  private oceanPendingSlices = 0
  private oceanJobId = 0
  private oceanGeometry: THREE.BufferGeometry | null = null
  private oceanSeaRadius = 0
  private oceanMeshFacetInset = 0
  private oceanWaveHeight = DEFAULT_OCEAN_WAVE_HEIGHT
  private underwaterViewState: UnderwaterViewState = { factor: 0, depth: 0 }
  private atmosphereMaterial: THREE.ShaderMaterial | null = null
  private cloudMaterial: THREE.ShaderMaterial | null = null
  private quadtrees: QuadtreeNode[] = []
  private chunks = new Map<string, TerrainChunk>()
  private fallbackSphere: THREE.Mesh
  private atmosphereMesh: THREE.Mesh | null = null
  private cloudMesh: THREE.Mesh | null = null
  private cloudMeshBaseRadius = 0
  private cloudBillboardMesh: THREE.InstancedMesh | null = null
  private cloudBillboardMaterial: THREE.ShaderMaterial | null = null
  private cloudBillboardAlphaAttr: THREE.InstancedBufferAttribute | null = null
  private cloudBillboardSeedAttr: THREE.InstancedBufferAttribute | null = null
  private cloudBillboardVisibleCount = 0
  private grassMaterial: THREE.ShaderMaterial | null = null
  private farGrassMaterial: THREE.ShaderMaterial | null = null
  private grassGroundTintStrength = 0.7
  private grassLayers = new Map<string, FluffyGrassLayer>()
  private farGrassLayers = new Map<string, FluffyGrassLayer>()
  private grassSettings: FluffyGrassSettings = {
    enabled: false,
    density: 0,
    height: 1,
    windStrength: 0,
    distance: 0,
    colorA: '#1f6f2e',
    colorB: '#64b94a',
  }
  private grassNearMinLod = 0
  private grassFarMinLod = 0
  private grassVisibleInstances = 0
  private propAssets: PlanetPropAssets | null = getPlanetPropAssets()
  private propAssetLoadRequested = false
  private propLayers = new Map<string, PlanetPropLayer>()
  private propScatterCache: PlanetPropScatterCache = new Map()
  private propPrepareJobs = new Map<string, { chunk: TerrainChunk; steps: ReturnType<typeof PlanetPropLayer.preparePlacements> }>()
  private propCoverage = new Map<string, boolean>()
  private propPreparationMs = 0
  // Scatter rebuilds are deferred behind a settle timer. Editor sliders fire on
  // pointermove with steps (0.01 / 0.05) well above the rebuild thresholds
  // (0.001), and a rebuild clears and regenerates every grass/prop layer on
  // every chunk — order 1e6 iterations and 1e5 Matrix4 allocations per tick.
  // These cannot simply move into EditorCanvas's existing setTimeout: that
  // timer only fires when buildPlanetKey changes, and the key deliberately
  // excludes every grass and prop parameter, so the sliders would go inert.
  private grassScatterDirtyAt = -1
  private propScatterDirtyAt = -1
  private propSettings: PlanetPropSettings = {
    enabled: false,
    treeDensity: 0,
    rockDensity: 0,
    distance: 0,
  }
  private propMinLod = 0
  // Leaves are generated and driven entirely here rather than baked into the
  // tree assets, so every one of these is live: change it and the canopy
  // responds on the next frame with no reload and no rebuild.
  private foliageSettings: FoliageSettings = { ...DEFAULT_FOLIAGE_SETTINGS }
  // Keyed by model id. Empty means every species keeps the palette it was
  // built with; entries override it live.
  private foliagePalettes: Record<string, FoliagePalette> = {}
  // Last known camera position in planet-local space, so prop attachment can
  // gate on distance from paths that do not receive it (createChunk,
  // rebuildPropLayers).
  private lastLocalCamPos = new THREE.Vector3()
  private hasLocalCamPos = false
  private propSunLightSpentMs = 0
  private propSunWorker: Worker | null = null
  private propSunWorkerFailed = false
  private propSunJobId = 0
  private propSunJobs = new Map<number, { chunkKey: string; sunX: number; sunY: number; sunZ: number }>()
  private propSunInFlightChunks = new Set<string>()
  private propVisibleInstances = 0
  private sunPosition = new THREE.Vector3(0, 0, 0)
  private cloudLocalSunDirection = new THREE.Vector3(0, 1, 0)
  private sunColor = new THREE.Color(0xfff2c8)
  private atmosphereColor = new THREE.Color(0x6fa8dc)
  private cloudColor = new THREE.Color(0xe8edf2)
  private atmosphereLightColor = new THREE.Color(0xc4d5df)
  private atmosphereSunGlare = 0.56
  private atmosphereSunGlareSize = 0.55
  private atmosphereTwilightColor = new THREE.Color(0xff8a3d)
  private atmosphereTwilightWidth = 1.12
  private atmosphereTwilightStrength = 1.02
  private atmosphereExtinctionStrength = 0.82
  private atmosphereDensity = 0
  private terrainAoStrength = 0.45
  private cloudCoverage = 0.68
  private cloudOpacity = 0.78
  private cloudScale = 2.7
  private cloudSoftness = 0.15
  private cloudHeight = 0.045
  private cloudSpeed = 0.012
  private cloudShadow = 0.14
  private cloudVolume = 1.08
  private cloudStorms = 0.62
  private cloudBands = 0.72
  private cloudDetail = 0.82
  private cloudColorStrength = 0
  private cloudQuality = 2
  private cloudMask: CloudMaskTexture
  private cloudBillboardsEnabled = true
  private cloudBillboardCount = 640
  private terrainParams: PlanetTerrainParams
  private seaHeight = -10
  private lodDistances: number[]
  private requestedTerrainWorkers: number
  private nodeSurfaceRadiusCache = new Map<string, number>()
  // Occupancy of the visible chunk set, bucketed by face * (maxLod + 1) + lod.
  // Rebuilt once per frame by rebuildStitchSets.
  private stitchSets: Set<number>[] = []
  // Quadrant masks of the chunks in stitchSets, same bucketing, cell -> mask.
  // Only masked chunks appear. Without this the stitch probe treats a masked
  // patch as covering its whole area, so a child whose neighbour is really a
  // promoted sibling at the same LOD is told to coarsen its edge against it --
  // and coarsening one side of a matched pair is what opens a crack.
  private stitchMasks: Map<number, number>[] = []
  private chunkPriorityCache = new Map<string, number>()
  private chunkNodeCache = new Map<string, QuadtreeNode | null>()
  // Rebuilt each frame by collectRenderKeys: key -> bitmask of child quadrants a
  // partially refined patch must leave to its children.
  private renderQuadrantMasks = new Map<string, number>()
  private syncChunkBuildBudgetMs = SYNC_CHUNK_BUILD_BUDGET_MS
  private workerDispatchBudgetMs = WORKER_DISPATCH_BUDGET_MS
  private chunkIntegrationBudgetMs = CHUNK_INTEGRATION_BUDGET_MS
  private propScatterBudgetMs = PROP_SCATTER_BUDGET_MS
  private time = 0
  private renderer: THREE.WebGLRenderer | null = null

  // Chunk generation queue
  private pendingKeys = new Set<string>()
  private pendingCollapseKeys = new Set<string>()
  private pendingWorkerKeys = new Set<string>()
  private completedWorkerJobs: TerrainWorkerBuildResponse[] = []
  private chunkBuildEpoch = 0
  private nextWorkerJobId = 1
  private generatedChunksLastFrame = 0
  private chunkGenerationMsLastFrame = 0
  private chunkIntegrationMsLastFrame = 0
  private debugShowAtmosphere = true
  private debugShowClouds = true
  private debugSimpleTerrain = false
  private debugNearTerrainShader = true
  private debugFarTerrainShader = true
  private debugFallbackTerrainShader = true
  private disposed = false

  constructor(
    scene: THREE.Scene,
    planetRadius: number,
    params: PlanetRendererParams,
    renderer?: THREE.WebGLRenderer,
  ) {
    this.planetRadius = planetRadius
    this.renderer = renderer ?? null
    this.gridSize = params.gridSize ?? 33
    this.skirts = params.skirts ?? true
    this.horizonMargin = params.horizonMargin ?? 1.0
    this.requestedTerrainWorkers = params.terrainWorkers ?? 0
    this.sunColor.set(params.sunColor ?? '#fff2c8')
    this.atmosphereColor.set(params.atmosphereColor)
    this.cloudColor.set(params.cloudColor ?? '#e8edf2')
    this.atmosphereSunGlare = params.atmosphereSunGlare ?? 0.56
    this.atmosphereSunGlareSize = params.atmosphereSunGlareSize ?? 0.55
    this.atmosphereTwilightColor.set(params.atmosphereTwilightColor ?? '#ff8a3d')
    this.atmosphereTwilightWidth = params.atmosphereTwilightWidth ?? 1.12
    this.atmosphereTwilightStrength = params.atmosphereTwilightStrength ?? 1.02
    this.atmosphereExtinctionStrength = params.atmosphereExtinctionStrength ?? 0.82
    this.atmosphereDensity = THREE.MathUtils.clamp(params.atmosphereDensity, 0, 1)
    this.terrainAoStrength = params.terrainAoStrength ?? 0.45
    this.cloudCoverage = params.cloudCoverage ?? 0.68
    this.cloudOpacity = params.cloudOpacity ?? 0.78
    this.cloudScale = params.cloudScale ?? 2.7
    this.cloudSoftness = params.cloudSoftness ?? 0.15
    this.cloudHeight = params.cloudHeight ?? 0.045
    this.cloudSpeed = params.cloudSpeed ?? 0.012
    this.cloudShadow = params.cloudShadow ?? 0.14
    this.cloudVolume = params.cloudVolume ?? 1.08
    this.cloudStorms = params.cloudStorms ?? 0.62
    this.cloudBands = params.cloudBands ?? 0.72
    this.cloudDetail = params.cloudDetail ?? 0.82
    this.cloudBillboardsEnabled = params.cloudBillboards ?? true
    this.cloudBillboardCount = THREE.MathUtils.clamp(
      Math.round(params.cloudBillboardCount ?? 640),
      0,
      CLOUD_BILLBOARD_MAX_INSTANCES,
    )
    this.grassSettings = {
      enabled: params.grassEnabled ?? true,
      density: THREE.MathUtils.clamp(params.grassDensity ?? 1.05, 0, 1.5),
      height: Math.max(0.05, params.grassHeight ?? 1.15),
      windStrength: THREE.MathUtils.clamp(params.grassWindStrength ?? 0.34, 0, 2),
      distance: Math.max(1, params.grassDistance ?? WORLD_SCALE.localDetailFar * 2.5),
      colorA: params.grassColorA ?? '#1f6f2e',
      colorB: params.grassColorB ?? '#64b94a',
    }
    this.propSettings = {
      enabled: params.propsEnabled ?? true,
      treeDensity: THREE.MathUtils.clamp(params.treeDensity ?? 0.45, 0, 1.5),
      rockDensity: THREE.MathUtils.clamp(params.rockDensity ?? 0.35, 0, 1.5),
      distance: Math.max(1, params.propDistance ?? WORLD_SCALE.localDetailFar * 3.6),
    }
    this.updateAtmosphereLightColor()
    this.group = new THREE.Group()
    scene.add(this.group)

    // Precompute LOD distances:
    // - Level 0 (root): Infinity (never splits)
    // - Level 1 (coarsest): radius-proportional for orbital view
    // - Levels 2+: absolute camera distances capped by geometric series.
    //   This gives consistent surface detail regardless of planet size.
    const multipliers = params.lodMultipliers
      ? [Infinity, ...params.lodMultipliers]
      : LOD_DISTANCE_MULTIPLIERS
    this.maxLod = multipliers.length - 1
    this.grassNearMinLod = Math.max(0, this.maxLod - GRASS_NEAR_LOD_BACKOFF)
    this.grassFarMinLod = Math.max(0, this.maxLod - GRASS_FAR_LOD_BACKOFF)
    this.propMinLod = Math.max(0, this.maxLod - 4)
    const ABSOLUTE_BASE = 50   // finest LOD covers 50 units near camera
    const ABSOLUTE_RATIO = 2.5 // each coarser level is 2.5x further
    this.lodDistances = multipliers.map((m, i) => {
      if (m === Infinity) return Infinity
      const radiusBased = m * planetRadius
      if (i === 1) return radiusBased // coarsest: radius-proportional for orbital view
      // Cap to absolute distance for consistent camera-relative detail
      const levelsFromFinest = this.maxLod - i
      const absoluteCap = ABSOLUTE_BASE * Math.pow(ABSOLUTE_RATIO, levelsFromFinest)
      return Math.min(radiusBased, absoluteCap)
    })

    this.noiseProfile = {
      ...PlanetGenerator.fromParams(params),
      ...params.noiseProfile,
      seed: Number(params.seed),
    }
    this.cloudMask = new CloudMaskTexture(this.getCloudMaskSettings())
    this.terrainParams = {
      seed: this.noiseProfile.seed,
      planetType: params.planetType,
      radius: planetRadius,
      terrainScale: params.terrainScale,
      frequency: this.noiseProfile.frequency,
      octaves: this.noiseProfile.octaves,
      lacunarity: this.noiseProfile.lacunarity,
      gain: this.noiseProfile.gain,
      warpStrength: this.noiseProfile.warpStrength,
      continentalScale: this.noiseProfile.continentalScale,
      mountainScale: this.noiseProfile.mountainScale,
      plainsScale: this.noiseProfile.plainsScale,
      hillsScale: this.noiseProfile.hillsScale,
      mountainBeltScale: this.noiseProfile.mountainBeltScale,
      reliefVariety: this.noiseProfile.reliefVariety,
      erosionStrength: this.noiseProfile.erosionStrength,
      thermalStrength: this.noiseProfile.thermalStrength,
      detailStrength: this.noiseProfile.detailStrength,
      microDetailStrength: this.noiseProfile.microDetailStrength,
      microDetailScale: this.noiseProfile.microDetailScale,
      microReliefMeters: this.noiseProfile.microReliefMeters,
    }
    const waterLevel = params.waterLevel ?? 0
    this.seaHeight = getSeaHeight(waterLevel, params.planetType)
    if (this.grassSettings.enabled && params.planetType === 'rocky') {
      this.grassMaterial = createFluffyGrassMaterial(this.grassSettings, 'near')
      this.farGrassMaterial = createFluffyGrassMaterial(this.grassSettings, 'far')
      this.updateLightColorUniforms()
    }

    this.material = createPlanetMaterial({
      seed: Number(params.seed),
      cloudMask: this.cloudMask.texture,
      planetType: params.planetType,
      waterLevel,
      terrainScale: params.terrainScale,
      localDetailNear: WORLD_SCALE.localDetailNear,
      localDetailFar: WORLD_SCALE.localDetailFar,
      colorA: params.colorA,
      colorB: params.colorB,
      textureScale: params.textureScale ?? 92,
      textureBlend: params.textureBlend ?? 0.48,
      textureNearDistance: params.textureNearDistance ?? 180,
      textureFadeDistance: params.textureFadeDistance ?? 420,
      textureDetailScale: 1.0,
      textureFarScale: 0.14,
      textureFarStrength: 0.42,
      terrainAoStrength: this.terrainAoStrength,
      atmosphereColor: params.atmosphereColor,
      sunPosition: this.sunPosition,
      sunColor: this.sunColor,
      atmosphereLightColor: this.atmosphereLightColor,
      twilightColor: this.atmosphereTwilightColor,
      atmosphereExtinctionStrength: this.atmosphereExtinctionStrength,
      cloudCoverage: this.cloudCoverage,
      cloudScale: this.cloudScale,
      cloudSoftness: this.cloudSoftness,
      cloudHeight: this.cloudHeight,
      cloudSpeed: this.cloudSpeed,
      cloudShadow: this.cloudShadow,
      cloudVolume: this.cloudVolume,
      cloudStorms: this.cloudStorms,
      cloudBands: this.cloudBands,
      cloudDetail: this.cloudDetail,
      planetRadius: planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
    })
    this.farMaterial = createPlanetFarMaterial({
      seed: Number(params.seed),
      cloudMask: this.cloudMask.texture,
      planetType: params.planetType,
      waterLevel,
      terrainScale: params.terrainScale,
      colorA: params.colorA,
      colorB: params.colorB,
      textureScale: params.textureScale ?? 92,
      textureBlend: params.textureBlend ?? 0.48,
      textureNearDistance: params.textureNearDistance ?? 180,
      textureFadeDistance: params.textureFadeDistance ?? 420,
      textureDetailScale: FAR_TEXTURE_LOD_BANDS[0].detailScale,
      textureFarScale: FAR_TEXTURE_LOD_BANDS[0].farScale,
      textureFarStrength: FAR_TEXTURE_LOD_BANDS[0].farStrength,
      terrainAoStrength: this.terrainAoStrength,
      atmosphereColor: params.atmosphereColor,
      sunPosition: this.sunPosition,
      sunColor: this.sunColor,
      atmosphereLightColor: this.atmosphereLightColor,
      twilightColor: this.atmosphereTwilightColor,
      atmosphereExtinctionStrength: this.atmosphereExtinctionStrength,
      cloudCoverage: this.cloudCoverage,
      cloudScale: this.cloudScale,
      cloudSoftness: this.cloudSoftness,
      cloudHeight: this.cloudHeight,
      cloudSpeed: this.cloudSpeed,
      cloudShadow: this.cloudShadow,
      cloudVolume: this.cloudVolume,
      cloudStorms: this.cloudStorms,
      cloudBands: this.cloudBands,
      cloudDetail: this.cloudDetail,
      planetRadius: planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
      lacunarity: this.noiseProfile.lacunarity,
      gain: this.noiseProfile.gain,
      warpStrength: this.noiseProfile.warpStrength,
      continentalScale: this.noiseProfile.continentalScale,
      mountainScale: this.noiseProfile.mountainScale,
      erosionStrength: this.noiseProfile.erosionStrength,
      thermalStrength: this.noiseProfile.thermalStrength,
      detailStrength: this.noiseProfile.detailStrength,
    })
    this.farLodMaterials = [
      this.farMaterial,
      ...FAR_TEXTURE_LOD_BANDS.slice(1).map(band => this.createFarLodMaterial(params, band)),
    ]

    // Fallback low-poly sphere for distant view
    const fallbackGeo = this.createFallbackGeometry(planetRadius)
    this.fallbackMaterial = createPlanetFallbackMaterial({
      seed: Number(params.seed),
      cloudMask: this.cloudMask.texture,
      planetType: params.planetType,
      waterLevel,
      colorA: params.colorA,
      colorB: params.colorB,
      textureScale: params.textureScale ?? 92,
      textureBlend: (params.textureBlend ?? 0.48) * 0.28,
      textureNearDistance: params.textureNearDistance ?? 180,
      textureFadeDistance: params.textureFadeDistance ?? 420,
      textureDetailScale: 0.09,
      textureFarScale: 0.045,
      textureFarStrength: 1.0,
      terrainAoStrength: this.terrainAoStrength,
      atmosphereColor: params.atmosphereColor,
      sunPosition: this.sunPosition,
      sunColor: this.sunColor,
      atmosphereLightColor: this.atmosphereLightColor,
      twilightColor: this.atmosphereTwilightColor,
      atmosphereExtinctionStrength: this.atmosphereExtinctionStrength,
      cloudCoverage: this.cloudCoverage,
      cloudScale: this.cloudScale,
      cloudSoftness: this.cloudSoftness,
      cloudHeight: this.cloudHeight,
      cloudSpeed: this.cloudSpeed,
      cloudShadow: this.cloudShadow,
      cloudVolume: this.cloudVolume,
      cloudStorms: this.cloudStorms,
      cloudBands: this.cloudBands,
      cloudDetail: this.cloudDetail,
      planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
      lacunarity: this.noiseProfile.lacunarity,
      gain: this.noiseProfile.gain,
      warpStrength: this.noiseProfile.warpStrength,
      continentalScale: this.noiseProfile.continentalScale,
      mountainScale: this.noiseProfile.mountainScale,
      erosionStrength: this.noiseProfile.erosionStrength,
      thermalStrength: this.noiseProfile.thermalStrength,
      detailStrength: this.noiseProfile.detailStrength,
    })
    this.fallbackSphere = new THREE.Mesh(fallbackGeo, this.fallbackMaterial)
    this.fallbackSphere.frustumCulled = false
    this.fallbackSphere.layers.enable(CLOUD_OCCLUDER_RENDER_LAYER)
    this.group.add(this.fallbackSphere)

    this.createOceanLayer(params, waterLevel)

    if (params.planetType !== 'gas' && this.cloudOpacity > 0.001) {
      const cloudRadius = planetRadius * (1 + THREE.MathUtils.clamp(this.cloudHeight, 0.001, 0.20))
      this.cloudMeshBaseRadius = cloudRadius
      const cloudGeo = new THREE.SphereGeometry(cloudRadius, CLOUD_SHELL_WIDTH_SEGMENTS, CLOUD_SHELL_HEIGHT_SEGMENTS)
      this.cloudMaterial = createCloudMaterial({
        seed: this.noiseProfile.seed,
        cloudMask: this.cloudMask.texture,
        coverage: this.cloudCoverage,
        opacity: this.cloudOpacity,
        scale: this.cloudScale,
        softness: this.cloudSoftness,
        height: this.cloudHeight,
        speed: this.cloudSpeed,
        shadow: this.cloudShadow,
        volume: this.cloudVolume,
        storms: this.cloudStorms,
        bands: this.cloudBands,
        detail: this.cloudDetail,
        atmosphereColor: params.atmosphereColor,
        sunColor: this.sunColor,
        atmosphereLightColor: this.atmosphereLightColor,
        sunPosition: this.sunPosition,
        cloudColor: params.cloudColor ?? '#e8edf2',
      })
      this.cloudMesh = new THREE.Mesh(cloudGeo, this.cloudMaterial)
      this.cloudMesh.layers.set(CLOUD_RENDER_LAYER)
      this.cloudMesh.frustumCulled = false
      this.cloudMesh.renderOrder = 3
      this.group.add(this.cloudMesh)

      const billboardGeo = new THREE.PlaneGeometry(1, 1, 3, 3)
      this.cloudBillboardAlphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(CLOUD_BILLBOARD_MAX_INSTANCES), 1)
      this.cloudBillboardSeedAttr = new THREE.InstancedBufferAttribute(new Float32Array(CLOUD_BILLBOARD_MAX_INSTANCES), 1)
      this.cloudBillboardAlphaAttr.setUsage(THREE.DynamicDrawUsage)
      this.cloudBillboardSeedAttr.setUsage(THREE.DynamicDrawUsage)
      billboardGeo.setAttribute('instanceAlpha', this.cloudBillboardAlphaAttr)
      billboardGeo.setAttribute('instanceSeed', this.cloudBillboardSeedAttr)
      this.cloudBillboardMaterial = createCloudBillboardMaterial({
        opacity: this.cloudOpacity,
        atmosphereColor: params.atmosphereColor,
        sunColor: this.sunColor,
        atmosphereLightColor: this.atmosphereLightColor,
        sunPosition: this.sunPosition,
        cloudColor: params.cloudColor ?? '#e8edf2',
      })
      this.cloudBillboardMesh = new THREE.InstancedMesh(
        billboardGeo,
        this.cloudBillboardMaterial,
        CLOUD_BILLBOARD_MAX_INSTANCES,
      )
      this.cloudBillboardMesh.count = 0
      this.cloudBillboardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.cloudBillboardMesh.layers.set(CLOUD_RENDER_LAYER)
      this.cloudBillboardMesh.frustumCulled = false
      this.cloudBillboardMesh.renderOrder = 5
      this.cloudBillboardMesh.visible = false
      this.group.add(this.cloudBillboardMesh)
    }

    if (params.atmosphereDensity > 0.01) {
      const atmosphereRadius = planetRadius * 1.08
      const atmosphereGeo = new THREE.SphereGeometry(atmosphereRadius, 96, 96)
      this.atmosphereMaterial = createAtmosphereMaterial({
        atmosphereColor: params.atmosphereColor,
        density: params.atmosphereDensity,
        sunColor: this.sunColor,
        atmosphereLightColor: this.atmosphereLightColor,
        twilightColor: this.atmosphereTwilightColor,
        sunGlare: this.atmosphereSunGlare,
        sunGlareSize: this.atmosphereSunGlareSize,
        twilightWidth: this.atmosphereTwilightWidth,
        twilightStrength: this.atmosphereTwilightStrength,
        sunPosition: this.sunPosition,
        planetRadius,
        atmosphereRadius,
      })
      this.atmosphereMesh = new THREE.Mesh(atmosphereGeo, this.atmosphereMaterial)
      this.atmosphereMesh.frustumCulled = false
      this.atmosphereMesh.renderOrder = 4
      this.group.add(this.atmosphereMesh)
    }

    this.updateGrassGroundAoUniforms()
    this.updateCloudUniforms()

    // Initialize 6 quadtree roots
    for (let f = 0; f < NUM_FACES; f++) {
      this.quadtrees.push(createRoot(f as CubeFace))
    }

    // Shared across every PlanetRenderer -- see terrain-worker-pool.ts. Each
    // renderer asking for its own pool is what put 40 workers on a ten-thread
    // machine. Last explicit request wins; the game leaves all five at 0, which
    // means "derive from hardware" and makes the call idempotent.
    setTerrainWorkerPoolSize(this.requestedTerrainWorkers)
    this.ensurePropAssets()
  }

  private createFarLodMaterial(
    params: PlanetRendererParams,
    band: (typeof FAR_TEXTURE_LOD_BANDS)[number],
  ): THREE.ShaderMaterial {
    return createPlanetFarMaterial({
      seed: Number(params.seed),
      cloudMask: this.cloudMask.texture,
      planetType: params.planetType,
      waterLevel: params.waterLevel ?? 0,
      terrainScale: params.terrainScale,
      colorA: params.colorA,
      colorB: params.colorB,
      textureScale: params.textureScale ?? 92,
      textureBlend: params.textureBlend ?? 0.48,
      textureNearDistance: params.textureNearDistance ?? 180,
      textureFadeDistance: params.textureFadeDistance ?? 420,
      textureDetailScale: band.detailScale,
      textureFarScale: band.farScale,
      textureFarStrength: band.farStrength,
      terrainAoStrength: this.terrainAoStrength,
      atmosphereColor: params.atmosphereColor,
      sunPosition: this.sunPosition,
      sunColor: this.sunColor,
      atmosphereLightColor: this.atmosphereLightColor,
      twilightColor: this.atmosphereTwilightColor,
      atmosphereExtinctionStrength: this.atmosphereExtinctionStrength,
      cloudCoverage: this.cloudCoverage,
      cloudScale: this.cloudScale,
      cloudSoftness: this.cloudSoftness,
      cloudHeight: this.cloudHeight,
      cloudSpeed: this.cloudSpeed,
      cloudShadow: this.cloudShadow,
      cloudVolume: this.cloudVolume,
      cloudStorms: this.cloudStorms,
      cloudBands: this.cloudBands,
      cloudDetail: this.cloudDetail,
      planetRadius: this.planetRadius,
      octaves: this.noiseProfile.octaves,
      frequency: this.noiseProfile.frequency,
      lacunarity: this.noiseProfile.lacunarity,
      gain: this.noiseProfile.gain,
      warpStrength: this.noiseProfile.warpStrength,
      continentalScale: this.noiseProfile.continentalScale,
      mountainScale: this.noiseProfile.mountainScale,
      erosionStrength: this.noiseProfile.erosionStrength,
      thermalStrength: this.noiseProfile.thermalStrength,
      detailStrength: this.noiseProfile.detailStrength,
    })
  }

  setPosition(pos: THREE.Vector3) {
    this.group.position.copy(pos)
  }

  setRotation(rotationAngle: number, axialTilt: number) {
    this.group.rotation.set(0, rotationAngle, axialTilt)
  }

  setSunPosition(pos: THREE.Vector3) {
    this.sunPosition.copy(pos)
  }

  private updateAtmosphereLightColor() {
    const sunBlend = 0.56
    this.atmosphereLightColor.copy(this.atmosphereColor).lerp(this.sunColor, sunBlend)
  }

  private copyColorUniform(material: THREE.ShaderMaterial | null, name: string, color: THREE.Color) {
    const uniform = material?.uniforms[name]
    if (uniform?.value?.copy) uniform.value.copy(color)
  }

  private copyVectorUniform(material: THREE.ShaderMaterial | null, name: string, vector: THREE.Vector3) {
    const uniform = material?.uniforms[name]
    if (uniform?.value?.copy) uniform.value.copy(vector)
  }

  private setFloatUniform(material: THREE.ShaderMaterial | null, name: string, value: number) {
    const uniform = material?.uniforms[name]
    if (uniform) uniform.value = value
  }

  private setTextureUniform(material: THREE.ShaderMaterial | null, name: string, value: THREE.Texture) {
    const uniform = material?.uniforms[name]
    if (uniform) uniform.value = value
  }

  private setColorUniform(material: THREE.ShaderMaterial | null, name: string, value: string) {
    const uniform = material?.uniforms[name]
    if (uniform?.value instanceof THREE.Color) uniform.value.set(value)
  }

  // Terrain albedo and texture blending are pure uniform state — none of it
  // touches the height field, the quadtree or the ocean shore mask. Routing
  // these through a setter keeps them out of the editor's planet rebuild key,
  // where dragging a colour slider used to tear down and rebuild the whole
  // planet, ocean shore mask included.
  setTerrainAppearance(settings: {
    colorA: string
    colorB: string
    textureScale: number
    textureBlend: number
    textureNearDistance: number
    textureFadeDistance: number
  }) {
    const textureScale = getPlanetTextureScale(settings.textureScale, this.planetRadius)
    const materials = [this.material, ...this.farLodMaterials, this.fallbackMaterial]
    for (const material of materials) {
      this.setColorUniform(material, 'uColorA', settings.colorA)
      this.setColorUniform(material, 'uColorB', settings.colorB)
      this.setFloatUniform(material, 'uTextureScale', textureScale)
      this.setFloatUniform(material, 'uTextureBlend', settings.textureBlend)
      this.setFloatUniform(material, 'uTextureNearDistance', settings.textureNearDistance)
      this.setFloatUniform(material, 'uTextureFadeDistance', settings.textureFadeDistance)
    }
  }

  // Every material that tints by the atmosphere names the uniform
  // uAtmosphereColor and feeds it a plain THREE.Color, so this is a straight
  // uniform write. setColorUniform skips materials that lack it.
  setAtmosphereColor(color: string) {
    const materials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
      this.atmosphereMaterial,
      this.cloudMaterial,
      this.cloudBillboardMaterial,
    ]
    for (const material of materials) {
      this.setColorUniform(material, 'uAtmosphereColor', color)
    }
  }

  private getCloudMaskSettings() {
    return {
      seed: this.noiseProfile.seed,
      coverage: this.cloudCoverage,
      scale: this.cloudScale,
      softness: this.cloudSoftness,
      storms: this.cloudStorms,
      bands: this.cloudBands,
      detail: this.cloudDetail,
    }
  }

  private getCloudMaskOffset(): number {
    return (this.time * Math.max(this.cloudSpeed, 0) * 0.006) % 1
  }

  private hasActiveClouds(): boolean {
    return this.debugShowClouds && this.cloudOpacity > 0.001
  }

  getCloudShadowSettings() {
    return {
      mask: this.cloudMask.texture,
      maskOffset: this.getCloudMaskOffset(),
      height: this.cloudHeight,
      strength: this.hasActiveClouds() ? this.cloudShadow : 0,
    }
  }

  private getGrassGroundAoStrength(): number {
    if (!this.grassSettings.enabled || this.terrainParams.planetType !== 'rocky') return 0
    return THREE.MathUtils.clamp(this.grassSettings.density * 0.34, 0, 0.46)
  }

  private updateGrassGroundAoUniforms() {
    const strength = this.getGrassGroundAoStrength()
    // Blades read as mix(colorA, colorB, tip), and tip averages out around the
    // middle of the blade, so this is what a patch of grass looks like once it
    // is too far away to resolve individual blades.
    _grassTint.set(this.grassSettings.colorA).lerp(_grassTintB.set(this.grassSettings.colorB), 0.55)
    const materials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
    ]
    for (const material of materials) {
      this.setFloatUniform(material, 'uGrassGroundAoStrength', strength)
      this.setFloatUniform(material, 'uGrassGroundTintStrength', this.grassGroundTintStrength)
      const tint = material.uniforms.uGrassGroundTint
      if (tint) (tint.value as THREE.Color).copy(_grassTint)
    }
  }

  /**
   * How strongly the ground takes on the grass colour where grass grows. This
   * is what carries a meadow once the blades themselves have faded out, so it
   * is what makes a short grass draw distance survivable.
   */
  setGrassGroundTintStrength(strength: number) {
    this.grassGroundTintStrength = THREE.MathUtils.clamp(strength, 0, 1)
    this.updateGrassGroundAoUniforms()
  }

  private updateLightColorUniforms() {
    this.updateAtmosphereLightColor()
    const materials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
      this.oceanMaterial,
      this.cloudMaterial,
      this.cloudBillboardMaterial,
      this.atmosphereMaterial,
      this.grassMaterial,
      this.farGrassMaterial,
    ]
    for (const material of materials) {
      this.copyColorUniform(material, 'uSunColor', this.sunColor)
      this.copyColorUniform(material, 'uAtmosphereColor', this.atmosphereColor)
      this.copyColorUniform(material, 'uCloudColor', this.cloudColor)
      this.copyColorUniform(material, 'uAtmosphereLightColor', this.atmosphereLightColor)
      this.copyColorUniform(material, 'uTwilightColor', this.atmosphereTwilightColor)
      this.setFloatUniform(material, 'uSunGlareStrength', this.atmosphereSunGlare)
      this.setFloatUniform(material, 'uSunGlareSize', this.atmosphereSunGlareSize)
      this.setFloatUniform(material, 'uTwilightWidth', this.atmosphereTwilightWidth)
      this.setFloatUniform(material, 'uTwilightStrength', this.atmosphereTwilightStrength)
      this.setFloatUniform(material, 'uAtmosphereExtinctionStrength', this.atmosphereExtinctionStrength)
    }
  }

  setSunColor(color: string) {
    this.sunColor.set(color)
    this.updateLightColorUniforms()
  }

  setCloudColor(color: string) {
    this.cloudColor.set(color)
    this.updateLightColorUniforms()
  }

  setTerrainAoStrength(strength: number) {
    this.terrainAoStrength = THREE.MathUtils.clamp(strength, 0, 2)
    const materials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
      this.grassMaterial,
      this.farGrassMaterial,
    ]
    for (const material of materials) {
      this.setFloatUniform(material, 'uTerrainAoStrength', this.terrainAoStrength)
    }
  }

  setClouds(settings: {
    coverage: number
    opacity: number
    scale: number
    softness: number
    height: number
    speed: number
    shadow: number
    volume: number
    storms: number
    bands: number
    detail: number
    colorStrength: number
    billboards: boolean
    billboardCount: number
  }) {
    this.cloudCoverage = settings.coverage
    this.cloudOpacity = settings.opacity
    this.cloudScale = settings.scale
    this.cloudSoftness = settings.softness
    this.cloudHeight = settings.height
    this.cloudSpeed = settings.speed
    this.cloudShadow = settings.shadow
    this.cloudVolume = settings.volume
    this.cloudStorms = settings.storms
    this.cloudBands = settings.bands
    this.cloudDetail = settings.detail
    this.cloudColorStrength = settings.colorStrength
    this.cloudBillboardsEnabled = settings.billboards
    this.cloudBillboardCount = THREE.MathUtils.clamp(
      Math.round(settings.billboardCount),
      0,
      CLOUD_BILLBOARD_MAX_INSTANCES,
    )
    this.cloudMask.update(this.getCloudMaskSettings())

    this.updateCloudUniforms()

    if (this.cloudMesh) {
      const scale = 1 + THREE.MathUtils.clamp(this.cloudHeight, 0.001, 0.20)
      const targetRadius = this.planetRadius * scale
      if (this.cloudMeshBaseRadius > 0) {
        this.cloudMesh.scale.setScalar(targetRadius / this.cloudMeshBaseRadius)
      }
    }
  }

  setGrass(settings: FluffyGrassSettings) {
    const next: FluffyGrassSettings = {
      enabled: settings.enabled,
      density: THREE.MathUtils.clamp(settings.density, 0, 3),
      height: Math.max(0.05, settings.height),
      windStrength: THREE.MathUtils.clamp(settings.windStrength, 0, 2),
      distance: Math.max(1, settings.distance),
      colorA: settings.colorA,
      colorB: settings.colorB,
    }
    const rebuild = next.enabled !== this.grassSettings.enabled
      || Math.abs(next.density - this.grassSettings.density) > 0.001
      || Math.abs(next.height - this.grassSettings.height) > 0.001
      || Math.abs(next.distance - this.grassSettings.distance) > 80

    this.grassSettings = next

    if (!next.enabled || this.terrainParams.planetType !== 'rocky') {
      this.grassScatterDirtyAt = -1
      this.clearGrassLayers()
      this.updateGrassGroundAoUniforms()
      return
    }

    if (!this.grassMaterial) {
      this.grassMaterial = createFluffyGrassMaterial(this.grassSettings, 'near')
    }
    if (!this.farGrassMaterial) {
      this.farGrassMaterial = createFluffyGrassMaterial(this.grassSettings, 'far')
    }
    this.updateLightColorUniforms()
    this.setFloatUniform(this.grassMaterial, 'uTerrainAoStrength', this.terrainAoStrength)
    this.setFloatUniform(this.farGrassMaterial, 'uTerrainAoStrength', this.terrainAoStrength)
    this.updateGrassGroundAoUniforms()
    this.updateCloudUniforms()

    if (rebuild) {
      this.grassScatterDirtyAt = performance.now()
    }
  }

  setProps(settings: PlanetPropSettings) {
    const next: PlanetPropSettings = {
      enabled: settings.enabled,
      treeDensity: THREE.MathUtils.clamp(settings.treeDensity, 0, 1.5),
      rockDensity: THREE.MathUtils.clamp(settings.rockDensity, 0, 1.5),
      distance: Math.max(1, settings.distance),
    }
    const rebuild = next.enabled !== this.propSettings.enabled
      || Math.abs(next.treeDensity - this.propSettings.treeDensity) > 0.001
      || Math.abs(next.rockDensity - this.propSettings.rockDensity) > 0.001

    this.propSettings = next

    if (!next.enabled || this.terrainParams.planetType !== 'rocky') {
      this.propScatterDirtyAt = -1
      this.clearPropLayers()
      return
    }

    this.ensurePropAssets()
    if (rebuild) {
      this.propScatterDirtyAt = performance.now()
    }
  }

  // Live foliage tuning. None of this touches placement or geometry -- the
  // cards already exist on every tree and the shader reads these each frame --
  // so it is safe to drive from a slider without rebuilding a single chunk.
  setFoliageSettings(settings: Partial<FoliageSettings>) {
    this.foliageSettings = {
      ...this.foliageSettings,
      ...settings,
      density: THREE.MathUtils.clamp(settings.density ?? this.foliageSettings.density, 0, 1),
      size: THREE.MathUtils.clamp(settings.size ?? this.foliageSettings.size, 0, 0.6),
      sizeVariance: THREE.MathUtils.clamp(settings.sizeVariance ?? this.foliageSettings.sizeVariance, 0, 1),
      colorVariance: THREE.MathUtils.clamp(settings.colorVariance ?? this.foliageSettings.colorVariance, 0, 1),
      translucency: THREE.MathUtils.clamp(settings.translucency ?? this.foliageSettings.translucency, 0, 3),
      flutter: THREE.MathUtils.clamp(settings.flutter ?? this.foliageSettings.flutter, 0, 4),
    }
    // `enabled` is the one setting that is not just a uniform: zero density
    // collapses every card to a degenerate quad, which the rasteriser drops
    // before it costs a fragment.
    if (!this.foliageSettings.enabled) this.foliageSettings.density = 0
  }

  getFoliageSettings(): FoliageSettings {
    return { ...this.foliageSettings }
  }

  // Per-species leaf colour. Applied on the next frame; safe to call before the
  // prop assets have finished loading.
  setFoliagePalettes(palettes: Record<string, FoliagePalette>) {
    this.foliagePalettes = { ...this.foliagePalettes, ...palettes }
    if (this.propAssets) setPlanetPropFoliagePalettes(this.propAssets, this.foliagePalettes)
  }

  // Drains the deferred scatter rebuilds once the slider has settled. Called at
  // the top of update(); asset load still rebuilds immediately, since that is a
  // one-shot and the props should appear as soon as they arrive.
  private consumePendingScatterRebuilds() {
    const now = performance.now()
    if (this.grassScatterDirtyAt >= 0 && now - this.grassScatterDirtyAt >= SCATTER_SETTLE_MS) {
      this.grassScatterDirtyAt = -1
      this.rebuildGrassLayers()
    }
    if (this.propScatterDirtyAt >= 0 && now - this.propScatterDirtyAt >= SCATTER_SETTLE_MS) {
      this.propScatterDirtyAt = -1
      this.rebuildPropLayers()
    }
  }

  private ensurePropAssets() {
    if (!this.propSettings.enabled || this.terrainParams.planetType !== 'rocky') return
    if (this.propAssets) return

    const loadedAssets = getPlanetPropAssets()
    if (loadedAssets) {
      this.propAssets = loadedAssets
      this.rebuildPropLayers()
      return
    }

    if (this.propAssetLoadRequested) return

    this.propAssetLoadRequested = true
    void loadPlanetPropAssets()
      .then((assets) => {
        this.propAssetLoadRequested = false
        if (this.disposed) return
        this.propAssets = assets
        this.rebuildPropLayers()
      })
      .catch((error: unknown) => {
        this.propAssetLoadRequested = false
        console.warn('Failed to load planet prop assets', error)
      })
  }

  private updateCloudUniforms() {
    const materials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
      this.oceanMaterial,
      this.cloudMaterial,
      this.cloudBillboardMaterial,
      this.grassMaterial,
      this.farGrassMaterial,
    ]
    const effectiveShadow = this.hasActiveClouds() ? this.cloudShadow : 0

    for (const material of materials) {
      this.setFloatUniform(material, 'uCloudCoverage', this.cloudCoverage)
      this.setFloatUniform(material, 'uCloudScale', this.cloudScale)
      this.setFloatUniform(material, 'uCloudSoftness', this.cloudSoftness)
      this.setFloatUniform(material, 'uCloudHeight', this.cloudHeight)
      this.setFloatUniform(material, 'uCloudSpeed', this.cloudSpeed)
      this.setFloatUniform(material, 'uCloudShadowStrength', effectiveShadow)
      this.setFloatUniform(material, 'uCloudVolumeStrength', this.cloudVolume)
      this.setFloatUniform(material, 'uCloudStormStrength', this.cloudStorms)
      this.setFloatUniform(material, 'uCloudBandStrength', this.cloudBands)
      this.setFloatUniform(material, 'uCloudDetailStrength', this.cloudDetail)
      this.setFloatUniform(material, 'uCloudColorStrength', this.cloudColorStrength)
      this.setFloatUniform(material, 'uCloudQuality', this.cloudQuality)
      this.setFloatUniform(material, 'uCloudSeed', this.noiseProfile.seed)
      this.setTextureUniform(material, 'uCloudMask', this.cloudMask.texture)
      this.setFloatUniform(material, 'uCloudMaskOffset', this.getCloudMaskOffset())
    }

    this.updateCloudRenderMix()
  }

  private updateCloudRenderMix() {
    const billboardMultiplier = this.cloudBillboardsEnabled && this.cloudBillboardCount > 0 ? 1 : 0

    this.setFloatUniform(this.cloudMaterial, 'uOpacity', this.cloudOpacity)
    this.setFloatUniform(this.cloudBillboardMaterial, 'uOpacity', this.cloudOpacity * billboardMultiplier)
  }

  private updateCloudQuality(surfaceDistance: number) {
    const cloudAltitude = this.planetRadius * THREE.MathUtils.clamp(this.cloudHeight, 0.001, 0.20)
    const orbitLowQualityDistance = Math.max(WORLD_SCALE.localDetailFar * 12, this.planetRadius * 0.09)
    const highQualityLayerBand = Math.max(WORLD_SCALE.localDetailFar * 4, cloudAltitude * 0.70)
    const distanceToCloudLayer = Math.abs(Math.max(0, surfaceDistance) - cloudAltitude)

    if (surfaceDistance > orbitLowQualityDistance) {
      this.setCloudQuality(0)
    } else if (distanceToCloudLayer < highQualityLayerBand) {
      this.setCloudQuality(2)
    } else {
      this.setCloudQuality(1)
    }
  }

  private setCloudQuality(nextQuality: number) {
    if (nextQuality === this.cloudQuality) return

    this.cloudQuality = nextQuality
    const materials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
      this.cloudMaterial,
      this.cloudBillboardMaterial,
      this.grassMaterial,
      this.farGrassMaterial,
    ]
    for (const material of materials) {
      this.setFloatUniform(material, 'uCloudQuality', this.cloudQuality)
    }
    this.updateCloudRenderMix()
  }

  private updateSurfaceLightingBlend(surfaceDistance: number) {
    const blend = 1 - THREE.MathUtils.smoothstep(
      surfaceDistance,
      WORLD_SCALE.localDetailNear * 1.5,
      WORLD_SCALE.localDetailFar * 1.25,
    )
    const materials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
    ]

    for (const material of materials) {
      this.setFloatUniform(material, 'uSurfaceLightingBlend', blend)
    }
  }

  private random01(value: number): number {
    const x = Math.sin(value * 12.9898 + this.noiseProfile.seed * 78.233) * 43758.5453
    return x - Math.floor(x)
  }

  private getCloudBillboardBudget(surfaceDistance: number): number {
    const distance = Math.max(0, surfaceDistance)
    const t = THREE.MathUtils.smoothstep(
      distance,
      CLOUD_BILLBOARD_BUDGET_NEAR_DISTANCE,
      CLOUD_BILLBOARD_BUDGET_FULL_DISTANCE,
    )
    const distanceBudget = THREE.MathUtils.lerp(CLOUD_BILLBOARD_SURFACE_BUDGET, 1, t)
    const qualityBudget = this.cloudQuality < 0.5
      ? CLOUD_BILLBOARD_LOW_QUALITY_MULTIPLIER
      : this.cloudQuality < 1.5
        ? CLOUD_BILLBOARD_MEDIUM_QUALITY_MULTIPLIER
        : 1
    return distanceBudget * qualityBudget
  }

  private updateCloudRenderSide(localCamPos: THREE.Vector3) {
    if (!this.cloudMaterial) return

    const cloudRadius = this.planetRadius * (1 + THREE.MathUtils.clamp(this.cloudHeight, 0.001, 0.20))
    const nextSide = localCamPos.lengthSq() < cloudRadius * cloudRadius
      ? THREE.BackSide
      : THREE.FrontSide

    if (this.cloudMaterial.side !== nextSide) {
      this.cloudMaterial.side = nextSide
      this.cloudMaterial.needsUpdate = true
    }
  }

  private updateCloudBillboards(localCamPos: THREE.Vector3, surfaceDistance: number) {
    const mesh = this.cloudBillboardMesh
    const alphaAttr = this.cloudBillboardAlphaAttr
    const seedAttr = this.cloudBillboardSeedAttr
    if (!mesh || !alphaAttr || !seedAttr) return

    const active = this.debugShowClouds
      && this.cloudBillboardsEnabled
      && this.cloudOpacity > 0.001
      && this.cloudBillboardCount > 0

    if (!active) {
      mesh.visible = false
      mesh.count = 0
      this.cloudBillboardVisibleCount = 0
      return
    }

    const centerDir = localCamPos.lengthSq() > 0.0001
      ? localCamPos.clone().normalize()
      : new THREE.Vector3(0, 1, 0)

    const cloudRadius = this.planetRadius * (1 + THREE.MathUtils.clamp(this.cloudHeight, 0.001, 0.20))
    const configuredCount = Math.min(
      CLOUD_BILLBOARD_MAX_INSTANCES,
      Math.max(0, Math.round(this.cloudBillboardCount)),
    )
    const billboardBudget = this.getCloudBillboardBudget(surfaceDistance)
    const desiredCount = Math.min(
      configuredCount,
      Math.max(1, Math.round(configuredCount * billboardBudget)),
    )
    // Derived from geometry rather than the previous hardcoded 0.92 rad.
    // The cap the player can actually see is the planet's horizon angle plus
    // how far past it the cloud shell stays visible:
    //   acos(Rp / rCam) + acos(Rp / Rcloud)
    // Standing on the surface at radius 50000 with cloudHeight 0.045 that is
    // 0.294 rad — 0.92 covered roughly nine times the solid angle, so ~90% of
    // the billboards sat below the horizon. They are not free: the cloud layer
    // renders into its own half-res target with no terrain depth, so each one
    // was fully rasterised and blended before being masked out in the
    // composite. Since angularStep scales with capAngle, the same candidate
    // budget now concentrates into the visible cap — denser clouds where you
    // can see them, for less fill.
    //
    // Ceilinged at the old constant so this can only ever do less work.
    const camRadius = Math.max(localCamPos.length(), this.planetRadius)
    const horizonAngle = Math.acos(THREE.MathUtils.clamp(this.planetRadius / camRadius, -1, 1))
    const shellAngle = Math.acos(THREE.MathUtils.clamp(this.planetRadius / cloudRadius, -1, 1))
    const capAngle = THREE.MathUtils.clamp(
      (horizonAngle + shellAngle) * CLOUD_CAP_ANGLE_MARGIN,
      CLOUD_CAP_ANGLE_MIN,
      CLOUD_CAP_ANGLE_MAX,
    )
    const baseSize = this.planetRadius * 0.092 * THREE.MathUtils.lerp(1.12, 1.0, billboardBudget)
    const threshold = THREE.MathUtils.lerp(0.13, 0.06, billboardBudget)
    const maskOffset = this.getCloudMaskOffset()
    const candidateTarget = Math.min(CLOUD_BILLBOARD_MAX_INSTANCES, Math.max(64, Math.round(desiredCount * 2.35)))
    const angularStep = THREE.MathUtils.clamp(
      capAngle * Math.sqrt(Math.PI / candidateTarget),
      0.012,
      0.085,
    )
    const centerLat = Math.asin(THREE.MathUtils.clamp(centerDir.y, -1, 1))
    const centerLon = Math.atan2(centerDir.x, centerDir.z)
    const centerLatCell = Math.round(centerLat / angularStep)
    const centerLonCell = Math.round(centerLon / angularStep)
    const cellRadius = Math.ceil(capAngle / angularStep) + 2
    const capDot = Math.cos(capAngle)
    const alphaArray = alphaAttr.array as Float32Array
    const seedArray = seedAttr.array as Float32Array
    const matrix = new THREE.Matrix4()
    const dir = new THREE.Vector3()
    const pos = new THREE.Vector3()
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    const toCamera = new THREE.Vector3()
    const basisX = new THREE.Vector3()
    const basisY = new THREE.Vector3()
    const basisZ = new THREE.Vector3()
    let visible = 0

    for (let latOffset = -cellRadius; latOffset <= cellRadius && visible < desiredCount; latOffset++) {
      const latCell = centerLatCell + latOffset
      const baseLat = latCell * angularStep
      if (baseLat < -Math.PI * 0.5 || baseLat > Math.PI * 0.5) continue

      for (let lonOffset = -cellRadius; lonOffset <= cellRadius && visible < desiredCount; lonOffset++) {
        const lonCell = centerLonCell + lonOffset
        const cellKey = latCell * 4099 + lonCell * 9173
        const r1 = this.random01(cellKey + 11.0)
        const r2 = this.random01(cellKey + 29.0)
        const r3 = this.random01(cellKey + 47.0)
        const lat = THREE.MathUtils.clamp(
          baseLat + (r1 - 0.5) * angularStep * 0.72,
          -Math.PI * 0.5 + 0.0001,
          Math.PI * 0.5 - 0.0001,
        )
        const lon = lonCell * angularStep + (r2 - 0.5) * angularStep * 0.72
        const cosLat = Math.cos(lat)
        dir.set(
          Math.sin(lon) * cosLat,
          Math.sin(lat),
          Math.cos(lon) * cosLat,
        )
        if (dir.dot(centerDir) < capDot) continue

        const density = this.cloudMask.sampleDirection(dir, maskOffset)
        if (density < threshold) continue

        pos.copy(dir).multiplyScalar(cloudRadius)
        toCamera.copy(localCamPos).sub(pos).normalize()
        right.crossVectors(dir, toCamera)
        if (right.lengthSq() < 0.0001) {
          right.crossVectors(new THREE.Vector3(0, 1, 0), dir)
          if (right.lengthSq() < 0.0001) right.crossVectors(new THREE.Vector3(1, 0, 0), dir)
        }
        right.normalize()
        up.crossVectors(toCamera, right).normalize()

        const densityAlpha = THREE.MathUtils.smoothstep(
          density,
          threshold,
          Math.min(1, threshold + Math.max(this.cloudSoftness, 0.05) * 2.8 + 0.18),
        )
        const size = baseSize * (0.62 + r3 * 1.18) * (0.90 + this.cloudVolume * 0.16)
        const aspect = 0.52 + this.random01(cellKey + 83.0) * 0.72
        basisX.copy(right).multiplyScalar(size)
        // A camera-facing card used to be taller than its altitude, cutting
        // through land and water at the horizon. Bound its radial half-extent.
        const radialProjection = Math.abs(up.dot(dir))
        const clearance = Math.max(1, cloudRadius - Math.max(this.planetRadius, this.oceanSeaRadius))
        basisY.copy(up).multiplyScalar(Math.min(size * aspect, clearance * 1.5 / Math.max(radialProjection, 0.1)))
        basisZ.copy(toCamera)
        matrix.makeBasis(basisX, basisY, basisZ)
        matrix.setPosition(pos)
        mesh.setMatrixAt(visible, matrix)
        alphaArray[visible] = THREE.MathUtils.clamp(densityAlpha * (0.30 + r3 * 0.34), 0, 0.68)
        seedArray[visible] = r3
        visible++
      }
    }

    mesh.count = visible
    mesh.visible = visible > 0
    mesh.instanceMatrix.needsUpdate = true
    alphaAttr.needsUpdate = true
    seedAttr.needsUpdate = true
    this.cloudBillboardVisibleCount = visible
  }

  setAtmosphereOptics(settings: {
    sunGlare: number
    sunGlareSize: number
    twilightColor: string
    twilightWidth: number
    twilightStrength: number
    extinctionStrength: number
  }) {
    this.atmosphereSunGlare = settings.sunGlare
    this.atmosphereSunGlareSize = settings.sunGlareSize
    this.atmosphereTwilightColor.set(settings.twilightColor)
    this.atmosphereTwilightWidth = settings.twilightWidth
    this.atmosphereTwilightStrength = settings.twilightStrength
    this.atmosphereExtinctionStrength = settings.extinctionStrength
    this.updateLightColorUniforms()
  }

  setDebugWireframe(enabled: boolean) {
    this.material.wireframe = enabled
    for (const material of this.farLodMaterials) {
      material.wireframe = enabled
    }
    this.fallbackMaterial.wireframe = enabled
    if (this.oceanMaterial) this.oceanMaterial.wireframe = enabled
    if (this.cloudMaterial) this.cloudMaterial.wireframe = enabled
    if (this.cloudBillboardMaterial) this.cloudBillboardMaterial.wireframe = enabled
  }

  /**
   * Foliage LOD tier used while filling the shadow map, independent of what
   * the camera sees. -1 keeps foliage out of the map entirely.
   */
  setFoliageShadowLodTier(tier: number) {
    setFoliageShadowLodTier(tier)
  }

  setDebugRendering(options: {
    showAtmosphere?: boolean
    showClouds?: boolean
    simpleTerrain?: boolean
    nearTerrainShader?: boolean
    farTerrainShader?: boolean
    fallbackTerrainShader?: boolean
  }) {
    if (options.showAtmosphere !== undefined) this.debugShowAtmosphere = options.showAtmosphere
    if (options.showClouds !== undefined) {
      this.debugShowClouds = options.showClouds
      this.updateCloudUniforms()
    }
    if (options.simpleTerrain !== undefined) this.debugSimpleTerrain = options.simpleTerrain
    if (options.nearTerrainShader !== undefined) this.debugNearTerrainShader = options.nearTerrainShader
    if (options.farTerrainShader !== undefined) this.debugFarTerrainShader = options.farTerrainShader
    if (options.fallbackTerrainShader !== undefined) this.debugFallbackTerrainShader = options.fallbackTerrainShader
  }

  sampleSurfaceRadius(dir: Vec3Like): number {
    const chunk = this.findVisibleChunkForDirection(dir)
    return chunk?.sampleVisualRadius(dir) ?? samplePlanetRadiusDetailed(dir, this.terrainParams)
  }

  getUnderwaterViewState(): UnderwaterViewState {
    return this.underwaterViewState
  }

  getDebugStats(camera: THREE.Camera) {
    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)

    const planetPos = new THREE.Vector3()
    this.group.getWorldPosition(planetPos)
    const planetQuat = new THREE.Quaternion()
    this.group.getWorldQuaternion(planetQuat)
    const localCamPos = camPos.clone().sub(planetPos).applyQuaternion(planetQuat.clone().invert())

    const byLod: Record<string, number> = {}
    let visible = 0
    let detailedMaterialChunks = 0
    let skirtEdges = 0
    let stitchEdges = 0
    for (const [key, chunk] of this.chunks) {
      const lod = key.split('_')[1] ?? '?'
      byLod[lod] = (byLod[lod] ?? 0) + 1
      if (chunk.mesh.visible) visible++
      if (chunk.mesh.material === this.material) detailedMaterialChunks++
      skirtEdges += (chunk.skirtFlags.bottom ? 1 : 0)
        + (chunk.skirtFlags.top ? 1 : 0)
        + (chunk.skirtFlags.left ? 1 : 0)
        + (chunk.skirtFlags.right ? 1 : 0)
      stitchEdges += (chunk.stitchSteps.bottom > 1 ? 1 : 0)
        + (chunk.stitchSteps.top > 1 ? 1 : 0)
        + (chunk.stitchSteps.left > 1 ? 1 : 0)
        + (chunk.stitchSteps.right > 1 ? 1 : 0)
    }

    return {
      radius: this.planetRadius,
      surfaceDistance: this.getLocalSurfaceDistance(localCamPos),
      chunks: this.chunks.size,
      visible,
      detailedMaterialChunks,
      pending: this.pendingKeys.size + this.pendingWorkerKeys.size + this.completedWorkerJobs.length,
      building: this.pendingWorkerKeys.size,
      workers: terrainWorkerPoolSize(),
      completedBuilds: this.completedWorkerJobs.length,
      pendingCollapses: this.pendingCollapseKeys.size,
      skirtEdges,
      stitchEdges,
      cloudQuality: this.cloudQuality,
      cloudBillboards: this.cloudBillboardVisibleCount,
      propsInstances: this.propVisibleInstances,
      ocean: this.oceanMesh?.visible ?? false,
      oceanQuality: this.oceanMaterial?.uniforms.uOceanQuality?.value ?? -1,
      seaHeight: this.seaHeight,
      seaRadius: this.oceanSeaRadius,
      grassInstances: this.grassVisibleInstances,
      generated: this.generatedChunksLastFrame,
      chunkGenerationMs: this.chunkGenerationMsLastFrame,
      chunkIntegrationMs: this.chunkIntegrationMsLastFrame,
      byLod,
      usingTerrain: !this.fallbackSphere.visible,
    }
  }

  getPropDebugInfo() {
    const materials: Array<{
      chunkKey: string
      meshName: string
      materialName: string
      materialType: string
      isShaderMaterial: boolean
      shaderVersion: unknown
      count: number
      visible: boolean
    }> = []
    let meshes = 0
    let instances = 0
    let visibleLayers = 0
    // Visible layers per detail tier, so PROP_LOD1_DISTANCE_FRACTION can be
    // tuned against what is actually on screen.
    const lodTiers: number[] = []
    let sunCount = 0
    let sunMin = 1
    let sunMax = 0
    let sunSum = 0

    for (const [chunkKey, layer] of this.propLayers) {
      if (layer.group.visible) {
        visibleLayers++
        const tier = layer.lodTierIndex
        lodTiers[tier] = (lodTiers[tier] ?? 0) + 1
      }
      const sunStats = layer.getSunLightStats()
      if (sunStats.count > 0) {
        sunCount += sunStats.count
        sunMin = Math.min(sunMin, sunStats.min)
        sunMax = Math.max(sunMax, sunStats.max)
        sunSum += sunStats.avg * sunStats.count
      }
      layer.group.traverse((object) => {
        if (!(object instanceof THREE.InstancedMesh)) return

        meshes++
        instances += object.count
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of meshMaterials) {
          materials.push({
            chunkKey,
            meshName: object.name,
            materialName: material.name,
            materialType: material.type,
            isShaderMaterial: material instanceof THREE.ShaderMaterial,
            shaderVersion: material.userData.planetPropShaderVersion ?? null,
            count: object.count,
            visible: object.visible && layer.group.visible,
          })
        }
      })
    }

    return {
      settings: { ...this.propSettings },
      assetsLoaded: this.propAssets !== null,
      assetLoadRequested: this.propAssetLoadRequested,
      layers: this.propLayers.size,
      preparing: this.propPrepareJobs.size,
      preparationMs: this.propPreparationMs,
      scatterCacheEntries: this.propScatterCache.size,
      visibleLayers,
      visibleLayersByLod: Array.from(lodTiers, count => count ?? 0),
      meshes,
      instances,
      visibleInstances: this.propVisibleInstances,
      uniqueMaterialNames: [...new Set(materials.map(material => material.materialName))],
      shaderVersions: [...new Set(materials.map(material => material.shaderVersion))],
      sunLight: {
        count: sunCount,
        min: sunCount > 0 ? sunMin : 0,
        max: sunCount > 0 ? sunMax : 0,
        avg: sunCount > 0 ? sunSum / sunCount : 0,
      },
      materials: materials.slice(0, 24),
    }
  }

  update(camera: THREE.Camera, _dt: number) {
    this.time += _dt
    this.propSunLightSpentMs = 0
    this.propPreparationMs = 0
    this.consumePendingScatterRebuilds()
    this.generatedChunksLastFrame = 0
    this.chunkGenerationMsLastFrame = 0
    this.chunkIntegrationMsLastFrame = 0
    this.grassVisibleInstances = 0
    this.propVisibleInstances = 0

    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)

    const planetPos = new THREE.Vector3()
    this.group.getWorldPosition(planetPos)
    if (this.grassMaterial) {
      updateFluffyGrassMaterial(
        this.grassMaterial,
        this.grassSettings,
        this.time,
        this.sunPosition,
        planetPos,
        this.planetRadius,
        1,
        1,
        0,
        1,
      )
    }
    if (this.farGrassMaterial) {
      updateFluffyGrassMaterial(
        this.farGrassMaterial,
        this.grassSettings,
        this.time,
        this.sunPosition,
        planetPos,
        this.planetRadius,
        GRASS_FAR_DISTANCE_MULTIPLIER,
        0.72,
        this.grassSettings.distance,
        1,
      )
    }
    const planetQuat = new THREE.Quaternion()
    this.group.getWorldQuaternion(planetQuat)
    const inversePlanetQuat = planetQuat.clone().invert()
    const localCamPos = camPos.clone().sub(planetPos).applyQuaternion(inversePlanetQuat)
    this.lastLocalCamPos.copy(localCamPos)
    this.hasLocalCamPos = true
    this.underwaterViewState = this.computeUnderwaterViewState(localCamPos)
    this.updateOceanViewSide(this.underwaterViewState)
    this.cloudLocalSunDirection.copy(this.sunPosition).sub(planetPos).applyQuaternion(inversePlanetQuat)
    if (this.cloudLocalSunDirection.lengthSq() > 0.000001) {
      this.cloudLocalSunDirection.normalize()
    } else {
      this.cloudLocalSunDirection.set(0, 1, 0)
    }

    const surfaceDist = this.getLocalSurfaceDistance(localCamPos)
    if (this.hasActiveClouds()) {
      this.updateCloudQuality(surfaceDist)
      this.updateCloudRenderSide(localCamPos)
    }
    this.updateSurfaceLightingBlend(surfaceDist)

    if (this.propAssets) {
      updatePlanetPropMaterials(this.propAssets, {
        sunPosition: this.sunPosition,
        planetCenter: planetPos,
        sunColor: this.sunColor,
        atmosphereLightColor: this.atmosphereLightColor,
        atmosphereInfluence: this.atmosphereDensity,
        terrainAoStrength: this.terrainAoStrength,
        cloudMask: this.cloudMask.texture,
        cloudMaskOffset: this.getCloudMaskOffset(),
        cloudHeight: this.cloudHeight,
        cloudShadowStrength: this.hasActiveClouds() ? this.cloudShadow : 0,
        cloudLocalSunDirection: this.cloudLocalSunDirection,
        time: this.time,
        // The trees answer the same wind the grass does -- same directions,
        // same frequencies, same strength -- so a gust leans a whole clearing
        // at once instead of each layer running its own private weather.
        windStrength: this.grassSettings.windStrength,
        foliage: this.foliageSettings,
      })
      setPlanetPropFoliagePalettes(this.propAssets, this.foliagePalettes)
    }
    this.chunkPriorityCache.clear()
    this.chunkNodeCache.clear()

    // Update sun position uniform
    this.material.uniforms.uSunPosition.value.copy(this.sunPosition)
    for (const material of this.farLodMaterials) {
      material.uniforms.uSunPosition.value.copy(this.sunPosition)
    }
    this.fallbackMaterial.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.cloudMaterial?.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.cloudBillboardMaterial?.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.oceanMaterial?.uniforms.uSunPosition.value.copy(this.sunPosition)
    this.atmosphereMaterial?.uniforms.uSunPosition.value.copy(this.sunPosition)
    const cloudLocalSunMaterials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
      this.oceanMaterial,
      this.cloudMaterial,
      this.grassMaterial,
      this.farGrassMaterial,
    ]
    for (const material of cloudLocalSunMaterials) {
      this.copyVectorUniform(material, 'uCloudLocalSunDirection', this.cloudLocalSunDirection)
    }
    this.updateLightColorUniforms()
    this.setFloatUniform(this.material, 'uTime', this.time)
    for (const material of this.farLodMaterials) {
      this.setFloatUniform(material, 'uTime', this.time)
    }
    this.setFloatUniform(this.fallbackMaterial, 'uTime', this.time)
    const cloudMaskOffset = this.getCloudMaskOffset()
    const cloudMaskMaterials = [
      this.material,
      ...this.farLodMaterials,
      this.fallbackMaterial,
      this.oceanMaterial,
      this.cloudMaterial,
      this.grassMaterial,
      this.farGrassMaterial,
    ]
    for (const material of cloudMaskMaterials) {
      this.setFloatUniform(material, 'uCloudMaskOffset', cloudMaskOffset)
    }
    this.oceanIfft?.update(this.time)
    if (this.oceanIfft && this.oceanMaterial) {
      this.oceanMaterial.uniforms.uIfftMap.value = this.oceanIfft.texture
    }
    this.updateOceanDetailIfft(surfaceDist)
    this.setFloatUniform(this.oceanMaterial, 'uTime', this.time)
    if (this.cloudMaterial) {
      this.group.getWorldPosition(this.cloudMaterial.uniforms.uPlanetCenter.value)
      this.cloudMaterial.uniforms.uTime.value = this.time
    }
    if (this.cloudBillboardMaterial) {
      this.group.getWorldPosition(this.cloudBillboardMaterial.uniforms.uPlanetCenter.value)
      this.cloudBillboardMaterial.uniforms.uTime.value = this.time
    }
    if (this.atmosphereMaterial) {
      this.group.getWorldPosition(this.atmosphereMaterial.uniforms.uPlanetCenter.value)
    }
    // Decide: show fallback sphere or quadtree terrain
    const useTerrain = this.terrainParams.planetType !== 'gas' && surfaceDist < Math.min(this.lodDistances[1], this.planetRadius * 1.5)

    if (!useTerrain) {
      this.updateOceanRenderState()
      this.fallbackSphere.visible = true
      this.fallbackSphere.material = this.debugSimpleTerrain || !this.debugFallbackTerrainShader
        ? this.simpleTerrainMaterial
        : this.fallbackMaterial
      if (this.cloudMesh) this.cloudMesh.visible = this.debugShowClouds && this.cloudOpacity > 0.001
      if (this.cloudBillboardMesh) {
        this.cloudBillboardMesh.visible = false
        this.cloudBillboardMesh.count = 0
        this.cloudBillboardVisibleCount = 0
      }
      if (this.atmosphereMesh) this.atmosphereMesh.visible = this.debugShowAtmosphere
      this.removeAllChunks()
      return
    }

    // Only worth scanning the 2401-cell cloud mask once we know terrain is
    // actually in use — the !useTerrain branch above hides the billboard mesh
    // outright, and that branch is also the worst case for the scan.
    this.updateCloudBillboards(localCamPos, surfaceDist)

    this.fallbackSphere.material = this.debugSimpleTerrain || !this.debugFallbackTerrainShader
      ? this.simpleTerrainMaterial
      : this.fallbackMaterial
    if (this.cloudMesh) this.cloudMesh.visible = this.debugShowClouds && this.cloudOpacity > 0.001
    if (this.atmosphereMesh) this.atmosphereMesh.visible = this.debugShowAtmosphere

    // 1. Update quadtree structure (create/destroy children based on distance)
    for (const root of this.quadtrees) {
      this.updateQuadtree(root, localCamPos)
    }

    // 2. Queue chunks that are needed for the next stable transition.
    //    updateQuadtree just created children with a default `covered` of
    //    false, so coverage has to be refreshed before collectLoadKeys reads it.
    this.propCoverage.clear()
    for (const root of this.quadtrees) {
      this.markCovered(root)
    }
    const loadKeys = new Set<string>()
    for (const root of this.quadtrees) {
      this.collectLoadKeys(root, loadKeys)
    }

    // 3. Retire queued chunks the camera has already left, then queue what is
    //    missing.
    this.retireStalePendingKeys(loadKeys)
    for (const key of loadKeys) {
      if (!this.chunks.has(key) && !this.isChunkBuildPending(key)) {
        this.pendingKeys.add(key)
      }
    }

    // 4. Process pending chunks
    this.integrateCompletedChunkBuilds(localCamPos)
    if (terrainWorkerPoolSize() > 0) {
      this.dispatchPendingChunkBuilds(localCamPos)
    } else {
      this.processPendingChunksSync(localCamPos)
    }

    this.advancePropPreparation()

    // Complete deferred LOD collapses after parent geometry and props exist.
    for (const root of this.quadtrees) {
      this.applyPendingCollapses(root)
    }

    // 4.5 Recompute visibility after generation so promotions happen atomically.
    //     A second coverage pass is mandatory here: integrateCompletedChunkBuilds
    //     added chunks and applyPendingCollapses dropped subtrees, so the flags
    //     from the pass above are stale for both reasons.
    this.propCoverage.clear()
    for (const root of this.quadtrees) {
      this.markCovered(root)
    }
    const renderKeys = new Set<string>()
    const retainKeys = new Set<string>()
    this.renderQuadrantMasks.clear()
    for (const root of this.quadtrees) {
      this.collectRenderKeys(root, renderKeys, this.renderQuadrantMasks)
      this.collectRetainKeys(root, retainKeys)
    }
    const terrainReady = this.hasQuadtreeTerrainCoverage()
    this.updateOceanRenderState()
    this.fallbackSphere.visible = !terrainReady

    // 5. Remove chunks no longer needed. Chunks can be retained while hidden so
    //    a parent only disappears after its target children fully cover it.
    for (const [key, chunk] of this.chunks) {
      if (!retainKeys.has(key)) {
        this.group.remove(chunk.mesh)
        this.disposeChunk(chunk)
        this.chunks.delete(key)
      } else {
        chunk.mesh.visible = terrainReady && renderKeys.has(key)
        if (chunk.mesh.visible) {
          if (this.debugSimpleTerrain) {
            chunk.mesh.material = this.simpleTerrainMaterial
          } else if (this.shouldUseDetailedMaterial(chunk, localCamPos)) {
            chunk.mesh.material = this.debugNearTerrainShader ? this.material : this.simpleTerrainMaterial
          } else {
            chunk.mesh.material = this.debugFarTerrainShader ? this.getFarLodMaterial(chunk.node.lod) : this.simpleTerrainMaterial
          }
        }
        this.updateChunkGrassVisibility(chunk, localCamPos)
        this.updateChunkPropVisibility(chunk, localCamPos)
      }
    }

    this.updateVisibleStitching(renderKeys)
  }

  private updateQuadtree(
    node: QuadtreeNode,
    localCamPos: THREE.Vector3,
  ) {
    const dist = this.getLocalChunkDistToCamera(node, localCamPos)
    const splitDistance = this.lodDistances[node.lod + 1]
    const keepChildrenDistance = splitDistance * LOD_COLLAPSE_HYSTERESIS
    const shouldSub =
      !this.isBelowHorizon(node, localCamPos) &&
      node.lod < this.maxLod &&
      dist < (node.children ? keepChildrenDistance : splitDistance) &&
      this.isChunkRelevantForDetail(node, localCamPos)

    if (shouldSub) {
      this.pendingCollapseKeys.delete(node.key)

      if (!node.children) {
        node.children = createChildren(node)
      }
      for (const child of node.children) {
        this.updateQuadtree(child, localCamPos)
      }
    } else {
      if (node.children) {
        const key = node.key
        if (this.isPropReady(this.chunks.get(key))) {
          this.removeChildrenChunks(node)
          node.children = null
        } else {
          if (!this.chunks.has(key)) this.pendingKeys.add(key)
          this.pendingCollapseKeys.add(key)
        }
      }
    }
  }

  private applyPendingCollapses(node: QuadtreeNode) {
    if (!node.children) return

    const key = node.key
    if (this.pendingCollapseKeys.has(key) && this.isPropReady(this.chunks.get(key))) {
      this.removeChildrenChunks(node)
      node.children = null
      this.pendingCollapseKeys.delete(key)
      return
    }

    for (const child of node.children) {
      this.applyPendingCollapses(child)
    }
  }

  private getLocalChunkDistToCamera(node: QuadtreeNode, localCamPos: THREE.Vector3): number {
    const surfaceRadius = this.getNodeSurfaceRadius(node)
    const center = getNodeCenter(node, _nodeDir).multiplyScalar(surfaceRadius)
    return Math.max(0, localCamPos.distanceTo(center) - this.getNodeBoundingRadius(node, surfaceRadius))
  }

  private getNodeSurfaceRadius(node: QuadtreeNode): number {
    const key = node.key
    const cached = this.nodeSurfaceRadiusCache.get(key)
    if (cached !== undefined) return cached

    const radius = samplePlanetRadius(getNodeCenter(node, _radiusDir), this.terrainParams)
    this.nodeSurfaceRadiusCache.set(key, radius)
    return radius
  }

  private getNodeBoundingRadius(node: QuadtreeNode, radius = this.planetRadius): number {
    const levelCells = 1 << node.lod
    const approxFacePatch = (2 / levelCells) * radius
    return approxFacePatch * 1.5
  }

  private getLocalSurfaceDistance(localCamPos: THREE.Vector3): number {
    if (localCamPos.lengthSq() === 0) return 0

    const dir = localCamPos.clone().normalize()
    return localCamPos.length() - samplePlanetRadius(dir, this.terrainParams)
  }

  private isChunkRelevantForDetail(node: QuadtreeNode, localCamPos: THREE.Vector3): boolean {
    if (localCamPos.lengthSq() === 0) return true

    const facing = getNodeCenter(node, _nodeDir).dot(_camDir.copy(localCamPos).normalize())
    return facing > -0.15
  }

  private isBelowHorizon(node: QuadtreeNode, localCamPos: THREE.Vector3): boolean {
    // Camera inside or on the surface — nothing is below horizon
    if (localCamPos.lengthSq() <= this.planetRadius * this.planetRadius) return false

    const chunkDir = getNodeCenter(node, _horizonDir)
    const boundingRadius = this.getNodeBoundingRadius(node)
    const camDist = localCamPos.length()

    // Chunk is below horizon when even its nearest point is hidden.
    // Margin = boundingRadius * camDist / R accounts for chunk extent:
    // large (coarse) chunks get big margin, small (fine) chunks get tight culling.
    return chunkDir.dot(localCamPos) <= this.planetRadius - boundingRadius * this.horizonMargin * camDist / this.planetRadius
  }

  private shouldUseDetailedMaterial(
    chunk: TerrainChunk,
    localCamPos: THREE.Vector3,
  ): boolean {
    const minDetailedLod = Math.min(DETAILED_MATERIAL_MIN_LOD, Math.max(0, this.maxLod - 1))
    if (chunk.node.lod < minDetailedLod) return false

    return this.getLocalChunkDistToCamera(chunk.node, localCamPos) < DETAILED_MATERIAL_DISTANCE
  }

  private getFarLodMaterial(lod: number): THREE.ShaderMaterial {
    const index = FAR_TEXTURE_LOD_BANDS.findIndex(band => lod <= band.maxLod)
    return this.farLodMaterials[Math.max(0, index)] ?? this.farMaterial
  }

  private findVisibleChunkForDirection(dir: Vec3Like): TerrainChunk | null {
    const faceUv = this.directionToFaceUv(dir)
    if (!faceUv) return null

    for (let lod = this.maxLod; lod >= 0; lod--) {
      const cells = 1 << lod
      const x = Math.min(cells - 1, Math.max(0, Math.floor(((faceUv.u + 1) * 0.5) * cells)))
      const y = Math.min(cells - 1, Math.max(0, Math.floor(((faceUv.v + 1) * 0.5) * cells)))
      const chunk = this.chunks.get(nodeKey(faceUv.face, lod, x, y))
      if (chunk?.mesh.visible) return chunk
    }

    return null
  }

  private directionToFaceUv(dir: Vec3Like): { face: CubeFace; u: number; v: number } | null {
    const ax = Math.abs(dir.x)
    const ay = Math.abs(dir.y)
    const az = Math.abs(dir.z)
    const m = Math.max(ax, ay, az)
    if (m <= 0) return null

    if (m === ax) {
      return dir.x >= 0
        ? { face: CubeFace.PX, u: dir.z / ax, v: dir.y / ax }
        : { face: CubeFace.NX, u: -dir.z / ax, v: dir.y / ax }
    }
    if (m === ay) {
      return dir.y >= 0
        ? { face: CubeFace.PY, u: dir.x / ay, v: dir.z / ay }
        : { face: CubeFace.NY, u: dir.x / ay, v: -dir.z / ay }
    }
    return dir.z >= 0
      ? { face: CubeFace.PZ, u: dir.x / az, v: dir.y / az }
      : { face: CubeFace.NZ, u: -dir.x / az, v: dir.y / az }
  }

  // Recomputes `covered` for a whole quadtree in one post-order pass.
  //
  // This replaces isNodeCovered, which rebuilt a key string per visit and, on a
  // miss, re-walked the entire subtree — and was called independently by
  // collectLoadKeys (twice per child), collectRenderKeys, collectRetainKeys and
  // hasQuadtreeTerrainCoverage, so the same answer was derived four-plus times.
  //
  // Always recurses into children even when this node is covered by its own
  // chunk: collectLoadKeys reads `child.covered` for children of covered
  // parents, so a stale flag anywhere in the tree would change the load set.
  private markCovered(node: QuadtreeNode): boolean {
    let childrenCovered = false
    if (node.children) {
      childrenCovered = true
      for (const child of node.children) {
        if (!this.markCovered(child)) childrenCovered = false
      }
    }
    const propChildrenCovered = node.children !== null && node.children.every(child => this.propCoverage.get(child.key))
    this.propCoverage.set(node.key, this.isPropReady(this.chunks.get(node.key)) || propChildrenCovered)
    node.covered = this.chunks.has(node.key) || (node.children !== null && childrenCovered)
    return node.covered
  }

  private collectLoadKeys(node: QuadtreeNode, out: Set<string>) {
    if (!node.children) {
      if (!this.chunks.has(node.key)) out.add(node.key)
      return
    }

    const childrenCovered = node.children.every(child => child.covered)
    if (!childrenCovered) {
      if (!this.chunks.has(node.key)) out.add(node.key)
      // Finish all four siblings before requesting grandchildren. Otherwise
      // fine chunks accumulate invisibly behind an incomplete parent patch.
      //
      // Measured 2026-09-11: this gate costs ~110 frames per LOD level with a
      // stationary camera (1374 frames to the first lod-10 chunk). Descending
      // regardless of sibling coverage removes that entirely -- and drops the
      // ground under a 55 m/s pass from lod 9 to lod 2, because promotion in
      // collectRenderKeys needs a *contiguous* covered quad, which is exactly
      // what breadth-first ordering produces and depth-first does not. The
      // serialisation is the price of promotion, not an oversight.
      for (const child of node.children) {
        if (!child.covered) out.add(child.key)
      }
      return
    }

    for (const child of node.children) this.collectLoadKeys(child, out)
  }

  // Builds the visible set, and with it the quadrant mask each partially
  // refined patch must draw around.
  //
  // Promotion used to be all-or-nothing: either this patch drew, or all four
  // children did. One child short and three finished ones stayed off screen,
  // which is why collectLoadKeys had to complete every level planet-wide
  // before requesting the next -- at ~110 frames per level. Masking the parent
  // per quadrant lets each child appear the moment it is built, using the index
  // rewrite TerrainChunk already performs for stitching: no extra draw call and
  // no fragment cost, which matters because this frame is fragment bound.
  //
  // `masks` is optional so the existing prop-lod checks can still call this
  // with two arguments.
  private collectRenderKeys(node: QuadtreeNode, out: Set<string>, masks?: Map<string, number>) {
    if (!node.children) {
      if (this.chunks.has(node.key)) out.add(node.key)
      return
    }

    let readyMask = 0
    let allReady = true
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (child.covered && this.propCoverage.get(child.key)) readyMask |= 1 << i
      else allReady = false
    }

    if (allReady) {
      for (const child of node.children) this.collectRenderKeys(child, out, masks)
      return
    }

    if (this.chunks.has(node.key)) {
      out.add(node.key)
      if (readyMask !== 0) {
        masks?.set(node.key, readyMask)
        for (let i = 0; i < node.children.length; i++) {
          if (readyMask & (1 << i)) this.collectRenderKeys(node.children[i], out, masks)
        }
      }
      return
    }

    // No chunk here to mask, so there is nothing to draw the gaps: fall back to
    // whatever the children can cover, as before.
    for (const child of node.children) this.collectRenderKeys(child, out, masks)
  }

  private collectRetainKeys(node: QuadtreeNode, out: Set<string>) {
    if (!node.children) {
      out.add(node.key)
      return
    }

    const childrenCovered = node.children.every(child => child.covered && this.propCoverage.get(child.key))
    if (!childrenCovered || this.pendingCollapseKeys.has(node.key)) out.add(node.key)
    for (const child of node.children) this.collectRetainKeys(child, out)
  }

  private hasQuadtreeTerrainCoverage(): boolean {
    return this.quadtrees.every(root => root.covered)
  }

  // Drops queued chunks that are no longer part of the load set.
  //
  // Nothing used to leave pendingKeys without being built: the only removal
  // was removeChildrenChunks, which runs on collapse. Flying low and fast
  // retires load keys far quicker than the worker pool drains them, so the
  // queue accumulated every patch the flight path ever grazed. A stale key is
  // not harmless -- it reaches the front as soon as the near work runs dry,
  // and then costs a worker slot, a geometry build, a prop scatter job and a
  // dispose in the same frame it lands, all for ground already behind the
  // camera.
  //
  // Self-healing: a key that still matters is re-added by the caller on the
  // very next frame. Deferred collapse parents are the one thing kept
  // explicitly -- collectLoadKeys stops descending once children are covered,
  // so it never names them, and dropping them would strand the collapse
  // permanently.
  private retireStalePendingKeys(loadKeys: Set<string>) {
    for (const key of this.pendingKeys) {
      if (!loadKeys.has(key) && !this.pendingCollapseKeys.has(key)) {
        this.pendingKeys.delete(key)
      }
    }
  }

  private isChunkBuildPending(key: string): boolean {
    return this.pendingKeys.has(key) || this.pendingWorkerKeys.has(key)
  }

  // Memoised for the frame. compareChunkBuildPriority parses both of its
  // operands, findBestPendingChunkKey compares every pending key against the
  // running best, and the dispatch loop calls that once per chunk it sends --
  // so an uncached parse ran O(pending x dispatched x 2) times per frame, each
  // one a split into four strings plus a fresh node object. At the queue sizes
  // a flyover produces that scan alone could exhaust WORKER_DISPATCH_BUDGET_MS,
  // throttling streaming exactly when the backlog was longest. Cleared with
  // chunkPriorityCache so the map stays bounded by one frame's key set.
  private parseChunkKey(key: string): QuadtreeNode | null {
    const memo = this.chunkNodeCache.get(key)
    if (memo !== undefined) return memo

    const node = this.buildChunkKeyNode(key)
    this.chunkNodeCache.set(key, node)
    return node
  }

  private buildChunkKeyNode(key: string): QuadtreeNode | null {
    const parts = key.split('_')
    if (parts.length !== 4) return null

    const face = parseInt(parts[0]) as CubeFace
    const lod = parseInt(parts[1])
    const x = parseInt(parts[2])
    const y = parseInt(parts[3])

    if (!Number.isFinite(face) || !Number.isFinite(lod) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null
    }

    // These synthetic nodes are not part of any quadtree, but they flow into
    // createChunk and the worker request, both of which now read node.key —
    // leaving it undefined here would silently break chunk lookup.
    return { face, lod, x, y, children: null, key, covered: false }
  }

  private integrateCompletedChunkBuilds(localCamPos: THREE.Vector3) {
    const integrationStart = performance.now()
    if (this.completedWorkerJobs.length > 1) {
      this.completedWorkerJobs.sort((a, b) => this.compareChunkBuildPriority(a.key, b.key, localCamPos))
    }

    while (this.completedWorkerJobs.length > 0) {
      if (this.generatedChunksLastFrame > 0 && performance.now() - integrationStart >= this.chunkIntegrationBudgetMs) break

      const result = this.completedWorkerJobs.shift()
      if (!result) break

      if (result.epoch !== this.chunkBuildEpoch || !this.pendingWorkerKeys.delete(result.key) || this.chunks.has(result.key)) {
        continue
      }

      const start = performance.now()
      const chunk = this.createChunk(result.node, result.geometry)
      this.chunkIntegrationMsLastFrame += performance.now() - start
      this.chunkGenerationMsLastFrame += result.durationMs
      this.chunks.set(result.key, chunk)
      this.group.add(chunk.mesh)
      this.generatedChunksLastFrame++
    }
  }

  private dispatchPendingChunkBuilds(localCamPos: THREE.Vector3) {
    if (this.pendingKeys.size === 0) return
    // Applying geometry is frame-budgeted. Do not let workers outrun upload
    // indefinitely, especially when the browser throttles a background tab.
    if (this.completedWorkerJobs.length >= terrainWorkerPoolSize() * 2) return

    const dispatchStart = performance.now()
    for (;;) {
      if (performance.now() - dispatchStart >= this.workerDispatchBudgetMs) break

      const key = this.findBestPendingChunkKey(localCamPos)
      if (!key) break

      const node = this.parseChunkKey(key)
      this.pendingKeys.delete(key)
      if (!node || this.chunks.has(key) || this.pendingWorkerKeys.has(key)) continue

      const worker = acquireTerrainWorker(
        this,
        response => this.handleChunkWorkerResponse(response),
        () => this.failChunkWorkerJob(key),
      )
      // Pool is saturated. Put the key back and let the next frame try again --
      // a distant planet whose quadtree has settled asks for nothing, so in
      // practice the planet under the player gets the whole pool.
      if (!worker) {
        this.pendingKeys.add(key)
        break
      }

      const jobId = this.nextWorkerJobId++
      this.pendingWorkerKeys.add(key)
      worker.postMessage({
        type: 'build',
        id: jobId,
        epoch: this.chunkBuildEpoch,
        key,
        node,
        terrain: this.terrainParams,
        gridSize: this.gridSize,
        skirts: { bottom: false, top: false, left: false, right: false },
      })
    }
  }

  // Was the per-slot onmessage closure. The pool frees the worker before this
  // runs, so a chunk that lands early can be replaced on the next dispatch.
  private handleChunkWorkerResponse(response: TerrainWorkerResponse) {
    if (
      response.type === 'ocean-built' || response.type === 'ocean-error'
      || response.type === 'prop-sun-built' || response.type === 'prop-sun-error'
    ) return
    if (response.epoch !== this.chunkBuildEpoch) return

    if (response.type === 'error') {
      this.pendingWorkerKeys.delete(response.key)
      this.pendingKeys.add(response.key)
      if (import.meta.env.DEV) {
        console.warn(`Terrain worker failed for ${response.key}: ${response.message}`)
      }
      return
    }

    if (!this.pendingWorkerKeys.has(response.key)) return
    this.completedWorkerJobs.push(response)
  }

  private failChunkWorkerJob(key: string) {
    this.pendingWorkerKeys.delete(key)
    this.pendingKeys.add(key)
  }

  private processPendingChunksSync(localCamPos: THREE.Vector3) {
    const buildStart = performance.now()

    while (this.pendingKeys.size > 0) {
      if (this.generatedChunksLastFrame > 0 && performance.now() - buildStart >= this.syncChunkBuildBudgetMs) break

      const key = this.findBestPendingChunkKey(localCamPos)
      if (!key) break

      const generationStart = performance.now()
      const chunk = this.generateChunk(key)
      this.chunkGenerationMsLastFrame += performance.now() - generationStart
      if (chunk) {
        this.chunks.set(key, chunk)
        this.group.add(chunk.mesh)
        this.generatedChunksLastFrame++
      }
      this.pendingKeys.delete(key)
    }
  }

  private findBestPendingChunkKey(localCamPos: THREE.Vector3): string | null {
    let bestKey: string | null = null

    for (const key of this.pendingKeys) {
      if (!bestKey || this.compareChunkBuildPriority(key, bestKey, localCamPos) < 0) {
        bestKey = key
      }
    }

    return bestKey
  }

  private compareChunkBuildPriority(aKey: string, bKey: string, localCamPos: THREE.Vector3): number {
    const a = this.parseChunkKey(aKey)
    const b = this.parseChunkKey(bKey)
    if (!a || !b) return a ? -1 : b ? 1 : aKey.localeCompare(bKey)

    // Complete the planetary safety net before refining local detail.
    if ((a.lod <= 2) !== (b.lod <= 2)) return a.lod <= 2 ? -1 : 1

    const distDelta = this.getChunkBuildPriority(aKey, a, localCamPos) - this.getChunkBuildPriority(bKey, b, localCamPos)
    if (Math.abs(distDelta) > 0.0001) return distDelta

    // If two chunks are equally near the camera, build the coarser coverage first
    // so transitions keep their parent patch while children fill in around it.
    if (a.lod !== b.lod) return a.lod - b.lod
    if (a.face !== b.face) return a.face - b.face
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  }

  private getChunkBuildPriority(key: string, node: QuadtreeNode, localCamPos: THREE.Vector3): number {
    const cached = this.chunkPriorityCache.get(key)
    if (cached !== undefined) return cached

    // Bounding spheres overlap generously. Distance-to-bound alone is zero
    // for hundreds of patches, starving the ground under the player while
    // unrelated coarse patches win the tie. Retain coverage priority, but
    // distinguish those overlaps by their actual distance to the patch centre.
    const surfaceRadius = this.getNodeSurfaceRadius(node)
    const centerDistance = getNodeCenter(node, _nodeDir).multiplyScalar(surfaceRadius).distanceTo(localCamPos)
    const priority = Math.max(0, centerDistance - this.getNodeBoundingRadius(node, surfaceRadius))
      + centerDistance * 0.08
    this.chunkPriorityCache.set(key, priority)
    return priority
  }

  private removeChildrenChunks(node: QuadtreeNode) {
    if (!node.children) return
    for (const child of node.children) {
      this.removeChildrenChunks(child)
      const key = child.key
      const chunk = this.chunks.get(key)
      if (chunk) {
        this.group.remove(chunk.mesh)
        this.disposeChunk(chunk)
        this.chunks.delete(key)
      }
      this.pendingKeys.delete(key)
      this.pendingWorkerKeys.delete(key)
      this.pendingCollapseKeys.delete(key)
    }
  }

  private generateChunk(key: string): TerrainChunk | null {
    const node = this.parseChunkKey(key)
    if (!node) return null

    return this.createChunk(node)
  }

  private createChunk(node: QuadtreeNode, geometryData?: TerrainChunkGeometryData): TerrainChunk {
    const chunk = new TerrainChunk(
      node,
      this.terrainParams,
      this.farMaterial,
      this.gridSize,
      { bottom: false, top: false, left: false, right: false },
      geometryData,
    )
    chunk.mesh.layers.enable(CLOUD_OCCLUDER_RENDER_LAYER)
    this.attachGrassLayer(chunk)
    this.attachPropLayer(chunk)
    return chunk
  }

  private attachGrassLayer(chunk: TerrainChunk) {
    if (!this.grassSettings.enabled) return

    if (chunk.node.lod >= this.grassNearMinLod) {
      this.attachGrassVariant(chunk, 'near')
    }
    if (chunk.node.lod >= this.grassFarMinLod) {
      this.attachGrassVariant(chunk, 'far')
    }
  }

  private attachGrassVariant(chunk: TerrainChunk, variant: FluffyGrassVariant) {
    const material = variant === 'near' ? this.grassMaterial : this.farGrassMaterial
    if (!material) return

    const grass = new FluffyGrassLayer({
      node: chunk.node,
      surface: chunk.getSurfaceData(),
      material,
      settings: this.grassSettings,
      seed: this.noiseProfile.seed,
      seaHeight: this.seaHeight,
      planetType: this.terrainParams.planetType,
      variant,
    })
    if (grass.instanceCount <= 0) {
      grass.dispose()
      return
    }

    chunk.mesh.add(grass.mesh)
    if (variant === 'near') {
      this.grassLayers.set(chunk.key, grass)
    } else {
      this.farGrassLayers.set(chunk.key, grass)
    }
  }

  private rebuildGrassLayers() {
    this.clearGrassLayers()
    if (!this.grassSettings.enabled) return

    for (const [, chunk] of this.chunks) {
      this.attachGrassLayer(chunk)
    }
  }

  // Prop layers are built lazily. The LOD gate alone does not match how they
  // are *shown*: visibility is by distance (propSettings.distance, 648 in game),
  // while the LOD-3 threshold at radius 650 sits at 1007 units — so a large
  // fraction of layers were cloned, uploaded and sun-lit for chunks that could
  // never render. Each one costs a deep geometry clone (up to ~1.8MB per chunk),
  // five instanced attributes, a bounding-sphere pass and the horizon raymarch.
  // Chunks that come into range get their layer from updateChunkPropVisibility.
  private shouldHavePropLayer(chunk: TerrainChunk): boolean {
    if (!this.propSettings.enabled || !this.propAssets || this.terrainParams.planetType !== 'rocky') return false
    if (chunk.node.lod < this.propMinLod) return false
    if (!this.hasLocalCamPos) return true
    // Build slightly outside the show distance so crossing the boundary does not
    // pop, and so a camera hovering on the edge does not rebuild every frame.
    return this.getLocalChunkDistToCamera(chunk.node, this.lastLocalCamPos)
      < this.propSettings.distance * PROP_BUILD_DISTANCE_MARGIN
  }

  private propLayerParams(chunk: TerrainChunk) {
    return {
      node: chunk.node,
      scatterCache: this.propScatterCache,
      assets: this.propAssets!,
      settings: this.propSettings,
      terrain: this.terrainParams,
      seed: this.noiseProfile.seed,
      seaHeight: this.seaHeight,
      planetType: this.terrainParams.planetType,
    }
  }

  private attachPropLayer(chunk: TerrainChunk) {
    if (!this.shouldHavePropLayer(chunk) || this.propLayers.has(chunk.key) || this.propPrepareJobs.has(chunk.key)) return
    this.propPrepareJobs.set(chunk.key, {
      chunk,
      steps: PlanetPropLayer.preparePlacements(this.propLayerParams(chunk)),
    })
  }

  private advancePropPreparation() {
    const start = performance.now()
    // Finish coarse coverage first, then the closest patch. Interrupted jobs
    // retain their iterator; a frame never restarts an expensive scatter.
    const jobs = [...this.propPrepareJobs.values()].sort((a, b) =>
      a.chunk.node.lod - b.chunk.node.lod
      || this.getLocalChunkDistToCamera(a.chunk.node, this.lastLocalCamPos)
        - this.getLocalChunkDistToCamera(b.chunk.node, this.lastLocalCamPos))
    for (const job of jobs) {
      if (performance.now() - start >= this.propScatterBudgetMs) break
      if (this.chunks.get(job.chunk.key) !== job.chunk || !this.shouldHavePropLayer(job.chunk)) {
        this.propPrepareJobs.delete(job.chunk.key)
        continue
      }
      while (performance.now() - start < this.propScatterBudgetMs) {
        const result = job.steps.next()
        if (!result.done) continue
        this.propPrepareJobs.delete(job.chunk.key)
        const props = new PlanetPropLayer({ ...this.propLayerParams(job.chunk), preparedPlacements: result.value })
        props.updateSunLight(this.cloudLocalSunDirection, true)
        job.chunk.mesh.add(props.group)
        // Empty habitat is ready too; don't resample it every frame.
        this.propLayers.set(job.chunk.key, props)
        break
      }
    }
    this.propPreparationMs = performance.now() - start
  }

  private isPropReady(chunk: TerrainChunk | undefined): boolean {
    return !!chunk && (!this.shouldHavePropLayer(chunk) || this.propLayers.has(chunk.key))
  }

  private rebuildPropLayers() {
    this.clearPropLayers()
    if (!this.propSettings.enabled || !this.propAssets) return

    for (const [, chunk] of this.chunks) {
      this.attachPropLayer(chunk)
    }
  }

  private clearPropLayers() {
    this.propScatterCache.clear()
    this.propPrepareJobs.clear()
    this.propSunJobs.clear()
    this.propSunInFlightChunks.clear()
    for (const [, props] of this.propLayers) {
      props.dispose()
    }
    this.propLayers.clear()
    this.propVisibleInstances = 0
  }

  private clearGrassLayers() {
    for (const [, grass] of this.grassLayers) {
      grass.dispose()
    }
    for (const [, grass] of this.farGrassLayers) {
      grass.dispose()
    }
    this.grassLayers.clear()
    this.farGrassLayers.clear()
    this.grassVisibleInstances = 0
  }

  private createOceanLayer(params: PlanetRendererParams, waterLevel: number) {
    if (this.seaHeight < -1 || params.planetType === 'gas') return

    const seaRadius = this.planetRadius + this.seaHeight * params.terrainScale * this.planetRadius
    if (!Number.isFinite(seaRadius) || seaRadius <= 0) return

    this.oceanSeaRadius = seaRadius
    const oceanGeo = new THREE.IcosahedronGeometry(seaRadius, OCEAN_GEODESIC_DETAIL)
    this.oceanMeshFacetInset = this.measureOceanMeshFacetInset(oceanGeo)
    const oceanDirections = this.addOceanTerrainHeightAttribute(oceanGeo)
    this.oceanGeometry = oceanGeo
    this.terminateOceanWorkers()
    this.propSunWorker?.terminate()
    this.propSunWorker = null
    this.propSunJobs.clear()
    this.propSunInFlightChunks.clear()
    this.oceanShoreMask?.dispose()
    this.oceanShoreMask = this.createOceanShoreMaskTexture()
    this.oceanDataReady = false
    this.dispatchOceanData(oceanDirections)
    const oceanWaveHeight = params.oceanWaveHeight ?? DEFAULT_OCEAN_WAVE_HEIGHT
    this.oceanWaveHeight = oceanWaveHeight
    const oceanSpectrumParams = {
      seed: Number(params.seed),
      planetRadius: this.planetRadius,
      terrainScale: params.terrainScale,
      waterLevel,
      waveHeight: oceanWaveHeight,
      windSpeed: params.oceanWindSpeed ?? THREE.MathUtils.lerp(18, 32, THREE.MathUtils.clamp(waterLevel, 0, 1)),
      detail: params.oceanDetail ?? 1.45,
      choppiness: params.oceanChoppiness ?? 1.1,
      foamStrength: params.oceanFoamStrength ?? THREE.MathUtils.lerp(0.46, 0.82, THREE.MathUtils.clamp(waterLevel, 0, 1)),
    }
    const gpuIfftRenderer = this.renderer && OceanGpuIfftSpectrum.isSupported(this.renderer, 512)
      ? this.renderer
      : null
    this.oceanIfft = gpuIfftRenderer
      ? new OceanGpuIfftSpectrum(gpuIfftRenderer, {
          ...oceanSpectrumParams,
          size: 512,
        })
      : new OceanIfftSpectrum(oceanSpectrumParams)
    if (gpuIfftRenderer && this.oceanIfft instanceof OceanGpuIfftSpectrum) {
      const detail = THREE.MathUtils.clamp(params.oceanDetail ?? 1.45, 0.35, 3)
      const detailBlend = THREE.MathUtils.smoothstep(detail, 0.35, 3)
      const detailWorldSize = THREE.MathUtils.clamp(
        this.oceanIfft.worldSize * THREE.MathUtils.lerp(0.12, 0.065, detailBlend),
        150,
        320,
      )
      this.oceanDetailIfft = new OceanGpuIfftSpectrum(gpuIfftRenderer, {
        ...oceanSpectrumParams,
        seed: (Number(params.seed) ^ 0x6A09E667) >>> 0,
        size: 512,
        worldSize: detailWorldSize,
        waveHeight: oceanWaveHeight * 0.46,
        windSpeed: Math.max(8, oceanSpectrumParams.windSpeed * 0.50),
        detail: Math.min(3, detail * 2.55),
        choppiness: THREE.MathUtils.clamp(oceanSpectrumParams.choppiness * 0.56 + 0.62, 0, 2.5),
        foamStrength: oceanSpectrumParams.foamStrength,
        waveHeightScale: 0.052,
        normalStrengthScale: THREE.MathUtils.lerp(2.25, 3.15, detailBlend),
        foamStrengthScale: 0.22,
        minHarmonic: 30,
        maxHarmonic: 512 * 0.46,
      })
    }

    this.oceanMaterial = createOceanMaterial({
      seed: Number(params.seed),
      planetType: params.planetType,
      seaHeight: this.seaHeight,
      seaRadius,
      planetRadius: this.planetRadius,
      terrainScale: params.terrainScale,
      waterLevel,
      sunPosition: this.sunPosition,
      sunColor: this.sunColor,
      atmosphereColor: this.atmosphereColor,
      atmosphereLightColor: this.atmosphereLightColor,
      cloudMask: this.cloudMask.texture,
      shoreMask: this.oceanShoreMask,
      shoreMaskDepthScale: OCEAN_SHORE_MASK_DEPTH_SCALE,
      cloudShadow: this.cloudShadow,
      cloudCoverage: this.cloudCoverage,
      cloudScale: this.cloudScale,
      cloudSoftness: this.cloudSoftness,
      cloudHeight: this.cloudHeight,
      cloudSpeed: this.cloudSpeed,
      cloudStorms: this.cloudStorms,
      cloudBands: this.cloudBands,
      cloudDetail: this.cloudDetail,
      ifftTexture: this.oceanIfft.texture,
      ifftWorldSize: this.oceanIfft.worldSize,
      ifftHeightScale: this.oceanIfft.heightScale,
      ifftNormalStrength: this.oceanIfft.normalStrength,
      ifftFoamStrength: this.oceanIfft.foamStrength,
      ifftChoppiness: this.oceanIfft.choppiness,
      ifftDetailTexture: this.oceanDetailIfft?.texture,
      ifftDetailWorldSize: this.oceanDetailIfft?.worldSize,
      ifftDetailHeightScale: this.oceanDetailIfft?.heightScale,
      ifftDetailNormalStrength: this.oceanDetailIfft?.normalStrength,
      ifftDetailFoamStrength: this.oceanDetailIfft?.foamStrength,
      ifftDetailChoppiness: this.oceanDetailIfft?.choppiness,
      ifftDetailNearDistance: 820,
      ifftDetailFarDistance: 2600,
      waveDetail: params.oceanDetail ?? 1.45,
      deepColor: params.oceanDeepColor,
      shallowColor: params.oceanShallowColor,
      foamColor: params.oceanFoamColor,
      clarity: params.oceanClarity,
      absorption: params.oceanAbsorption,
      turbidity: params.oceanTurbidity,
      reflectionStrength: params.oceanReflectionStrength,
      specularStrength: params.oceanSpecularStrength ?? 1,
    })

    this.oceanMesh = new THREE.Mesh(oceanGeo, this.oceanMaterial)
    this.oceanMesh.frustumCulled = false
    this.oceanMesh.renderOrder = 2
    this.oceanMesh.layers.enable(CLOUD_OCCLUDER_RENDER_LAYER)
    this.group.add(this.oceanMesh)
  }

  // Seeds the attribute with zeros and returns the normalised vertex directions
  // for the worker. The attribute has to exist up front: ocean.ts declares
  // `attribute float terrainHeight` and reads it in the vertex shader.
  private addOceanTerrainHeightAttribute(geometry: THREE.BufferGeometry): Float32Array {
    const positions = geometry.getAttribute('position')
    const heights = new Float32Array(positions.count)
    const directions = new Float32Array(positions.count * 3)

    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i)
      const y = positions.getY(i)
      const z = positions.getZ(i)
      const length = Math.hypot(x, y, z) || 1
      directions[i * 3] = x / length
      directions[i * 3 + 1] = y / length
      directions[i * 3 + 2] = z / length
    }

    positions.needsUpdate = true
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    geometry.setAttribute('terrainHeight', new THREE.BufferAttribute(heights, 1))
    return directions
  }

  // Moves the two heavy loops off the main thread. Together they were ~65,340
  // icosphere vertices plus 131,072 shore-mask texels, each a full detailed
  // height sample — measured at ~2.7s of synchronous freeze per water planet in
  // the constructor, and re-triggered in the editor by any structural change.
  //
  // Uses its own one-shot worker rather than the chunk pool: the pool is
  // created after this point in the constructor, and its slots are keyed by
  // chunk key and epoch.
  private dispatchOceanData(directions: Float32Array) {
    const jobId = ++this.oceanJobId
    const maskParams = this.oceanShoreMaskParams()
    const vertexCount = directions.length / 3

    const runSynchronously = () => {
      this.applyOceanHeights(jobId, buildOceanVertexHeights(directions, this.terrainParams), 0)
      this.applyOceanShoreMask(jobId, buildOceanShoreMask(this.terrainParams, maskParams), 0)
      this.finishOceanData(jobId)
    }

    if (typeof Worker === 'undefined') {
      runSynchronously()
      return
    }

    // Split across several one-shot workers. A single worker took ~2.27s for
    // the 196k detailed height samples; every texel and every vertex is
    // independent, so this is the difference between water appearing after two
    // seconds and after a few hundred milliseconds.
    //
    // These are separate from the chunk pool on purpose: that pool is built
    // later in the constructor and its slots are keyed by chunk key and epoch.
    const sliceCount = this.resolveOceanSliceCount()
    this.terminateOceanWorkers()
    this.oceanPendingSlices = sliceCount

    for (let slice = 0; slice < sliceCount; slice++) {
      const rowStart = Math.floor((maskParams.height * slice) / sliceCount)
      const rowEnd = Math.floor((maskParams.height * (slice + 1)) / sliceCount)
      const vertexStart = Math.floor((vertexCount * slice) / sliceCount)
      const vertexEnd = Math.floor((vertexCount * (slice + 1)) / sliceCount)
      const sliceDirections = directions.slice(vertexStart * 3, vertexEnd * 3)

      const worker = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' })
      this.oceanWorkers.push(worker)

      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
        const response = event.data
        if (response.type === 'ocean-built') {
          this.applyOceanHeights(response.id, response.heights, response.vertexOffset)
          this.applyOceanShoreMask(response.id, response.shoreMask, response.rowStart)
          this.completeOceanSlice(response.id)
          return
        }
        if (response.type === 'ocean-error') {
          if (import.meta.env.DEV) console.warn(`Ocean worker slice failed: ${response.message}`)
          this.failOceanJob(jobId, runSynchronously)
        }
      }

      worker.onerror = () => {
        // Better a one-off stall than a planet with no coastline.
        this.failOceanJob(jobId, runSynchronously)
      }

      const request: TerrainWorkerOceanRequest = {
        type: 'ocean',
        id: jobId,
        slice,
        terrain: this.terrainParams,
        directions: sliceDirections,
        vertexOffset: vertexStart,
        shoreMask: maskParams,
        rowStart,
        rowEnd,
      }
      worker.postMessage(request, [sliceDirections.buffer])
    }
  }

  private resolveOceanSliceCount(): number {
    const threads = typeof navigator === 'undefined'
      ? 4
      : Math.max(2, navigator.hardwareConcurrency ?? 4)
    // Deliberately a small share of the machine. The chunk pool already takes
    // up to min(8, threads - 1), and oversubscribing turns terrain streaming
    // slower — which the player sees — to make the water arrive sooner, which
    // they mostly do not. Measured on this machine: 6 slices left the slowest
    // slice at 1338ms of contended CPU versus ~380ms of actual work.
    return Math.max(1, Math.min(MAX_OCEAN_WORKERS, Math.floor(threads / 3)))
  }

  private terminateOceanWorkers() {
    for (const worker of this.oceanWorkers) worker.terminate()
    this.oceanWorkers.length = 0
    this.oceanPendingSlices = 0
  }

  private failOceanJob(jobId: number, fallback: () => void) {
    if (jobId !== this.oceanJobId || this.oceanDataReady) return
    this.terminateOceanWorkers()
    fallback()
  }

  private completeOceanSlice(jobId: number) {
    if (jobId !== this.oceanJobId) return
    this.oceanPendingSlices--
    if (this.oceanPendingSlices > 0) return
    this.terminateOceanWorkers()
    this.finishOceanData(jobId)
  }

  private finishOceanData(jobId: number) {
    if (jobId !== this.oceanJobId || this.disposed) return
    this.oceanDataReady = true
  }

  private applyOceanHeights(jobId: number, heights: Float32Array, vertexOffset: number) {
    if (jobId !== this.oceanJobId || this.disposed) return
    const attribute = this.oceanGeometry?.getAttribute('terrainHeight')
    if (!attribute || vertexOffset + heights.length > attribute.count) return
    ;(attribute.array as Float32Array).set(heights, vertexOffset)
    attribute.needsUpdate = true
  }

  private applyOceanShoreMask(jobId: number, shoreMask: Uint8Array, rowStart: number) {
    if (jobId !== this.oceanJobId || this.disposed) return
    const mask = this.oceanShoreMask
    const maskData = mask?.image?.data as Uint8Array | undefined
    if (!mask || !maskData) return
    const byteOffset = rowStart * OCEAN_SHORE_MASK_WIDTH * 4
    if (byteOffset + shoreMask.length > maskData.length) return
    maskData.set(shoreMask, byteOffset)
    mask.needsUpdate = true
  }

  private oceanShoreMaskParams(): OceanShoreMaskParams {
    return {
      width: OCEAN_SHORE_MASK_WIDTH,
      height: OCEAN_SHORE_MASK_HEIGHT,
      seaHeight: this.seaHeight,
      bias: OCEAN_SHORE_MASK_BIAS,
      surfaceEdge: OCEAN_SHORE_MASK_SURFACE_EDGE,
      depthScale: OCEAN_SHORE_MASK_DEPTH_SCALE,
    }
  }

  private createOceanShoreMaskTexture(): THREE.DataTexture {
    const width = OCEAN_SHORE_MASK_WIDTH
    const height = OCEAN_SHORE_MASK_HEIGHT
    // Allocated empty; filled by applyOceanData once the worker replies.
    const data = new Uint8Array(width * height * 4)

    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true
    return texture
  }

  private measureOceanMeshFacetInset(geometry: THREE.BufferGeometry): number {
    const positions = geometry.getAttribute('position')
    const index = geometry.getIndex()
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const normal = new THREE.Vector3()
    let maxInset = 0

    const measureTriangle = (ia: number, ib: number, ic: number) => {
      a.fromBufferAttribute(positions, ia)
      b.fromBufferAttribute(positions, ib)
      c.fromBufferAttribute(positions, ic)
      normal.crossVectors(b.clone().sub(a), c.clone().sub(a))
      if (normal.lengthSq() <= 1e-10) return
      normal.normalize()
      const planeDistance = Math.abs(a.dot(normal))
      maxInset = Math.max(maxInset, Math.max(0, this.oceanSeaRadius - planeDistance))
    }

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        measureTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2))
      }
    } else {
      for (let i = 0; i < positions.count; i += 3) {
        measureTriangle(i, i + 1, i + 2)
      }
    }

    return maxInset
  }

  private updateOceanRenderState() {
    if (!this.oceanMesh || !this.oceanMaterial) return

    // Stays hidden until the worker returns the per-vertex terrain heights and
    // the shore mask; without them the mesh would render as a smooth sphere
    // with no coastline.
    this.oceanMesh.visible = this.seaHeight >= -1 && this.oceanDataReady
    // Orbital oceans must respect ships and every other celestial body too.
    this.oceanMaterial.depthTest = true
    this.setFloatUniform(this.oceanMaterial, 'uOceanQuality', 2)
    this.setFloatUniform(this.oceanMaterial, 'uOceanAlpha', 1)
  }

  private updateOceanViewSide(state: UnderwaterViewState) {
    if (!this.oceanMaterial || !this.oceanMesh || this.oceanSeaRadius <= 0) return

    const nextSide = state.factor > 0.01 ? THREE.BackSide : THREE.FrontSide
    if (this.oceanMaterial.side !== nextSide) {
      this.oceanMaterial.side = nextSide
    }
  }

  private computeUnderwaterViewState(localCamPos: THREE.Vector3): UnderwaterViewState {
    if (!this.oceanMesh || this.seaHeight < -1 || this.oceanSeaRadius <= 0) {
      return { factor: 0, depth: 0 }
    }

    const localRadius = localCamPos.length()
    if (!Number.isFinite(localRadius) || localRadius <= 1e-6) {
      return { factor: 0, depth: 0 }
    }

    const localDir = localCamPos.clone().divideScalar(localRadius)
    const oceanSurfaceRadius = this.sampleOceanVisualSurfaceRadius(localDir, localRadius)
    const terrainSurfaceRadius = this.sampleSurfaceRadius(localDir)
    const waterDepthAtCameraDir = oceanSurfaceRadius - terrainSurfaceRadius
    const waterMask = smoothstepNumber(0.05, 0.8, waterDepthAtCameraDir)

    if (waterMask <= 0.01) return { factor: 0, depth: 0 }

    const cameraDepth = oceanSurfaceRadius - localRadius
    const fadeDepth = Math.max(1.2, Math.min(3.5, this.oceanWaveHeight * 0.22))
    const factor = cameraDepth > 0
      ? smoothstepNumber(0, fadeDepth, cameraDepth) * waterMask
      : 0
    return {
      factor,
      depth: Math.max(0, cameraDepth),
    }
  }

  private sampleOceanVisualSurfaceRadius(localDir: THREE.Vector3, localRadius: number): number {
    if (!this.oceanMesh?.geometry || this.oceanSeaRadius <= 0) return this.oceanSeaRadius

    const idealDepth = this.oceanSeaRadius - localRadius
    const probeRange = Math.max(2.5, this.oceanMeshFacetInset * 1.5 + this.oceanWaveHeight * 0.5 + 0.5)
    if (Math.abs(idealDepth) > probeRange) {
      return this.oceanSeaRadius + this.sampleOceanSurfaceDisplacement(localDir, 1)
    }

    const hit = this.raycastOceanMesh(localDir)
    if (!hit) {
      return this.oceanSeaRadius + this.sampleOceanSurfaceDisplacement(localDir, 1)
    }

    return this.raycastDisplacedOceanTriangleRadius(localDir, hit)
      ?? hit.radius + this.sampleOceanSurfaceDisplacement(localDir, 1)
  }

  private raycastOceanMesh(localDir: THREE.Vector3): OceanMeshRaycastHit | null {
    const geometry = this.oceanMesh?.geometry
    if (!geometry) return null

    const positions = geometry.getAttribute('position')
    const index = geometry.getIndex()
    const ray = new THREE.Ray(new THREE.Vector3(0, 0, 0), localDir)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const hit = new THREE.Vector3()
    let closest = Infinity
    let closestHit: OceanMeshRaycastHit | null = null

    const testTriangle = (ia: number, ib: number, ic: number) => {
      a.fromBufferAttribute(positions, ia)
      b.fromBufferAttribute(positions, ib)
      c.fromBufferAttribute(positions, ic)
      const intersection = ray.intersectTriangle(a, b, c, false, hit)
      if (!intersection) return
      const radius = intersection.dot(localDir)
      if (radius > 0 && radius < closest) {
        closest = radius
        closestHit = { radius, ia, ib, ic }
      }
    }

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        testTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2))
      }
    } else {
      for (let i = 0; i < positions.count; i += 3) {
        testTriangle(i, i + 1, i + 2)
      }
    }

    return closestHit
  }

  private raycastDisplacedOceanTriangleRadius(localDir: THREE.Vector3, baseHit: OceanMeshRaycastHit): number | null {
    const geometry = this.oceanMesh?.geometry
    if (!geometry) return null

    const positions = geometry.getAttribute('position')
    const terrainHeights = geometry.getAttribute('terrainHeight')
    if (!terrainHeights) return null

    const ray = new THREE.Ray(new THREE.Vector3(0, 0, 0), localDir)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const hit = new THREE.Vector3()
    this.getDisplacedOceanVertex(positions, terrainHeights, baseHit.ia, a)
    this.getDisplacedOceanVertex(positions, terrainHeights, baseHit.ib, b)
    this.getDisplacedOceanVertex(positions, terrainHeights, baseHit.ic, c)

    const intersection = ray.intersectTriangle(a, b, c, false, hit)
    if (!intersection) return null
    const radius = intersection.dot(localDir)
    return radius > 0 ? radius : null
  }

  private getDisplacedOceanVertex(
    positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    terrainHeights: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    index: number,
    target: THREE.Vector3,
  ) {
    target.fromBufferAttribute(positions, index)
    const dir = target.clone().normalize()
    const normalizedWaterDepth = this.seaHeight - terrainHeights.getX(index)
    const displacement = this.sampleOceanSurfaceDisplacementFromNormalizedDepth(dir, normalizedWaterDepth)
    target.addScaledVector(dir, displacement)
  }

  private sampleOceanSurfaceDisplacement(localDir: THREE.Vector3, waterDepth: number): number {
    if (!this.oceanIfft || this.oceanSeaRadius <= 0) return 0

    const terrainMeters = Math.max(this.terrainParams.terrainScale * this.terrainParams.radius, 0.001)
    const normalizedDepth = Math.max(waterDepth, 0) / terrainMeters
    return this.sampleOceanSurfaceDisplacementFromNormalizedDepth(localDir, normalizedDepth)
  }

  private sampleOceanSurfaceDisplacementFromNormalizedDepth(localDir: THREE.Vector3, normalizedDepth: number): number {
    if (!this.oceanIfft || this.oceanSeaRadius <= 0) return 0

    const shoreCalm = smoothstepNumber(0.005, 0.055, normalizedDepth)
    const waveHeight = this.oceanIfft.sampleHeightAtDirection(localDir, this.oceanSeaRadius, this.time)
    return waveHeight * this.oceanIfft.heightScale * (0.35 + shoreCalm * 0.65)
  }

  private updateOceanDetailIfft(surfaceDistance: number) {
    if (!this.oceanMaterial) return

    const strength = this.getOceanDetailIfftStrength(surfaceDistance)
    this.setFloatUniform(this.oceanMaterial, 'uIfftDetailEnabled', strength)
    if (!this.oceanDetailIfft || strength <= 0.001) return

    const cadence = this.getOceanDetailIfftCadence(surfaceDistance)
    if (cadence <= 0) return

    if (this.oceanDetailIfftFrame % cadence === 0) {
      this.oceanDetailIfft.update(this.time)
      this.oceanMaterial.uniforms.uIfftDetailMap.value = this.oceanDetailIfft.texture
    }
    this.oceanDetailIfftFrame = (this.oceanDetailIfftFrame + 1) % 240
  }

  private getOceanDetailIfftStrength(surfaceDistance: number): number {
    if (!this.oceanDetailIfft) return 0

    const distance = Math.max(0, surfaceDistance)
    return 1 - THREE.MathUtils.smoothstep(
      distance,
      OCEAN_DETAIL_IFFT_QUARTER_DISTANCE,
      OCEAN_DETAIL_IFFT_DISABLE_DISTANCE,
    )
  }

  private getOceanDetailIfftCadence(surfaceDistance: number): number {
    if (!this.oceanDetailIfft) return 0

    const distance = Math.max(0, surfaceDistance)
    if (distance <= OCEAN_DETAIL_IFFT_FULL_DISTANCE) return 1
    if (distance <= OCEAN_DETAIL_IFFT_HALF_DISTANCE) return 2
    if (distance <= OCEAN_DETAIL_IFFT_QUARTER_DISTANCE) return 4
    return 0
  }

  private updateChunkGrassVisibility(chunk: TerrainChunk, localCamPos: THREE.Vector3) {
    const grass = this.grassLayers.get(chunk.key)
    const farGrass = this.farGrassLayers.get(chunk.key)
    if (!grass && !farGrass) return

    const dist = this.getLocalChunkDistToCamera(chunk.node, localCamPos)
    const nearVisible = !!grass
      && chunk.mesh.visible
      && this.grassSettings.enabled
      && !this.debugSimpleTerrain
      && dist < this.grassSettings.distance + this.grassSettings.height * 8
    grass?.setVisible(nearVisible)
    if (nearVisible && grass) this.grassVisibleInstances += grass.instanceCount

    const farVisible = !!farGrass
      && chunk.mesh.visible
      && this.grassSettings.enabled
      && !this.debugSimpleTerrain
      && dist >= this.grassSettings.distance - this.grassSettings.height * 8
      && dist < this.grassSettings.distance * GRASS_FAR_DISTANCE_MULTIPLIER
    farGrass?.setVisible(farVisible)
    if (farVisible && farGrass) this.grassVisibleInstances += farGrass.instanceCount
  }

  private updateChunkPropVisibility(chunk: TerrainChunk, localCamPos: THREE.Vector3) {
    let props = this.propLayers.get(chunk.key)
    if (!props) {
      // Came into range since the chunk was built — attach now.
      this.attachPropLayer(chunk)
      props = this.propLayers.get(chunk.key)
      if (!props) return
    }

    const dist = this.getLocalChunkDistToCamera(chunk.node, localCamPos)
    const visible = chunk.mesh.visible
      && this.propSettings.enabled
      && !this.debugSimpleTerrain
      && dist < this.propSettings.distance
    props.setVisible(visible)
    if (visible) {
      props.setLodTier(this.resolvePropLodTier(dist, props.lodTierIndex))
      if (props.needsSunLightUpdate(this.cloudLocalSunDirection)) {
        this.requestPropSunLight(chunk.key, props)
      }
      this.propVisibleInstances += props.instanceCount
    }
  }

  // Horizon shadowing is ten detailed height samples per instance -- ~3.4ms per
  // chunk. It depends only on the placement arrays, the sun direction and the
  // terrain params, so it moves off the main thread wholesale. A single
  // dedicated worker is enough: results that arrive late are simply discarded
  // and re-requested, and oversubscribing would starve chunk streaming.
  private requestPropSunLight(chunkKey: string, layer: PlanetPropLayer) {
    if (this.propSunInFlightChunks.has(chunkKey)) return

    const worker = this.ensurePropSunWorker()
    if (!worker || this.propSunInFlightChunks.size >= MAX_PROP_SUN_IN_FLIGHT) {
      // No worker available (or the queue is full): fall back to the budgeted
      // main-thread path so lighting still converges.
      if (this.propSunLightSpentMs < PROP_SUN_LIGHT_BUDGET_MS) {
        const started = performance.now()
        layer.updateSunLight(this.cloudLocalSunDirection)
        this.propSunLightSpentMs += performance.now() - started
      }
      return
    }

    const placements = layer.getSunLightJobPlacements()
    if (placements.length === 0) return

    const sun = _propSunDir.copy(this.cloudLocalSunDirection)
    if (sun.lengthSq() <= 1e-8) return
    sun.normalize()

    const id = ++this.propSunJobId
    this.propSunJobs.set(id, { chunkKey, sunX: sun.x, sunY: sun.y, sunZ: sun.z })
    this.propSunInFlightChunks.add(chunkKey)

    const request: TerrainWorkerPropSunRequest = {
      type: 'prop-sun',
      id,
      terrain: this.terrainParams,
      sunX: sun.x,
      sunY: sun.y,
      sunZ: sun.z,
      placements,
    }
    worker.postMessage(request)
  }

  private ensurePropSunWorker(): Worker | null {
    if (this.propSunWorker || this.propSunWorkerFailed || typeof Worker === 'undefined') {
      return this.propSunWorker
    }

    try {
      const worker = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
        const response = event.data
        if (response.type === 'prop-sun-built') {
          this.completePropSunJob(response.id, response.results)
          return
        }
        if (response.type === 'prop-sun-error') {
          if (import.meta.env.DEV) console.warn(`Prop sun worker failed: ${response.message}`)
          this.completePropSunJob(response.id, null)
        }
      }
      worker.onerror = () => {
        // Drop back to the budgeted main-thread path for the rest of the session.
        this.propSunWorkerFailed = true
        this.propSunWorker?.terminate()
        this.propSunWorker = null
        this.propSunJobs.clear()
        this.propSunInFlightChunks.clear()
      }
      this.propSunWorker = worker
    } catch {
      this.propSunWorkerFailed = true
    }

    return this.propSunWorker
  }

  private completePropSunJob(id: number, results: Float32Array[] | null) {
    const job = this.propSunJobs.get(id)
    if (!job) return
    this.propSunJobs.delete(id)
    this.propSunInFlightChunks.delete(job.chunkKey)
    if (!results || this.disposed) return

    const layer = this.propLayers.get(job.chunkKey)
    if (!layer) return

    // Discard if the sun moved past the staleness threshold while the job was
    // in flight -- needsSunLightUpdate will simply ask again next frame.
    const current = _propSunDir.copy(this.cloudLocalSunDirection)
    if (current.lengthSq() <= 1e-8) return
    current.normalize()
    if (current.x * job.sunX + current.y * job.sunY + current.z * job.sunZ <= PROP_SUN_STALE_DOT) return

    layer.applySunLightResults(results, current)
  }

  private resolvePropLodTier(dist: number, currentTier: number): number {
    let tier = 0

    for (let i = 0; i < PROP_LOD_DISTANCES.length; i++) {
      const threshold = PROP_LOD_DISTANCES[i]
      // Asymmetric bound: a boundary already crossed has to be re-crossed by
      // the hysteresis margin to step back down, so a chunk sitting on it does
      // not swap geometry every frame.
      const bound = i < currentTier
        ? threshold * (1 - PROP_LOD_HYSTERESIS)
        : threshold * (1 + PROP_LOD_HYSTERESIS)
      if (dist > bound) tier = i + 1
    }

    return tier
  }

  private disposeChunk(chunk: TerrainChunk) {
    const grass = this.grassLayers.get(chunk.key)
    if (grass) {
      grass.dispose()
      this.grassLayers.delete(chunk.key)
    }
    const farGrass = this.farGrassLayers.get(chunk.key)
    if (farGrass) {
      farGrass.dispose()
      this.farGrassLayers.delete(chunk.key)
    }
    this.propPrepareJobs.delete(chunk.key)
    const props = this.propLayers.get(chunk.key)
    if (props) {
      props.dispose()
      this.propLayers.delete(chunk.key)
    }
    chunk.dispose()
  }

  // Rebuilds the per-(face, lod) occupancy sets that the stitch probe walks.
  //
  // The probe used to rebuild `${face}_${lod}_${x}_${y}` on every step of every
  // probe, four probes per visible chunk. Its hit rate is ~1.3%, so it almost
  // always walks to lod 0 and returns 0 — tens of thousands of throwaway
  // strings per frame to answer "no".
  //
  // Keys stay per-lod (`y * 2^lod + x`) rather than bit-packed into one integer
  // on purpose: 12 bits of y would collide from lod 13 up, and computeAutoLod
  // reaches lod 14. A collision here means a wrong stitch step, which shows up
  // as a visible T-junction crack.
  private rebuildStitchSets(renderKeys: Set<string>) {
    const buckets = NUM_FACES * (this.maxLod + 1)
    if (this.stitchSets.length !== buckets) {
      this.stitchSets = Array.from({ length: buckets }, () => new Set<number>())
      this.stitchMasks = Array.from({ length: buckets }, () => new Map<number, number>())
    } else {
      for (const set of this.stitchSets) set.clear()
      for (const map of this.stitchMasks) map.clear()
    }

    for (const key of renderKeys) {
      const chunk = this.chunks.get(key)
      if (!chunk) continue
      const node = chunk.node
      const bucket = node.face * (this.maxLod + 1) + node.lod
      const cell = node.y * (1 << node.lod) + node.x
      this.stitchSets[bucket].add(cell)
      const mask = this.renderQuadrantMasks.get(key)
      if (mask) this.stitchMasks[bucket].set(cell, mask)
    }
  }

  private updateVisibleStitching(renderKeys: Set<string>) {
    this.rebuildStitchSets(renderKeys)
    for (const key of renderKeys) {
      const chunk = this.chunks.get(key)
      if (!chunk) continue
      chunk.setStitchSteps(this.computeVisibleStitchSteps(chunk.node), this.renderQuadrantMasks.get(key) ?? 0)
    }
  }

  private computeVisibleStitchSteps(node: QuadtreeNode): StitchSteps {
    // Returns a shared scratch — setStitchSteps copies the fields out. ~99% of
    // these are discarded unchanged, so allocating one per visible chunk per
    // frame was pure garbage.
    const out = _stitchScratch
    if (!this.skirts) {
      out.bottom = 0
      out.top = 0
      out.left = 0
      out.right = 0
      return out
    }

    out.bottom = this.getVisibleCoarserSameFaceNeighborStep(node, 0, -1)
    out.top = this.getVisibleCoarserSameFaceNeighborStep(node, 0, 1)
    out.left = this.getVisibleCoarserSameFaceNeighborStep(node, -1, 0)
    out.right = this.getVisibleCoarserSameFaceNeighborStep(node, 1, 0)
    return out
  }

  private getVisibleCoarserSameFaceNeighborStep(
    node: QuadtreeNode,
    dx: number,
    dy: number,
  ): number {
    const cells = 1 << node.lod
    const x = node.x + dx
    const y = node.y + dy
    if (x < 0 || y < 0 || x >= cells || y >= cells) return 0

    const stride = this.maxLod + 1
    for (let lod = node.lod - 1; lod >= 0; lod--) {
      const shift = node.lod - lod
      const bucket = node.face * stride + lod
      // x and y are non-negative past the bounds check, so >> matches Math.floor.
      const cell = (y >> shift) * (1 << lod) + (x >> shift)
      if (!this.stitchSets[bucket].has(cell)) continue

      // A masked patch does not draw every quadrant. Find which of its four the
      // neighbour falls in -- the ancestor one level finer picks it out -- and
      // keep looking coarser when that quadrant is somebody else's to draw.
      const mask = this.stitchMasks[bucket].get(cell)
      if (mask) {
        const quadrant = ((((y >> (shift - 1)) & 1) << 1) | ((x >> (shift - 1)) & 1))
        if (mask & (1 << quadrant)) continue
      }
      return 1 << shift
    }

    return 0
  }

  private createFallbackGeometry(planetRadius: number): THREE.SphereGeometry {
    const geometry = new THREE.SphereGeometry(planetRadius, 64, 48)
    this.addTerrainHeightAttribute(geometry)
    return geometry
  }

  private addTerrainHeightAttribute(geometry: THREE.BufferGeometry) {
    const positions = geometry.getAttribute('position')
    const heights = new Float32Array(positions.count)
    const macroAo = new Float32Array(positions.count)
    const dir = new THREE.Vector3()

    for (let i = 0; i < positions.count; i++) {
      dir.fromBufferAttribute(positions, i).normalize()
      heights[i] = samplePlanetHeight(dir, this.terrainParams)
      // The orbital mesh needs real seabed depth. A flat sphere at the base
      // radius intersects the lower ocean sphere in a regular pattern of facets.
      const radius = this.terrainParams.radius * (1 + heights[i] * this.terrainParams.terrainScale)
      positions.setXYZ(i, dir.x * radius, dir.y * radius, dir.z * radius)
      macroAo[i] = this.sampleFallbackMacroAo(dir, heights[i])
    }

    positions.needsUpdate = true
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    geometry.setAttribute('terrainHeight', new THREE.BufferAttribute(heights, 1))
    geometry.setAttribute('terrainMacroAo', new THREE.BufferAttribute(macroAo, 1))
  }

  private sampleFallbackMacroAo(dir: THREE.Vector3, centerHeight: number): number {
    if (this.terrainParams.planetType === 'gas') return 1

    const sampleStep = 0.010
    const terrainMeters = Math.max(this.terrainParams.terrainScale * this.terrainParams.radius, 0.001)
    const expectedRelief = Math.max(terrainMeters * 0.022, 10)
    const axes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 1, 0).normalize(),
      new THREE.Vector3(1, 0, 1).normalize(),
      new THREE.Vector3(0, 1, 1).normalize(),
    ]

    let localMin = centerHeight
    let localMax = centerHeight
    const sampleDir = new THREE.Vector3()
    const sample = (offset: THREE.Vector3) => {
      sampleDir.copy(dir).addScaledVector(offset, sampleStep).normalize()
      const h = samplePlanetHeight(sampleDir, this.terrainParams)
      localMin = Math.min(localMin, h)
      localMax = Math.max(localMax, h)
      return h
    }
    const samplePairs: Array<[number, number]> = []
    for (const axis of axes) {
      const projected = axis.clone().addScaledVector(dir, -axis.dot(dir))
      if (projected.lengthSq() < 1e-4) continue
      projected.normalize()
      samplePairs.push([sample(projected), sample(projected.clone().multiplyScalar(-1))])
    }

    let maxConcavityMeters = 0
    let concavitySum = 0
    for (const [a, b] of samplePairs) {
      const pairConcavityMeters = Math.max(0, (a + b) * 0.5 - centerHeight) * terrainMeters
      maxConcavityMeters = Math.max(maxConcavityMeters, pairConcavityMeters)
      concavitySum += pairConcavityMeters
    }

    const avgConcavityMeters = concavitySum / Math.max(1, samplePairs.length)
    const localRangeMeters = Math.max(0, localMax - localMin) * terrainMeters
    const avgBasin = THREE.MathUtils.smoothstep(avgConcavityMeters, expectedRelief * 0.12, expectedRelief * 1.10)
    const peakBasin = THREE.MathUtils.smoothstep(maxConcavityMeters, expectedRelief * 0.18, expectedRelief * 1.32)
    const basin = Math.max(avgBasin, peakBasin)
    const rangeGate = THREE.MathUtils.smoothstep(localRangeMeters, expectedRelief * 0.20, expectedRelief * 1.90)
    return 1 - basin * rangeGate
  }

  private removeAllChunks() {
    this.chunkBuildEpoch++
    for (const [, chunk] of this.chunks) {
      this.group.remove(chunk.mesh)
      this.disposeChunk(chunk)
    }
    this.chunks.clear()
    this.propCoverage.clear()
    this.propPrepareJobs.clear()
    this.pendingKeys.clear()
    this.pendingWorkerKeys.clear()
    this.completedWorkerJobs.length = 0
    this.pendingCollapseKeys.clear()

    for (const root of this.quadtrees) {
      this.collapseQuadtree(root)
    }
  }

  private collapseQuadtree(node: QuadtreeNode) {
    if (node.children) {
      for (const child of node.children) {
        this.collapseQuadtree(child)
      }
      node.children = null
    }
  }

  dispose() {
    this.disposed = true
    this.removeAllChunks()
    this.propScatterCache.clear()
    this.propPrepareJobs.clear()
    // Not terminate: the pool is shared with every other planet. This only
    // says the results still in the air are no longer wanted.
    releaseTerrainWorkersFor(this)
    this.material.dispose()
    for (const material of this.farLodMaterials) {
      material.dispose()
    }
    this.farLodMaterials.length = 0
    this.fallbackMaterial.dispose()
    this.simpleTerrainMaterial.dispose()
    this.cloudMaterial?.dispose()
    this.cloudBillboardMaterial?.dispose()
    this.cloudMask.dispose()
    this.oceanMaterial?.dispose()
    this.oceanIfft?.dispose()
    this.oceanDetailIfft?.dispose()
    this.oceanShoreMask?.dispose()
    this.grassMaterial?.dispose()
    this.farGrassMaterial?.dispose()
    this.atmosphereMaterial?.dispose()
    this.cloudMesh?.geometry.dispose()
    this.cloudBillboardMesh?.geometry.dispose()
    // Same class of leak as the grass layers: instanceMatrix (1600 instances)
    // hangs off the InstancedMesh, not the geometry, and only the mesh's own
    // dispose releases it. In the editor this runs on every slider change that
    // alters the planet key.
    this.cloudBillboardMesh?.dispose()
    this.oceanMesh?.geometry.dispose()
    this.atmosphereMesh?.geometry.dispose()
    if (this.fallbackSphere.material instanceof THREE.ShaderMaterial) {
      this.fallbackSphere.material.dispose()
    }
    this.fallbackSphere.geometry.dispose()
    this.group.parent?.remove(this.group)
  }
}

// Isolated preview of the procedural foliage, driving the real load path in
// planet-props.ts rather than a copy of it. Dev-only: not linked from the app.
import * as THREE from 'three'
import {
  PlanetPropLayer,
  loadPlanetPropAssets,
  updatePlanetPropMaterials,
} from '../src/game/planet/planet-props'
import { DEFAULT_FOLIAGE_SETTINGS, FOLIAGE_LOD_SIZE_BOOST } from '../src/game/planet/tree-foliage'

const hud = document.getElementById('hud')!

// Headless Chrome swallows the console, and a ShaderMaterial that fails to
// link still counts its triangles in renderer.info -- so errors land in the DOM
// where --dump-dom can read them.
const log: string[] = []
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    log.push(`[${level}] ` + args.map(a => String(a)).join(' '))
    original(...args)
  }
}
window.addEventListener('error', e => log.push(`[uncaught] ${e.message}`))
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
renderer.setSize(innerWidth, innerHeight)
renderer.setClearColor(0x8fb6d4)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 900000)

// The wind uses normalize(instanceOrigin) as the tree's up axis, so the
// instance cannot sit at the world origin.
const GROUND_Y = 500
const group = new THREE.Group()
scene.add(group)

const params = new URLSearchParams(location.search)
const MODEL = params.get('model') ?? 'oak-tree'
const HEIGHT = Number(params.get('height') ?? 10)
const TIER = Number(params.get('tier') ?? 0)
const DIST = Number(params.get('dist') ?? 18)
const YAW = Number(params.get('yaw') ?? 0.6)
const TIME = Number(params.get('t') ?? 0)
const SHOW = params.get('show') ?? 'all'   // all | trunk | leaves

function instancedAttributes(count: number): [string, THREE.InstancedBufferAttribute][] {
  const dirs = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    dirs[i * 3 + 1] = 1
    normals[i * 3 + 1] = 1
  }
  return [
    ['instancePlanetDir', new THREE.InstancedBufferAttribute(dirs, 3)],
    ['instanceTerrainNormal', new THREE.InstancedBufferAttribute(normals, 3)],
    ['instanceTerrainMicroAo', new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1)],
    ['instanceTerrainMacroAo', new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1)],
    ['instanceTerrainSunLight', new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1)],
  ]
}

function bind(source: THREE.BufferGeometry, attrs: [string, THREE.InstancedBufferAttribute][]) {
  const geometry = new THREE.BufferGeometry()
  for (const name of Object.keys(source.attributes)) geometry.setAttribute(name, source.attributes[name])
  if (source.index) geometry.setIndex(source.index)
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null
  for (const [name, attribute] of attrs) geometry.setAttribute(name, attribute)
  return geometry
}

const assets = await loadPlanetPropAssets()

// ── Real-layer mode ───────────────────────────────────────
// Builds an actual PlanetPropLayer on a synthetic surface patch. The grid mode
// below binds geometry by hand and so proves nothing about the layer, which is
// where the shared-attribute binding, the foliage mesh and the LOD draw range
// all live.
if (params.has('layer')) {
  const RADIUS = 3000
  const GRID = 33
  const SPAN = 260 // metres across the patch
  const HEIGHT_NORM = 0.10

  const positions = new Float32Array(GRID * GRID * 3)
  const normals = new Float32Array(GRID * GRID * 3)
  const heights = new Float32Array(GRID * GRID).fill(HEIGHT_NORM)
  const microAo = new Float32Array(GRID * GRID).fill(1)
  const macroAo = new Float32Array(GRID * GRID).fill(1)

  const terrain = {
    seed: 7, planetType: 'rocky', radius: RADIUS,
    terrainScale: 0.07, frequency: 2.4, octaves: 6,
  }
  const surfaceRadius = RADIUS + HEIGHT_NORM * terrain.terrainScale * RADIUS

  for (let iy = 0; iy < GRID; iy++) {
    for (let ix = 0; ix < GRID; ix++) {
      const u = (ix / (GRID - 1) - 0.5) * SPAN
      const v = (iy / (GRID - 1) - 0.5) * SPAN
      // Patch on the +Z face, near the equator so the snow mask stays off.
      const dir = new THREE.Vector3(u / RADIUS, v / RADIUS, 1).normalize()
      const i = (iy * GRID + ix) * 3
      positions[i] = dir.x * surfaceRadius
      positions[i + 1] = dir.y * surfaceRadius
      positions[i + 2] = dir.z * surfaceRadius
      normals[i] = dir.x; normals[i + 1] = dir.y; normals[i + 2] = dir.z
    }
  }

  const node = { face: 4, lod: 5, x: 3, y: 7, children: null, key: '4_5_3_7', covered: false }
  const layer = new PlanetPropLayer({
    node: node as never,
    surface: { positions, normals, heights, microAo, macroAo, gridSize: GRID },
    assets,
    settings: { enabled: true, treeDensity: 1.2, rockDensity: 0, distance: 2200 },
    terrain,
    seed: 7,
    seaHeight: 0,
    planetType: 'rocky',
  })
  layer.setLodTier(TIER)
  layer.updateSunLight(new THREE.Vector3(0.45, 0.75, 0.5).normalize())
  scene.add(layer.group)

  const sunL = new THREE.Vector3(0.45, 0.75, 0.5).normalize().multiplyScalar(40000)
  updatePlanetPropMaterials(assets, {
    sunPosition: sunL,
    planetCenter: new THREE.Vector3(),
    sunColor: new THREE.Color(0xfff2c8),
    atmosphereLightColor: new THREE.Color(0xc4d5df),
    atmosphereInfluence: 1,
    terrainAoStrength: 0.45,
    cloudMask: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat),
    cloudMaskOffset: 0,
    cloudHeight: 0.045,
    cloudShadowStrength: 0,
    cloudLocalSunDirection: new THREE.Vector3(0, 0, 1),
    time: TIME,
    windStrength: Number(params.get('wind') ?? 0.34),
    foliage: { ...DEFAULT_FOLIAGE_SETTINGS, density: Number(params.get('density') ?? 1) },
  })

  // The patch sits on the +Z face, so "up" here is +Z, not +Y.
  camera.up.set(0, 0, 1)
  camera.position.set(-SPAN * 0.42, -SPAN * 0.42, surfaceRadius + 16)
  camera.lookAt(new THREE.Vector3(SPAN * 0.25, SPAN * 0.25, surfaceRadius + 6))
  renderer.render(scene, camera)

  const meshes: string[] = []
  layer.group.traverse(o => {
    if (o instanceof THREE.InstancedMesh) {
      const drawn = o.geometry.drawRange.count
      meshes.push(`${o.name} n=${o.count} draw=${drawn === Infinity ? 'all' : drawn}`)
    }
  })
  hud.textContent = [
    `LAYER MODE tier=${TIER} instances=${layer.instanceCount}`,
    ...meshes,
    `draws=${renderer.info.render.calls} tris=${renderer.info.render.triangles}`,
  ].join('\n')

  const diagEl = document.createElement('pre')
  diagEl.id = 'diag'
  diagEl.style.cssText = 'position:fixed;left:8px;top:120px;color:#ff9;font:10px monospace;max-width:900px;white-space:pre-wrap;z-index:9'
  diagEl.textContent = log.length ? log.join('\n---\n') : 'no console errors'
  document.body.appendChild(diagEl)
  throw new Error('__layer_mode_done')
}
const attrs = instancedAttributes(1)

// Lay out one tree per (model, tier) pair so a single SwiftShader render
// covers the whole comparison -- separate headless instances starve each other.
const MODELS = (params.get('models') ?? MODEL).split(',')
const TIERS = (params.get('tiers') ?? String(TIER)).split(',').map(Number)
const SPACING = Number(params.get('spacing') ?? HEIGHT * 1.5)

let trunkTris = 0
let cards = 0
const fractions = [1, 0.55, 0.30, 0.15]
const cols = TIERS.length
const rows = MODELS.length

// One row along X: putting models on separate Z rows made the front row occlude
// the back one at every useful camera angle.
const total = rows * cols
MODELS.forEach((modelId, row) => {
  const m = assets.trees.find(t => t.id === modelId) ?? assets.trees[0]
  TIERS.forEach((tier, col) => {
    const x = (row * cols + col - (total - 1) / 2) * SPACING
    const z = 0
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, GROUND_Y, z),
      new THREE.Quaternion(),
      new THREE.Vector3(HEIGHT, HEIGHT, HEIGHT),
    )
    if (SHOW !== 'leaves') {
      for (const part of m.parts) {
        const t = Math.min(tier, part.tiers.length - 1)
        const geometry = bind(part.tiers[t].geometry, attrs)
        const mesh = new THREE.InstancedMesh(geometry, part.tiers[t].material, 1)
        mesh.setMatrixAt(0, matrix)
        mesh.instanceMatrix.needsUpdate = true
        mesh.frustumCulled = false
        group.add(mesh)
        trunkTris += (geometry.index?.count ?? 0) / 3
      }
    }
    if (m.foliage && SHOW !== 'trunk') {
      const boost = FOLIAGE_LOD_SIZE_BOOST[Math.min(tier, FOLIAGE_LOD_SIZE_BOOST.length - 1)]
      const scaleAttr = new THREE.InstancedBufferAttribute(new Float32Array(1).fill(boost), 1)
      const geometry = bind(m.foliage.geometry, [...attrs, ['instanceFoliageScale', scaleAttr]])
      const n = Math.round(m.foliage.cardCount * fractions[Math.min(tier, 3)])
      cards += n
      geometry.setDrawRange(0, n * 6)
      const mesh = new THREE.InstancedMesh(geometry, m.foliage.material, 1)
      mesh.setMatrixAt(0, matrix)
      mesh.instanceMatrix.needsUpdate = true
      mesh.frustumCulled = false
      mesh.renderOrder = 3
      group.add(mesh)
    }
  })
})

const sun = new THREE.Vector3(0.45, 0.75, 0.5).normalize().multiplyScalar(4000).add(new THREE.Vector3(0, GROUND_Y, 0))
updatePlanetPropMaterials(assets, {
  sunPosition: sun,
  planetCenter: new THREE.Vector3(0, 0, 0),
  sunColor: new THREE.Color(0xfff2c8),
  atmosphereLightColor: new THREE.Color(0xc4d5df),
  atmosphereInfluence: 1,
  terrainAoStrength: 0.45,
  cloudMask: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat),
  cloudMaskOffset: 0,
  cloudHeight: 0.045,
  cloudShadowStrength: 0,
  cloudLocalSunDirection: new THREE.Vector3(0, 1, 0),
  time: TIME,
  windStrength: Number(params.get('wind') ?? 0.34),
  foliage: { ...DEFAULT_FOLIAGE_SETTINGS, density: Number(params.get('density') ?? 1) },
})

const target = new THREE.Vector3(0, GROUND_Y + HEIGHT * 0.5, 0)
camera.position.set(Math.sin(YAW) * DIST, GROUND_Y + HEIGHT * 0.62, Math.cos(YAW) * DIST)
camera.lookAt(target)

renderer.render(scene, camera)
hud.textContent = [
  `models=${MODELS.join(',')} tiers=${TIERS.join(',')} show=${SHOW} height=${HEIGHT}m dist=${DIST}m`,
  `trunk tris=${trunkTris}  foliage cards=${cards} (${cards * 2} tris)`,
  `cards at tier0: ` + MODELS.map(id =>
    `${id}=${assets.trees.find(t => t.id === id)?.foliage?.cardCount ?? 0}`).join(' '),
  `draws=${renderer.info.render.calls} tris=${renderer.info.render.triangles}`,
].join('\n')

const diag = document.createElement('pre')
diag.id = 'diag'
diag.style.cssText = 'position:fixed;left:8px;top:90px;color:#ff9;font:10px monospace;max-width:880px;white-space:pre-wrap;z-index:9'
diag.textContent = log.length ? log.join('\n---\n') : 'no console errors'
document.body.appendChild(diag)

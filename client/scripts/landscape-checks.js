// Run in the editor console: await (await import('/scripts/landscape-checks.js')).runLandscapeChecks()
import * as THREE from 'three'
import { buildTerrainChunkGeometryData } from '../src/game/planet/terrain-geometry'
import { PlanetPropLayer } from '../src/game/planet/planet-props'
import { FluffyGrassLayer } from '../src/game/planet/fluffy-grass'

export function runLandscapeChecks() {
  const results = []
  const check = (name, condition, evidence) => {
    results.push({ name, passed: !!condition, evidence })
    if (!condition) throw new Error(JSON.stringify(results))
  }
  const terrain = window.__nmsEditorDebug.planet.terrainParams
  const node = (face, x, y, lod = 10) => ({ face, x, y, lod, children: null, key: `${face}_${lod}_${x}_${y}`, covered: false })
  const start = performance.now()
  const a = buildTerrainChunkGeometryData(node(4, 1023, 730), terrain, 9, false)
  const b = buildTerrainChunkGeometryData(node(0, 1023, 730), terrain, 9, false)
  let seamError = 0, normalError = 0
  for (let y = 0; y < 9; y++) for (let k = 0; k < 3; k++) {
    const i = (y * 9 + 8) * 3 + k
    seamError = Math.max(seamError, Math.abs(a.positions[i] - b.positions[i]))
    normalError = Math.max(normalError, Math.abs(a.normals[i] - b.normals[i]))
  }
  check('Cube-face boundary positions and normals agree', seamError < .003 && normalError < 1e-4, { seamError, normalError })
  check('Chunk geometry has finite outward unit normals', a.normals.every(Number.isFinite) && Array.from({ length: 81 }, (_, i) => {
    const n = new THREE.Vector3().fromArray(a.normals, i * 3), p = new THREE.Vector3().fromArray(a.positions, i * 3).normalize()
    return Math.abs(n.length() - 1) < 1e-5 && n.dot(p) > 0
  }).every(Boolean), { twoChunksMs: performance.now() - start })

  const props = Object.create(PlanetPropLayer.prototype)
  const grass = Object.create(FluffyGrassLayer.prototype)
  const model = { id: 'test', kind: 'tree', heightRange: [6, 13], width: 1, parts: [] }
  const surface = { gridSize: 17, positions: new Float32Array(17 * 17 * 3), normals: new Float32Array(17 * 17 * 3), heights: new Float32Array(17 * 17).fill(.03), microAo: new Float32Array(17 * 17).fill(1), macroAo: new Float32Array(17 * 17).fill(1) }
  const params = { terrain, surface, node: node(4, 510, 610), settings: { enabled: true, treeDensity: 1, rockDensity: 1, density: 1, height: .6 }, assets: { trees: [model], rocks: [{ ...model, kind: 'rock' }] }, seed: 67, seaHeight: -.054, planetType: 'rocky', variant: 'near' }
  let totalTrees = 0, emptyPatches = 0, minDistance = Infinity, maxTrees = 0, totalGrass = 0
  for (let patch = 0; patch < 50; patch++) {
    params.node = node(4, 420 + patch, 719)
    for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) {
      const p = new THREE.Vector3(patch * 140 - 3500 + x * 5, 8000 + y * 5, 23500).normalize()
      p.toArray(surface.normals, (y * 17 + x) * 3)
      p.multiplyScalar(25048.75).toArray(surface.positions, (y * 17 + x) * 3)
    }
    const placements = props.buildKindPlacements(params, 'tree')
    const matrices = placements.flatMap(p => p.matrices)
    const repeat = props.buildKindPlacements(params, 'tree').flatMap(p => p.matrices)
    check(`Deterministic scatter ${patch}`, JSON.stringify(matrices) === JSON.stringify(repeat))
    totalTrees += matrices.length; maxTrees = Math.max(maxTrees, matrices.length)
    if (!matrices.length) emptyPatches++
    for (let i = 0; i < matrices.length; i++) for (let j = 0; j < i; j++) {
      minDistance = Math.min(minDistance, new THREE.Vector3().setFromMatrixPosition(matrices[i]).distanceTo(new THREE.Vector3().setFromMatrixPosition(matrices[j])))
    }
    const blades = grass.buildInstances(params)
    totalGrass += blades.count
    check(`Grass budget ${patch}`, blades.count <= 2400 && blades.matrices.every(m => m.elements.every(Number.isFinite)))
  }
  check('Woodland contains both stands and clearings', totalTrees > 0 && emptyPatches > 0 && maxTrees <= 34, { totalTrees, emptyPatches, maxTrees, totalGrass })
  check('Trees retain six metre spacing within each chunk', minDistance > 5.9, minDistance)
  surface.heights.fill(-.5)
  check('No submerged trees, rocks or grass', props.buildKindPlacements({ ...params, seaHeight: 5 }, 'tree').length === 0 && props.buildKindPlacements({ ...params, seaHeight: 5 }, 'rock').length === 0 && grass.buildInstances(params).count === 0)
  return { passed: results.length, results: results.filter(r => !r.name.startsWith('Deterministic scatter') && !r.name.startsWith('Grass budget')) }
}

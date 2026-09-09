// Pure deterministic terrain/ecology checks; no browser, database or generated bindings.
// Run: node client/scripts/terrain-checks.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function compile(source, imports = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', js)(id => imports[id] ?? require(id), mod, mod.exports)
  return mod.exports
}
const root = new URL('../../', import.meta.url)
const read = p => readFileSync(new URL(p, root), 'utf8')
const path = 'server/spacetimedb/src/shared/planet-terrain.ts'
const noise = compile(read('server/spacetimedb/src/shared/terrain-noise.ts'))
const imports = { './terrain-noise': noise, './vector': compile(read('server/spacetimedb/src/shared/vector.ts')) }
const terrain = compile(read(path), imports)
const ecology = compile(read('client/src/game/planet/surface-ecology.ts'), { '../../../../server/spacetimedb/src/shared/terrain-noise': noise })
const params = { seed: 67, planetType: 'rocky', radius: 25000, terrainScale: .065, frequency: 1.2, octaves: 6, gain: .4, warpStrength: .39, mountainScale: 1.7, plainsScale: 2, hillsScale: .54, mountainBeltScale: 1.3, reliefVariety: 1, erosionStrength: .3, thermalStrength: .58, detailStrength: .22 }
const dirs = Array.from({ length: 3000 }, (_, i) => {
  const y = 1 - 2 * (i + .5) / 3000, a = i * 2.399963229728653
  return { x: Math.sqrt(1 - y * y) * Math.cos(a), y, z: Math.sqrt(1 - y * y) * Math.sin(a) }
})
let min = Infinity, max = -Infinity, maxStep = 0
for (const seed of [0, 67, 12591, -17]) {
  for (const dir of dirs) {
    const p = { ...params, seed }
    const h = terrain.samplePlanetHeightDetailed(dir, p)
    assert(Number.isFinite(h))
    assert.equal(h, terrain.samplePlanetHeightDetailed(dir, p))
    const meters = terrain.samplePlanetLandformHeight(dir, p) * p.radius * p.terrainScale
    min = Math.min(min, meters); max = Math.max(max, meters)
    const offset = { x: dir.x + 1e-8, y: dir.y, z: dir.z }
    const len = Math.hypot(offset.x, offset.y, offset.z)
    Object.keys(offset).forEach(k => { offset[k] /= len })
    maxStep = Math.max(maxStep, Math.abs(terrain.samplePlanetLandformHeight(offset, p) - terrain.samplePlanetLandformHeight(dir, p)) * p.radius * p.terrainScale)
  }
}
assert(min < -15 && max > 30 && min > -110 && max < 110)
assert(maxStep < .001, `submillimetre probe discontinuity: ${maxStep}`)
for (const type of ['ice', 'gas']) assert.equal(terrain.samplePlanetLandformHeight(dirs[0], { ...params, planetType: type }), 0)
assert.equal(terrain.samplePlanetLandformHeight(dirs[0], { ...params, reliefVariety: 0 }), 0)
let forest = 0, clearing = 0, outcrops = 0
for (const dir of dirs) {
  const p = { x: dir.x * 25000, y: dir.y * 25000, z: dir.z * 25000 }
  const e = ecology.sampleSurfaceEcology(p, 67, 1)
  assert.deepEqual(e, ecology.sampleSurfaceEcology(p, 67, 1))
  assert(Object.values(e).every(v => v >= 0 && v <= 1))
  const steep = ecology.sampleSurfaceEcology(p, 67, .7)
  assert(steep.woodland <= e.woodland && steep.meadow <= e.meadow)
  assert(steep.outcrop >= e.outcrop)
  if (e.woodland > .6) forest++
  if (e.woodland < .05) clearing++
  if (steep.outcrop > .5) outcrops++
}
assert(forest > 50 && clearing > 500 && outcrops > 100)
// Probe across the old integer-cell discontinuities in all three axes.
for (const scale of [85, 150, 640]) for (const axis of ['x', 'y', 'z']) {
  const p = { x: 137, y: -59, z: 213 }; p[axis] = scale - 1e-5
  const before = ecology.sampleSurfaceEcology(p, 67, .95); p[axis] += 2e-5
  const after = ecology.sampleSurfaceEcology(p, 67, .95)
  for (const key of Object.keys(before)) assert(Math.abs(before[key] - after[key]) < 1e-5)
}
console.log(JSON.stringify({ samples: 12000, landformMeters: [min, max], maxSubmillimeterHeightStep: maxStep, forest, clearing, outcrops }, null, 2))
if (process.argv.includes('--benchmark')) {
  const before = compile(execFileSync('git', ['show', `3aa5ba9:${path}`], { cwd: root, encoding: 'utf8' }), imports)
  const run = module => { const t = performance.now(); for (const dir of dirs) module.samplePlanetHeightDetailed(dir, params); return performance.now() - t }
  run(before); run(terrain)
  const a = [], b = []
  for (let i = 0; i < 7; i++) { a.push(run(before)); b.push(run(terrain)) }
  a.sort((x,y) => x-y); b.sort((x,y) => x-y)
  console.log(JSON.stringify({ detailedSamples: dirs.length, baselineMedianMs: a[3], currentMedianMs: b[3], ratio: b[3]/a[3] }, null, 2))
  const quadtree = compile(read('client/src/game/planet/quadtree.ts'))
  const geometrySource = read('client/src/game/planet/terrain-geometry.ts')
  const build = module => compile(geometrySource, { './quadtree': quadtree, '../../../../server/spacetimedb/src/shared/planet-terrain': module }).buildTerrainChunkGeometryData
  const oldBuild = build(before), newBuild = build(terrain)
  const chunk = { face: 4, lod: 10, x: 450, y: 719, children: null, key: '4_10_450_719', covered: false }
  const measureChunk = fn => { const t = performance.now(); fn(chunk, params, 33, false); return performance.now() - t }
  measureChunk(oldBuild); measureChunk(newBuild)
  const oldTimes = [], newTimes = []
  for (let i = 0; i < 5; i++) { oldTimes.push(measureChunk(oldBuild)); newTimes.push(measureChunk(newBuild)) }
  oldTimes.sort((x,y) => x-y); newTimes.sort((x,y) => x-y)
  console.log(JSON.stringify({ gridSize: 33, baselineChunkMedianMs: oldTimes[2], currentChunkMedianMs: newTimes[2], ratio: newTimes[2]/oldTimes[2] }, null, 2))
  for (const planetType of ['ice', 'gas']) for (const dir of dirs.slice(0, 100)) {
    assert.equal(terrain.samplePlanetHeightDetailed(dir, { ...params, planetType }), before.samplePlanetHeightDetailed(dir, { ...params, planetType }))
  }

}

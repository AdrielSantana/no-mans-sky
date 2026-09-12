// Editor console: const study = await import('/scripts/far-pose-study.js')
// First reproduce §0f with the original prepare()/priceVariants() harness.
// Then: study.findPoses(); study.setPose('valley'); await study.settle();
// await study.pricePose(); study.coverage();
// Orbit automatically tests fallback; materialScope can override that choice.
// Runtime-only diagnostics: never imported by the game.
import * as THREE from 'three'
import { VARIANTS } from './far-band-variants.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const range = xs => Math.max(...xs) - Math.min(...xs)
const rounded = x => +x.toFixed(3)
const debug = () => window.__nmsEditorDebug
let context
export const progress = { phase: 'idle', pairs: [] }

function snapshot() {
  const { engine, walker, planet } = debug()
  const info = engine.renderer.info.render
  return { draws: info.calls, triangles: info.triangles,
    pending: planet.pendingKeys.size + planet.pendingWorkerKeys.size + planet.propPrepareJobs.size,
    walker: walker.isEnabled(), dpr: engine.getPixelRatioLimit(),
    camera: engine.camera.position.toArray(), quaternion: engine.camera.quaternion.toArray() }
}

function guard() {
  const { engine, walker, planet } = debug()
  if (planet !== context.planet || walker !== context.walker) throw new Error('HMR replaced the scene')
  if (engine.getPixelRatioLimit() !== 1) throw new Error('DPR changed')
  if (walker.isEnabled() !== (context.pose.kind === 'walk')) throw new Error('Camera mode changed')
  if (engine.renderer.domElement.width !== context.width || engine.renderer.domElement.height !== context.height) throw new Error('Viewport changed')
}

export function findPoses() {
  const { engine, planet, walker } = debug()
  if (!walker.isEnabled()) throw new Error('Start from the reproduced walker pose')
  const target = walker.activeTarget
  const origin = new THREE.Vector3().copy(walker.state.localPosition).normalize()
  const east = new THREE.Vector3(1, 0, 0).projectOnPlane(origin).normalize()
  const north = new THREE.Vector3().crossVectors(origin, east).normalize()
  const radius = target.terrain.radius
  const candidates = []
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) {
    const dir = origin.clone().addScaledVector(east, i * 600 / radius).addScaledVector(north, j * 600 / radius).normalize()
    const height = target.sampleSurfaceRadius(dir)
    if (height < planet.oceanSeaRadius + 15) continue
    const e = new THREE.Vector3(1, 0, 0).projectOnPlane(dir).normalize()
    const n = new THREE.Vector3().crossVectors(dir, e).normalize()
    const ring = Array.from({ length: 8 }, (_, k) => {
      const angle = k * Math.PI / 4
      const v = dir.clone().addScaledVector(e, Math.sin(angle) * 500 / radius).addScaledVector(n, Math.cos(angle) * 500 / radius).normalize()
      return { yaw: angle, height: target.sampleSurfaceRadius(v) }
    })
    candidates.push({ direction: dir.toArray(), radius: height,
      relief: height - mean(ring.map(v => v.height)), variation: range(ring.map(v => v.height)),
      yaw: ring.reduce((a, b) => a.height < b.height ? a : b).yaw })
  }
  if (!candidates.length) throw new Error('No dry land candidates')
  const valley = [...candidates].sort((a, b) => a.relief - b.relief)[0]
  const crest = [...candidates].sort((a, b) => b.relief - a.relief)[0]
  const flat = [...candidates].sort((a, b) => a.variation - b.variation)[0]
  context = { engine, planet, walker, target, originalUpdate: walker.update,
    width: engine.renderer.domElement.width, height: engine.renderer.domElement.height,
    originalPose: { direction: origin.toArray(), yaw: walker.state.yaw, pitch: walker.state.pitch },
    poses: {
      valley: { ...valley, kind: 'walk', pitch: -1.1 },
      flat: { ...flat, kind: 'walk', pitch: 0 },
      crest: { ...crest, kind: 'walk', pitch: 0 },
      flight: { ...flat, kind: 'flight', altitude: 80, speed: 55, durationMs: 6000 },
      orbit: { direction: origin.toArray(), kind: 'orbit', altitude: radius * 1.5 },
    } }
  return context.poses
}

function flightCamera(seconds) {
  const { pose, engine, target } = context
  const origin = new THREE.Vector3().fromArray(pose.direction)
  const east = new THREE.Vector3(1, 0, 0).projectOnPlane(origin).normalize()
  const north = new THREE.Vector3().crossVectors(origin, east).normalize()
  const tangent = north.multiplyScalar(Math.cos(pose.yaw)).addScaledVector(east, Math.sin(pose.yaw))
  const theta = seconds * pose.speed / target.terrain.radius
  const dir = origin.clone().multiplyScalar(Math.cos(theta)).addScaledVector(tangent, Math.sin(theta)).normalize()
  const forward = tangent.clone().multiplyScalar(Math.cos(theta)).addScaledVector(origin, -Math.sin(theta)).normalize()
  engine.camera.position.copy(dir).multiplyScalar(target.sampleSurfaceRadius(dir) + pose.altitude)
    .applyQuaternion(target.worldQuaternion).add(target.worldPosition)
  engine.camera.up.copy(dir).applyQuaternion(target.worldQuaternion)
  engine.camera.lookAt(engine.camera.position.clone().add(forward.addScaledVector(dir, -0.16).applyQuaternion(target.worldQuaternion)))
}

export function setPose(name) {
  if (!context?.poses[name]) throw new Error('Call findPoses() first; unknown pose ' + name)
  const { engine, walker, target } = context
  context.pose = context.poses[name]
  context.name = name
  context.motionStart = null
  walker.update = context.originalUpdate
  const pose = context.pose
  if (pose.kind === 'walk') {
    walker.enableAt(target, new THREE.Vector3().fromArray(pose.direction), pose.yaw)
    walker.state.pitch = pose.pitch
  } else {
    walker.releaseWithoutRestoringCamera()
    engine.setOrbitControlsEnabled(false)
    if (pose.kind === 'flight') {
      walker.update = function(dt) {
        context.originalUpdate.call(this, dt)
        flightCamera(context.motionStart === null ? 0 : Math.min(pose.durationMs, performance.now() - context.motionStart) / 1000)
      }
      flightCamera(0)
    } else {
      const dir = new THREE.Vector3().fromArray(pose.direction)
      engine.camera.position.copy(dir).multiplyScalar(target.terrain.radius + pose.altitude)
        .applyQuaternion(target.worldQuaternion).add(target.worldPosition)
      engine.camera.up.set(0, 1, 0)
      engine.camera.lookAt(target.worldPosition)
    }
  }
  engine.setPixelRatioCeiling(1)
  engine.setPixelRatioLimit(1)
  progress.phase = 'positioned ' + name
  return { name, ...pose }
}

function sampleFrames(count = 180, durationMs = null) {
  return new Promise((resolve, reject) => {
    const deltas = [], draws = [], triangles = []
    let last = performance.now(), warmup = 12, started = null
    const tick = () => {
      try {
        guard()
        const now = performance.now(), delta = now - last
        last = now
        if (warmup > 0) warmup--
        else {
          if (started === null) { started = now; if (durationMs) context.motionStart = now }
          else { deltas.push(delta); const s = snapshot(); draws.push(s.draws); triangles.push(s.triangles) }
        }
        if (started === null || (durationMs ? now - started < durationMs : deltas.length < count)) requestAnimationFrame(tick)
        else resolve({ frameMs: median(deltas), spreadMs: range(deltas), frames: deltas.length,
          elapsedMs: now - started, draws: { min: Math.min(...draws), max: Math.max(...draws), mean: mean(draws) },
          triangles: { min: Math.min(...triangles), max: Math.max(...triangles) }, end: snapshot() })
      } catch (error) { reject(error) }
    }
    requestAnimationFrame(tick)
  })
}

export async function settle({ minimumMs = 200000, timeoutMs = 600000, plateauMs = 10000 } = {}) {
  progress.phase = 'settling ' + context.name
  const start = performance.now(), trajectory = []
  for (;;) {
    const sample = await sampleFrames(90)
    const s = snapshot(), elapsed = performance.now() - start
    trajectory.push({ seconds: rounded(elapsed / 1000), frameMs: rounded(sample.frameMs), ...s })
    progress.settling = trajectory.slice(-5)
    const recent = trajectory.filter(v => v.seconds >= elapsed / 1000 - plateauMs / 1000 - 4)
    const enough = recent.length >= 4 && (recent.at(-1).seconds - recent[0].seconds) * 1000 >= plateauMs
    const stable = enough && recent.every(v => v.pending === 0)
      && range(recent.map(v => v.draws)) <= 4
      && range(recent.map(v => v.frameMs)) <= Math.max(1, mean(recent.map(v => v.frameMs)) * 0.06)
    if (elapsed >= minimumMs && stable) return { settled: true, seconds: rounded(elapsed / 1000), trajectory }
    if (elapsed > timeoutMs) return { settled: false, seconds: rounded(elapsed / 1000), trajectory }
  }
}

export async function pricePose({
  repeats = 6, frames = 180, recompileMs = 2200, controlLimitMs = 0.5,
  materialScope = context?.pose?.kind === 'orbit' ? 'fallback' : 'far',
} = {}) {
  if (repeats < 2 || repeats % 2) throw new Error('Use a positive even repeat count')
  if (!['far', 'fallback'].includes(materialScope)) throw new Error('Unknown material scope')
  const { planet, engine, pose } = context
  guard()
  const mats = materialScope === 'fallback' ? [planet.fallbackMaterial] : planet.farLodMaterials
  const sources = mats.map(m => m.fragmentShader)
  const restore = () => mats.forEach((m, i) => { m.fragmentShader = sources[i]; m.needsUpdate = true })
  const results = [], pairs = []
  progress.pairs = pairs
  async function measure(key, variant, r) {
    context.motionStart = null
    if (pose.kind === 'flight') flightCamera(0)
    mats.forEach((m, i) => { m.fragmentShader = variant ? VARIANTS[key].apply(sources[i], r) : sources[i]; m.needsUpdate = true })
    await wait(recompileMs)
    guard()
    if (engine.renderer.info.programs.some(p => p.diagnostics && !p.diagnostics.runnable)) throw new Error('Broken shader program')
    return sampleFrames(frames, pose.kind === 'flight' ? pose.durationMs : null)
  }
  try {
    for (const key of ['control', 'revertBoth']) {
      progress.phase = context.name + ' ' + key
      for (const source of sources) for (const anchor of VARIANTS[key].needs) if (!source.includes(anchor)) throw new Error('Shader anchor missing')
      const rows = []
      for (let r = 0; r < repeats; r++) {
        let base, variant
        if (r % 2 === 0) { variant = await measure(key, true, r); base = await measure(key, false, r) }
        else { base = await measure(key, false, r); variant = await measure(key, true, r) }
        const row = { key, repeat: r, variantFirst: r % 2 === 0, differenceMs: base.frameMs - variant.frameMs, base, variant }
        rows.push(row); pairs.push(row)
      }
      const diffs = rows.map(r => r.differenceMs)
      const result = { key, gainMs: rounded(mean(diffs)), dispersionMs: rounded(range(diffs)),
        byOrder: { variantFirst: rounded(mean(rows.filter(r => r.variantFirst).map(r => r.differenceMs))),
          baselineFirst: rounded(mean(rows.filter(r => !r.variantFirst).map(r => r.differenceMs))) },
        baseMs: rounded(mean(rows.map(r => r.base.frameMs))), variantMs: rounded(mean(rows.map(r => r.variant.frameMs))),
        geometryStable: pose.kind === 'flight' ? null : range(rows.flatMap(r => [r.base.draws.min, r.base.draws.max, r.variant.draws.min, r.variant.draws.max])) <= 4,
        minimumDraws: Math.min(...rows.flatMap(r => [r.base.draws.min, r.variant.draws.min])), rows }
      results.push(result)
      if (key === 'control' && Math.abs(result.gainMs) > controlLimitMs) return { valid: false, materialScope, reason: 'Control is not near zero; variant was not measured', results }
      if (pose.kind !== 'flight' && !result.geometryStable) return { valid: false, materialScope, reason: 'Draw counts changed', results }
    }
    return { valid: true, pose: context.name, definition: pose, materialScope, dpr: 1, results }
  } finally { restore(); context.motionStart = null }
}

// Geometry-only coverage estimate, not the final composited image: excludes
// prop/avatar/ocean occlusion, atmosphere/clouds and the overlaid editor UI.
// Uses the exact visible chunk geometry and vertex shaders with depth testing.
export function coverage({ width = 368 } = {}) {
  const { engine, planet } = debug()
  const renderer = engine.renderer, camera = engine.camera
  const height = Math.round(width * renderer.domElement.height / renderer.domElement.width)
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
  const scene = new THREE.Scene(), clones = new Map()
  const terrain = new Set([planet.material, ...planet.farLodMaterials, planet.fallbackMaterial])
  const far = new Set(planet.farLodMaterials)
  engine.scene.updateMatrixWorld(true)
  engine.scene.traverseVisible(object => {
    if (!object.isMesh || !terrain.has(object.material) || !object.layers.test(camera.layers)) return
    const original = object.material
    if (!clones.has(original)) clones.set(original, new THREE.ShaderMaterial({
      uniforms: original.uniforms, vertexShader: original.vertexShader, defines: { ...original.defines },
      side: original.side, blending: THREE.NoBlending,
      fragmentShader: `#include <logdepthbuf_pars_fragment>
        varying vec3 vWorldPos;
        void main() {
          float d = distance(cameraPosition, vWorldPos);
          gl_FragColor = vec4(1.0, step(600.0, d), step(1200.0, d), ${far.has(original) ? '1.0' : '0.0'});
          #include <logdepthbuf_fragment>
        }`,
    }))
    const mesh = new THREE.Mesh(object.geometry, clones.get(original))
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(object.matrixWorld)
    mesh.frustumCulled = object.frustumCulled
    scene.add(mesh)
  })
  const saved = { target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear }
  try {
    renderer.setRenderTarget(target)
    renderer.setClearColor(0, 0)
    renderer.autoClear = true
    renderer.render(scene, camera)
    if (renderer.info.programs.some(p => p.diagnostics && !p.diagnostics.runnable)) throw new Error('Broken coverage shader')
    const pixels = new Uint8Array(width * height * 4)
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
    let total = 0, beyond600 = 0, beyond1200 = 0, farMaterial = 0, farBeyond600 = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 127) total++
      if (pixels[i + 1] > 127) beyond600++
      if (pixels[i + 2] > 127) beyond1200++
      if (pixels[i + 3] > 127) { farMaterial++; if (pixels[i + 1] > 127) farBeyond600++ }
    }
    const percent = n => rounded(100 * n / (width * height))
    return { estimated: true, method: 'terrain-only raster; no props, ocean, atmosphere or UI occlusion', width, height,
      terrainPercent: percent(total), beyond600Percent: percent(beyond600), beyond1200Percent: percent(beyond1200),
      farMaterialPercent: percent(farMaterial), farMaterialBeyond600Percent: percent(farBeyond600), meshes: scene.children.length }
  } finally {
    renderer.setRenderTarget(saved.target); renderer.setClearColor(saved.clear, saved.alpha); renderer.autoClear = saved.autoClear
    target.dispose(); for (const material of clones.values()) material.dispose()
  }
}

export function restoreStudy() {
  if (!context) return
  const { walker, target, engine, originalPose } = context
  walker.update = context.originalUpdate
  walker.enableAt(target, new THREE.Vector3().fromArray(originalPose.direction), originalPose.yaw)
  walker.state.pitch = originalPose.pitch
  engine.setPixelRatioCeiling(2)
  progress.phase = 'restored'
}

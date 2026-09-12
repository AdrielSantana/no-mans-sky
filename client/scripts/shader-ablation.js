// Editor console: await (await import('/scripts/shader-ablation.js')).runFarShaderAblation()
//
// The far-LOD terrain material is not a cheaper shader than the near one: 869
// fragment lines against 856, the same procedural noise, the same 70-odd
// smoothsteps. LOD cuts triangles and leaves per-fragment work untouched, and
// this frame is fragment bound -- swapping the far material for the simple one
// returned 16.45 ms of a 33.7 ms frame with draws and triangles unchanged.
//
// So this ranks the pieces. Each shared GLSL block reached from main() is a
// function whose first argument is the colour it transforms, which makes
// neutralising one a source rewrite: replace the whole call with that argument
// and recompile. Pixels and geometry stay identical; only the shader changes.

// Replaces `name(firstArg, ...)` with `firstArg`, tracking nesting so a call
// containing other calls is still cut at its own closing paren.
//
// Skips the function's own definition. Rewriting that too -- which a plain
// indexOf loop does -- leaves the shader uncompilable, and a shader that fails
// to compile renders nothing while still issuing its draw calls. That reads as
// a free 10 ms on every ablation, which is how a first run "proved" that five
// different blocks each cost exactly the same.
const RETURN_TYPES = ['void', 'float', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'int', 'bool']

function stubCall(source, name) {
  let out = source
  let from = 0
  for (;;) {
    const at = out.indexOf(name + '(', from)
    if (at < 0) return out
    const preceding = out.slice(Math.max(0, at - 24), at).trimEnd()
    if (RETURN_TYPES.some(t => preceding.endsWith(t))) { from = at + name.length; continue }
    let depth = 0, i = at + name.length, firstArgEnd = -1
    for (; i < out.length; i++) {
      const c = out[i]
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) break }
      else if (c === ',' && depth === 1 && firstArgEnd < 0) firstArgEnd = i
    }
    if (i >= out.length) return out
    const firstArg = out.slice(at + name.length + 1, firstArgEnd < 0 ? i : firstArgEnd).trim()
    out = out.slice(0, at) + firstArg + out.slice(i + 1)
    from = at + firstArg.length
  }
}

// A program that failed to compile still issues draws but shades nothing, so
// every timing taken while one is broken is meaningless.
function brokenPrograms(engine) {
  return engine.renderer.info.programs.filter(p => p.diagnostics && !p.diagnostics.runnable).length
}

function sampleFrames(count) {
  return new Promise(resolve => {
    const deltas = []
    let last = performance.now(), warmup = 12
    const tick = () => {
      const now = performance.now(), dt = now - last
      last = now
      if (warmup > 0) warmup--
      else deltas.push(dt)
      if (deltas.length < count) requestAnimationFrame(tick)
      else resolve(deltas.sort((a, b) => a - b))
    }
    requestAnimationFrame(tick)
  })
}

async function measure(engine, frames) {
  const xs = await sampleFrames(frames)
  const info = engine.renderer.info.render
  const mid = xs[Math.floor(xs.length / 2)]
  return {
    frameMs: +mid.toFixed(2),
    fps: +(1000 / mid).toFixed(1),
    spread: +(xs[Math.floor(xs.length * 0.75)] - xs[Math.floor(xs.length * 0.25)]).toFixed(2),
    draws: info.calls,
    triangles: info.triangles,
  }
}

export async function runFarShaderAblation({ frames = 300, recompileMs = 3000 } = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Open the editor (?editor) first')
  const { engine, planet } = debug
  const materials = planet.farLodMaterials
  const originals = materials.map(m => m.fragmentShader)
  const wait = ms => new Promise(r => setTimeout(r, ms))

  const targets = [
    'applyTerrainTexture',
    'applyPlanetLighting',
    'applyGrassGroundAo',
    'applyTerrainCloudShadow',
    'applyTerrainMacroAoToColor',
  ]

  const runs = []
  const baselines = []
  let before = await measure(engine, frames)
  baselines.push(before)

  for (const name of targets) {
    let touched = 0
    materials.forEach((m, i) => {
      const stubbed = stubCall(originals[i], name)
      if (stubbed !== originals[i]) touched++
      m.fragmentShader = stubbed
      m.needsUpdate = true
    })
    await wait(recompileMs)
    const broken = brokenPrograms(engine)
    const measured = await measure(engine, frames)

    materials.forEach((m, i) => { m.fragmentShader = originals[i]; m.needsUpdate = true })
    await wait(recompileMs)
    const after = await measure(engine, frames)
    baselines.push(after)

    const paired = (before.frameMs + after.frameMs) / 2
    runs.push({
      name,
      materialsTouched: touched,
      ...measured,
      gainMs: +(paired - measured.frameMs).toFixed(2),
      // All three must hold for the result to mean "shader cost" and nothing else.
      brokenPrograms: broken,
      drawsUnchanged: measured.draws === before.draws,
      trianglesUnchanged: measured.triangles === before.triangles,
    })
    before = after
  }

  const range = +(Math.max(...baselines.map(b => b.frameMs)) - Math.min(...baselines.map(b => b.frameMs))).toFixed(2)
  return {
    baseline: baselines[0],
    baselines: baselines.map(b => b.frameMs),
    noiseFloorMs: +Math.max(range, Math.max(...baselines.map(b => b.spread))).toFixed(2),
    runs: runs.sort((a, b) => b.gainMs - a.gainMs),
  }
}

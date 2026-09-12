// Editor console:
//   const m = await import('/scripts/far-block-costs.js')
//   await m.prepare()                       // walker + settle, once
//   await m.runFarBlockCosts({ targets: [...] })
//
// Ranks the GLSL blocks that the far terrain fragment shader actually executes.
//
// The static survey (scratchpad/glsl-survey.mjs) says the texture block is
// ~65% of the weighted per-fragment work and holds 8 of the 9 texture fetches.
// This is the runtime check on that ranking, and it is a separate question:
// the static weighting (fetch x8, transcendental x4, alu x1) is a guess about
// this GPU, not a measurement of it.
//
// Three things make the number survive a machine that is not idle:
//
// 1. Amplification. The gain from deleting shader work is pure fill, so it
//    scales with pixel count. Measuring at pixel ratio 2 multiplies the effect
//    by 4 while the OS jitter stays put. `engine.applyPixelRatio` clamps to
//    window.devicePixelRatio, so 2 is the ceiling on this display.
// 2. Interleaving. Each repeat measures stubbed and baseline back to back and
//    keeps the difference. Drift that takes longer than one pair -- streaming,
//    thermal, another process waking up -- cancels instead of landing on
//    whichever variant was unlucky.
// 3. A null control that recompiles without changing any work. It walks the
//    same code path and pays the same recompile, so whatever it reports is the
//    floor below which nothing here means anything.

const RETURN_TYPES = ['void', 'float', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'int', 'bool']

// Replaces `name(firstArg, ...)` with `firstArg`. Only sound when the first
// argument has the function's return type -- every `apply*` here transforms a
// colour it takes first, and sampleBiomeTexture takes the direction it samples
// along. sampleTerrainTexture does NOT qualify: its first argument is a
// sampler2D, and stubbing it produces a shader that will not compile.
function stubCall(source, name) {
  let out = source
  let from = 0
  for (;;) {
    const at = out.indexOf(name + '(', from)
    if (at < 0) return out
    const preceding = out.slice(Math.max(0, at - 24), at).trimEnd()
    // Skip the definition. Rewriting it leaves the shader uncompilable, and a
    // broken program still issues its draws while shading nothing -- which
    // reads as a free 10 ms on every ablation at once.
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

const TARGETS = {
  terrainTexture: { call: 'applyTerrainTexture', block: 'TERRAIN_TEXTURE_GLSL (bloco inteiro)' },
  biomeFetches: { call: 'sampleBiomeTexture', block: 'TERRAIN_TEXTURE_GLSL (so os 8 fetches)' },
  lighting: { call: 'applyPlanetLighting', block: 'PLANET_LIGHTING_GLSL' },
  grassAo: { call: 'applyGrassGroundAo', block: 'TERRAIN_GRASS_AO_GLSL' },
  cloudShadow: { call: 'applyTerrainCloudShadow', block: 'TERRAIN_CLOUD_SHADOW_GLSL + CLOUD_PATTERN_GLSL' },
  macroAo: { call: 'applyTerrainMacroAoToColor', block: 'PLANET_LIGHTING_GLSL (so o macro AO)' },
  control: { call: null, block: '(controle: recompila sem mudar trabalho)' },
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function sampleFrames(count) {
  return new Promise(resolve => {
    const deltas = []
    let last = performance.now(), warmup = 12
    const tick = () => {
      const now = performance.now()
      const dt = now - last
      last = now
      if (warmup > 0) warmup--
      else deltas.push(dt)
      if (deltas.length < count) requestAnimationFrame(tick)
      else resolve(deltas)
    }
    requestAnimationFrame(tick)
  })
}

function brokenPrograms(engine) {
  return engine.renderer.info.programs.filter(p => p.diagnostics && !p.diagnostics.runnable).length
}

async function measure(engine, frames) {
  const deltas = await sampleFrames(frames)
  const info = engine.renderer.info.render
  return { frameMs: median(deltas), draws: info.calls, triangles: info.triangles }
}

const wait = ms => new Promise(r => setTimeout(r, ms))

/**
 * Walker on the surface, scene fully streamed in, frame time flat.
 *
 * Split from the measurement on purpose: settling takes minutes and the CDP
 * eval has a timeout. Running it inside the ablation is how a previous attempt
 * lost the whole run to a driver timeout.
 */
export async function prepare({ minDraws = 300, plateauMs = 20000, timeoutMs = 420000, probeFrames = 90 } = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Abra o editor (?editor) primeiro')
  const { engine, planet, walker } = debug
  if (!walker?.isEnabled?.()) walker?.enableNearest?.()
  if (!walker?.isEnabled?.()) throw new Error('Nao consegui entrar no modo walk')

  const start = performance.now()
  let lastDraws = -1, lastTriangles = -1, stableSince = null, best = Infinity
  const trajectory = []
  for (;;) {
    const frameMs = median(await sampleFrames(probeFrames))
    const info = engine.renderer.info.render
    const draws = info.calls, triangles = info.triangles
    trajectory.push({ t: +((performance.now() - start) / 1000).toFixed(1), frameMs: +frameMs.toFixed(2), draws })

    const grew = Math.abs(draws - lastDraws) > Math.max(2, lastDraws * 0.01)
      || Math.abs(triangles - lastTriangles) > Math.max(5000, lastTriangles * 0.01)
    lastDraws = draws; lastTriangles = triangles
    const improving = frameMs < best * 0.98
    if (frameMs < best) best = frameMs
    const busy = planet.pendingKeys.size > 0 || planet.pendingWorkerKeys.size > 0 || planet.propPrepareJobs.size > 0

    if (grew || busy || improving || draws < minDraws) stableSince = null
    else if (stableSince === null) stableSince = performance.now()
    else if (performance.now() - stableSince >= plateauMs) {
      return { settled: true, seconds: +((performance.now() - start) / 1000).toFixed(1), draws, triangles, frameMs: +frameMs.toFixed(2), trajectory }
    }
    if (performance.now() - start > timeoutMs) {
      return { settled: false, seconds: +((performance.now() - start) / 1000).toFixed(1), draws, triangles, busy, trajectory }
    }
  }
}

export async function runFarBlockCosts({
  targets = ['control', 'terrainTexture', 'biomeFetches'],
  frames = 150,
  repeats = 3,
  pixelRatio = 2,
  recompileMs = 2200,
} = {}) {
  const debug = window.__nmsEditorDebug
  if (!debug) throw new Error('Abra o editor (?editor) primeiro')
  const { engine, planet, walker } = debug
  if (!walker?.isEnabled?.()) throw new Error('Walker caiu -- rode prepare() de novo (o HMR do Vite ejeta o walker a cada edicao)')

  const materials = planet.farLodMaterials
  const originals = materials.map(m => m.fragmentShader)
  const restore = () => materials.forEach((m, i) => { m.fragmentShader = originals[i]; m.needsUpdate = true })

  const previousRatio = engine.getPixelRatioLimit()
  if (pixelRatio) { engine.setPixelRatioCeiling(pixelRatio); engine.setPixelRatioLimit(pixelRatio) }
  await wait(1200)
  const ratio = engine.getPixelRatioLimit()
  // Everything is reported back at pixel ratio 1 so it can be compared with
  // the rest of the backlog. Only valid because the effect being measured is
  // fill: it scales with pixel count, and nothing else here does.
  const scaleToDpr1 = 1 / (ratio * ratio)

  const results = []
  try {
    for (const key of targets) {
      const target = TARGETS[key]
      if (!target) throw new Error(`alvo desconhecido: ${key}`)
      const diffs = []
      const drawsPerRepeat = []
      let touched = 0, broken = 0, drawsOk = true, trianglesOk = true, stubbedFrame = 0, baseFrame = 0

      for (let r = 0; r < repeats; r++) {
        // Stubbed. The control changes only a comment, so it pays the same
        // recompile and removes no work.
        materials.forEach((m, i) => {
          const next = target.call ? stubCall(originals[i], target.call) : `${originals[i]}\n// controle ${r}`
          if (target.call && next !== originals[i]) touched++
          m.fragmentShader = next
          m.needsUpdate = true
        })
        await wait(recompileMs)
        broken = Math.max(broken, brokenPrograms(engine))
        const stubbed = await measure(engine, frames)

        restore()
        await wait(recompileMs)
        const base = await measure(engine, frames)

        if (stubbed.draws !== base.draws) drawsOk = false
        if (stubbed.triangles !== base.triangles) trianglesOk = false
        diffs.push(base.frameMs - stubbed.frameMs)
        // Draw count per repeat, because the guards above cannot see the one
        // failure that matters here: another agent editing the repo triggers
        // Vite HMR, HMR rebuilds the planet, and the walker is dropped back
        // into orbit. Both halves of a later pair then agree at ~42 draws, so
        // "draws unchanged" still passes while the numbers describe a
        // different scene. A per-repeat trace makes that visible.
        drawsPerRepeat.push(base.draws)
        stubbedFrame = stubbed.frameMs
        baseFrame = base.frameMs
      }

      const gain = median(diffs)
      results.push({
        alvo: key,
        bloco: target.block,
        // The headline: what this block costs at pixel ratio 1.
        ganhoMs: +(gain * scaleToDpr1).toFixed(2),
        ganhoMedidoMs: +gain.toFixed(2),
        diffs: diffs.map(d => +d.toFixed(2)),
        drawsPorRepeticao: drawsPerRepeat,
        cenaEstavel: drawsPerRepeat.every(d => d > 300 && Math.abs(d - drawsPerRepeat[0]) <= 4),
        // Spread across repeats. A gain smaller than this is not a result.
        dispersaoMs: +(Math.max(...diffs) - Math.min(...diffs)).toFixed(2),
        frameBaseMs: +baseFrame.toFixed(2),
        frameStubMs: +stubbedFrame.toFixed(2),
        materiaisTocados: target.call ? touched : null,
        programasQuebrados: broken,
        drawsIguais: drawsOk,
        triangulosIguais: trianglesOk,
      })
    }
  } finally {
    restore()
    if (pixelRatio) { engine.setPixelRatioCeiling(2); engine.setPixelRatioLimit(previousRatio) }
  }

  const control = results.find(r => r.alvo === 'control')
  return {
    pixelRatio: ratio,
    escalaParaDpr1: +scaleToDpr1.toFixed(3),
    pisoDeRuidoMs: control ? +Math.max(Math.abs(control.ganhoMs), control.dispersaoMs * scaleToDpr1).toFixed(2) : null,
    walkerAtivo: engine.renderer.info.render.calls > 300,
    resultados: results.sort((a, b) => b.ganhoMs - a.ganhoMs),
  }
}

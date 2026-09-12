// Editor console, after far-block-costs.js prepare():
//   const v = await import('/scripts/far-band-variants.js')
//   await v.priceVariants()                  // cost, paired and interleaved
//   v.applyVariant('farBandOneSample')       // for a screenshot
//   v.restoreVariant()
//
// Prices the edits that are actually shippable, as opposed to the ceilings in
// far-block-costs.js.
//
// Why these two and not the cut that measured biggest: deleting the far
// branch's texture outright bought 9.7 ms but introduces a seam. The branch at
// detailFade <= 0.001 is continuous with the crossfade above it today -- both
// sides land on blend(baseColor, farTex, farAmount) -- and returning baseColor
// there drops that blend to zero across one step, which is a visible ring at
// 600 m. So:
//
//   farBandOneSample  halves the fetches where the second one cannot be seen
//                     (the far band stretches the texture ~7x and blends it at
//                     ~20%), and leaves the near band untouched.
//   farDistanceFade   ramps farAmount to zero between 2 and 8 km and skips the
//                     fetches once it is there, so the texture leaves smoothly
//                     instead of at a step.
//
// Both keyed off values the call site already has, so no signature changes and
// no new uniforms.
//
// The pair order is counterbalanced, and that is not a detail. Measuring every
// repeat as (variant, baseline) put a consistent +1.2 ms on the control in one
// run and +3.6 ms in the next, and flipped one variant from +3.4 to -4.6
// between them: whichever half of the pair goes second inherits the drift, so
// a fixed order measures the drift as if it were the effect. Alternating the
// order across repeats cancels the linear part exactly, which is why `repeats`
// should be even and why the control is still measured every time -- it is the
// check that the cancellation worked, and it should now land near zero.

const ONE_SAMPLE_ANCHOR = `  vec3 second = textureGrad(tex, uv + b, dx, dy).rgb;`
const ONE_SAMPLE_FAR = `  if (scaleMultiplier < 0.5) return first;
  vec3 second = textureGrad(tex, uv + b, dx, dy).rgb;`

const FAR_AMOUNT = `  float farAmount = uTextureBlend * 0.42;`
const FAR_AMOUNT_FADED = `  float farAmount = uTextureBlend * 0.42 * (1.0 - smoothstep(2000.0, 8000.0, cameraDistance));`

const FAR_BRANCH = `  if (detailFade <= 0.001) {
    vec3 farTex = sampleBiomeTexture(dir, coast, rockMask, snowMask, moisture, 0.14);`
const FAR_BRANCH_SKIP = `  if (detailFade <= 0.001) {
    if (farAmount <= 0.002) return baseColor;
    vec3 farTex = sampleBiomeTexture(dir, coast, rockMask, snowMask, moisture, 0.14);`

// What the source carries once the change is in.
const SHIPPED_ONE_SAMPLE = `  if (scaleMultiplier < DECORRELATE_SCALE_MIN) return first;\n`
const SHIPPED_FAR_AMOUNT = `  float farAmount = uTextureBlend * 0.42
    * (1.0 - smoothstep(detailEnd, detailEnd * 2.0, cameraDistance));`
const SHIPPED_SKIP = `    if (farAmount <= 0.002) return baseColor;\n`

const oneSample = s => s.replace(ONE_SAMPLE_ANCHOR, ONE_SAMPLE_FAR)

// The fade range is the whole question. 2-8 km bought 1.6 ms because almost no
// pixel on a walked surface is out there; the crude cut that bought 9.7 ms took
// everything past 600 m, where the near detail has just finished handing over.
// So the range starts at 600 m and the sweep is how far it takes to reach zero.
const distanceFade = (d0, d1) => s => s
  .replace(FAR_AMOUNT, `  float farAmount = uTextureBlend * 0.42 * (1.0 - smoothstep(${d0}.0, ${d1}.0, cameraDistance));`)
  .replace(FAR_BRANCH, FAR_BRANCH_SKIP)

export const VARIANTS = {
  control: { apply: (s, r) => `${s}\n// nudge ${r}`, needs: [] },
  farBandOneSample: { apply: oneSample, needs: [ONE_SAMPLE_ANCHOR] },
  fade600_2500: { apply: distanceFade(600, 2500), needs: [FAR_AMOUNT, FAR_BRANCH] },
  fade600_1200: { apply: distanceFade(600, 1200), needs: [FAR_AMOUNT, FAR_BRANCH] },
  fade2000_8000: { apply: distanceFade(2000, 8000), needs: [FAR_AMOUNT, FAR_BRANCH] },
  fade600_2500_plus1: {
    apply: s => distanceFade(600, 2500)(oneSample(s)),
    needs: [ONE_SAMPLE_ANCHOR, FAR_AMOUNT, FAR_BRANCH],
  },
  fade600_1200_plus1: {
    apply: s => distanceFade(600, 1200)(oneSample(s)),
    needs: [ONE_SAMPLE_ANCHOR, FAR_AMOUNT, FAR_BRANCH],
  },
  // Inverse variants, for validating the change after it lands in the source.
  // Measuring "shipped vs reverted" is the same paired comparison read the
  // other way round: these gains come back negative, and the magnitude is what
  // the shipped code saves. Needed because the source edit also reaches the
  // near material, which the forward variants never touched -- they only ever
  // patched planet.farLodMaterials.
  revertOneSample: {
    apply: s => s.replace(SHIPPED_ONE_SAMPLE, ''),
    needs: [SHIPPED_ONE_SAMPLE],
  },
  revertFade: {
    apply: s => s.replace(SHIPPED_FAR_AMOUNT, '  float farAmount = uTextureBlend * 0.42;')
      .replace(SHIPPED_SKIP, ''),
    needs: [SHIPPED_FAR_AMOUNT, SHIPPED_SKIP],
  },
  revertBoth: {
    apply: s => s.replace(SHIPPED_ONE_SAMPLE, '')
      .replace(SHIPPED_FAR_AMOUNT, '  float farAmount = uTextureBlend * 0.42;')
      .replace(SHIPPED_SKIP, ''),
    needs: [SHIPPED_ONE_SAMPLE, SHIPPED_FAR_AMOUNT, SHIPPED_SKIP],
  },
  allBandsOneSample: {
    apply: s => s.replace(`  vec3 second = textureGrad(tex, uv + b, dx, dy).rgb;
  return mix(first, second, smoothstep(0.15, 0.85, fract(field)));`, `  return first;`),
    needs: [ONE_SAMPLE_ANCHOR],
  },
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const wait = ms => new Promise(r => setTimeout(r, ms))

function sampleFrames(count) {
  return new Promise(resolve => {
    const d = []
    let last = performance.now(), w = 12
    const tick = () => {
      const n = performance.now(), dt = n - last
      last = n
      if (w > 0) w--
      else d.push(dt)
      if (d.length < count) requestAnimationFrame(tick)
      else resolve(d)
    }
    requestAnimationFrame(tick)
  })
}

let saved = null

function materials() {
  return window.__nmsEditorDebug.planet.farLodMaterials
}

// A replace() that matches nothing returns the source untouched, leaving the
// shader intact and the variant reporting the noise floor as its gain. Every
// anchor is checked before anything is measured.
function checkAnchors(variant, source) {
  const missing = variant.needs.filter(n => !source.includes(n))
  if (missing.length) throw new Error(`ancora nao encontrada (o shader mudou): ${missing[0].trim().slice(0, 60)}`)
}

export function applyVariant(key) {
  const variant = VARIANTS[key]
  if (!variant) throw new Error(`variante desconhecida: ${key}`)
  const mats = materials()
  if (!saved) saved = mats.map(m => m.fragmentShader)
  checkAnchors(variant, saved[0])
  mats.forEach((m, i) => { m.fragmentShader = variant.apply(saved[i], 0); m.needsUpdate = true })
  return { aplicada: key }
}

export function restoreVariant() {
  if (!saved) return { restaurada: false }
  materials().forEach((m, i) => { m.fragmentShader = saved[i]; m.needsUpdate = true })
  return { restaurada: true }
}

export async function priceVariants({
  keys = ['control', 'farBandOneSample', 'farDistanceFade', 'both'],
  frames = 180,
  repeats = 3,
  recompileMs = 2200,
} = {}) {
  const { engine, planet, walker } = window.__nmsEditorDebug
  if (!walker?.isEnabled?.()) throw new Error('walker caiu -- rode prepare() de novo')
  const mats = planet.farLodMaterials
  const originals = mats.map(m => m.fragmentShader)
  saved = originals
  const restore = () => mats.forEach((m, i) => { m.fragmentShader = originals[i]; m.needsUpdate = true })

  const out = []
  try {
    for (const key of keys) {
      const variant = VARIANTS[key]
      checkAnchors(variant, originals[0])
      const diffs = [], draws = []
      let broken = 0, fetchDelta = null

      const measureVariant = async r => {
        mats.forEach((m, i) => { m.fragmentShader = variant.apply(originals[i], r); m.needsUpdate = true })
        if (fetchDelta === null) {
          const count = s => (s.match(/textureGrad\(/g) || []).length
          fetchDelta = count(variant.apply(originals[0], r)) - count(originals[0])
        }
        await wait(recompileMs)
        broken = Math.max(broken, engine.renderer.info.programs.filter(p => p.diagnostics && !p.diagnostics.runnable).length)
        const frameMs = median(await sampleFrames(frames))
        draws.push(engine.renderer.info.render.calls)
        return frameMs
      }
      const measureBaseline = async () => {
        restore()
        await wait(recompileMs)
        return median(await sampleFrames(frames))
      }

      for (let r = 0; r < repeats; r++) {
        // Even repeats run variant first, odd repeats baseline first. The
        // difference is always baseline - variant, so drift enters with
        // opposite sign on alternating repeats and averages out.
        const [cut, base] = r % 2 === 0
          ? [await measureVariant(r), await measureBaseline()]
          : await (async () => { const b = await measureBaseline(); return [await measureVariant(r), b] })()
        diffs.push(base - cut)
      }
      // Mean, not median: the cancellation is an average over the two orders,
      // and a median of four can silently drop one order entirely.
      const g = diffs.reduce((a, b) => a + b, 0) / diffs.length
      out.push({
        variante: key,
        ganhoMs: +g.toFixed(2),
        diffs: diffs.map(x => +x.toFixed(2)),
        // Split by pair order. If these two disagree by more than the effect,
        // the counterbalancing is carrying the result and the number is not
        // yet trustworthy.
        porOrdem: {
          variantePrimeiro: +(diffs.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / Math.max(1, Math.ceil(diffs.length / 2))).toFixed(2),
          baselinePrimeiro: +(diffs.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(diffs.length / 2))).toFixed(2),
        },
        dispersaoMs: +(Math.max(...diffs) - Math.min(...diffs)).toFixed(2),
        textureGradNoFonte: fetchDelta,
        draws,
        cenaEstavel: draws.every(x => x > 300 && Math.abs(x - draws[0]) <= 4),
        programasQuebrados: broken,
      })
    }
  } finally { restore() }
  return { dpr: engine.getPixelRatioLimit(), resultados: out }
}

// Editor console, after far-block-costs.js prepare():
//   await (await import('/scripts/far-cut-pricing.js')).priceCuts()
//
// Prices the actual cuts, not the blocks. far-block-costs.js answers "what
// does this block cost if it vanishes", which is a ceiling nobody can ship;
// this answers "what does this specific edit buy", which is what the choice
// is actually between.
//
// Each variant is a literal source rewrite checked against the shader before
// it runs. A replace() that matches nothing returns the string unchanged, the
// shader stays intact, and the variant quietly reports the noise floor as its
// result -- so a missing match is an error here, not a zero.
//
// Measured on planet.farLodMaterials only. The near material is untouched, so
// every number below is "what far chunks cost", never the whole terrain.

const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]
const wait = ms => new Promise(r => setTimeout(r, ms))
function sampleFrames(count){return new Promise(resolve=>{const d=[];let last=performance.now(),w=12;const t=()=>{const n=performance.now(),dt=n-last;last=n;if(w>0)w--;else d.push(dt);if(d.length<count)requestAnimationFrame(t);else resolve(d)};requestAnimationFrame(t)})}

const TWO_SAMPLE = `  vec3 second = textureGrad(tex, uv + b, dx, dy).rgb;
  return mix(first, second, smoothstep(0.15, 0.85, fract(field)));`
const ONE_SAMPLE = `  return first;`

const FAR_BRANCH = `  if (detailFade <= 0.001) {
    vec3 farTex = sampleBiomeTexture(dir, coast, rockMask, snowMask, moisture, 0.14);
    return blendTerrainTexture(baseColor, farTex, farAmount);
  }`
const FAR_SKIP = `  if (detailFade <= 0.001) {
    return baseColor;
  }`

const VARIANTS = [
  { key: 'controle', apply: (s, r) => `${s}\n// nudge ${r}`, expect: null },
  { key: '1-amostra-em-vez-de-2', apply: s => s.replace(TWO_SAMPLE, ONE_SAMPLE), expect: TWO_SAMPLE,
    nota: '8 fetches -> 4; perde a decorrelacao que esconde o ladrilho' },
  { key: 'sem-textura-alem-de-600m', apply: s => s.replace(FAR_BRANCH, FAR_SKIP), expect: FAR_BRANCH,
    nota: 'so a faixa far (detailFade==0); perto e transicao intactos' },
]

export async function priceCuts({ frames = 180, repeats = 3, recompileMs = 2200 } = {}) {
  const d = window.__nmsEditorDebug
  const { engine, planet, walker } = d
  if (!walker?.isEnabled?.()) throw new Error('walker caiu')
  const mats = planet.farLodMaterials
  const originals = mats.map(m => m.fragmentShader)
  const restore = () => mats.forEach((m,i)=>{m.fragmentShader=originals[i];m.needsUpdate=true})
  const out = []
  try {
    for (const v of VARIANTS) {
      // A rewrite that matched nothing is a silent pass: the shader is intact
      // and the variant reports the noise floor as its gain.
      if (v.expect && !originals[0].includes(v.expect)) {
        out.push({ variante: v.key, erro: 'trecho nao encontrado -- o shader mudou' }); continue
      }
      const diffs = [], draws = []
      let broken = 0
      for (let r = 0; r < repeats; r++) {
        mats.forEach((m,i)=>{m.fragmentShader=v.apply(originals[i], r);m.needsUpdate=true})
        await wait(recompileMs)
        broken = Math.max(broken, engine.renderer.info.programs.filter(p=>p.diagnostics&&!p.diagnostics.runnable).length)
        const cut = median(await sampleFrames(frames))
        const cutDraws = engine.renderer.info.render.calls
        restore()
        await wait(recompileMs)
        const base = median(await sampleFrames(frames))
        diffs.push(base - cut); draws.push(cutDraws)
      }
      const g = median(diffs)
      out.push({
        variante: v.key, nota: v.nota,
        ganhoMs: +g.toFixed(2),
        diffs: diffs.map(x=>+x.toFixed(2)),
        dispersaoMs: +(Math.max(...diffs)-Math.min(...diffs)).toFixed(2),
        draws, cenaEstavel: draws.every(x=>x>300&&Math.abs(x-draws[0])<=4),
        programasQuebrados: broken,
      })
    }
  } finally { restore() }
  return { dpr: engine.getPixelRatioLimit(), resultados: out }
}

// Static survey of the far-LOD terrain fragment shader.
//
// Answers "what is actually executed per fragment", not "how many lines does
// each block have". Builds the call graph from main(), so a block that is
// included but never reached scores zero -- which is a result, not a gap.
//
// Runs on the source, so machine load cannot touch it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// node client/scripts/glsl-survey.mjs
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const GEN = readFileSync(`${ROOT}/game/planet/planet-generator.ts`, 'utf8')
const NOISE = readFileSync(`${ROOT}/game/shaders/noise.glsl.ts`, 'utf8')
const BIOMES = readFileSync(`${ROOT}/game/planet/planet-type-shaders.ts`, 'utf8')

// Pull `NAME = /* glsl */ \`...\`` out of a module, honouring nested ${} so an
// interpolated block does not end the literal early.
function literal(src, name) {
  const head = new RegExp(`${name}\\s*=\\s*/\\* glsl \\*/\\s*\``).exec(src)
  if (!head) throw new Error(`missing ${name}`)
  let i = head.index + head[0].length
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === '$' && src[i + 1] === '{') { depth++; i++; continue }
    if (src[i] === '}' && depth > 0) { depth--; continue }
    if (src[i] === '`' && depth === 0) break
  }
  return src.slice(head.index + head[0].length, i)
}

const BLOCKS = {
  SIMPLEX_4D: literal(NOISE, 'SIMPLEX_4D'),
  TERRAIN_NOISE: literal(NOISE, 'TERRAIN_NOISE'),
  TERRAIN_HEIGHT_GLSL: literal(GEN, 'TERRAIN_HEIGHT_GLSL'),
  TERRAIN_TEXTURE_GLSL: literal(GEN, 'TERRAIN_TEXTURE_GLSL'),
  CLOUD_PATTERN_GLSL: literal(GEN, 'CLOUD_PATTERN_GLSL'),
  PLANET_LIGHTING_GLSL: literal(GEN, 'PLANET_LIGHTING_GLSL'),
  TERRAIN_GRASS_AO_GLSL: literal(GEN, 'TERRAIN_GRASS_AO_GLSL'),
  TERRAIN_CLOUD_SHADOW_GLSL: literal(GEN, 'TERRAIN_CLOUD_SHADOW_GLSL'),
  PLANET_TYPE_BIOMES_GLSL: literal(BIOMES, 'PLANET_TYPE_BIOMES_GLSL'),
}
// TERRAIN_NOISE interpolates SIMPLEX_4D; keep them attributed separately.
BLOCKS.TERRAIN_NOISE = BLOCKS.TERRAIN_NOISE.replace(/\$\{SIMPLEX_4D\}/, '')

// The far fragment shader's own body: everything between the assembled
// includes, i.e. the material-local helpers plus main().
function farFragmentBody() {
  const at = GEN.indexOf('export function createPlanetFarMaterial')
  const head = /const fragmentShader = \/\* glsl \*\/ `/.exec(GEN.slice(at))
  const start = at + head.index + head[0].length
  let i = start, depth = 0
  for (; i < GEN.length; i++) {
    if (GEN[i] === '\\') { i++; continue }
    if (GEN[i] === '$' && GEN[i + 1] === '{') { depth++; i++; continue }
    if (GEN[i] === '}' && depth > 0) { depth--; continue }
    if (GEN[i] === '`' && depth === 0) break
  }
  return GEN.slice(start, i).replace(/\$\{[A-Z_0-9]+\}/g, '')
}
BLOCKS['(main do far)'] = farFragmentBody()

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const TYPES = ['void', 'float', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'int', 'bool', 'uint', 'ivec2', 'ivec3', 'ivec4']
const DEF = new RegExp(`(?:^|\\n)\\s*(?:highp |mediump |lowp )?(${TYPES.join('|')})\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'g')

// Every function definition in every block, with its body and home block.
const funcs = new Map()
for (const [block, raw] of Object.entries(BLOCKS)) {
  const src = stripComments(raw)
  DEF.lastIndex = 0
  let m
  while ((m = DEF.exec(src))) {
    const open = src.indexOf('(', m.index + m[0].length - 1)
    let i = open, depth = 0
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') { depth--; if (!depth) break } }
    const brace = src.indexOf('{', i)
    // A prototype (`;` before `{`) declares, it does not define.
    const semi = src.indexOf(';', i)
    if (brace < 0 || (semi >= 0 && semi < brace)) continue
    let j = brace, d2 = 0
    for (; j < src.length; j++) { if (src[j] === '{') d2++; else if (src[j] === '}') { d2--; if (!d2) break } }
    funcs.set(m[2], { name: m[2], block, body: src.slice(brace + 1, j) })
    DEF.lastIndex = j
  }
}

const BUILTINS = new Set(['if', 'for', 'while', 'return', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'float', 'int', 'bool', 'ivec2', 'ivec3', 'ivec4'])
const TRANSCENDENTAL = new Set(['pow', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'atan', 'asin', 'acos', 'sqrt', 'inversesqrt', 'normalize', 'length', 'distance', 'reflect', 'refract'])
const TEXTURE = new Set(['texture', 'texture2D', 'textureLod', 'texture2DLodEXT', 'textureGrad'])
const ALU = new Set(['mix', 'clamp', 'smoothstep', 'step', 'dot', 'cross', 'abs', 'min', 'max', 'floor', 'ceil', 'fract', 'mod', 'sign', 'saturate', 'dFdx', 'dFdy', 'fwidth'])

// Walk a body statement by statement, tracking loop nesting so an op inside a
// `for` counts once per trip. Loop bounds come from the literal in the header;
// a `break` on a uniform (terrainFbm) is resolved by OCTAVES below.
const OCTAVES = 5

function scan(body) {
  const calls = []      // { name, weight }
  let transcendental = 0, texture = 0, alu = 0
  const loopStack = []  // { closeAt, trips }
  let weight = 1
  const recompute = () => { weight = loopStack.reduce((a, l) => a * l.trips, 1) }

  for (let i = 0; i < body.length; i++) {
    while (loopStack.length && i >= loopStack[loopStack.length - 1].closeAt) { loopStack.pop(); recompute() }
    const ch = body[i]
    if (!/[A-Za-z_]/.test(ch)) continue
    let k = i
    while (k < body.length && /[A-Za-z0-9_]/.test(body[k])) k++
    const word = body.slice(i, k)
    let p = k
    while (p < body.length && /\s/.test(body[p])) p++
    if (body[p] !== '(') { i = k - 1; continue }

    if (word === 'for') {
      const header = body.slice(p, body.indexOf(')', p) + 1)
      const bound = /<\s*(\d+)/.exec(header)
      let trips = bound ? +bound[1] : 1
      let close = body.indexOf('{', p)
      if (close >= 0) {
        let d = 0, j = close
        for (; j < body.length; j++) { if (body[j] === '{') d++; else if (body[j] === '}') { d--; if (!d) break } }
        const inner = body.slice(close, j)
        if (/i\s*>=\s*octaves/.test(inner)) trips = Math.min(trips, OCTAVES)
        loopStack.push({ closeAt: j, trips })
        recompute()
      }
      i = k - 1
      continue
    }
    if (TRANSCENDENTAL.has(word)) transcendental += weight
    else if (TEXTURE.has(word)) texture += weight
    else if (ALU.has(word)) alu += weight
    else if (!BUILTINS.has(word)) calls.push({ name: word, weight })
    i = k - 1
  }
  return { calls, transcendental, texture, alu }
}

for (const f of funcs.values()) Object.assign(f, scan(f.body))

// Inclusive cost, attributed to the block that owns each executed function.
//
// Branch-aware on purpose. A plain call-graph walk sums paths that never run
// together: main() picks one of three biomes on a uniform, and
// applyTerrainTexture picks one of three distance bands. Summing all of them
// invents a fragment that does not exist -- it triple-counts the texture path,
// which is the whole answer here.
const SCENARIOS = [
  {
    label: 'chunk far, planeta rochoso (>600 m)',
    skip: new Set(['gasBands', 'iceBiome']),
    // Textually 4 call sites across 3 distance branches; one branch runs.
    once: { applyTerrainTexture: new Set(['sampleBiomeTexture']) },
  },
  {
    label: 'chunk perto, planeta rochoso (<180 m)',
    skip: new Set(['gasBands', 'iceBiome']),
    once: { applyTerrainTexture: new Set(['sampleBiomeTexture']) },
  },
  {
    label: 'faixa de transicao (180-600 m)',
    skip: new Set(['gasBands', 'iceBiome']),
    // The crossfade is the one band that really does sample twice.
    once: null,
    twice: { applyTerrainTexture: new Set(['sampleBiomeTexture']) },
  },
]

function accumulate(name, weight, totals, scen, seenDepth) {
  if (scen.skip.has(name)) return
  const f = funcs.get(name)
  if (!f) return
  if ((seenDepth.get(name) || 0) > 8) return
  seenDepth.set(name, (seenDepth.get(name) || 0) + 1)
  const t = totals[f.block] || (totals[f.block] = { transcendental: 0, texture: 0, alu: 0, funcs: new Set() })
  t.transcendental += f.transcendental * weight
  t.texture += f.texture * weight
  t.alu += f.alu * weight
  t.funcs.add(name)

  const onceHere = scen.once?.[name]
  const twiceHere = scen.twice?.[name]
  const collapsed = new Map()
  for (const c of f.calls) {
    if (onceHere?.has(c.name) || twiceHere?.has(c.name)) {
      collapsed.set(c.name, Math.max(collapsed.get(c.name) || 0, c.weight))
      continue
    }
    accumulate(c.name, weight * c.weight, totals, scen, seenDepth)
  }
  for (const [n, w] of collapsed) {
    accumulate(n, weight * w * (twiceHere?.has(n) ? 2 : 1), totals, scen, seenDepth)
  }
  seenDepth.set(name, seenDepth.get(name) - 1)
}

const pad = (s, n) => String(s).padStart(n)
const reached = new Set()

for (const scen of SCENARIOS) {
  const totals = {}
  const main = funcs.get('main')
  totals['(main do far)'] = { transcendental: main.transcendental, texture: main.texture, alu: main.alu, funcs: new Set(['main']) }
  for (const c of main.calls) accumulate(c.name, c.weight, totals, scen, new Map())

  const rows = Object.entries(totals).map(([block, t]) => ({
    block,
    texture: t.texture,
    transcendental: t.transcendental,
    alu: t.alu,
    // Machine-independent weighting: a filtered fetch with explicit gradients
    // is the expensive slot, a transcendental next, plain ALU nearly free.
    score: t.texture * 8 + t.transcendental * 4 + t.alu,
    funcs: [...t.funcs],
  })).sort((a, b) => b.score - a.score)
  for (const r of rows) r.funcs.forEach(f => reached.add(f))

  const total = rows.reduce((a, r) => a + r.score, 0)
  console.log(`\n== ${scen.label}`)
  console.log(`${'bloco'.padEnd(28)}${pad('tex', 5)}${pad('transc', 8)}${pad('alu', 7)}${pad('peso', 8)}${pad('%', 7)}`)
  for (const r of rows) {
    console.log(`${r.block.padEnd(28)}${pad(r.texture, 5)}${pad(r.transcendental, 8)}${pad(r.alu, 7)}${pad(r.score, 8)}${pad((100 * r.score / total).toFixed(1), 7)}`)
  }
  console.log(`${'TOTAL'.padEnd(28)}${pad(rows.reduce((a, r) => a + r.texture, 0), 5)}${pad(rows.reduce((a, r) => a + r.transcendental, 0), 8)}${pad(rows.reduce((a, r) => a + r.alu, 0), 7)}${pad(total, 8)}`)
}

const declared = new Set(Object.keys(BLOCKS))
const usedBlocks = new Set([...reached].map(n => funcs.get(n)?.block).filter(Boolean))
console.log(`\nincluido no shader mas nunca alcancado a partir de main():`)
for (const b of declared) if (!usedBlocks.has(b)) console.log(`  ${b}`)

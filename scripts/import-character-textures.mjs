#!/usr/bin/env node
// Shrinks a character's texture set to what the renderer actually samples.
//
//   node scripts/import-character-textures.mjs client/src/assets/models/astronaut
//   node scripts/import-character-textures.mjs <dir> --base 2048 --extra 1024
//
// The avatar is drawn by a hand-written shader (player-avatar.ts) that reads
// base color only and writes alpha 1.0. Generators ship 4096 maps and a full
// PBR set regardless, so a stock export costs ~30 MB of download and ~255 MB of
// VRAM to feed one sampler.
//
// Base color is written as WebP because it measured better on both axes for
// this asset: at 2048, WebP q90 is 849 KB / 39.3 dB against JPEG q92 at
// 1169 KB / 38.3 dB. three's GLTFLoader and a plain TextureLoader both take it.
//
// metallic and roughness are kept, at a smaller size, purely so they exist if
// the avatar ever gets a real PBR shader. Nothing samples them today -- they
// are written next to the base map, not wired in.
//
// Sources are never deleted. Generator output cannot be regenerated once the
// job expires, so pruning is left to a human.

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const BASE_PATTERNS = [/base[_-]?color/i, /albedo/i, /diffuse/i, /texture_0(?!_)/i]
const EXTRA_PATTERNS = { metallic: [/metallic/i, /metalness/i], roughness: [/roughness/i] }

function classify(name) {
  for (const [slot, patterns] of Object.entries(EXTRA_PATTERNS)) {
    if (patterns.some(p => p.test(name))) return slot
  }
  if (BASE_PATTERNS.some(p => p.test(name))) return 'base'
  return null
}

const dir = process.argv[2]
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node scripts/import-character-textures.mjs <directory> [--base 2048] [--extra 1024]')
  process.exit(1)
}
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}
const baseSize = arg('--base', 2048)
const extraSize = arg('--extra', 1024)

const images = fs.readdirSync(dir)
  .filter(name => /\.(png|jpe?g|webp)$/i.test(name))
  .map(name => ({ name, file: path.join(dir, name), slot: classify(name) }))
  .filter(entry => entry.slot)

if (images.length === 0) {
  console.error(`no base/metallic/roughness textures found in ${dir}`)
  process.exit(1)
}

const vram = size => (size * size * 4 * 1.33) / 1048576
let beforeDisk = 0, beforeVram = 0, afterDisk = 0, afterVram = 0
const written = []

for (const image of images) {
  const meta = await sharp(image.file).metadata()
  const size = image.slot === 'base' ? baseSize : extraSize
  const target = path.join(dir, `${image.slot === 'base' ? 'base_color' : image.slot}.webp`)

  // removeAlpha is checked, not assumed: a mask hidden in the alpha channel
  // would be silently thrown away here.
  if (meta.hasAlpha) {
    const { data, info } = await sharp(image.file).raw().toBuffer({ resolveWithObject: true })
    let opaque = true
    for (let i = 3; i < data.length; i += info.channels) {
      if (data[i] !== 255) { opaque = false; break }
    }
    if (!opaque) throw new Error(`${image.name}: alpha channel is not constant -- it carries data, refusing to drop it`)
  }

  await sharp(image.file)
    .resize(size, size, { kernel: 'lanczos3' })
    .removeAlpha()
    .webp({ quality: image.slot === 'base' ? 90 : 88 })
    .toFile(target)

  const before = fs.statSync(image.file).size / 1048576
  const after = fs.statSync(target).size / 1048576
  beforeDisk += before; afterDisk += after
  beforeVram += vram(meta.width); afterVram += vram(size)
  written.push({ slot: image.slot, from: image.name, to: path.basename(target), meta, size, before, after })
}

console.log(`${dir}\n`)
for (const w of written) {
  console.log(`  ${w.to.padEnd(16)} ${w.meta.width}x${w.meta.height} -> ${w.size}x${w.size}   `
    + `${w.before.toFixed(2)} -> ${w.after.toFixed(2)} MB disco   `
    + `${vram(w.meta.width).toFixed(0)} -> ${vram(w.size).toFixed(1)} MB VRAM`
    + (w.slot === 'base' ? '' : '   (nao amostrado hoje)'))
}
console.log(`\n  disco: ${beforeDisk.toFixed(2)} -> ${afterDisk.toFixed(2)} MB (${(beforeDisk / afterDisk).toFixed(1)}x)`)
console.log(`  VRAM:  ${beforeVram.toFixed(0)} -> ${afterVram.toFixed(1)} MB (${(beforeVram / afterVram).toFixed(1)}x)`)
console.log(`\n  As fontes NAO foram apagadas.`)

#!/usr/bin/env node
// Builds the LOD ladder for a hero model from a single source .glb.
//
//   node scripts/import-ship-lods.mjs client/src/assets/models/spaceships/origin/Meshy_AI__0901010044_texture.glb
//   node scripts/import-ship-lods.mjs <source.glb> --out <dir> --keep-4k
//
// Why this exists next to import-prop-lods.mjs instead of replacing it: props
// are drawn by a shader that samples base color only, so that script *deletes*
// the normal and metallicRoughness maps. A ship is lit by MeshStandardMaterial
// and 3.5k triangles only read as a ship because the normal map carries the
// panel detail, so here those maps are the point.
//
// The tiers are decimated from one mesh rather than exported independently, so
// every tier keeps the source UV layout and the atlas stays valid. Each tier
// still gets its own material, because each tier gets its own texture sizes.
//
// The source is never deleted. There is exactly one of it and no way to bake
// another, so outputs are written alongside it and pruning is left to a human.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

// ratio is fed to meshoptimizer; the texture sizes are maximums per slot.
//
// Sizes come from texel density, not from taste: at ~12 m long and filling
// roughly 600x400 px in third person, with ~40% of the surface facing camera,
// a 2048 atlas is already ~7x more texels than pixels. metallicRoughness is
// low-frequency everywhere and never needs to match base color.
//
// Qualities come from a measurement, not from defaults. Re-encoding the source
// normal map at 2048 and comparing reconstructed normals against a lossless
// resample of the same source:
//
//   codec          size   mean angular error   p99     max
//   jpeg q80      163 KB       0.958°         5.92°   21.0°
//   webp q90      213 KB       0.749°         4.33°   16.4°
//   webp q95      386 KB       0.648°         3.85°   15.2°
//   jpeg q92 444  535 KB       0.647°         3.36°   13.2°
//
// WebP wins on bytes-per-degree at every point on that curve, and base color
// gains ~3.5 dB PSNR over JPEG at equal size. The normal map buys q95 because
// it is the only thing giving a 3.5k-triangle hull its panel detail; the mean
// error barely moves but the p99 -- the speckle on specular highlights -- does.
const TIERS = [
  { ratio: 1.00, base: [2048, 90], normal: [2048, 95], metallicRoughness: [512, 85] },
  { ratio: 0.25, base: [512, 85], normal: [512, 90], metallicRoughness: [256, 85] },
]

const KEEP_4K_TIERS = [
  { ratio: 1.00, base: [4096, 90], normal: [4096, 95], metallicRoughness: [1024, 85] },
  { ratio: 0.25, base: [512, 85], normal: [512, 90], metallicRoughness: [256, 85] },
]

// Matched against glTF image names. Meshy emits exactly these three.
const SLOT_PATTERNS = {
  base: '*base_color*',
  normal: '*normal*',
  metallicRoughness: '*metallic_roughness*',
}

function readGlb(file) {
  const buffer = fs.readFileSync(file)
  const jsonLength = buffer.readUInt32LE(12)
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'))
}

function triangleCount(json) {
  let total = 0
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.indices != null) total += json.accessors[primitive.indices].count / 3
    }
  }
  return total
}

// JPEG/PNG dimensions straight from the bufferView, so the report describes the
// file that was written rather than the size that was requested. --width is a
// maximum and aspect ratio is preserved, so the two can legitimately differ.
function imageSizes(file) {
  const buffer = fs.readFileSync(file)
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'))
  const binStart = 20 + jsonLength + 8
  return (json.images ?? []).map((image) => {
    const view = json.bufferViews[image.bufferView]
    const bytes = buffer.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength)
    return { name: image.name ?? '?', bytes: view.byteLength, ...measure(bytes) }
  })
}

function measure(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    switch (bytes.toString('ascii', 12, 16)) {
      case 'VP8 ':
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
      case 'VP8L': {
        const bits = bytes.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      case 'VP8X':
        return {
          width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1,
          height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1,
        }
    }
    return { width: 0, height: 0 }
  }
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue }
    const marker = bytes[offset + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  return { width: 0, height: 0 }
}

function vram(images) {
  return images.reduce((sum, image) => sum + (image.width * image.height * 4 * 1.33) / 1048576, 0)
}

function gltfTransform(...args) {
  execFileSync('npx', ['--yes', '@gltf-transform/cli@4.5.0', ...args], { stdio: 'ignore' })
}

// Resizes every texture to its tier size and rewrites it as PNG.
//
// This exists because the CLI cannot express "resize without re-encoding".
// `gltf-transform png` is a no-op on JPEG input -- verified, all three images
// come back image/jpeg -- so `resize` stays the lossy step, and a WebP pass
// afterwards only stacks a second generation on top of the damage. Measured:
// that route lands at 0.92 degrees of normal error and 37.6 dB on base color,
// worse than the plain JPEG resize it was meant to beat.
//
// Doing the resample here and handing WebP a lossless PNG leaves exactly one
// lossy encode, at the quality we asked for: 0.65 degrees and 44.0 dB.
async function resizeTexturesToPng(source, destination, tier) {
  const buffer = fs.readFileSync(source)
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'))
  const binStart = 20 + jsonLength + 8
  const binLength = buffer.readUInt32LE(20 + jsonLength)
  const bin = buffer.subarray(binStart, binStart + binLength)

  const slotByImage = new Map()
  for (const [name, pattern] of Object.entries(SLOT_PATTERNS)) {
    const needle = pattern.replaceAll('*', '')
    for (const [index, image] of (json.images ?? []).entries()) {
      if ((image.name ?? '').includes(needle)) slotByImage.set(index, name)
    }
  }

  const replacement = new Map()
  for (const [index, image] of (json.images ?? []).entries()) {
    const slot = slotByImage.get(index)
    const size = slot ? tier[slot]?.[0] : null
    if (!size) continue
    const view = json.bufferViews[image.bufferView]
    const original = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    replacement.set(image.bufferView, await sharp(original)
      .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
      .png({ compressionLevel: 6 })
      .toBuffer())
    image.mimeType = 'image/png'
  }

  // Rebuild the binary chunk in bufferView order. Accessor byteOffsets are
  // relative to their bufferView, so keeping indices and internal layout intact
  // keeps every mesh accessor valid; only the offsets between views move.
  const chunks = []
  let cursor = 0
  for (const [index, view] of json.bufferViews.entries()) {
    const data = replacement.get(index)
      ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const padding = (4 - (cursor % 4)) % 4
    if (padding > 0) { chunks.push(Buffer.alloc(padding)); cursor += padding }
    view.byteOffset = cursor
    view.byteLength = data.length
    chunks.push(data)
    cursor += data.length
  }
  while (cursor % 4 !== 0) { chunks.push(Buffer.alloc(1)); cursor += 1 }
  const newBin = Buffer.concat(chunks, cursor)
  json.buffers[0].byteLength = newBin.length

  let text = JSON.stringify(json)
  while (text.length % 4 !== 0) text += ' '
  const jsonBuf = Buffer.from(text)
  const out = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + newBin.length)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.write('JSON', 16)
  jsonBuf.copy(out, 20)
  out.writeUInt32LE(newBin.length, 20 + jsonBuf.length)
  out.write('BIN\0', 24 + jsonBuf.length)
  newBin.copy(out, 28 + jsonBuf.length)
  fs.writeFileSync(destination, out)
}

const source = process.argv[2]
if (!source || !fs.existsSync(source)) {
  console.error('usage: node scripts/import-ship-lods.mjs <source.glb> [--out <dir>] [--keep-4k]')
  process.exit(1)
}

const outIndex = process.argv.indexOf('--out')
const outDir = outIndex > 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : path.dirname(source)
const tiers = process.argv.includes('--keep-4k') ? KEEP_4K_TIERS : TIERS

const sourceJson = readGlb(source)
const sourceTriangles = triangleCount(sourceJson)
const sourceImages = imageSizes(source)

console.log(`source: ${source}`)
console.log(`  ${sourceTriangles} triangles, ${sourceImages.length} textures, `
  + `${(fs.statSync(source).size / 1048576).toFixed(2)} MB on disk, ~${vram(sourceImages).toFixed(0)} MB VRAM`)
for (const image of sourceImages) {
  console.log(`    ${image.name.padEnd(20)} ${image.width}x${image.height}`)
}
console.log()

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-lods-'))
const outputs = []

try {
  for (const [index, tier] of tiers.entries()) {
    let current = path.join(work, `t${index}_in.glb`)
    fs.copyFileSync(source, current)

    if (tier.ratio < 1) {
      // weld first: the source has 3968 vertices for 3519 triangles, so most of
      // them are split by UV seams and hard normals. meshoptimizer will not
      // collapse across a split, and unwelded input caps the reachable ratio.
      const welded = path.join(work, `t${index}_weld.glb`)
      gltfTransform('weld', current, welded)
      const simplified = path.join(work, `t${index}_simplify.glb`)
      gltfTransform('simplify', welded, simplified, '--ratio', String(tier.ratio), '--error', '0.02')
      current = simplified
    }

    const resized = path.join(work, `t${index}_resized.glb`)
    await resizeTexturesToPng(current, resized, tier)
    current = resized

    // WebP encoding stays with the CLI: it owns the EXT_texture_webp plumbing
    // (extensionsUsed plus the per-texture extension block), and getting that
    // subtly wrong yields a file that loads everywhere except where it matters.
    for (const [slot, pattern] of Object.entries(SLOT_PATTERNS)) {
      const quality = tier[slot]?.[1]
      if (!quality) continue
      const next = path.join(work, `t${index}_${slot}_webp.glb`)
      gltfTransform('webp', current, next, '--pattern', pattern, '--quality', String(quality))
      current = next
    }

    outputs.push({ index, file: current, tier })
  }

  // Validate every tier before anything is written to the asset directory.
  for (const output of outputs) {
    const json = readGlb(output.file)
    const triangles = triangleCount(json)
    const images = imageSizes(output.file)
    const material = (json.materials ?? [])[0]

    if (images.length !== sourceImages.length) {
      throw new Error(`tier ${output.index}: ${images.length} textures, expected ${sourceImages.length}`)
    }
    // A slot pattern that matches nothing fails silently and leaves the
    // lossless PNG intermediate in the output, which is ~6x the whole budget.
    const stragglers = (json.images ?? []).filter(image => image.mimeType !== 'image/webp')
    if (stragglers.length > 0) {
      throw new Error(`tier ${output.index}: ${stragglers.map(i => `${i.name}=${i.mimeType}`).join(', ')} `
        + 'never reached WebP -- check SLOT_PATTERNS against the image names')
    }
    if (!material?.normalTexture) {
      throw new Error(`tier ${output.index}: lost its normal map`)
    }
    if (!material?.pbrMetallicRoughness?.metallicRoughnessTexture) {
      throw new Error(`tier ${output.index}: lost its metallicRoughness map`)
    }
    // Simplification is allowed to quit early on the error budget, so this is a
    // ceiling rather than an equality -- but a tier that did not shrink at all
    // is a silent no-op worth failing on.
    const expected = sourceTriangles * output.tier.ratio
    if (triangles > sourceTriangles + 1) {
      throw new Error(`tier ${output.index}: ${triangles} triangles, more than the source's ${sourceTriangles}`)
    }
    if (output.tier.ratio < 1 && triangles >= sourceTriangles) {
      throw new Error(`tier ${output.index}: simplify did nothing (${triangles} triangles)`)
    }
    output.triangles = triangles
    output.expected = expected
    output.images = images
  }

  fs.mkdirSync(outDir, { recursive: true })
  console.log('output:')
  for (const output of outputs) {
    const destination = path.join(outDir, `lod_${output.index}.glb`)
    fs.copyFileSync(output.file, destination)
    const mb = fs.statSync(destination).size / 1048576
    const sizes = output.images.map(image => `${image.name.split('_')[0]}:${image.width}`).join(' ')
    console.log(`  lod_${output.index}.glb  ${String(output.triangles).padStart(5)} tris `
      + `(alvo ${output.expected.toFixed(0)})  ${sizes}  `
      + `${mb.toFixed(2)} MB disco  ~${vram(output.images).toFixed(1)} MB VRAM`)
  }

  const before = vram(sourceImages)
  const after = outputs.reduce((sum, output) => sum + vram(output.images), 0)
  console.log(`\n  VRAM: ${before.toFixed(0)} MB -> ${after.toFixed(0)} MB (${(before / after).toFixed(1)}x)`)
  console.log(`\n  A fonte NAO foi apagada: ${source}`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

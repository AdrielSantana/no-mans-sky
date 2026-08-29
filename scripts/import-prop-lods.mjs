#!/usr/bin/env node
// Imports a directory of prop LOD exports into the layout the renderer expects.
//
//   node scripts/import-prop-lods.mjs client/src/assets/models/trees/winter_tree
//   node scripts/import-prop-lods.mjs <dir> --sizes 1024,512,256,128
//
// What it does, in order:
//   1. Reads every .glb in the directory and sorts by triangle count, descending.
//      Tier is assigned from that order -- never from the filename. Generators
//      lie: the oak tiers arrived labelled lod_100, lod_100, lod_300 and lod_0
//      while the real counts were 91, 1044, 309 and 3990.
//   2. Strips normal / metallicRoughness / occlusion / emissive from every
//      material. The prop shader samples base color only (planet-props.ts), so
//      those are decoded by GLTFLoader at load and never read.
//   3. Prunes the now-orphaned images, then resizes the remaining base color to
//      the size for that tier.
//   4. Validates every output before touching the source directory: triangle
//      counts must match their source exactly and exactly one image must remain.
//   5. Only then replaces the directory contents with lod_0.glb .. lod_N.glb.
//
// Nothing is deleted until step 4 passes for every tier.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_SIZES = [1024, 512, 256, 128]

function readGlb(file) {
  const buffer = fs.readFileSync(file)
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.slice(20, 20 + jsonLength).toString())
  return { buffer, json, jsonLength, binStart: 20 + jsonLength + 8 }
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

function writeGlb(file, json, bin) {
  let text = JSON.stringify(json)
  while (text.length % 4 !== 0) text += ' '
  const jsonBuf = Buffer.from(text)
  const out = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + bin.length)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.write('JSON', 16)
  jsonBuf.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + jsonBuf.length)
  out.write('BIN\0', 24 + jsonBuf.length)
  bin.copy(out, 28 + jsonBuf.length)
  fs.writeFileSync(file, out)
}

function stripUnusedMaps(source, destination) {
  const { buffer, json, binStart } = readGlb(source)
  for (const material of json.materials ?? []) {
    delete material.normalTexture
    delete material.occlusionTexture
    delete material.emissiveTexture
    if (material.pbrMetallicRoughness) delete material.pbrMetallicRoughness.metallicRoughnessTexture
  }
  writeGlb(destination, json, buffer.slice(binStart))
}

function gltfTransform(...args) {
  execFileSync('npx', ['--yes', '@gltf-transform/cli@latest', ...args], { stdio: 'ignore' })
}

const dir = process.argv[2]
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node scripts/import-prop-lods.mjs <directory> [--sizes 1024,512,256,128]')
  process.exit(1)
}

const sizesArg = process.argv.indexOf('--sizes')
const sizes = sizesArg > 0 && process.argv[sizesArg + 1]
  ? process.argv[sizesArg + 1].split(',').map(Number)
  : DEFAULT_SIZES

const sources = fs.readdirSync(dir)
  .filter(name => name.toLowerCase().endsWith('.glb'))
  .map(name => {
    const file = path.join(dir, name)
    return { name, file, triangles: triangleCount(readGlb(file).json) }
  })
  .sort((a, b) => b.triangles - a.triangles)

if (sources.length === 0) {
  console.error(`no .glb files in ${dir}`)
  process.exit(1)
}

console.log(`${sources.length} tier(s) in ${dir}, ordered by triangle count:\n`)
sources.forEach((source, tier) => {
  console.log(`  tier ${tier}  ${String(source.triangles).padStart(6)} tris  <- ${source.name}`)
})
console.log()

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-lods-'))
const outputs = []

try {
  sources.forEach((source, tier) => {
    const size = sizes[Math.min(tier, sizes.length - 1)]
    const stripped = path.join(work, `stripped_${tier}.glb`)
    const pruned = path.join(work, `pruned_${tier}.glb`)
    const resized = path.join(work, `lod_${tier}.glb`)

    stripUnusedMaps(source.file, stripped)
    gltfTransform('prune', stripped, pruned)
    gltfTransform('resize', pruned, resized, '--width', String(size), '--height', String(size), '--filter', 'lanczos3')

    if (!fs.existsSync(resized) || fs.statSync(resized).size === 0) {
      throw new Error(`tier ${tier} produced no output`)
    }
    outputs.push({ tier, file: resized, size, source })
  })

  // Validate everything before the directory is touched.
  for (const output of outputs) {
    const { json } = readGlb(output.file)
    const triangles = triangleCount(json)
    const images = (json.images ?? []).length
    if (triangles !== output.source.triangles) {
      throw new Error(`tier ${output.tier}: ${triangles} triangles, expected ${output.source.triangles}`)
    }
    if (images !== 1) {
      throw new Error(`tier ${output.tier}: ${images} images left, expected exactly 1 (base color)`)
    }
  }

  for (const source of sources) fs.rmSync(source.file)
  const dsStore = path.join(dir, '.DS_Store')
  if (fs.existsSync(dsStore)) fs.rmSync(dsStore)

  for (const output of outputs) {
    const destination = path.join(dir, `lod_${output.tier}.glb`)
    fs.copyFileSync(output.file, destination)
    const mb = fs.statSync(destination).size / 1048576
    const vram = (output.size * output.size * 4 * 1.33) / 1048576
    console.log(
      `  lod_${output.tier}.glb  ${String(output.source.triangles).padStart(6)} tris  `
      + `${output.size}x${output.size}  ${mb.toFixed(2)} MB on disk  ${vram.toFixed(2)} MB VRAM`,
    )
  }

  const totalVram = outputs.reduce((sum, o) => sum + (o.size * o.size * 4 * 1.33) / 1048576, 0)
  console.log(`\n  ladder VRAM: ${totalVram.toFixed(2)} MB`)
  console.log('\nRemember: independently exported tiers re-bake their own atlas, so they need')
  console.log('ownMaterial: true in loadPlanetPropAssets. Tiers decimated from one mesh do not.')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

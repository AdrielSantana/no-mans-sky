#!/usr/bin/env node
// Removes embedded texture blobs from a binary FBX, leaving the mesh, skin and
// skeleton untouched.
//
//   node scripts/strip-fbx-media.mjs <in.fbx> <out.fbx>
//   node scripts/strip-fbx-media.mjs <in.fbx> --extract <dir>   (only pull the images out)
//
// Mixamo hands back a character with its texture embedded as a Video/Content
// blob. For this project that is pure waste: player-avatar.ts loads an
// optimised texture from disk and assigns it over whatever the loader found, so
// the embedded copy is downloaded, decoded and then thrown away. On the current
// astronaut that blob is a 4096x4096 PNG -- 24.7 MB of a 25.6 MB file.
//
// The file is edited in place rather than re-serialised. A binary FBX node
// carries an absolute EndOffset, so cutting bytes out means every offset that
// points past the cut has to move; that is a patch of a few uint32s, whereas
// rewriting the tree would mean reproducing the footer, the padding and the
// array encodings byte for byte, and getting any of it wrong yields a file that
// still parses and is subtly wrong.

import fs from 'node:fs'
import path from 'node:path'

const [input, second, third] = process.argv.slice(2)
if (!input || !second) {
  console.error('usage: strip-fbx-media.mjs <in.fbx> <out.fbx>')
  console.error('       strip-fbx-media.mjs <in.fbx> --extract <dir>')
  process.exit(1)
}
const extractOnly = second === '--extract'
const outPath = extractOnly ? null : second
const extractDir = extractOnly ? (third ?? path.dirname(input)) : null

const buffer = fs.readFileSync(input)

const MAGIC = 'Kaydara FBX Binary  '
if (buffer.toString('binary', 0, MAGIC.length) !== MAGIC) {
  throw new Error(`${input}: not a binary FBX (ASCII FBX is not supported)`)
}
const version = buffer.readUInt32LE(23)
// 7500 widened the three record-header fields from 32 to 64 bits. Everything
// else about the layout is identical.
const wide = version >= 7500
const FIELD = wide ? 8 : 4
const HEADER = FIELD * 3 + 1
const readOffset = pos => wide ? Number(buffer.readBigUInt64LE(pos)) : buffer.readUInt32LE(pos)

const nodes = []          // every record, so offsets can be patched
const videoContents = []  // the blobs to remove

function parseProperties(pos, count, node) {
  for (let i = 0; i < count; i++) {
    const type = String.fromCharCode(buffer[pos])
    pos += 1
    switch (type) {
      case 'Y': pos += 2; break
      case 'C': pos += 1; break
      case 'I': case 'F': pos += 4; break
      case 'D': case 'L': pos += 8; break
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const compressedLength = buffer.readUInt32LE(pos + 8)
        const encoding = buffer.readUInt32LE(pos + 4)
        const arrayLength = buffer.readUInt32LE(pos)
        const raw = { f: 4, d: 8, l: 8, i: 4, b: 1 }[type] * arrayLength
        pos += 12 + (encoding === 0 ? raw : compressedLength)
        break
      }
      case 'S': case 'R': {
        const length = buffer.readUInt32LE(pos)
        // The blob lives on a node literally named Content inside a Video node.
        // Matching on size alone would also catch a large vertex array.
        if (type === 'R' && node.name === 'Content' && length > 0) {
          videoContents.push({ lengthFieldPos: pos, dataStart: pos + 4, length, node })
        }
        pos += 4 + length
        break
      }
      default: throw new Error(`unknown FBX property type '${type}' at ${pos - 1}`)
    }
  }
  return pos
}

function parseNode(pos) {
  const endOffset = readOffset(pos)
  if (endOffset === 0) return { end: pos + HEADER, node: null }  // null record
  const numProperties = readOffset(pos + FIELD)
  const propertyListLen = readOffset(pos + FIELD * 2)
  const nameLen = buffer[pos + FIELD * 3]
  const name = buffer.toString('binary', pos + HEADER, pos + HEADER + nameLen)

  const node = {
    name,
    endOffsetFieldPos: pos,
    endOffset,
    propListLenFieldPos: pos + FIELD * 2,
    propertyListLen,
  }
  nodes.push(node)

  const propertiesStart = pos + HEADER + nameLen
  const afterProperties = parseProperties(propertiesStart, numProperties, node)

  // Nested list, when present, runs from the end of the properties to the
  // node's own EndOffset and is terminated by a null record.
  let cursor = afterProperties
  while (cursor < endOffset - HEADER) {
    const child = parseNode(cursor)
    cursor = child.end
    if (!child.node) break
  }
  return { end: endOffset, node }
}

let cursor = 27
while (cursor < buffer.length) {
  const endOffset = readOffset(cursor)
  if (endOffset === 0) break            // top-level null record: nodes are done
  cursor = parseNode(cursor).end
}

if (videoContents.length === 0) {
  console.log(`${input}: nenhuma textura embutida encontrada, nada a fazer`)
  process.exit(0)
}

function extensionOf(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  return 'bin'
}

const base = path.basename(input).replace(/\.fbx$/i, '')
const extracted = []
for (const [index, blob] of videoContents.entries()) {
  const bytes = buffer.subarray(blob.dataStart, blob.dataStart + blob.length)
  const suffix = videoContents.length > 1 ? `_${index}` : ''
  const target = path.join(extractDir ?? path.dirname(outPath), `${base}${suffix}.${extensionOf(bytes)}`)
  fs.writeFileSync(target, bytes)
  extracted.push({ target, length: blob.length })
  console.log(`  extraido  ${path.basename(target).padEnd(58)} ${(blob.length / 1048576).toFixed(2)} MB`)
}
if (extractOnly) process.exit(0)

// Patch offsets in the original buffer first, while the recorded field
// positions are still valid, then cut the bytes out in one pass.
const cuts = videoContents
  .map(blob => ({ start: blob.dataStart, end: blob.dataStart + blob.length, blob }))
  .sort((a, b) => a.start - b.start)

const removedBefore = position => cuts.reduce((sum, cut) => sum + (cut.end <= position ? cut.end - cut.start : 0), 0)

for (const node of nodes) {
  const shift = removedBefore(node.endOffset)
  if (shift === 0) continue
  const value = node.endOffset - shift
  if (wide) buffer.writeBigUInt64LE(BigInt(value), node.endOffsetFieldPos)
  else buffer.writeUInt32LE(value, node.endOffsetFieldPos)
}
for (const cut of cuts) {
  const node = cut.blob.node
  const value = node.propertyListLen - (cut.end - cut.start)
  if (wide) buffer.writeBigUInt64LE(BigInt(value), node.propListLenFieldPos)
  else buffer.writeUInt32LE(value, node.propListLenFieldPos)
  buffer.writeUInt32LE(0, cut.blob.lengthFieldPos)  // Content is now zero-length
}

const pieces = []
let read = 0
for (const cut of cuts) {
  pieces.push(buffer.subarray(read, cut.start))
  read = cut.end
}
pieces.push(buffer.subarray(read))
const output = Buffer.concat(pieces)
fs.writeFileSync(outPath, output)

console.log(`\n  ${path.basename(input)}  ${(buffer.length / 1048576).toFixed(1)} MB`)
console.log(`  ${path.basename(outPath)}  ${(output.length / 1048576).toFixed(2)} MB`
  + `  (${(buffer.length / output.length).toFixed(1)}x menor)`)
console.log(`\n  Fonte NAO apagada. Valide o resultado antes de descartar o original.`)

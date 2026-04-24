// ── Simplex 4D noise (Ashima Arts) — TypeScript port ──────
// Direct port of the GLSL implementation for CPU-side terrain generation

function mod289(x: number): number {
  return x - Math.floor(x * (1 / 289)) * 289
}

function permute(x: number): number {
  return mod289(((x * 34 + 1) * x))
}

const F4 = 0.309016994374947451
const C = [0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958]

export function snoise4(x: number, y: number, z: number, w: number): number {
  const s = (x + y + z + w) * F4
  const ix = Math.floor(x + s)
  const iy = Math.floor(y + s)
  const iz = Math.floor(z + s)
  const iw = Math.floor(w + s)

  const sx = (ix) * C[0] + (iy) * C[1] + (iz) * C[2] + (iw) * C[3]
  const x0 = x - ix + sx
  const y0 = y - iy + sx
  const z0 = z - iz + sx
  const w0 = w - iw + sx

  // Rank sorting
  const isX = y0 < x0 ? 1 : 0
  const isY = z0 < y0 ? 1 : 0
  const isZ = w0 < z0 ? 1 : 0
  const isXY = isX + (z0 < x0 ? 1 : 0)
  const isXZ = isX + (w0 < x0 ? 1 : 0)
  const isYZ = isY + (w0 < y0 ? 1 : 0)

  const i1 = isXY + isX
  const i2 = isYZ + isY
  const i3 = isZ + isXZ

  // Offsets for remaining corners
  const x1 = x0 - i1 + C[0]
  const y1 = y0 - i1 + C[1]
  const z1 = z0 - i1 + C[2]
  const w1 = w0 - i1 + C[3]

  const x2 = x0 - i2 + C[0] * 2
  const y2 = y0 - i2 + C[1] * 2
  const z2 = z0 - i2 + C[2] * 2
  const w2 = w0 - i2 + C[3] * 2

  const x3 = x0 - i3 + C[0] * 3
  const y3 = y0 - i3 + C[1] * 3
  const z3 = z0 - i3 + C[2] * 3
  const w3 = w0 - i3 + C[3] * 3

  const x4 = x0 - 1 + C[0] * 4
  const y4 = y0 - 1 + C[1] * 4
  const z4 = z0 - 1 + C[2] * 4
  const w4 = w0 - 1 + C[3] * 4

  // Permutations
  const iwMod = mod289(iw)
  const izMod = mod289(iz)
  const iyMod = mod289(iy)
  const ixMod = mod289(ix)

  const j0 = permute(permute(permute(permute(iwMod) + izMod) + iyMod) + ixMod)

  const j1a = permute(permute(permute(permute(
    iwMod + (i1 & 1) + ((i1 & 2) >> 1)) + izMod + ((i1 >> 1) & 1) + ((i1 >> 2) & 1)) +
    iyMod + ((i1 >> 1) & 1) + ((i1 >> 2) & 1)) +
    ixMod + (i1 & 1) + ((i1 & 2) >> 1))

  // Simplified approach using dot products of normalized gradients
  const dot0 = x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0
  const dot1 = x1 * x1 + y1 * y1 + z1 * z1 + w1 * w1
  const dot2 = x2 * x2 + y2 * y2 + z2 * z2 + w2 * w2
  const dot3 = x3 * x3 + y3 * y3 + z3 * z3 + w3 * w3
  const dot4 = x4 * x4 + y4 * y4 + z4 * z4 + w4 * w4

  const m0 = Math.max(0.6 - dot0, 0)
  const m1 = Math.max(0.6 - dot1, 0)
  const m2 = Math.max(0.6 - dot2, 0)
  const m3 = Math.max(0.6 - dot3, 0)
  const m4 = Math.max(0.6 - dot4, 0)

  // Use hash-based gradient selection
  function hashGrad(seed: number): [number, number, number, number] {
    const h = mod289(seed * 127.1 + 311.7)
    const s = (h * h) % 1
    const a = s * 2 - 1
    const b = ((h * 127.1) % 1) * 2 - 1
    const c = ((h * 311.7) % 1) * 2 - 1
    const d = ((h * 74.7) % 1) * 2 - 1
    const len = Math.sqrt(a * a + b * b + c * c + d * d)
    return [a / len, b / len, c / len, d / len]
  }

  const g0 = hashGrad(j0)
  const g1 = hashGrad(j1a)
  const g2 = hashGrad(permute(j1a + 1))
  const g3 = hashGrad(permute(j1a + 2))
  const g4 = hashGrad(permute(j1a + 3))

  const n0 = m0 * m0 * m0 * m0 * (g0[0] * x0 + g0[1] * y0 + g0[2] * z0 + g0[3] * w0)
  const n1 = m1 * m1 * m1 * m1 * (g1[0] * x1 + g1[1] * y1 + g1[2] * z1 + g1[3] * w1)
  const n2 = m2 * m2 * m2 * m2 * (g2[0] * x2 + g2[1] * y2 + g2[2] * z2 + g2[3] * w2)
  const n3 = m3 * m3 * m3 * m3 * (g3[0] * x3 + g3[1] * y3 + g3[2] * z3 + g3[3] * w3)
  const n4 = m4 * m4 * m4 * m4 * (g4[0] * x4 + g4[1] * y4 + g4[2] * z4 + g4[3] * w4)

  return 49 * (n0 + n1 + n2 + n3 + n4)
}

// ── Terrain FBM ───────────────────────────────────────────
export function terrainFbm(
  px: number, py: number, pz: number,
  seed: number,
  octaves: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let maxAmp = 0
  for (let i = 0; i < octaves; i++) {
    sum += snoise4(px * freq, py * freq, pz * freq, seed) * amp
    maxAmp += amp
    freq *= lacunarity
    amp *= gain
  }
  return sum / maxAmp
}

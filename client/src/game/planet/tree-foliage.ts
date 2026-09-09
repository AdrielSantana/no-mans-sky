import * as THREE from 'three'
import {
  PROP_CLOUD_FN_GLSL,
  PROP_CLOUD_PARS_GLSL,
  PROP_LIGHT_FN_GLSL,
  PROP_LIGHT_PARS_GLSL,
  PROP_WIND_FN_GLSL,
  PROP_WIND_PARS_GLSL,
  createPropSharedUniforms,
} from './prop-shading'

// Procedural foliage for the tree props.
//
// The tree models ship trunk and branches only, deliberately: leaves are an
// engine concern here, not an asset one, so their count, size, colour, spread
// and motion are all live parameters rather than something baked into a GLB.
//
// Everything below runs once per model at load. The output is one geometry and
// one material per tree model, shared by every instance on the planet.

// ── Public settings ───────────────────────────────────────
export interface FoliageSettings {
  enabled: boolean
  // Fraction of the generated cards actually drawn, per tree. Below 1 each
  // tree drops a *different* subset, so a stand thins out unevenly the way a
  // real one does rather than every tree losing the same leaves.
  density: number
  // Card size as a fraction of tree height.
  size: number
  sizeVariance: number
  // How far each leaf's colour can drift from the A/B blend, per card.
  colorVariance: number
  // Light transmitted through the blade when the sun is behind it.
  translucency: number
  // Extra motion of the cards relative to the branch they hang on.
  flutter: number
  // How far each card's shading normal is pulled toward the canopy sphere.
  // Flat cards lit by their own geometric normal read as scattered paper; a
  // spherical normal makes the canopy read as one soft volume.
  sphericalNormal: number
}

// Colour is per species, not global: an oak and a cold conifer should not be
// wearing the same green. It sits beside heightRange in planet-props.ts for the
// same reason -- it is a property of the model, while everything in
// FoliageSettings is a property of the world.
export interface FoliagePalette {
  // Shaded, inner-canopy leaves.
  colorA: THREE.ColorRepresentation
  // Sunlit, outer-canopy leaves.
  colorB: THREE.ColorRepresentation
}

export const DEFAULT_FOLIAGE_PALETTE: FoliagePalette = {
  colorA: 0x4f7a35,
  colorB: 0x87a94b,
}

export const DEFAULT_FOLIAGE_SETTINGS: FoliageSettings = {
  enabled: true,
  density: 1,
  size: 0.105,
  sizeVariance: 0.45,
  colorVariance: 0.16,
  translucency: 0.85,
  flutter: 1,
  sphericalNormal: 0.72,
}

// Cards per LOD tier, as a fraction of the full set. Tier 3 keeps a sixth of
// the cards but the material scales them up to hold roughly the same canopy
// mass, so the silhouette survives even though the detail does not.
// Tiers past 3 were tried and removed. They held tier 3's canopy area exactly
// while collapsing an oak from 235 cards to 39, and the arithmetic was right --
// but they sat at 850m and 1300m, and props stop being drawn at 648m in game
// (WORLD_SCALE.localDetailFar * 3.6). They were unreachable, and the bounding
// sphere below is padded by the *last* tier's boost, so they cost culling
// everywhere to buy nothing. Measuring the editor's 2200m draw distance instead
// of the game's is what hid that.
export const FOLIAGE_LOD_FRACTIONS = [1, 0.55, 0.30, 0.15]
// Deliberately well short of the 1/sqrt(fraction) that would hold leaf *area*
// constant (that would be 2.6x at tier 3). Past roughly 1.35 a card stops
// reading as a clump of leaves and starts reading as one enormous leaf, which
// is far more noticeable than the canopy being slightly thinner.
export const FOLIAGE_LOD_SIZE_BOOST = [1, 1.10, 1.22, 1.35]

// ── Deterministic RNG ─────────────────────────────────────
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// ── Branch anchor extraction ──────────────────────────────
export interface BranchAnchor {
  x: number; y: number; z: number
  // Outward surface normal at the anchor.
  nx: number; ny: number; nz: number
  // Local branch radius, in model units (the mesh is normalised to height 1).
  radius: number
}

interface AnchorOptions {
  // Neighbourhood radius for the local-shape estimate, as a fraction of height.
  sampleRadius: number
  // Only vertices thinner than this percentile of the radius distribution can
  // carry leaves. Keeps foliage off the trunk.
  thinPercentile: number
  // Anchors are rejected within this distance of an accepted one, so leaves are
  // spread over the branches instead of clumping where the mesh is dense.
  spacing: number
  // Lowest point on the tree that may carry leaves, as a fraction of height.
  minHeight: number
}

// Swept against both shipped trees. Anything looser starves the narrow pine:
// at spacing 0.028 it yielded 53 anchors to the oak's 139, because Poisson
// rejection is bounded by branch surface area and a conifer has far less of it.
// These values land at 523 anchors on the oak and 295 on the winter tree, which
// is the density difference the two silhouettes actually call for.
const DEFAULT_ANCHOR_OPTIONS: AnchorOptions = {
  sampleRadius: 0.055,
  thinPercentile: 0.55,
  spacing: 0.008,
  minHeight: 0.30,
}

// Welds by position and averages normals. The GLBs split vertices along UV
// seams -- oak lod_0 carries 3791 vertices for 1987 distinct positions -- and
// leaving them split would weight anchor selection towards seams, which have
// nothing to do with where a branch actually is.
function weldPositions(geometry: THREE.BufferGeometry): { positions: Float32Array; normals: Float32Array } {
  const srcPos = geometry.getAttribute('position')
  const srcNrm = geometry.getAttribute('normal')
  const map = new Map<string, number>()
  const positions: number[] = []
  const normals: number[] = []
  const counts: number[] = []

  for (let i = 0; i < srcPos.count; i++) {
    const x = srcPos.getX(i), y = srcPos.getY(i), z = srcPos.getZ(i)
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`
    let index = map.get(key)
    if (index === undefined) {
      index = positions.length / 3
      map.set(key, index)
      positions.push(x, y, z)
      normals.push(0, 0, 0)
      counts.push(0)
    }
    if (srcNrm) {
      normals[index * 3] += srcNrm.getX(i)
      normals[index * 3 + 1] += srcNrm.getY(i)
      normals[index * 3 + 2] += srcNrm.getZ(i)
    }
    counts[index]++
  }

  for (let i = 0; i < counts.length; i++) {
    const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2])
    if (len > 1e-6) {
      normals[i * 3] /= len
      normals[i * 3 + 1] /= len
      normals[i * 3 + 2] /= len
    } else {
      normals[i * 3] = 0; normals[i * 3 + 1] = 1; normals[i * 3 + 2] = 0
    }
  }

  return { positions: new Float32Array(positions), normals: new Float32Array(normals) }
}

// Estimates the local branch radius at every vertex.
//
// For each vertex it takes the neighbourhood within `radius`, finds the
// dominant direction of that neighbourhood by power iteration -- on a branch
// that is the branch axis -- and reports the RMS distance of the neighbours
// from that axis. On a tube that quantity *is* the tube radius, and unlike a
// neighbour count it does not change when the mesh is tessellated differently.
//
// Measured on the shipped assets this separates the distribution by a factor of
// 6.6 between the 5th and 95th percentile, which is the signal leaf placement
// rides on.
function estimateLocalRadii(positions: Float32Array, sampleRadius: number): Float32Array {
  const count = positions.length / 3
  const radii = new Float32Array(count)
  const cell = Math.max(sampleRadius, 1e-4)
  const buckets = new Map<number, number[]>()

  // Integer lattice keys. Model space is bounded by roughly [-1, 1] in x/z and
  // [0, 1] in y, so the coordinates stay far inside the 1024-per-axis range
  // this packing allows.
  const keyOf = (a: number, b: number, c: number) => ((a + 512) * 1024 + (b + 512)) * 1024 + (c + 512)

  for (let i = 0; i < count; i++) {
    const a = Math.floor(positions[i * 3] / cell)
    const b = Math.floor(positions[i * 3 + 1] / cell)
    const c = Math.floor(positions[i * 3 + 2] / cell)
    const key = keyOf(a, b, c)
    let bucket = buckets.get(key)
    if (!bucket) { bucket = []; buckets.set(key, bucket) }
    bucket.push(i)
  }

  const near: number[] = []
  const r2 = sampleRadius * sampleRadius

  for (let i = 0; i < count; i++) {
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2]
    const a = Math.floor(px / cell), b = Math.floor(py / cell), c = Math.floor(pz / cell)
    near.length = 0
    let sx = 0, sy = 0, sz = 0

    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        for (let dc = -1; dc <= 1; dc++) {
          const bucket = buckets.get(keyOf(a + da, b + db, c + dc))
          if (!bucket) continue
          for (const j of bucket) {
            const dx = positions[j * 3] - px
            const dy = positions[j * 3 + 1] - py
            const dz = positions[j * 3 + 2] - pz
            if (dx * dx + dy * dy + dz * dz > r2) continue
            near.push(j)
            sx += positions[j * 3]; sy += positions[j * 3 + 1]; sz += positions[j * 3 + 2]
          }
        }
      }
    }

    const n = near.length
    if (n < 4) { radii[i] = 0; continue }

    const cx = sx / n, cy = sy / n, cz = sz / n
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
    for (const j of near) {
      const dx = positions[j * 3] - cx, dy = positions[j * 3 + 1] - cy, dz = positions[j * 3 + 2] - cz
      xx += dx * dx; xy += dx * dy; xz += dx * dz
      yy += dy * dy; yz += dy * dz; zz += dz * dz
    }
    xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n

    let vx = 1, vy = 1, vz = 1
    for (let it = 0; it < 24; it++) {
      const ax = xx * vx + xy * vy + xz * vz
      const ay = xy * vx + yy * vy + yz * vz
      const az = xz * vx + yz * vy + zz * vz
      const len = Math.hypot(ax, ay, az)
      if (len < 1e-12) break
      vx = ax / len; vy = ay / len; vz = az / len
    }

    let acc = 0
    for (const j of near) {
      const dx = positions[j * 3] - cx, dy = positions[j * 3 + 1] - cy, dz = positions[j * 3 + 2] - cz
      const t = dx * vx + dy * vy + dz * vz
      const ex = dx - t * vx, ey = dy - t * vy, ez = dz - t * vz
      acc += ex * ex + ey * ey + ez * ez
    }
    radii[i] = Math.sqrt(acc / n)
  }

  return radii
}

export function extractBranchAnchors(
  geometry: THREE.BufferGeometry,
  seed: number,
  options: Partial<AnchorOptions> = {},
): BranchAnchor[] {
  const opts = { ...DEFAULT_ANCHOR_OPTIONS, ...options }
  const { positions, normals } = weldPositions(geometry)
  const count = positions.length / 3
  if (count === 0) return []

  const radii = estimateLocalRadii(positions, opts.sampleRadius)

  const nonZero = Array.from(radii).filter(r => r > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) return []
  const thinCut = nonZero[Math.min(nonZero.length - 1, Math.floor(opts.thinPercentile * (nonZero.length - 1)))]

  // Candidates scored by thinness first and height second, so the tips of the
  // outermost branches are taken before the inner ones when spacing forces a
  // choice.
  const candidates: { index: number; score: number }[] = []
  for (let i = 0; i < count; i++) {
    const r = radii[i]
    if (r <= 0 || r > thinCut) continue
    const y = positions[i * 3 + 1]
    if (y < opts.minHeight) continue
    const thinness = 1 - r / thinCut
    candidates.push({ index: i, score: thinness * 0.7 + y * 0.3 })
  }
  candidates.sort((a, b) => b.score - a.score)

  // Greedy Poisson rejection against everything already accepted.
  const accepted: BranchAnchor[] = []
  const spacing2 = opts.spacing * opts.spacing
  const acceptCell = Math.max(opts.spacing, 1e-4)
  const acceptBuckets = new Map<number, BranchAnchor[]>()
  const acceptKey = (a: number, b: number, c: number) => ((a + 512) * 1024 + (b + 512)) * 1024 + (c + 512)

  for (const candidate of candidates) {
    const i = candidate.index
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2]
    const a = Math.floor(px / acceptCell), b = Math.floor(py / acceptCell), c = Math.floor(pz / acceptCell)

    let blocked = false
    for (let da = -1; da <= 1 && !blocked; da++) {
      for (let db = -1; db <= 1 && !blocked; db++) {
        for (let dc = -1; dc <= 1 && !blocked; dc++) {
          const bucket = acceptBuckets.get(acceptKey(a + da, b + db, c + dc))
          if (!bucket) continue
          for (const other of bucket) {
            const dx = other.x - px, dy = other.y - py, dz = other.z - pz
            if (dx * dx + dy * dy + dz * dz < spacing2) { blocked = true; break }
          }
        }
      }
    }
    if (blocked) continue

    const anchor: BranchAnchor = {
      x: px, y: py, z: pz,
      nx: normals[i * 3], ny: normals[i * 3 + 1], nz: normals[i * 3 + 2],
      radius: radii[i],
    }
    accepted.push(anchor)
    const key = acceptKey(a, b, c)
    let bucket = acceptBuckets.get(key)
    if (!bucket) { bucket = []; acceptBuckets.set(key, bucket) }
    bucket.push(anchor)
  }

  // Shuffled so that *any prefix* of the list is a spatially uniform sample of
  // the whole canopy. The LOD tiers below draw a prefix; without the shuffle
  // they would strip leaves in score order and bald one part of the tree.
  const rng = mulberry32(seed ^ 0x9e3779b9)
  for (let i = accepted.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = accepted[i]; accepted[i] = accepted[j]; accepted[j] = tmp
  }

  return accepted
}

// ── Card geometry ─────────────────────────────────────────
export interface FoliageGeometryOptions {
  cardsPerAnchor: number
  // How far the card base sits outside the branch surface, in branch radii.
  liftRadii: number
  // How far a card may tilt away from the branch normal, in radians.
  spread: number
  // How far cards rotate downward under their own weight, in radians.
  droop: number
}

const DEFAULT_GEOMETRY_OPTIONS: FoliageGeometryOptions = {
  // Three cards per anchor rather than two. Coverage is what makes a canopy
  // read as mass; the alternative -- fewer, larger cards -- makes each one
  // legible as an individual leaf, which is the failure mode this is avoiding.
  cardsPerAnchor: 3,
  liftRadii: 0.9,
  spread: 0.95,
  droop: 0.42,
}

export const FOLIAGE_ATLAS_CELLS = 2

export function buildFoliageGeometry(
  anchors: BranchAnchor[],
  seed: number,
  options: Partial<FoliageGeometryOptions> = {},
): { geometry: THREE.BufferGeometry; cardCount: number; canopyCenter: THREE.Vector3 } | null {
  const opts = { ...DEFAULT_GEOMETRY_OPTIONS, ...options }
  const cardCount = anchors.length * opts.cardsPerAnchor
  if (cardCount === 0) return null

  const rng = mulberry32(seed ^ 0x85ebca6b)

  // Attribute budget, not style: MAX_VERTEX_ATTRIBS is 16 on essentially all
  // hardware, and this mesh already spends 4 on instanceMatrix and 6 more on
  // the shared per-instance data. A first version with separate uv, leafAxisY,
  // leafCorner and leafHash attributes hit exactly 16 and failed to link with
  // "Too many attributes". Packing corner, atlas cell and hash into one vec4 --
  // and deriving the second card axis and the uv in the shader -- leaves 14.
  const pivots = new Float32Array(cardCount * 4 * 3)
  const normals = new Float32Array(cardCount * 4 * 3)
  const axisX = new Float32Array(cardCount * 4 * 3)
  const leafData = new Float32Array(cardCount * 4 * 4)
  const indices = new Uint32Array(cardCount * 6)

  // Canopy centroid, handed to the material as the origin for the spherical
  // shading normal.
  let cx = 0, cy = 0, cz = 0
  for (const a of anchors) { cx += a.x; cy += a.y; cz += a.z }
  cx /= anchors.length; cy /= anchors.length; cz /= anchors.length

  let card = 0

  for (const anchor of anchors) {
    for (let k = 0; k < opts.cardsPerAnchor; k++) {
      // Card facing: the branch normal, jittered within a cone. Cards on one
      // anchor therefore fan out instead of stacking into one flat plane.
      let fx = anchor.nx, fy = anchor.ny, fz = anchor.nz
      const theta = rng() * Math.PI * 2
      const cone = rng() * opts.spread
      // Build a basis around the normal to jitter within.
      const upx = Math.abs(fy) < 0.9 ? 0 : 1
      let tx = upx === 0 ? -fz : 0, ty = 0, tz = upx === 0 ? fx : 1
      let tl = Math.hypot(tx, ty, tz)
      if (tl < 1e-6) { tx = 1; ty = 0; tz = 0; tl = 1 }
      tx /= tl; ty /= tl; tz /= tl
      const bx = fy * tz - fz * ty, by = fz * tx - fx * tz, bz = fx * ty - fy * tx
      const sc = Math.sin(cone), cc = Math.cos(cone)
      const jx = tx * Math.cos(theta) + bx * Math.sin(theta)
      const jy = ty * Math.cos(theta) + by * Math.sin(theta)
      const jz = tz * Math.cos(theta) + bz * Math.sin(theta)
      fx = fx * cc + jx * sc; fy = fy * cc + jy * sc; fz = fz * cc + jz * sc
      const fl = Math.hypot(fx, fy, fz) || 1
      fx /= fl; fy /= fl; fz /= fl

      // The card grows outward from the pivot along `fy`-tilted `f`, and spans
      // sideways along a perpendicular. Droop rotates the growth direction
      // toward -Y so clusters hang rather than stick out rigidly.
      let gy = fy - opts.droop
      let gx = fx, gz = fz
      const gl = Math.hypot(gx, gy, gz) || 1
      gx /= gl; gy /= gl; gz /= gl

      // Sideways axis: perpendicular to the growth direction, spun freely.
      let sx = -gz, sy = 0, sz = gx
      let sl = Math.hypot(sx, sy, sz)
      if (sl < 1e-5) { sx = 1; sy = 0; sz = 0; sl = 1 }
      sx /= sl; sy /= sl; sz /= sl
      const spin = rng() * Math.PI * 2
      // Rotate the sideways axis about the growth direction (Rodrigues).
      const cs = Math.cos(spin), ss = Math.sin(spin)
      const crx = gy * sz - gz * sy, cry = gz * sx - gx * sz, crz = gx * sy - gy * sx
      const rsx = sx * cs + crx * ss
      const rsy = sy * cs + cry * ss
      const rsz = sz * cs + crz * ss

      // Geometric card normal is growth x sideways.
      let cnx = gy * rsz - gz * rsy
      let cny = gz * rsx - gx * rsz
      let cnz = gx * rsy - gy * rsx
      const cnl = Math.hypot(cnx, cny, cnz) || 1
      cnx /= cnl; cny /= cnl; cnz /= cnl

      // Pivot: lifted off the branch surface along the original normal so the
      // card base is not buried inside the bark.
      const lift = anchor.radius * opts.liftRadii
      const px = anchor.x + anchor.nx * lift
      const py = anchor.y + anchor.ny * lift
      const pz = anchor.z + anchor.nz * lift

      const cell = Math.floor(rng() * FOLIAGE_ATLAS_CELLS)
        + Math.floor(rng() * FOLIAGE_ATLAS_CELLS) * FOLIAGE_ATLAS_CELLS
      const hash = rng()

      const base = card * 4
      // Corner layout: x spans [-0.5, 0.5] across the card, y spans [0, 1]
      // outward from the pivot.
      const cornerData = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]
      for (let v = 0; v < 4; v++) {
        const o3 = (base + v) * 3
        const o4 = (base + v) * 4
        pivots[o3] = px; pivots[o3 + 1] = py; pivots[o3 + 2] = pz
        // The *geometric* card normal. The shading normal is blended toward the
        // canopy sphere in the shader, which keeps that blend a live parameter
        // and lets the second card axis be recovered as cross(axisX, normal).
        normals[o3] = cnx; normals[o3 + 1] = cny; normals[o3 + 2] = cnz
        axisX[o3] = rsx; axisX[o3 + 1] = rsy; axisX[o3 + 2] = rsz
        leafData[o4] = cornerData[v][0]
        leafData[o4 + 1] = cornerData[v][1]
        leafData[o4 + 2] = cell
        leafData[o4 + 3] = hash
      }

      const io = card * 6
      indices[io] = base; indices[io + 1] = base + 1; indices[io + 2] = base + 2
      indices[io + 3] = base; indices[io + 4] = base + 2; indices[io + 5] = base + 3
      card++
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pivots, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('leafAxisX', new THREE.BufferAttribute(axisX, 3))
  geometry.setAttribute('leafData', new THREE.BufferAttribute(leafData, 4))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))

  // The bounding sphere has to cover the cards at their largest, not the
  // pivots. Frustum culling reads this, and a sphere sized to the pivots would
  // pop the canopy out at the screen edge.
  //
  // Note this reads the *last* tier's boost, so any tier added to
  // FOLIAGE_LOD_SIZE_BOOST widens every foliage sphere at every distance, not
  // only where the new tier applies. The geometry is shared by every chunk
  // drawing the model, so it cannot be re-padded per tier.
  geometry.computeBoundingSphere()
  if (geometry.boundingSphere) {
    geometry.boundingSphere.radius += DEFAULT_FOLIAGE_SETTINGS.size
      * (1 + DEFAULT_FOLIAGE_SETTINGS.sizeVariance)
      * FOLIAGE_LOD_SIZE_BOOST[FOLIAGE_LOD_SIZE_BOOST.length - 1]
  }

  return { geometry, cardCount, canopyCenter: new THREE.Vector3(cx, cy, cz) }
}

// ── Leaf atlas ────────────────────────────────────────────
// Drawn on a canvas at module load rather than shipped as an asset, so leaf
// shape stays a parameter of the engine like everything else here. RGB carries
// a shading gradient only; the actual colour comes from the material uniforms.
function createLeafAtlas(): THREE.Texture {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    const fallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat)
    fallback.needsUpdate = true
    return fallback
  }

  ctx.clearRect(0, 0, size, size)
  const cell = size / FOLIAGE_ATLAS_CELLS
  const rng = mulberry32(0x1eaf)

  for (let cy = 0; cy < FOLIAGE_ATLAS_CELLS; cy++) {
    for (let cx = 0; cx < FOLIAGE_ATLAS_CELLS; cx++) {
      const ox = cx * cell
      const oy = cy * cell
      // Leaves radiate from the bottom-centre of the cell, which is where the
      // card's pivot sits, so a cluster looks attached rather than floating.
      const originX = ox + cell * 0.5
      const originY = oy + cell * 0.98
      const leaves = 13 + Math.floor(rng() * 6)

      for (let i = 0; i < leaves; i++) {
        const angle = (-Math.PI / 2) + (rng() - 0.5) * 2.4
        const length = cell * (0.22 + rng() * 0.30)
        const width = length * (0.42 + rng() * 0.30)
        const tipX = originX + Math.cos(angle) * length
        const tipY = originY + Math.sin(angle) * length
        const midX = (originX + tipX) * 0.5
        const midY = (originY + tipY) * 0.5
        const perpX = -Math.sin(angle) * width * 0.5
        const perpY = Math.cos(angle) * width * 0.5

        // Value varies per leaf so the cluster has internal depth once tinted.
        const shade = Math.floor(150 + rng() * 105)
        ctx.fillStyle = `rgb(${shade},${shade},${shade})`
        ctx.beginPath()
        ctx.moveTo(originX, originY)
        ctx.quadraticCurveTo(midX + perpX, midY + perpY, tipX, tipY)
        ctx.quadraticCurveTo(midX - perpX, midY - perpY, originX, originY)
        ctx.fill()

        // Midrib, a touch darker.
        ctx.strokeStyle = `rgba(${Math.floor(shade * 0.72)},${Math.floor(shade * 0.72)},${Math.floor(shade * 0.72)},0.85)`
        ctx.lineWidth = Math.max(1, cell * 0.006)
        ctx.beginPath()
        ctx.moveTo(originX, originY)
        ctx.lineTo(tipX, tipY)
        ctx.stroke()
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.name = 'foliage-atlas'
  texture.colorSpace = THREE.NoColorSpace
  // Clamped, not wrapped: cells sit next to each other in the atlas and a
  // repeat would bleed one cluster's leaves into its neighbour at the edge mip.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

let leafAtlas: THREE.Texture | null = null
function getLeafAtlas(): THREE.Texture {
  if (!leafAtlas) leafAtlas = createLeafAtlas()
  return leafAtlas
}

// ── Material ──────────────────────────────────────────────
export function createFoliageMaterial(
  settings: FoliageSettings,
  palette: FoliagePalette,
  cloudMask: THREE.Texture,
  canopyCenter: THREE.Vector3,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: {
      PROP_TRANSLUCENT: 1,
    },
    uniforms: {
      ...createPropSharedUniforms(cloudMask),
      uLeafAtlas: { value: getLeafAtlas() },
      uLeafSize: { value: settings.size },
      uLeafSizeVariance: { value: settings.sizeVariance },
      uLeafColorA: { value: new THREE.Color(palette.colorA) },
      uLeafColorB: { value: new THREE.Color(palette.colorB) },
      uLeafColorVariance: { value: settings.colorVariance },
      uTranslucency: { value: settings.translucency },
      uFlutter: { value: settings.flutter },
      uDensity: { value: settings.density },
      uSphericalNormal: { value: settings.sphericalNormal },
      uCanopyCenter: { value: canopyCenter.clone() },
      uAlphaTest: { value: 0.38 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>

      ${PROP_LIGHT_PARS_GLSL}
      ${PROP_WIND_PARS_GLSL}

      uniform vec3 uSunPosition;
      uniform float uLeafSize;
      uniform float uLeafSizeVariance;
      uniform vec3 uLeafColorA;
      uniform vec3 uLeafColorB;
      uniform float uLeafColorVariance;
      uniform float uTranslucency;
      uniform float uFlutter;
      uniform float uDensity;
      uniform float uSphericalNormal;
      uniform vec3 uCanopyCenter;

      attribute vec3 leafAxisX;
      // (corner.x, corner.y, atlas cell, per-card hash) -- see
      // buildFoliageGeometry for why these share one attribute.
      attribute vec4 leafData;
      attribute float instanceFoliageScale;
      attribute vec3 instancePlanetDir;
      attribute vec3 instanceTerrainNormal;
      attribute float instanceTerrainMicroAo;
      attribute float instanceTerrainMacroAo;
      attribute float instanceTerrainSunLight;

      varying vec2 vUv;
      varying vec3 vLight;
      varying vec3 vAlbedo;
      varying vec3 vLocalPlanetDir;
      varying float vTerrainMicroAo;
      varying float vTerrainMacroAo;

      ${PROP_LIGHT_FN_GLSL}
      ${PROP_WIND_FN_GLSL}

      float leafRandom(float a, float b) {
        return fract(sin(a * 127.1 + b * 311.7) * 43758.5453123);
      }

      void main() {
        vec2 corner = leafData.xy;
        float leafHash = leafData.w;
        // The card plane. leafAxisX and the geometric normal are orthonormal by
        // construction, and for the basis (growth, sideways, normal) built in
        // buildFoliageGeometry, sideways x normal recovers growth exactly.
        vec3 leafAxisY = cross(leafAxisX, normal);

        // Atlas cell 0..3 unpacked to a 2x2 grid.
        vec2 cellXY = vec2(mod(leafData.z, 2.0), floor(leafData.z * 0.5));
        vUv = (cellXY + vec2(corner.x + 0.5, corner.y)) * 0.5;

        vTerrainMicroAo = instanceTerrainMicroAo;
        vTerrainMacroAo = instanceTerrainMacroAo;
        vLocalPlanetDir = normalize(instancePlanetDir);

        vec3 instanceOrigin = vec3(0.0);
        vec3 axisXWorld = vec3(1.0, 0.0, 0.0);
        vec3 axisZWorld = vec3(0.0, 0.0, 1.0);
        float treeHeight = 1.0;
        #ifdef USE_INSTANCING
          instanceOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          treeHeight = length(instanceMatrix[0].xyz);
          axisXWorld = instanceMatrix[0].xyz / max(treeHeight, 1e-6);
          axisZWorld = instanceMatrix[2].xyz / max(length(instanceMatrix[2].xyz), 1e-6);
        #endif

        // Per-tree seed with no extra attribute and no extra rng draw during
        // placement: every tree sits at a distinct position, so its own
        // translation is already a unique key.
        float treeSeed = leafRandom(
          instanceOrigin.x * 0.731 + instanceOrigin.z * 1.193,
          instanceOrigin.y * 0.917 + instanceOrigin.x * 0.379
        );

        // Per-tree thinning. Each tree drops a different subset of the cards,
        // so lowering density does not carve the same hole in every tree. The
        // rejected card collapses to a degenerate quad, which the rasteriser
        // discards before it costs a fragment.
        float keep = leafRandom(leafHash * 91.7, treeSeed * 53.3);
        float alive = step(keep, clamp(uDensity, 0.0, 1.0));

        float sizeJitter = 1.0 + (leafRandom(leafHash * 17.3, treeSeed) - 0.5) * 2.0 * uLeafSizeVariance;
        // instanceFoliageScale is the LOD size compensation. It rides on the
        // instances because the material is shared by every chunk on the
        // planet, and chunks sit at different LOD tiers at the same time.
        float size = uLeafSize * sizeJitter * instanceFoliageScale * alive;

        // The pivot travels with the branch. Both this and the trunk shader
        // call propWindSway with the same arguments at the same point, so the
        // card stays welded to the branch through the whole gust.
        vec3 pivot = position;
        pivot += propWindSway(position, instanceOrigin, axisXWorld, axisZWorld, treeHeight, PROP_WIND_STIFFNESS);

        // Flutter is the card moving *relative* to its branch, phase-shifted
        // per card. This is what separates foliage from a rigid decal, and it
        // is deliberately absent from the trunk.
        //
        // Its amplitude rides the same gust envelope the branch bend does, so
        // the canopy goes still between gusts and thrashes during one, in step
        // with the branch it hangs on. The floor is non-zero because leaves are
        // never completely dead even in calm air.
        float phase = leafHash * 6.2831853 + treeSeed * 12.9;
        float flutterGust = 0.28 + propWindGust(instanceOrigin) * 1.20;
        float flutterAmp = uFlutter * uWindStrength * 0.020 * flutterGust;
        vec3 flutter =
            leafAxisX * sin(uTime * 3.1 + phase) * flutterAmp
          + leafAxisY * sin(uTime * 2.3 + phase * 1.7) * flutterAmp * 0.6;

        vec3 localPos = pivot
          + (leafAxisX * corner.x + leafAxisY * corner.y) * size
          + flutter * corner.y;

        vec4 localPosition = vec4(localPos, 1.0);
        // Shading normal pulled toward the canopy sphere, so a mass of flat
        // cards lights as one soft volume rather than as scattered paper.
        vec3 outward = position - uCanopyCenter;
        vec3 spherical = dot(outward, outward) > 1e-8 ? normalize(outward) : normal;
        vec3 localNormal = normalize(mix(normal, spherical, clamp(uSphericalNormal, 0.0, 1.0)));
        #ifdef USE_INSTANCING
          mat3 instanceNormalMatrix = mat3(instanceMatrix);
          localPosition = instanceMatrix * localPosition;
          localNormal = instanceNormalMatrix * localNormal;
        #endif

        vec4 worldPos = modelMatrix * localPosition;
        vec3 worldNormal = normalize(mat3(modelMatrix) * localNormal);
        vec3 upDir = normalize(mat3(modelMatrix) * instancePlanetDir);
        vec3 instanceWorldOrigin = (modelMatrix * vec4(instanceOrigin, 1.0)).xyz;
        vec3 sunDir = normalize(uSunPosition - instanceWorldOrigin);

        vLight = computePropLight(worldNormal, upDir, sunDir, instanceTerrainSunLight, uTranslucency);

        // Colour: an A/B blend keyed on height in the canopy -- lower leaves
        // sit in shade and read darker -- plus a per-leaf, per-tree drift.
        float canopyT = smoothstep(0.30, 1.0, position.y);
        float drift = (leafRandom(leafHash * 7.77, treeSeed * 3.31) - 0.5) * 2.0 * uLeafColorVariance;
        vec3 albedo = mix(uLeafColorA, uLeafColorB, clamp(canopyT * 0.62 + drift + 0.26, 0.0, 1.0));
        vAlbedo = albedo;

        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>

      ${PROP_CLOUD_PARS_GLSL}
      uniform sampler2D uLeafAtlas;
      uniform float uAlphaTest;
      uniform float uTerrainAoStrength;

      varying vec2 vUv;
      varying vec3 vLight;
      varying vec3 vAlbedo;
      varying vec3 vLocalPlanetDir;
      varying float vTerrainMicroAo;
      varying float vTerrainMacroAo;

      ${PROP_CLOUD_FN_GLSL}

      float foliageTerrainAo(float bakedAo, float amount, float floorValue) {
        float strength = clamp(uTerrainAoStrength, 0.0, 2.0);
        if (strength <= 0.001) return 1.0;
        float cavity = 1.0 - clamp(bakedAo, 0.0, 1.0);
        return clamp(1.0 - cavity * strength * amount, floorValue, 1.0);
      }

      void main() {
        vec4 texel = texture2D(uLeafAtlas, vUv);
        if (texel.a < uAlphaTest) discard;

        // The atlas RGB is a value ramp, not a colour: it carries the per-leaf
        // shading inside a cluster. Centred on the mid grey it was drawn
        // around so it modulates rather than darkens.
        float shade = 0.72 + texel.r * 0.52;
        vec3 color = vAlbedo * shade * vLight;

        // Foliage sits above the ground, so it takes only a light touch of the
        // terrain's baked occlusion -- enough to sit trees into hollows,
        // nowhere near what the trunk base gets.
        color *= foliageTerrainAo(vTerrainMacroAo, 0.18, 0.68);
        color *= foliageTerrainAo(vTerrainMicroAo, 0.14, 0.82);

        float cloudShadow = propCloudShadowMask(vLocalPlanetDir);
        vec3 coolShadow = color * vec3(0.11, 0.14, 0.19);
        color = mix(color, coolShadow, clamp(cloudShadow, 0.0, 0.96));

        gl_FragColor = vec4(color, 1.0);
        #include <logdepthbuf_fragment>
      }
    `,
    // Cards are flat, so both faces are visible and both must shade. This is
    // the per-submesh decision the trunk material's comment anticipated: the
    // trunk stays FrontSide with no discard and keeps early-Z, and only the
    // foliage pays for being cut-out geometry.
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
  })
}

export function updateFoliageMaterialSettings(material: THREE.ShaderMaterial, settings: FoliageSettings): void {
  material.uniforms.uLeafSize.value = settings.size
  material.uniforms.uLeafSizeVariance.value = settings.sizeVariance
  material.uniforms.uLeafColorVariance.value = settings.colorVariance
  material.uniforms.uTranslucency.value = settings.translucency
  material.uniforms.uFlutter.value = settings.flutter
  material.uniforms.uDensity.value = settings.density
  material.uniforms.uSphericalNormal.value = settings.sphericalNormal
}

// Colour is deliberately not part of updateFoliageMaterialSettings: that runs
// every frame for every model, and the palette is per model. This is the way to
// recolour one species -- for a season, a biome, or an editor slider.
export function setFoliagePalette(material: THREE.ShaderMaterial, palette: FoliagePalette): void {
  material.uniforms.uLeafColorA.value.set(palette.colorA)
  material.uniforms.uLeafColorB.value.set(palette.colorB)
}

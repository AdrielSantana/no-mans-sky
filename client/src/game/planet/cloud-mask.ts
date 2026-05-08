import * as THREE from 'three'

const TAU = Math.PI * 2

export interface CloudMaskSettings {
  seed: number
  coverage: number
  scale: number
  softness: number
  storms: number
  bands: number
  detail: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fract(value: number): number {
  return value - Math.floor(value)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.000001), 0, 1)
  return t * t * (3 - 2 * t)
}

function hash3(x: number, y: number, z: number, seed: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453)
}

function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = fract(x)
  const fy = fract(y)
  const fz = fract(z)
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const uz = fz * fz * (3 - 2 * fz)

  const n000 = hash3(ix, iy, iz, seed)
  const n100 = hash3(ix + 1, iy, iz, seed)
  const n010 = hash3(ix, iy + 1, iz, seed)
  const n110 = hash3(ix + 1, iy + 1, iz, seed)
  const n001 = hash3(ix, iy, iz + 1, seed)
  const n101 = hash3(ix + 1, iy, iz + 1, seed)
  const n011 = hash3(ix, iy + 1, iz + 1, seed)
  const n111 = hash3(ix + 1, iy + 1, iz + 1, seed)

  const nx00 = lerp(n000, n100, ux)
  const nx10 = lerp(n010, n110, ux)
  const nx01 = lerp(n001, n101, ux)
  const nx11 = lerp(n011, n111, ux)
  const nxy0 = lerp(nx00, nx10, uy)
  const nxy1 = lerp(nx01, nx11, uy)
  return lerp(nxy0, nxy1, uz) * 2 - 1
}

function fbm3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3(x * freq, y * freq, z * freq, seed + i * 37.17) * amp
    norm += amp
    amp *= gain
    freq *= lacunarity
  }

  return norm > 0 ? sum / norm : 0
}

export class CloudMaskTexture {
  readonly width: number
  readonly height: number
  readonly texture: THREE.DataTexture
  private data: Uint8Array
  private settingsKey = ''
  private curved = new THREE.Vector3()
  private tangent = new THREE.Vector3()
  private bitangent = new THREE.Vector3()

  constructor(settings: CloudMaskSettings, width = 512, height = 256) {
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height * 4)
    this.texture = new THREE.DataTexture(this.data, width, height, THREE.RGBAFormat)
    this.texture.name = 'shared-cloud-mask'
    this.texture.wrapS = THREE.RepeatWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    this.update(settings)
  }

  update(settings: CloudMaskSettings) {
    const key = [
      settings.seed,
      settings.coverage.toFixed(4),
      settings.scale.toFixed(4),
      settings.softness.toFixed(4),
      settings.storms.toFixed(4),
      settings.bands.toFixed(4),
      settings.detail.toFixed(4),
    ].join(':')
    if (key === this.settingsKey) return
    this.settingsKey = key

    for (let y = 0; y < this.height; y++) {
      const v = (y + 0.5) / this.height
      const lat = (0.5 - v) * Math.PI
      const sinLat = Math.sin(lat)
      const cosLat = Math.cos(lat)

      for (let x = 0; x < this.width; x++) {
        const u = (x + 0.5) / this.width
        const lon = (u - 0.5) * TAU
        const value = this.densityToMask(
          Math.sin(lon) * cosLat,
          sinLat,
          Math.cos(lon) * cosLat,
          settings,
        )
        const byte = Math.round(clamp(value, 0, 1) * 255)
        const index = (y * this.width + x) * 4
        this.data[index] = byte
        this.data[index + 1] = byte
        this.data[index + 2] = byte
        this.data[index + 3] = 255
      }
    }

    this.texture.needsUpdate = true
  }

  sampleDirection(dir: THREE.Vector3, offsetU = 0): number {
    const len = Math.max(dir.length(), 0.000001)
    const nx = dir.x / len
    const ny = clamp(dir.y / len, -1, 1)
    const nz = dir.z / len
    const u = fract(Math.atan2(nx, nz) / TAU + 0.5 + offsetU)
    const v = clamp(0.5 - Math.asin(ny) / Math.PI, 0, 1)
    return this.sampleUv(u, v)
  }

  dispose() {
    this.texture.dispose()
  }

  private sampleUv(u: number, v: number): number {
    const x = u * this.width - 0.5
    const y = v * this.height - 0.5
    const x0 = Math.floor(x)
    const y0 = clamp(Math.floor(y), 0, this.height - 1)
    const x1 = x0 + 1
    const y1 = clamp(y0 + 1, 0, this.height - 1)
    const tx = fract(x)
    const ty = clamp(y - y0, 0, 1)
    const a = this.samplePixel(x0, y0)
    const b = this.samplePixel(x1, y0)
    const c = this.samplePixel(x0, y1)
    const d = this.samplePixel(x1, y1)
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty)
  }

  private samplePixel(x: number, y: number): number {
    const wrappedX = ((x % this.width) + this.width) % this.width
    return this.data[(y * this.width + wrappedX) * 4] / 255
  }

  private densityToMask(x: number, y: number, z: number, settings: CloudMaskSettings): number {
    const density = this.cloudDensity(x, y, z, settings)
    const coverage = clamp(settings.coverage, 0, 1)
    const threshold = lerp(0.78, 0.24, coverage)
    const softness = Math.max(settings.softness, 0.015)
    const cloud = smoothstep(threshold, threshold + softness, density)
    const body = smoothstep(threshold + softness * 0.32, threshold + softness * 1.85, density)
    return clamp(cloud * lerp(0.82, 1.10, body), 0, 1)
  }

  private cloudDensity(x: number, y: number, z: number, settings: CloudMaskSettings): number {
    this.curvedDirection(x, y, z, settings, this.curved)
    const scale = Math.max(settings.scale, 0.001)
    const px = this.curved.x * scale
    const py = this.curved.y * scale
    const pz = this.curved.z * scale
    const stormStrength = clamp(settings.storms, 0, 1.5)
    const bandStrength = clamp(settings.bands, 0, 1.5)
    const detailStrength = clamp(settings.detail, 0, 1.5)
    const seed = settings.seed

    const macroRaw = fbm3(px * 0.42 + 31.0, py * 0.42 - 18.0, pz * 0.42 + 7.0, seed + 301.7, 3, 2.0, 0.54) * 0.5 + 0.5
    const broad = fbm3(px * 0.82 + 13.1, py * 0.82 - 7.2, pz * 0.82 + 4.8, seed + 503.7, 3, 2.05, 0.52) * 0.5 + 0.5
    const medium = fbm3(px * 1.86 - 5.4, py * 1.86 + 17.6, pz * 1.86 + 9.2, seed + 907.2, 2, 2.18, 0.48) * 0.5 + 0.5
    const fine = fbm3(px * 6.20 + 28.0, py * 6.20 + 3.7, pz * 6.20 - 11.5, seed + 1301.4, 2, 2.24, 0.44) * 0.5 + 0.5
    const frontNoise = fbm3(
      px * 0.36 + pz * 0.18,
      py * 2.20 + macroRaw * 1.20,
      pz * 0.42,
      seed + 1709.1,
      2,
      2.0,
      0.55,
    )
    const fronts = Math.pow(1 - clamp(Math.abs(frontNoise), 0, 1), 2.85)
    const stormCells = Math.pow(smoothstep(0.50, 0.92, macroRaw + medium * 0.18), 1.85)
    const brokenWisps = smoothstep(0.44, 0.84, fine + fronts * 0.24) * (1 - stormCells * 0.36)

    let systems = broad * 0.34 + medium * 0.18
    systems += stormCells * (0.26 * stormStrength)
    systems += fronts * (0.22 * bandStrength)
    systems += brokenWisps * (0.14 * detailStrength)
    return clamp(systems, 0, 1.25)
  }

  private curvedDirection(
    x: number,
    y: number,
    z: number,
    settings: CloudMaskSettings,
    target: THREE.Vector3,
  ) {
    const axisX = 0.18
    const axisY = 0.96
    const axisZ = 0.09
    this.tangent.set(
      axisY * z - axisZ * y,
      axisZ * x - axisX * z,
      axisX * y - axisY * x,
    )
    if (this.tangent.lengthSq() < 0.0001) {
      this.tangent.set(0, -z, y)
    }
    this.tangent.normalize()
    this.bitangent.set(
      y * this.tangent.z - z * this.tangent.y,
      z * this.tangent.x - x * this.tangent.z,
      x * this.tangent.y - y * this.tangent.x,
    ).normalize()

    const phase = settings.seed * 0.017
    const scale = Math.max(settings.scale, 0.001)
    const curlA = Math.sin((x * 2.13 + y * 0.71 - z * 1.42) * scale * 1.08 + phase)
    const curlB = Math.sin((-x * 1.17 + y * 1.86 + z * 2.37) * scale * 1.54 + phase * 1.7)
    const bandStrength = clamp(settings.bands, 0, 1.5)

    target.set(
      x + this.tangent.x * curlA * 0.15 * bandStrength + this.bitangent.x * curlB * 0.09 * bandStrength,
      y + this.tangent.y * curlA * 0.15 * bandStrength + this.bitangent.y * curlB * 0.09 * bandStrength,
      z + this.tangent.z * curlA * 0.15 * bandStrength + this.bitangent.z * curlB * 0.09 * bandStrength,
    ).normalize()
  }
}

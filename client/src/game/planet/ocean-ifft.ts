import * as THREE from 'three'

interface OceanIfftSpectrumParams {
  seed: number
  planetRadius: number
  terrainScale: number
  waterLevel: number
  waveHeight: number
  windSpeed: number
  detail: number
  choppiness: number
  foamStrength: number
}

const IFFT_SIZE = 256
const GRAVITY = 9.81
const TWO_PI = Math.PI * 2

function mulberry32(seed: number) {
  let value = seed >>> 0
  return () => {
    value += 0x6D2B79F5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(random: () => number) {
  const u = Math.max(random(), 1e-7)
  const v = Math.max(random(), 1e-7)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v)
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = THREE.MathUtils.clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

function clampHalf(value: number) {
  return THREE.DataUtils.toHalfFloat(THREE.MathUtils.clamp(value, -32, 32))
}

function inverseFft1D(real: Float32Array, imag: Float32Array, offset: number, stride: number, size: number) {
  let j = 0
  for (let i = 1; i < size; i++) {
    let bit = size >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const ia = offset + i * stride
      const ib = offset + j * stride
      const tr = real[ia]
      const ti = imag[ia]
      real[ia] = real[ib]
      imag[ia] = imag[ib]
      real[ib] = tr
      imag[ib] = ti
    }
  }

  for (let len = 2; len <= size; len <<= 1) {
    const angle = TWO_PI / len
    const wLenR = Math.cos(angle)
    const wLenI = Math.sin(angle)
    const half = len >> 1

    for (let i = 0; i < size; i += len) {
      let wr = 1
      let wi = 0
      for (let k = 0; k < half; k++) {
        const even = offset + (i + k) * stride
        const odd = offset + (i + k + half) * stride
        const oddR = real[odd] * wr - imag[odd] * wi
        const oddI = real[odd] * wi + imag[odd] * wr
        const evenR = real[even]
        const evenI = imag[even]

        real[even] = evenR + oddR
        imag[even] = evenI + oddI
        real[odd] = evenR - oddR
        imag[odd] = evenI - oddI

        const nextWr = wr * wLenR - wi * wLenI
        wi = wr * wLenI + wi * wLenR
        wr = nextWr
      }
    }
  }

  const inv = 1 / size
  for (let i = 0; i < size; i++) {
    const index = offset + i * stride
    real[index] *= inv
    imag[index] *= inv
  }
}

function inverseFft2D(real: Float32Array, imag: Float32Array, size: number) {
  for (let y = 0; y < size; y++) inverseFft1D(real, imag, y * size, 1, size)
  for (let x = 0; x < size; x++) inverseFft1D(real, imag, x, size, size)
}

export class OceanIfftSpectrum {
  readonly size = IFFT_SIZE
  readonly worldSize: number
  readonly heightScale: number
  readonly normalStrength: number
  readonly foamStrength: number
  readonly choppiness: number
  readonly texture: THREE.DataTexture

  private readonly h0R = new Float32Array(IFFT_SIZE * IFFT_SIZE)
  private readonly h0I = new Float32Array(IFFT_SIZE * IFFT_SIZE)
  private readonly omega = new Float32Array(IFFT_SIZE * IFFT_SIZE)
  private readonly spectrumR = new Float32Array(IFFT_SIZE * IFFT_SIZE)
  private readonly spectrumI = new Float32Array(IFFT_SIZE * IFFT_SIZE)
  private readonly height = new Float32Array(IFFT_SIZE * IFFT_SIZE)
  private readonly foam = new Float32Array(IFFT_SIZE * IFFT_SIZE)
  private readonly textureData = new Uint16Array(IFFT_SIZE * IFFT_SIZE * 4)
  private outputScale = 1
  private initialized = false

  constructor(params: OceanIfftSpectrumParams) {
    const terrainMeters = Math.max(params.terrainScale * params.planetRadius, 1)
    this.worldSize = THREE.MathUtils.clamp(params.planetRadius * 1.05, 360, 2400)
    this.heightScale = THREE.MathUtils.clamp(terrainMeters * 0.018 * params.waveHeight, 0.12, params.planetRadius * 0.012)
    this.choppiness = THREE.MathUtils.clamp(params.choppiness, 0, 2.5)
    this.normalStrength = THREE.MathUtils.clamp(this.heightScale * (1.15 + this.choppiness * 0.42), 1.2, 10)
    this.foamStrength = THREE.MathUtils.clamp(params.foamStrength, 0, 2)

    this.texture = new THREE.DataTexture(
      this.textureData,
      IFFT_SIZE,
      IFFT_SIZE,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    )
    this.texture.name = 'Ocean iFFT spectrum'
    this.texture.wrapS = THREE.RepeatWrapping
    this.texture.wrapT = THREE.RepeatWrapping
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false
    this.texture.colorSpace = THREE.NoColorSpace

    this.buildInitialSpectrum(params.seed, params.waterLevel, params.windSpeed, params.detail)
    this.update(0)
  }

  update(time: number) {
    const count = IFFT_SIZE * IFFT_SIZE
    for (let i = 0; i < count; i++) {
      const x = i % IFFT_SIZE
      const y = Math.floor(i / IFFT_SIZE)
      const opposite = ((IFFT_SIZE - y) & (IFFT_SIZE - 1)) * IFFT_SIZE + ((IFFT_SIZE - x) & (IFFT_SIZE - 1))
      const phase = this.omega[i] * time
      const c = Math.cos(phase)
      const s = Math.sin(phase)

      const h0r = this.h0R[i]
      const h0i = this.h0I[i]
      const h0OppR = this.h0R[opposite]
      const h0OppI = this.h0I[opposite]
      this.spectrumR[i] = h0r * c - h0i * s + h0OppR * c - h0OppI * s
      this.spectrumI[i] = h0r * s + h0i * c - h0OppI * c - h0OppR * s
    }

    inverseFft2D(this.spectrumR, this.spectrumI, IFFT_SIZE)
    this.writeTexture()
  }

  dispose() {
    this.texture.dispose()
  }

  private buildInitialSpectrum(seed: number, waterLevel: number, windSpeedParam: number, detailParam: number) {
    const random = mulberry32((seed ^ 0x9E3779B9) >>> 0)
    const windAngle = (seed % 8192) * 0.00076699039
    const windX = Math.cos(windAngle)
    const windY = Math.sin(windAngle)
    const windSpeed = THREE.MathUtils.clamp(windSpeedParam, 4, 60)
    const detail = THREE.MathUtils.clamp(detailParam, 0.35, 3)
    const largestWave = windSpeed * windSpeed / GRAVITY
    const dampingLength = this.worldSize / IFFT_SIZE * (0.48 / detail)
    const amplitude = THREE.MathUtils.lerp(0.00024, 0.00044, THREE.MathUtils.clamp(waterLevel, 0, 1))

    for (let y = 0; y < IFFT_SIZE; y++) {
      const ky = TWO_PI * (y < IFFT_SIZE / 2 ? y : y - IFFT_SIZE) / this.worldSize
      for (let x = 0; x < IFFT_SIZE; x++) {
        const index = y * IFFT_SIZE + x
        const kx = TWO_PI * (x < IFFT_SIZE / 2 ? x : x - IFFT_SIZE) / this.worldSize
        const kLen = Math.hypot(kx, ky)

        if (kLen < 1e-5) {
          this.h0R[index] = 0
          this.h0I[index] = 0
          this.omega[index] = 0
          continue
        }

        const kDotWind = (kx * windX + ky * windY) / kLen
        const harmonicIndex = kLen * this.worldSize / TWO_PI
        const shortWaveBoost = 1 + Math.max(detail - 1, 0)
          * 0.85
          * smoothstep(IFFT_SIZE * 0.025, IFFT_SIZE * 0.34, harmonicIndex)
        const direction = kDotWind < 0 ? 0.08 : 1
        const phillips = amplitude
          * Math.exp(-1 / Math.max(kLen * largestWave * kLen * largestWave, 1e-6))
          / Math.pow(kLen, 4)
          * kDotWind * kDotWind
          * direction
          * shortWaveBoost
          * Math.exp(-kLen * kLen * dampingLength * dampingLength)
        const spectralAmp = Math.sqrt(Math.max(phillips, 0) * 0.5)

        this.h0R[index] = gaussian(random) * spectralAmp
        this.h0I[index] = gaussian(random) * spectralAmp
        this.omega[index] = Math.sqrt(GRAVITY * kLen)
      }
    }
  }

  private writeTexture() {
    const count = IFFT_SIZE * IFFT_SIZE
    let sumSq = 0

    for (let i = 0; i < count; i++) sumSq += this.spectrumR[i] * this.spectrumR[i]
    const rms = Math.sqrt(sumSq / count)
    const targetScale = rms > 1e-7 ? 0.34 / rms : 1
    this.outputScale = this.initialized
      ? THREE.MathUtils.lerp(this.outputScale, targetScale, 0.04)
      : targetScale
    this.initialized = true

    for (let i = 0; i < count; i++) {
      this.height[i] = THREE.MathUtils.clamp(this.spectrumR[i] * this.outputScale, -2.4, 2.4)
    }

    for (let y = 0; y < IFFT_SIZE; y++) {
      const y0 = ((y - 1 + IFFT_SIZE) & (IFFT_SIZE - 1)) * IFFT_SIZE
      const y1 = ((y + 1) & (IFFT_SIZE - 1)) * IFFT_SIZE
      for (let x = 0; x < IFFT_SIZE; x++) {
        const index = y * IFFT_SIZE + x
        const x0 = (x - 1 + IFFT_SIZE) & (IFFT_SIZE - 1)
        const x1 = (x + 1) & (IFFT_SIZE - 1)
        const center = this.height[index]
        const gradX = (this.height[y * IFFT_SIZE + x1] - this.height[y * IFFT_SIZE + x0]) * 0.5
        const gradY = (this.height[y1 + x] - this.height[y0 + x]) * 0.5
        const curvature = Math.abs(this.height[y * IFFT_SIZE + x1]
          + this.height[y * IFFT_SIZE + x0]
          + this.height[y1 + x]
          + this.height[y0 + x]
          - center * 4)
        const slope = Math.hypot(gradX, gradY)
        const crest = Math.max(center - 0.32, 0)
        const breaking = slope * 0.68 + curvature * 1.15 + crest * 0.86
        const foamCandidate = smoothstep(0.38, 0.96, breaking)
        this.foam[index] = Math.max(this.foam[index] * 0.90, foamCandidate * foamCandidate)

        const out = index * 4
        this.textureData[out] = clampHalf(this.height[index])
        this.textureData[out + 1] = clampHalf(gradX)
        this.textureData[out + 2] = clampHalf(gradY)
        this.textureData[out + 3] = clampHalf(THREE.MathUtils.clamp(this.foam[index], 0, 1))
      }
    }

    this.texture.needsUpdate = true
  }
}

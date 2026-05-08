import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

interface OceanGpuIfftSpectrumParams {
  seed: number
  planetRadius: number
  terrainScale: number
  waterLevel: number
  // World-unit wave height scale. This is intentionally not planet-relative.
  waveHeight: number
  windSpeed: number
  detail: number
  choppiness: number
  foamStrength: number
  size?: number
  worldSize?: number
  waveHeightScale?: number
  normalStrengthScale?: number
  foamStrengthScale?: number
  minHarmonic?: number
  maxHarmonic?: number
}

interface OceanWaveSampleComponent {
  kx: number
  ky: number
  h0R: number
  h0I: number
  h0OppR: number
  h0OppI: number
  omega: number
  energy: number
}

const DEFAULT_GPU_IFFT_SIZE = 512
const GPU_HEIGHT_SAMPLE_COMPONENTS = 160
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

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const COMPLEX_GLSL = /* glsl */ `
vec2 complexMul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec4 texel(sampler2D map, vec2 coord, float size) {
  return texture2D(map, (mod(coord, size) + 0.5) / size);
}
`

export class OceanGpuIfftSpectrum {
  readonly size: number
  readonly bits: number
  readonly worldSize: number
  readonly heightScale: number
  readonly normalStrength: number
  readonly foamStrength: number
  readonly choppiness: number
  private readonly minHarmonic: number
  private readonly maxHarmonic: number

  private readonly renderer: THREE.WebGLRenderer
  private readonly quad: FullScreenQuad
  private readonly h0Texture: THREE.DataTexture
  private readonly spectrumTarget: THREE.WebGLRenderTarget
  private readonly pingTarget: THREE.WebGLRenderTarget
  private readonly pongTarget: THREE.WebGLRenderTarget
  private readonly outputTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private readonly evolveMaterial: THREE.ShaderMaterial
  private readonly butterflyMaterial: THREE.ShaderMaterial
  private readonly composeMaterial: THREE.ShaderMaterial
  private readonly sampleComponents: OceanWaveSampleComponent[]
  private readonly sampleScale: number
  private outputIndex = 0

  constructor(renderer: THREE.WebGLRenderer, params: OceanGpuIfftSpectrumParams) {
    this.renderer = renderer
    this.size = params.size ?? DEFAULT_GPU_IFFT_SIZE
    this.bits = Math.round(Math.log2(this.size))
    this.minHarmonic = params.minHarmonic ?? 0
    this.maxHarmonic = params.maxHarmonic ?? this.size * 0.48
    this.worldSize = params.worldSize ?? THREE.MathUtils.clamp(params.planetRadius * 1.05, 360, 2400)
    this.heightScale = Math.max(0, params.waveHeight * (params.waveHeightScale ?? 1))
    this.choppiness = THREE.MathUtils.clamp(params.choppiness, 0, 2.5)
    this.normalStrength = THREE.MathUtils.clamp(
      this.heightScale * (1.15 + this.choppiness * 0.42) * (params.normalStrengthScale ?? 1),
      0.45,
      12,
    )
    this.foamStrength = THREE.MathUtils.clamp(params.foamStrength * (params.foamStrengthScale ?? 1), 0, 2)

    const spectrum = this.buildInitialSpectrum(params.seed, params.waterLevel, params.windSpeed, params.detail)
    this.sampleComponents = spectrum.sampleComponents
    this.sampleScale = spectrum.sampleScale
    this.h0Texture = new THREE.DataTexture(
      spectrum.data,
      this.size,
      this.size,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    )
    this.h0Texture.name = 'Ocean GPU iFFT h0'
    this.h0Texture.wrapS = THREE.RepeatWrapping
    this.h0Texture.wrapT = THREE.RepeatWrapping
    this.h0Texture.minFilter = THREE.NearestFilter
    this.h0Texture.magFilter = THREE.NearestFilter
    this.h0Texture.generateMipmaps = false
    this.h0Texture.colorSpace = THREE.NoColorSpace
    this.h0Texture.needsUpdate = true

    this.spectrumTarget = this.createTarget('ocean-gpu-spectrum', THREE.NearestFilter)
    this.pingTarget = this.createTarget('ocean-gpu-ping', THREE.NearestFilter)
    this.pongTarget = this.createTarget('ocean-gpu-pong', THREE.NearestFilter)
    this.outputTargets = [
      this.createTarget('ocean-gpu-output-a', THREE.LinearFilter),
      this.createTarget('ocean-gpu-output-b', THREE.LinearFilter),
    ]

    this.evolveMaterial = this.createEvolveMaterial()
    this.butterflyMaterial = this.createButterflyMaterial()
    this.composeMaterial = this.createComposeMaterial(spectrum.outputScale)
    this.quad = new FullScreenQuad(this.evolveMaterial)
    this.clearOutputTargets()
    this.update(0)
  }

  static isSupported(renderer: THREE.WebGLRenderer, size = DEFAULT_GPU_IFFT_SIZE) {
    return renderer.capabilities.isWebGL2
      && renderer.capabilities.maxVertexTextures > 0
      && renderer.capabilities.maxTextureSize >= size
      && renderer.extensions.has('EXT_color_buffer_float')
  }

  get texture() {
    return this.outputTargets[this.outputIndex].texture
  }

  update(time: number) {
    const previousTarget = this.renderer.getRenderTarget()
    const previousAutoClear = this.renderer.autoClear

    try {
      this.renderer.autoClear = false
      this.renderEvolvedSpectrum(time)
      let source = this.spectrumTarget
      let target = this.pingTarget

      for (let stage = 1; stage <= this.bits; stage++) {
        this.renderButterfly(source.texture, target, stage, new THREE.Vector2(1, 0))
        const nextSource = target
        target = target === this.pingTarget ? this.pongTarget : this.pingTarget
        source = nextSource
      }

      target = source === this.pingTarget ? this.pongTarget : this.pingTarget
      for (let stage = 1; stage <= this.bits; stage++) {
        this.renderButterfly(source.texture, target, stage, new THREE.Vector2(0, 1))
        const nextSource = target
        target = target === this.pingTarget ? this.pongTarget : this.pingTarget
        source = nextSource
      }

      this.renderOutput(source.texture)
    } finally {
      this.renderer.autoClear = previousAutoClear
      this.renderer.setRenderTarget(previousTarget)
    }
  }

  dispose() {
    this.h0Texture.dispose()
    this.spectrumTarget.dispose()
    this.pingTarget.dispose()
    this.pongTarget.dispose()
    this.outputTargets[0].dispose()
    this.outputTargets[1].dispose()
    this.evolveMaterial.dispose()
    this.butterflyMaterial.dispose()
    this.composeMaterial.dispose()
    this.quad.dispose()
  }

  sampleHeightAtDirection(dir: THREE.Vector3, seaRadius: number, time: number): number {
    const length = Math.max(1e-6, Math.hypot(dir.x, dir.y, dir.z))
    const nx = dir.x / length
    const ny = dir.y / length
    const nz = dir.z / length
    const sx = nx * seaRadius
    const sy = ny * seaRadius
    const sz = nz * seaRadius
    const wx = Math.pow(Math.abs(nx), 5)
    const wy = Math.pow(Math.abs(ny), 5)
    const wz = Math.pow(Math.abs(nz), 5)
    const weightSum = Math.max(wx + wy + wz, 1e-6)
    const hx = this.sampleHeightAtMeters(sz, sy, time)
    const hy = this.sampleHeightAtMeters(sx, sz, time)
    const hz = this.sampleHeightAtMeters(sx, sy, time)
    return (hx * wx + hy * wy + hz * wz) / weightSum
  }

  private createTarget(name: string, filter: typeof THREE.NearestFilter | typeof THREE.LinearFilter) {
    const target = new THREE.WebGLRenderTarget(this.size, this.size, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: filter,
      magFilter: filter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    })
    target.texture.name = name
    target.texture.colorSpace = THREE.NoColorSpace
    return target
  }

  private buildInitialSpectrum(seed: number, waterLevel: number, windSpeedParam: number, detailParam: number) {
    const random = mulberry32((seed ^ 0x9E3779B9) >>> 0)
    const windAngle = (seed % 8192) * 0.00076699039
    const windX = Math.cos(windAngle)
    const windY = Math.sin(windAngle)
    const windSpeed = THREE.MathUtils.clamp(windSpeedParam, 4, 60)
    const detail = THREE.MathUtils.clamp(detailParam, 0.35, 3)
    const minHarmonic = Math.max(0, Math.min(this.size * 0.48, this.minHarmonic))
    const maxHarmonic = Math.max(minHarmonic + 1, Math.min(this.size * 0.48, this.maxHarmonic))
    const largestWave = windSpeed * windSpeed / GRAVITY
    const dampingLength = this.worldSize / this.size * (0.48 / detail)
    const amplitude = THREE.MathUtils.lerp(0.00024, 0.00044, THREE.MathUtils.clamp(waterLevel, 0, 1))
    const h0R = new Float32Array(this.size * this.size)
    const h0I = new Float32Array(this.size * this.size)
    const data = new Uint16Array(this.size * this.size * 4)

    for (let y = 0; y < this.size; y++) {
      const ky = TWO_PI * (y < this.size / 2 ? y : y - this.size) / this.worldSize
      for (let x = 0; x < this.size; x++) {
        const index = y * this.size + x
        const kx = TWO_PI * (x < this.size / 2 ? x : x - this.size) / this.worldSize
        const kLen = Math.hypot(kx, ky)

        if (kLen < 1e-5) continue

        const kDotWind = (kx * windX + ky * windY) / kLen
        const harmonicIndex = kLen * this.worldSize / TWO_PI
        const highPass = minHarmonic > 0
          ? smoothstep(minHarmonic * 0.72, minHarmonic, harmonicIndex)
          : 1
        const lowPass = 1 - smoothstep(maxHarmonic * 0.86, maxHarmonic, harmonicIndex)
        const bandPass = highPass * lowPass
        if (bandPass <= 0.0001) continue
        const shortWaveBoost = 1 + Math.max(detail - 1, 0)
          * 0.85
          * smoothstep(this.size * 0.025, this.size * 0.34, harmonicIndex)
        const direction = kDotWind < 0 ? 0.08 : 1
        const phillips = amplitude
          * Math.exp(-1 / Math.max(kLen * largestWave * kLen * largestWave, 1e-6))
          / Math.pow(kLen, 4)
          * kDotWind * kDotWind
          * direction
          * bandPass
          * shortWaveBoost
          * Math.exp(-kLen * kLen * dampingLength * dampingLength)
        const spectralAmp = Math.sqrt(Math.max(phillips, 0) * 0.5)

        h0R[index] = gaussian(random) * spectralAmp
        h0I[index] = gaussian(random) * spectralAmp
      }
    }

    let sumSpectrumSq = 0
    const sampleComponents: OceanWaveSampleComponent[] = []
    for (let y = 0; y < this.size; y++) {
      const oppositeY = (this.size - y) & (this.size - 1)
      for (let x = 0; x < this.size; x++) {
        const index = y * this.size + x
        const opposite = oppositeY * this.size + ((this.size - x) & (this.size - 1))
        const real = h0R[index] + h0R[opposite]
        const imag = h0I[index] - h0I[opposite]
        const energy = real * real + imag * imag
        sumSpectrumSq += energy
        if (energy > 1e-14) {
          const kx = TWO_PI * (x < this.size / 2 ? x : x - this.size) / this.worldSize
          const ky = TWO_PI * (y < this.size / 2 ? y : y - this.size) / this.worldSize
          const kLen = Math.hypot(kx, ky)
          const component = {
            kx,
            ky,
            h0R: h0R[index],
            h0I: h0I[index],
            h0OppR: h0R[opposite],
            h0OppI: h0I[opposite],
            omega: Math.sqrt(GRAVITY * kLen),
            energy,
          }
          this.insertHeightSampleComponent(sampleComponents, component)
        }

        const out = index * 4
        data[out] = clampHalf(h0R[index])
        data[out + 1] = clampHalf(h0I[index])
        data[out + 2] = 0
        data[out + 3] = 0
      }
    }

    const invSizeSq = 1 / (this.size * this.size)
    const spatialRms = Math.sqrt(sumSpectrumSq) * invSizeSq
    const outputScale = spatialRms > 1e-7 ? 0.34 / spatialRms : 1
    const sampleScale = outputScale * invSizeSq
    return { data, outputScale, sampleComponents, sampleScale }
  }

  private insertHeightSampleComponent(
    components: OceanWaveSampleComponent[],
    component: OceanWaveSampleComponent,
  ): number {
    if (components.length < GPU_HEIGHT_SAMPLE_COMPONENTS) {
      components.push(component)
      return 0
    }

    let minIndex = 0
    let minEnergy = components[0].energy
    for (let i = 1; i < components.length; i++) {
      if (components[i].energy < minEnergy) {
        minEnergy = components[i].energy
        minIndex = i
      }
    }

    if (component.energy <= minEnergy) return component.energy
    components[minIndex] = component
    return minEnergy
  }

  private sampleHeightAtMeters(xMeters: number, yMeters: number, time: number): number {
    let height = 0
    for (const component of this.sampleComponents) {
      const phase = component.omega * time
      const cosPhase = Math.cos(phase)
      const sinPhase = Math.sin(phase)
      const spectralR = (component.h0R + component.h0OppR) * cosPhase
        - (component.h0I + component.h0OppI) * sinPhase
      const spectralI = (component.h0R - component.h0OppR) * sinPhase
        + (component.h0I - component.h0OppI) * cosPhase
      const spatialPhase = component.kx * xMeters + component.ky * yMeters
      height += spectralR * Math.cos(spatialPhase) - spectralI * Math.sin(spatialPhase)
    }

    return THREE.MathUtils.clamp(height * this.sampleScale, -2.4, 2.4)
  }

  private createEvolveMaterial() {
    const bits = this.bits
    const size = this.size
    return new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uH0Map: { value: this.h0Texture },
        uTime: { value: 0 },
        uSize: { value: size },
        uWorldSize: { value: this.worldSize },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${COMPLEX_GLSL}

        uniform sampler2D uH0Map;
        uniform float uTime;
        uniform float uSize;
        uniform float uWorldSize;
        varying vec2 vUv;

        float bitReverse(float value) {
          float result = 0.0;
          float current = value;
          for (int i = 0; i < ${bits}; i++) {
            result = result * 2.0 + mod(current, 2.0);
            current = floor(current * 0.5);
          }
          return result;
        }

        void main() {
          vec2 outCoord = floor(vUv * uSize);
          vec2 kCoord = vec2(bitReverse(outCoord.x), bitReverse(outCoord.y));
          vec2 oppositeCoord = mod(uSize - kCoord, uSize);
          vec2 signedK = vec2(
            kCoord.x < uSize * 0.5 ? kCoord.x : kCoord.x - uSize,
            kCoord.y < uSize * 0.5 ? kCoord.y : kCoord.y - uSize
          );
          float kLen = length(signedK * ${TWO_PI.toFixed(12)} / uWorldSize);

          if (kLen < 0.00001) {
            gl_FragColor = vec4(0.0);
            return;
          }

          vec4 h0 = texel(uH0Map, kCoord, uSize);
          vec4 h0Opp = texel(uH0Map, oppositeCoord, uSize);
          float phase = sqrt(${GRAVITY.toFixed(4)} * kLen) * uTime;
          vec2 rot = vec2(cos(phase), sin(phase));
          vec2 h = complexMul(h0.rg, rot) + complexMul(vec2(h0Opp.r, -h0Opp.g), vec2(rot.x, -rot.y));
          gl_FragColor = vec4(h, 0.0, 1.0);
        }
      `,
    })
  }

  private createButterflyMaterial() {
    const size = this.size
    return new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uInput: { value: null },
        uSize: { value: size },
        uStage: { value: 1 },
        uDirection: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${COMPLEX_GLSL}

        uniform sampler2D uInput;
        uniform float uSize;
        uniform float uStage;
        uniform vec2 uDirection;
        varying vec2 vUv;

        void main() {
          vec2 coord = floor(vUv * uSize);
          float axisIndex = dot(coord, uDirection);
          float len = exp2(uStage);
          float halfLen = len * 0.5;
          float groupStart = floor(axisIndex / len) * len;
          float localIndex = axisIndex - groupStart;
          float pairIndex = mod(localIndex, halfLen);
          float signValue = localIndex < halfLen ? 1.0 : -1.0;
          float indexA = groupStart + pairIndex;
          float indexB = indexA + halfLen;

          vec2 coordA = coord;
          vec2 coordB = coord;
          if (uDirection.x > 0.5) {
            coordA.x = indexA;
            coordB.x = indexB;
          } else {
            coordA.y = indexA;
            coordB.y = indexB;
          }

          float angle = ${TWO_PI.toFixed(12)} * pairIndex / len;
          vec2 twiddle = vec2(cos(angle), sin(angle));
          vec2 a = texel(uInput, coordA, uSize).rg;
          vec2 b = complexMul(texel(uInput, coordB, uSize).rg, twiddle);
          gl_FragColor = vec4(a + b * signValue, 0.0, 1.0);
        }
      `,
    })
  }

  private createComposeMaterial(outputScale: number) {
    const size = this.size
    return new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSpatialMap: { value: null },
        uPreviousMap: { value: this.outputTargets[0].texture },
        uSize: { value: size },
        uOutputScale: { value: outputScale },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        ${COMPLEX_GLSL}

        uniform sampler2D uSpatialMap;
        uniform sampler2D uPreviousMap;
        uniform float uSize;
        uniform float uOutputScale;
        varying vec2 vUv;

        float sampleHeight(vec2 coord) {
          return texel(uSpatialMap, coord, uSize).r / (uSize * uSize) * uOutputScale;
        }

        float oceanSmoothstep(float edge0, float edge1, float value) {
          float t = clamp((value - edge0) / max(edge1 - edge0, 0.000001), 0.0, 1.0);
          return t * t * (3.0 - 2.0 * t);
        }

        void main() {
          vec2 coord = floor(vUv * uSize);
          float center = sampleHeight(coord);
          float left = sampleHeight(coord + vec2(-1.0, 0.0));
          float right = sampleHeight(coord + vec2(1.0, 0.0));
          float down = sampleHeight(coord + vec2(0.0, -1.0));
          float up = sampleHeight(coord + vec2(0.0, 1.0));
          float gradX = (right - left) * 0.5;
          float gradY = (up - down) * 0.5;
          float curvature = abs(left + right + down + up - center * 4.0);
          float slope = length(vec2(gradX, gradY));
          float crest = max(center - 0.32, 0.0);
          float breaking = slope * 0.68 + curvature * 1.15 + crest * 0.86;
          float foamCandidate = oceanSmoothstep(0.38, 0.96, breaking);
          float previousFoam = texture2D(uPreviousMap, vUv).a;
          float foam = max(previousFoam * 0.90, foamCandidate * foamCandidate);
          gl_FragColor = vec4(clamp(center, -2.4, 2.4), gradX, gradY, clamp(foam, 0.0, 1.0));
        }
      `,
    })
  }

  private clearOutputTargets() {
    const previousTarget = this.renderer.getRenderTarget()
    const previousClearAlpha = this.renderer.getClearAlpha()
    const previousClearColor = new THREE.Color()
    this.renderer.getClearColor(previousClearColor)

    try {
      this.renderer.setClearColor(0x000000, 0)
      for (const target of this.outputTargets) {
        this.renderer.setRenderTarget(target)
        this.renderer.clear(true, false, false)
      }
    } finally {
      this.renderer.setClearColor(previousClearColor, previousClearAlpha)
      this.renderer.setRenderTarget(previousTarget)
    }
  }

  private renderEvolvedSpectrum(time: number) {
    this.evolveMaterial.uniforms.uTime.value = time
    this.quad.material = this.evolveMaterial
    this.renderer.setRenderTarget(this.spectrumTarget)
    this.quad.render(this.renderer)
  }

  private renderButterfly(
    input: THREE.Texture,
    target: THREE.WebGLRenderTarget,
    stage: number,
    direction: THREE.Vector2,
  ) {
    this.butterflyMaterial.uniforms.uInput.value = input
    this.butterflyMaterial.uniforms.uStage.value = stage
    this.butterflyMaterial.uniforms.uDirection.value.copy(direction)
    this.quad.material = this.butterflyMaterial
    this.renderer.setRenderTarget(target)
    this.quad.render(this.renderer)
  }

  private renderOutput(spatialTexture: THREE.Texture) {
    const previousIndex = this.outputIndex
    const nextIndex = 1 - this.outputIndex
    this.composeMaterial.uniforms.uSpatialMap.value = spatialTexture
    this.composeMaterial.uniforms.uPreviousMap.value = this.outputTargets[previousIndex].texture
    this.quad.material = this.composeMaterial
    this.renderer.setRenderTarget(this.outputTargets[nextIndex])
    this.quad.render(this.renderer)
    this.outputIndex = nextIndex
  }
}

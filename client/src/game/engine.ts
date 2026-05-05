import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { createSkybox } from './skybox'
import { WORLD_SCALE } from './world-scale'

const UNDERWATER_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uDepth: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uWaterColor: { value: new THREE.Color(0x123d55) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uDepth;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform vec3 uWaterColor;

    varying vec2 vUv;

    void main() {
      float amount = clamp(uAmount, 0.0, 1.0);
      float depth = clamp(uDepth, 0.0, 1.0);
      vec2 texel = 1.0 / max(uResolution, vec2(1.0));
      vec2 wave = vec2(
        sin((vUv.y + uTime * 0.035) * 38.0),
        cos((vUv.x - uTime * 0.026) * 31.0)
      ) * texel * (2.0 + depth * 5.0) * amount;

      vec4 base = texture2D(tDiffuse, vUv + wave);
      vec3 blur = base.rgb;
      float blurRadius = (1.5 + depth * 5.5) * amount;
      blur += texture2D(tDiffuse, vUv + vec2(texel.x, 0.0) * blurRadius).rgb;
      blur += texture2D(tDiffuse, vUv - vec2(texel.x, 0.0) * blurRadius).rgb;
      blur += texture2D(tDiffuse, vUv + vec2(0.0, texel.y) * blurRadius).rgb;
      blur += texture2D(tDiffuse, vUv - vec2(0.0, texel.y) * blurRadius).rgb;
      blur *= 0.2;

      vec3 color = mix(base.rgb, blur, amount * (0.46 + depth * 0.34));
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(color, vec3(luminance), amount * (0.14 + depth * 0.20));

      vec3 waterTint = mix(clamp(uWaterColor, vec3(0.0), vec3(1.0)), vec3(0.010, 0.070, 0.100), 0.46);
      float murk = amount * (0.52 + depth * 0.40);
      color = mix(color, waterTint, murk);

      float vignette = smoothstep(0.18, 0.82, length(vUv - 0.5));
      color *= 1.0 - amount * (0.16 + depth * 0.18 + vignette * 0.22);

      float caustic = sin((vUv.x + vUv.y) * 84.0 + uTime * 1.35)
        * sin((vUv.x - vUv.y) * 63.0 - uTime * 1.10);
      caustic = smoothstep(0.56, 0.94, caustic * 0.5 + 0.5);
      color += waterTint * caustic * amount * (1.0 - depth * 0.72) * 0.038;

      gl_FragColor = vec4(color, base.a);
    }
  `,
}

export class GameEngine {
  readonly scene: THREE.Scene
  readonly renderer: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private composer: EffectComposer
  private animationId: number | null = null
  private container: HTMLElement
  private boundResize: () => void
  private skybox: THREE.Mesh
  private clock = new THREE.Clock()
  private pixelRatioLimit = Math.min(window.devicePixelRatio, 2)
  private sunLight: THREE.PointLight | null = null
  private bloomPass: UnrealBloomPass | null = null
  private underwaterPass: ShaderPass | null = null
  private outputPass: OutputPass | null = null

  constructor(container: HTMLElement) {
    this.container = container
    const width = container.clientWidth
    const height = container.clientHeight

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
    this.renderer.setSize(width, height)
    this.renderer.setPixelRatio(this.pixelRatioLimit)
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.toneMappingExposure = 1
    container.appendChild(this.renderer.domElement)

    // Scene
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x000000)
    this.skybox = createSkybox()
    this.scene.add(this.skybox)

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, width / height, WORLD_SCALE.cameraNear, WORLD_SCALE.cameraFar)
    this.camera.position.set(...WORLD_SCALE.initialCameraPosition)
    this.camera.lookAt(0, 0, 0)

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = WORLD_SCALE.orbitMinDistance
    this.controls.maxDistance = WORLD_SCALE.orbitMaxDistance

    // Bloom
    this.composer = new EffectComposer(this.renderer)
    this.composer.setPixelRatio(this.pixelRatioLimit)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      1.5,
      0.4,
      0.85,
    )
    bloomPass.threshold = 0.7
    bloomPass.strength = 1
    bloomPass.radius = 0.5
    this.composer.addPass(bloomPass)
    this.bloomPass = bloomPass
    const underwaterPass = new ShaderPass(UNDERWATER_SHADER)
    underwaterPass.enabled = false
    underwaterPass.uniforms.uResolution.value.set(width * this.pixelRatioLimit, height * this.pixelRatioLimit)
    this.composer.addPass(underwaterPass)
    this.underwaterPass = underwaterPass
    const outputPass = new OutputPass()
    this.composer.addPass(outputPass)
    this.outputPass = outputPass

    this.setupLights()

    this.boundResize = this.handleResize.bind(this)
    window.addEventListener('resize', this.boundResize)
  }

  private setupLights() {
    this.scene.add(new THREE.AmbientLight(0x111122, 0.15))
    const sunLight = new THREE.PointLight(0xffcc66, 200, 0, 1.3)
    sunLight.position.set(0, 0, 0)
    this.scene.add(sunLight)
    this.sunLight = sunLight
  }

  setSunPosition(position: THREE.Vector3) {
    this.sunLight?.position.copy(position)
  }

  setSunColor(color: string) {
    this.sunLight?.color.set(color)
  }

  setBloomEnabled(enabled: boolean) {
    if (this.bloomPass) this.bloomPass.enabled = enabled
  }

  setBloomSettings(settings: { strength: number; radius: number; threshold: number }) {
    if (!this.bloomPass) return
    this.bloomPass.strength = settings.strength
    this.bloomPass.radius = settings.radius
    this.bloomPass.threshold = settings.threshold

    const bloomPass = this.bloomPass as UnrealBloomPass & {
      highPassUniforms?: Record<string, { value: number }>
      compositeMaterial?: {
        uniforms?: Record<string, { value: number }>
      }
    }
    if (bloomPass.highPassUniforms?.luminosityThreshold) {
      bloomPass.highPassUniforms.luminosityThreshold.value = settings.threshold
    }
    if (bloomPass.compositeMaterial?.uniforms?.bloomStrength) {
      bloomPass.compositeMaterial.uniforms.bloomStrength.value = settings.strength
    }
    if (bloomPass.compositeMaterial?.uniforms?.bloomRadius) {
      bloomPass.compositeMaterial.uniforms.bloomRadius.value = settings.radius
    }
  }

  setToneMappingExposure(exposure: number) {
    this.renderer.toneMappingExposure = exposure
  }

  setUnderwaterEffect(settings: { amount: number; depth: number; color: THREE.Color } | null) {
    if (!this.underwaterPass) return
    const amount = THREE.MathUtils.clamp(settings?.amount ?? 0, 0, 1)
    this.underwaterPass.enabled = amount > 0.001
    this.underwaterPass.uniforms.uAmount.value = amount
    this.underwaterPass.uniforms.uDepth.value = THREE.MathUtils.clamp(settings?.depth ?? 0, 0, 1)
    if (settings) this.underwaterPass.uniforms.uWaterColor.value.copy(settings.color)
  }

  getToneMappingExposure(): number {
    return this.renderer.toneMappingExposure
  }

  getToneMappingName(): string {
    switch (this.renderer.toneMapping) {
      case THREE.NoToneMapping:
        return 'none'
      case THREE.LinearToneMapping:
        return 'linear'
      case THREE.ReinhardToneMapping:
        return 'reinhard'
      case THREE.CineonToneMapping:
        return 'cineon'
      case THREE.ACESFilmicToneMapping:
        return 'aces'
      case THREE.AgXToneMapping:
        return 'agx'
      case THREE.NeutralToneMapping:
        return 'neutral'
      default:
        return 'custom'
    }
  }

  getBloomSettings() {
    return this.bloomPass
      ? {
          enabled: this.bloomPass.enabled,
          strength: this.bloomPass.strength,
          radius: this.bloomPass.radius,
          threshold: this.bloomPass.threshold,
        }
      : null
  }

  getDeltaTime(): number {
    return this.clock.getDelta()
  }

  setOrbitControlsEnabled(enabled: boolean) {
    this.controls.enabled = enabled
    if (enabled) this.resetOrbitControls()
  }

  setOrbitBounds(min: number, max: number) {
    this.controls.minDistance = min
    this.controls.maxDistance = max
  }

  resetOrbitControls() {
    this.camera.up.set(0, 1, 0)
    this.controls.target.copy(this.camera.position).add(
      new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion),
    )
    this.controls.update()
  }

  setPixelRatioLimit(limit: number) {
    this.pixelRatioLimit = Math.min(window.devicePixelRatio, limit)
    this.renderer.setPixelRatio(this.pixelRatioLimit)
    this.composer.setPixelRatio(this.pixelRatioLimit)
    this.handleResize()
  }

  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  private handleResize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.underwaterPass?.uniforms.uResolution.value.set(w * this.pixelRatioLimit, h * this.pixelRatioLimit)
  }

  start(onFrame?: (dt: number) => void) {
    this.clock.start()
    const loop = () => {
      this.animationId = requestAnimationFrame(loop)
      const dt = this.clock.getDelta()
      this.controls.update()
      onFrame?.(dt)
      if (this.underwaterPass?.enabled) this.underwaterPass.uniforms.uTime.value += dt
      this.composer.render()
    }
    loop()
  }

  stop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }
  }

  dispose() {
    this.stop()
    window.removeEventListener('resize', this.boundResize)
    this.controls.dispose()
    this.outputPass?.dispose()
    this.underwaterPass?.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.container.removeChild(this.renderer.domElement)
  }
}

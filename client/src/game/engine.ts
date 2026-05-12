import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { createSkybox } from './skybox'
import { WORLD_SCALE } from './world-scale'
import { CLOUD_RENDER_LAYER } from './render-layers'

const CLOUD_RENDER_SCALE = 0.5
const CLOUD_OBJECT_REFRESH_INTERVAL = 30

function createDepthTexture(width: number, height: number, name: string): THREE.DepthTexture {
  const texture = new THREE.DepthTexture(width, height)
  texture.name = name
  texture.format = THREE.DepthFormat
  texture.type = THREE.UnsignedIntType
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  return texture
}

function createComposerRenderTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  })
  target.texture.name = 'EffectComposer.rt1'
  target.depthTexture = createDepthTexture(width, height, 'main-scene-depth')
  return target
}

export interface UnderwaterFilterSettings {
  enabled: boolean
  tint: string
  strength: number
  distortion: number
  murk: number
}

class CloudCompositePass extends Pass {
  private scene: THREE.Scene
  private camera: THREE.Camera
  private cloudTarget: THREE.WebGLRenderTarget
  private cloudDepthTarget: THREE.WebGLRenderTarget
  private material: THREE.ShaderMaterial
  private fsQuad: FullScreenQuad
  private clearColor = new THREE.Color()
  private cloudRenderObjects: THREE.Object3D[] = []
  private cloudObjectRefreshFrame = CLOUD_OBJECT_REFRESH_INTERVAL
  private depthOnlyMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
  })

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super()
    this.scene = scene
    this.camera = camera
    this.needsSwap = true
    this.cloudTarget = this.createCloudTarget(1, 1)
    this.cloudDepthTarget = this.createDepthTarget(1, 1, 'cloud-depth')
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tClouds: { value: this.cloudTarget.texture },
        tCloudDepth: { value: this.cloudDepthTarget.depthTexture },
        tSceneDepth: { value: null },
        uCloudEnabled: { value: 1 },
        uDepthBias: { value: 0.000002 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tClouds;
        uniform sampler2D tCloudDepth;
        uniform sampler2D tSceneDepth;
        uniform float uCloudEnabled;
        uniform float uDepthBias;
        varying vec2 vUv;

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec4 clouds = texture2D(tClouds, vUv);
          float sceneDepth = texture2D(tSceneDepth, vUv).x;
          float cloudDepth = texture2D(tCloudDepth, vUv).x;
          float hasSceneDepth = 1.0 - step(0.9999, sceneDepth);
          float cloudBehindScene = step(sceneDepth - uDepthBias, cloudDepth) * hasSceneDepth;
          clouds.a *= 1.0 - cloudBehindScene;
          clouds.a *= uCloudEnabled;
          gl_FragColor = vec4(mix(base.rgb, clouds.rgb, clouds.a), max(base.a, clouds.a));
        }
      `,
    })
    this.fsQuad = new FullScreenQuad(this.material)
  }

  private createCloudTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    })
    target.texture.name = 'cloud-half-res'
    target.depthTexture = createDepthTexture(width, height, 'cloud-half-res-depth')
    return target
  }

  private createDepthTarget(width: number, height: number, name: string): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    })
    target.texture.name = name
    target.depthTexture = createDepthTexture(width, height, `${name}-texture`)
    return target
  }

  setSize(width: number, height: number) {
    const targetWidth = Math.max(1, Math.floor(width * CLOUD_RENDER_SCALE))
    const targetHeight = Math.max(1, Math.floor(height * CLOUD_RENDER_SCALE))
    this.cloudTarget.setSize(targetWidth, targetHeight)
    this.cloudDepthTarget.setSize(targetWidth, targetHeight)
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const hasClouds = this.hasVisibleClouds()
    this.needsSwap = hasClouds
    if (!hasClouds) return

    this.renderClouds(renderer)

    this.material.uniforms.tDiffuse.value = readBuffer.texture
    this.material.uniforms.tClouds.value = this.cloudTarget.texture
    this.material.uniforms.tCloudDepth.value = this.cloudDepthTarget.depthTexture
    this.material.uniforms.tSceneDepth.value = readBuffer.depthTexture
    this.material.uniforms.uCloudEnabled.value = hasClouds ? 1 : 0
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    this.fsQuad.render(renderer)
  }

  private hasVisibleClouds(): boolean {
    const cloudLayerMask = 1 << CLOUD_RENDER_LAYER

    if (
      this.cloudObjectRefreshFrame >= CLOUD_OBJECT_REFRESH_INTERVAL ||
      this.cloudRenderObjects.some(object => !object.parent || (object.layers.mask & cloudLayerMask) === 0)
    ) {
      this.refreshCloudRenderObjects(cloudLayerMask)
    } else {
      this.cloudObjectRefreshFrame++
    }

    return this.cloudRenderObjects.some(object => this.isVisibleInHierarchy(object))
  }

  private refreshCloudRenderObjects(cloudLayerMask: number) {
    this.cloudObjectRefreshFrame = 0
    this.cloudRenderObjects.length = 0
    this.scene.traverse(object => {
      if ((object.layers.mask & cloudLayerMask) !== 0) this.cloudRenderObjects.push(object)
    })
  }

  private isVisibleInHierarchy(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object
    while (current) {
      if (!current.visible) return false
      current = current.parent
    }
    return true
  }

  private renderClouds(renderer: THREE.WebGLRenderer) {
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    const previousBackground = this.scene.background
    const previousOverrideMaterial = this.scene.overrideMaterial
    const previousCameraMask = this.camera.layers.mask
    const previousClearAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.clearColor)

    try {
      this.scene.background = null
      renderer.setRenderTarget(this.cloudTarget)
      renderer.setClearColor(0x000000, 0)

      this.scene.overrideMaterial = this.depthOnlyMaterial

      this.camera.layers.set(CLOUD_RENDER_LAYER)
      renderer.setRenderTarget(this.cloudDepthTarget)
      renderer.clear(true, true, true)
      renderer.render(this.scene, this.camera)
      this.scene.overrideMaterial = previousOverrideMaterial

      renderer.autoClear = false
      renderer.setRenderTarget(this.cloudTarget)
      renderer.clear(true, true, true)
      renderer.render(this.scene, this.camera)
    } finally {
      this.scene.overrideMaterial = previousOverrideMaterial
      renderer.autoClear = previousAutoClear
      this.camera.layers.mask = previousCameraMask
      this.scene.background = previousBackground
      renderer.setClearColor(this.clearColor, previousClearAlpha)
      renderer.setRenderTarget(previousTarget)
    }
  }

  dispose() {
    this.cloudTarget.dispose()
    this.cloudDepthTarget.dispose()
    this.material.dispose()
    this.depthOnlyMaterial.dispose()
    this.fsQuad.dispose()
  }
}

class UnderwaterPass extends Pass {
  private material: THREE.ShaderMaterial
  private fsQuad: FullScreenQuad
  private settings: UnderwaterFilterSettings = {
    enabled: true,
    tint: '#1b8f9d',
    strength: 0.72,
    distortion: 0.75,
    murk: 0.34,
  }

  constructor() {
    super()
    this.enabled = false
    this.needsSwap = true
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        uStrength: { value: 0 },
        uDepth: { value: 0 },
        uTime: { value: 0 },
        uTexelSize: { value: new THREE.Vector2(1, 1) },
        uTintColor: { value: new THREE.Color(this.settings.tint) },
        uDistortion: { value: this.settings.distortion },
        uMurk: { value: this.settings.murk },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uTexelSize;
        uniform vec3 uTintColor;
        uniform float uStrength;
        uniform float uDepth;
        uniform float uTime;
        uniform float uDistortion;
        uniform float uMurk;
        varying vec2 vUv;

        float underwaterHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float underwaterCaustic(vec2 uv, float time) {
          float a = sin((uv.x * 22.0 + uv.y * 13.0) + time * 1.15);
          float b = sin((uv.x * -18.0 + uv.y * 25.0) - time * 0.82);
          float c = sin((uv.x * 41.0 - uv.y * 17.0) + time * 0.48);
          return smoothstep(1.54, 2.46, a + b + c);
        }

        void main() {
          float strength = clamp(uStrength, 0.0, 1.0);
          float depth01 = clamp(uDepth / 38.0, 0.0, 1.0);
          vec2 centered = vUv - vec2(0.5);
          float shimmerA = sin(vUv.y * 84.0 + uTime * 1.55 + sin(vUv.x * 17.0 + uTime * 0.7));
          float shimmerB = sin(vUv.x * 52.0 - uTime * 1.22 + sin(vUv.y * 23.0 - uTime * 0.43));
          vec2 distortion = vec2(shimmerA * 0.86 + shimmerB * 0.32, shimmerB * 0.58 - shimmerA * 0.20);
          distortion *= uTexelSize * (2.4 + depth01 * 4.2) * uDistortion * strength;

          vec2 sampleUv = clamp(vUv + distortion, vec2(0.001), vec2(0.999));
          vec4 base = texture2D(tDiffuse, sampleUv);
          vec3 blur = base.rgb;
          blur += texture2D(tDiffuse, clamp(sampleUv + vec2(1.2, 0.0) * uTexelSize, vec2(0.001), vec2(0.999))).rgb;
          blur += texture2D(tDiffuse, clamp(sampleUv + vec2(-1.2, 0.0) * uTexelSize, vec2(0.001), vec2(0.999))).rgb;
          blur += texture2D(tDiffuse, clamp(sampleUv + vec2(0.0, 1.2) * uTexelSize, vec2(0.001), vec2(0.999))).rgb;
          blur += texture2D(tDiffuse, clamp(sampleUv + vec2(0.0, -1.2) * uTexelSize, vec2(0.001), vec2(0.999))).rgb;
          blur *= 0.2;

          float murk = clamp(uMurk, 0.0, 1.0);
          vec3 color = mix(base.rgb, blur, strength * murk * (0.18 + depth01 * 0.24));
          color.r *= 1.0 - strength * (0.20 + depth01 * 0.34);
          color.g *= 1.0 - strength * (0.035 + depth01 * 0.10);
          color.b *= 1.0 + strength * (0.035 - depth01 * 0.04);

          vec3 deepTint = mix(uTintColor, vec3(0.010, 0.105, 0.145), depth01 * 0.82);
          float fog = strength * (0.24 + murk * 0.26 + depth01 * 0.28);
          color = mix(color, deepTint, clamp(fog, 0.0, 0.72));

          float causticTop = 1.0 - smoothstep(0.10, 0.84, depth01);
          float caustic = underwaterCaustic(vUv + distortion * 35.0, uTime);
          color += uTintColor * caustic * causticTop * strength * 0.035;

          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(vec3(luma), color, 1.0 - strength * (0.08 + depth01 * 0.18));

          float vignette = smoothstep(0.34, 0.86, length(centered));
          color *= 1.0 - vignette * strength * (0.12 + murk * 0.14);
          float grain = underwaterHash(gl_FragCoord.xy + floor(uTime * 24.0));
          color += (grain - 0.5) * strength * murk * 0.016;

          gl_FragColor = vec4(max(color, vec3(0.0)), base.a);
        }
      `,
    })
    this.fsQuad = new FullScreenQuad(this.material)
  }

  setSettings(settings: UnderwaterFilterSettings) {
    this.settings = settings
    this.material.uniforms.uTintColor.value.set(settings.tint)
    this.material.uniforms.uDistortion.value = settings.distortion
    this.material.uniforms.uMurk.value = settings.murk
    if (!settings.enabled) this.setState(0, 0)
  }

  setState(factor: number, depth: number) {
    const strength = this.settings.enabled
      ? THREE.MathUtils.clamp(factor, 0, 1) * THREE.MathUtils.clamp(this.settings.strength, 0, 1.5)
      : 0
    this.enabled = strength > 0.001
    this.material.uniforms.uStrength.value = strength
    this.material.uniforms.uDepth.value = Math.max(0, depth)
  }

  setTime(time: number) {
    this.material.uniforms.uTime.value = time
  }

  setSize(width: number, height: number) {
    this.material.uniforms.uTexelSize.value.set(1 / Math.max(1, width), 1 / Math.max(1, height))
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    this.fsQuad.render(renderer)
  }

  dispose() {
    this.material.dispose()
    this.fsQuad.dispose()
  }
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
  private outputPass: OutputPass | null = null
  private cloudPass: CloudCompositePass | null = null
  private underwaterPass: UnderwaterPass | null = null
  private elapsedTime = 0

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
    this.composer = new EffectComposer(this.renderer, createComposerRenderTarget(width, height))
    this.composer.setPixelRatio(this.pixelRatioLimit)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    const cloudPass = new CloudCompositePass(this.scene, this.camera)
    this.composer.addPass(cloudPass)
    this.cloudPass = cloudPass
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
    const underwaterPass = new UnderwaterPass()
    this.composer.addPass(underwaterPass)
    underwaterPass.setSize(width * this.pixelRatioLimit, height * this.pixelRatioLimit)
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

  setUnderwaterFilterSettings(settings: UnderwaterFilterSettings) {
    this.underwaterPass?.setSettings(settings)
  }

  setUnderwaterState(state: { factor: number; depth: number }) {
    this.underwaterPass?.setState(state.factor, state.depth)
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
  }

  start(onFrame?: (dt: number) => void) {
    this.clock.start()
    const loop = () => {
      this.animationId = requestAnimationFrame(loop)
      const dt = this.clock.getDelta()
      this.elapsedTime += dt
      this.controls.update()
      onFrame?.(dt)
      this.underwaterPass?.setTime(this.elapsedTime)
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
    this.cloudPass?.dispose()
    this.underwaterPass?.dispose()
    this.outputPass?.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.container.removeChild(this.renderer.domElement)
  }
}

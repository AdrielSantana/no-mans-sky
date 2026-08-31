import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { createSkybox } from './skybox'
import { WORLD_SCALE } from './world-scale'
import { CLOUD_RENDER_LAYER } from './render-layers'
import { SunShadowMap } from './planet/sun-shadow'
import { GpuProfiler } from './gpu-profiler'

// Upper bound on a single frame's delta. Returning from a hidden tab hands
// Clock.getDelta() the whole elapsed wall time.
const MAX_FRAME_DELTA = 1 / 15
const RESIZE_DEBOUNCE_MS = 120
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
    // DoubleSide, not FrontSide. PlanetRenderer.updateCloudRenderSide flips the
    // cloud shell to BackSide as soon as the camera is inside it — i.e. any time
    // you are walking on the surface. With a FrontSide override the shell's
    // outward-facing polygons are all facing away, so this pre-pass wrote no
    // depth at all, tCloudDepth stayed at the cleared 1.0, and the composite
    // then read every pixel with geometry as "cloud is behind the scene" and
    // multiplied the cloud alpha to zero. The result was a cloud deck that got
    // cut off with a hard edge along the terrain horizon and only survived
    // against empty sky.
    //
    // DoubleSide is a no-op from outside the shell: a ray from outside hits the
    // near (front-facing) surface first either way, and the depth test keeps it.
    side: THREE.DoubleSide,
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
  private pixelRatioCeiling = 2
  private pixelRatioOverride = 2
  private sunLight: THREE.PointLight | null = null
  private bloomPass: UnrealBloomPass | null = null
  private outputPass: OutputPass | null = null
  private smaaPass: SMAAPass | null = null
  private gpuProfiler: GpuProfiler
  private sunShadow = new SunShadowMap()
  private sunShadowDir = new THREE.Vector3()
  private cloudPass: CloudCompositePass | null = null
  private underwaterPass: UnderwaterPass | null = null
  private elapsedTime = 0
  private lastWidth = 0
  private lastHeight = 0
  private resizeTimer: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private contextLost = false
  private frameCallback: ((dt: number) => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
    const width = container.clientWidth
    const height = container.clientHeight

    // Renderer
    // antialias is deliberately off: the whole scene is rasterised into the
    // composer's render targets, which are created without `samples`. The only
    // draw reaching the default framebuffer is OutputPass's fullscreen quad,
    // where MSAA has no edges to resolve — so `antialias: true` allocated a
    // multisampled backbuffer and resolved it every frame for nothing.
    // Geometry AA is instead the SMAA pass at the end of the chain below; it
    // cannot be bolted onto one composer target because RenderPass draws into
    // readBuffer and the swap parity is dynamic.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true })
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
    // After OutputPass on purpose: SMAA detects edges by luma, so it wants the
    // tonemapped LDR image, not the HalfFloat scene target. Running it here
    // also leaves those targets single-sampled and the cloud pass's depth read
    // untouched, which composer-level MSAA would not.
    //
    // Its two lookup textures are inline base64, so nothing is fetched -- but
    // they decode asynchronously, so the very first frames pass through
    // un-antialiased rather than blocking.
    const smaaPass = new SMAAPass()
    this.composer.addPass(smaaPass)
    // Passes added after the composer's own setSize never got one, and SMAA
    // needs device pixels or its edge search walks the wrong texel distance.
    smaaPass.setSize(width * this.pixelRatioLimit, height * this.pixelRatioLimit)
    this.smaaPass = smaaPass

    this.gpuProfiler = new GpuProfiler(this.renderer)
    this.instrumentComposerPasses()

    this.setupLights()

    this.boundResize = this.scheduleResize.bind(this)
    window.addEventListener('resize', this.boundResize)
    // A window resize event is not the only way the canvas changes size — the
    // editor panel can change the container's width on its own.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.boundResize)
      this.resizeObserver.observe(container)
    }
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost)
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored)
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

  getSunPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return this.sunLight ? target.copy(this.sunLight.position) : target.set(0, 0, 0)
  }

  setSunColor(color: string) {
    this.sunLight?.color.set(color)
  }

  getSunColor(target = new THREE.Color()): THREE.Color {
    return this.sunLight ? target.copy(this.sunLight.color) : target.set(0xffffff)
  }

  setSunShadowEnabled(enabled: boolean) {
    this.sunShadow.setEnabled(enabled)
  }

  setSunShadowSettings(settings: { strength: number; radius: number; size: number; softness: number }) {
    this.sunShadow.setStrength(settings.strength)
    this.sunShadow.setRadius(settings.radius)
    this.sunShadow.setSize(settings.size)
    this.sunShadow.setSoftness(settings.softness)
  }

  getSunShadowEnabled(): boolean {
    return this.sunShadow.isEnabled()
  }

  /** Live state of the shadow pass, for the HUD. Reads the pass, not the params
   * that were handed to it -- the two disagreeing is exactly the bug worth
   * seeing. */
  getSunShadowStats() {
    return this.sunShadow.getStats()
  }

  setBloomEnabled(enabled: boolean) {
    if (this.bloomPass) this.bloomPass.enabled = enabled
  }

  // EffectComposer points renderToScreen at the last *enabled* pass, so turning
  // this off hands the screen back to OutputPass with nothing else to change.
  setAntialiasEnabled(enabled: boolean) {
    if (this.smaaPass) this.smaaPass.enabled = enabled
  }

  getAntialiasEnabled(): boolean {
    return this.smaaPass?.enabled ?? false
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

  // Wraps each pass's render so the profiler sees it by name. Done by
  // replacing the method rather than by subclassing every pass type, since
  // three's passes come from examples/jsm and are not ours to extend. A
  // disabled pass is simply never called, and the profiler zeroes it.
  private instrumentComposerPasses(): void {
    const labels = new Map<object, string>([
      [this.cloudPass as object, 'clouds'],
      [this.bloomPass as object, 'bloom'],
      [this.underwaterPass as object, 'underwater'],
      [this.outputPass as object, 'output'],
      [this.smaaPass as object, 'smaa'],
    ])
    for (const pass of this.composer.passes) {
      const label = labels.get(pass as object) ?? 'scene'
      const original = pass.render.bind(pass)
      pass.render = (...args: Parameters<typeof pass.render>) => {
        this.gpuProfiler.begin(label)
        original(...args)
        this.gpuProfiler.end()
      }
    }
  }

  setGpuProfilingEnabled(enabled: boolean) {
    this.gpuProfiler.setEnabled(enabled)
  }

  getGpuTimings() {
    return this.gpuProfiler.getTimings()
  }

  isGpuProfilingSupported(): boolean {
    return this.gpuProfiler.isSupported()
  }

  /**
   * Ceiling the user asked for. Kept apart from the walker's override so the
   * two cannot clobber each other: the walker drops to 1x on the surface, and
   * before this split any editor slider change would have shoved it back to 2x
   * mid-walk.
   */
  setPixelRatioCeiling(ceiling: number) {
    this.pixelRatioCeiling = ceiling
    this.applyPixelRatio()
  }

  setPixelRatioLimit(limit: number) {
    this.pixelRatioOverride = limit
    this.applyPixelRatio()
  }

  private applyPixelRatio() {
    const limit = Math.min(this.pixelRatioCeiling, this.pixelRatioOverride)
    const next = Math.min(window.devicePixelRatio, limit)
    if (next === this.pixelRatioLimit) return
    this.pixelRatioLimit = next
    this.renderer.setPixelRatio(this.pixelRatioLimit)
    this.composer.setPixelRatio(this.pixelRatioLimit)
    // handleResize bails when the CSS size is unchanged, which it always is
    // here -- only the device-pixel multiplier moved. Without this the render
    // targets keep the old resolution and changing the limit does nothing.
    this.lastWidth = 0
    this.lastHeight = 0
    this.handleResize()
  }

  getPixelRatioLimit(): number {
    return this.pixelRatioLimit
  }

  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  private handleResize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    // A zero height gives aspect = Infinity and a NaN projection matrix, which
    // renders nothing and does not recover on its own.
    if (w <= 0 || h <= 0) return
    if (w === this.lastWidth && h === this.lastHeight) return
    this.lastWidth = w
    this.lastHeight = h
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    // composer.setSize rebuilds every bloom render target, so this must not run
    // on every resize event while a window drag is in flight.
    this.composer.setSize(w, h)
  }

  private scheduleResize() {
    if (this.resizeTimer !== null) return
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null
      this.handleResize()
    }, RESIZE_DEBOUNCE_MS)
  }

  private handleContextLost = (event: Event) => {
    // Without preventDefault the context is never restored and the canvas stays
    // black forever while rAF keeps burning CPU.
    event.preventDefault()
    this.contextLost = true
    this.stop()
  }

  private handleContextRestored = () => {
    this.contextLost = false
    this.lastWidth = 0
    this.lastHeight = 0
    this.handleResize()
    if (this.frameCallback) this.start(this.frameCallback)
  }

  start(onFrame?: (dt: number) => void) {
    if (onFrame) this.frameCallback = onFrame
    if (this.contextLost) return
    this.clock.start()
    // three resets renderer.info inside every renderer.render() call. A composer
    // frame makes at least six (RenderPass, the cloud pass's two, the bloom and
    // underwater quads, OutputPass), and the last one is always a fullscreen
    // quad — so the perf HUD read a permanent "1 draw call, 2 triangles" no
    // matter what the scene held. Taking over the reset makes the counters
    // accumulate over the whole frame, which is what the HUD means to show.
    this.renderer.info.autoReset = false
    const loop = () => {
      this.animationId = requestAnimationFrame(loop)
      // Clamp: Clock.getDelta() returns the entire time spent in a hidden tab,
      // which would teleport clouds, waves and grass wind on the first frame
      // back. The walker controller already clamps its own step.
      const dt = Math.min(this.clock.getDelta(), MAX_FRAME_DELTA)
      this.elapsedTime += dt
      this.renderer.info.reset()
      this.gpuProfiler.beginFrame()
      this.controls.update()
      onFrame?.(dt)
      this.underwaterPass?.setTime(this.elapsedTime)
      // Before the composer, and centred on the camera rather than on any one
      // planet: the box is 260 m deep along the sun, so wherever the camera is
      // standing the ground under it is inside. Out in orbit no caster is in
      // range and the pass degenerates to a clear.
      if (this.sunLight) {
        this.sunShadowDir.copy(this.sunLight.position).sub(this.camera.position).normalize()
        this.gpuProfiler.begin('shadow')
        this.sunShadow.render(this.renderer, this.scene, this.sunShadowDir, this.camera.position)
        this.gpuProfiler.end()
      }
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
    this.sunShadow.dispose()
    this.gpuProfiler.dispose()
    window.removeEventListener('resize', this.boundResize)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.resizeTimer !== null) {
      window.clearTimeout(this.resizeTimer)
      this.resizeTimer = null
    }
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost)
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored)
    this.controls.dispose()
    this.cloudPass?.dispose()
    this.underwaterPass?.dispose()
    this.outputPass?.dispose()
    // EffectComposer.dispose only releases rt1/rt2 and its copy pass. The bloom
    // pass owns eleven render targets and ~9 materials that only its own
    // dispose() frees.
    this.bloomPass?.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.container.removeChild(this.renderer.domElement)
  }
}

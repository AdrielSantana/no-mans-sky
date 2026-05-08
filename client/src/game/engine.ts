import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { createSkybox } from './skybox'
import { WORLD_SCALE } from './world-scale'
import { CLOUD_RENDER_LAYER, MAIN_RENDER_LAYER } from './render-layers'

const CLOUD_RENDER_SCALE = 0.5

class CloudCompositePass extends Pass {
  private scene: THREE.Scene
  private camera: THREE.Camera
  private cloudTarget: THREE.WebGLRenderTarget
  private material: THREE.ShaderMaterial
  private fsQuad: FullScreenQuad
  private clearColor = new THREE.Color()
  private materialColorWrite = new Map<THREE.Material, boolean>()

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super()
    this.scene = scene
    this.camera = camera
    this.needsSwap = true
    this.cloudTarget = this.createCloudTarget(1, 1)
    this.material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tClouds: { value: this.cloudTarget.texture },
        uCloudEnabled: { value: 1 },
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
        uniform float uCloudEnabled;
        varying vec2 vUv;

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec4 clouds = texture2D(tClouds, vUv);
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
    return target
  }

  setSize(width: number, height: number) {
    const targetWidth = Math.max(1, Math.floor(width * CLOUD_RENDER_SCALE))
    const targetHeight = Math.max(1, Math.floor(height * CLOUD_RENDER_SCALE))
    this.cloudTarget.setSize(targetWidth, targetHeight)
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const hasClouds = this.hasVisibleClouds()
    if (hasClouds) this.renderClouds(renderer)

    this.material.uniforms.tDiffuse.value = readBuffer.texture
    this.material.uniforms.tClouds.value = this.cloudTarget.texture
    this.material.uniforms.uCloudEnabled.value = hasClouds ? 1 : 0
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    this.fsQuad.render(renderer)
  }

  private hasVisibleClouds(): boolean {
    let visible = false
    const cloudLayerMask = 1 << CLOUD_RENDER_LAYER
    this.scene.traverse(object => {
      if (visible) return
      if (object.visible && (object.layers.mask & cloudLayerMask) !== 0) visible = true
    })
    return visible
  }

  private renderClouds(renderer: THREE.WebGLRenderer) {
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    const previousBackground = this.scene.background
    const previousCameraMask = this.camera.layers.mask
    const previousClearAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.clearColor)

    try {
      this.scene.background = null
      renderer.setRenderTarget(this.cloudTarget)
      renderer.setClearColor(0x000000, 0)
      renderer.clear(true, true, true)

      this.camera.layers.set(MAIN_RENDER_LAYER)
      this.setSceneColorWrite(false)
      renderer.render(this.scene, this.camera)
      this.restoreSceneColorWrite()

      renderer.autoClear = false
      this.camera.layers.set(CLOUD_RENDER_LAYER)
      renderer.render(this.scene, this.camera)
    } finally {
      this.restoreSceneColorWrite()
      renderer.autoClear = previousAutoClear
      this.camera.layers.mask = previousCameraMask
      this.scene.background = previousBackground
      renderer.setClearColor(this.clearColor, previousClearAlpha)
      renderer.setRenderTarget(previousTarget)
    }
  }

  private setSceneColorWrite(value: boolean) {
    this.materialColorWrite.clear()
    this.scene.traverse(object => {
      const mesh = object as THREE.Mesh
      const material = mesh.material
      if (!material) return

      const materials = Array.isArray(material) ? material : [material]
      for (const item of materials) {
        if (!this.materialColorWrite.has(item)) {
          this.materialColorWrite.set(item, item.colorWrite)
          item.colorWrite = value
        }
      }
    })
  }

  private restoreSceneColorWrite() {
    for (const [material, colorWrite] of this.materialColorWrite) {
      material.colorWrite = colorWrite
    }
    this.materialColorWrite.clear()
  }

  dispose() {
    this.cloudTarget.dispose()
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
      this.controls.update()
      onFrame?.(dt)
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
    this.outputPass?.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.container.removeChild(this.renderer.domElement)
  }
}

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { createSkybox } from './skybox'

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

  constructor(container: HTMLElement) {
    this.container = container
    const width = container.clientWidth
    const height = container.clientHeight

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(width, height)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(this.renderer.domElement)

    // Scene
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x000000)
    this.skybox = createSkybox()
    this.scene.add(this.skybox)

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 500)
    this.camera.position.set(0, 22, 28)
    this.camera.lookAt(0, 0, 0)

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 5
    this.controls.maxDistance = 80

    // Bloom
    this.composer = new EffectComposer(this.renderer)
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

    this.setupLights()

    this.boundResize = this.handleResize.bind(this)
    window.addEventListener('resize', this.boundResize)
  }

  private setupLights() {
    this.scene.add(new THREE.AmbientLight(0x111133, 0.5))
    const sunLight = new THREE.PointLight(0xffcc66, 100, 200)
    sunLight.position.set(0, 0, 0)
    this.scene.add(sunLight)
  }

  getDeltaTime(): number {
    return this.clock.getDelta()
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
    this.composer.dispose()
    this.renderer.dispose()
    this.container.removeChild(this.renderer.domElement)
  }
}

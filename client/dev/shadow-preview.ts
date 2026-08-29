// Isolated check of the sun shadow map: does a caster's shadow land in the
// right place on the receiver? Loads no models on purpose -- the point is to
// exercise SunShadowMap's matrix and SUN_SHADOW_PARS_GLSL's sampling with
// nothing else that can fail.
import * as THREE from 'three'
import { SunShadowMap, SUN_SHADOW_PARS_GLSL, getSunShadowUniforms } from '../src/game/planet/sun-shadow'
import { SUN_SHADOW_CASTER_LAYER } from '../src/game/render-layers'

const hud = document.getElementById('hud')!
const log: string[] = []
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => { log.push(`[${level}] ${args.map(String).join(' ')}`); original(...args) }
}
window.addEventListener('error', e => log.push(`[uncaught] ${e.message}`))

const params = new URLSearchParams(location.search)
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
renderer.setSize(900, 600)
renderer.setClearColor(0x10161c)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, 900 / 600, 0.1, 5000)

// The receiver shows the shadow factor straight, with no other shading, so any
// offset or bias error is unmistakable rather than buried in lighting.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400, 1, 1).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    uniforms: { ...getSunShadowUniforms(), uSunDir: { value: new THREE.Vector3() } },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      ${SUN_SHADOW_PARS_GLSL}
      uniform vec3 uSunDir;
      varying vec3 vWorldPos;
      void main() {
        float f = sunShadowFactor(vWorldPos, dot(vec3(0.0, 1.0, 0.0), uSunDir));
        gl_FragColor = vec4(vec3(f) * vec3(0.55, 0.62, 0.5), 1.0);
      }`,
  }),
)
scene.add(ground)

// Casters: a row of pillars of different heights, so the shadow length has to
// scale with height for the projection to be right.
const casterMat = new THREE.MeshBasicMaterial({ color: 0xcc7744 })
const heights = [6, 12, 20, 12, 6]
heights.forEach((h, i) => {
  const box = new THREE.Mesh(new THREE.BoxGeometry(3, h, 3), casterMat)
  box.position.set((i - 2) * 22, h / 2, 0)
  box.layers.enable(SUN_SHADOW_CASTER_LAYER)
  scene.add(box)
})

const shadow = new SunShadowMap()
shadow.setSize(Number(params.get('size') ?? 1024))
shadow.setRadius(Number(params.get('radius') ?? 90))
shadow.setStrength(Number(params.get('strength') ?? 0.85))

// Elevation of the sun above the horizon, in degrees. A low sun is the hard
// case: long shadows and the most acne.
const elev = Number(params.get('elev') ?? 35) * Math.PI / 180
const sunDir = new THREE.Vector3(Math.cos(elev) * 0.6, Math.sin(elev), Math.cos(elev) * 0.8).normalize()
;(ground.material as THREE.ShaderMaterial).uniforms.uSunDir.value.copy(sunDir)

shadow.render(renderer, scene, sunDir, new THREE.Vector3(0, 0, 0))

camera.position.set(0, 78, 108)
camera.lookAt(0, 0, 10)
renderer.render(scene, camera)

const m = getSunShadowUniforms().uShadowMatrix.value.elements
hud.textContent = [
  `SHADOW PREVIEW  elev=${(elev * 180 / Math.PI).toFixed(0)}deg radius=${params.get('radius') ?? 90} size=${params.get('size') ?? 1024}`,
  `hasFrame=${shadow.hasShadowFrame()} params=${getSunShadowUniforms().uShadowParams.value.toArray().map(v => v.toFixed(4)).join(', ')}`,
  `matrix[0,5,10]=${m[0].toFixed(5)}, ${m[5].toFixed(5)}, ${m[10].toFixed(5)}`,
  `draws=${renderer.info.render.calls} tris=${renderer.info.render.triangles}`,
  log.length ? log.join('\n') : 'no console errors',
].join('\n')

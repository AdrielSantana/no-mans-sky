import * as THREE from 'three'
import { SUN_SHADOW_CASTER_LAYER } from '../render-layers'

// Cast shadows from props and the player onto the terrain.
//
// This is deliberately not three's WebGLShadowMap. That system needs the
// receiving material to carry the lights UBO and the shadow chunks, and every
// surface here is a hand-written ShaderMaterial with its own lighting -- props
// shade per vertex, terrain per fragment through applyPlanetLighting. Wiring
// three's shadows in would mean adopting its light model wholesale. Owning the
// pass instead costs one orthographic depth render and one matrix.
//
// The uniforms are handed out as stable objects and mutated in place, so a
// material spreads them once at construction and never needs a per-frame
// update path of its own.

const DEFAULT_SIZE = 2048
// Metres of surface the map covers, as a radius around the focus point. The
// shadow only has to hold up where the player is standing: at 120 m a 2048 map
// is ~0.12 m per texel, which resolves a trunk. Widening it to the prop draw
// distance would put a tree's shadow across four texels.
const DEFAULT_RADIUS = 120
// Along the sun direction. Has to clear the tallest caster with room over it,
// since the box is centred on the ground.
const DEPTH_MARGIN = 260

export interface SunShadowUniforms {
  uShadowMap: { value: THREE.Texture | null }
  uShadowMatrix: { value: THREE.Matrix4 }
  // x: 1 when the map holds a usable frame, y: strength, z: texel size,
  // w: depth bias in shadow-space units.
  uShadowParams: { value: THREE.Vector4 }
}

const _uniforms: SunShadowUniforms = {
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowParams: { value: new THREE.Vector4(0, 0.75, 1 / DEFAULT_SIZE, 0.0015) },
}

// NDC is [-1, 1] and a texture lookup wants [0, 1].
const _ndcToUv = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
)

const _up = new THREE.Vector3()
const _focus = new THREE.Vector3()
const _eye = new THREE.Vector3()
const _snap = new THREE.Vector3()

/**
 * The uniform objects every shadow-receiving material should spread into its
 * own uniforms. The same objects for the whole app -- mutated in place here, so
 * a material picks up each frame's map without any code of its own.
 */
export function getSunShadowUniforms(): SunShadowUniforms {
  return _uniforms
}

export class SunShadowMap {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
  private target: THREE.WebGLRenderTarget | null = null
  private size = DEFAULT_SIZE
  private radius = DEFAULT_RADIUS
  private enabled = true
  private hasFrame = false
  // Draw calls the last depth pass made, i.e. how many caster batches actually
  // reached the map. Zero with the feature on means the box is empty, which
  // looks identical on screen to the map never being sampled -- worth the two
  // reads to tell those apart.
  private lastCasterDraws = 0

  constructor() {
    // Only casters, so the depth pass never touches terrain, ocean, clouds or
    // the skybox. Objects opt in by enabling the layer on themselves.
    this.camera.layers.set(SUN_SHADOW_CASTER_LAYER)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.hasFrame = false
      this.lastCasterDraws = 0
      _uniforms.uShadowParams.value.x = 0
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setStrength(strength: number): void {
    _uniforms.uShadowParams.value.y = Math.max(0, Math.min(1, strength))
  }

  setRadius(radius: number): void {
    this.radius = Math.max(10, radius)
  }

  setSize(size: number): void {
    const next = Math.max(256, Math.min(4096, Math.round(size)))
    if (next === this.size) return
    this.size = next
    this.target?.dispose()
    this.target = null
    _uniforms.uShadowParams.value.z = 1 / next
  }

  private ensureTarget(): THREE.WebGLRenderTarget {
    if (this.target) return this.target
    const target = new THREE.WebGLRenderTarget(this.size, this.size, {
      // The colour attachment exists only because a render target needs one --
      // the caster materials write no colour. Depth is what gets sampled.
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    })
    const depth = new THREE.DepthTexture(this.size, this.size)
    depth.name = 'sun-shadow-depth'
    depth.format = THREE.DepthFormat
    depth.type = THREE.UnsignedIntType
    depth.minFilter = THREE.NearestFilter
    depth.magFilter = THREE.NearestFilter
    target.depthTexture = depth
    target.texture.name = 'sun-shadow-color'
    this.target = target
    return target
  }

  /**
   * Points the box down the sun direction and centres it on `focus`, then draws
   * every object on the caster layer into it.
   *
   * `sunDirection` points *from the surface towards the sun*, matching what the
   * terrain and prop shaders already carry.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    sunDirection: THREE.Vector3,
    focus: THREE.Vector3,
  ): void {
    if (!this.enabled) return
    if (sunDirection.lengthSq() < 1e-8) return

    const target = this.ensureTarget()
    _focus.copy(focus)

    // Any axis not parallel to the sun gives a valid basis, and for an ortho
    // camera aimed down the sun the choice does not move where a shadow lands
    // -- it only spins the box about the light axis. Deriving it from the sun
    // rather than from the focus keeps it still while the player walks. It must
    // not come from `focus.normalize()`: that is only the planet radial when
    // the planet sits at the world origin, and these planets orbit.
    _up.set(0, 1, 0)
    if (Math.abs(_up.dot(sunDirection)) > 0.99) _up.set(1, 0, 0)

    this.camera.left = -this.radius
    this.camera.right = this.radius
    this.camera.top = this.radius
    this.camera.bottom = -this.radius
    this.camera.near = 0.1
    this.camera.far = DEPTH_MARGIN
    this.camera.up.copy(_up)
    this.camera.updateProjectionMatrix()

    // Snap the box to whole shadow texels. Without this the map slides by a
    // fraction of a texel every frame the camera moves, and every shadow edge
    // crawls -- the most obvious artefact a shadow map has.
    _eye.copy(sunDirection).normalize().multiplyScalar(DEPTH_MARGIN * 0.5).add(_focus)
    this.camera.position.copy(_eye)
    this.camera.lookAt(_focus)
    this.camera.updateMatrixWorld(true)

    const texelWorld = (this.radius * 2) / this.size
    _snap.copy(_focus).applyMatrix4(this.camera.matrixWorldInverse)
    _snap.x = Math.round(_snap.x / texelWorld) * texelWorld
    _snap.y = Math.round(_snap.y / texelWorld) * texelWorld
    _focus.copy(_snap).applyMatrix4(this.camera.matrixWorld)

    _eye.copy(sunDirection).normalize().multiplyScalar(DEPTH_MARGIN * 0.5).add(_focus)
    this.camera.position.copy(_eye)
    this.camera.lookAt(_focus)
    this.camera.updateMatrixWorld(true)

    _uniforms.uShadowMatrix.value
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .premultiply(_ndcToUv)

    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    // The engine turns off info.autoReset and resets once per frame, so the
    // counter accumulates and the delta is this pass's own draws.
    const drawsBefore = renderer.info.render.calls
    renderer.setRenderTarget(target)
    renderer.autoClear = true
    renderer.clear(true, true, false)
    renderer.render(scene, this.camera)
    renderer.setRenderTarget(previousTarget)
    renderer.autoClear = previousAutoClear
    this.lastCasterDraws = Math.max(0, renderer.info.render.calls - drawsBefore)

    this.hasFrame = true
    _uniforms.uShadowMap.value = target.depthTexture
    _uniforms.uShadowParams.value.x = 1
  }

  hasShadowFrame(): boolean {
    return this.hasFrame
  }

  getStats(): { enabled: boolean, hasFrame: boolean, casterDraws: number, size: number, radius: number } {
    return {
      enabled: this.enabled,
      hasFrame: this.hasFrame,
      casterDraws: this.lastCasterDraws,
      size: this.size,
      radius: this.radius,
    }
  }

  dispose(): void {
    this.target?.dispose()
    this.target = null
    _uniforms.uShadowMap.value = null
    _uniforms.uShadowParams.value.x = 0
    this.hasFrame = false
    this.lastCasterDraws = 0
  }
}

// Shared by every receiving material. Kept here beside the matrix that produced
// it so the two cannot drift.
export const SUN_SHADOW_PARS_GLSL = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec4 uShadowParams;

// 1.0 in full light, down to (1 - strength) in full shadow.
//
// The bias scales with how grazing the sun is: a surface nearly edge-on to the
// light spans many depth units inside one shadow texel, which is what produces
// acne when a constant bias is used instead.
float sunShadowFactor(vec3 worldPos, float nDotL) {
  if (uShadowParams.x < 0.5 || uShadowParams.y <= 0.0) return 1.0;

  vec4 shadowPos = uShadowMatrix * vec4(worldPos, 1.0);
  vec3 coord = shadowPos.xyz / shadowPos.w;
  // Outside the box there is no information, and guessing "lit" is the only
  // guess that does not put a hard edge on the ground at the box boundary.
  if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z > 1.0) return 1.0;

  float slope = clamp(1.0 - abs(nDotL), 0.0, 1.0);
  float bias = uShadowParams.w * (0.35 + slope * 3.0);
  float texel = uShadowParams.z;

  // 2x2 rotated-free PCF. Cheap, and at 0.12 m per texel it is enough to stop
  // the edge reading as a staircase.
  float lit = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y)) * texel;
      float depth = texture2D(uShadowMap, coord.xy + offset).r;
      lit += step(coord.z - bias, depth);
    }
  }
  lit /= 9.0;

  // Fade the whole thing out towards the box edge so walking does not drag a
  // visible rectangle of shadow across the ground.
  vec2 edge = abs(coord.xy - 0.5) * 2.0;
  float inside = 1.0 - smoothstep(0.82, 1.0, max(edge.x, edge.y));
  return 1.0 - (1.0 - lit) * uShadowParams.y * inside;
}
`

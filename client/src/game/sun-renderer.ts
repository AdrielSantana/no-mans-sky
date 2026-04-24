import * as THREE from 'three'
import { SIMPLEX_4D } from './shaders/noise.glsl'

const SUN_DETAIL_ON_DISTANCE_MULTIPLIER = 60
const SUN_DETAIL_OFF_DISTANCE_MULTIPLIER = 75

// ── Visibility helper ────────────────────────────────────
const VISIBILITY_GLSL = /* glsl */ `
uniform float uVisibility;
uniform float uDirection;
uniform vec3  uLightView;

float getAlpha(vec3 n){
  float nDotL = dot(n, uLightView) * uDirection;
  return smoothstep(1.0, 1.5, nDotL + uVisibility * 2.5);
}
`

// ── Brightness to color helper ───────────────────────────
const BRIGHTNESS_COLOR = /* glsl */ `
vec3 brightnessToColor(float b, float tint, float brightness){
  b *= tint;
  return (vec3(b, b*b, b*b*b*b) / tint) * brightness;
}
`

// ── Perlin cubemap (noise bake) ──────────────────────────
const perlinVS = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const perlinFS = /* glsl */ `
precision highp float;
varying vec3 vWorld;
uniform float uTime;
uniform float uSpatialFrequency;
uniform float uTemporalFrequency;
uniform float uH;
uniform float uContrast;
uniform float uFlatten;

${SIMPLEX_4D}

vec2 fbm(vec4 p){
  float a = 1.0;
  float f = 1.0;
  vec2 sum = vec2(0.0);
  for (int i = 0; i < 5; i++){
    sum.x += snoise(p * f) * a;
    p.w += 100.0;
    sum.y += snoise(p * f) * a;
    a *= uH;
    f *= 2.0;
  }
  return sum;
}

void main(){
  vec3 world = normalize(vWorld);
  world += 12.45;
  vec4 p = vec4(world * uSpatialFrequency, uTime * uTemporalFrequency);
  vec2 f = fbm(p) * uContrast + 0.5;
  vec4 p2 = vec4(world * 2.0, uTime * uTemporalFrequency);
  float modulate = max(snoise(p2), 0.0);
  float x = mix(f.x, f.x * modulate, uFlatten);
  gl_FragColor = vec4(x, f.y, f.y, x);
}
`

// ── Sun sphere ───────────────────────────────────────────
const sunSphereVS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vWorld;
varying vec3 vNormalView;
varying vec3 vNormalWorld;
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;
uniform float uTime;

mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

void setLayers(vec3 p){
  float t = uTime;
  vec3 p1 = p;
  p1.yz = rot(t) * p1.yz;
  vLayer0 = p1;
  p1 = p;
  p1.zx = rot(t + 2.094) * p1.zx;
  vLayer1 = p1;
  p1 = p;
  p1.xy = rot(t - 4.188) * p1.xy;
  vLayer2 = p1;
}

void main(){
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalView = normalize(normalMatrix * normal);
  vNormalWorld = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  setLayers(normalize(normal));
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
`

const sunSphereFS = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>

${VISIBILITY_GLSL}
${BRIGHTNESS_COLOR}

varying vec3 vWorld;
varying vec3 vNormalView;
varying vec3 vNormalWorld;
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;

uniform samplerCube uPerlinCube;
uniform float uFresnelPower;
uniform float uFresnelInfluence;
uniform float uTint;
uniform float uBase;
uniform float uBrightnessOffset;
uniform float uBrightness;

float ocean(){
  float s = 0.0;
  s += textureCube(uPerlinCube, vLayer0).r;
  s += textureCube(uPerlinCube, vLayer1).r;
  s += textureCube(uPerlinCube, vLayer2).r;
  return s * 0.3333333;
}

void main(){
  vec3 Vview = normalize((viewMatrix * vec4(vWorld - cameraPosition, 0.0)).xyz);
  float nDotV = dot(vNormalView, -Vview);
  float fresnel = pow(1.0 - nDotV, uFresnelPower) * uFresnelInfluence;
  float brightness = ocean() * uBase + uBrightnessOffset + fresnel;
  vec3 col = clamp(brightnessToColor(brightness, uTint, uBrightness), 0.0, 1.0);
  float a = getAlpha(normalize(vNormalWorld));
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(col * a, a);
}
`

// ── Glow billboard ───────────────────────────────────────
const glowVS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aPos;
varying float vRadial;
varying vec3 vWorld;
uniform mat4 uViewProjection;
uniform float uRadius;
uniform vec3 uCamUp;
uniform vec3 uCamPos;

void main(void){
  vRadial = aPos.z;
  vec3 side = normalize(cross(normalize(-uCamPos), uCamUp));
  vec3 p = aPos.x * side + aPos.y * uCamUp;
  p *= 1.0 + aPos.z * uRadius;
  vec4 world = vec4(p, 1.0);
  vWorld = world.xyz;
  gl_Position = uViewProjection * world;
  #include <logdepthbuf_vertex>
}
`

const glowFS = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
${VISIBILITY_GLSL}
${BRIGHTNESS_COLOR}

varying float vRadial;
varying vec3 vWorld;
uniform float uTint;
uniform float uBrightness;
uniform float uFalloffColor;

void main(void){
  float alpha = (1.0 - vRadial);
  alpha *= alpha;
  float brightness = 1.0 + alpha * uFalloffColor;
  alpha *= getAlpha(normalize(vWorld));
  gl_FragColor.xyz = brightnessToColor(brightness, uTint, uBrightness) * alpha;
  gl_FragColor.w = alpha;
  #include <logdepthbuf_fragment>
}
`

// ── Sun rays (ribbon geometry) ───────────────────────────
const sunRaysVS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aPos;
attribute vec3 aPos0;
attribute vec4 aWireRandom;

varying float vUVY;
varying float vOpacity;
varying vec3  vColor;
varying vec3  vNormal;
varying float vProgress;

uniform float uHueSpread;
uniform float uHue;
uniform float uLength;
uniform float uWidth;
uniform float uTime;
uniform float uNoiseFrequency;
uniform float uNoiseAmplitude;
uniform float uSunRadius;
uniform vec3  uCamPos;
uniform mat4  uViewProjection;
uniform float uOpacity;

#define m4 mat4(0.00,0.80,0.60,-0.4, -0.80,0.36,-0.48,-0.5, -0.60,-0.48,0.64,0.2, 0.40,0.30,0.20,0.4)

vec4 twistedSineNoise(vec4 q, float falloff){
  float a = 1.;
  float f = 1.;
  vec4 sum = vec4(0);
  for (int i = 0; i < 4; i++) {
    q = m4 * q;
    vec4 s = sin(q.ywxz * f) * a;
    q += s;
    sum += s;
    a *= falloff;
    f /= falloff;
  }
  return sum;
}

vec3 getPos(float phase, float animPhase){
  float size = aWireRandom.z + 0.2;
  float d = phase * uLength * size;
  vec3 p = aPos0 + aPos0 * d;
  p += twistedSineNoise(vec4((p / uSunRadius) * uNoiseFrequency, uTime * 0.22), 0.707).xyz * (d * uNoiseAmplitude);
  return p;
}

vec3 spectrum(in float d){
  return smoothstep(0.25, 0., abs(d + vec3(-0.375, -0.5, -0.625)));
}

void main(void){
  vUVY = aPos.z;
  float animPhase = fract(uTime * 0.08 * (aWireRandom.y * 0.5) + aWireRandom.x);
  vec3 p  = getPos(aPos.x, animPhase);
  vec3 p1 = getPos(aPos.x + 0.01, animPhase);
  vec3 p0w = (modelMatrix * vec4(p, 1.0)).xyz;
  vec3 p1w = (modelMatrix * vec4(p1, 1.0)).xyz;
  vec3 dirW  = normalize(p1w - p0w);
  vec3 vW    = normalize(p0w - uCamPos);
  vec3 sideW = normalize(cross(vW, dirW));
  if (length(sideW) < 1e-6) {
    vec3 up = (abs(dirW.y) < 0.99) ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
    sideW = normalize(cross(up, dirW));
  }
  float width = uWidth * aPos.z * (1.0 - aPos.x);
  vec3 pWorld = p0w + sideW * width;
  vNormal  = normalize(pWorld);
  vOpacity = uOpacity * (0.5 + aWireRandom.w);
  vColor   = spectrum(aWireRandom.w * uHueSpread + uHue);
  vProgress = aPos.x;
  gl_Position = uViewProjection * vec4(pWorld, 1.0);
  #include <logdepthbuf_vertex>
}
`

const sunRaysFS = /* glsl */ `
#ifdef GL_ES
precision highp float;
#endif
#include <logdepthbuf_pars_fragment>
${VISIBILITY_GLSL}

varying float vUVY;
varying float vOpacity;
varying vec3  vColor;
varying vec3  vNormal;
varying float vProgress;
uniform float uAlphaBlended;

void main(void){
  float alpha = smoothstep(1.0, 0.0, abs(vUVY));
  alpha *= alpha;
  alpha *= vOpacity;
  alpha *= getAlpha(vNormal);
  // Fade-out suave ao longo do comprimento
  alpha *= 1.0 - smoothstep(0.5, 1.0, vProgress);
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vColor * alpha, alpha * uAlphaBlended);
}
`

// ── Sun flares (arcing magma ribbons) ────────────────────
const sunFlaresVS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aPos;
attribute vec3 aPos0;
attribute vec3 aPos1;
attribute vec4 aWireRandom;

varying float vUVY;
varying float vOpacity;
varying vec3  vColor;
varying vec3  vNormal;
varying float vProgress;

uniform float uWidth;
uniform float uAmp;
uniform float uTime;
uniform float uNoiseFrequency;
uniform float uNoiseAmplitude;
uniform float uSunRadius;
uniform vec3  uCamPos;
uniform mat4  uViewProjection;
uniform float uOpacity;
uniform float uHueSpread;
uniform float uHue;

#define m4 mat4(0.00,0.80,0.60,-0.4, -0.80,0.36,-0.48,-0.5, -0.60,-0.48,0.64,0.2, 0.40,0.30,0.20,0.4)

vec4 twistedSineNoise(vec4 q, float falloff){
  float a = 1.0;
  float f = 1.0;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    q = m4 * q;
    vec4 s = sin(q.ywxz * f) * a;
    q += s;
    sum += s;
    a *= falloff;
    f /= falloff;
  }
  return sum;
}

vec3 getPosOBJ(float phase, float animPhase){
  float size = distance(aPos0, aPos1);
  vec3  n    = normalize((aPos0 + aPos1) * 0.5);
  vec3 p = mix(aPos0, aPos1, phase);
  float amp = sin(phase * 3.14159265) * size * uAmp;
  amp *= animPhase;
  p += n * amp;
  p += twistedSineNoise(vec4((p / uSunRadius) * uNoiseFrequency, uTime * 0.2), 0.707).xyz * (amp * uNoiseAmplitude);
  return p;
}

#define hue(v) ( .6 + .6 * cos( 6.3*(v) + vec3(0.0,23.0,21.0) ) )

void main(void){
  vUVY = aPos.z;
  float animPhase = fract(uTime * 0.08 * (aWireRandom.y * 0.5) + aWireRandom.x);
  vec3 pOBJ  = getPosOBJ(aPos.x,        animPhase);
  vec3 p1OBJ = getPosOBJ(aPos.x + 0.01, animPhase);
  vec3 pW  = (modelMatrix * vec4(pOBJ,  1.0)).xyz;
  vec3 p1W = (modelMatrix * vec4(p1OBJ, 1.0)).xyz;
  vec3 dirW  = normalize(p1W - pW);
  vec3 vW    = normalize(pW - uCamPos);
  vec3 sideW = normalize(cross(vW, dirW));
  float R = length(aPos0);
  float width = uWidth * aPos.z * (1.0 + animPhase) * R;
  pW += sideW * width;
  vNormal  = normalize(pW);
  float lenW = length(pW);
  vOpacity  = smoothstep(R, R * 1.03, lenW);
  vOpacity *= (1.0 - animPhase);
  vOpacity *= uOpacity;
  vColor = hue(aWireRandom.w * uHueSpread + uHue);
  vProgress = aPos.x;
  gl_Position = uViewProjection * vec4(pW, 1.0);
  #include <logdepthbuf_vertex>
}
`

const sunFlaresFS = /* glsl */ `
#ifdef GL_ES
precision highp float;
#endif
#include <logdepthbuf_pars_fragment>
${VISIBILITY_GLSL}

varying float vUVY;
varying float vOpacity;
varying vec3  vColor;
varying vec3  vNormal;
varying float vProgress;
uniform float uAlphaBlended;

void main(void){
  float alpha = 1.0 - smoothstep(0.0, 1.0, abs(vUVY));
  alpha *= alpha;
  alpha *= vOpacity;
  alpha *= getAlpha(vNormal);
  // Fade-out suave nas pontas
  alpha *= 1.0 - smoothstep(0.6, 1.0, vProgress);
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vColor * alpha, alpha);
}
`

// ── SunRenderer class ────────────────────────────────────

export class SunRenderer {
  private group: THREE.Group
  private renderer: THREE.WebGLRenderer
  private camera: THREE.Camera
  private time = 0
  private size: number

  // Perlin cubemap
  private perlinScene: THREE.Scene
  private perlinMat: THREE.ShaderMaterial
  private cubeRT: THREE.WebGLCubeRenderTarget
  private cubeCam: THREE.CubeCamera

  // Sun sphere
  private sunMaterial: THREE.ShaderMaterial

  // Glow
  private glowMaterial: THREE.ShaderMaterial

  // Sun rays
  private sunRaysMaterial: THREE.ShaderMaterial
  private sunRaysMesh: THREE.Mesh

  // Sun flares
  private sunFlaresMaterial: THREE.ShaderMaterial
  private sunFlaresMesh: THREE.Mesh
  private showDetailEffects = true

  private lightDirWorld = new THREE.Vector3(1, 1, 1).normalize()

  constructor(
    group: THREE.Group,
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    size: number,
  ) {
    this.group = group
    this.renderer = renderer
    this.camera = camera
    this.size = size

    this.perlinScene = new THREE.Scene()

    // Perlin cubemap bake
    const res = 512
    this.cubeRT = new THREE.WebGLCubeRenderTarget(res, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
    })
    this.cubeCam = new THREE.CubeCamera(0.1, 100, this.cubeRT)

    this.perlinMat = new THREE.ShaderMaterial({
      vertexShader: perlinVS,
      fragmentShader: perlinFS,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uTime: { value: 0 },
        uSpatialFrequency: { value: 6 },
        uTemporalFrequency: { value: 0.1 },
        uH: { value: 1 },
        uContrast: { value: 0.25 },
        uFlatten: { value: 0.72 },
      },
    })
    const perlinBox = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.perlinMat)
    this.perlinScene.add(perlinBox)

    // Sun sphere
    this.sunMaterial = new THREE.ShaderMaterial({
      vertexShader: sunSphereVS,
      fragmentShader: sunSphereFS,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uPerlinCube: { value: this.cubeRT.texture },
        uFresnelPower: { value: 1.0 },
        uFresnelInfluence: { value: 0.8 },
        uTint: { value: 0.2 },
        uBase: { value: 4.0 },
        uBrightnessOffset: { value: 1.0 },
        uBrightness: { value: 0.6 },
        uVisibility: { value: 1 },
        uDirection: { value: 1.0 },
        uLightView: { value: this.lightDirWorld.clone() },
      },
    })
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(size, 64, 64), this.sunMaterial)
    this.group.add(sunMesh)

    // Glow, rays, flares - all use size
    this.glowMaterial = this.createGlow(size)
    const rays = this.createSunRays(size)
    this.sunRaysMaterial = rays.material
    this.sunRaysMesh = rays.mesh

    const flares = this.createSunFlares(size)
    this.sunFlaresMaterial = flares.material
    this.sunFlaresMesh = flares.mesh
  }

  private createGlow(sunSize: number): THREE.ShaderMaterial {
    const segments = 134
    const rSphere = sunSize * 0.99
    const positions = new Float32Array(3 * (2 * segments))
    let r = 0
    for (let a = 0; a < segments; a++) {
      const s = (a / segments) * Math.PI * 2.0
      const sx = Math.sin(s) * rSphere
      const sy = Math.cos(s) * rSphere
      positions[r++] = sx; positions[r++] = sy; positions[r++] = 0.0
      positions[r++] = sx; positions[r++] = sy; positions[r++] = 1.0
    }
    const indices = new Uint16Array(2 * segments * 3)
    let o = 0
    for (let a = 0; a < segments; a++) {
      const i0 = 2 * a, i1 = 2 * a + 1
      const i2 = 2 * ((a + 1) % segments), i3 = i2 + 1
      indices[o++] = i0; indices[o++] = i1; indices[o++] = i2
      indices[o++] = i2; indices[o++] = i1; indices[o++] = i3
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('aPos', new THREE.Float32BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))

    const mat = new THREE.ShaderMaterial({
      vertexShader: glowVS,
      fragmentShader: glowFS,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uRadius: { value: 0.4 },
        uTint: { value: 0.4 },
        uBrightness: { value: 1.06 },
        uFalloffColor: { value: 0.5 },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uCamPos: { value: new THREE.Vector3() },
        uVisibility: { value: this.sunMaterial.uniforms.uVisibility.value },
        uDirection: { value: this.sunMaterial.uniforms.uDirection.value },
        uLightView: { value: this.lightDirWorld.clone() },
      },
    })

    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    this.group.add(mesh)
    return mat
  }

  private randomUnit(v: THREE.Vector3): THREE.Vector3 {
    const z = Math.random() * 2 - 1
    const t = Math.random() * Math.PI * 2
    const rr = Math.sqrt(1 - z * z)
    v.set(rr * Math.cos(t), rr * Math.sin(t), z)
    return v
  }

  private createSunRays(sunSize: number): { material: THREE.ShaderMaterial; mesh: THREE.Mesh } {
    const lineCount = 800
    const lineLength = 8
    const sunRadius = sunSize

    const totalVerts = lineCount * lineLength * 2
    const aPos = new Float32Array(totalVerts * 3)
    const aPos0 = new Float32Array(totalVerts * 3)
    const aWireRand = new Float32Array(totalVerts * 4)
    const indices = new Uint16Array(lineCount * (lineLength - 1) * 2 * 3)

    const base = new THREE.Vector3()
    const jitter = new THREE.Vector3()
    const held = new THREE.Vector3()
    let ip = 0, i0 = 0, ir = 0, ii = 0
    let d = 0
    let p = 0

    for (let v = 0; v < lineCount; v++) {
      if (Math.random() < 0.1 || v === 0) {
        this.randomUnit(held).normalize()
        d = Math.random()
        p = Math.random()
      }
      base.copy(held)
      this.randomUnit(jitter).multiplyScalar(0.025)
      base.add(jitter).normalize()

      const rands = [d, p, Math.random(), Math.random()]

      for (let m = 0; m < lineLength; m++) {
        const vertBase = 2 * (v * lineLength + m)
        for (let y = 0; y <= 1; y++) {
          aPos[ip++] = (m + 0.5) / lineLength
          aPos[ip++] = (v + 0.5) / lineCount
          aPos[ip++] = 2 * y - 1
          for (let t = 0; t < 4; t++) aWireRand[ir++] = rands[t]
          aPos0[i0++] = base.x * sunRadius
          aPos0[i0++] = base.y * sunRadius
          aPos0[i0++] = base.z * sunRadius
        }
        if (m < lineLength - 1) {
          const a = vertBase + 0, b = vertBase + 1, c = vertBase + 2, dd = vertBase + 3
          indices[ii++] = a; indices[ii++] = b; indices[ii++] = c
          indices[ii++] = c; indices[ii++] = b; indices[ii++] = dd
        }
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('aPos', new THREE.BufferAttribute(aPos, 3))
    geo.setAttribute('aPos0', new THREE.BufferAttribute(aPos0, 3))
    geo.setAttribute('aWireRandom', new THREE.BufferAttribute(aWireRand, 4))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))

    const mat = new THREE.ShaderMaterial({
      vertexShader: sunRaysVS,
      fragmentShader: sunRaysFS,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uVisibility: { value: this.sunMaterial.uniforms.uVisibility.value },
        uDirection: { value: this.sunMaterial.uniforms.uDirection.value },
        uLightView: { value: this.lightDirWorld.clone() },
        uWidth: { value: 0.03 },
        uLength: { value: 0.25 },
        uOpacity: { value: 0.03 },
        uNoiseFrequency: { value: 4.0 },
        uNoiseAmplitude: { value: 0.2 },
        uSunRadius: { value: sunSize },
        uAlphaBlended: { value: 0.3 },
        uHueSpread: { value: 0.2 },
        uHue: { value: 0.2 },
        uResolution: { value: new THREE.Vector4(lineLength, lineCount, 1 / lineLength, 1 / lineCount) },
      },
    })

    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 3
    this.group.add(mesh)
    return { material: mat, mesh }
  }

  private createSunFlares(sunSize: number): { material: THREE.ShaderMaterial; mesh: THREE.Mesh } {
    const sunRadius = sunSize
    const lineCount = 2047
    const lineLength = 16

    const totalVerts = lineCount * lineLength * 2
    const aPos = new Float32Array(totalVerts * 3)
    const aPos0 = new Float32Array(totalVerts * 3)
    const aPos1 = new Float32Array(totalVerts * 3)
    const aWireRand = new Float32Array(totalVerts * 4)
    const indices = new Uint16Array(lineCount * (lineLength - 1) * 2 * 3)

    const held = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const f = new THREE.Vector3()
    const g = new THREE.Vector3()

    let s = 0, l = 0, c = 0, h = 0, u = 0

    let m = Math.random(), _p = Math.random()
    for (let y = 0; y < lineCount; y++) {
      if (Math.random() < 0.025 || y === 0) {
        dir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
        held.copy(dir)
        g.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(0.4)
        held.add(g).normalize()
        m = Math.random()
        _p = Math.random()
      }

      f.copy(dir)
      g.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(0.02)
      f.add(g).normalize()

      const p = new THREE.Vector3().copy(held)
      g.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(0.075)
      p.add(g).normalize()

      const rands = [m, _p, Math.random(), Math.random()]

      for (let E = 0; E < lineLength; E++) {
        const base = 2 * (y * lineLength + E)
        for (let A = 0; A <= 1; A++) {
          aPos[s++] = (E + 0.5) / lineLength
          aPos[s++] = (y + 0.5) / lineCount
          aPos[s++] = 2 * A - 1
          for (let R = 0; R < 4; R++) aWireRand[l++] = rands[R]
          aPos0[c++] = f.x * sunRadius; aPos0[c++] = f.y * sunRadius; aPos0[c++] = f.z * sunRadius
          aPos1[h++] = p.x * sunRadius; aPos1[h++] = p.y * sunRadius; aPos1[h++] = p.z * sunRadius
        }
        if (E < lineLength - 1) {
          indices[u++] = base + 0; indices[u++] = base + 1; indices[u++] = base + 2
          indices[u++] = base + 2; indices[u++] = base + 1; indices[u++] = base + 3
        }
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('aPos', new THREE.BufferAttribute(aPos, 3))
    geo.setAttribute('aPos0', new THREE.BufferAttribute(aPos0, 3))
    geo.setAttribute('aPos1', new THREE.BufferAttribute(aPos1, 3))
    geo.setAttribute('aWireRandom', new THREE.BufferAttribute(aWireRand, 4))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))

    const mat = new THREE.ShaderMaterial({
      vertexShader: sunFlaresVS,
      fragmentShader: sunFlaresFS,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uViewProjection: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uVisibility: { value: this.sunMaterial.uniforms.uVisibility.value },
        uDirection: { value: this.sunMaterial.uniforms.uDirection.value },
        uLightView: { value: this.lightDirWorld.clone() },
        uWidth: { value: 0.005 },
        uAmp: { value: 0.5 },
        uOpacity: { value: 0.2 },
        uAlphaBlended: { value: 0.65 },
        uHueSpread: { value: 0.16 },
        uHue: { value: 0.0 },
        uNoiseFrequency: { value: 4.0 },
        uNoiseAmplitude: { value: 0.2 },
        uSunRadius: { value: sunSize },
        uResolution: { value: new THREE.Vector4(lineLength, lineCount, 1 / lineLength, 1 / lineCount) },
        uLineLength: { value: lineLength },
      },
    })

    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 1
    this.group.add(mesh)
    return { material: mat, mesh }
  }

  update(deltaTime: number) {
    this.time += deltaTime

    // Bake perlin cubemap
    this.perlinMat.uniforms.uTime.value = this.time * 0.1
    this.cubeCam.update(this.renderer, this.perlinScene)

    // Sun sphere
    this.sunMaterial.uniforms.uTime.value = this.time * 0.04
    this.sunMaterial.uniforms.uLightView.value.copy(this.lightDirWorld)

    // Update camera-dependent uniforms
    this.camera.updateMatrixWorld(true)
    const view = new THREE.Matrix4().copy(this.camera.matrixWorld).invert()
    const vp = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, view)
    const camPos = new THREE.Vector3()
    this.camera.getWorldPosition(camPos)
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize()
    this.updateDetailLod(camPos)

    // Glow
    this.glowMaterial.uniforms.uViewProjection.value.copy(vp)
    this.glowMaterial.uniforms.uCamUp.value.copy(camUp)
    this.glowMaterial.uniforms.uCamPos.value.copy(camPos)
    this.glowMaterial.uniforms.uLightView.value.copy(this.lightDirWorld)
    this.glowMaterial.uniforms.uVisibility.value = this.sunMaterial.uniforms.uVisibility.value
    this.glowMaterial.uniforms.uDirection.value = this.sunMaterial.uniforms.uDirection.value

    if (this.showDetailEffects) {
      // Sun rays
      this.sunRaysMaterial.uniforms.uViewProjection.value.copy(vp)
      this.sunRaysMaterial.uniforms.uCamPos.value.copy(camPos)
      this.sunRaysMaterial.uniforms.uTime.value = this.time
      this.sunRaysMaterial.uniforms.uLightView.value.copy(this.lightDirWorld)
      this.sunRaysMaterial.uniforms.uVisibility.value = this.sunMaterial.uniforms.uVisibility.value
      this.sunRaysMaterial.uniforms.uDirection.value = this.sunMaterial.uniforms.uDirection.value

      // Sun flares
      this.sunFlaresMaterial.uniforms.uViewProjection.value.copy(vp)
      this.sunFlaresMaterial.uniforms.uCamPos.value.copy(camPos)
      this.sunFlaresMaterial.uniforms.uTime.value = this.time
      this.sunFlaresMaterial.uniforms.uLightView.value.copy(this.lightDirWorld)
      this.sunFlaresMaterial.uniforms.uVisibility.value = this.sunMaterial.uniforms.uVisibility.value
      this.sunFlaresMaterial.uniforms.uDirection.value = this.sunMaterial.uniforms.uDirection.value
    }
  }

  private updateDetailLod(camPos: THREE.Vector3) {
    const sunPos = new THREE.Vector3()
    this.group.getWorldPosition(sunPos)
    const dist = camPos.distanceTo(sunPos)
    const offDistance = this.size * SUN_DETAIL_OFF_DISTANCE_MULTIPLIER
    const onDistance = this.size * SUN_DETAIL_ON_DISTANCE_MULTIPLIER

    if (this.showDetailEffects && dist > offDistance) {
      this.showDetailEffects = false
      this.sunRaysMesh.visible = false
      this.sunFlaresMesh.visible = false
    } else if (!this.showDetailEffects && dist < onDistance) {
      this.showDetailEffects = true
      this.sunRaysMesh.visible = true
      this.sunFlaresMesh.visible = true
    }
  }

  dispose() {
    this.cubeRT.dispose()
    this.perlinMat.dispose()
    this.sunMaterial.dispose()
    this.glowMaterial.dispose()
    this.sunRaysMaterial.dispose()
    this.sunFlaresMaterial.dispose()
  }
}

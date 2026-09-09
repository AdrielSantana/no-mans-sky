// Run in the editor's browser console:
// await (await import('/scripts/visual-checks.js')).runVisualChecks()
import * as THREE from 'three'

export function runVisualChecks() {
  const { engine, planet } = window.__nmsEditorDebug
  const results = []
  const check = (name, condition, evidence) => {
    results.push({ name, passed: Boolean(condition), evidence })
  }

  // Exercise the production scheduler without workers or scene mutations.
  const scheduler = Object.create(Object.getPrototypeOf(planet))
  scheduler.chunks = new Map([['root', {}], ['a', {}]])
  const leaf = key => ({ key, covered: false, children: null })
  const a = { key: 'a', covered: true, children: [leaf('a0'), leaf('a1'), leaf('a2'), leaf('a3')] }
  const root = { key: 'root', covered: true, children: [a, leaf('b'), leaf('c'), leaf('d')] }
  let wanted = new Set()
  scheduler.collectLoadKeys(root, wanted)
  check('Finish sibling coverage before grandchildren',
    ['b', 'c', 'd'].every(key => wanted.has(key)) && !wanted.has('a0'), [...wanted])
  root.children.forEach(child => { child.covered = true; scheduler.chunks.set(child.key, {}) })
  wanted = new Set()
  scheduler.collectLoadKeys(root, wanted)
  check('Refine after sibling coverage is complete',
    ['a0', 'a1', 'a2', 'a3'].every(key => wanted.has(key)), [...wanted])

  // Render real cloud shaders through the production compositor. Comparing
  // pixels catches logarithmic-depth mistakes that TypeScript cannot detect.
  const renderer = engine.renderer
  const previousTarget = renderer.getRenderTarget()
  const previousClear = renderer.getClearColor(new THREE.Color())
  const previousAlpha = renderer.getClearAlpha()
  const previousAutoClear = renderer.autoClear
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 900000)
  camera.position.z = 10
  const source = new THREE.WebGLRenderTarget(64, 64)
  source.depthTexture = new THREE.DepthTexture(64, 64, THREE.UnsignedIntType)
  const output = new THREE.WebGLRenderTarget(64, 64)
  const pass = new engine.cloudPass.constructor(scene, camera)
  pass.setSize(64, 64)
  const cloud = planet.cloudBillboardMesh.clone()
  cloud.geometry = cloud.geometry.clone()
  cloud.material = planet.cloudBillboardMaterial.clone()
  cloud.geometry.setAttribute('instanceAlpha', new THREE.InstancedBufferAttribute(new Float32Array([1]), 1))
  cloud.geometry.setAttribute('instanceSeed', new THREE.InstancedBufferAttribute(new Float32Array([0.4]), 1))
  cloud.count = 1
  cloud.setMatrixAt(0, new THREE.Matrix4().makeScale(8, 8, 1))
  cloud.instanceMatrix.needsUpdate = true
  cloud.position.set(0, 0, 0)
  cloud.quaternion.identity()
  cloud.scale.setScalar(1)
  cloud.visible = true
  cloud.material.uniforms.uPlanetCenter.value.set(0, 0, -100)
  cloud.material.uniforms.uSunPosition.value.set(0, 0, 100)
  cloud.material.uniforms.uOpacity.value = 1
  cloud.material.uniforms.uTime.value = 0
  const blocker = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: '#5b2744' }))
  scene.add(cloud, blocker)
  const shell = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), planet.cloudMaterial.clone())
  const mask = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  mask.needsUpdate = true
  shell.layers.set(1)
  shell.material.uniforms.uCloudMask.value = mask
  shell.material.uniforms.uCloudQuality.value = 0
  shell.material.uniforms.uCloudLocalSunDirection.value.set(0, 0, 1)
  shell.material.uniforms.uPlanetCenter.value.set(0, 0, 0)
  shell.material.uniforms.uSunPosition.value.set(0, 0, 100)
  shell.material.uniforms.uOpacity.value = 1
  const pixel = target => {
    const data = new Uint8Array(4)
    renderer.readRenderTargetPixels(target, 32, 32, 1, 1, data)
    return [...data]
  }
  const render = z => {
    blocker.position.z = z
    renderer.setClearColor(0, 1)
    renderer.autoClear = true
    renderer.setRenderTarget(source)
    renderer.render(scene, camera)
    const base = pixel(source)
    pass.render(renderer, output, source)
    return { base, composite: pixel(output) }
  }
  const difference = pair => Math.max(...pair.base.slice(0, 3).map((v, i) => Math.abs(v - pair.composite[i])))
  try {
    const behind = render(2)
    check('Cloud behind opaque terrain is occluded', difference(behind) <= 1, behind)
    const inFront = render(-2)
    check('Cloud in front of terrain stays visible', difference(inFront) > 5, inFront)
    blocker.material.transparent = true
    blocker.material.opacity = 0.8
    blocker.material.depthWrite = true
    blocker.material.needsUpdate = true
    const ocean = render(2)
    check('Cloud behind transparent depth-writing ocean is occluded', difference(ocean) <= 1, ocean)
    const parent = new THREE.Group()
    parent.visible = false
    scene.add(parent)
    parent.add(cloud)
    check('Hidden planet does not enable its cloud pass', !pass.hasVisibleClouds(), null)
    cloud.removeFromParent()
    scene.add(shell)
    pass.cloudObjectRefreshFrame = 30
    blocker.material.transparent = false
    blocker.material.needsUpdate = true
    const outsideHidden = render(9)
    check('Orbital shell behind terrain is occluded', difference(outsideHidden) <= 1, outsideHidden)
    const outsideVisible = render(7)
    check('Orbital shell in front of terrain stays visible', difference(outsideVisible) > 5, outsideVisible)
    camera.position.z = 0
    shell.material.side = THREE.BackSide
    shell.material.needsUpdate = true
    shell.material.uniforms.uCloudLocalSunDirection.value.set(0, 0, -1)
    shell.material.uniforms.uSunPosition.value.set(0, 0, -100)
    const insideHidden = render(-2)
    check('Cloud ceiling behind a mountain is occluded', difference(insideHidden) <= 1, insideHidden)
    const insideVisible = render(-12)
    check('Cloud ceiling remains visible from inside the shell', difference(insideVisible) > 5, insideVisible)
  } finally {
    scene.remove(cloud, blocker)
    cloud.geometry.dispose()
    cloud.material.dispose()
    cloud.dispose()
    blocker.geometry.dispose()
    blocker.material.dispose()
    pass.dispose()
    shell.geometry.dispose()
    shell.material.dispose()
    mask.dispose()
    source.dispose()
    output.dispose()
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClear, previousAlpha)
    renderer.autoClear = previousAutoClear
  }
  const failed = results.filter(result => !result.passed)
  if (failed.length) throw new Error(JSON.stringify(results))
  return results
}

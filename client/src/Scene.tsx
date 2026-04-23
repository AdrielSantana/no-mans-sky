import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTable } from 'spacetimedb/react'
import { tables } from './module_bindings'

export default function Scene() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [celestialBodies] = useTable(tables.celestialBody)

  const sceneRef = useRef<THREE.Scene | null>(null)
  const meshMapRef = useRef(new Map<string, THREE.Mesh>())
  const orbitLineMapRef = useRef(new Map<string, THREE.Line>())

  // Setup Three.js
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const width = container.clientWidth
    const height = container.clientHeight

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(window.devicePixelRatio)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x020210)
    sceneRef.current = scene

    // Stars
    const starsGeo = new THREE.BufferGeometry()
    const starsPos = new Float32Array(4500)
    for (let i = 0; i < 4500; i++) starsPos[i] = (Math.random() - 0.5) * 300
    starsGeo.setAttribute('position', new THREE.BufferAttribute(starsPos, 3))
    scene.add(new THREE.Points(starsGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12 })))

    // Camera
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 500)
    camera.position.set(0, 22, 28)
    camera.lookAt(0, 0, 0)

    // Lights
    scene.add(new THREE.AmbientLight(0x111133, 1))
    const sunLight = new THREE.PointLight(0xffcc66, 100, 200)
    sunLight.position.set(0, 0, 0)
    scene.add(sunLight)

    // Camera controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 5
    controls.maxDistance = 80

    // Resize
    function handleResize() {
      const w = container.clientWidth
      const h = container.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    window.addEventListener('resize', handleResize)

    // Animation loop
    let animationId: number
    function animate() {
      animationId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('resize', handleResize)
      controls.dispose()
      renderer.dispose()
      container.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [])

  // Sync meshes with server data
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    const meshMap = meshMapRef.current
    const orbitLineMap = orbitLineMapRef.current
    const activeIds = new Set<string>()

    for (const body of celestialBodies) {
      const id = body.id.toString()
      activeIds.add(id)

      let mesh = meshMap.get(id)

      if (!mesh) {
        // Criar mesh novo
        const geometry = new THREE.SphereGeometry(1, 32, 32)
        const material = body.isSun
          ? new THREE.MeshBasicMaterial({ color: body.color })
          : new THREE.MeshStandardMaterial({ color: body.color, roughness: 0.6, metalness: 0.2 })
        mesh = new THREE.Mesh(geometry, material)
        scene.add(mesh)
        meshMap.set(id, mesh)

        // Orbita circular (so para planetas)
        if (!body.isSun && body.orbitRadius > 0) {
          const points: THREE.Vector3[] = []
          for (let i = 0; i <= 64; i++) {
            const a = (i / 64) * Math.PI * 2
            points.push(new THREE.Vector3(body.orbitRadius * Math.cos(a), 0, body.orbitRadius * Math.sin(a)))
          }
          const lineGeo = new THREE.BufferGeometry().setFromPoints(points)
          const lineMat = new THREE.LineBasicMaterial({ color: 0x1a1a3a, transparent: true, opacity: 0.4 })
          const line = new THREE.Line(lineGeo, lineMat)
          scene.add(line)
          orbitLineMap.set(id, line)
        }
      }

      // Atualizar posicao e escala
      mesh.position.set(body.x, body.y, body.z)
      mesh.scale.setScalar(body.bodySize)
      mesh.rotation.y = body.rotationAngle
    }

    // Remover meshes que nao existem mais
    for (const [id, mesh] of meshMap) {
      if (!activeIds.has(id)) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
        meshMap.delete(id)

        const line = orbitLineMap.get(id)
        if (line) {
          scene.remove(line)
          line.geometry.dispose()
          ;(line.material as THREE.Material).dispose()
          orbitLineMap.delete(id)
        }
      }
    }
  }, [celestialBodies])

  return <div ref={containerRef} style={{ width: '100%', height: '100vh' }} />
}

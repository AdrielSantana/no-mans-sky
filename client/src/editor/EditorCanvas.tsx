import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GameEngine } from '../game/engine'
import { PlanetRenderer } from '../game/planet/planet-renderer'
import { PlanetWalkerController, type PlanetWalkerTarget } from '../game/planet-walker-controller'
import type { EditorParams } from './editor-defaults'

interface Props {
  params: EditorParams
}

function createPlanet(scene: THREE.Scene, params: EditorParams): PlanetRenderer {
  return new PlanetRenderer(scene, params.planetRadius, {
    seed: BigInt(params.seed),
    planetType: params.planetType,
    terrainScale: params.terrainScale,
    waterLevel: params.waterLevel,
    colorA: params.colorA,
    colorB: params.colorB,
    atmosphereColor: params.atmosphereColor,
    atmosphereDensity: params.atmosphereDensity,
    noiseProfile: {
      octaves: params.octaves,
      lacunarity: params.lacunarity,
      gain: params.gain,
      frequency: params.frequency,
    },
    lodMultipliers: params.lodMultipliers,
  })
}

function buildWalkerTarget(params: EditorParams, renderer: PlanetRenderer): PlanetWalkerTarget {
  return {
    id: 'editor-planet',
    worldPosition: new THREE.Vector3(0, 0, 0),
    worldQuaternion: new THREE.Quaternion(),
    terrain: {
      seed: params.seed,
      planetType: params.planetType,
      radius: params.planetRadius,
      terrainScale: params.terrainScale,
      frequency: params.frequency,
      octaves: params.octaves,
    },
    sampleSurfaceRadius: dir => renderer.sampleSurfaceRadius(dir),
  }
}

export function EditorCanvas({ params }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<GameEngine | null>(null)
  const planetRef = useRef<PlanetRenderer | null>(null)
  const walkerRef = useRef<PlanetWalkerController | null>(null)
  const paramsRef = useRef(params)
  const prevRadiusRef = useRef(params.planetRadius)
  const initializedRef = useRef(false)
  const wireframeRef = useRef(false)

  // Setup engine (once)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const engine = new GameEngine(container)
    engineRef.current = engine

    const walker = new PlanetWalkerController(engine)
    walkerRef.current = walker

    const r = params.planetRadius
    engine.camera.position.set(0, r * 2.5, r * 5)
    engine.camera.lookAt(0, 0, 0)
    engine.setOrbitBounds(r * 0.5, r * 15)

    const planet = createPlanet(engine.scene, params)
    planet.setSunPosition(new THREE.Vector3(0, 0, 0))
    planetRef.current = planet
    initializedRef.current = true

    walker.setTargets([buildWalkerTarget(params, planet)])

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (event.code === 'KeyV') {
        wireframeRef.current = !wireframeRef.current
        planetRef.current?.setDebugWireframe(wireframeRef.current)
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    engine.start((dt) => {
      walker.update(dt)
      planetRef.current?.update(engine.camera, dt)
    })

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      walker.dispose()
      planet.dispose()
      engine.dispose()
      engineRef.current = null
      planetRef.current = null
      walkerRef.current = null
      initializedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced planet recreation when params change
  useEffect(() => {
    paramsRef.current = params
    if (!initializedRef.current) return

    const timer = setTimeout(() => {
      const engine = engineRef.current
      const walker = walkerRef.current
      if (!engine) return

      const oldPlanet = planetRef.current
      if (oldPlanet) oldPlanet.dispose()

      const newPlanet = createPlanet(engine.scene, paramsRef.current)
      newPlanet.setSunPosition(new THREE.Vector3(0, 0, 0))
      planetRef.current = newPlanet

      walker?.setTargets([buildWalkerTarget(paramsRef.current, newPlanet)])

      // Reposition camera only when radius changes
      if (params.planetRadius !== prevRadiusRef.current) {
        const r = params.planetRadius
        engine.camera.position.set(0, r * 2.5, r * 5)
        engine.camera.lookAt(0, 0, 0)
        engine.setOrbitBounds(r * 0.5, r * 15)
        prevRadiusRef.current = r
      }
    }, 150)

    return () => clearTimeout(timer)
  }, [params])

  return <div ref={containerRef} style={{ width: '100%', height: '100vh' }} />
}

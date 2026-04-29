import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GameEngine } from '../game/engine'
import { PlanetRenderer } from '../game/planet/planet-renderer'
import { PlanetWalkerController, type PlanetWalkerTarget } from '../game/planet-walker-controller'
import type { EditorParams } from './editor-defaults'

interface Props {
  params: EditorParams
}

const PERF_QUERY_PARAM = 'perf'

declare global {
  interface Window {
    __nmsEditorDebug?: {
      engine: GameEngine
      planet: PlanetRenderer
      walker: PlanetWalkerController
    }
  }
}

function createPlanet(scene: THREE.Scene, params: EditorParams): PlanetRenderer {
  return new PlanetRenderer(scene, params.planetRadius, {
    seed: BigInt(params.seed),
    planetType: params.planetType,
    terrainScale: params.terrainScale,
    waterLevel: params.waterLevel,
    colorA: params.colorA,
    colorB: params.colorB,
    textureScale: params.textureScale,
    textureBlend: params.textureBlend,
    textureNearDistance: params.textureNearDistance,
    textureFadeDistance: params.textureFadeDistance,
    atmosphereColor: params.atmosphereColor,
    atmosphereDensity: params.atmosphereDensity,
    atmosphereHazeStrength: params.atmosphereHazeStrength,
    atmosphereHazeDistance: params.atmosphereHazeDistance,
    atmosphereHorizonGlow: params.atmosphereHorizonGlow,
    atmosphereSunGlare: params.atmosphereSunGlare,
    atmosphereSunGlareSize: params.atmosphereSunGlareSize,
    sunColor: params.sunColor,
    sunTintStrength: params.sunTintStrength,
    noiseProfile: {
      octaves: params.octaves,
      lacunarity: params.lacunarity,
      gain: params.gain,
      frequency: params.frequency,
      warpStrength: params.warpStrength,
      continentalScale: params.continentalScale,
      mountainScale: params.mountainScale,
      erosionStrength: params.erosionStrength,
      thermalStrength: params.thermalStrength,
      detailStrength: params.detailStrength,
    },
    lodMultipliers: params.lodMultipliers,
    gridSize: params.gridSize,
    skirts: params.skirts,
    horizonMargin: params.horizonMargin,
    terrainWorkers: params.terrainWorkers,
  })
}

function applyDebugSettings(engine: GameEngine, planet: PlanetRenderer, params: EditorParams) {
  engine.setBloomEnabled(params.debugBloom)
  engine.setBloomSettings({
    strength: params.bloomStrength,
    radius: params.bloomRadius,
    threshold: params.bloomThreshold,
  })
  engine.setToneMappingExposure(params.toneMappingExposure)
  planet.setDebugRendering({
    showOcean: params.debugOcean,
    showAtmosphere: params.debugAtmosphere,
    simpleTerrain: params.debugSimpleTerrain,
    nearTerrainShader: params.debugNearTerrainShader,
    farTerrainShader: params.debugFarTerrainShader,
    fallbackTerrainShader: params.debugFallbackTerrainShader,
  })
}

function buildSunPosition(params: EditorParams): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(params.sunAzimuth)
  const elevation = THREE.MathUtils.degToRad(params.sunElevation)
  const cosElevation = Math.cos(elevation)
  const distance = params.planetRadius * 24

  return new THREE.Vector3(
    Math.sin(azimuth) * cosElevation,
    Math.sin(elevation),
    Math.cos(azimuth) * cosElevation,
  ).multiplyScalar(distance)
}

function buildPlanetKey(params: EditorParams): string {
  return JSON.stringify({
    seed: params.seed,
    planetType: params.planetType,
    planetRadius: params.planetRadius,
    terrainScale: params.terrainScale,
    waterLevel: params.waterLevel,
    colorA: params.colorA,
    colorB: params.colorB,
    textureScale: params.textureScale,
    textureBlend: params.textureBlend,
    textureNearDistance: params.textureNearDistance,
    textureFadeDistance: params.textureFadeDistance,
    atmosphereColor: params.atmosphereColor,
    atmosphereDensity: params.atmosphereDensity,
    octaves: params.octaves,
    lacunarity: params.lacunarity,
    gain: params.gain,
    frequency: params.frequency,
    warpStrength: params.warpStrength,
    continentalScale: params.continentalScale,
    mountainScale: params.mountainScale,
    erosionStrength: params.erosionStrength,
    thermalStrength: params.thermalStrength,
    detailStrength: params.detailStrength,
    lodMultipliers: params.lodMultipliers,
    gridSize: params.gridSize,
    autoLod: params.autoLod,
    skirts: params.skirts,
    horizonMargin: params.horizonMargin,
    terrainWorkers: params.terrainWorkers,
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
      lacunarity: params.lacunarity,
      gain: params.gain,
      warpStrength: params.warpStrength,
      continentalScale: params.continentalScale,
      mountainScale: params.mountainScale,
      erosionStrength: params.erosionStrength,
      thermalStrength: params.thermalStrength,
      detailStrength: params.detailStrength,
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
  const planetKeyRef = useRef(buildPlanetKey(params))
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
    const sunPosition = buildSunPosition(params)
    planet.setSunPosition(sunPosition)
    engine.setSunPosition(sunPosition)
    planet.setSunColor(params.sunColor)
    engine.setSunColor(params.sunColor)
    applyDebugSettings(engine, planet, params)
    planetRef.current = planet
    initializedRef.current = true

    walker.setTargets([buildWalkerTarget(params, planet)])

    const showPerf = import.meta.env.DEV && new URLSearchParams(window.location.search).has(PERF_QUERY_PARAM)
    const frameSamples: number[] = []
    const updateSamples: number[] = []
    let lastFrame = performance.now()
    let perfOverlay: HTMLDivElement | null = null
    let perfInterval: number | null = null

    if (import.meta.env.DEV) {
      window.__nmsEditorDebug = { engine, planet, walker }
    }

    if (showPerf) {
      perfOverlay = document.createElement('div')
      perfOverlay.style.cssText = [
        'position:fixed',
        'left:12px',
        'top:12px',
        'z-index:9999',
        'min-width:300px',
        'padding:10px 12px',
        'background:rgba(0,0,0,0.72)',
        'color:#d8fff1',
        'font:12px/1.45 monospace',
        'white-space:pre',
        'pointer-events:none',
        'border:1px solid rgba(120,255,210,0.35)',
        'border-radius:8px',
      ].join(';')
      document.body.appendChild(perfOverlay)

      perfInterval = window.setInterval(() => {
        if (!perfOverlay) return
        const sortedFrames = [...frameSamples].sort((a, b) => a - b)
        const sortedUpdates = [...updateSamples].sort((a, b) => a - b)
        const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)
        const pct = (values: number[], q: number) => values[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0
        const stats = planetRef.current?.getDebugStats(engine.camera)
        const bloom = engine.getBloomSettings()
        const lods = stats
          ? Object.entries(stats.byLod)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([lod, count]) => `${lod}:${count}`)
            .join(' ')
          : ''

        perfOverlay.textContent = [
          `fps=${(1000 / avg(frameSamples)).toFixed(1)} frame=${avg(frameSamples).toFixed(1)}ms p95=${pct(sortedFrames, 0.95).toFixed(1)}ms`,
          `update=${avg(updateSamples).toFixed(2)}ms p95=${pct(sortedUpdates, 0.95).toFixed(2)}ms`,
          `draw=${engine.renderer.info.render.calls} tri=${engine.renderer.info.render.triangles}`,
          `geo=${engine.renderer.info.memory.geometries} tex=${engine.renderer.info.memory.textures}`,
          `diag bloom=${paramsRef.current.debugBloom ? 'on' : 'off'} ocean=${paramsRef.current.debugOcean ? 'on' : 'off'} atmosphere=${paramsRef.current.debugAtmosphere ? 'on' : 'off'} simpleTerrain=${paramsRef.current.debugSimpleTerrain ? 'on' : 'off'}`,
          bloom
            ? `bloom strength=${bloom.strength.toFixed(2)} radius=${bloom.radius.toFixed(2)} threshold=${bloom.threshold.toFixed(2)} enabled=${bloom.enabled ? 'on' : 'off'}`
            : 'bloom unavailable',
          `tone ${engine.getToneMappingName()} exposure=${engine.getToneMappingExposure().toFixed(2)}`,
          `terrain near=${paramsRef.current.debugNearTerrainShader ? 'shader' : 'simple'} far=${paramsRef.current.debugFarTerrainShader ? 'shader' : 'simple'} fallback=${paramsRef.current.debugFallbackTerrainShader ? 'shader' : 'simple'}`,
          stats
            ? `planet dist=${stats.surfaceDistance.toFixed(1)} chunks=${stats.visible}/${stats.chunks} pending=${stats.pending} building=${stats.building}/${stats.workers} skirts=${stats.skirtEdges} generated=${stats.generated} build=${stats.chunkGenerationMs.toFixed(2)}ms integrate=${stats.chunkIntegrationMs.toFixed(2)}ms lod[${lods}]`
            : 'planet unavailable',
        ].join('\n')

        frameSamples.length = 0
        updateSamples.length = 0
      }, 500)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (event.code === 'KeyV') {
        wireframeRef.current = !wireframeRef.current
        planetRef.current?.setDebugWireframe(wireframeRef.current)
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    engine.start((dt) => {
      if (showPerf) {
        const now = performance.now()
        frameSamples.push(now - lastFrame)
        lastFrame = now
        if (frameSamples.length > 240) frameSamples.shift()
      }
      const updateStart = showPerf ? performance.now() : 0
      walker.update(dt)
      planetRef.current?.update(engine.camera, dt)
      if (showPerf) {
        updateSamples.push(performance.now() - updateStart)
        if (updateSamples.length > 240) updateSamples.shift()
      }
    })

    return () => {
      if (perfInterval !== null) {
        window.clearInterval(perfInterval)
      }
      perfOverlay?.remove()
      window.removeEventListener('keydown', handleKeyDown)
      walker.dispose()
      planet.dispose()
      engine.dispose()
      engineRef.current = null
      planetRef.current = null
      walkerRef.current = null
      initializedRef.current = false
      if (window.__nmsEditorDebug?.engine === engine) {
        delete window.__nmsEditorDebug
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced planet recreation when params change
  useEffect(() => {
    paramsRef.current = params
    if (!initializedRef.current) return

    const sunPosition = buildSunPosition(params)
    planetRef.current?.setSunPosition(sunPosition)
    engineRef.current?.setSunPosition(sunPosition)
    planetRef.current?.setSunColor(params.sunColor)
    planetRef.current?.setSunTintStrength(params.sunTintStrength)
    planetRef.current?.setAtmosphereHaze(params.atmosphereHazeStrength, params.atmosphereHazeDistance)
    planetRef.current?.setAtmosphereOptics({
      horizonGlow: params.atmosphereHorizonGlow,
      sunGlare: params.atmosphereSunGlare,
      sunGlareSize: params.atmosphereSunGlareSize,
    })
    engineRef.current?.setSunColor(params.sunColor)
    if (engineRef.current && planetRef.current) {
      applyDebugSettings(engineRef.current, planetRef.current, params)
    }

    const planetKey = buildPlanetKey(params)
    if (planetKey === planetKeyRef.current) return

    const timer = setTimeout(() => {
      const engine = engineRef.current
      const walker = walkerRef.current
      if (!engine) return

      const oldPlanet = planetRef.current
      if (oldPlanet) oldPlanet.dispose()

      const newPlanet = createPlanet(engine.scene, paramsRef.current)
      const latestSunPosition = buildSunPosition(paramsRef.current)
      newPlanet.setSunPosition(latestSunPosition)
      engine.setSunPosition(latestSunPosition)
      newPlanet.setSunColor(paramsRef.current.sunColor)
      newPlanet.setSunTintStrength(paramsRef.current.sunTintStrength)
      newPlanet.setAtmosphereHaze(paramsRef.current.atmosphereHazeStrength, paramsRef.current.atmosphereHazeDistance)
      newPlanet.setAtmosphereOptics({
        horizonGlow: paramsRef.current.atmosphereHorizonGlow,
        sunGlare: paramsRef.current.atmosphereSunGlare,
        sunGlareSize: paramsRef.current.atmosphereSunGlareSize,
      })
      engine.setSunColor(paramsRef.current.sunColor)
      applyDebugSettings(engine, newPlanet, paramsRef.current)
      planetRef.current = newPlanet
      planetKeyRef.current = buildPlanetKey(paramsRef.current)
      if (import.meta.env.DEV && window.__nmsEditorDebug?.engine === engine && walker) {
        window.__nmsEditorDebug = { engine, planet: newPlanet, walker }
      }

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

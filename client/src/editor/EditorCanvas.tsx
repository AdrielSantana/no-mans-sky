import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GameEngine } from '../game/engine'
import { PlanetRenderer } from '../game/planet/planet-renderer'
import { createPlanet, applyDebugSettings, buildWalkerTarget } from '../game/planet-factory'
import { atmosphereDepthAt, planetSunlightFactor } from '../game/planet-sunlight'
import { PlanetWalkerController, type PlanetWalkerTarget } from '../game/planet-walker-controller'
import { loadShipModel, type ShipModel } from '../game/ship/ship-model'
import { LandedShip } from '../game/ship/landed-ship'
import { ShipBoardingController } from '../game/ship/ship-boarding-controller'
import type { EditorParams } from './editor-defaults'

interface Props {
  params: EditorParams
}

const PERF_QUERY_PARAM = 'perf'
const PLANET_ROTATION_AXIS = new THREE.Vector3(0, 1, 0)
// Hull length in metres. A guess to be looked at, not a decision: the avatar is
// 1.78 m, so this is a hull a little over six people long.
const SHIP_LENGTH_METERS = 12
// Tangential offset from the walker's spawn point, so pressing H drops the
// player beside the ship rather than inside it.
const SHIP_SPAWN_OFFSET_METERS = 14

declare global {
  interface Window {
    __nmsEditorDebug?: {
      engine: GameEngine
      planet: PlanetRenderer
      walker: PlanetWalkerController
      ship: ShipModel | null
      boarding: ShipBoardingController | null
    }
  }
}

function getEffectiveWaterLevel(params: EditorParams) { return params.waterEnabled ? params.waterLevel : 0 }

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

// Only parameters that change the *structure* of the planet belong here —
// height field, radius, LOD layout, water level, ocean shore mask. Anything
// that is purely a uniform (terrain albedo, texture blending, atmosphere
// colour) is applied imperatively in the effect below, because a key change
// tears the planet down and rebuilds it, and the ocean shore mask alone costs
// ~2.7s of synchronous main thread.
function buildPlanetKey(params: EditorParams): string {
  return JSON.stringify({
    seed: params.seed,
    planetType: params.planetType,
    planetRadius: params.planetRadius,
    terrainScale: params.terrainScale,
    waterEnabled: params.waterEnabled,
    waterLevel: getEffectiveWaterLevel(params),
    oceanDeepColor: params.oceanDeepColor,
    oceanShallowColor: params.oceanShallowColor,
    oceanFoamColor: params.oceanFoamColor,
    oceanClarity: params.oceanClarity,
    oceanAbsorption: params.oceanAbsorption,
    oceanTurbidity: params.oceanTurbidity,
    oceanReflectionStrength: params.oceanReflectionStrength,
    oceanWaveHeight: params.oceanWaveHeight,
    oceanWindSpeed: params.oceanWindSpeed,
    oceanDetail: params.oceanDetail,
    oceanChoppiness: params.oceanChoppiness,
    oceanFoamStrength: params.oceanFoamStrength,
    oceanSpecularStrength: params.oceanSpecularStrength,
    atmosphereDensity: params.atmosphereDensity,
    octaves: params.octaves,
    lacunarity: params.lacunarity,
    gain: params.gain,
    frequency: params.frequency,
    warpStrength: params.warpStrength,
    continentalScale: params.continentalScale,
    mountainScale: params.mountainScale,
    plainsScale: params.plainsScale,
    hillsScale: params.hillsScale,
    mountainBeltScale: params.mountainBeltScale,
    reliefVariety: params.reliefVariety,
    erosionStrength: params.erosionStrength,
    thermalStrength: params.thermalStrength,
    detailStrength: params.detailStrength,
    microDetailStrength: params.microDetailStrength,
    microDetailScale: params.microDetailScale,
    microReliefMeters: params.microReliefMeters,
    lodMultipliers: params.lodMultipliers,
    gridSize: params.gridSize,
    autoLod: params.autoLod,
    skirts: params.skirts,
    horizonMargin: params.horizonMargin,
    terrainWorkers: params.terrainWorkers,
  })
}

function syncWalkerTargetRotation(target: PlanetWalkerTarget | null, rotationAngle: number) {
  target?.worldQuaternion.setFromAxisAngle(PLANET_ROTATION_AXIS, rotationAngle)
}

export function EditorCanvas({ params }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<GameEngine | null>(null)
  const planetRef = useRef<PlanetRenderer | null>(null)
  const walkerRef = useRef<PlanetWalkerController | null>(null)
  const walkerTargetRef = useRef<PlanetWalkerTarget | null>(null)
  const shipRef = useRef<ShipModel | null>(null)
  const landedShipRef = useRef<LandedShip | null>(null)
  const boardingRef = useRef<ShipBoardingController | null>(null)
  const shipLocalUp = useRef(new THREE.Vector3(0, 1, 0)).current
  const shipSunPosition = useRef(new THREE.Vector3()).current
  const shipSunDirection = useRef(new THREE.Vector3()).current
  const shipSunColor = useRef(new THREE.Color()).current
  const inversePlanetRotation = useRef(new THREE.Quaternion()).current
  const paramsRef = useRef(params)
  const rotationAngleRef = useRef(0)
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

    const planet = createPlanet(engine.scene, engine.renderer, params)
    const sunPosition = buildSunPosition(params)
    planet.setSunPosition(sunPosition)
    engine.setSunPosition(sunPosition)
    planet.setSunColor(params.sunColor)
    engine.setSunColor(params.sunColor)
    applyDebugSettings(engine, planet, params)
    planet.setDebugWireframe(wireframeRef.current)
    planetRef.current = planet
    initializedRef.current = true

    const walkerTarget = buildWalkerTarget(params, planet)
    walkerTargetRef.current = walkerTarget
    walker.setTargets([walkerTarget])

    // The walker spawns along the direction the camera is looking from, so the
    // ship is anchored on that same direction, nudged sideways by its own
    // length. Pressing H then lands the player next to it.
    let shipCancelled = false
    void loadShipModel({ lengthMeters: SHIP_LENGTH_METERS, renderer: engine.renderer })
      .then((ship) => {
        if (shipCancelled) { ship.dispose(); return }
        const spawnDirection = engine.camera.position.clone().normalize()
        const east = new THREE.Vector3(1, 0, 0).projectOnPlane(spawnDirection)
        if (east.lengthSq() < 1e-8) east.set(0, 0, -1).projectOnPlane(spawnDirection)
        const offset = SHIP_SPAWN_OFFSET_METERS / Math.max(paramsRef.current.planetRadius, 1)
        const landed = new LandedShip(ship)
        landed.place(spawnDirection.addScaledVector(east.normalize(), offset), 0)
        engine.scene.add(ship.object)
        shipRef.current = ship
        landedShipRef.current = landed
        boardingRef.current = new ShipBoardingController(engine, walker, ship, landed)
        if (import.meta.env.DEV && window.__nmsEditorDebug) {
          window.__nmsEditorDebug.ship = ship
          window.__nmsEditorDebug.boarding = boardingRef.current
        }
      })
      .catch((error) => {
        console.error('Falha ao carregar a nave', error)
      })

    const showPerf = import.meta.env.DEV && new URLSearchParams(window.location.search).has(PERF_QUERY_PARAM)
    const frameSamples: number[] = []
    const updateSamples: number[] = []
    let lastFrame = performance.now()
    let perfOverlay: HTMLDivElement | null = null
    let perfInterval: number | null = null

    if (import.meta.env.DEV) {
      window.__nmsEditorDebug = { engine, planet, walker, ship: shipRef.current, boarding: boardingRef.current }
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

        // From the pass, not from the params handed to it. A HUD that echoes its
        // own inputs cannot tell "the box is empty" from "the map is never
        // sampled", and both look like no shadows at all.
        const shadowStats = engine.getSunShadowStats()
        const shadowDiag = shadowStats.enabled
          ? `${shadowStats.size}@${shadowStats.radius}m soft=${shadowStats.softness.toFixed(2)} casters=${shadowStats.casterDraws}/${(shadowStats.casterTriangles/1e6).toFixed(2)}Mtri${shadowStats.hasFrame ? '' : ' NOFRAME'}`
          : 'off'

        const gpuTimings = engine.getGpuTimings()
        const gpuTotal = gpuTimings.reduce((sum, t) => sum + t.ms, 0)
        const gpuLine = !paramsRef.current.debugGpuProfiler
          ? 'gpu profiler off'
          : !engine.isGpuProfilingSupported()
            ? 'gpu timer queries unsupported'
            : gpuTotal <= 0
              ? 'gpu measuring...'
              : `gpu ${gpuTimings.map(t => `${t.label}=${t.ms.toFixed(2)}`).join(' ')} total=${gpuTotal.toFixed(2)}ms @${engine.getPixelRatioLimit().toFixed(2)}x`

        perfOverlay.textContent = [
          `fps=${(1000 / avg(frameSamples)).toFixed(1)} frame=${avg(frameSamples).toFixed(1)}ms p95=${pct(sortedFrames, 0.95).toFixed(1)}ms`,
          `update=${avg(updateSamples).toFixed(2)}ms p95=${pct(sortedUpdates, 0.95).toFixed(2)}ms`,
          `draw=${engine.renderer.info.render.calls} tri=${engine.renderer.info.render.triangles}`,
          gpuLine,
          `geo=${engine.renderer.info.memory.geometries} tex=${engine.renderer.info.memory.textures}`,
          `diag bloom=${paramsRef.current.debugBloom ? 'on' : 'off'} aa=${paramsRef.current.debugAntialias ? 'smaa' : 'off'} shadow=${shadowDiag} atmosphere=${paramsRef.current.debugAtmosphere ? 'on' : 'off'} clouds=${paramsRef.current.debugClouds ? 'on' : 'off'} simpleTerrain=${paramsRef.current.debugSimpleTerrain ? 'on' : 'off'}`,
          bloom
            ? `bloom strength=${bloom.strength.toFixed(2)} radius=${bloom.radius.toFixed(2)} threshold=${bloom.threshold.toFixed(2)} enabled=${bloom.enabled ? 'on' : 'off'}`
            : 'bloom unavailable',
          `tone ${engine.getToneMappingName()} exposure=${engine.getToneMappingExposure().toFixed(2)}`,
          `terrain near=${paramsRef.current.debugNearTerrainShader ? 'shader' : 'simple'} far=${paramsRef.current.debugFarTerrainShader ? 'shader' : 'simple'} fallback=${paramsRef.current.debugFallbackTerrainShader ? 'shader' : 'simple'}`,
          stats
            ? `planet dist=${stats.surfaceDistance.toFixed(1)} chunks=${stats.visible}/${stats.chunks} pending=${stats.pending} building=${stats.building}/${stats.workers} skirts=${stats.skirtEdges} stitch=${stats.stitchEdges} cloudQ=${stats.cloudQuality} cloudBB=${stats.cloudBillboards} grass=${stats.grassInstances} props=${stats.propsInstances} generated=${stats.generated} build=${stats.chunkGenerationMs.toFixed(2)}ms integrate=${stats.chunkIntegrationMs.toFixed(2)}ms lod[${lods}]`
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
      const rotationSpeed = THREE.MathUtils.degToRad(paramsRef.current.planetRotationSpeed)
      if (Math.abs(rotationSpeed) > 1e-6) {
        rotationAngleRef.current = THREE.MathUtils.euclideanModulo(
          rotationAngleRef.current + rotationSpeed * dt,
          Math.PI * 2,
        )
        planetRef.current?.setRotation(rotationAngleRef.current, 0)
        syncWalkerTargetRotation(walkerTargetRef.current, rotationAngleRef.current)
      }
      if (walkerTargetRef.current && planetRef.current) {
        walkerTargetRef.current.cloudShadow = planetRef.current.getCloudShadowSettings()
      }
      walker.update(dt)
      planetRef.current?.update(engine.camera, dt)
      const target = walkerTargetRef.current
      const ship = shipRef.current
      if (landedShipRef.current && ship && target?.sampleSurfaceRadius) {
        const landed = landedShipRef.current
        // While flying, the boarding controller writes the hull from the flight
        // model instead. Running both would have the surface anchor fight the
        // flight integrator for the same transform every frame.
        if (!boardingRef.current?.isShipAirborne()) {
          landed.update(target.worldPosition, target.worldQuaternion, target.sampleSurfaceRadius)
        }
        ship.updateLod(engine.camera.position)

        // The hull is lit by three's light rig, which knows nothing about the
        // planet, so day and night have to be handed to it. Same shadow test
        // the avatar uses, evaluated at the hull instead of at the player --
        // without it the ship sat there at full noon brightness at midnight.
        const sunPosition = engine.getSunPosition(shipSunPosition)
        // Radial direction of the hull itself rather than the landing site's:
        // once airborne the two diverge, and the parked value would freeze the
        // ship at whatever time of day it took off in.
        const shipUp = boardingRef.current?.isShipAirborne()
          ? shipLocalUp.copy(ship.object.position).sub(target.worldPosition)
              .applyQuaternion(inversePlanetRotation.copy(target.worldQuaternion).invert())
              .normalize()
          : landed.getLocalDirection()
        shipSunDirection.copy(sunPosition).sub(ship.object.position)
        if (shipSunDirection.lengthSq() > 1e-6) {
          shipSunDirection.normalize().applyQuaternion(
            inversePlanetRotation.copy(target.worldQuaternion).invert(),
          )
        } else {
          shipSunDirection.copy(shipUp)
        }
        const shipRadius = ship.object.position.distanceTo(target.worldPosition)
        ship.setSunLighting(
          sunPosition,
          engine.getSunColor(shipSunColor),
          planetSunlightFactor(
            shipUp.dot(shipSunDirection),
            target.terrain.radius,
            shipRadius,
            atmosphereDepthAt(
              boardingRef.current?.isShipAirborne()
                ? target.sampleSurfaceRadius(shipUp)
                : landed.getSurfaceRadius(),
              target.terrain.radius,
              shipRadius,
            ),
          ),
          target,
        )
      }
      // After the walker: while piloting, the boarding controller owns the
      // camera, and whoever writes last wins.
      if (boardingRef.current) {
        boardingRef.current.setTarget(target)
        boardingRef.current.update(dt)
      }
      engine.setUnderwaterState(
        paramsRef.current.underwaterFilter
          ? planetRef.current?.getUnderwaterViewState() ?? { factor: 0, depth: 0 }
          : { factor: 0, depth: 0 },
      )
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
      walkerTargetRef.current = null
      shipCancelled = true
      boardingRef.current?.dispose()
      boardingRef.current = null
      shipRef.current?.dispose()
      shipRef.current = null
      landedShipRef.current = null
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
    planetRef.current?.setCloudColor(params.cloudColor)
    planetRef.current?.setTerrainAoStrength(params.terrainAoStrength)
    planetRef.current?.setTerrainAppearance({
      colorA: params.colorA,
      colorB: params.colorB,
      textureScale: params.textureScale,
      textureBlend: params.textureBlend,
      textureNearDistance: params.textureNearDistance,
      textureFadeDistance: params.textureFadeDistance,
    })
    planetRef.current?.setAtmosphereColor(params.atmosphereColor)
    planetRef.current?.setClouds({
      coverage: params.cloudCoverage,
      opacity: params.cloudOpacity,
      scale: params.cloudScale,
      softness: params.cloudSoftness,
      height: params.cloudHeight,
      speed: params.cloudSpeed,
      shadow: params.cloudShadow,
      volume: params.cloudVolume,
      storms: params.cloudStorms,
      bands: params.cloudBands,
      detail: params.cloudDetail,
      colorStrength: params.cloudColorStrength,
      billboards: params.cloudBillboards,
      billboardCount: params.cloudBillboardCount,
    })
    planetRef.current?.setGrass({
      enabled: params.grassEnabled,
      density: params.grassDensity,
      height: params.grassHeight,
      windStrength: params.grassWindStrength,
      distance: params.grassDistance,
      colorA: params.grassColorA,
      colorB: params.grassColorB,
    })
    planetRef.current?.setProps({
      enabled: params.propsEnabled,
      treeDensity: params.treeDensity,
      rockDensity: params.rockDensity,
      distance: params.propDistance,
    })
    planetRef.current?.setFoliageSettings({
      enabled: params.propsEnabled,
      density: params.foliageDensity,
      size: params.foliageSize,
      flutter: params.foliageFlutter,
      translucency: params.foliageTranslucency,
    })
    planetRef.current?.setFoliagePalettes({
      'oak-tree': { colorA: params.oakLeafShade, colorB: params.oakLeafSun },
      'winter-tree': { colorA: params.pineLeafShade, colorB: params.pineLeafSun },
    })
    planetRef.current?.setAtmosphereOptics({
      sunGlare: params.atmosphereSunGlare,
      sunGlareSize: params.atmosphereSunGlareSize,
      twilightColor: params.atmosphereTwilightColor,
      twilightWidth: params.atmosphereTwilightWidth,
      twilightStrength: params.atmosphereTwilightStrength,
      extinctionStrength: params.atmosphereExtinctionStrength,
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

      const newPlanet = createPlanet(engine.scene, engine.renderer, paramsRef.current)
      const latestSunPosition = buildSunPosition(paramsRef.current)
      newPlanet.setSunPosition(latestSunPosition)
      newPlanet.setRotation(rotationAngleRef.current, 0)
      engine.setSunPosition(latestSunPosition)
      newPlanet.setSunColor(paramsRef.current.sunColor)
      newPlanet.setCloudColor(paramsRef.current.cloudColor)
      newPlanet.setTerrainAoStrength(paramsRef.current.terrainAoStrength)
      newPlanet.setClouds({
        coverage: paramsRef.current.cloudCoverage,
        opacity: paramsRef.current.cloudOpacity,
        scale: paramsRef.current.cloudScale,
        softness: paramsRef.current.cloudSoftness,
        height: paramsRef.current.cloudHeight,
        speed: paramsRef.current.cloudSpeed,
        shadow: paramsRef.current.cloudShadow,
        volume: paramsRef.current.cloudVolume,
        storms: paramsRef.current.cloudStorms,
        bands: paramsRef.current.cloudBands,
        detail: paramsRef.current.cloudDetail,
        colorStrength: paramsRef.current.cloudColorStrength,
        billboards: paramsRef.current.cloudBillboards,
        billboardCount: paramsRef.current.cloudBillboardCount,
      })
      newPlanet.setAtmosphereOptics({
        sunGlare: paramsRef.current.atmosphereSunGlare,
        sunGlareSize: paramsRef.current.atmosphereSunGlareSize,
        twilightColor: paramsRef.current.atmosphereTwilightColor,
        twilightWidth: paramsRef.current.atmosphereTwilightWidth,
        twilightStrength: paramsRef.current.atmosphereTwilightStrength,
        extinctionStrength: paramsRef.current.atmosphereExtinctionStrength,
      })
      engine.setSunColor(paramsRef.current.sunColor)
      applyDebugSettings(engine, newPlanet, paramsRef.current)
      newPlanet.setDebugWireframe(wireframeRef.current)
      planetRef.current = newPlanet
      planetKeyRef.current = buildPlanetKey(paramsRef.current)
      if (import.meta.env.DEV && window.__nmsEditorDebug?.engine === engine && walker) {
        window.__nmsEditorDebug = { engine, planet: newPlanet, walker, ship: shipRef.current, boarding: boardingRef.current }
      }

      const walkerTarget = buildWalkerTarget(paramsRef.current, newPlanet)
      syncWalkerTargetRotation(walkerTarget, rotationAngleRef.current)
      walkerTargetRef.current = walkerTarget
      walker?.setTargets([walkerTarget])

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

import { useEffect, useRef } from 'react'
import { useTable } from 'spacetimedb/react'
import { tables } from './module_bindings'
import { GameEngine } from './game/engine'
import { CelestialSystem } from './game/celestial-system'

const PERF_QUERY_PARAM = 'perf'

declare global {
  interface Window {
    __nmsDebug?: {
      engine: GameEngine
      system: CelestialSystem
    }
  }
}

export default function Scene() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [celestialBodies] = useTable(tables.celestialBody)
  const [planetParams] = useTable(tables.planetParams)
  const celestialSystemRef = useRef<CelestialSystem | null>(null)

  // Setup engine
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const engine = new GameEngine(container)
    const system = new CelestialSystem(engine)
    celestialSystemRef.current = system
    const showPerf = import.meta.env.DEV && new URLSearchParams(window.location.search).has(PERF_QUERY_PARAM)
    const frameSamples: number[] = []
    const updateSamples: number[] = []
    let lastFrame = performance.now()
    let perfOverlay: HTMLDivElement | null = null
    let perfInterval: number | null = null

    if (import.meta.env.DEV) {
      window.__nmsDebug = { engine, system }
    }
    if (showPerf) {
      perfOverlay = document.createElement('div')
      perfOverlay.style.cssText = [
        'position:fixed',
        'left:12px',
        'top:12px',
        'z-index:9999',
        'min-width:260px',
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
        const planetStats = system.getDebugStats().planets
          .filter(planet => planet.chunks > 0 || planet.usingTerrain)
          .map(planet => {
            const lods = Object.entries(planet.byLod)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([lod, count]) => `${lod}:${count}`)
              .join(' ')
            return `planet ${planet.id} dist=${planet.surfaceDistance.toFixed(1)} chunks=${planet.visible}/${planet.chunks} detailed=${planet.detailedMaterialChunks} pending=${planet.pending} lod[${lods}]`
          })
          .join('\n')

        perfOverlay.textContent = [
          `fps=${(1000 / avg(frameSamples)).toFixed(1)} frame=${avg(frameSamples).toFixed(1)}ms p95=${pct(sortedFrames, 0.95).toFixed(1)}ms`,
          `update=${avg(updateSamples).toFixed(2)}ms p95=${pct(sortedUpdates, 0.95).toFixed(2)}ms`,
          `draw=${engine.renderer.info.render.calls} tri=${engine.renderer.info.render.triangles}`,
          `geo=${engine.renderer.info.memory.geometries} tex=${engine.renderer.info.memory.textures}`,
          planetStats || 'no active terrain chunks',
        ].join('\n')

        frameSamples.length = 0
        updateSamples.length = 0
      }, 500)
    }

    engine.start((dt) => {
      if (showPerf) {
        const now = performance.now()
        frameSamples.push(now - lastFrame)
        lastFrame = now
        if (frameSamples.length > 240) frameSamples.shift()
      }
      const updateStart = showPerf ? performance.now() : 0
      system.update(dt)
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
      system.dispose()
      engine.dispose()
      celestialSystemRef.current = null
      if (window.__nmsDebug?.engine === engine) {
        delete window.__nmsDebug
      }
    }
  }, [])

  // Sync celestial bodies with planet params
  useEffect(() => {
    celestialSystemRef.current?.sync(celestialBodies, planetParams)
  }, [celestialBodies, planetParams])

  return <div ref={containerRef} style={{ width: '100%', height: '100vh' }} />
}

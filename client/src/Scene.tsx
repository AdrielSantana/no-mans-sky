import { useEffect, useRef } from 'react'
import { useTable } from 'spacetimedb/react'
import { tables } from './module_bindings'
import { GameEngine } from './game/engine'
import { CelestialSystem } from './game/celestial-system'

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

    engine.start((dt) => {
      system.update(dt)
    })

    return () => {
      system.dispose()
      engine.dispose()
      celestialSystemRef.current = null
    }
  }, [])

  // Sync celestial bodies with planet params
  useEffect(() => {
    celestialSystemRef.current?.sync(celestialBodies, planetParams)
  }, [celestialBodies, planetParams])

  return <div ref={containerRef} style={{ width: '100%', height: '100vh' }} />
}

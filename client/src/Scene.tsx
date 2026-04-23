import { useEffect, useRef } from 'react'
import { useTable } from 'spacetimedb/react'
import { tables } from './module_bindings'
import { GameEngine } from './game/engine'
import { CelestialSystem } from './game/celestial-system'

export default function Scene() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [celestialBodies] = useTable(tables.celestialBody)
  const celestialSystemRef = useRef<CelestialSystem | null>(null)

  // Setup engine
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const engine = new GameEngine(container)
    const system = new CelestialSystem(engine.scene)
    celestialSystemRef.current = system

    engine.start()

    return () => {
      system.dispose()
      engine.dispose()
      celestialSystemRef.current = null
    }
  }, [])

  // Sync celestial bodies
  useEffect(() => {
    celestialSystemRef.current?.sync(celestialBodies)
  }, [celestialBodies])

  return <div ref={containerRef} style={{ width: '100%', height: '100vh' }} />
}

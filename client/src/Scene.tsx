import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatOverlay } from './ChatOverlay'
import { GameEngine } from './game/engine'
import { CelestialSystem } from './game/celestial-system'
import type { ChatStore } from './game/chat'
import { WorldConnection } from './game/world-connection'

declare global {
  interface Window {
    __nmsDebug?: { engine: GameEngine; system: CelestialSystem; network: WorldConnection }
  }
}

export default function Scene() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Conectando ao universo…')
  const [place, setPlace] = useState('Mineral Dawn')
  const [perf, setPerf] = useState('')
  const [chat, setChat] = useState<ChatStore | null>(null)
  const engineRef = useRef<GameEngine | null>(null)
  const chatCanvas = useCallback(() => engineRef.current?.getDomElement() ?? null, [])
  useEffect(() => {
    if (!containerRef.current) return
    const engine = new GameEngine(containerRef.current)
    const system = new CelestialSystem(engine)
    const network = new WorldConnection(system, setStatus)
    engineRef.current = engine
    setChat(network.chat)
    if (import.meta.env.DEV) window.__nmsDebug = { engine, system, network }
    engine.start(dt => { system.update(dt); network.remotes.update(dt) })
    const timer = setInterval(() => {
      const nearest = system.nearestTarget(engine.camera.position)
      setPlace(nearest ? system.names.get(nearest.id) ?? '' : 'Entre as estrelas')
      if (new URLSearchParams(location.search).has('perf')) {
        const active = system.getDebugStats().planets.filter(p => p.usingTerrain)
        setPerf(`draw=${engine.renderer.info.render.calls} tri=${engine.renderer.info.render.triangles}\n${active.map(p => `${system.names.get(p.id)} chunks=${p.visible}/${p.chunks} pending=${p.pending} build=${p.chunkGenerationMs.toFixed(1)}ms`).join('\n')}`)
      }
    }, 500)
    return () => {
      clearInterval(timer)
      setChat(null)
      engineRef.current = null
      network.dispose()
      system.dispose()
      engine.dispose()
      if (window.__nmsDebug?.engine === engine) delete window.__nmsDebug
    }
  }, [])
  return <>
    <div ref={containerRef} style={{ width: '100%', height: '100vh' }} />
    <div style={{ position: 'fixed', top: 18, left: 22, color: '#e8ecdc', pointerEvents: 'none', font: '13px/1.7 system-ui', textShadow: '0 2px 5px #000' }}>
      <div style={{ fontSize: 20, letterSpacing: '0.08em' }}>{place}</div>
      <div>{status}</div>
      <div style={{ opacity: 0.75 }}>WASD — explorar · Espaço — pular · C — chamar nave · E — embarcar / pousar</div>
      {perf && <pre>{perf}</pre>}
    </div>
    {chat && <ChatOverlay store={chat} canvas={chatCanvas} />}
  </>
}

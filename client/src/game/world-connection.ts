import { DbConnection } from '../module_bindings'
import type { CelestialSystem } from './celestial-system'
import { RemoteExplorers } from './remote-explorers'

export class WorldConnection {
  connection: DbConnection | null = null
  readonly remotes: RemoteExplorers
  private stopped = false
  private ready = false
  private retry: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval>
  private signature = ''
  private connectedAt = 0
  private generation = 0
  private status = 'Conectando ao universo…'
  private readonly tokenKey: string
  private readonly uri = import.meta.env.VITE_SPACETIMEDB_URI ?? 'ws://127.0.0.1:3000'
  private readonly database = import.meta.env.VITE_SPACETIMEDB_DATABASE ?? 'no-mans-sky'

  private system: CelestialSystem
  private onStatus: (status: string) => void
  constructor(system: CelestialSystem, onStatus: (status: string) => void) {
    this.system = system
    this.onStatus = onStatus
    // Tabs represent independent explorers; session storage survives reloads.
    // ?explorer=friend gives a stable second local test identity in the same browser.
    const slot = new URLSearchParams(location.search).get('explorer') ?? 'default'
    this.tokenKey = `nms:${this.uri}:${this.database}:${slot}`
    this.remotes = new RemoteExplorers(system)
    this.connect()
    this.interval = setInterval(() => this.tick(), 100)
  }

  private report(message: string) { this.status = message; this.onStatus(message) }

  private connect() {
    if (this.stopped) return
    const generation = ++this.generation
    const retry = () => { if (generation === this.generation) this.reconnect() }
    this.report('Conectando ao universo…')
    this.connectedAt = Date.now()
    this.connection = DbConnection.builder().withUri(this.uri).withDatabaseName(this.database)
      .withToken(sessionStorage.getItem(this.tokenKey) ?? undefined)
      .onConnect((connection, _identity, token) => {
        clearTimeout(this.retry)
        this.retry = undefined
        if (this.stopped) { connection.disconnect(); return }
        sessionStorage.setItem(this.tokenKey, token)
        connection.subscriptionBuilder().onApplied(() => {
          this.ready = true
          const own = [...connection.db.player.iter()].find(p => p.identity.isEqual(connection.identity!))
          if (own) this.system.setClockOffset(Number(own.lastSeen.microsSinceUnixEpoch / 1000n) - (Date.now() + this.connectedAt) / 2)
          const states = [...connection.db.explorerState.iter()]
          const ownState = states.find(p => p.identity.isEqual(connection.identity!))
          const peers = [...connection.db.player.iter()].filter(p => p.connected && !p.identity.isEqual(connection.identity!))
          const peer = states.find(s => s.mode === 'walking' && peers.some(p => p.identity.isEqual(s.identity)))
          this.system.setInitialState(ownState ?? peer ?? null, !ownState && !!peer)
          this.tick()
        }).onError(retry).subscribeToAllTables()
      })
      .onDisconnect(retry)
      .onConnectError(retry)
      .build()
  }

  private reconnect() {
    this.ready = false
    if (this.stopped || this.retry) return
    this.report('Sem conexão — você pode continuar explorando. Reconectando…')
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.generation++
      this.connection?.disconnect()
      this.connect()
    }, 2000)
  }

  private tick() {
    const connection = this.connection
    if (!connection?.isActive || !this.ready) return
    const bodies = [...connection.db.celestialBody.iter()]
    const appearances = [...connection.db.planetAppearance.iter()]
    const clocks = [...connection.db.worldClock.iter()]
    const signature = JSON.stringify([bodies, appearances, clocks], (_, value) => typeof value === 'bigint' ? value.toString() : value)
    if (signature !== this.signature) { this.system.sync(bodies, appearances, clocks); this.signature = signature }
    const players = [...connection.db.player.iter()]
    this.remotes.sync([...connection.db.explorerState.iter()], players, connection.identity?.toHexString() ?? '')
    const count = players.filter(p => p.connected).length
    const status = `${count} ${count === 1 ? 'explorador online' : 'exploradores online'}`
    if (this.status !== status) this.report(status)
    const snapshot = this.system.getSnapshot()
    if (snapshot) void connection.reducers.syncState(snapshot).catch(error => this.report(`Sincronização: ${String(error)}`))
  }

  dispose() {
    this.stopped = true
    clearInterval(this.interval)
    clearTimeout(this.retry)
    this.connection?.disconnect()
    this.remotes.dispose()
  }
}

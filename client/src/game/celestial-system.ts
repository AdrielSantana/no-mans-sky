import * as THREE from 'three'
import { encodePose } from './network-pose'
import type { CelestialBody, PlanetAppearance, WorldClock, ExplorerState, Pose } from '../module_bindings/types'
import type { GameEngine } from './engine'
import { SunRenderer } from './sun-renderer'
import { PlanetRenderer } from './planet/planet-renderer'
import { createPlanet, applyDebugSettings, buildWalkerTarget } from './planet-factory'
import { PlanetWalkerController, type PlanetWalkerTarget } from './planet-walker-controller'
import { loadShipModel, type ShipModel } from './ship/ship-model'
import { LandedShip } from './ship/landed-ship'
import { ShipBoardingController } from './ship/ship-boarding-controller'
import { MINERAL_WORLD } from '../../../server/spacetimedb/src/shared/world-catalog'
import type { PlanetSettings } from '../../../server/spacetimedb/src/shared/world-settings'
import { samplePlanetRadius } from '../../../server/spacetimedb/src/shared/planet-terrain'
import { planetSunlightFactor, atmosphereDepthAt } from './planet-sunlight'

export class CelestialSystem {
  readonly walkerController: PlanetWalkerController
  readonly planetRenderers = new Map<string, PlanetRenderer>()
  readonly targets = new Map<string, PlanetWalkerTarget>()
  readonly names = new Map<string, string>()
  boarding: ShipBoardingController | null = null
  ship: ShipModel | null = null
  private landed: LandedShip | null = null
  private shipTarget: PlanetWalkerTarget | null = null
  private bodies: readonly CelestialBody[] = []
  private epoch = Date.now()
  private clockOffset = 0
  private sun: SunRenderer | null = null
  private sunGroup = new THREE.Group()
  private sunPosition = new THREE.Vector3()
  private settings = new Map<string, string>()
  private disposed = false
  private spawned = false
  private initialState: ExplorerState | null = null
  private joiningPeer = false
  private wireframe = false
  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'KeyV' || event.repeat) return
    this.wireframe = !this.wireframe
    for (const renderer of this.planetRenderers.values()) renderer.setDebugWireframe(this.wireframe)
  }

  readonly engine: GameEngine
  constructor(engine: GameEngine) {
    this.engine = engine
    this.walkerController = new PlanetWalkerController(engine)
    engine.setSunColor(MINERAL_WORLD.sunColor)
    window.addEventListener('keydown', this.onKeyDown)
    void loadShipModel({ lengthMeters: 12, renderer: engine.renderer }).then(ship => {
      if (this.disposed) { ship.dispose(); return }
      this.ship = ship
      this.landed = new LandedShip(ship)
      engine.scene.add(ship.object, ship.sunLight)
      ship.object.visible = false
      this.boarding = new ShipBoardingController(engine, this.walkerController, ship, this.landed)
    }).catch(error => console.error('Falha ao carregar a nave', error))
  }

  setInitialState(state: ExplorerState | null, joiningPeer = false) {
    if (this.spawned) return
    this.initialState = state
    this.joiningPeer = joiningPeer
  }

  setClockOffset(milliseconds: number) { this.clockOffset = milliseconds }

  sync(bodies: readonly CelestialBody[], appearances: readonly PlanetAppearance[], clocks: readonly WorldClock[]) {
    this.bodies = bodies
    if (clocks[0]) this.epoch = Number(clocks[0].epoch.microsSinceUnixEpoch / 1000n)
    const active = new Set(bodies.map(body => body.id.toString()))
    for (const [id, renderer] of this.planetRenderers) {
      if (!active.has(id)) { renderer.dispose(); this.planetRenderers.delete(id); this.targets.delete(id); this.settings.delete(id) }
    }
    for (const body of bodies) {
      const id = body.id.toString()
      this.names.set(id, body.name)
      if (body.isSun) {
        if (!this.sun) {
          this.engine.scene.add(this.sunGroup)
          this.sun = new SunRenderer(this.sunGroup, this.engine.renderer, this.engine.camera, body.bodySize)
        }
        continue
      }
      const appearance = appearances.find(a => a.bodyId === body.id)
      if (!appearance || this.settings.get(id) === appearance.settingsJson) continue
      const params: PlanetSettings = JSON.parse(appearance.settingsJson)
      this.planetRenderers.get(id)?.dispose()
      const renderer = createPlanet(this.engine.scene, this.engine.renderer, params)
      applyDebugSettings(this.engine, renderer, params)
      renderer.setSunColor(MINERAL_WORLD.sunColor)
      this.planetRenderers.set(id, renderer)
      this.targets.set(id, buildWalkerTarget(params, renderer, id))
      this.settings.set(id, appearance.settingsJson)
    }
    this.walkerController.setTargets([...this.targets.values()].filter(t => t.terrain.planetType !== 'gas'))
  }

  update(dt: number) {
    const elapsed = (Date.now() + this.clockOffset - this.epoch) / 1000
    for (const body of this.bodies) {
      const angle = body.angle + body.speed * elapsed
      const position = new THREE.Vector3(body.orbitRadius * Math.cos(angle),
        body.orbitRadius * Math.sin(body.orbitalInclination) * Math.sin(angle),
        body.orbitRadius * Math.cos(body.orbitalInclination) * Math.sin(angle))
      const rotation = (body.rotationAngle + body.rotationSpeed * elapsed) % (Math.PI * 2)
      if (body.isSun) {
        this.sunGroup.position.copy(position)
        this.sunPosition.copy(position)
        this.engine.setSunPosition(position)
        continue
      }
      const id = body.id.toString()
      const target = this.targets.get(id)
      const renderer = this.planetRenderers.get(id)
      if (!target || !renderer) continue
      target.worldPosition.copy(position)
      target.worldQuaternion.setFromEuler(new THREE.Euler(0, rotation, body.axialTilt))
      renderer.setPosition(position)
      renderer.setRotation(rotation, body.axialTilt)
      renderer.setSunPosition(this.sunPosition)
      target.cloudShadow = renderer.getCloudShadowSettings()
    }
    if (!this.spawned && this.ship && this.targets.size) this.spawn()
    this.walkerController.update(dt)
    const walkTarget = this.walkerController.getActiveTarget()
    if (this.boarding?.isShipAirborne() && this.ship) {
      // Switch the flight's sampling frame only when another planet is closer.
      // FlightFrame preserves the world pose across this handoff.
      const nearest = this.nearestTarget(this.ship.object.position)
      if (nearest) this.shipTarget = nearest
    } else if (walkTarget) this.shipTarget = walkTarget
    const target = this.shipTarget
    if (this.ship && this.landed && target?.sampleSurfaceRadius && this.boarding) {
      if (!this.boarding.isShipAirborne()) this.landed.update(target.worldPosition, target.worldQuaternion, target.sampleSurfaceRadius)
      this.boarding.setTarget(target)
      this.boarding.update(dt)
      this.ship.updateLod(this.engine.camera.position)
      const up = this.ship.object.position.clone().sub(target.worldPosition).normalize()
      const sunlight = this.sunPosition.clone().sub(this.ship.object.position).normalize()
      const radius = this.ship.object.position.distanceTo(target.worldPosition)
      this.ship.setSunLighting(this.sunPosition, this.engine.getSunColor(new THREE.Color()),
        planetSunlightFactor(up.dot(sunlight), target.terrain.radius, radius,
          atmosphereDepthAt(target.terrain.radius, target.terrain.radius, radius)))
    }
    this.sun?.update(dt)
    for (const renderer of this.planetRenderers.values()) renderer.update(this.engine.camera, dt)
    const nearest = this.nearestTarget(this.engine.camera.position)
    this.engine.setUnderwaterState(nearest ? this.planetRenderers.get(nearest.id)!.getUnderwaterViewState() : { factor: 0, depth: 0 })
  }

  nearestTarget(position: THREE.Vector3) {
    let nearest: PlanetWalkerTarget | null = null
    let distance = Infinity
    for (const target of this.targets.values()) {
      const d = position.distanceTo(target.worldPosition) - target.terrain.radius
      if (d < distance) { nearest = target; distance = d }
    }
    return nearest
  }

  private spawn() {
    const saved = this.initialState
    const target = (saved && (this.targets.get(saved.playerPose.frame) ?? this.targets.get(saved.shipPose.frame)))
      || [...this.targets.values()].find(t => t.terrain.planetType === 'rocky')
    if (!target || !this.ship || !this.landed) return
    // The escarpment explored in the editor; stable across all explorers.
    const direction = new THREE.Vector3(-0.121553467091, 0.376804080125, 0.918282875719).normalize()
    if (saved && saved.playerPose.frame !== 'space') direction.set(saved.playerPose.x, saved.playerPose.y, saved.playerPose.z).normalize()
    else if (saved && saved.shipPose.frame !== 'space') direction.set(saved.shipPose.x, saved.shipPose.y, saved.shipPose.z).normalize().addScaledVector(new THREE.Vector3(1, 0, 0), 16 / target.terrain.radius).normalize()
    const sunLocal = this.sunPosition.clone().sub(target.worldPosition).normalize()
      .applyQuaternion(target.worldQuaternion.clone().invert())
    const east = new THREE.Vector3().crossVectors(sunLocal, new THREE.Vector3(0, 1, 0)).normalize()
    const north = new THREE.Vector3().crossVectors(east, sunLocal).normalize()
    // Search dry land on the day side before spawning. Sampling is analytic,
    // so terrain streaming cannot choose a different site for another client.
    if (!saved && direction.dot(sunLocal) < 0.35) {
      for (let i = 0; i < 96; i++) {
        const angle = i * 2.39996323
        const candidate = sunLocal.clone().multiplyScalar(0.62)
          .addScaledVector(east, Math.cos(angle) * 0.78)
          .addScaledVector(north, Math.sin(angle) * 0.78).normalize()
        direction.copy(candidate)
        if (samplePlanetRadius(candidate, target.terrain) > (target.seaRadius ?? 0) + 12) break
      }
    }
    if (this.joiningPeer) direction.addScaledVector(new THREE.Vector3(1, 0, 0).projectOnPlane(direction).normalize(), 5 / target.terrain.radius).normalize()
    this.walkerController.enableAt(target, direction, Math.PI / 2)
    this.landed.place(direction.clone().addScaledVector(new THREE.Vector3(1, 0, 0).projectOnPlane(direction).normalize(), 18 / target.terrain.radius), 0)
    this.shipTarget = target
    this.ship.object.visible = true
    this.spawned = true
    if (saved && !this.joiningPeer) {
      const shipTarget = this.targets.get(saved.shipPose.frame)
      if (shipTarget) {
        const d = new THREE.Vector3(saved.shipPose.x, saved.shipPose.y, saved.shipPose.z).normalize()
        const q = new THREE.Quaternion(saved.shipPose.qx, saved.shipPose.qy, saved.shipPose.qz, saved.shipPose.qw).normalize()
        const east = new THREE.Vector3(1, 0, 0).projectOnPlane(d).normalize()
        const north = new THREE.Vector3().crossVectors(d, east)
        const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
        this.landed.place(d, Math.atan2(nose.dot(east), nose.dot(north)))
        this.shipTarget = shipTarget
      } else if (saved.mode === 'flying') {
        const pose: Pose = saved.shipPose
        const position = new THREE.Vector3(pose.x, pose.y, pose.z)
        const nearest = this.nearestTarget(position)
        if (nearest) {
          this.shipTarget = nearest
          this.boarding?.restoreFlight(nearest, position, new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw), 0)
        }
      }
    }
  }

  getSnapshot() {
    if (!this.spawned || !this.ship || !this.boarding || this.boarding.getMode() === 'free') return null
    const walking = this.walkerController.getNetworkPose()
    return {
      mode: this.boarding.getMode(),
      playerPose: walking?.pose ?? encodePose(this.ship.object),
      shipPose: encodePose(this.ship.object, this.boarding.isShipAirborne() ? undefined : this.shipTarget ?? undefined),
      speed: walking?.speed ?? this.boarding.getFlightReadout().speed,
      grounded: walking?.grounded ?? !this.boarding.isShipAirborne(),
    }
  }

  getDebugStats() {
    return { planets: [...this.planetRenderers].map(([id, renderer]) => ({ id, ...renderer.getDebugStats(this.engine.camera) })), simpleMeshes: 0, hasSun: !!this.sun }
  }

  dispose() {
    this.disposed = true
    window.removeEventListener('keydown', this.onKeyDown)
    this.boarding?.dispose()
    this.ship?.dispose()
    this.walkerController.dispose()
    this.sun?.dispose()
    this.sunGroup.removeFromParent()
    for (const renderer of this.planetRenderers.values()) renderer.dispose()
    this.planetRenderers.clear()
  }
}

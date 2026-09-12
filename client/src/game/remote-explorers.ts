import * as THREE from 'three'
import type { ExplorerState, Player, Pose } from '../module_bindings/types'
import type { CelestialSystem } from './celestial-system'
import { planetSunlightFactor, atmosphereDepthAt } from './planet-sunlight'
import { PlayerAvatar } from './player-avatar'
import { loadShipModel, type ShipModel } from './ship/ship-model'

interface Remote {
  avatar: PlayerAvatar
  ship: ShipModel | null
  previous: ExplorerState
  next: ExplorerState
  received: number
  alive: boolean
}

export class RemoteExplorers {
  readonly actors = new Map<string, Remote>()
  private system: CelestialSystem
  constructor(system: CelestialSystem) { this.system = system }

  sync(rows: readonly ExplorerState[], players: readonly Player[], ownIdentity: string) {
    const active = new Set(players.filter(p => p.connected).map(p => p.identity.toHexString()))
    const wanted = new Set<string>()
    for (const row of rows) {
      const id = row.identity.toHexString()
      if (id === ownIdentity || !active.has(id)) continue
      wanted.add(id)
      let actor = this.actors.get(id)
      if (!actor) {
        actor = { avatar: new PlayerAvatar(this.system.engine.scene), ship: null,
          previous: row, next: row, received: performance.now(), alive: true }
        this.actors.set(id, actor)
        const created = actor
        void loadShipModel({ lengthMeters: 12, renderer: this.system.engine.renderer }).then(ship => {
          if (!created.alive) { ship.dispose(); return }
          created.ship = ship
          this.system.engine.scene.add(ship.object)
        }).catch(error => console.error('Remote ship', error))
      } else if (actor.next.updatedAt.microsSinceUnixEpoch !== row.updatedAt.microsSinceUnixEpoch) {
        actor.previous = actor.next
        actor.next = row
        actor.received = performance.now()
      }
    }
    for (const [id, actor] of this.actors) {
      if (!wanted.has(id)) { actor.alive = false; actor.avatar.dispose(); actor.ship?.dispose(); this.actors.delete(id) }
    }
  }

  private pose(a: Pose, b: Pose, alpha: number) {
    // Interpolate in the frame of the planet; transform to world at render time.
    // Across a frame change interpolate two world poses, never unrelated locals.
    const decode = (p: Pose) => {
      const position = new THREE.Vector3(p.x, p.y, p.z)
      const quaternion = new THREE.Quaternion(p.qx, p.qy, p.qz, p.qw).normalize()
      const target = this.system.targets.get(p.frame)
      if (target) { position.applyQuaternion(target.worldQuaternion).add(target.worldPosition); quaternion.premultiply(target.worldQuaternion) }
      return { position, quaternion }
    }
    const from = decode(a), to = decode(b)
    return { position: from.position.lerp(to.position, alpha), quaternion: from.quaternion.slerp(to.quaternion, alpha) }
  }

  update(dt: number) {
    const engine = this.system.engine
    for (const actor of this.actors.values()) {
      const row = actor.next
      const duration = Math.max(100, Math.min(300, Number(row.updatedAt.microsSinceUnixEpoch - actor.previous.updatedAt.microsSinceUnixEpoch) / 1000))
      const alpha = THREE.MathUtils.clamp((performance.now() - actor.received) / duration, 0, 1)
      const player = this.pose(actor.previous.playerPose, row.playerPose, alpha)
      const target = this.system.targets.get(row.playerPose.frame)
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quaternion)
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion)
      actor.avatar.setVisible(row.mode === 'walking')
      if (row.mode === 'walking') actor.avatar.update(dt, {
        position: player.position, up, forward, right: new THREE.Vector3().crossVectors(up, forward),
        sunPosition: engine.getSunPosition(new THREE.Vector3()), sunColor: engine.getSunColor(new THREE.Color()),
        atmosphereLightColor: new THREE.Color(target?.atmosphereColor ?? '#aabbbc'),
        atmosphereInfluence: target?.atmosphereDensity ?? 0,
        cloudMask: target?.cloudShadow?.mask ?? null, cloudMaskOffset: target?.cloudShadow?.maskOffset ?? 0,
        cloudHeight: target?.cloudShadow?.height ?? 0, cloudShadowStrength: target?.cloudShadow?.strength ?? 0,
        cloudShadowInfluence: 1,
        cloudLocalSurfaceDirection: target ? player.position.clone().sub(target.worldPosition).applyQuaternion(target.worldQuaternion.clone().invert()).normalize() : up,
        cloudLocalSunDirection: target ? engine.getSunPosition(new THREE.Vector3()).sub(player.position).applyQuaternion(target.worldQuaternion.clone().invert()).normalize() : up,
        planetRadius: target?.terrain.radius ?? 1,
        actorRadius: target ? player.position.distanceTo(target.worldPosition) : 1,
        atmosphereDepth: 1, moveX: 0, moveY: row.speed > 0.2 ? 1 : 0,
        yawDelta: 0, sprint: row.speed > 6, grounded: row.grounded, jumpStarted: false,
        speed: row.speed, verticalSpeed: row.grounded ? 0 : -1,
      })
      if (actor.ship) {
        const ship = this.pose(actor.previous.shipPose, row.shipPose, alpha)
        actor.ship.object.position.copy(ship.position)
        actor.ship.object.quaternion.copy(ship.quaternion)
        actor.ship.updateLod(engine.camera.position)
        const planet = this.system.nearestTarget(ship.position)
        const sun = engine.getSunPosition(new THREE.Vector3())
        const radius = planet ? ship.position.distanceTo(planet.worldPosition) : 1
        const light = planet ? planetSunlightFactor(
          ship.position.clone().sub(planet.worldPosition).normalize().dot(sun.clone().sub(ship.position).normalize()),
          planet.terrain.radius, radius, atmosphereDepthAt(planet.terrain.radius, planet.terrain.radius, radius)) : 1
        actor.ship.setSunLighting(sun, engine.getSunColor(new THREE.Color()), light, planet ?? undefined)
      }
    }
  }

  dispose() {
    for (const actor of this.actors.values()) { actor.alive = false; actor.avatar.dispose(); actor.ship?.dispose() }
    this.actors.clear()
  }
}

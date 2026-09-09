import * as THREE from 'three'
import { FlightFrame } from '../src/game/ship/flight-frame.ts'
import { ShipFlight } from '../src/game/ship/ship-flight.ts'
import { DbConnection } from '../src/module_bindings/index.ts'
import { samplePlanetHeightDetailed } from '../../server/spacetimedb/src/shared/planet-terrain.ts'
import { ICE_WORLD, WORLD_CATALOG } from '../../server/spacetimedb/src/shared/world-catalog.ts'

function assert(condition, message) { if (!condition) throw new Error(message) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await wait(50) }
  throw new Error(`Timeout: ${label}`)
}

export function runFlightFrameChecks() {
  const target = { id: 'a', worldPosition: new THREE.Vector3(260000, 0, 0), worldQuaternion: new THREE.Quaternion(), terrain: { radius: 25000 } }
  const frame = new FlightFrame()
  const position = new THREE.Vector3(0, 0, 32000)
  const quaternion = new THREE.Quaternion()
  frame.reset(target.id, target.worldPosition, target.worldQuaternion)
  const initial = position.clone().add(target.worldPosition)
  let maxError = 0
  for (let i = 0; i < 600; i++) {
    target.worldPosition.x += 0.25
    target.worldQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i + 1) * 0.001)
    frame.advance(position, quaternion, target)
    const world = position.clone().applyQuaternion(target.worldQuaternion).add(target.worldPosition)
    maxError = Math.max(maxError, world.distanceTo(initial))
    assert(target.worldQuaternion.clone().multiply(quaternion).angleTo(new THREE.Quaternion()) < 1e-6, 'Space attitude inherited planet rotation')
  }
  assert(maxError < 1e-6, `Space position moved with planet: ${maxError}`)
  position.set(0, 0, 25010); quaternion.identity()
  frame.reset(target.id, target.worldPosition, target.worldQuaternion)
  target.worldQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
  frame.advance(position, quaternion, target)
  assert(position.distanceTo(new THREE.Vector3(0, 0, 25010)) < 1e-9, 'Low flight lost surface frame')
  const before = position.clone().applyQuaternion(target.worldQuaternion).add(target.worldPosition)
  const other = { ...target, id: 'b', worldPosition: new THREE.Vector3(-90000, 10000, -90000), worldQuaternion: new THREE.Quaternion() }
  frame.advance(position, quaternion, other)
  assert(position.clone().add(other.worldPosition).distanceTo(before) < 1e-6, 'Planet handoff teleported ship')
  const flight = new ShipFlight()
  flight.enterFrom(new THREE.Vector3(0, 0, 43000), new THREE.Quaternion(), 300)
  for (let i = 0; i < 1200; i++) flight.update(1 / 60, { throttle: 1, pitch: 0, yaw: 0, roll: 0 }, { gas: true, planetRadius: 40000, sampleSurfaceRadius: () => 40000 })
  assert(flight.getLocalPosition().length() >= 41000, 'Ship penetrated deep gas shell')
  const terrain = { ...ICE_WORLD, radius: ICE_WORLD.planetRadius }
  let min = Infinity, max = -Infinity, maxStep = 0
  for (let i = 0; i < 1000; i++) {
    const z = 1 - 2 * (i + 0.5) / 1000, a = i * 2.39996323, r = Math.sqrt(1 - z * z)
    const d = new THREE.Vector3(Math.cos(a) * r, z, Math.sin(a) * r)
    const h = samplePlanetHeightDetailed(d, terrain) * terrain.radius * terrain.terrainScale
    const n = d.clone().add(new THREE.Vector3(1e-7, 0, 0)).normalize()
    const hn = samplePlanetHeightDetailed(n, terrain) * terrain.radius * terrain.terrainScale
    assert(Number.isFinite(h), 'Invalid glacier height')
    min = Math.min(min, h); max = Math.max(max, h); maxStep = Math.max(maxStep, Math.abs(hn - h))
  }
  assert(max - min > 200 && maxStep < 0.5, 'Glacial relief missing or discontinuous')
  return { maxSpacePositionErrorMeters: maxError, gasMinimumRadius: 41000, glacierReliefMeters: [min, max], glacierContinuityMeters: maxStep }
}

export async function runMultiplayerChecks() {
  const connect = () => new Promise((resolve, reject) => {
    DbConnection.builder().withUri('ws://127.0.0.1:3000').withDatabaseName('no-mans-sky')
      .onConnect(connection => connection.subscriptionBuilder().onApplied(() => resolve(connection)).onError(reject).subscribeToAllTables())
      .onConnectError((_ctx, error) => reject(error)).build()
  })
  const a = await connect(), b = await connect()
  try {
    assert(a.identity.toHexString() !== b.identity.toHexString(), 'Test identities collided')
    const appearances = [...a.db.planetAppearance.iter()]
    assert(appearances.length === WORLD_CATALOG.length, 'Missing world profiles')
    const rocky = appearances.find(p => JSON.parse(p.settingsJson).planetType === 'rocky')
    const settings = JSON.parse(rocky.settingsJson)
    assert(settings.seed === 67 && settings.colorA === '#668570' && settings.microReliefMeters === 1.5, 'Editor settings diverged')
    const pose = { frame: rocky.bodyId.toString(), x: 1234.123456789, y: 8000, z: 23000, qx: 0, qy: 0, qz: 0, qw: 1 }
    await a.reducers.syncState({ mode: 'walking', playerPose: pose, shipPose: pose, speed: 3, grounded: true })
    await until(() => !!b.db.explorerState.identity.find(a.identity), 'position replication')
    const first = b.db.explorerState.identity.find(a.identity)
    assert(first.playerPose.x === pose.x && first.playerPose.frame === pose.frame, 'Position precision/frame lost')
    const space = { ...pose, frame: 'space', x: 324567.123456789 }
    await a.reducers.syncState({ mode: 'flying', playerPose: space, shipPose: space, speed: 850, grounded: false })
    await until(() => b.db.explorerState.identity.find(a.identity)?.mode === 'flying', 'flight replication')
    assert(b.db.explorerState.identity.find(a.identity).shipPose.x === space.x, 'Ship pose not replicated')
    await b.reducers.syncState({ mode: 'walking', playerPose: pose, shipPose: pose, speed: 0, grounded: true })
    assert(a.db.explorerState.identity.find(a.identity).mode === 'flying', 'Another sender overwrote ownership')
    let rejected = false
    try { await a.reducers.syncState({ mode: 'flying', playerPose: { ...space, frame: 'missing' }, shipPose: space, speed: 1, grounded: false }) } catch { rejected = true }
    assert(rejected, 'Unknown frame accepted')
    const id = a.identity
    a.disconnect()
    await until(() => !b.db.player.identity.find(id)?.connected, 'disconnect presence')
    return { clients: 2, profiles: appearances.length, f64Precision: true, walkingAndShipReplication: true, senderOwnership: true, invalidFrameRejected: true, disconnectPresence: true }
  } finally { if (a.isActive) a.disconnect(); b.disconnect() }
}

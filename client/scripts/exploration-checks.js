import * as THREE from 'three'
import { ShipBoardingController } from '../src/game/ship/ship-boarding-controller.ts'
import { ShipFlight } from '../src/game/ship/ship-flight.ts'
function assert(ok, message) { if (!ok) throw new Error(message) }
export function runExplorationChecks() {
  // Exercise the actual transition on opposite hemispheres, far from the origin.
  let transitions = 0
  for (const axis of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
    const up = new THREE.Vector3(...axis)
    const centre = new THREE.Vector3(360000, 21000, -80000)
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), 0.8)
    const ship = centre.clone().addScaledVector(up, 18010)
    const camera = new THREE.PerspectiveCamera()
    const state = {
      transition: 0, mode: 'boarding', target: { worldPosition: centre, worldQuaternion: rotation },
      ship: { object: { position: ship } }, engine: { camera }, scratch: new THREE.Vector3(),
      from: ship.clone().addScaledVector(up, 3), lookFrom: ship.clone(),
      to: new THREE.Vector3(), lookTo: new THREE.Vector3(),
      computeChasePose(to, look) { to.copy(ship).addScaledVector(up, 10); look.copy(ship) },
      clampAboveGround(p) { return p },
    }
    ShipBoardingController.prototype.storeTransitionInPlanetFrame.call(state)
    ShipBoardingController.prototype.advanceTransition.call(state, 0.1)
    assert(camera.up.dot(up) > 0.999999, 'Transition flipped hemisphere')
    assert(camera.position.distanceTo(ship) < 30, 'Transition left planet frame')
    transitions++
  }
  const flight = new ShipFlight()
  flight.enterFrom(new THREE.Vector3(0,0,100000), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI), 0)
  for (let i=0;i<3600;i++) flight.update(1/60, { throttle:1,pitch:0,yaw:0,roll:0 }, { gas:false, planetRadius:25000, sampleSurfaceRadius:()=>25000 })
  // Check the actual flight readout rather than the configured constant.
  const speed = flight.getReadout().speed
  assert(speed > 11000 && speed <= 12001, `Space cruise speed: ${speed}`)
  return { hemisphereTransitions:transitions, cruiseMetersPerSecond:speed }
}

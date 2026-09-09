import { schema, table, t } from 'spacetimedb/server';

// ── Tabelas ────────────────────────────────────────────────

export const player = table(
  { name: 'player', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().unique(),
    name: t.string(),
    connected: t.bool(),
    lastSeen: t.timestamp(),
  }
);

export const celestialBody = table(
  { name: 'celestial_body', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    isSun: t.bool(),
    orbitRadius: t.f32(),
    bodySize: t.f32(),
    color: t.string(),
    angle: t.f32(),
    speed: t.f32(),
    rotationAngle: t.f32(),
    rotationSpeed: t.f32(),
    axialTilt: t.f32(),
    orbitalInclination: t.f32(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
  }
);

export const planetParams = table(
  { name: 'planet_params', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    bodyId: t.u64(),
    seed: t.u64(),
    planetType: t.string(),
    waterLevel: t.f32(),
    terrainScale: t.f32(),
    colorA: t.string(),
    colorB: t.string(),
    atmosphereColor: t.string(),
    atmosphereDensity: t.f32(),
  }
);

// Versioned editor settings are data; the server does not render or simulate terrain.
export const planetAppearance = table({ name: 'planet_appearance', public: true }, {
  bodyId: t.u64().primaryKey(), revision: t.u32(), settingsJson: t.string(),
});
export const worldClock = table({ name: 'world_clock', public: true }, {
  id: t.u32().primaryKey(), epoch: t.timestamp(),
});
export const pose = t.object('Pose', {
  frame: t.string(), x: t.f64(), y: t.f64(), z: t.f64(),
  qx: t.f64(), qy: t.f64(), qz: t.f64(), qw: t.f64(),
});
export const explorerState = table({ name: 'explorer_state', public: true }, {
  identity: t.identity().primaryKey(), mode: t.string(), playerPose: pose,
  shipPose: pose, speed: t.f32(), grounded: t.bool(), updatedAt: t.timestamp(),
});
const spacetimedb = schema({ player, celestialBody, planetParams, planetAppearance, worldClock, explorerState });
export default spacetimedb;

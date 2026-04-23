import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import spacetimedb, { TICK_INTERVAL } from './schema';
import { SOLAR_SYSTEM, SUN_CONFIG } from './seed';

// Re-exportar reducer agendado (necessario para SpacetimeDB resolveSchedules)
export { update_orbits } from './schema';

const DEFAULT_PLAYER_NAME = 'Explorer';

export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  let hasBodies = false;
  for (const _ of ctx.db.celestialBody.iter()) {
    hasBodies = true;
    break;
  }
  if (hasBodies) return;

  // Sol
  ctx.db.celestialBody.insert({
    id: 0n,
    name: SUN_CONFIG.name,
    isSun: true,
    orbitRadius: 0,
    bodySize: SUN_CONFIG.bodySize,
    color: SUN_CONFIG.color,
    angle: 0,
    speed: 0,
    rotationAngle: 0,
    rotationSpeed: SUN_CONFIG.rotationSpeed,
    axialTilt: SUN_CONFIG.axialTilt,
    orbitalInclination: 0,
    x: 0,
    y: 0,
    z: 0,
  });

  // Planetas
  for (const p of SOLAR_SYSTEM) {
    const x = p.orbitRadius * Math.cos(p.startAngle);
    const z = p.orbitRadius * Math.sin(p.startAngle);
    ctx.db.celestialBody.insert({
      id: 0n,
      name: p.name,
      isSun: false,
      orbitRadius: p.orbitRadius,
      bodySize: p.bodySize,
      color: p.color,
      angle: p.startAngle,
      speed: p.orbitSpeed,
      rotationAngle: 0,
      rotationSpeed: p.rotationSpeed,
      axialTilt: p.axialTilt,
      orbitalInclination: p.orbitalInclination,
      x,
      y: p.orbitRadius * Math.sin(p.orbitalInclination) * Math.sin(p.startAngle),
      z,
    });
  }

  // Agendar primeiro tick
  ctx.db.orbitTick.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + TICK_INTERVAL),
  });
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  const player = ctx.db.player.identity.find(ctx.sender);

  if (player) {
    ctx.db.player.id.update({
      ...player,
      connected: true,
      lastSeen: ctx.timestamp,
    });
    return;
  }

  ctx.db.player.insert({
    id: 0n,
    identity: ctx.sender,
    name: DEFAULT_PLAYER_NAME,
    connected: true,
    lastSeen: ctx.timestamp,
  });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const player = ctx.db.player.identity.find(ctx.sender);

  if (!player) return;

  ctx.db.player.id.update({
    ...player,
    connected: false,
    lastSeen: ctx.timestamp,
  });
});

export const set_name = spacetimedb.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    const nextName = name.trim();

    if (!nextName) {
      throw new SenderError('Name is required');
    }

    if (nextName.length > 24) {
      throw new SenderError('Name must be 24 characters or fewer');
    }

    const player = ctx.db.player.identity.find(ctx.sender);

    if (!player) {
      ctx.db.player.insert({
        id: 0n,
        identity: ctx.sender,
        name: nextName,
        connected: true,
        lastSeen: ctx.timestamp,
      });
      return;
    }

    ctx.db.player.id.update({
      ...player,
      name: nextName,
      lastSeen: ctx.timestamp,
    });
  }
);

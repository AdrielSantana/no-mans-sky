import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import spacetimedb, { TICK_INTERVAL } from './schema';

// Re-exportar reducer agendado (necessario para SpacetimeDB resolveSchedules)
export { update_orbits } from './schema';

const DEFAULT_PLAYER_NAME = 'Explorer';

export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  // Evitar re-seed se ja existem corpos celestes
  let hasBodies = false;
  for (const _ of ctx.db.celestialBody.iter()) {
    hasBodies = true;
    break;
  }
  if (hasBodies) return;

  // Sol
  ctx.db.celestialBody.insert({
    id: 0n,
    name: 'Sol',
    isSun: true,
    orbitRadius: 0,
    bodySize: 1.5,
    color: '#ffcc00',
    angle: 0,
    speed: 0,
    rotationAngle: 0,
    rotationSpeed: 0.01,
    x: 0,
    y: 0,
    z: 0,
  });

  // Planetas
  const planets: Array<{
    name: string;
    orbitRadius: number;
    bodySize: number;
    color: string;
    angle: number;
    speed: number;
    rotationSpeed: number;
  }> = [
    { name: 'Mercurio', orbitRadius: 4, bodySize: 0.3, color: '#aaaaaa', angle: 0, speed: 0.04, rotationSpeed: 0.005 },
    { name: 'Venus', orbitRadius: 6, bodySize: 0.6, color: '#e8a040', angle: 1.2, speed: 0.025, rotationSpeed: 0.008 },
    { name: 'Terra', orbitRadius: 8.5, bodySize: 0.65, color: '#4488ff', angle: 2.8, speed: 0.018, rotationSpeed: 0.02 },
    { name: 'Marte', orbitRadius: 11, bodySize: 0.45, color: '#cc4422', angle: 4.1, speed: 0.012, rotationSpeed: 0.019 },
    { name: 'Jupiter', orbitRadius: 15, bodySize: 1.2, color: '#d4a060', angle: 5.5, speed: 0.006, rotationSpeed: 0.04 },
  ];

  for (const p of planets) {
    const x = p.orbitRadius * Math.cos(p.angle);
    const z = p.orbitRadius * Math.sin(p.angle);
    ctx.db.celestialBody.insert({
      id: 0n,
      name: p.name,
      isSun: false,
      orbitRadius: p.orbitRadius,
      bodySize: p.bodySize,
      color: p.color,
      angle: p.angle,
      speed: p.speed,
      rotationAngle: 0,
      rotationSpeed: p.rotationSpeed,
      x,
      y: 0,
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

import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

export const player = table(
  {
    name: 'player',
    public: true,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().unique(),
    name: t.string(),
    connected: t.bool(),
    lastSeen: t.timestamp(),
  }
);

export const celestialBody = table(
  {
    name: 'celestial_body',
    public: true,
  },
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
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
  }
);

// Placeholder resolvido em runtime - o reducer e definido abaixo
let updateOrbitsReducer: ReturnType<any> | undefined;

export const orbitTick = table(
  {
    name: 'orbit_tick',
    scheduled: () => updateOrbitsReducer,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({ player, celestialBody, orbitTick });

export const TICK_INTERVAL = 50_000n; // 50ms em microssegundos (50.000 µs)

export const update_orbits = spacetimedb.reducer(
  { arg: orbitTick.rowType },
  (ctx, { arg }) => {
    for (const body of ctx.db.celestialBody.iter()) {
      if (body.isSun) {
        ctx.db.celestialBody.id.update({
          ...body,
          rotationAngle: body.rotationAngle + body.rotationSpeed,
        });
        continue;
      }

      const newAngle = body.angle + body.speed;
      const x = body.orbitRadius * Math.cos(newAngle);
      const z = body.orbitRadius * Math.sin(newAngle);

      ctx.db.celestialBody.id.update({
        ...body,
        angle: newAngle,
        rotationAngle: body.rotationAngle + body.rotationSpeed,
        x,
        z,
      });
    }

    ctx.db.orbitTick.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + TICK_INTERVAL),
    });
  }
);
updateOrbitsReducer = update_orbits;

export default spacetimedb;

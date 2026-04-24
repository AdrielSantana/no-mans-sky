import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

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

// Referencia lazy: o reducer e definido abaixo, apos schema().
// O () => wrapper so e avaliado em runtime, quando ambos existem.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _updateOrbitsRef: any;

export const orbitTick = table(
  {
    name: 'orbit_tick',
    scheduled: () => _updateOrbitsRef,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

// ── Schema ─────────────────────────────────────────────────

const spacetimedb = schema({ player, celestialBody, planetParams, orbitTick });

// ── Scheduled reducer ──────────────────────────────────────
// Precisa ficar em schema.ts pois a tabela orbitTick referencia
// este reducer via scheduled: () => ...

export const TICK_INTERVAL = 50_000n; // 50ms (50.000 microssegundos)

export const update_orbits = spacetimedb.reducer(
  { arg: orbitTick.rowType },
  (ctx, { arg: _arg }) => {
    for (const body of ctx.db.celestialBody.iter()) {
      if (body.isSun) {
        ctx.db.celestialBody.id.update({
          ...body,
          rotationAngle: body.rotationAngle + body.rotationSpeed,
        });
        continue;
      }

      const newAngle = body.angle + body.speed;
      const incl = body.orbitalInclination;

      ctx.db.celestialBody.id.update({
        ...body,
        angle: newAngle,
        rotationAngle: body.rotationAngle + body.rotationSpeed,
        x: body.orbitRadius * Math.cos(newAngle),
        y: body.orbitRadius * Math.sin(incl) * Math.sin(newAngle),
        z: body.orbitRadius * Math.cos(incl) * Math.sin(newAngle),
      });
    }

    ctx.db.orbitTick.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + TICK_INTERVAL),
    });
  }
);
_updateOrbitsRef = update_orbits;

export default spacetimedb;

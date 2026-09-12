import { SenderError, t } from 'spacetimedb/server';
import type { ReducerCtx } from 'spacetimedb/server';
import spacetimedb, { pose } from './schema';
import { WORLD_CATALOG, WORLD_REVISION } from './shared/world-catalog';
const DEFAULT_PLAYER_NAME = 'Explorer';
export default spacetimedb;

function applyCatalogue(ctx: ReducerCtx<typeof spacetimedb.schemaType>) {
  if (!ctx.db.worldClock.id.find(0)) ctx.db.worldClock.insert({ id: 0, epoch: ctx.timestamp });
  if (!Array.from(ctx.db.celestialBody.iter()).some(b => b.isSun)) ctx.db.celestialBody.insert({ id: 0n, name: 'Sol', isSun: true,
    orbitRadius: 0, bodySize: 12000, color: '#ffe3ba', angle: 0, speed: 0,
    rotationAngle: 0, rotationSpeed: 0.0001, axialTilt: 0, orbitalInclination: 0, x: 0, y: 0, z: 0 });
  for (const entry of WORLD_CATALOG) {
    const p = entry.settings;
    const existing = Array.from(ctx.db.celestialBody.iter()).find(b => b.name === entry.name && !b.isSun);
    const definition = { id: existing?.id ?? 0n, name: entry.name, isSun: false,
      orbitRadius: entry.orbitRadius, bodySize: p.planetRadius, color: p.colorA,
      angle: entry.startAngle, speed: entry.orbitSpeed, rotationAngle: 0,
      rotationSpeed: entry.rotationSpeed, axialTilt: entry.axialTilt,
      orbitalInclination: entry.orbitalInclination,
      x: entry.orbitRadius * Math.cos(entry.startAngle),
      y: entry.orbitRadius * Math.sin(entry.orbitalInclination) * Math.sin(entry.startAngle),
      z: entry.orbitRadius * Math.cos(entry.orbitalInclination) * Math.sin(entry.startAngle) };
    const body = existing ? ctx.db.celestialBody.id.update(definition) : ctx.db.celestialBody.insert(definition);
    const previousParams = Array.from(ctx.db.planetParams.iter()).find(p => p.bodyId === body.id);
    const parameters = { id: previousParams?.id ?? 0n, bodyId: body.id, seed: BigInt(p.seed),
      planetType: p.planetType, waterLevel: p.waterEnabled ? p.waterLevel : 0,
      terrainScale: p.terrainScale, colorA: p.colorA, colorB: p.colorB,
      atmosphereColor: p.atmosphereColor, atmosphereDensity: p.atmosphereDensity };
    if (previousParams) ctx.db.planetParams.id.update(parameters); else ctx.db.planetParams.insert(parameters);
    const appearance = { bodyId: body.id, revision: WORLD_REVISION, settingsJson: JSON.stringify(p) };
    if (ctx.db.planetAppearance.bodyId.find(body.id)) ctx.db.planetAppearance.bodyId.update(appearance);
    else ctx.db.planetAppearance.insert(appearance);
  }
}

export const init = spacetimedb.init(applyCatalogue);
// No input: applies only the catalogue compiled into this module. Idempotent.
export const refresh_catalogue = spacetimedb.reducer(applyCatalogue);

export const onConnect = spacetimedb.clientConnected(ctx => {
  // A new module can add/update profiles without resetting player data.
  const appearances = Array.from(ctx.db.planetAppearance.iter());
  if (WORLD_CATALOG.some(entry => !appearances.some(a => a.settingsJson === JSON.stringify(entry.settings)))) applyCatalogue(ctx);
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

const CHAT_CHANNELS = ['global', 'body', 'local'];
const CHAT_BODY_LIMIT = 240;
// History is capped per channel and place rather than globally: a busy planet
// must not push the system-wide channel out of every client's cache. The cap is
// what makes subscribing to the whole table affordable.
const CHAT_HISTORY_PER_SCOPE = 80;

function isPlanet(ctx: ReducerCtx<typeof spacetimedb.schemaType>, id: string) {
  return Array.from(ctx.db.celestialBody.iter()).some(b => b.id.toString() === id && !b.isSun);
}

// Same client-authority split as sync_state: the client says where it is, the
// server owns who is speaking, when, and how much history survives.
export const send_chat = spacetimedb.reducer({
  channel: t.string(), scope: t.string(), body: t.string(),
  x: t.f64(), y: t.f64(), z: t.f64(),
}, (ctx, message) => {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) throw new SenderError('Connect first');
  if (!CHAT_CHANNELS.includes(message.channel)) throw new SenderError('Invalid channel');
  const body = message.body.trim();
  if (!body) throw new SenderError('Message is required');
  if (body.length > CHAT_BODY_LIMIT) throw new SenderError(`Message must be ${CHAT_BODY_LIMIT} characters or fewer`);
  const global = message.channel === 'global';
  const scope = global ? '' : message.scope;
  if (message.channel === 'body' && !isPlanet(ctx, scope)) throw new SenderError('Unknown celestial body');
  if (message.channel === 'local' && scope !== 'space' && !isPlanet(ctx, scope)) throw new SenderError('Unknown reference frame');
  if (![message.x, message.y, message.z].every(Number.isFinite)) throw new SenderError('Non-finite origin');

  ctx.db.chatMessage.insert({
    id: 0n, channel: message.channel, scope,
    senderIdentity: ctx.sender, senderName: player.name, body,
    x: global ? 0 : message.x, y: global ? 0 : message.y, z: global ? 0 : message.z,
    sentAt: ctx.timestamp,
  });

  // Scope is filtered here rather than through the index: a composite index
  // would cover it, but its filter panics in 2.1.0.
  const history = Array.from(ctx.db.chatMessage.chat_message_channel.filter(message.channel))
    .filter(row => row.scope === scope)
    .sort((a, b) => Number(a.sentAt.microsSinceUnixEpoch - b.sentAt.microsSinceUnixEpoch) || Number(a.id - b.id));
  for (const row of history.slice(0, Math.max(0, history.length - CHAT_HISTORY_PER_SCOPE))) {
    ctx.db.chatMessage.id.delete(row.id);
  }

  ctx.db.player.id.update({ ...player, lastSeen: ctx.timestamp });
});

// Client-authority: only ownership and payload validity live here. No speed,
// collision, landing, gravity, or terrain simulation is repeated on the server.
export const sync_state = spacetimedb.reducer({
  mode: t.string(), playerPose: pose, shipPose: pose, speed: t.f32(), grounded: t.bool(),
}, (ctx, state) => {
  if (!ctx.db.player.identity.find(ctx.sender)) throw new SenderError('Connect first');
  if (!['free', 'walking', 'boarding', 'piloting', 'takingOff', 'flying', 'landing', 'disembarking'].includes(state.mode)) {
    throw new SenderError('Invalid mode');
  }
  for (const value of [state.playerPose, state.shipPose]) {
    if (![value.x, value.y, value.z, value.qx, value.qy, value.qz, value.qw, state.speed].every(Number.isFinite)) {
      throw new SenderError('Non-finite pose');
    }
    if (Math.hypot(value.qx, value.qy, value.qz, value.qw) < 0.5) throw new SenderError('Invalid rotation');
    if (value.frame !== 'space' && !isPlanet(ctx, value.frame)) throw new SenderError('Unknown reference frame');
  }
  const row = { ...state, identity: ctx.sender, updatedAt: ctx.timestamp };
  if (ctx.db.explorerState.identity.find(ctx.sender)) ctx.db.explorerState.identity.update(row);
  else ctx.db.explorerState.insert(row);
});

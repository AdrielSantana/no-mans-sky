import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';

const DEFAULT_PLAYER_NAME = 'Explorer';

export default spacetimedb;

export const init = spacetimedb.init(_ctx => {});

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

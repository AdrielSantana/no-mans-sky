import { schema, table, t } from 'spacetimedb/server';

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

export default schema({ player });

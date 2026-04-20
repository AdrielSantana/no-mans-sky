# No Man's Sky

Starter workspace for a React/Vite client backed by a TypeScript SpacetimeDB module.

## Requirements

- Node.js 22+
- pnpm 10+
- SpacetimeDB CLI 2.1+

## Setup

```bash
pnpm install
pnpm spacetime:generate
```

## Development

Start SpacetimeDB locally in one terminal:

```bash
pnpm spacetime:start
```

Publish/run the module in another terminal:

```bash
pnpm dev:server
```

Run the Vite client:

```bash
pnpm dev
```

The default local database name is `no-mans-sky`. Client connection settings can be overridden with:

```bash
VITE_SPACETIMEDB_URI=ws://127.0.0.1:3000
VITE_SPACETIMEDB_DATABASE=no-mans-sky
```

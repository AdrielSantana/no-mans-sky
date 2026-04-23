import { useMemo } from 'react'
import { SpacetimeDBProvider } from 'spacetimedb/react'
import App from './App'
import { DbConnection } from './module_bindings'

const SPACETIME_TOKEN_KEY = 'no-mans-sky.spacetime-token'
const SPACETIME_URI =
  import.meta.env.VITE_SPACETIMEDB_URI ?? 'ws://127.0.0.1:3000'
const SPACETIME_DATABASE =
  import.meta.env.VITE_SPACETIMEDB_DATABASE ?? 'no-mans-sky'

function Root() {
  const connectionBuilder = useMemo(
    () =>
      DbConnection.builder()
        .withUri(SPACETIME_URI)
        .withDatabaseName(SPACETIME_DATABASE)
        .withToken(localStorage.getItem(SPACETIME_TOKEN_KEY) ?? undefined)
        .onConnect((conn, _identity, token) => {
          localStorage.setItem(SPACETIME_TOKEN_KEY, token)
          conn.subscriptionBuilder().subscribe(['SELECT * FROM celestial_body', 'SELECT * FROM player'])
        }),
    [],
  )

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  )
}

export default Root

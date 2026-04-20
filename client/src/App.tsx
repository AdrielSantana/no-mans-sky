import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  useReducer as useSpacetimeReducer,
  useSpacetimeDB,
  useTable,
} from 'spacetimedb/react'
import './App.css'
import starshipUrl from './assets/starship.svg'
import { reducers, tables } from './module_bindings'
import type { Player } from './module_bindings/types'

type AppProps = {
  databaseName: string
}

function formatLastSeen(player: Player) {
  return player.lastSeen.toDate().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function App({ databaseName }: AppProps) {
  const { connectionError, identity, isActive } = useSpacetimeDB()
  const [players, isReady] = useTable(tables.player)
  const setName = useSpacetimeReducer(reducers.setName)
  const [name, setNameInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const ownIdentity = identity?.toHexString()
  const currentPlayer = useMemo(
    () =>
      players.find((player) => player.identity.toHexString() === ownIdentity),
    [ownIdentity, players],
  )
  const onlinePlayers = players.filter((player) => player.connected)
  const statusLabel = isActive
    ? isReady
      ? 'Conectado'
      : 'Sincronizando'
    : 'Aguardando servidor'

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextName = name.trim()

    if (!nextName) {
      setFormError('Informe um nome para o explorador.')
      return
    }

    setIsSaving(true)
    setFormError(null)

    try {
      await setName({ name: nextName })
      setNameInput('')
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Nao foi possivel salvar.',
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="intro">
        <div className="intro-copy">
          <p className="eyebrow">SpacetimeDB local</p>
          <h1>Exploradores conectados</h1>
          <p className="intro-text">
            Banco <strong>{databaseName}</strong>. Use o servidor local para
            entrar, renomear seu explorador e ver a lista em tempo real.
          </p>
        </div>
        <img className="ship-art" src={starshipUrl} alt="" />
      </section>

      <section className="control-surface" aria-label="Sessao do jogador">
        <div className="status-row">
          <span className={isActive ? 'status online' : 'status offline'}>
            {statusLabel}
          </span>
          {ownIdentity ? (
            <span className="identity">ID {ownIdentity.slice(0, 12)}</span>
          ) : (
            <span className="identity">Identidade pendente</span>
          )}
        </div>

        <form className="name-form" onSubmit={handleSubmit}>
          <label htmlFor="player-name">Nome do explorador</label>
          <div className="form-row">
            <input
              id="player-name"
              maxLength={24}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder={currentPlayer?.name ?? 'Explorer'}
              value={name}
            />
            <button disabled={!isActive || isSaving} type="submit">
              {isSaving ? 'Salvando' : 'Salvar nome'}
            </button>
          </div>
          {formError ? <p className="form-error">{formError}</p> : null}
          {connectionError ? (
            <p className="form-error">{connectionError.message}</p>
          ) : null}
        </form>
      </section>

      <section className="roster" aria-label="Jogadores">
        <div className="roster-heading">
          <div>
            <p className="eyebrow">Online</p>
            <h2>{onlinePlayers.length} jogadores</h2>
          </div>
          <p>{isReady ? 'Atualizado em tempo real' : 'Carregando dados'}</p>
        </div>

        {players.length > 0 ? (
          <ul className="player-list">
            {players.map((player) => (
              <li key={player.id.toString()}>
                <span
                  className={
                    player.connected ? 'presence active' : 'presence idle'
                  }
                />
                <div>
                  <strong>{player.name}</strong>
                  <span>{formatLastSeen(player)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            Nenhum explorador sincronizado ainda.
          </p>
        )}
      </section>
    </main>
  )
}

export default App

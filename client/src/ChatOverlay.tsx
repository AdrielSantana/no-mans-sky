import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CHAT_CHANNELS, type ChatChannel, type ChatEntry, type ChatStore } from './game/chat'
import { textEntry } from './game/text-entry'
import './ChatOverlay.css'

const CHANNEL_LABEL: Record<ChatChannel, string> = {
  global: 'Global',
  body: 'Corpo celeste',
  local: 'Local',
}
const MESSAGE_LIMIT = 240
/** How long an unopened message stays on the HUD before it fades out. */
const RECENT_MS = 15000
const RECENT_LIMIT = 6

export function ChatOverlay({ store, canvas }: { store: ChatStore; canvas: () => HTMLCanvasElement | null }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  /** Whether the game held the mouse when the chat opened, to hand it back. */
  const heldPointer = useRef(false)
  const [now, setNow] = useState(() => Date.now())

  const openChat = useCallback(() => {
    const element = canvas()
    heldPointer.current = !!element && document.pointerLockElement === element
    if (heldPointer.current) document.exitPointerLock()
    textEntry.set(true)
    store.setOpen(true)
  }, [store, canvas])

  const closeChat = useCallback(() => {
    // Read and cleared first: blurring the input fires onBlur, which closes the
    // chat again from inside this call. Whoever gets here first owns the mouse.
    const restorePointer = heldPointer.current
    heldPointer.current = false
    store.setOpen(false)
    textEntry.set(false)
    inputRef.current?.blur()
    const element = canvas()
    if (restorePointer && element && document.pointerLockElement !== element) {
      // Requested from inside the keystroke that closed the chat, which is the
      // user gesture browsers ask for. Chrome still refuses for about a second
      // after a lock the player left with Escape; clicking the canvas recovers.
      void Promise.resolve(element.requestPointerLock()).catch(() => {})
    }
  }, [store, canvas])

  // Esc throws the draft away. Losing focus only closes: alt-tabbing mid-sentence
  // should not cost the sentence.
  const discardChat = useCallback(() => {
    store.setDraft('')
    closeChat()
  }, [store, closeChat])

  // The flag is module-global and every game key handler early-returns on it, so
  // an overlay that unmounts while open -- an HMR reload mid-sentence -- would
  // leave the game with no keyboard and no way back but a page reload.
  useEffect(() => () => textEntry.set(false), [])

  // A rejected message keeps the chat open so its notice can be read, and the
  // draft stays in the box. Closing on a failed send would swallow both.
  const submit = () => {
    if (!snapshot.draft.trim()) discardChat()
    else if (store.send()) closeChat()
  }

  // Capture phase: the walker and the ship listen for keys on `window` too, and
  // at the same target capture always runs before bubble. So the typing flag is
  // already set by the time they see the Enter that opened the chat.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Read through the store rather than a captured render value: this handler
      // outlives the render that installed it.
      if (store.getSnapshot().open || event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return
      event.preventDefault()
      openChat()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openChat, store])

  useEffect(() => { if (snapshot.open) inputRef.current?.focus() }, [snapshot.open])

  // The closed HUD fades messages out by age, so it needs a clock of its own.
  // The open panel keeps everything, and does not.
  useEffect(() => {
    if (snapshot.open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [snapshot.open])

  const messages = snapshot.audible[snapshot.channel]
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages, snapshot.open])

  // Faded by when the message reached this client, not by the server's clock:
  // the two disagree, and the HUD must not depend on the difference.
  const recent = useMemo(() => CHAT_CHANNELS
    .flatMap(channel => snapshot.audible[channel])
    .filter(entry => entry.seenAt > 0 && now - entry.seenAt < RECENT_MS)
    .sort((a, b) => a.sentAt - b.sentAt)
    .slice(-RECENT_LIMIT), [snapshot.audible, now])

  const cycleChannel = (backwards: boolean) => {
    const index = CHAT_CHANNELS.indexOf(snapshot.channel)
    const count = CHAT_CHANNELS.length
    store.setChannel(CHAT_CHANNELS[(index + (backwards ? count - 1 : 1)) % count])
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter and Escape are how an IME commits and cancels a candidate, and on
    // macOS that includes the dead keys that write "ção". While a composition is
    // open they belong to it, not to the chat.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') { event.preventDefault(); submit() }
    else if (event.key === 'Escape') { event.preventDefault(); discardChat() }
    else if (event.key === 'Tab') { event.preventDefault(); cycleChannel(event.shiftKey) }
  }

  if (!snapshot.open) {
    return <div className="chat chat--closed">
      {recent.map(entry => <Message key={entry.id} entry={entry} />)}
      <div className="chat__hint">Enter — conversar</div>
    </div>
  }

  // The body channel with no world in range stays typable on purpose: a disabled
  // box takes no focus, and with no focus there is no Escape to close the chat.
  const placeless = snapshot.channel === 'body' && !snapshot.bodyName
  return <div
    className="chat chat--open"
    // Clicking anywhere in the panel but the box itself keeps the caret where it
    // is: reading back through the log, or switching channels, must not blur the
    // input and close the chat. Clicking the canvas still does, which is how the
    // player gets back to flying.
    onMouseDown={event => { if (event.target !== inputRef.current) event.preventDefault() }}
  >
    <div className="chat__tabs">
      {CHAT_CHANNELS.map(channel => <button
        key={channel}
        type="button"
        className={`chat__tab chat__tab--${channel}${channel === snapshot.channel ? ' is-active' : ''}`}
        onClick={() => store.setChannel(channel)}
      >
        {channel === 'body' ? snapshot.bodyName ?? CHANNEL_LABEL.body : CHANNEL_LABEL[channel]}
        {snapshot.unread[channel] > 0 && <span className="chat__badge">{snapshot.unread[channel]}</span>}
      </button>)}
    </div>
    <div className="chat__log" ref={logRef}>
      {messages.length === 0
        ? <div className="chat__empty">{describeEmpty(snapshot.channel, snapshot.bodyName)}</div>
        : messages.map(entry => <Message key={entry.id} entry={entry} timestamped />)}
    </div>
    <input
      ref={inputRef}
      className="chat__input"
      value={snapshot.draft}
      maxLength={MESSAGE_LIMIT}
      placeholder={placeless ? 'Nenhum corpo celeste ao alcance' : `Falar em ${label(snapshot, snapshot.channel).toLowerCase()}…`}
      onChange={event => store.setDraft(event.target.value)}
      onKeyDown={onInputKeyDown}
      onBlur={closeChat}
    />
    <div className="chat__hint">
      {snapshot.notice
        ? <span className="chat__notice">{snapshot.notice}</span>
        : <>Enter — enviar · Esc — fechar · Tab — trocar de canal{snapshot.draft.length > MESSAGE_LIMIT - 40 && <span> · {MESSAGE_LIMIT - snapshot.draft.length}</span>}</>}
    </div>
  </div>
}

function Message({ entry, timestamped = false }: { entry: ChatEntry; timestamped?: boolean }) {
  return <div className={`chat__message chat__message--${entry.channel}`}>
    {timestamped && <span className="chat__time">{formatTime(entry.sentAt)}</span>}
    <span className="chat__channel">[{CHANNEL_LABEL[entry.channel].slice(0, 1)}]</span>
    <span className={`chat__sender${entry.own ? ' is-own' : ''}`}>{entry.senderName}</span>
    <span className="chat__body">{entry.body}</span>
  </div>
}

function label(snapshot: { bodyName: string | null }, channel: ChatChannel) {
  return channel === 'body' ? snapshot.bodyName ?? CHANNEL_LABEL.body : CHANNEL_LABEL[channel]
}

function describeEmpty(channel: ChatChannel, bodyName: string | null) {
  if (channel === 'global') return 'Nada dito no sistema ainda.'
  if (channel === 'local') return 'Ninguém falou por aqui.'
  return bodyName ? `Nada dito em ${bodyName} ainda.` : 'Aproxime-se de um corpo celeste para falar com quem está nele.'
}

function formatTime(milliseconds: number) {
  return new Date(milliseconds).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

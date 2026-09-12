import * as THREE from 'three'
import type { DbConnection } from '../module_bindings'
import type { ChatMessage } from '../module_bindings/types'
import type { CelestialSystem } from './celestial-system'
import type { PlanetWalkerTarget } from './planet-walker-controller'

export type ChatChannel = 'global' | 'body' | 'local'
export const CHAT_CHANNELS: readonly ChatChannel[] = ['global', 'body', 'local']

/** Earshot. Covers a landing site and the walk back to it, not the horizon. */
export const LOCAL_CHAT_RADIUS_METERS = 1200
/**
 * A world counts as "where you are" out to one radius above its own surface.
 * The catalogue's orbits are at least 100 km apart and the radii top out at
 * 40 km, so the bands never overlap: there is no ambiguity about which body
 * channel an explorer is in, and between the worlds there is no body channel.
 */
const BODY_RANGE_FACTOR = 1

export interface ChatEntry {
  id: string
  channel: ChatChannel
  senderName: string
  own: boolean
  body: string
  /** Server time, in milliseconds. Orders the log and labels each line. */
  sentAt: number
  /**
   * When this client first saw the message, on its own clock. The HUD fades by
   * this and not by `sentAt`: the two clocks disagree, and a machine a minute
   * fast would hide every message the moment it arrived. Zero for the history
   * that was already there on connect, which belongs in the panel, not on screen.
   */
  seenAt: number
}

export interface ChatSnapshot {
  open: boolean
  channel: ChatChannel
  draft: string
  notice: string
  /** The world the body channel is bound to, or null when none is in range. */
  bodyName: string | null
  /** Oldest first. Only what this explorer can actually hear. */
  audible: Record<ChatChannel, readonly ChatEntry[]>
  unread: Record<ChatChannel, number>
}

/** A local message keeps the origin in its sender's frame, resolved per tick. */
interface PlacedEntry {
  entry: ChatEntry
  scope: string
  origin: THREE.Vector3
}

const NO_ENTRIES: readonly ChatEntry[] = []

/**
 * Reads the chat table into the shape the overlay renders, and sends messages.
 *
 * Two of the three channels are places, and a place is only knowable here: the
 * table stores each message's origin in the frame its sender was in, and this is
 * where those frames resolve. So `local` is filtered per client rather than per
 * row, which is also what lets two explorers standing together hear each other
 * while one is on foot in the planet's frame and the other sits in a ship in the
 * world's.
 *
 * Rows change rarely and the player moves every frame, so the two are separated:
 * the table is re-read only when it actually changes, and each tick does no more
 * than the distance checks the movement invalidated.
 */
export class ChatStore {
  private readonly system: CelestialSystem
  private readonly listeners = new Set<() => void>()
  private readonly origin = new THREE.Vector3()
  private readonly scratch = new THREE.Vector3()
  private readonly inverse = new THREE.Quaternion()
  private connection: DbConnection | null = null
  private snapshot: ChatSnapshot = {
    open: false, channel: 'global', draft: '', notice: '', bodyName: null,
    audible: { global: NO_ENTRIES, body: NO_ENTRIES, local: NO_ENTRIES },
    unread: { global: 0, body: 0, local: 0 },
  }
  private signature = ''
  private channel: ChatChannel = 'global'
  private open = false
  private draft = ''
  private notice = ''
  /**
   * The newest message already put in front of the player, per channel *and*
   * place. Unread is derived from it instead of counted as rows arrive, so a
   * reconnect that replays the history does not invent a badge for old messages.
   * The place belongs in the key: arriving at a world whose channel holds talk
   * older than the last thing read elsewhere must not mark it read.
   */
  private readonly readMark = new Map<string, number>()
  // Rebuilt from the table only when a row is inserted or pruned away.
  private rowsStale = true
  /**
   * Bumped on every rebuild. The signature carries this instead of the list
   * lengths: at the history cap an insert prunes the oldest row in the same
   * transaction, so the length is unchanged and the lists are still new.
   */
  private rowsRevision = 0
  private firstConnectionRebuild = true
  private firstSeen = new Map<string, number>()
  private globalEntries: ChatEntry[] = []
  private bodyEntries = new Map<string, ChatEntry[]>()
  private placed: PlacedEntry[] = []
  private localEntries: ChatEntry[] = []
  private localSignature = ''

  constructor(system: CelestialSystem) { this.system = system }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = () => this.snapshot

  setOpen(open: boolean) {
    if (this.open === open) return
    this.open = open
    if (open) this.notice = ''
    this.refresh()
  }

  setChannel(channel: ChatChannel) {
    if (this.channel === channel) return
    this.channel = channel
    this.notice = ''
    this.refresh()
  }

  setDraft(draft: string) {
    if (this.draft === draft) return
    this.draft = draft
    this.refresh()
  }

  /**
   * Hands the draft to the server. False means it stayed in the box -- the
   * notice says why, and the overlay leaves the chat open so it can be read.
   */
  send(): boolean {
    const text = this.draft.trim()
    const connection = this.connection
    if (!text) return false
    if (!connection?.isActive) { this.notify('Sem conexão — a mensagem não foi enviada'); return false }
    const placed = this.channel !== 'global'
    const body = placed ? this.resolveBody() : null
    if (this.channel === 'body' && !body) { this.notify('Nenhum corpo celeste ao alcance'); return false }
    // The origin travels in the frame of its sender, the same convention the
    // poses use: written in the planet's frame it stays on the ground as the
    // world turns, which is what a conversation at a landing site expects.
    const origin = this.origin.set(0, 0, 0)
    const scope = placed ? body?.id ?? 'space' : ''
    if (placed) {
      origin.copy(this.system.engine.camera.position)
      if (body) origin.sub(body.worldPosition).applyQuaternion(this.inverse.copy(body.worldQuaternion).invert())
    }
    this.draft = ''
    this.notice = ''
    this.refresh()
    void connection.reducers.sendChat({
      channel: this.channel, scope, body: text, x: origin.x, y: origin.y, z: origin.z,
    }).catch(error => this.notify(`Envio: ${String(error)}`))
    return true
  }

  /** Called on the network tick: earshot and the nearest world both move. */
  sync(connection: DbConnection) {
    if (connection !== this.connection) {
      this.connection?.db.chatMessage.removeOnInsert(this.invalidate)
      this.connection?.db.chatMessage.removeOnDelete(this.invalidate)
      this.connection = connection
      connection.db.chatMessage.onInsert(this.invalidate)
      connection.db.chatMessage.onDelete(this.invalidate)
      this.rowsStale = true
      this.firstConnectionRebuild = true
    }
    this.refresh()
  }

  private readonly invalidate = () => { this.rowsStale = true }

  private notify(message: string) {
    this.notice = message
    this.refresh()
  }

  private refresh() {
    if (this.rowsStale) this.rebuildRows()
    const body = this.resolveBody()
    const bodyId = body?.id ?? null
    const bodyEntries = bodyId ? this.bodyEntries.get(bodyId) ?? NO_ENTRIES : NO_ENTRIES
    this.refreshEarshot()
    const audible: Record<ChatChannel, readonly ChatEntry[]> = {
      global: this.globalEntries, body: bodyEntries, local: this.localEntries,
    }

    const unread: Record<ChatChannel, number> = { global: 0, body: 0, local: 0 }
    for (const channel of CHAT_CHANNELS) {
      const entries = audible[channel]
      const latest = entries.length > 0 ? entries[entries.length - 1].sentAt : 0
      const key = `${channel}:${channel === 'global' ? '' : bodyId ?? 'space'}`
      // First sight of a place, and the channel being read, are both up to date.
      const mark = this.readMark.get(key)
      if (mark === undefined || (this.open && channel === this.channel)) this.readMark.set(key, latest)
      const since = this.readMark.get(key) ?? latest
      let count = 0
      for (const entry of entries) if (!entry.own && entry.sentAt > since) count += 1
      unread[channel] = count
    }

    const bodyName = bodyId ? this.system.names.get(bodyId) ?? null : null
    const signature = `${this.open}|${this.channel}|${this.draft}|${this.notice}|${bodyId}`
      + `|${this.rowsRevision}|${this.localSignature}`
      + `|${unread.global},${unread.body},${unread.local}`
    if (signature === this.signature) return
    this.signature = signature
    this.snapshot = { open: this.open, channel: this.channel, draft: this.draft, notice: this.notice, bodyName, audible, unread }
    for (const listener of this.listeners) listener()
  }

  private rebuildRows() {
    this.rowsStale = false
    this.rowsRevision += 1
    this.globalEntries = []
    this.bodyEntries.clear()
    this.placed = []
    const connection = this.connection
    if (!connection) return
    const ownIdentity = connection.identity?.toHexString() ?? ''
    // Carried across rebuilds so a message keeps the moment it arrived, and
    // dropped for rows the server pruned away.
    const previouslySeen = this.firstSeen
    const arrival = this.firstConnectionRebuild ? 0 : Date.now()
    this.firstConnectionRebuild = false
    this.firstSeen = new Map()
    const rows = [...connection.db.chatMessage.iter()]
    // Ordered by the server's clock, with the id only as a tie-break: auto
    // increment ids may have gaps, so they are no ordering on their own.
    rows.sort((a, b) => Number(a.sentAt.microsSinceUnixEpoch - b.sentAt.microsSinceUnixEpoch)
      || Number(a.id - b.id))
    for (const row of rows) {
      const channel = row.channel as ChatChannel
      if (channel !== 'global' && channel !== 'body' && channel !== 'local') continue
      const id = row.id.toString()
      const seenAt = previouslySeen.get(id) ?? arrival
      this.firstSeen.set(id, seenAt)
      const entry: ChatEntry = {
        id, channel, senderName: describeSender(row), body: row.body,
        own: row.senderIdentity.toHexString() === ownIdentity,
        sentAt: Number(row.sentAt.microsSinceUnixEpoch / 1000n),
        seenAt,
      }
      if (channel === 'global') this.globalEntries.push(entry)
      else if (channel === 'local') this.placed.push({ entry, scope: row.scope, origin: new THREE.Vector3(row.x, row.y, row.z) })
      else {
        const list = this.bodyEntries.get(row.scope)
        if (list) list.push(entry)
        else this.bodyEntries.set(row.scope, [entry])
      }
    }
  }

  /** Only the local channel depends on where the player is standing right now. */
  private refreshEarshot() {
    const eye = this.system.engine.camera.position
    let signature = ''
    for (const placed of this.placed) {
      if (this.worldOrigin(placed).distanceTo(eye) > LOCAL_CHAT_RADIUS_METERS) continue
      signature += `${placed.entry.id},`
    }
    if (signature === this.localSignature) return
    this.localSignature = signature
    this.localEntries = []
    for (const placed of this.placed) {
      if (this.worldOrigin(placed).distanceTo(eye) <= LOCAL_CHAT_RADIUS_METERS) this.localEntries.push(placed.entry)
    }
  }

  /** The world the explorer is at, by the reckoning the HUD's place readout uses. */
  private resolveBody(): PlanetWalkerTarget | null {
    const eye = this.system.engine.camera.position
    const nearest = this.system.nearestTarget(eye)
    if (!nearest) return null
    const altitude = eye.distanceTo(nearest.worldPosition) - nearest.terrain.radius
    return altitude <= nearest.terrain.radius * BODY_RANGE_FACTOR ? nearest : null
  }

  private worldOrigin(placed: PlacedEntry) {
    const point = this.scratch.copy(placed.origin)
    const target = this.system.targets.get(placed.scope)
    if (target) point.applyQuaternion(target.worldQuaternion).add(target.worldPosition)
    return point
  }
}

/**
 * Identities are anonymous and there is no naming step, so every explorer is
 * called the same thing. The tail of the identity is what tells two of them
 * apart in the log.
 */
function describeSender(row: ChatMessage) {
  return `${row.senderName} ${row.senderIdentity.toHexString().slice(-4)}`
}

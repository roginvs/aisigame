import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_HIDE_MS,
  PRESENCE_STALE_MS,
  applyPresence,
  forgetPlayer,
  lookupRememberedPlayer,
  mergeReturningPlayer,
  rememberPlayer,
  touch,
  type PresenceEntry,
} from './presence.ts'
import type { Player } from '../game/types.ts'
import { stickyPackPhase, type PackPhase } from './packProgress.ts'

export type RosterEntry = {
  clientId: string
  name: string
  playerId: number | null
  percent: number
  /** Оценка скорости приёма пакета у этого клиента, байт/с; null если ещё рано или готово. */
  downloadBps: number | null
  /** Оценка оставшегося времени передачи, секунды. */
  etaSeconds: number | null
  /** Фаза доставки пакета (соединение / загрузка / сверка). */
  packPhase: PackPhase
  ready: boolean
  hashOk: boolean
  lastSeen: number
  stale: boolean
  hidden: boolean
  isMaster: boolean
  /** Последний RTT ping/pong мастер ↔ клиент, мс; null — ещё не измерен. */
  pingMs?: number | null
}

export class ConferenceRoster {
  private entries = new Map<string, RosterEntry>()
  private masterClientId: string
  private masterName: string
  private nextPlayerId: number

  getMasterClientId(): string {
    return this.masterClientId
  }

  constructor(masterClientId: string, masterName: string, startPlayerId = 2) {
    this.masterClientId = masterClientId
    this.masterName = masterName
    this.nextPlayerId = startPlayerId
    const now = Date.now()
    touch(masterClientId, now)
    this.entries.set(masterClientId, {
      clientId: masterClientId,
      name: masterName,
      playerId: 1,
      percent: 100,
      downloadBps: null,
      etaSeconds: null,
      packPhase: 'ready',
      ready: true,
      hashOk: true,
      lastSeen: now,
      stale: false,
      hidden: false,
      isMaster: true,
    })
  }

  setMasterName(name: string): void {
    this.masterName = name.trim() || this.masterName
    const entry = this.entries.get(this.masterClientId)
    if (entry) this.entries.set(this.masterClientId, { ...entry, name: this.masterName })
  }

  upsertHello(clientId: string, name: string, now = Date.now()): RosterEntry {
    touch(clientId, now)
    const existing = this.entries.get(clientId)
    if (existing) {
      const next = { ...existing, name: name.trim() || existing.name, lastSeen: now }
      this.entries.set(clientId, this.withPresence(next, now))
      return this.withPresence(next, now)
    }
    const returning = mergeReturningPlayer(clientId, name, now)
    const playerId = returning?.playerId ?? null
    if (returning) {
      rememberPlayer({ clientId, playerId: returning.playerId, score: returning.score, name: returning.name })
    }
    const entry: RosterEntry = {
      clientId,
      name: name.trim() || 'Игрок',
      playerId,
      percent: 0,
      downloadBps: null,
      etaSeconds: null,
      packPhase: 'connecting',
      ready: false,
      hashOk: false,
      lastSeen: now,
      stale: false,
      hidden: false,
      isMaster: false,
    }
    this.entries.set(clientId, this.withPresence(entry, now))
    return entry
  }

  updateProgress(
    clientId: string,
    patch: Partial<
      Pick<RosterEntry, 'percent' | 'downloadBps' | 'etaSeconds' | 'ready' | 'hashOk' | 'packPhase'>
    >,
    now = Date.now(),
  ): void {
    const entry = this.entries.get(clientId)
    if (!entry) return
    touch(clientId, now)
    const next = { ...entry, ...patch, lastSeen: now }
    const percentExplicitlyZero = patch.percent === 0 && entry.percent > 0
    if (next.hashOk || next.percent >= 100) {
      next.downloadBps = null
      next.etaSeconds = null
      if (next.percent < 100 && next.hashOk) next.percent = 100
      if (next.hashOk) next.packPhase = next.ready ? 'ready' : 'verified'
    } else {
      next.packPhase = stickyPackPhase({
        previous: entry.packPhase,
        next: next.packPhase,
        percent: next.percent,
        hashOk: next.hashOk,
        ready: next.ready,
        percentExplicitlyZero,
      })
    }
    this.entries.set(clientId, this.withPresence(next, now))
  }

  assignPlayerId(clientId: string): number | null {
    const entry = this.entries.get(clientId)
    if (!entry || entry.playerId !== null) return entry?.playerId ?? null
    const remembered = lookupRememberedPlayer(clientId)
    const id = remembered?.playerId ?? this.nextPlayerId++
    this.nextPlayerId = Math.max(this.nextPlayerId, id + 1)
    this.entries.set(clientId, { ...entry, playerId: id })
    return id
  }

  /**
   * Восстанавливает устойчивую связь clientId -> playerId из сохранённой партии.
   * Сами отсутствующие клиенты не добавляются в видимый roster: они появятся после hello.
   */
  restorePlayers(players: readonly Player[]): void {
    const master =
      players.find((player) => player.clientId === this.masterClientId) ??
      players.find((player) => player.id === 1) ??
      players[0]
    if (master) {
      const current = this.entries.get(this.masterClientId)
      if (current) {
        this.masterName = master.name
        this.entries.set(this.masterClientId, {
          ...current,
          name: master.name,
          playerId: master.id,
        })
      }
      rememberPlayer({
        clientId: this.masterClientId,
        playerId: master.id,
        score: master.score,
        name: master.name,
      })
    }

    for (const player of players) {
      this.nextPlayerId = Math.max(this.nextPlayerId, player.id + 1)
      const savedClientId = player.clientId?.trim()
      if (!savedClientId || savedClientId === this.masterClientId) continue
      rememberPlayer({
        clientId: savedClientId,
        playerId: player.id,
        score: player.score,
        name: player.name,
      })
      const existing = this.entries.get(savedClientId)
      if (existing) {
        this.entries.set(savedClientId, { ...existing, name: player.name, playerId: player.id })
      }
    }
  }

  list(now = Date.now()): RosterEntry[] {
    return [...this.entries.values()]
      .map((entry) => this.withPresence(entry, now))
      .filter((entry) => !entry.hidden || entry.isMaster)
  }

  allIncludingHidden(now = Date.now()): RosterEntry[] {
    return [...this.entries.values()].map((entry) => this.withPresence(entry, now))
  }

  get(clientId: string): RosterEntry | undefined {
    return this.entries.get(clientId)
  }

  masterSeenWithin(ms: number, now = Date.now()): boolean {
    const entry = this.entries.get(this.masterClientId)
    if (!entry) return false
    return now - entry.lastSeen <= ms
  }

  /** RTT из pong — тоже признак жизни клиента. */
  setPing(clientId: string, pingMs: number, now = Date.now()): void {
    const entry = this.entries.get(clientId)
    if (!entry) return
    touch(clientId, now)
    this.entries.set(clientId, { ...entry, pingMs: Math.max(0, Math.round(pingMs)), lastSeen: now })
  }

  /** Скрытый гость (минута без вести) снят: ростер и память присутствия его больше не держат. */
  pruneHidden(now = Date.now()): void {
    for (const [clientId, entry] of this.entries) {
      if (entry.isMaster) continue
      if (now - entry.lastSeen >= PRESENCE_HIDE_MS) this.release(clientId)
    }
  }

  release(clientId: string): void {
    if (clientId === this.masterClientId) return
    this.entries.delete(clientId)
    forgetPlayer(clientId)
  }

  heartbeat(clientId: string, now = Date.now()): void {
    touch(clientId, now)
    const entry = this.entries.get(clientId)
    if (entry) this.entries.set(clientId, { ...entry, lastSeen: now })
  }

  static heartbeatIntervalMs = PRESENCE_HEARTBEAT_MS
  static staleMs = PRESENCE_STALE_MS
  static hideMs = PRESENCE_HIDE_MS

  private withPresence(entry: RosterEntry, now: number): RosterEntry {
    const views = applyPresence(
      [
        {
          clientId: entry.clientId,
          name: entry.name,
          lastSeen: entry.lastSeen,
          score: 0,
          playerId: entry.playerId ?? 0,
        } satisfies PresenceEntry,
      ],
      now,
    )
    const view = views[0]
    return { ...entry, stale: view?.stale ?? false, hidden: view?.hidden ?? false }
  }
}

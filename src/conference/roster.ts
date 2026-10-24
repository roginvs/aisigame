import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_HIDE_MS,
  PRESENCE_STALE_MS,
  applyPresence,
  forgetPlayer,
  lookupRememberedSeats,
  rememberPlayer,
  touch,
  type PresenceEntry,
} from './presence.ts'
import type { Player } from '../game/types.ts'
import { stickyPackPhase, type PackPhase } from './packProgress.ts'
import { rosterSeats, seatLabel, type RosterSeat } from './seats.ts'

export type { RosterSeat }

export type RosterEntry = {
  clientId: string
  /** Подпись устройства: одно имя или «Аня, Боря». */
  name: string
  /** Первое место. Игровые действия смотрят seats, не это поле. */
  playerId: number | null
  /** Места устройства. Нет поля — одно место из name/playerId. */
  seats?: RosterSeat[]
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

  constructor(masterClientId: string, masterName: string | readonly string[], startPlayerId = 2) {
    const seatNames = normalizeRosterNames(masterName)
    this.masterClientId = masterClientId
    this.masterName = seatLabel(seatNames)
    const seats = seatNames.map((name, index) => ({ name, playerId: index + 1 }))
    this.nextPlayerId = Math.max(startPlayerId, seatNames.length + 1)
    const now = Date.now()
    touch(masterClientId, now)
    this.entries.set(masterClientId, {
      clientId: masterClientId,
      name: this.masterName,
      playerId: seats[0]?.playerId ?? 1,
      seats,
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
    if (!entry) return
    const seats = rosterSeats(entry)
    const nextSeats = seats.length === 1 ? [{ name: this.masterName, playerId: seats[0]?.playerId ?? entry.playerId }] : seats
    this.entries.set(this.masterClientId, { ...entry, name: this.masterName, seats: nextSeats })
  }

  upsertHello(clientId: string, name: string | readonly string[], now = Date.now()): RosterEntry {
    touch(clientId, now)
    const names = normalizeRosterNames(name)
    const existing = this.entries.get(clientId)
    if (existing) {
      const locked = rosterSeats(existing).some((seat) => seat.playerId !== null)
      const seats = locked
        ? rosterSeats(existing)
        : names.map((seatName) => ({ name: seatName, playerId: null }))
      const next = {
        ...existing,
        name: locked ? existing.name : seatLabel(seats.map((seat) => seat.name)),
        playerId: locked ? existing.playerId : null,
        seats,
        lastSeen: now,
      }
      this.entries.set(clientId, this.withPresence(next, now))
      return this.withPresence(next, now)
    }
    const remembered = lookupRememberedSeats(clientId)
    const seats: RosterSeat[] = remembered?.length
      ? remembered.map((seat) => ({ name: seat.name, playerId: seat.playerId }))
      : names.map((seatName) => ({ name: seatName, playerId: null }))
    const playerId = seats[0]?.playerId ?? null
    if (remembered?.length) {
      rememberPlayer({
        clientId,
        playerId: remembered[0]?.playerId ?? 0,
        score: remembered[0]?.score ?? 0,
        name: remembered[0]?.name ?? names[0] ?? 'Игрок',
        seats: remembered,
      })
    }
    const entry: RosterEntry = {
      clientId,
      name: seatLabel(seats.map((seat) => seat.name)),
      playerId,
      seats,
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
    return this.assignSeats(clientId)[0] ?? null
  }

  /** Выдаёт id всем местам устройства, у которых его ещё нет. Уже выданные не двигает. */
  assignSeats(clientId: string): number[] {
    const entry = this.entries.get(clientId)
    if (!entry) return []
    let changed = false
    const seats = rosterSeats(entry).map((seat) => {
      if (seat.playerId !== null) return seat
      changed = true
      const id = this.nextPlayerId++
      return { ...seat, playerId: id }
    })
    const ids = seats.flatMap((seat) => (seat.playerId === null ? [] : [seat.playerId]))
    if (changed || entry.playerId !== (ids[0] ?? null) || !entry.seats) {
      const remembered = lookupRememberedSeats(clientId) ?? []
      const stored = seats.flatMap((seat) => {
        if (seat.playerId === null) return []
        const prev = remembered.find((item) => item.playerId === seat.playerId)
        return [{ playerId: seat.playerId, score: prev?.score ?? 0, name: seat.name }]
      })
      const first = stored[0]
      if (first) {
        rememberPlayer({ clientId, playerId: first.playerId, score: first.score, name: first.name, seats: stored })
      }
      this.entries.set(clientId, {
        ...entry,
        seats,
        playerId: ids[0] ?? null,
        name: seatLabel(seats.map((seat) => seat.name)),
      })
    }
    return ids
  }

  /**
   * Восстанавливает устойчивую связь clientId -> playerId из сохранённой партии.
   * Сами отсутствующие клиенты не добавляются в видимый roster: они появятся после hello.
   */
  restorePlayers(players: readonly Player[]): void {
    const groups = new Map<string, Player[]>()
    for (const player of players) {
      this.nextPlayerId = Math.max(this.nextPlayerId, player.id + 1)
      const savedClientId = player.clientId?.trim()
      if (!savedClientId) continue
      const group = groups.get(savedClientId) ?? []
      group.push(player)
      groups.set(savedClientId, group)
    }
    for (const [clientId, group] of groups) {
      group.sort((left, right) => left.id - right.id)
      const seats = group.map((player) => ({ playerId: player.id, score: player.score, name: player.name }))
      const first = seats[0]
      if (!first) continue
      rememberPlayer({ clientId, playerId: first.playerId, score: first.score, name: first.name, seats })
      const existing = this.entries.get(clientId)
      const rosterSeatsHere = group.map((player) => ({ name: player.name, playerId: player.id }))
      const label = seatLabel(group.map((player) => player.name))
      if (clientId === this.masterClientId) this.masterName = label
      if (!existing) continue
      this.entries.set(clientId, {
        ...existing,
        name: label,
        playerId: first.playerId,
        seats: rosterSeatsHere,
      })
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

function normalizeRosterNames(name: string | readonly string[]): string[] {
  const raw = typeof name === 'string' ? [name] : [...name]
  const names = raw.map((item) => item.trim().slice(0, 40)).filter((item) => item.length > 0).slice(0, 8)
  return names.length > 0 ? names : ['Игрок']
}

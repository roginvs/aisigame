import { idleSteps } from '../options.ts'

/** Отсчёт тишины в слушающем состоянии без своего таймера. Живёт в контексте машины. */
export type IdleKind = keyof typeof idleSteps

export type IdleClock = {
  kind: IdleKind
  /** Сколько порогов уже пройдено. */
  stage: number
  /** Накопленная тишина, мс (без речи ведущей, речи игрока и разбора). */
  elapsedMs: number
  /** С какого момента тикает; null — заморожен. */
  since: number | null
  /** Переход сам себе: entry не сбрасывает отсчёт, а только перезапускает. */
  carry: boolean
}

/** Что сделали по молчанию — для реплики ведущей после автодействия. */
export type IdleOutcome = {
  kind: IdleKind
  fromId: number
  toId: number | null
  waitedMs: number
  /** Аукцион: молчание первого — торги открыты по номиналу, а не пас. */
  autoOpen?: boolean
  stake?: number
}

export type TalkState = { host: boolean; player: boolean }

/** Сколько ждёт таймер в заморозке: дольше любой партии. */
export const IDLE_FROZEN_MS = 2 ** 31 - 1

let scale = 1
/** Демо: ускорить (0.1 — в 10 раз быстрее). */
export function setIdleScale(next: number): void {
  scale = Number.isFinite(next) && next > 0 ? next : 1
}
export function idleThresholds(kind: IdleKind): number[] {
  return idleSteps[kind].map((ms) => Math.round(ms * scale))
}

export function talking(talk: TalkState | undefined): boolean {
  return Boolean(talk?.host || talk?.player)
}

/** Новый отсчёт или перезапуск после carry-перехода. */
export function enterIdle(clock: IdleClock | null | undefined, kind: IdleKind, talk: TalkState | undefined, now: number): IdleClock {
  const running = talking(talk) ? null : now
  if (clock && clock.carry && clock.kind === kind) return { ...clock, carry: false, since: running }
  return { kind, stage: 0, elapsedMs: 0, since: running, carry: false }
}

/** Остановить и накопить; reset — речь игрока началась. */
export function pauseIdle(clock: IdleClock, now: number, reset: boolean): IdleClock {
  if (reset) return { ...clock, stage: 0, elapsedMs: 0, since: null, carry: true }
  const elapsedMs = clock.since === null ? clock.elapsedMs : clock.elapsedMs + Math.max(0, now - clock.since)
  return { ...clock, elapsedMs, since: null, carry: true }
}

export function idleDelay(clock: IdleClock | null | undefined): number {
  if (!clock || clock.since === null) return IDLE_FROZEN_MS
  const threshold = idleThresholds(clock.kind)[clock.stage]
  if (threshold === undefined) return IDLE_FROZEN_MS
  return Math.max(0, threshold - clock.elapsedMs)
}

export function idleIsFinal(clock: IdleClock | null | undefined): boolean {
  return Boolean(clock && clock.stage >= idleThresholds(clock.kind).length - 1)
}

export function advanceIdle(clock: IdleClock, now: number): IdleClock {
  const threshold = idleThresholds(clock.kind)[clock.stage] ?? clock.elapsedMs
  return { ...clock, stage: clock.stage + 1, elapsedMs: threshold, since: now, carry: true }
}

import type { HostEar } from '../game/hostEar.ts'
import { buildCommit } from '../buildInfo.ts'
import type { GameContext } from '../game/types.ts'
import {
  type ConferenceMessageRing,
  type ConferencePackManifest,
  type ConferenceJitsiPair,
  type ConferenceSnapshot,
  type ConferenceSnapshotPresence,
} from './messages.ts'
import { rosterSeats } from './seats.ts'
import type { RosterEntry } from './roster.ts'
import { emptyMessageRing } from './messageRing.ts'

export type ConferenceJitsiIds = {
  pairs: ConferenceJitsiPair[]
  host: string | null
  sounds: string | null
}

/**
 * Пары `[jitsiId, clientId]` по составу: мастер — своё соединение, гость — от кого пришёл его hello.
 * Нет id (BroadcastChannel без Jitsi или hello ещё не было) — пары нет.
 */
export function jitsiPairs(
  roster: readonly { clientId: string; isMaster: boolean }[],
  ids: { self: string | null; endpointOf: (clientId: string) => string | null },
): ConferenceJitsiPair[] {
  const pairs: ConferenceJitsiPair[] = []
  const seen = new Set<string>()
  for (const entry of roster) {
    if (seen.has(entry.clientId)) continue
    const jitsiId = entry.isMaster ? ids.self : ids.endpointOf(entry.clientId)
    if (!jitsiId) continue
    seen.add(entry.clientId)
    pairs.push([jitsiId, entry.clientId])
  }
  return pairs
}

export function buildConferenceSnapshot(input: {
  phase: string
  pack: ConferencePackManifest | null
  context: GameContext
  roster: RosterEntry[]
  messageRing?: ConferenceMessageRing
  timerRemainingMs: number | null
  falseStartIds: number[]
  liveSpeech?: { text: string; at: string } | null
  hostEar?: HostEar
  hostLink?: ConferenceSnapshot['hostLink']
  hearTurnOnly?: boolean
  /** Пауза в лобби (машина контроллера стоит на паузе до старта партии). */
  lobbyPaused?: boolean
  /** Кто есть кто в Jitsi (ведёт мастер, см. `masterSession.conferenceIds`). */
  jitsi?: ConferenceJitsiIds
}): ConferenceSnapshot {
  // Ответ раскрываем по одному: в снимок попадают только уже разобранные ответы.
  const typedAnswers: Record<string, string> = {}
  for (const id of (input.context.revealedIds ?? [])) {
    const text = input.context.typedAnswers?.[id]
    if (text !== undefined) typedAnswers[String(id)] = text
  }

  const presence: ConferenceSnapshotPresence[] = input.roster.map((entry) => ({
    clientId: entry.clientId,
    name: entry.name,
    playerId: entry.playerId,
    seats: rosterSeats(entry),
    isMaster: entry.isMaster,
    stale: entry.stale,
    hidden: entry.hidden,
    percent: entry.percent,
    downloadBps: entry.downloadBps,
    etaSeconds: entry.etaSeconds,
    packPhase: entry.packPhase,
    ready: entry.ready,
    hashOk: entry.hashOk,
    pingMs: entry.pingMs ?? null,
  }))

  return {
    outcomes: input.context.outcomes ?? {},
    appeal: input.context.appeal ?? null,
    appealSerial: input.context.appealSerial ?? 0,
    special: input.context.special ?? null,
    commit: buildCommit(),
    pack: input.pack,
    phase: input.phase,
    players: input.context.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      clientId: player.clientId,
    })),
    presence,
    jitsiIds: input.jitsi?.pairs ?? [],
    hostJitsiId: input.jitsi?.host ?? null,
    soundsJitsiId: input.jitsi?.sounds ?? null,
    roundIndex: input.context.roundIndex,
    playedIds: [...input.context.playedIds],
    missedIds: [...input.context.missedIds],
    finalists: [...input.context.finalists],
    finalCursor: input.context.finalCursor,
    activeQuestionId: input.context.activeQuestionId,
    chooserId: input.context.chooserId,
    answererId: input.context.activePlayerId,
    falseStartIds: input.falseStartIds,
    falseStarts: Object.fromEntries(
      Object.entries(input.context.falseStarts).filter((entry): entry is [string, number] => entry[1] !== undefined),
    ),
    /** Финал: скрытые ставки — суммы остаются у контроллера; в комнату уходит только факт. */
    stakedIds: input.context.bets.map((bet) => bet.playerId),
    /** Финал: кто уже напечатал ответ (текст уходит на разбор, не сразу). */
    typedIds: Object.keys(input.context.typedAnswers ?? {}).map((key) => Number(key)),
    /** Финал: раскрытые ставки — только у тех, кого ведущая уже назвала. */
    stakes: Object.fromEntries(
      (input.context.stakeShownIds ?? [])
        .map((id) => {
          const bet = input.context.bets.find((item) => item.playerId === id)
          return bet ? [String(id), bet.amount] : null
        })
        .filter((entry): entry is [string, number] => entry !== null),
    ),
    betMisses: input.context.betMisses,
    finalStriker: input.context.finalStriker ?? null,
    struckThemes: [...(input.context.struckThemes ?? [])],
    typedAnswers,
    revealedIds: [...(input.context.revealedIds ?? [])],
    stakeShownIds: [...(input.context.stakeShownIds ?? [])],
    // Известный упрощённый канал: активная ставка (в финале — сумма текущего финалиста из скрытых bets)
    // лежит в снимке с момента его хода, до «Смотрим ставку». Скрытость держит только UI (stakeShownIds):
    // технически внимательный игрок может прочитать сумму в DevTools. Считаем игроков честными:
    // ради единственного честного поля не разводим отдельную маску снимка (маскировать отдельно — в to-do).
    activeStake: input.context.activeStake,
    attemptId: input.context.attemptId,
    clarifications: input.context.clarifications,
    spokeWithoutButton: input.context.spokeWithoutButton,
    talkedDuringRead: input.context.talkedDuringRead,
    sayFalseStart: input.context.sayFalseStart,
    heard: input.context.heard,
    wrongHeard: [...input.context.wrongHeard],
    sayCloseGuess: input.context.sayCloseGuess,
    // judgmentReason в комнату не уходит: пояснение оценки обычно называет правильный ответ,
    // а услышать его игрок должен только после объявления (как в снимке партии — там поле вырезано).
    judgmentStatus: input.context.judgmentStatus,
    announceKind: input.context.announceKind,
    clarifyReason: input.context.clarifyReason,
    statusLine: input.context.statusLine,
    phaseDurationMs: input.context.phaseDurationMs,
    timerRemainingMs: input.timerRemainingMs,
    liveSpeech: input.liveSpeech ?? null,
    hostEar: input.hostEar ?? 'idle',
    resumePath: input.context.resumePath,
    resumeStatus: input.context.resumeStatus,
    error: input.context.error,
    ...(input.hostLink ? { hostLink: input.hostLink } : {}),
    ...(input.hearTurnOnly !== undefined ? { hearTurnOnly: input.hearTurnOnly } : {}),
    lobbyPaused: input.lobbyPaused === true,
    ...(input.messageRing ?? emptyMessageRing()),
  }
}

export function timerRemainingMs(context: GameContext, now: number): number | null {
  if (context.phaseStartedAt === null || context.phaseDurationMs === null) return null
  return Math.max(0, context.phaseDurationMs - (now - context.phaseStartedAt))
}

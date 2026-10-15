import type { GameContext, QuestionPack } from '../game/types.ts'
import type { ConferenceSnapshot } from './messages.ts'
import { TIMER_RESYNC_THRESHOLD_MS } from '../options.ts'

/** Якорь полоски таймера у гостя: держим, пока таймер тот же и дрейф мал (сетевой джиттер). */
let timerAnchor: { key: string; startedAt: number } | null = null

export function resetTimerAnchor(): void {
  timerAnchor = null
}

/** Когда снимок пришёл: остаток таймера верен на этот момент, а не на момент перерисовки. */
const receivedAt = new WeakMap<ConferenceSnapshot, number>()

export function anchoredPhaseStart(snapshot: ConferenceSnapshot, renderNow = Date.now()): number | null {
  // Экран перерисовывается и без нового снимка (плитки, чат); если брать «сейчас» рендера, старый
  // остаток сдвигает начало фазы вперёд на возраст снимка — полоска прыгает назад, затем вперёд.
  const now = receivedAt.get(snapshot) ?? renderNow
  if (!receivedAt.has(snapshot)) receivedAt.set(snapshot, now)
  if (snapshot.timerRemainingMs === null || snapshot.phaseDurationMs === null || snapshot.phase === 'paused') {
    timerAnchor = null
    return null
  }
  const derived = now - (snapshot.phaseDurationMs - snapshot.timerRemainingMs)
  const key = `${snapshot.phase}|${snapshot.phaseDurationMs}|${snapshot.activeQuestionId ?? ''}|${snapshot.attemptId}`
  if (timerAnchor && timerAnchor.key === key && Math.abs(derived - timerAnchor.startedAt) <= TIMER_RESYNC_THRESHOLD_MS) {
    return timerAnchor.startedAt
  }
  timerAnchor = { key, startedAt: derived }
  return derived
}

export function contextFromSnapshot(snapshot: ConferenceSnapshot, pack: QuestionPack): GameContext {
  const bets = Object.entries(snapshot.bets).map(([playerId, amount]) => ({
    playerId: Number(playerId),
    amount,
  }))
  const falseStarts: GameContext['falseStarts'] = {}
  for (const [id, stamp] of Object.entries(snapshot.falseStarts)) falseStarts[Number(id)] = stamp

  return {
    outcomes: snapshot.outcomes ?? {},
    appeal: snapshot.appeal ?? null,
    appealSerial: snapshot.appealSerial ?? 0,
    special: snapshot.special ?? null,
    players: snapshot.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      clientId: player.clientId,
    })),
    packName: pack.name,
    rounds: pack.rounds,
    roundIndex: snapshot.roundIndex,
    warnings: pack.warnings,
    questions: pack.questions,
    playedIds: [...snapshot.playedIds],
    missedIds: [...snapshot.missedIds],
    finalists: [...snapshot.finalists],
    finalCursor: snapshot.finalCursor,
    bets,
    betMisses: snapshot.betMisses,
    chooserId: snapshot.chooserId ?? snapshot.players[0]?.id ?? 1,
    activeQuestionId: snapshot.activeQuestionId,
    activePlayerId: snapshot.answererId,
    activeStake: snapshot.activeStake,
    attemptId: snapshot.attemptId,
    clarifications: snapshot.clarifications,
    spokeWithoutButton: snapshot.spokeWithoutButton,
    talkedDuringRead: snapshot.talkedDuringRead,
    sayFalseStart: snapshot.sayFalseStart,
    heard: snapshot.heard,
    wrongHeard: [...snapshot.wrongHeard],
    sayCloseGuess: snapshot.sayCloseGuess,
    judgmentReason: snapshot.judgmentReason,
    announceKind: snapshot.announceKind,
    judgmentStatus: snapshot.judgmentStatus,
    clarifyReason: snapshot.clarifyReason,
    phaseStartedAt: anchoredPhaseStart(snapshot),
    phaseDurationMs: snapshot.phaseDurationMs,
    earlyLeftMs: null,
    earlyStartedAt: null,
    pauseStartedAt: null,
    resumePath: snapshot.resumePath ?? '',
    resumeStatus: snapshot.resumeStatus ?? '',
    statusLine: snapshot.statusLine || statusForPhase(snapshot.phase),
    error: snapshot.error ?? null,
    falseStarts,
  }
}

function statusForPhase(phase: string): string {
  if (phase === 'lobby') return 'Ждём игроков'
  if (phase.startsWith('choosing')) return 'назовите тему и стоимость'
  if (phase.startsWith('buzzing') || phase.startsWith('answering')) return 'Жмите кнопку'
  if (phase.startsWith('reading')) return 'Ведущая читает вопрос'
  return 'Партия идёт'
}

/** Мастер: точное начало фазы из своей машины, когда снимок о той же фазе. */
export function withExactPhaseStart(context: GameContext, phaseStartedAt: number | null | undefined): GameContext {
  return phaseStartedAt === undefined ? context : { ...context, phaseStartedAt }
}

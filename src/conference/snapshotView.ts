import type { GameContext, QuestionPack } from '../game/types.ts'
import type { ConferenceSnapshot } from './messages.ts'

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
    phaseStartedAt:
      snapshot.timerRemainingMs !== null && snapshot.phaseDurationMs !== null
        ? Date.now() - (snapshot.phaseDurationMs - snapshot.timerRemainingMs)
        : null,
    phaseDurationMs: snapshot.phaseDurationMs,
    earlyLeftMs: null,
    earlyStartedAt: null,
    pauseStartedAt: null,
    resumePath: '',
    resumeStatus: '',
    statusLine: snapshot.statusLine || statusForPhase(snapshot.phase),
    error: null,
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

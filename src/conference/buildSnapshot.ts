import type { GameContext } from '../game/types.ts'
import type { ConferenceChatLine, ConferenceSnapshot, ConferenceSnapshotPresence } from './messages.ts'
import type { RosterEntry } from './roster.ts'
import { readConversationLines } from './traceConversation.ts'

export function buildConferenceSnapshot(input: {
  phase: string
  context: GameContext
  roster: RosterEntry[]
  chat: ConferenceChatLine[]
  timerRemainingMs: number | null
  falseStartIds: number[]
}): ConferenceSnapshot {
  const bets: Record<string, number> = {}
  for (const bet of input.context.bets) bets[String(bet.playerId)] = bet.amount

  const presence: ConferenceSnapshotPresence[] = input.roster.map((entry) => ({
    clientId: entry.clientId,
    name: entry.name,
    playerId: entry.playerId,
    isMaster: entry.isMaster,
    stale: entry.stale,
    hidden: entry.hidden,
    percent: entry.percent,
    ready: entry.ready,
    hashOk: entry.hashOk,
  }))

  return {
    phase: input.phase,
    players: input.context.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      clientId: player.clientId,
    })),
    presence,
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
    bets,
    betMisses: input.context.betMisses,
    activeStake: input.context.activeStake,
    attemptId: input.context.attemptId,
    clarifications: input.context.clarifications,
    spokeWithoutButton: input.context.spokeWithoutButton,
    talkedDuringRead: input.context.talkedDuringRead,
    sayFalseStart: input.context.sayFalseStart,
    heard: input.context.heard,
    wrongHeard: [...input.context.wrongHeard],
    sayCloseGuess: input.context.sayCloseGuess,
    judgmentReason: input.context.judgmentReason,
    judgmentStatus: input.context.judgmentStatus,
    announceKind: input.context.announceKind,
    clarifyReason: input.context.clarifyReason,
    statusLine: input.context.statusLine,
    phaseDurationMs: input.context.phaseDurationMs,
    timerRemainingMs: input.timerRemainingMs,
    conversation: readConversationLines(200),
    chat: input.chat.slice(-200),
  }
}

export function timerRemainingMs(context: GameContext, now: number): number | null {
  if (context.phaseStartedAt === null || context.phaseDurationMs === null) return null
  return Math.max(0, context.phaseDurationMs - (now - context.phaseStartedAt))
}

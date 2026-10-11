import { and, assign, not, setup, stateIn } from 'xstate'
import { gameConfig } from '../config.ts'
import { questionSpeech } from './choices.ts'
import { earlyBuzzerMsFor } from './earlyBuzzer.ts'
import { findQuestion, nextPlayableRound, questionById, questionsInRound } from './pack.ts'
import { defaultPlayers, openingChooser } from './players.ts'
import { demoPack } from './questions.ts'
import { restoredMatch } from './savedGame.ts'
import type { AnnounceKind, GameContext, GameEvent, JudgmentStatus, Player, PlayerId, QuestionPack } from './types.ts'

/** true — назвать фальстарт. Тесты подменяют flip, чтобы не зависеть от случайности. */
export const falseStartCoin = {
  flip(): boolean {
    return Math.random() < 0.5
  },
}

/** true — на объявлении ответа можно сказать, что попытка была близкой. Тесты подменяют flip. */
export const closeGuessCoin = {
  flip(): boolean {
    return Math.random() < 0.5
  },
}

/** Контроллер ставит эту причину, когда созвучие уже переспрашивали и оно стало обычной ошибкой. */
export const phoneticRetryReason = 'Созвучие уже переспрашивали. Дальше это обычная ошибка.'

function blankMatch(pack: QuestionPack, players?: Player[]): GameContext {
  const roster = players && players.length > 0 ? players.map((player) => ({ ...player })) : defaultPlayers()
  return {
    players: roster,
    packName: pack.name,
    rounds: pack.rounds,
    roundIndex: pack.rounds[0]?.index ?? 0,
    warnings: pack.warnings,
    questions: pack.questions,
    playedIds: [],
    missedIds: [],
    finalists: [],
    finalCursor: 0,
    bets: [],
    betMisses: 0,
    activeStake: null,
    activeQuestionId: null,
    activePlayerId: null,
    chooserId: openingChooser(roster),
    attemptId: 0,
    clarifications: 0,
    spokeWithoutButton: false,
    talkedDuringRead: false,
    sayFalseStart: false,
    wrongHeard: [],
    sayCloseGuess: false,
    heard: '',
    judgmentReason: '',
    judgmentStatus: null,
    announceKind: null,
    clarifyReason: '',
    error: null,
    resumePath: '',
    resumeStatus: '',
    statusLine: 'Введите ключ и начните игру',
    phaseStartedAt: null,
    phaseDurationMs: null,
    earlyLeftMs: null,
    earlyStartedAt: null,
    pauseStartedAt: null,
    falseStarts: {},
  }
}

export function falseStartCooling(stamp: number | undefined, now: number): boolean {
  return stamp !== undefined && now - stamp < gameConfig.falseStartMs
}

function shiftFalseStarts(stamps: GameContext['falseStarts'], shiftMs: number): GameContext['falseStarts'] {
  if (shiftMs <= 0) return stamps
  const shifted: GameContext['falseStarts'] = {}
  for (const [id, stamp] of Object.entries(stamps)) {
    if (stamp === undefined) continue
    shifted[Number(id)] = stamp + shiftMs
  }
  return shifted
}

function freshContext(): GameContext {
  return blankMatch(demoPack)
}

function roundKind(context: GameContext) {
  return context.rounds.find((round) => round.index === context.roundIndex)?.kind ?? 'normal'
}

function isFinal(context: GameContext): boolean {
  return roundKind(context) === 'final'
}

function currentFinalist(context: GameContext): PlayerId | null {
  return context.finalists[context.finalCursor] ?? null
}

function playerScore(context: GameContext, playerId: PlayerId | null): number {
  return context.players.find((player) => player.id === playerId)?.score ?? 0
}

function roundFinished(context: GameContext): boolean {
  if (isFinal(context)) return Boolean(context.activeQuestionId && context.playedIds.includes(context.activeQuestionId))
  const round = questionsInRound(context.questions, context.roundIndex)
  return round.length > 0 && round.every((question) => context.playedIds.includes(question.id))
}

function closeQuestion(context: GameContext): boolean {
  if (!isFinal(context) || context.finalists.length === 0) return true
  return context.finalCursor >= context.finalists.length - 1
}

function stakeOf(context: GameContext): number {
  if (context.activeStake !== null) return context.activeStake
  return questionById(context.questions, context.activeQuestionId)?.value ?? 0
}

function addMissed(missed: PlayerId[], playerId: PlayerId | null): PlayerId[] {
  if (!playerId || missed.includes(playerId)) return missed
  return [...missed, playerId]
}

function othersCanBuzz(context: GameContext, missed: PlayerId[]): boolean {
  if (isFinal(context)) return false
  return context.players.some((player) => !missed.includes(player.id))
}

function withPlayed(playedIds: string[], id: string | null): string[] {
  if (!id || playedIds.includes(id)) return playedIds
  return [...playedIds, id]
}

function changeScore(context: GameContext, playerId: PlayerId | null, delta: number) {
  if (!playerId || delta === 0) return context.players
  return context.players.map((player) =>
    player.id === playerId ? { ...player, score: player.score + delta } : player,
  )
}

function showsClock(path: string): boolean {
  return path === 'buzzing' || path === 'buzzing.open' || path === 'buzzing.reminding' || path === 'answering.waiting'
}

function clockMs(path: string, missedIds: readonly PlayerId[] = [], clarifications = 0): number | null {
  if (path === 'buzzing' || path === 'buzzing.open' || path === 'buzzing.reminding') {
    return missedIds.length > 0 ? gameConfig.stealBuzzerMs : gameConfig.buzzerMs
  }
  if (path === 'answering.waiting') return clarifications > 0 ? gameConfig.clarifyMs : gameConfig.answerMs
  return null
}

/** Сколько ещё идти окну кнопки. Свежие часы совпадают с длительностью, уже начатые не обнуляются. */
function buzzerMsLeft(context: GameContext): number {
  const duration = context.phaseDurationMs ?? gameConfig.buzzerMs
  if (context.phaseStartedAt === null) return duration
  return Math.max(0, duration - (Date.now() - context.phaseStartedAt))
}

function outcomeStatus(context: GameContext, event: GameEvent): JudgmentStatus | null {
  if (event.type !== 'ANSWER_JUDGED') return null
  if (event.judgment.status === 'near_miss' && context.clarifications >= gameConfig.maxClarifications) return 'incorrect'
  return event.judgment.status
}

function asksRepeat(context: GameContext, event: GameEvent): boolean {
  return (
    event.type === 'ANSWER_JUDGED' &&
    event.judgment.status === 'near_miss' &&
    context.clarifications < gameConfig.maxClarifications
  )
}

function inRoster(context: GameContext, playerId: number): boolean {
  return context.players.some((player) => player.id === playerId)
}

function hasFalseStarts(context: GameContext): boolean {
  return context.players.some((player) => context.falseStarts[player.id] !== undefined)
}

function rememberWrong(previous: string[], event: GameEvent): string[] {
  if (event.type !== 'ANSWER_JUDGED' || event.judgment.status !== 'incorrect') return previous
  if (event.judgment.reason === phoneticRetryReason) return previous
  const text = event.judgment.heard.replace(/\s+/g, ' ').trim()
  if (!text || previous.includes(text)) return previous
  return [...previous, text]
}

function incorrectReveals(context: GameContext, event: GameEvent): boolean {
  if (event.type !== 'ANSWER_JUDGED' || outcomeStatus(context, event) !== 'incorrect') return false
  if (!isFinal(context)) {
    const missed = addMissed(context.missedIds, event.judgment.playerId)
    if (othersCanBuzz(context, missed)) return false
  }
  return closeQuestion(context)
}

function silenceReveals(context: GameContext): boolean {
  if (!isFinal(context)) {
    const missed = addMissed(context.missedIds, context.activePlayerId)
    if (othersCanBuzz(context, missed)) return false
  }
  return closeQuestion(context)
}

function rollCloseGuess(attempts: readonly string[]): boolean {
  return attempts.some((item) => item.trim()) && closeGuessCoin.flip()
}

function earlyRemaining(context: GameContext, path: string): number | null {
  if (path === 'reading.armed') return 0
  if (path !== 'reading' && path !== 'reading.sealed') return null
  const budget = context.earlyLeftMs ?? gameConfig.earlyBuzzerMs
  if (context.earlyStartedAt === null) return budget
  return Math.max(0, budget - (Date.now() - context.earlyStartedAt))
}

export function isReadingPath(path: string): boolean {
  return path === 'reading' || path.startsWith('reading.')
}

export function buttonsLive(path: string): boolean {
  return path.startsWith('buzzing') || path === 'reading.armed' || path === 'falseStartCue'
}

export function falseStartOpen(path: string, finalRound: boolean): boolean {
  if (finalRound) return false
  return path === 'flashing' || path === 'reading.sealed'
}

export function statePath(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const [key, nested] = Object.entries(value)[0] ?? []
    if (!key) return ''
    const rest = statePath(nested)
    return rest ? `${key}.${rest}` : key
  }
  return ''
}

function liveRoundSkip() {
  return and([
    not(stateIn('startMenu')),
    not(stateIn('connecting')),
    not(stateIn('failed')),
    not(stateIn('stopped')),
    not(stateIn('finished')),
    not(and([stateIn('paused'), 'pausedAfterFinish'])),
  ])
}

export const gameMachine = setup({
  types: {
    context: {} as GameContext,
    events: {} as GameEvent,
  },
  delays: {
    buzzerMs: gameConfig.buzzerMs,
    buzzerLeft: ({ context }) => buzzerMsLeft(context),
    answerMs: gameConfig.answerMs,
    answerLeft: ({ context }) => (context.clarifications > 0 ? gameConfig.clarifyMs : gameConfig.answerMs),
    judgeMs: gameConfig.judgeMs,
    cellFlashMs: gameConfig.cellFlashMs,
    earlyLeft: ({ context }) => context.earlyLeftMs ?? gameConfig.earlyBuzzerMs,
  },
  actions: {
    clearError: assign({ error: () => null }),
    setError: assign({
      error: ({ event }) =>
        event.type === 'CONNECTION_FAILED' || event.type === 'CONNECTION_LOST'
          ? event.message
          : 'Соединение прервалось',
      statusLine: () => 'Связь с ведущей потеряна',
    }),
    resetMatch: assign(() => freshContext()),
    rememberPause: assign({
      resumePath: ({ event }) => (event.type === 'PAUSE' ? event.path : ''),
      resumeStatus: ({ context }) => context.statusLine,
      statusLine: () => 'Пауза. Микрофон выключен, ведущая не ждёт',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
      earlyStartedAt: () => null,
      earlyLeftMs: ({ context, event }) => (event.type === 'PAUSE' ? earlyRemaining(context, event.path) : null),
      pauseStartedAt: () => Date.now(),
    }),
    rememberStop: assign({
      statusLine: () => 'Остановлена',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
      earlyStartedAt: () => null,
      earlyLeftMs: () => null,
      pauseStartedAt: () => null,
    }),
    resumeClock: assign({
      statusLine: ({ context }) => context.resumeStatus || 'Дальше',
      phaseStartedAt: ({ context }) => (showsClock(context.resumePath) ? Date.now() : null),
      phaseDurationMs: ({ context }) => clockMs(context.resumePath, context.missedIds, context.clarifications),
      falseStarts: ({ context }) =>
        shiftFalseStarts(context.falseStarts, context.pauseStartedAt === null ? 0 : Date.now() - context.pauseStartedAt),
      pauseStartedAt: () => null,
    }),
    loadPack: assign(({ event }) =>
      event.type === 'START_GAME' ? blankMatch(event.pack, event.players) : {},
    ),
    loadSaved: assign(({ event }) => {
      if (event.type !== 'CONTINUE_GAME') return {}
      return { ...blankMatch(event.pack), ...restoredMatch(event.pack, event.saved) }
    }),
    clearResume: assign({
      resumePath: () => '',
      error: () => null,
    }),
    startRestoredBuzzer: assign({
      statusLine: () => 'Жмите свою кнопку',
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: ({ context }) =>
        context.missedIds.length > 0 ? gameConfig.stealBuzzerMs : gameConfig.buzzerMs,
    }),
    setWelcomeStatus: assign({
      statusLine: ({ context }) => `Пакет «${context.packName}»`,
      error: () => null,
    }),
    setChoosingStatus: assign({
      statusLine: ({ context }) => {
        const round = context.rounds.find((item) => item.index === context.roundIndex)
        if (round?.kind === 'final') return 'Выберите тему финала'
        return 'назовите тему и стоимость'
      },
      activeQuestionId: () => null,
      activePlayerId: () => null,
      heard: () => '',
      wrongHeard: () => [],
      sayCloseGuess: () => false,
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      clarifyReason: () => '',
      clarifications: () => 0,
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    setResolvingStatus: assign({
      statusLine: () => 'Ведущая разбирает выбор',
    }),
    handoffChooser: assign({
      chooserId: ({ context, event }) =>
        event.type === 'CHOOSER_OFFLINE' ? event.toPlayerId : context.chooserId,
      clarifyReason: ({ context, event }) => {
        if (event.type !== 'CHOOSER_OFFLINE') return context.clarifyReason
        const disconnected = context.players.find((player) => player.id === event.fromPlayerId)?.name ?? 'Игрок'
        const replacement = context.players.find((player) => player.id === event.toPlayerId)?.name ?? 'Игрок'
        const choice = isFinal(context) ? 'тему финала' : 'вопрос'
        return `${disconnected} отключился. ${replacement}, выбирайте ${choice}.`
      },
      statusLine: ({ context, event }) => {
        if (event.type !== 'CHOOSER_OFFLINE') return context.statusLine
        const disconnected = context.players.find((player) => player.id === event.fromPlayerId)?.name ?? 'Игрок'
        const replacement = context.players.find((player) => player.id === event.toPlayerId)?.name ?? 'Игрок'
        return `${disconnected} отключился · ${replacement} выбирает`
      },
    }),
    noteUnclear: assign({
      clarifyReason: ({ event }) => {
        if (event.type === 'QUESTION_UNCLEAR') return event.reason
        if (event.type === 'SELECTION_FAILED') return event.message
        return 'Назовите тему и стоимость ещё раз'
      },
      statusLine: ({ event }) => {
        if (event.type === 'QUESTION_UNCLEAR') return event.reason
        if (event.type === 'SELECTION_FAILED') return event.message
        return 'Нужно уточнить выбор'
      },
    }),
    noteUnavailable: assign({
      clarifyReason: () => 'Такой вопрос недоступен или уже сыгран',
      statusLine: () => 'Этот вопрос недоступен',
    }),
    selectionTimeout: assign({
      statusLine: () => 'Не удалось разобрать выбор. Назовите тему ещё раз',
      clarifyReason: () => '',
    }),
    openQuestion: assign({
      activeQuestionId: ({ context, event }) => {
        if (event.type !== 'QUESTION_SELECTED') return null
        return (
          findQuestion(
            context.questions,
            context.roundIndex,
            event.themeId,
            event.value,
            roundKind(context),
            context.playedIds,
          )?.id ?? null
        )
      },
      activePlayerId: () => null,
      missedIds: () => [],
      activeStake: () => null,
      heard: () => '',
      wrongHeard: () => [],
      sayCloseGuess: () => false,
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      clarifications: () => 0,
      talkedDuringRead: () => false,
      sayFalseStart: () => false,
      falseStarts: () => ({}),
      statusLine: ({ context, event }) => {
        if (event.type !== 'QUESTION_SELECTED') return 'Открываю вопрос'
        const question = findQuestion(
          context.questions,
          context.roundIndex,
          event.themeId,
          event.value,
          roundKind(context),
          context.playedIds,
        )
        if (!question) return 'Открываю вопрос'
        return roundKind(context) === 'final' ? question.themeName : `${question.themeName}, ${question.value}`
      },
    }),
    setReadingStatus: assign({
      statusLine: () => 'Ведущая читает вопрос',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    armEarlyClock: assign({
      earlyLeftMs: ({ context }) => {
        const question = questionById(context.questions, context.activeQuestionId)
        return earlyBuzzerMsFor(question ? questionSpeech(question) : '')
      },
      earlyStartedAt: () => Date.now(),
    }),
    noteEarlyStart: assign({
      earlyStartedAt: () => Date.now(),
    }),
    clearEarlyBuzz: assign({
      earlyLeftMs: () => null,
      earlyStartedAt: () => null,
    }),
    startBuzzerTimer: assign({
      statusLine: () => 'Жмите свою кнопку',
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: () => gameConfig.buzzerMs,
      spokeWithoutButton: () => false,
    }),
    startArmedBuzzer: assign({
      statusLine: () => 'Жмите свою кнопку',
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: () => gameConfig.buzzerMs,
      spokeWithoutButton: () => false,
    }),
    noteUnbuttonedTalk: assign({
      spokeWithoutButton: () => true,
    }),
    noteTalkedOver: assign({
      talkedDuringRead: () => true,
    }),
    decideFalseStartCallout: assign({
      sayFalseStart: ({ context }) => hasFalseStarts(context) && falseStartCoin.flip(),
    }),
    reopenBuzzers: assign({
      activePlayerId: () => null,
      heard: () => '',
      sayCloseGuess: () => false,
      judgmentStatus: () => null,
      announceKind: () => null,
      spokeWithoutButton: () => false,
      statusLine: () => 'Жмите свою кнопку',
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: () => gameConfig.stealBuzzerMs,
    }),
    markFalseStart: assign({
      falseStarts: ({ context, event }) => {
        if (event.type !== 'BUZZER_PRESSED') return context.falseStarts
        return { ...context.falseStarts, [event.playerId]: Date.now() }
      },
    }),
    assignAnswerer: assign({
      activePlayerId: ({ event }) => (event.type === 'BUZZER_PRESSED' ? event.playerId : null),
      attemptId: ({ context }) => context.attemptId + 1,
      clarifications: () => 0,
      statusLine: ({ event }) =>
        event.type === 'BUZZER_PRESSED' ? `Отвечает игрок ${event.playerId}` : 'Отвечает игрок',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    startAnswerTimer: assign({
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: ({ context }) => (context.clarifications > 0 ? gameConfig.clarifyMs : gameConfig.answerMs),
    }),
    setJudgingStatus: assign({
      statusLine: () => 'Ведущая оценивает ответ',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    applyJudgment: assign({
      players: ({ context, event }) => {
        if (event.type !== 'ANSWER_JUDGED') return context.players
        const status = outcomeStatus(context, event)
        const stake = stakeOf(context)
        const delta = status === 'correct' ? stake : status === 'incorrect' ? -stake : 0
        return changeScore(context, event.judgment.playerId, delta)
      },
      missedIds: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (status !== 'incorrect' || isFinal(context) || event.type !== 'ANSWER_JUDGED') return context.missedIds
        return addMissed(context.missedIds, event.judgment.playerId)
      },
      playedIds: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (status === 'near_miss') return context.playedIds
        if (status === 'incorrect' && !isFinal(context) && event.type === 'ANSWER_JUDGED') {
          const missed = addMissed(context.missedIds, event.judgment.playerId)
          if (othersCanBuzz(context, missed)) return context.playedIds
        }
        if (event.type !== 'ANSWER_JUDGED') return context.playedIds
        return closeQuestion(context) ? withPlayed(context.playedIds, context.activeQuestionId) : context.playedIds
      },
      heard: ({ event }) => (event.type === 'ANSWER_JUDGED' ? event.judgment.heard : ''),
      wrongHeard: ({ context, event }) => rememberWrong(context.wrongHeard, event),
      sayCloseGuess: ({ context, event }) => {
        const attempts = rememberWrong(context.wrongHeard, event)
        if (!incorrectReveals(context, event)) return false
        return rollCloseGuess(attempts)
      },
      judgmentReason: ({ event }) => (event.type === 'ANSWER_JUDGED' ? event.judgment.reason : ''),
      judgmentStatus: ({ context, event }) => outcomeStatus(context, event),
      announceKind: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (status === 'correct') return 'correct'
        if (status === 'incorrect') return 'incorrect'
        if (status === 'near_miss') return 'repeat'
        return 'unclear'
      },
      chooserId: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (status === 'near_miss' || event.type !== 'ANSWER_JUDGED') return context.chooserId
        return event.judgment.playerId
      },
      clarifications: ({ context, event }) => (asksRepeat(context, event) ? context.clarifications + 1 : context.clarifications),
      statusLine: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (status === 'correct') return 'Верно'
        if (status === 'incorrect') return 'Неверно'
        if (status === 'near_miss') return 'Повторите, пожалуйста'
        if (status === 'unintelligible') return 'Ответ не разобран'
        if (status === 'ambiguous') return 'Ответ спорный'
        if (status === 'needs_clarification') return 'Нужно было уточнить, в этом прототипе вопрос закрыт'
        return 'Оценка получена'
      },
    }),
    rearmAnswer: assign({
      attemptId: ({ context }) => context.attemptId + 1,
      heard: () => '',
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      statusLine: ({ context }) => `Отвечает игрок ${context.activePlayerId ?? ''}`,
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: () => gameConfig.clarifyMs,
    }),
    nobodyAnswered: assign({
      playedIds: ({ context }) => withPlayed(context.playedIds, context.activeQuestionId),
      sayCloseGuess: ({ context }) => rollCloseGuess(context.wrongHeard),
      announceKind: () => 'nobody' as AnnounceKind,
      statusLine: () => 'Никто не нажал кнопку',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    silencePenalty: assign({
      players: ({ context }) => changeScore(context, context.activePlayerId, -stakeOf(context)),
      missedIds: ({ context }) =>
        isFinal(context) ? context.missedIds : addMissed(context.missedIds, context.activePlayerId),
      playedIds: ({ context }) => {
        if (!isFinal(context)) {
          const missed = addMissed(context.missedIds, context.activePlayerId)
          if (othersCanBuzz(context, missed)) return context.playedIds
        }
        return closeQuestion(context) ? withPlayed(context.playedIds, context.activeQuestionId) : context.playedIds
      },
      sayCloseGuess: ({ context }) => (silenceReveals(context) ? rollCloseGuess(context.wrongHeard) : false),
      announceKind: () => 'silence' as AnnounceKind,
      judgmentStatus: () => 'incorrect' as const,
      chooserId: ({ context }) => context.activePlayerId ?? context.chooserId,
      statusLine: ({ context }) => {
        if (isFinal(context)) return 'Время на ответ вышло'
        const missed = addMissed(context.missedIds, context.activePlayerId)
        return othersCanBuzz(context, missed) ? 'Время вышло' : 'Время на ответ вышло'
      },
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    judgeTimeout: assign({
      playedIds: ({ context }) =>
        closeQuestion(context) ? withPlayed(context.playedIds, context.activeQuestionId) : context.playedIds,
      sayCloseGuess: () => false,
      announceKind: () => 'unclear' as AnnounceKind,
      statusLine: () => 'Оценка не пришла вовремя, очки не меняются',
      judgmentReason: () => 'Модель не успела оценить ответ',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    clearTimer: assign({
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    setFinishedStatus: assign({
      statusLine: () => 'Игра закончена',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    advanceRound: assign({
      roundIndex: ({ context }) => {
        const next = nextPlayableRound(context.rounds, context.questions, context.roundIndex)
        return next === -1 ? context.roundIndex : next
      },
      activeQuestionId: () => null,
      activePlayerId: () => null,
      chooserId: ({ context }) => openingChooser(context.players),
      missedIds: () => [],
      activeStake: () => null,
      finalists: () => [],
      finalCursor: () => 0,
      bets: () => [],
      betMisses: () => 0,
      heard: () => '',
      wrongHeard: () => [],
      sayCloseGuess: () => false,
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      clarifyReason: () => '',
      clarifications: () => 0,
      talkedDuringRead: () => false,
      sayFalseStart: () => false,
      falseStarts: () => ({}),
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
      earlyLeftMs: () => null,
      earlyStartedAt: () => null,
      pauseStartedAt: () => null,
      statusLine: ({ context }) => {
        const next = nextPlayableRound(context.rounds, context.questions, context.roundIndex)
        return context.rounds.find((round) => round.index === next)?.name ?? 'Следующий раунд'
      },
    }),
    clearActivePlay: assign({
      activeQuestionId: () => null,
      activePlayerId: () => null,
      missedIds: () => [],
      heard: () => '',
      wrongHeard: () => [],
      sayCloseGuess: () => false,
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      clarifyReason: () => '',
      clarifications: () => 0,
      talkedDuringRead: () => false,
      sayFalseStart: () => false,
      activeStake: () => null,
      finalists: () => [],
      finalCursor: () => 0,
      bets: () => [],
      betMisses: () => 0,
      falseStarts: () => ({}),
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
      earlyLeftMs: () => null,
      earlyStartedAt: () => null,
      pauseStartedAt: () => null,
    }),
    prepareFinalists: assign({
      finalists: ({ context }) =>
        context.players
          .filter((player) => player.score > 0)
          .sort((left, right) => left.score - right.score || left.id - right.id)
          .map((player) => player.id),
      finalCursor: () => 0,
      bets: () => [],
      betMisses: () => 0,
    }),
    placeBet: assign({
      bets: ({ context, event }) =>
        event.type === 'BET_PLACED' ? [...context.bets, { playerId: event.playerId, amount: event.amount }] : context.bets,
      betMisses: () => 0,
    }),
    placeMinimumBet: assign({
      bets: ({ context }) => {
        const playerId = currentFinalist(context)
        if (!playerId) return context.bets
        return [...context.bets, { playerId, amount: 1 }]
      },
      betMisses: () => 0,
      statusLine: () => 'Ставка 1',
    }),
    noteBetRetry: assign({
      betMisses: ({ context }) => context.betMisses + 1,
      statusLine: () => 'Назовите ставку ещё раз',
    }),
    nextBettor: assign({
      finalCursor: ({ context }) => context.finalCursor + 1,
      betMisses: () => 0,
    }),
    armFinalAnswers: assign({
      finalCursor: () => 0,
      betMisses: () => 0,
      activePlayerId: () => null,
    }),
    addPlayer: assign({
      players: ({ context, event }) => {
        if (event.type !== 'ADD_PLAYER') return context.players
        const clientId = event.player.clientId?.trim()
        if (!clientId) return context.players
        if (context.players.some((player) => player.clientId === clientId)) return context.players
        return [...context.players, { ...event.player, clientId }]
      },
    }),
    nextFinalist: assign({
      finalCursor: ({ context }) => context.finalCursor + 1,
    }),
    assignFinalAnswerer: assign({
      activePlayerId: ({ context }) => currentFinalist(context),
      attemptId: ({ context }) => context.attemptId + 1,
      clarifications: () => 0,
      activeStake: ({ context }) => {
        const playerId = currentFinalist(context)
        return context.bets.find((bet) => bet.playerId === playerId)?.amount ?? 1
      },
      heard: () => '',
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      statusLine: ({ context }) => `Отвечает игрок ${currentFinalist(context) ?? ''}`,
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
  },
  guards: {
    purposeWelcome: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'welcome',
    purposeRead: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'read',
    purposeClarify: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'clarify',
    purposeAnnounce: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'announce',
    purposeFinished: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'finished',
    purposeBridge: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'bridge',
    purposeBet: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'bet',
    purposeTurn: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'turn',
    purposeChooserHandoff: ({ event }) =>
      event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'chooserHandoff',
    purposeFalseStart: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'falseStart',
    validChooserHandoff: ({ context, event }) =>
      event.type === 'CHOOSER_OFFLINE' &&
      event.fromPlayerId === context.chooserId &&
      event.toPlayerId !== event.fromPlayerId &&
      inRoster(context, event.toPlayerId),
    sayFalseStart: ({ context }) => context.sayFalseStart,
    readFinal: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'read' && isFinal(context),
    earlyBuzzAllowed: ({ context }) => !isFinal(context),
    moreFinalists: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' &&
      event.purpose === 'announce' &&
      isFinal(context) &&
      context.finalists.length > 0 &&
      context.finalCursor < context.finalists.length - 1,
    roundOverAndNext: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' &&
      event.purpose === 'announce' &&
      roundFinished(context) &&
      nextPlayableRound(context.rounds, context.questions, context.roundIndex) !== -1,
    roundOver: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' &&
      event.purpose === 'announce' &&
      roundFinished(context) &&
      nextPlayableRound(context.rounds, context.questions, context.roundIndex) === -1,
    questionAvailable: ({ context, event }) => {
      if (event.type !== 'QUESTION_SELECTED') return false
      const question = findQuestion(
        context.questions,
        context.roundIndex,
        event.themeId,
        event.value,
        roundKind(context),
        context.playedIds,
      )
      return Boolean(question && !context.playedIds.includes(question.id))
    },
    finalQuestion: ({ context, event }) => {
      if (event.type !== 'QUESTION_SELECTED' || !isFinal(context)) return false
      const question = findQuestion(
        context.questions,
        context.roundIndex,
        event.themeId,
        event.value,
        'final',
        context.playedIds,
      )
      return Boolean(question && !context.playedIds.includes(question.id) && context.players.some((player) => player.score > 0))
    },
    finalWithoutPlayers: ({ context, event }) => {
      if (event.type !== 'QUESTION_SELECTED' || !isFinal(context)) return false
      const question = findQuestion(
        context.questions,
        context.roundIndex,
        event.themeId,
        event.value,
        'final',
        context.playedIds,
      )
      return Boolean(question && context.players.every((player) => player.score <= 0))
    },
    betMatches: ({ context, event }) => {
      if (event.type !== 'BET_PLACED') return false
      const playerId = currentFinalist(context)
      return event.playerId === playerId && event.amount >= 1 && event.amount <= playerScore(context, playerId)
    },
    betGiveUp: ({ context }) => context.betMisses >= 1,
    moreBets: ({ context }) => context.finalCursor < context.finalists.length - 1,
    validPlayer: ({ context, event }) =>
      event.type === 'BUZZER_PRESSED' &&
      inRoster(context, event.playerId) &&
      !context.missedIds.includes(event.playerId) &&
      !falseStartCooling(context.falseStarts[event.playerId], Date.now()),
    canFalseStart: ({ context, event }) =>
      event.type === 'BUZZER_PRESSED' &&
      inRoster(context, event.playerId) &&
      !isFinal(context) &&
      !falseStartCooling(context.falseStarts[event.playerId], Date.now()),
    othersCanAnswer: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' &&
      event.purpose === 'announce' &&
      !isFinal(context) &&
      (context.announceKind === 'incorrect' || context.announceKind === 'silence') &&
      Boolean(context.activeQuestionId) &&
      !context.playedIds.includes(context.activeQuestionId ?? ''),
    hasNextRound: ({ context }) =>
      nextPlayableRound(context.rounds, context.questions, context.roundIndex) !== -1,
    pausedAfterFinish: ({ context }) => context.resumePath === 'finished',
    pendingRestore: ({ context }) => context.resumePath !== '',
    samePlayerRepeats: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'announce' && context.announceKind === 'repeat',
    judgmentMatches: ({ context, event }) => {
      if (event.type !== 'ANSWER_JUDGED') return false
      return (
        event.judgment.questionId === context.activeQuestionId &&
        event.judgment.playerId === context.activePlayerId &&
        event.judgment.attemptId === context.attemptId
      )
    },
  },
}).createMachine({
  id: 'game',
  initial: 'startMenu',
  context: freshContext,
  on: {
    RESET_GAME: { target: '.startMenu', actions: 'resetMatch' },
    CONNECTION_LOST: { target: '.failed', actions: 'setError' },
    PAUSE: {
      guard: and([not(stateIn('paused')), not(stateIn('stopped'))]),
      target: '.paused',
      actions: 'rememberPause',
    },
    STOP: {
      guard: not(stateIn('stopped')),
      target: '.stopped',
      actions: 'rememberStop',
    },
    NEXT_ROUND: [
      {
        guard: and([liveRoundSkip(), 'hasNextRound']),
        target: '.bridging',
        reenter: true,
        actions: 'advanceRound',
      },
      { guard: liveRoundSkip(), target: '.finished', actions: 'clearActivePlay' },
    ],
    ADD_PLAYER: {
      guard: not(stateIn('startMenu')),
      actions: 'addPlayer',
    },
  },
  states: {
    startMenu: {
      on: {
        START_GAME: { target: 'connecting', actions: 'loadPack' },
        CONTINUE_GAME: { target: 'connecting', actions: 'loadSaved' },
      },
    },
    connecting: {
      on: {
        CONNECTED: [
          { guard: 'pendingRestore', target: 'restoring', actions: 'clearError' },
          { target: 'welcoming', actions: 'clearError' },
        ],
        CONNECTION_FAILED: { target: 'failed', actions: 'setError' },
      },
    },
    restoring: {
      always: [
        { guard: ({ context }) => context.resumePath === 'welcoming', target: 'welcoming', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'choosing.listening', target: 'choosing.listening', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'flashing', target: 'flashing', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'reading.sealed', target: 'reading.sealed', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'reading.armed', target: 'reading.armed', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'falseStartCue', target: 'falseStartCue', actions: 'clearResume' },
        {
          guard: ({ context }) => context.resumePath === 'buzzing.open',
          target: 'buzzing',
          actions: ['clearResume', 'startRestoredBuzzer'],
        },
        { guard: ({ context }) => context.resumePath === 'answering.waiting', target: 'answering.waiting', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'announcing', target: 'announcing', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'bridging', target: 'bridging', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'turnCue', target: 'turnCue', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalBets.asking', target: 'finalBets.asking', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finished', target: 'finished', actions: 'clearResume' },
        { target: 'choosing.listening', actions: 'clearResume' },
      ],
    },
    welcoming: {
      entry: 'setWelcomeStatus',
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeWelcome', target: 'choosing' },
      },
    },
    choosing: {
      initial: 'listening',
      entry: 'setChoosingStatus',
      on: {
        CHOOSER_OFFLINE: {
          guard: 'validChooserHandoff',
          target: '#game.chooserHandoff',
          actions: 'handoffChooser',
        },
      },
      states: {
        listening: {
          on: {
            PLAYER_SPEECH_FINISHED: 'resolving',
            QUESTION_SELECTED: [
              { guard: 'finalWithoutPlayers', target: '#game.finished' },
              { guard: 'finalQuestion', target: '#game.finalBets', actions: ['openQuestion', 'prepareFinalists'] },
              { guard: 'questionAvailable', target: '#game.flashing', actions: 'openQuestion' },
              { target: 'clarifying', actions: 'noteUnavailable' },
            ],
            QUESTION_UNCLEAR: { target: 'clarifying', actions: 'noteUnclear' },
          },
        },
        resolving: {
          entry: 'setResolvingStatus',
          after: { judgeMs: { target: 'listening', actions: 'selectionTimeout' } },
          on: {
            QUESTION_SELECTED: [
              { guard: 'finalWithoutPlayers', target: '#game.finished' },
              { guard: 'finalQuestion', target: '#game.finalBets', actions: ['openQuestion', 'prepareFinalists'] },
              { guard: 'questionAvailable', target: '#game.flashing', actions: 'openQuestion' },
              { target: 'clarifying', actions: 'noteUnavailable' },
            ],
            QUESTION_UNCLEAR: { target: 'clarifying', actions: 'noteUnclear' },
            SELECTION_FAILED: { target: 'listening', actions: 'noteUnclear' },
          },
        },
        clarifying: {
          on: {
            HOST_AUDIO_FINISHED: {
              guard: 'purposeClarify',
              target: 'listening',
              actions: 'setChoosingStatus',
            },
            PLAYER_SPEECH_STARTED: { target: 'listening', actions: 'setChoosingStatus' },
          },
        },
      },
    },
    chooserHandoff: {
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeChooserHandoff', target: 'choosing' },
      },
    },
    flashing: {
      after: { cellFlashMs: { target: 'reading', actions: 'armEarlyClock' } },
      on: {
        BUZZER_PRESSED: { guard: 'canFalseStart', actions: 'markFalseStart' },
      },
    },
    reading: {
      initial: 'sealed',
      entry: 'setReadingStatus',
      on: {
        TALKED_OVER: { actions: 'noteTalkedOver' },
      },
      states: {
        sealed: {
          entry: 'noteEarlyStart',
          after: {
            earlyLeft: { guard: 'earlyBuzzAllowed', target: 'armed' },
          },
          on: {
            BUZZER_PRESSED: { guard: 'canFalseStart', actions: 'markFalseStart' },
            HOST_AUDIO_FINISHED: [
              { guard: 'readFinal', target: '#game.turnCue', actions: 'clearEarlyBuzz' },
              { guard: 'purposeRead', target: '#game.afterReading', actions: ['clearEarlyBuzz', 'decideFalseStartCallout'] },
            ],
          },
        },
        armed: {
          entry: 'startArmedBuzzer',
          after: {
            buzzerMs: { target: '#game.announcing', actions: 'nobodyAnswered' },
          },
          on: {
            BUZZER_PRESSED: {
              guard: 'validPlayer',
              target: '#game.answering',
              actions: ['clearEarlyBuzz', 'assignAnswerer'],
            },
            HOST_AUDIO_FINISHED: {
              guard: 'purposeRead',
              target: '#game.buzzing',
              actions: 'clearEarlyBuzz',
            },
          },
        },
      },
    },
    afterReading: {
      always: [
        { guard: 'sayFalseStart', target: 'falseStartCue' },
        { target: 'buzzing', actions: 'startBuzzerTimer' },
      ],
    },
    falseStartCue: {
      on: {
        TALKED_OVER: { actions: 'noteTalkedOver' },
        HOST_AUDIO_FINISHED: { guard: 'purposeFalseStart', target: 'buzzing', actions: 'startBuzzerTimer' },
        BUZZER_PRESSED: { guard: 'validPlayer', target: '#game.answering', actions: 'assignAnswerer' },
      },
    },
    bridging: {
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeBridge', target: 'choosing' },
      },
    },
    finalBets: {
      initial: 'asking',
      states: {
        asking: {
          on: {
            HOST_AUDIO_FINISHED: { guard: 'purposeBet', target: 'hearing' },
          },
        },
        hearing: {
          after: {
            answerMs: [
              { guard: 'betGiveUp', target: 'placed', actions: 'placeMinimumBet' },
              { target: 'asking', actions: 'noteBetRetry', reenter: true },
            ],
          },
          on: {
            PLAYER_SPEECH_FINISHED: 'resolving',
          },
        },
        resolving: {
          after: {
            judgeMs: [
              { guard: 'betGiveUp', target: 'placed', actions: 'placeMinimumBet' },
              { target: 'asking', actions: 'noteBetRetry', reenter: true },
            ],
          },
          on: {
            BET_PLACED: { guard: 'betMatches', target: 'placed', actions: 'placeBet' },
            BET_UNCLEAR: [
              { guard: 'betGiveUp', target: 'placed', actions: 'placeMinimumBet' },
              { target: 'asking', actions: 'noteBetRetry', reenter: true },
            ],
          },
        },
        placed: {
          always: [
            { guard: 'moreBets', target: 'asking', actions: 'nextBettor', reenter: true },
            { target: '#game.flashing', actions: 'armFinalAnswers' },
          ],
        },
      },
    },
    turnCue: {
      entry: 'assignFinalAnswerer',
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeTurn', target: 'answering' },
      },
    },
    buzzing: {
      initial: 'open',
      states: {
        open: {
          after: { buzzerLeft: { target: '#game.announcing', actions: 'nobodyAnswered' } },
        },
      },
      on: {
        BUZZER_PRESSED: { guard: 'validPlayer', target: '#game.answering', actions: 'assignAnswerer' },
        UNBUTTONED_TALK: { actions: 'noteUnbuttonedTalk' },
        TALKED_OVER: { actions: 'noteTalkedOver' },
      },
    },
    answering: {
      initial: 'waiting',
      states: {
        waiting: {
          entry: 'startAnswerTimer',
          after: { answerLeft: { target: '#game.announcing', actions: 'silencePenalty' } },
          on: {
            PLAYER_SPEECH_STARTED: { target: 'hearing', actions: 'clearTimer' },
            PLAYER_SPEECH_FINISHED: '#game.judging',
          },
        },
        hearing: {
          after: { judgeMs: { target: '#game.announcing', actions: 'silencePenalty' } },
          on: {
            PLAYER_SPEECH_FINISHED: '#game.judging',
          },
        },
      },
    },
    judging: {
      entry: 'setJudgingStatus',
      after: { judgeMs: { target: 'announcing', actions: 'judgeTimeout' } },
      on: {
        ANSWER_JUDGED: [
          { guard: 'judgmentMatches', target: 'announcing', actions: 'applyJudgment' },
        ],
        ANSWER_ECHO: { target: 'answering' },
      },
    },
    announcing: {
      entry: 'clearTimer',
      on: {
        HOST_AUDIO_FINISHED: [
          { guard: 'samePlayerRepeats', target: 'answering', actions: 'rearmAnswer' },
          { guard: 'moreFinalists', target: 'turnCue', actions: 'nextFinalist' },
          { guard: 'othersCanAnswer', target: 'buzzing', actions: 'reopenBuzzers' },
          { guard: 'roundOverAndNext', target: 'bridging', actions: 'advanceRound' },
          { guard: 'roundOver', target: 'finished' },
          { guard: 'purposeAnnounce', target: 'choosing' },
        ],
      },
    },
    stopped: {},
    paused: {
      on: {
        RESUME: [
          { guard: ({ context }) => context.resumePath === 'welcoming', target: 'welcoming', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'bridging', target: 'bridging', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'choosing.listening', target: 'choosing.listening', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'choosing.resolving', target: 'choosing.resolving', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'choosing.clarifying', target: 'choosing.clarifying', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'chooserHandoff', target: 'chooserHandoff', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'flashing', target: 'flashing', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'reading.armed', target: 'reading.armed', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'falseStartCue', target: 'falseStartCue', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'reading' || context.resumePath === 'reading.sealed', target: 'reading.sealed', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'buzzing' || context.resumePath === 'buzzing.open' || context.resumePath === 'buzzing.reminding', target: 'buzzing', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'answering.waiting', target: 'answering.waiting', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'answering.hearing', target: 'answering.hearing', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'judging', target: 'judging', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'announcing', target: 'announcing', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'turnCue', target: 'turnCue', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'finalBets.asking', target: 'finalBets.asking', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'finalBets.hearing', target: 'finalBets.hearing', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'finalBets.resolving', target: 'finalBets.resolving', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'finished', target: 'finished', actions: 'resumeClock' },
        ],
      },
    },
    finished: {
      entry: 'setFinishedStatus',
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeFinished', actions: 'clearTimer' },
      },
    },
    failed: {
      on: {
        START_GAME: { target: 'connecting', actions: 'loadPack' },
        CONTINUE_GAME: { target: 'connecting', actions: 'loadSaved' },
      },
    },
  },
})

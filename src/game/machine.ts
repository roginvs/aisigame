import { and, assign, not, or, setup, stateIn } from 'xstate'
import { auctionOptions, nextAuctionBidder, sameOption } from './auction.ts'
import { autoCatRecipient, nextInCircle } from './cat.ts'
import { appealMsLeft, appealRequestError, appealStake, appealWindowMs, eligibleAppealPlayers, settleOutcome } from './appeals.ts'
import { gameConfig } from '../config.ts'
import { answerOverrunSafetyMs, answerUtteranceJudgeMs, catAwayWaitMs, finalStakeMs, finalTypedMs } from '../options.ts'
import { advanceIdle, enterIdle, idleDelay, idleIsFinal, idleThresholds, pauseIdle, type IdleKind } from './idle.ts'
import { questionSpeech } from './choices.ts'
import { exactAnswer } from './judgment.ts'
import { earlyBuzzerMsFor } from './earlyBuzzer.ts'
import { findQuestion, nextPlayableRound, questionById, questionsInRound, roundThemes } from './pack.ts'
import { answererStatus, defaultPlayers, openingChooser } from './players.ts'
import { demoPack } from './questions.ts'
import { answerHasClip, publicAnswerHasPlayable } from './reveal.ts'
import { answerMediaMaxMs, answerMediaMinMs } from '../options.ts'
import { restoredMatch } from './savedGame.ts'
import type { AnnounceKind, GameContext, GameEvent, JudgmentStatus, Player, PlayerId, QuestionPack, SpecialState } from './types.ts'

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
    outcomes: {},
    appeal: null,
    appealSerial: 0,
    playedIds: [],
    missedIds: [],
    finalists: [],
    finalCursor: 0,
    bets: [],
    betMisses: 0,
    finalStriker: openingChooser(roster, 0),
    struckThemes: [],
    typedAnswers: {},
    revealedIds: [],
    stakeShownIds: [],
    activeStake: null,
    activeQuestionId: null,
    activePlayerId: null,
    chooserId: openingChooser(roster, 0),
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
    special: null,
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

/** Кот в мешке или аукцион на текущей ячейке. */
export function isSpecial(context: GameContext): boolean {
  return Boolean(context.special && context.special.questionId === context.activeQuestionId)
}

function baseSpecial(kind: SpecialState['kind'], questionId: string, giverId: PlayerId, patch: Partial<SpecialState>): SpecialState {
  return {
    kind, questionId, giverId, recipientId: null, stakeOptions: [], stake: null, nominal: 0,
    order: [], passed: [], leaderId: null, bid: null, allIn: false, options: [], log: [], unclear: '',
    awayPlayerId: null, awayFrom: null, awayNextChooser: null, ...patch,
  }
}

function playerName(context: GameContext, id: PlayerId | null | undefined): string {
  return context.players.find((player) => player.id === id)?.name ?? `Игрок ${id ?? ''}`
}

function circleFrom(players: Player[], firstId: PlayerId): PlayerId[] {
  const start = Math.max(0, players.findIndex((player) => player.id === firstId))
  return players.map((_, offset) => players[(start + offset) % players.length]!.id)
}

function auctionNext(context: GameContext) {
  const special = context.special!
  return nextAuctionBidder({
    order: special.order, fromId: special.recipientId ?? special.giverId, leaderId: special.leaderId, passed: special.passed,
    scoreOf: (id) => playerScore(context, id), nominal: special.nominal, bid: special.bid, allIn: special.allIn,
  })
}

function selectedQuestion(context: GameContext, event: GameEvent) {
  if (event.type !== 'QUESTION_SELECTED') return undefined
  const question = findQuestion(context.questions, context.roundIndex, event.themeId, event.value, roundKind(context), context.playedIds)
  return question && !context.playedIds.includes(question.id) ? question : undefined
}

function awayPatch(context: GameContext, event: GameEvent, from: NonNullable<SpecialState['awayFrom']>): Partial<GameContext> {
  if (event.type !== 'SPECIAL_PLAYER_OFFLINE' || !context.special) return {}
  return {
    special: { ...context.special, awayPlayerId: event.playerId, awayFrom: from, awayNextChooser: event.nextChooserId },
    statusLine: `Ждём игрока ${playerName(context, event.playerId)}`,
    phaseStartedAt: Date.now(), phaseDurationMs: catAwayWaitMs,
  }
}

const heardPurpose = (purpose: string) => ({ event }: { event: GameEvent }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === purpose

function othersCanBuzz(context: GameContext, missed: PlayerId[]): boolean {
  if (isFinal(context) || isSpecial(context)) return false
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

/** Темы финала, ещё не вычеркнутые игроками. */
function openFinalThemes(context: GameContext): { id: string; name: string }[] {
  if (!isFinal(context)) return []
  return roundThemes(context.questions, context.roundIndex).filter((theme) => !(context.struckThemes ?? []).includes(theme.id))
}

/** Клик по табло в финале = удар, пока тем открыто больше одной; в остальном выбор закрыт до finalDraft. */
function strikeThemeOf(context: GameContext, event: GameEvent): string | null {
  if (event.type === 'STRIKE_THEME') return event.themeId
  if (event.type === 'QUESTION_SELECTED' && isFinal(context) && openFinalThemes(context).length > 1) {
    return event.themeId
  }
  return null
}

/** Вычеркнуть тему может только тот, чей сейчас ход вычёркивания, и только открытую тему финала. */
function strikeValid(context: GameContext, event: GameEvent): boolean {
  const themeId = strikeThemeOf(context, event)
  if (!themeId || !isFinal(context)) return false
  if (event.type === 'STRIKE_THEME' && event.playerId !== context.finalStriker) return false
  return openFinalThemes(context).some((theme) => theme.id === themeId)
}

/** Вычеркнута последняя из двух открытых тем — после этого удара остаётся одна. */
function strikeCloses(context: GameContext, event: GameEvent): boolean {
  if (!strikeValid(context, event)) return false
  const struckId = strikeThemeOf(context, event) ?? ''
  return openFinalThemes(context).filter((theme) => theme.id !== struckId).length <= 1
}

/** Темы финала, которые открыты больше одной — идёт круг вычёркивания. */ 
export function finalStrikerTurnOpen(context: GameContext): boolean {
  return isFinal(context) && openFinalThemes(context).length > 1 && context.finalStriker !== undefined
}

/** Финал: напечатанный ответ, который решается без модели — пусто (неверно) или точное совпадение с эталоном. */
function typedInstantVerdict(context: GameContext): { status: JudgmentStatus; heard: string } | null {
  const playerId = context.activePlayerId
  const question = questionById(context.questions, context.activeQuestionId)
  if (!playerId || !question) return null
  const text = (context.typedAnswers?.[playerId] ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { status: 'incorrect', heard: '' }
  if (exactAnswer(text, question.answers)) return { status: 'correct', heard: text }
  return null
}

/** Вердикт финала — по статусу оценки: counter correct/incorrect, спорное — unclear. */
function verdictKind(event: GameEvent): AnnounceKind | null {
  if (event.type !== 'ANSWER_JUDGED') return null
  if (event.judgment.status === 'correct') return 'correct'
  if (event.judgment.status === 'incorrect') return 'incorrect'
  return 'unclear'
}

function verdictLabel(status: JudgmentStatus): string {
  if (status === 'correct') return 'Верно'
  if (status === 'incorrect') return 'Неверно'
  return 'Ответ спорный'
}

/** Итоговая строка финала: победитель — лучший счёт; при равенстве — все лидеры. */
function finalResultLine(context: GameContext): string {
  const best = Math.max(...context.players.map((player) => player.score))
  const winners = context.players.filter((player) => player.score === best).map((player) => player.name)
  const winnerName = winners[0] ?? ''
  return winners.length === 1 ? `Победитель: ${winnerName}` : `Победители: ${winners.join(', ')}`
}

function showsClock(path: string): boolean {
  return (
    path === 'buzzing' ||
    path === 'buzzing.open' ||
    path === 'buzzing.reminding' ||
    path === 'answering.waiting' ||
    path === 'finalBets.collecting' ||
    path === 'finalTyped'
  )
}

function clockMs(path: string, missedIds: readonly PlayerId[] = [], clarifications = 0): number | null {
  if (path === 'buzzing' || path === 'buzzing.open' || path === 'buzzing.reminding') {
    return missedIds.length > 0 ? gameConfig.stealBuzzerMs : gameConfig.buzzerMs
  }
  if (path === 'finalBets.collecting') return finalStakeMs
  if (path === 'finalTyped') return finalTypedMs
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

/**
 * Обычный раунд, ячейка уже закрыта, в раунде ещё есть вопросы: пока ведущая
 * комментирует итог, табло уже на экране и выбирающий может открыть следующий
 * вопрос (выбор обрывает речь). Не во время апелляции, повтора и медиа ответа.
 */
/** Сколько ещё держать медиа ответа после речи ведущей. */
export function answerHoldLeft(context: GameContext, now: number): number {
  const elapsed = now - (context.answerShownAt ?? now)
  const question = questionById(context.questions, context.activeQuestionId)
  const waitingClip = answerHasClip(question?.answerMedia) && !context.answerClipEnded
  const until = waitingClip ? answerMediaMaxMs : answerMediaMinMs
  return Math.max(0, Math.min(until, answerMediaMaxMs) - elapsed)
}

export function earlyPickOpen(path: string, context: GameContext): boolean {
  if (path !== 'announcing.speaking' && path !== 'announcing') return false
  if (isFinal(context) || context.announceKind === 'repeat') return false
  if (context.appeal?.activePlayerId != null) return false
  const question = questionById(context.questions, context.activeQuestionId)
  if (!question || !context.playedIds.includes(question.id)) return false
  if (roundFinished(context)) return false
  return !publicAnswerHasPlayable({ kind: context.announceKind, cellClosed: true, answerMedia: question.answerMedia })
}

/** Можно ли сейчас выбрать ячейку (голос/клик выбирающего). */
export function pickOpen(path: string, context: GameContext): boolean {
  // Ранний слух на выборе: пока ведущая уточняет, напоминает или передаёт ход — табло тоже кликабельно.
  return path === 'choosing.listening' || path === 'choosing.clarifying' || path === 'choosing.resolving' || path === 'chooserHandoff' || earlyPickOpen(path, context)
}

export function isAnnouncingPath(path: string): boolean {
  return path === 'announcing' || path.startsWith('announcing.')
}

export function isAnnounceSpeakingPath(path: string): boolean {
  return path === 'announcing' || path === 'announcing.speaking'
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
    const [key, nested]: [string?, unknown?] = Object.entries(value as Record<string, unknown>)[0] ?? []
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
    appealLeft: ({ context }) => context.appeal ? appealMsLeft(context.appeal) : appealWindowMs(),
    buzzerMs: gameConfig.buzzerMs,
    buzzerLeft: ({ context }) => buzzerMsLeft(context),
    answerMs: gameConfig.answerMs,
    answerLeft: ({ context }) => (context.clarifications > 0 ? gameConfig.clarifyMs : gameConfig.answerMs),
    judgeMs: gameConfig.judgeMs,
    answerSettleSafetyMs: answerOverrunSafetyMs + answerUtteranceJudgeMs,
    cellFlashMs: gameConfig.cellFlashMs,
    deadlineFinalStake: finalStakeMs,
    deadlineFinalTyped: finalTypedMs,
    earlyLeft: ({ context }) => context.earlyLeftMs ?? gameConfig.earlyBuzzerMs,
    // С момента показа: пока играет звук/ролик — до max; потом (или без клипа) — добрать до min.
    answerHoldLeft: ({ context }) => answerHoldLeft(context, Date.now()),
    catAwayWaitMs: catAwayWaitMs,
    idleStep: ({ context }) => idleDelay(context.idle),
  },
  actions: {
    noteTalk: assign(({ context, event }) => {
      const talk = { host: Boolean(context.talk?.host), player: Boolean(context.talk?.player) }
      if (event.type === 'IDLE_SPEECH') talk.player = event.active
      if (event.type === 'HOST_TALKING') talk.host = event.active
      return { talk }
    }),
    idleEnter: assign(({ context }, params: { kind: IdleKind }) => {
      const clock = enterIdle(context.idle, params.kind, context.talk, Date.now())
      const fresh = clock.stage === 0 && clock.elapsedMs === 0 && !context.idle?.carry
      return fresh ? { idle: clock, idleOutcome: null } : { idle: clock }
    }),
    idleTalk: assign(({ context, event }) => {
      if (!context.idle) return {}
      const reset = event.type === 'IDLE_SPEECH' && event.active
      return { idle: pauseIdle(context.idle, Date.now(), reset) }
    }),
    idleNudge: assign(({ context }) => {
      if (!context.idle) return {}
      let idle = advanceIdle(context.idle, Date.now())
      // Один игрок: передавать ход некому — напоминаем дальше с тем же шагом.
      if (idle.kind === 'choosing' && context.players.length <= 1 && idleIsFinal(idle)) {
        const steps = idleThresholds('choosing')
        idle = { ...idle, stage: steps.length - 2, elapsedMs: steps[steps.length - 3] ?? 0 }
      }
      return { idle, idleNudges: (context.idleNudges ?? 0) + 1 }
    }),
    idlePassChooser: assign(({ context }) => {
      const fromId = context.chooserId
      const toId = context.players.length > 1 ? nextInCircle(context.players, fromId) ?? fromId : fromId
      return {
        chooserId: toId,
        idle: null,
        idleOutcome: { kind: 'choosing' as const, fromId, toId, waitedMs: context.idle?.elapsedMs ?? 0 },
        clarifyReason: '',
        statusLine: toId === fromId ? `${playerName(context, fromId)}, выбирайте вопрос` : `Выбирает ${playerName(context, toId)}`,
      }
    }),
    idleGiveCat: assign(({ context }) => {
      const special = context.special
      if (!special) return {}
      const others = context.players.filter((player) => player.id !== special.giverId)
      const toId = others[Math.floor(Math.random() * others.length)]?.id ?? special.giverId
      return {
        special: { ...special, recipientId: toId, unclear: '' },
        idle: null,
        idleOutcome: { kind: 'catPick' as const, fromId: special.giverId, toId, waitedMs: context.idle?.elapsedMs ?? 0 },
        statusLine: `Кот у игрока ${playerName(context, toId)}`,
      }
    }),
    idleMinStake: assign(({ context }) => {
      const special = context.special
      if (!special) return {}
      const stake = Math.min(...(special.stakeOptions.length ? special.stakeOptions : [special.nominal]))
      return {
        special: { ...special, stake, unclear: '' },
        idle: null,
        idleOutcome: { kind: 'catStake' as const, fromId: special.recipientId ?? 0, toId: special.recipientId, waitedMs: context.idle?.elapsedMs ?? 0, stake },
      }
    }),
    idleAuctionPass: assign(({ context }) => {
      const special = context.special
      if (!special || special.recipientId === null) return {}
      const who = special.recipientId
      const name = playerName(context, who)
      const waitedMs = context.idle?.elapsedMs ?? 0
      if (special.bid === null) {
        return {
          special: { ...special, bid: special.nominal, leaderId: who, options: [], unclear: '', log: [...special.log, `${name} — ${special.nominal}, молча`] },
          idle: null,
          idleOutcome: { kind: 'auction' as const, fromId: who, toId: null, waitedMs, autoOpen: true },
        }
      }
      return {
        special: { ...special, passed: [...special.passed, who], options: [], unclear: '', log: [...special.log, `${name} — пас (молчание)`] },
        idle: null,
        idleOutcome: { kind: 'auction' as const, fromId: who, toId: null, waitedMs },
      }
    }),
    clearAppeals: assign({ appeal: () => null }),
    markRoundSummary: assign(({ context }) => context.appeal ? { appeal: { ...context.appeal, summary: 'pending' as const } } : {}),
    markSummaryDone: assign(({ context }) => context.appeal ? { appeal: { ...context.appeal, summary: 'done' as const } } : {}),
    markAppealTimeUp: assign(({ context }) => context.appeal ? { appeal: { ...context.appeal, timeUp: true, remainingMs: 0, startedAt: null }, phaseStartedAt: null, phaseDurationMs: null } : {}),
    restartAppealClock: assign(({ context }) => context.appeal ? { appeal: { ...context.appeal, startedAt: Date.now() } } : {}),
    openClosedAppeals: assign(({ context }) => {
      const questionId = context.appeal?.questionId ?? context.activeQuestionId
      if (!questionId || isFinal(context) || eligibleAppealPlayers(context, questionId).length === 0) return { appeal: null }
      const windowId = (context.appealSerial ?? 0) + 1
      return { appealSerial: windowId, appeal: { questionId, windowId, stage: 'closed' as const, queue: [], activePlayerId: null,
        lastPlayerId: null, chooserId: context.appeal?.stage === 'closed' ? context.appeal.chooserId : context.chooserId,
        remainingMs: appealWindowMs(), startedAt: Date.now() } }
    }),
    acceptAppeal: assign(({ context, event }) => {
      if (event.type !== 'APPEAL_REQUESTED' || !context.appeal) return {}
      return { appeal: { ...context.appeal, activePlayerId: event.playerId, startedAt: null, acceptedRequestIds: [...context.appeal.acceptedRequestIds ?? [], event.requestId] },
        activeQuestionId: context.appeal.questionId, activePlayerId: event.playerId,
        activeStake: context.outcomes?.[context.appeal.questionId]?.[event.playerId]?.stake ?? null,
        attemptId: context.attemptId + 1, clarifications: 0, heard: '', judgmentStatus: null, announceKind: null,
        judgmentReason: '', phaseStartedAt: null, phaseDurationMs: null, statusLine: 'Повтор ответа' }
    }),
    confirmClosedAppeal: assign(({ context }) => {
      const amount = context.activeQuestionId ? appealStake(context, context.activeQuestionId, context.activePlayerId) : 0
      return { ...settleOutcome(context, amount, true), announceKind: 'correct' as AnnounceKind, judgmentStatus: 'correct' as const,
        judgmentReason: 'Апелляция: игрок подтвердил верный ответ', statusLine: 'Апелляция принята' }
    }),
    /** Минус только что получен — апелляция доступна сразу, ещё во время реплики ведущей. */
    markAnswerShown: assign(() => ({ answerShownAt: Date.now(), answerClipEnded: false })),
    /**
     * Окно медиа ответа (min–max) начинает отсчёт, когда медиа реально включилось:
     * звук и ролик стартуют в holding, уже после объявлении. Картинка появляется
     * вместе с входом в announcing — там якорь в markAnswerShown правильный.
     */
    anchorAnswerHold: assign(({ context }) => {
      const question = questionById(context.questions, context.activeQuestionId)
      if (!question || !answerHasClip(question.answerMedia)) return {}
      return { answerShownAt: Date.now() }
    }),
    markAnswerClipEnded: assign(() => ({ answerClipEnded: true })),
    openAppealNow: assign(({ context }) => {
      if (isFinal(context) || context.appeal?.activePlayerId != null || context.announceKind === 'repeat') return {}
      const questionId = context.activeQuestionId
      if (!questionId) return {}
      const windowId = (context.appealSerial ?? 0) + 1
      const base = { questionId, windowId, queue: [], activePlayerId: null, chooserId: context.chooserId, remainingMs: appealWindowMs(), startedAt: Date.now() }
      if (context.playedIds.includes(questionId)) {
        if (context.appeal?.questionId === questionId && context.appeal.stage === 'closed') return {}
        if (eligibleAppealPlayers(context, questionId).length === 0) return { appeal: null }
        return { appealSerial: windowId, appeal: { ...base, stage: 'closed' as const, lastPlayerId: context.activePlayerId } }
      }
      const playerId = context.activePlayerId
      const outcome = playerId ? context.outcomes?.[questionId]?.[playerId] : undefined
      if (!playerId || !outcome || outcome.amount > 0 || outcome.correct === true) return {}
      if (context.appeal?.questionId === questionId && context.appeal.stage === 'open' && context.appeal.lastPlayerId === playerId) return {}
      return { appealSerial: windowId, appeal: { ...base, stage: 'open' as const, lastPlayerId: playerId } }
    }),
    queueAppeal: assign(({ context, event }) => event.type === 'APPEAL_REQUESTED' && context.appeal
      ? { appeal: { ...context.appeal, queue: [...context.appeal.queue, event.playerId], acceptedRequestIds: [...context.appeal.acceptedRequestIds ?? [], event.requestId] } } : {}),
    nextAppeal: assign(({ context }) => {
      const appeal = context.appeal!
      const playerId = appeal.queue[0]!
      return { appeal: { ...appeal, activePlayerId: playerId, queue: appeal.queue.slice(1) },
        activeQuestionId: appeal.questionId, activePlayerId: playerId, attemptId: context.attemptId + 1,
        clarifications: 0, heard: '', judgmentReason: '', judgmentStatus: null, announceKind: null, statusLine: 'Повтор ответа' }
    }),
    clearError: assign({ error: () => null }),
    setError: assign({
      appeal: () => null,
      error: ({ event }) =>
        event.type === 'CONNECTION_FAILED' || event.type === 'CONNECTION_LOST'
          ? event.message
          : 'Соединение прервалось',
      statusLine: () => 'Связь с ведущей потеряна',
    }),
    resetMatch: assign(() => freshContext()),
    rememberPause: assign({
      appeal: ({ context }) => context.appeal ? { ...context.appeal, remainingMs: appealMsLeft(context.appeal), startedAt: null } : null,
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
      appeal: () => null,
      statusLine: () => 'Остановлена',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
      earlyStartedAt: () => null,
      earlyLeftMs: () => null,
      pauseStartedAt: () => null,
    }),
    resumeClock: assign({
      appeal: ({ context }) => context.appeal ? { ...context.appeal, startedAt: context.appeal.activePlayerId === null ? Date.now() : null } : null,
      statusLine: ({ context }) => context.resumeStatus || 'Дальше',
      phaseStartedAt: ({ context }) => (showsClock(context.resumePath) ? Date.now() : null),
      phaseDurationMs: ({ context }) => clockMs(context.resumePath, context.missedIds, context.clarifications),
      falseStarts: ({ context }) =>
        shiftFalseStarts(context.falseStarts, context.pauseStartedAt === null ? 0 : Date.now() - context.pauseStartedAt),
      pauseStartedAt: () => null,
      resumePath: () => '',
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
      phaseStartedAt: ({ context }) => context.appeal?.stage === 'closed' ? Date.now() : null,
      phaseDurationMs: ({ context }) => context.appeal?.stage === 'closed' ? appealMsLeft(context.appeal) : null,
    }),
    setResolvingStatus: assign({
      statusLine: () => 'Ведущая разбирает выбор',
    }),
    handoffChooser: assign({
      idleOutcome: () => null,
      // Переданию хода подставляется только тот токен, который был у отключившегося:
      // ход выбора и (в финале) право удара идут вместе, только пока это один игрок.
      chooserId: ({ context, event }) =>
        event.type === 'CHOOSER_OFFLINE' && event.fromPlayerId === context.chooserId ? event.toPlayerId : context.chooserId,
      finalStriker: ({ context, event }) => {
        if (event.type !== 'CHOOSER_OFFLINE') return context.finalStriker
        if (!finalStrikerTurnOpen(context) || context.finalStriker !== event.fromPlayerId) return context.finalStriker
        return event.toPlayerId
      },
      clarifyReason: ({ context, event }) => {
        if (event.type !== 'CHOOSER_OFFLINE') return context.clarifyReason
        const disconnected = context.players.find((player) => player.id === event.fromPlayerId)?.name ?? 'Игрок'
        return `${disconnected} отключился`
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
      idleOutcome: () => null,
      appeal: () => null,
      special: () => null,
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
      appealSerial: ({ context }) => (context.appealSerial ?? 0) + 1,
      appeal: ({ context }) => context.activeQuestionId ? {
        questionId: context.activeQuestionId, windowId: (context.appealSerial ?? 0) + 1, stage: 'open' as const,
        queue: [], activePlayerId: null, lastPlayerId: context.activePlayerId, chooserId: context.chooserId,
        remainingMs: appealWindowMs(), startedAt: Date.now(),
      } : null,

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
      appeal: () => null,
      activePlayerId: ({ event }) => (event.type === 'BUZZER_PRESSED' ? event.playerId : null),
      attemptId: ({ context }) => context.attemptId + 1,
      clarifications: () => 0,
      statusLine: ({ context, event }) =>
        event.type === 'BUZZER_PRESSED' ? answererStatus(context, event.playerId) : 'Отвечает игрок',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    startCat: assign(({ context }) => {
      const question = questionById(context.questions, context.activeQuestionId)
      if (!question?.cat) return {}
      const giverId = context.chooserId
      return {
        special: baseSpecial('cat', question.id, giverId, { recipientId: autoCatRecipient(context.players, giverId), stakeOptions: question.cat.options, nominal: question.value }),
        statusLine: 'Кот в мешке', phaseStartedAt: null, phaseDurationMs: null,
      }
    }),
    handoffCatGiver: assign(({ context, event }) => {
      if (event.type !== 'CHOOSER_OFFLINE' || !context.special) return {}
      return { chooserId: event.toPlayerId, special: { ...context.special, giverId: event.toPlayerId, recipientId: autoCatRecipient(context.players, event.toPlayerId) } }
    }),
    setCatRecipient: assign(({ context, event }) => {
      if (event.type !== 'CAT_RECIPIENT' || !context.special) return {}
      return { special: { ...context.special, recipientId: event.playerId, unclear: '' }, statusLine: `Кот у игрока ${playerName(context, event.playerId)}` }
    }),
    noteSpecialUnclear: assign(({ context, event }) => {
      if (!context.special) return {}
      const reason = event.type === 'CAT_PICK_UNCLEAR' || event.type === 'CAT_STAKE_UNCLEAR' || event.type === 'AUCTION_UNCLEAR' ? event.reason : ''
      return { special: { ...context.special, unclear: reason } }
    }),
    setCatStake: assign(({ context, event }) => {
      if (event.type !== 'CAT_STAKE' || !context.special) return {}
      return { special: { ...context.special, stake: event.amount, unclear: '' } }
    }),
    setCatFixedStake: assign(({ context }) => context.special ? { special: { ...context.special, stake: context.special.stakeOptions[0] ?? context.special.nominal } } : {}),
    placeSpecial: assign(({ context }) => {
      const special = context.special
      if (!special) return {}
      const playerId = special.kind === 'cat' ? special.recipientId : special.leaderId
      const stake = special.kind === 'cat' ? special.stake : special.bid
      return { activePlayerId: playerId, activeStake: stake ?? special.nominal, missedIds: [], statusLine: `${playerName(context, playerId)} отвечает за ${stake ?? special.nominal}` }
    }),
    beginSpecialAnswer: assign(({ context }) => ({
      attemptId: context.attemptId + 1, clarifications: 0, heard: '', judgmentReason: '', judgmentStatus: null, announceKind: null,
      statusLine: answererStatus(context, context.activePlayerId),
    })),
    startAuction: assign(({ context }) => {
      const question = questionById(context.questions, context.activeQuestionId)
      if (!question?.auction) return {}
      const giverId = context.chooserId
      const nominal = question.value
      const open = auctionOptions({ nominal, money: playerScore(context, giverId), current: null, currentAllIn: false, opening: true })
      const auto = open.auto
      return {
        special: baseSpecial('auction', question.id, giverId, {
          recipientId: giverId, nominal, order: circleFrom(context.players, giverId), options: open.options,
          bid: auto ?? null, leaderId: auto === undefined ? null : giverId, autoStake: auto !== undefined,
          log: auto === undefined ? [] : [`${playerName(context, giverId)} — ${auto}, автоматически`],
        }),
        statusLine: 'Аукцион', phaseStartedAt: null, phaseDurationMs: null,
      }
    }),
    auctionAutoOpen: assign(({ context }) => {
      const special = context.special
      if (!special) return {}
      return { special: { ...special, bid: special.nominal, leaderId: special.giverId, options: [], autoStake: true,
        log: [...special.log, `${playerName(context, special.giverId)} — ${special.nominal}, автоматически`] } }
    }),
    applyAuctionBid: assign(({ context, event }) => {
      const special = context.special
      if (event.type !== 'AUCTION_BID' || !special) return {}
      const name = playerName(context, event.playerId)
      if (event.option.kind === 'pass') return { special: { ...special, passed: [...special.passed, event.playerId], options: [], unclear: '', log: [...special.log, `${name} — пас`] } }
      const allIn = event.option.kind === 'allIn'
      return { special: { ...special, bid: event.option.amount, leaderId: event.playerId, allIn, options: [], unclear: '',
        log: [...special.log, `${name} — ${allIn ? 'ва-банк ' : ''}${event.option.amount}`] } }
    }),
    nextAuctionBidder: assign(({ context }) => {
      const special = context.special
      if (!special) return {}
      const next = auctionNext(context)
      return { special: { ...special, recipientId: next.bidderId, options: next.options, passed: [...special.passed, ...next.autoPassed],
        log: [...special.log, ...next.autoPassed.map((id) => `${playerName(context, id)} — пас (не хватает денег)`)] },
        statusLine: `${playerName(context, next.bidderId)} решает, перекупать ли` }
    }),
    auctionWinner: assign(({ context }) => {
      const special = context.special
      if (!special) return {}
      const next = auctionNext(context)
      return { special: { ...special, recipientId: null, options: [], passed: [...special.passed, ...next.autoPassed],
        log: [...special.log, ...next.autoPassed.map((id) => `${playerName(context, id)} — пас (не хватает денег)`)] },
        statusLine: `Вопрос уходит игроку ${playerName(context, special.leaderId)} за ${special.bid ?? special.nominal}` }
    }),
    markAwayStaking: assign(({ context, event }) => awayPatch(context, event, 'staking')),
    markAwayBidding: assign(({ context, event }) => awayPatch(context, event, 'bidding')),
    markAwayAnswering: assign(({ context, event }) => ({ ...awayPatch(context, event, 'answering'), attemptId: context.attemptId + 1 })),
    clearAway: assign(({ context }) => context.special ? { special: { ...context.special, awayPlayerId: null, awayFrom: null, awayNextChooser: null }, phaseStartedAt: null, phaseDurationMs: null } : {}),
    restartAwayClock: assign({ phaseStartedAt: () => Date.now(), phaseDurationMs: () => catAwayWaitMs }),
    rearmSpecialAnswer: assign(({ context }) => ({ attemptId: context.attemptId + 1, clarifications: 0, heard: '' })),
    awayAutoPass: assign(({ context }) => {
      const special = context.special
      if (!special?.awayPlayerId) return {}
      return { special: { ...special, passed: [...special.passed, special.awayPlayerId], options: [], awayPlayerId: null, awayFrom: null, awayNextChooser: null,
        log: [...special.log, `${playerName(context, special.awayPlayerId)} — пас (не в сети)`] }, phaseStartedAt: null, phaseDurationMs: null }
    }),
    awayCloseQuestion: assign(({ context }) => {
      const special = context.special
      const away = special?.awayPlayerId ?? context.activePlayerId
      const chooser = special?.awayNextChooser ?? (away ? nextInCircle(context.players, away) : null) ?? context.chooserId
      return {
        playedIds: withPlayed(context.playedIds, context.activeQuestionId),
        announceKind: 'away' as AnnounceKind, judgmentStatus: null, sayCloseGuess: false,
        activePlayerId: away ?? context.activePlayerId,
        chooserId: chooser,
        statusLine: `${playerName(context, away)} не вернулся, идём дальше`,
        phaseStartedAt: null, phaseDurationMs: null,
      }
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
      outcomes: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (isFinal(context) || status === 'near_miss') return context.outcomes
        return settleOutcome(context, status === 'correct' ? stakeOf(context) : status === 'incorrect' ? -stakeOf(context) : 0, status === 'correct').outcomes
      },
      players: ({ context, event }) => {
        if (event.type !== 'ANSWER_JUDGED') return context.players
        const status = outcomeStatus(context, event)
        const stake = stakeOf(context)
        const delta = status === 'correct' ? stake : status === 'incorrect' ? -stake : 0
        if (status === 'near_miss') return context.players
        // В финале очки уходят публично, только при раскрытии ставки (revealFinalStake).
        return isFinal(context) ? context.players : settleOutcome(context, delta, status === 'correct').players
      },
      missedIds: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (status === 'near_miss' || isFinal(context) || event.type !== 'ANSWER_JUDGED') return context.missedIds
        return addMissed(context.missedIds, event.judgment.playerId)
      },
      playedIds: ({ context, event }) => {
        const status = outcomeStatus(context, event)
        if (status === 'near_miss') return context.playedIds
        if (status !== 'correct' && !isFinal(context) && event.type === 'ANSWER_JUDGED') {
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
        if (context.appeal?.stage === 'closed' || status === 'near_miss' || event.type !== 'ANSWER_JUDGED') return context.chooserId
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
        if (status === 'needs_clarification') return 'Ответ не удалось уверенно засчитать'
        return 'Оценка получена'
      },
    }),
    rearmAnswer: assign({
      attemptId: ({ context }) => context.attemptId + 1,
      heard: () => '',
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      statusLine: ({ context }) => answererStatus(context, context.activePlayerId),
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
      players: ({ context }) => isFinal(context) ? changeScore(context, context.activePlayerId, -stakeOf(context)) : settleOutcome(context, -stakeOf(context)).players,
      outcomes: ({ context }) => isFinal(context) ? context.outcomes : settleOutcome(context, -stakeOf(context)).outcomes,
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
      chooserId: ({ context }) => context.appeal?.stage === 'closed' ? context.chooserId : context.activePlayerId ?? context.chooserId,
      statusLine: ({ context }) => {
        if (isFinal(context)) return 'Время на ответ вышло'
        const missed = addMissed(context.missedIds, context.activePlayerId)
        return othersCanBuzz(context, missed) ? 'Время вышло' : 'Время на ответ вышло'
      },
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    judgeTimeout: assign({
      players: ({ context }) => isFinal(context) ? context.players : settleOutcome(context, 0).players,
      outcomes: ({ context }) => isFinal(context) ? context.outcomes : settleOutcome(context, 0).outcomes,
      missedIds: ({ context }) => isFinal(context) ? context.missedIds : addMissed(context.missedIds, context.activePlayerId),
      chooserId: ({ context }) => context.appeal?.stage === 'closed' ? context.chooserId : context.activePlayerId ?? context.chooserId,
      playedIds: ({ context }) => {
        if (!isFinal(context) && othersCanBuzz(context, addMissed(context.missedIds, context.activePlayerId))) return context.playedIds
        return closeQuestion(context) ? withPlayed(context.playedIds, context.activeQuestionId) : context.playedIds
      },
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
      appeal: () => null,
      roundIndex: ({ context }) => {
        const next = nextPlayableRound(context.rounds, context.questions, context.roundIndex)
        return next === -1 ? context.roundIndex : next
      },
      activeQuestionId: () => null,
      activePlayerId: () => null,
      chooserId: ({ context }) => {
        // assign применяет все присваивания к исходному контексту: следующий индекс считаем здесь.
        const next = nextPlayableRound(context.rounds, context.questions, context.roundIndex)
        return openingChooser(context.players, next === -1 ? context.roundIndex : next)
      },
      missedIds: () => [],
      activeStake: () => null,
      finalStriker: ({ context }) => {
        const next = nextPlayableRound(context.rounds, context.questions, context.roundIndex)
        return openingChooser(context.players, next === -1 ? context.roundIndex : next)
      },
      struckThemes: () => [],
      typedAnswers: () => ({}),
      revealedIds: () => [],
      stakeShownIds: () => [],
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
      appeal: () => null,
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
      // В финале играют все: у игроков с нулём или минусом ставка 0. Разбор идёт по возрастанию счёта.
      finalists: ({ context }) =>
        [...context.players]
          .sort((left, right) => left.score - right.score || left.id - right.id)
          .map((player) => player.id),
      finalCursor: () => 0,
      bets: () => [],
      betMisses: () => 0,
    }),
    /** Финал: готовим круг вычёркивания тем — начинает выбирающий финального раунда. */
    prepareFinalDraft: assign({
      // Темы/ставки чистятся в advanceRound при входе в финальный раунд; удар уже учтён.
      statusLine: () => 'Тема вычеркнута — объявляю финал',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    applyStrike: assign({
      struckThemes: ({ context, event }) => {
        const themeId = strikeThemeOf(context, event)
        if (!themeId || (context.struckThemes ?? []).includes(themeId)) return context.struckThemes
        return [...(context.struckThemes ?? []), themeId]
      },
      finalStriker: ({ context }) => nextInCircle(context.players, context.finalStriker ?? 1) ?? context.finalStriker,
      statusLine: ({ context }) =>
        context.finalStriker ? `${playerName(context, context.finalStriker)} вычеркнул тему` : 'Тема вычеркнута',
    }),
    openFinalQuestion: assign({
      // Осталась одна открытая тема — играем её; в финале с единственной темой остаётся вычеркнутая.
      activeQuestionId: ({ context }) => {
        const themes = roundThemes(context.questions, context.roundIndex)
        const open = openFinalThemes(context)
        const theme = open[0] ?? themes.find((item) => (context.struckThemes ?? []).includes(item.id)) ?? null
        if (!theme) return context.activeQuestionId
        const question = findQuestion(context.questions, context.roundIndex, theme.id, 0, 'final', context.playedIds)
        return question?.id ?? context.activeQuestionId
      },
      statusLine: () => 'Открываю вопрос',
    }),
    placeTypedStake: assign({
      bets: ({ context, event }) => {
        if (event.type !== 'FINAL_STAKE') return context.bets
        return [...context.bets.filter((bet) => bet.playerId !== event.playerId), { playerId: event.playerId, amount: event.amount }]
      },
    }),
    startFinalStakeTimer: assign({
      statusLine: () => 'Ставки скрыты: введите ставку',
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: () => finalStakeMs,
    }),
    stopPhaseClock: assign({
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    fillMissingStakes: assign({
      // Кто не успел — ставка 0: счёт не меняется.
      bets: ({ context }) => [
        ...context.bets,
        ...context.finalists
          .filter((id) => !context.bets.some((bet) => bet.playerId === id))
          .map((id) => ({ playerId: id, amount: 0 })),
      ],
    }),
    resetTypedAnswers: assign({
      typedAnswers: () => ({}),
      revealedIds: () => [],
    }),
    startFinalTypedTimer: assign({
      statusLine: () => 'Отвечайте на табло',
      phaseStartedAt: () => Date.now(),
      phaseDurationMs: () => finalTypedMs,
    }),
    storeTypedAnswer: assign({
      typedAnswers: ({ context, event }) => {
        if (event.type !== 'FINAL_TYPED') return context.typedAnswers
        return { ...(context.typedAnswers ?? {}), [event.playerId]: event.text }
      },
    }),
    fillMissingTypedAnswers: assign({
      // Пустой ответ — минус ставки, как честно напечатанный неверный.
      typedAnswers: ({ context }) => {
        const answers: Partial<Record<PlayerId, string>> = { ...(context.typedAnswers ?? {}) }
        for (const id of context.finalists) answers[id] ??= ''
        return answers
      },
    }),
    showTypedAnswer: assign({
      revealedIds: ({ context }) =>
        context.activePlayerId && !(context.revealedIds ?? []).includes(context.activePlayerId)
          ? [...(context.revealedIds ?? []), context.activePlayerId]
          : context.revealedIds,
      statusLine: ({ context }) => `Смотрим ответ: ${playerName(context, context.activePlayerId)}`,
    }),
    applyFinalVerdict: assign({
      judgmentStatus: ({ event }) => (event.type === 'ANSWER_JUDGED' ? event.judgment.status : null),
      judgmentReason: ({ event }) => (event.type === 'ANSWER_JUDGED' ? event.judgment.reason : ''),
      heard: ({ event }) => (event.type === 'ANSWER_JUDGED' ? event.judgment.heard : ''),
      announceKind: ({ event }) => verdictKind(event),
      statusLine: ({ event }) => (event.type === 'ANSWER_JUDGED' ? verdictLabel(event.judgment.status) : 'Ведущая оценивает ответ'),
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    finalJudgeFailed: assign({
      // Оценка не пришла: счёт не меняем, но ход объявляем.
      announceKind: () => 'unclear' as AnnounceKind,
      statusLine: () => 'Оценка не успела — счёт без изменений',
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    applyTypedVerdict: assign({
      // Мгновенный вердикт напечатанного ответа — модель не участвует.
      judgmentStatus: ({ context }) => typedInstantVerdict(context)?.status ?? null,
      heard: ({ context }) => typedInstantVerdict(context)?.heard ?? '',
      statusLine: ({ context }) => verdictLabel(typedInstantVerdict(context)?.status ?? 'incorrect'),
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    revealFinalStake: assign({
      // Очки меняются открыто, в момент разбора ставки.
      players: ({ context }) => {
        const playerId = context.activePlayerId
        const stake = context.activeStake ?? 0
        if (!playerId) return context.players
        const delta = context.judgmentStatus === 'correct' ? stake : context.judgmentStatus === 'incorrect' ? -stake : 0
        return changeScore(context, playerId, delta)
      },
      stakeShownIds: ({ context }) =>
        context.activePlayerId && !(context.stakeShownIds ?? []).includes(context.activePlayerId)
          ? [...(context.stakeShownIds ?? []), context.activePlayerId]
          : context.stakeShownIds,
      statusLine: ({ context }) => `Ставка ${playerName(context, context.activePlayerId)} — ${context.activeStake ?? 0}`,
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
    clearJudgment: assign({
      judgmentStatus: () => null,
      judgmentReason: () => '',
      announceKind: () => null,
      heard: () => '',
    }),
    closeFinalQuestion: assign({
      // Финальный вопрос сыгран целиком, только когда разобраны все финалисты.
      playedIds: ({ context }) => withPlayed(context.playedIds, context.activeQuestionId),
      statusLine: ({ context }) => finalResultLine(context),
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
        return context.bets.find((bet) => bet.playerId === playerId)?.amount ?? 0
      },
      heard: () => '',
      judgmentReason: () => '',
      judgmentStatus: () => null,
      announceKind: () => null,
      statusLine: ({ context }) => answererStatus(context, currentFinalist(context)),
      phaseStartedAt: () => null,
      phaseDurationMs: () => null,
    }),
  },
  guards: {
    idleNudgeDue: ({ context }) => !idleIsFinal(context.idle) || (context.idle?.kind === 'choosing' && context.players.length <= 1),
    validAppeal: ({ context, event }) => event.type === 'APPEAL_REQUESTED' &&
      appealRequestError(context, context.appeal?.activePlayerId !== null && context.appeal?.stage === 'closed' ? 'answering.waiting' : context.appeal?.stage === 'open' ? 'buzzing.open' : 'choosing.listening', event) === null,
    closedAppeal: ({ context }) => context.appeal?.stage === 'closed' && context.appeal.activePlayerId !== null,
    // Only a closed-question window with nobody answering expires; without it the choosing clock stays untouched.
    idleClosedAppeal: ({ context }) => context.appeal?.stage === 'closed' && context.appeal.activePlayerId === null,
    summaryPending: ({ context }) => context.appeal?.summary === 'pending',
    summarySaid: ({ context }) => context.appeal?.summary === 'done',
    appealTimeUp: ({ context }) => Boolean(context.appeal?.timeUp),
    purposeRoundSummary: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'roundSummary',
    queuedAppeal: ({ context }) => Boolean(context.appeal?.queue.length),
    openStageAppeal: ({ context }) => context.appeal?.stage === 'open',
    closedStageAppeal: ({ context }) => context.appeal?.stage === 'closed',
    hasAppeals: ({ context }) => !isFinal(context) && Boolean(context.activeQuestionId && eligibleAppealPlayers(context, context.appeal?.questionId ?? context.activeQuestionId).length),
    normalRound: ({ context }) => !isFinal(context),

    purposeWelcome: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'welcome',
    purposeRead: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'read',
    purposeClarify: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'clarify',
    purposeAnnounce: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'announce',
    purposeFinished: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'finished',
    purposeBridge: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'bridge',
    purposeTurn: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'turn',
    purposeFinalIntro: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'finalIntro',
    purposeStake: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'stake',
    purposeScore: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'score',
    purposeChooserHandoff: ({ event }) =>
      event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'chooserHandoff',
    purposeFalseStart: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'falseStart',
    validChooserHandoff: ({ context, event }) =>
      event.type === 'CHOOSER_OFFLINE' &&
      event.toPlayerId !== event.fromPlayerId &&
      (
        event.fromPlayerId === context.chooserId ||
        // Финал: отвал того, чей ход вычёркивания, тоже требует передачи (мастер посылает для обоих токенов).
        (finalStrikerTurnOpen(context) && event.fromPlayerId === context.finalStriker)
      ) &&
      inRoster(context, event.toPlayerId),
    sayFalseStart: ({ context }) => context.sayFalseStart,
    readFinal: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'read' && isFinal(context),
    earlyBuzzAllowed: ({ context }) => !isFinal(context) && !isSpecial(context),
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
    announceMediaHold: ({ context, event }) => {
      if (event.type !== 'HOST_AUDIO_FINISHED' || event.purpose !== 'announce') return false
      const question = questionById(context.questions, context.activeQuestionId)
      if (!question) return false
      return publicAnswerHasPlayable({
        kind: context.announceKind,
        cellClosed: context.playedIds.includes(question.id),
        answerMedia: question.answerMedia,
      })
    },
    roundDoneHasNext: ({ context }) =>
      roundFinished(context) &&
      nextPlayableRound(context.rounds, context.questions, context.roundIndex) !== -1,
    roundDoneNoNext: ({ context }) =>
      roundFinished(context) &&
      nextPlayableRound(context.rounds, context.questions, context.roundIndex) === -1,
    questionAvailable: ({ context, event }) => {
      if (event.type !== 'QUESTION_SELECTED' || isFinal(context)) return false
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
    validFinalStrike: ({ context, event }) => strikeValid(context, event),
    strikeClosesThemes: ({ context, event }) => strikeCloses(context, event),
    moreReveals: ({ context }) => context.finalCursor < context.finalists.length - 1,
    validFinalStake: ({ context, event }) => {
      if (event.type !== 'FINAL_STAKE') return false
      if (!context.players.some((player) => player.id === event.playerId)) return false
      if (context.bets.some((bet) => bet.playerId === event.playerId)) return false
      const score = playerScore(context, event.playerId)
      return Number.isFinite(event.amount) && Number.isInteger(event.amount) && event.amount >= 0 && event.amount <= score
    },
    finalAllStaked: ({ context }) =>
      context.finalists.length > 0 && context.finalists.every((id) => context.bets.some((bet) => bet.playerId === id)),
    validFinalTyped: ({ context, event }) => {
      if (event.type !== 'FINAL_TYPED') return false
      if (!context.players.some((player) => player.id === event.playerId)) return false
      if (context.typedAnswers?.[event.playerId] !== undefined) return false
      return typeof event.text === 'string' && event.text.length <= 200
    },
    finalAllTyped: ({ context }) =>
      context.finalists.length > 0 &&
      context.finalists.every((id) => context.typedAnswers?.[id] !== undefined),
    validPlayer: ({ context, event }) =>
      event.type === 'BUZZER_PRESSED' &&
      inRoster(context, event.playerId) &&
      !context.missedIds.includes(event.playerId) &&
      !falseStartCooling(context.falseStarts[event.playerId], Date.now()),
    canFalseStart: ({ context, event }) =>
      event.type === 'BUZZER_PRESSED' &&
      inRoster(context, event.playerId) &&
      !isFinal(context) &&
      !isSpecial(context) &&
      !falseStartCooling(context.falseStarts[event.playerId], Date.now()),
    typedInstantVerdict: ({ context }) =>
      // Пустой ответ или точный эталон решает машина: модель звать не нужно.
      Boolean(typedInstantVerdict(context)),
    othersCanAnswer: ({ context, event }) =>
      event.type === 'HOST_AUDIO_FINISHED' &&
      event.purpose === 'announce' &&
      !isFinal(context) &&
      (context.announceKind === 'incorrect' || context.announceKind === 'silence' || context.announceKind === 'unclear') &&
      Boolean(context.activeQuestionId) &&
      !context.playedIds.includes(context.activeQuestionId ?? ''),
    hasNextRound: ({ context }) =>
      nextPlayableRound(context.rounds, context.questions, context.roundIndex) !== -1,
    pausedAfterFinish: ({ context }) => context.resumePath === 'finished',
    selectedCat: ({ context, event }) => !isFinal(context) && Boolean(selectedQuestion(context, event)?.cat),
    selectedAuction: ({ context, event }) => !isFinal(context) && Boolean(selectedQuestion(context, event)?.auction),
    catHasRecipient: ({ context }) => context.special?.recipientId != null,
    catFixed: ({ context }) => (context.special?.stakeOptions.length ?? 0) <= 1,
    validCatRecipient: ({ context, event }) =>
      event.type === 'CAT_RECIPIENT' && context.special?.kind === 'cat' && context.special.recipientId === null &&
      event.playerId !== context.special.giverId && inRoster(context, event.playerId),
    validCatStake: ({ context, event }) =>
      event.type === 'CAT_STAKE' && context.special?.kind === 'cat' && event.playerId === context.special.recipientId &&
      context.special.stakeOptions.includes(event.amount),
    catGiverOffline: ({ context, event }) =>
      event.type === 'CHOOSER_OFFLINE' && context.special?.kind === 'cat' && context.special.recipientId === null &&
      event.fromPlayerId === context.special.giverId && event.toPlayerId !== event.fromPlayerId && inRoster(context, event.toPlayerId),
    auctionHasBid: ({ context }) => context.special?.bid != null,
    auctionAutoStake: ({ context }) => context.special?.kind === 'auction' && context.special.autoStake === true,
    auctionOpenerOffline: ({ context, event }) =>
      event.type === 'CHOOSER_OFFLINE' && context.special?.kind === 'auction' && context.special.bid === null && event.fromPlayerId === context.special.giverId,
    validAuctionBid: ({ context, event }) =>
      event.type === 'AUCTION_BID' && context.special?.kind === 'auction' && event.playerId === context.special.recipientId &&
      context.special.options.some((option) => sameOption(option, event.option)),
    auctionContinues: ({ context }) => context.special?.kind === 'auction' && auctionNext(context).bidderId !== null,
    auctionAwaitingBid: ({ context }) => context.special?.kind === 'auction' && context.special.recipientId !== null && context.special.options.length > 0,
    readSpecial: ({ context, event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'read' && isSpecial(context),
    awayRecipient: ({ context, event }) => event.type === 'SPECIAL_PLAYER_OFFLINE' && context.special?.recipientId === event.playerId,
    awayAnswerer: ({ context, event }) => event.type === 'SPECIAL_PLAYER_OFFLINE' && isSpecial(context) && context.activePlayerId === event.playerId,
    awayBack: ({ context, event }) => event.type === 'SPECIAL_PLAYER_BACK' && context.special?.awayPlayerId === event.playerId,
    awayFromStaking: ({ context }) => context.special?.awayFrom === 'staking',
    awayFromBidding: ({ context }) => context.special?.awayFrom === 'bidding',
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
    APPEAL_REQUESTED: [
      { guard: and([not(stateIn('paused')), not(stateIn('stopped')), not(stateIn('failed')), 'closedAppeal', 'validAppeal']), actions: 'queueAppeal' },
      // До раскрытия ответа (ячейка открыта): игрок повторяет ответ.
      { guard: and([not(stateIn('paused')), 'validAppeal', 'openStageAppeal', or([stateIn('buzzing'), stateIn('announcing')])]), target: '.appealCue', actions: 'acceptAppeal' },
      // После раскрытия (ячейка закрыта): без повтора — игрок подтвердил кнопку апелляции.
      { guard: and([not(stateIn('paused')), 'validAppeal', 'closedStageAppeal', or([stateIn('choosing'), stateIn('roundSummaryWindow'), stateIn('announcing')])]), target: '.appealConfirm', actions: ['acceptAppeal', 'confirmClosedAppeal'] },
    ],
    SPECIAL_PLAYER_OFFLINE: [
      { guard: and([stateIn('cat.staking'), 'awayRecipient']), target: '.specialAway', actions: 'markAwayStaking' },
      { guard: and([or([stateIn('auction.asking'), stateIn('auction.listening'), stateIn('auction.resolving'), stateIn('auction.clarifying')]), 'awayRecipient']), target: '.specialAway', actions: 'markAwayBidding' },
      { guard: and([or([stateIn('answering'), stateIn('judging')]), 'awayAnswerer']), target: '.specialAway', actions: 'markAwayAnswering' },
    ],
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
    IDLE_SPEECH: { actions: 'noteTalk' },
    HOST_TALKING: { actions: 'noteTalk' },
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
        { guard: ({ context }) => context.resumePath.startsWith('cat.'), target: 'cat.resume', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath.startsWith('auction.'), target: 'auction.resume', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'specialAway', target: 'specialAway', actions: ['clearResume', 'restartAwayClock'] },
        { guard: ({ context }) => context.resumePath === 'appealCue', target: 'appealCue', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'roundSummaryWindow', target: 'roundSummaryWindow', actions: ['clearResume', 'restartAppealClock'] },
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
        {
          guard: ({ context }) => context.resumePath === 'announcing' || context.resumePath === 'announcing.speaking',
          target: 'announcing',
          actions: 'clearResume',
        },
        {
          guard: ({ context }) => context.resumePath === 'announcing.holding',
          target: 'announcing.holding',
          actions: 'clearResume',
        },
        { guard: ({ context }) => context.resumePath === 'bridging', target: 'bridging', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'turnCue', target: 'turnCue', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalDraft', target: 'finalDraft', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalBets.collecting', target: 'finalBets.collecting', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalTyped', target: 'finalTyped', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalReveal.look', target: 'finalReveal.look', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalReveal.verdict', target: 'finalReveal.verdict', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalReveal.stakeCue', target: 'finalReveal.stakeCue', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'finalReveal.scoreCue', target: 'finalReveal.scoreCue', actions: 'clearResume' },
        { guard: ({ context }) => context.resumePath === 'wrapUp', target: 'wrapUp', actions: 'clearResume' },
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
      after: { appealLeft: { guard: 'idleClosedAppeal', actions: ['clearAppeals', 'clearTimer'] } },
      initial: 'listening',
      entry: 'setChoosingStatus',
      // В пакете может изначально быть одна тема финала: круг вычёркивания уже закончен.
      always: { guard: ({ context }) => isFinal(context) && openFinalThemes(context).length === 1, target: 'finalDraft' },
      on: {
        CHOOSER_OFFLINE: {
          guard: 'validChooserHandoff',
          target: '#game.chooserHandoff',
          actions: 'handoffChooser',
        },
        // Финал: игроки по кругу вычёркивают темы, пока не останется одна.
        STRIKE_THEME: [
          { guard: 'strikeClosesThemes', target: 'finalDraft', actions: 'applyStrike' },
          { guard: 'validFinalStrike', target: 'choosing.listening', reenter: true, actions: 'applyStrike' },
        ],
      },
      states: {
        listening: {
          entry: { type: 'idleEnter', params: { kind: 'choosing' } },
          after: { idleStep: [{ guard: 'idleNudgeDue', target: 'listening', reenter: true, actions: 'idleNudge' }, { target: '#game.chooserHandoff', actions: 'idlePassChooser' }] },
          on: {
            IDLE_SPEECH: { target: 'listening', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            HOST_TALKING: { target: 'listening', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            PLAYER_SPEECH_FINISHED: 'resolving',
            QUESTION_SELECTED: [
              { guard: 'selectedCat', target: '#game.cat', actions: ['openQuestion', 'startCat'] },
              { guard: 'selectedAuction', target: '#game.auction', actions: ['openQuestion', 'startAuction'] },
              // Финал: клик по таблицу тем — вычеркнуть тему (голос или кнопка).
              { guard: 'strikeClosesThemes', target: '#game.finalDraft', actions: 'applyStrike' },
              { guard: 'validFinalStrike', target: 'listening', reenter: true, actions: 'applyStrike' },
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
              { guard: 'selectedCat', target: '#game.cat', actions: ['openQuestion', 'startCat'] },
              { guard: 'selectedAuction', target: '#game.auction', actions: ['openQuestion', 'startAuction'] },
              // Финал: клик по таблице тем — вычеркнуть (голос разбирается моделью так же, как выбор).
              { guard: 'strikeClosesThemes', target: '#game.finalDraft', actions: 'applyStrike' },
              { guard: 'validFinalStrike', target: 'listening', reenter: true, actions: 'applyStrike' },
              { guard: 'questionAvailable', target: '#game.flashing', actions: 'openQuestion' },
              { target: 'clarifying', actions: 'noteUnavailable' },
            ],
            QUESTION_UNCLEAR: { target: 'listening', actions: 'noteUnclear' },
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
            // Табло кликабельно и во время уточнения ведущей.
            QUESTION_SELECTED: [
              { guard: 'selectedCat', target: '#game.cat', actions: ['openQuestion', 'startCat'] },
              { guard: 'selectedAuction', target: '#game.auction', actions: ['openQuestion', 'startAuction'] },
              { guard: 'strikeClosesThemes', target: '#game.finalDraft', actions: 'applyStrike' },
              { guard: 'validFinalStrike', target: 'listening', reenter: true, actions: 'applyStrike' },
              { guard: 'questionAvailable', target: '#game.flashing', actions: 'openQuestion' },
            ],
          },
        },
      },
    },
    chooserHandoff: {
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeChooserHandoff', target: 'choosing' },
        // Новый выбирающий может говорить, пока ведущая ещё объявляет передачу хода.
        PLAYER_SPEECH_STARTED: 'choosing',
        STRIKE_THEME: [
          { guard: 'strikeClosesThemes', target: '#game.finalDraft', actions: 'applyStrike' },
          { guard: 'validFinalStrike', actions: 'applyStrike' },
        ],
        // …и кликнуть ячейку.
        QUESTION_SELECTED: [
          { guard: 'selectedCat', target: '#game.cat', actions: ['openQuestion', 'startCat'] },
          { guard: 'selectedAuction', target: '#game.auction', actions: ['openQuestion', 'startAuction'] },
          { guard: 'strikeClosesThemes', target: '#game.finalDraft', actions: 'applyStrike' },
          { guard: 'validFinalStrike', actions: 'applyStrike' },
          { guard: 'questionAvailable', target: '#game.flashing', actions: 'openQuestion' },
        ],
      },
    },
    cat: {
      initial: 'announcing',
      on: {
        CHOOSER_OFFLINE: { guard: 'catGiverOffline', target: '.announcing', reenter: true, actions: 'handoffCatGiver' },
      },
      states: {
        announcing: {
          on: {
            HOST_AUDIO_FINISHED: [
              { guard: and([heardPurpose('cat'), 'catHasRecipient']), target: 'staking' },
              { guard: heardPurpose('cat'), target: 'picking' },
            ],
            // Ранний слух: на табло уже кнопки, голос принимаем до конца речи ведущей.
            PLAYER_SPEECH_FINISHED: 'resolving',
            CAT_RECIPIENT: { guard: 'validCatRecipient', target: '#game.cat.staking', actions: 'setCatRecipient' },
            CAT_PICK_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
          },
        },
        picking: {
          entry: { type: 'idleEnter', params: { kind: 'catPick' } },
          after: { idleStep: [{ guard: 'idleNudgeDue', target: 'picking', reenter: true, actions: 'idleNudge' }, { target: '#game.cat.staking', actions: 'idleGiveCat' }] },
          on: {
            IDLE_SPEECH: { target: 'picking', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            HOST_TALKING: { target: 'picking', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            PLAYER_SPEECH_FINISHED: 'resolving',
            CAT_RECIPIENT: { guard: 'validCatRecipient', target: '#game.cat.staking', actions: 'setCatRecipient' },
            CAT_PICK_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
          },
        },
        /** Как choosing.resolving: локально не узнали — модель выбирает из кандидатов. */
        resolving: {
          after: { judgeMs: 'picking' },
          on: {
            CAT_RECIPIENT: { guard: 'validCatRecipient', target: '#game.cat.staking', actions: 'setCatRecipient' },
            CAT_PICK_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
            SELECTION_FAILED: 'picking',
          },
        },
        clarifying: {
          on: {
            HOST_AUDIO_FINISHED: { guard: heardPurpose('catClarify'), target: 'picking' },
            PLAYER_SPEECH_STARTED: 'picking',
            CAT_RECIPIENT: { guard: 'validCatRecipient', target: '#game.cat.staking', actions: 'setCatRecipient' },
          },
        },
        staking: {
          initial: 'asking',
          on: {
            CAT_STAKE: { guard: 'validCatStake', target: 'placed', actions: 'setCatStake' },
          },
          states: {
            asking: {
              on: {
                HOST_AUDIO_FINISHED: [
                  { guard: and([heardPurpose('catStake'), 'catFixed']), target: '#game.cat.placed', actions: 'setCatFixedStake' },
                  { guard: heardPurpose('catStake'), target: 'listening' },
                ],
                PLAYER_SPEECH_FINISHED: 'resolving',
                CAT_STAKE_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
              },
            },
            listening: {
              entry: { type: 'idleEnter', params: { kind: 'catStake' } },
          after: { idleStep: [{ guard: 'idleNudgeDue', target: 'listening', reenter: true, actions: 'idleNudge' }, { target: '#game.cat.autoStaked', actions: 'idleMinStake' }] },
          on: {
                IDLE_SPEECH: { target: 'listening', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            HOST_TALKING: { target: 'listening', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            PLAYER_SPEECH_FINISHED: 'resolving',
                CAT_STAKE_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
              },
            },
            resolving: {
              after: { judgeMs: 'listening' },
              on: {
                CAT_STAKE_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
                SELECTION_FAILED: 'listening',
              },
            },
            clarifying: {
              on: {
                HOST_AUDIO_FINISHED: { guard: heardPurpose('catStakeClarify'), target: 'listening' },
                PLAYER_SPEECH_STARTED: 'listening',
              },
            },
          },
        },
        /** Молчал на ставке: взяли минимум, ведущая объявляет, потом вопрос. */
        autoStaked: {
          on: { HOST_AUDIO_FINISHED: { guard: heardPurpose('idleAuto'), target: 'placed' } },
        },
        // Ячейка уже мигала при выборе кота: сразу к чтению, без второго показа табло.
        placed: { always: { target: '#game.reading', actions: ['placeSpecial', 'armEarlyClock'] } },
        /** Восстановление и RESUME: получатель уже есть — к ставке, иначе снова объявление. */
        resume: {
          always: [
            { guard: 'catHasRecipient', target: 'staking' },
            { target: 'announcing' },
          ],
        },
      },
    },
    auction: {
      initial: 'announcing',
      on: {
        CHOOSER_OFFLINE: { guard: 'auctionOpenerOffline', target: '.advancing', actions: 'auctionAutoOpen' },
      },
      states: {
        announcing: {
          on: {
            HOST_AUDIO_FINISHED: [
              { guard: and([heardPurpose('auction'), 'auctionHasBid']), target: 'advancing' },
              { guard: heardPurpose('auction'), target: 'listening' },
            ],
            // Автоставка: отвечать нечего, речь при объявлении — не заявка. Дальше перекупка идёт как обычно.
            PLAYER_SPEECH_FINISHED: { guard: not('auctionAutoStake'), target: 'resolving' },
            AUCTION_BID: { guard: 'validAuctionBid', target: '#game.auction.advancing', actions: 'applyAuctionBid' },
            AUCTION_UNCLEAR: { guard: not('auctionAutoStake'), target: 'clarifying', actions: 'noteSpecialUnclear' },
          },
        },
        asking: {
          on: {
            HOST_AUDIO_FINISHED: { guard: heardPurpose('auctionAsk'), target: 'listening' },
            PLAYER_SPEECH_FINISHED: 'resolving',
            AUCTION_BID: { guard: 'validAuctionBid', target: '#game.auction.advancing', actions: 'applyAuctionBid' },
            AUCTION_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
          },
        },
        listening: {
          entry: { type: 'idleEnter', params: { kind: 'auction' } },
          after: { idleStep: [{ guard: 'idleNudgeDue', target: 'listening', reenter: true, actions: 'idleNudge' }, { target: 'advancing', actions: 'idleAuctionPass' }] },
          on: {
            IDLE_SPEECH: { target: 'listening', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            HOST_TALKING: { target: 'listening', reenter: true, actions: ['idleTalk', 'noteTalk'] },
            PLAYER_SPEECH_FINISHED: 'resolving',
            AUCTION_BID: { guard: 'validAuctionBid', target: '#game.auction.advancing', actions: 'applyAuctionBid' },
            AUCTION_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
          },
        },
        resolving: {
          after: { judgeMs: 'listening' },
          on: {
            AUCTION_BID: { guard: 'validAuctionBid', target: '#game.auction.advancing', actions: 'applyAuctionBid' },
            AUCTION_UNCLEAR: { target: 'clarifying', actions: 'noteSpecialUnclear' },
            SELECTION_FAILED: 'listening',
          },
        },
        clarifying: {
          on: {
            HOST_AUDIO_FINISHED: { guard: heardPurpose('auctionClarify'), target: 'listening' },
            PLAYER_SPEECH_STARTED: 'listening',
            AUCTION_BID: { guard: 'validAuctionBid', target: '#game.auction.advancing', actions: 'applyAuctionBid' },
          },
        },
        advancing: {
          always: [
            { guard: 'auctionContinues', target: 'asking', actions: 'nextAuctionBidder' },
            { target: 'won', actions: 'auctionWinner' },
          ],
        },
        won: {
          on: { HOST_AUDIO_FINISHED: { guard: heardPurpose('auctionWon'), target: '#game.reading', actions: ['placeSpecial', 'armEarlyClock'] } },
        },
        resume: {
          always: [
            { guard: 'auctionAwaitingBid', target: 'asking' },
            { guard: 'auctionHasBid', target: 'advancing' },
            { target: 'announcing' },
          ],
        },
      },
    },
    /** Получатель кота / участник торгов / отвечающий на спецвопросе отключился: ждём 15 с. */
    specialAway: {
      after: {
        catAwayWaitMs: [
          { guard: 'awayFromBidding', target: 'auction.advancing', actions: 'awayAutoPass' },
          { target: 'announcing', actions: 'awayCloseQuestion' },
        ],
      },
      on: {
        SPECIAL_PLAYER_BACK: [
          { guard: and(['awayBack', 'awayFromStaking']), target: 'cat.staking', actions: 'clearAway' },
          { guard: and(['awayBack', 'awayFromBidding']), target: 'auction.asking', actions: 'clearAway' },
          { guard: 'awayBack', target: 'answering', actions: ['clearAway', 'rearmSpecialAnswer'] },
        ],
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
              { guard: 'readSpecial', target: '#game.answering', actions: ['clearEarlyBuzz', 'beginSpecialAnswer'] },
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
    afterQuestion: {
      always: [
        { guard: and(['hasAppeals', 'roundDoneHasNext']), target: 'roundSummaryWindow', actions: ['openClosedAppeals', 'markRoundSummary'] },
        { guard: and(['hasAppeals', 'roundDoneNoNext']), target: 'roundSummaryWindow', actions: 'openClosedAppeals' },
        { guard: 'hasAppeals', target: 'choosing', actions: 'openClosedAppeals' },
        { guard: 'roundDoneHasNext', target: 'bridging', actions: 'advanceRound' },
        { guard: 'roundDoneNoNext', target: 'finished', actions: 'clearAppeals' },
        { target: 'choosing', actions: 'clearAppeals' },
      ],
    },
    roundSummaryWindow: {
      entry: assign(({ context }) => ({ statusLine: `Апелляции · ${Math.round(appealWindowMs() / 1000)} секунд`, phaseStartedAt: Date.now(), phaseDurationMs: appealMsLeft(context.appeal) })),
      after: { appealLeft: [
        // The window never cuts the round summary: appeals close, the phrase finishes, then the round advances.
        { guard: 'summaryPending', actions: 'markAppealTimeUp' },
        { target: 'appealEnd' },
      ] },
      on: {
        HOST_AUDIO_FINISHED: [
          { guard: and(['purposeRoundSummary', 'appealTimeUp']), target: 'appealEnd', actions: 'markSummaryDone' },
          { guard: 'purposeRoundSummary', actions: 'markSummaryDone' },
        ],
      },
    },
    appealEnd: {
      always: [
        // The summary already named scores and the next round, so skip the bridge phrase.
        { guard: and(['roundDoneHasNext', 'summarySaid']), target: 'choosing', actions: 'advanceRound' },
        { guard: 'roundDoneHasNext', target: 'bridging', actions: 'advanceRound' },
        { guard: 'roundDoneNoNext', target: 'finished', actions: 'clearAppeals' },
        { target: 'choosing', actions: 'clearAppeals' },
      ],
    },
    /** Отдельный шаг, чтобы новое объявление звучало даже при входе из announcing. */
    appealConfirm: {
      after: { 1: { target: 'announcing' } },
    },
    appealCue: {
      // Ранний слух: игрок начал повторять ответ, пока ведущая ещё просит.
      on: {
        HOST_AUDIO_FINISHED: { guard: ({ event }) => event.type === 'HOST_AUDIO_FINISHED' && event.purpose === 'appeal', target: 'answering' },
        PLAYER_SPEECH_STARTED: 'answering',
      },
    },
    appealNext: {
      always: [
        { guard: and(['queuedAppeal', 'closedStageAppeal']), target: 'appealConfirm', actions: ['nextAppeal', 'confirmClosedAppeal'] },
        { guard: 'queuedAppeal', target: 'appealCue', actions: 'nextAppeal' },
        { target: 'afterQuestion' },
      ],
    },
    bridging: {
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeBridge', target: 'choosing' },
      },
    },
    /** Финал: ведущая объясняет скрытые ставки; темы уже вычеркнуты, осталась одна. */
    finalDraft: {
      entry: 'prepareFinalDraft',
      on: {
        HOST_AUDIO_FINISHED: {
          guard: 'purposeFinalIntro',
          target: '#game.finalBets',
          actions: 'prepareFinalists',
        },
      },
    },
    /** Финал: скрытые ставки на табло (печатают сами игроки, машина их не показывает до разбора). */
    finalBets: {
      initial: 'collecting',
      states: {
        collecting: {
          entry: 'startFinalStakeTimer',
          always: { guard: 'finalAllStaked', target: '#game.flashing', actions: ['openFinalQuestion', 'stopPhaseClock'] },
          after: {
            deadlineFinalStake: {
              target: '#game.flashing',
              actions: ['fillMissingStakes', 'openFinalQuestion', 'stopPhaseClock'],
            },
          },
          on: {
            FINAL_STAKE: {
              guard: 'validFinalStake',
              actions: 'placeTypedStake',
            },
          },
        },
      },
    },
    /** Финал: ответы печатают на табло, скрыто; после окна — последовательный разбор. */
    finalTyped: {
      entry: ['startFinalTypedTimer'],
      always: { guard: 'finalAllTyped', target: '#game.finalReveal', actions: 'stopPhaseClock' },
      after: {
        deadlineFinalTyped: { target: '#game.finalReveal', actions: ['fillMissingTypedAnswers', 'stopPhaseClock'] },
      },
      on: {
        FINAL_TYPED: {
          guard: 'validFinalTyped',
          actions: 'storeTypedAnswer',
        },
      },
    },
    /** Финал: последовательный разбор — ответ, вердикт, ставка, финальный счёт; от меньшего счёта вверх. */
    finalReveal: {
      initial: 'look',
      states: {
        look: {
          entry: ['assignFinalAnswerer', 'showTypedAnswer'],
          // Пустой ответ или точное совпадение с эталоном решает машина, модель только для остального.
          always: [{ guard: 'typedInstantVerdict', target: 'verdict', actions: 'applyTypedVerdict' }],
          after: { judgeMs: { target: 'verdict', actions: 'finalJudgeFailed' } },
          on: {
            ANSWER_JUDGED: { guard: 'judgmentMatches', target: 'verdict', actions: 'applyFinalVerdict' },
            ANSWER_JUDGE_FAILED: { target: 'verdict', actions: 'finalJudgeFailed' },
          },
        },
        verdict: {
          on: {
            HOST_AUDIO_FINISHED: { guard: 'purposeAnnounce', target: 'stakeCue' },
          },
        },
        stakeCue: {
          on: {
            HOST_AUDIO_FINISHED: { guard: 'purposeStake', target: 'scoreCue', actions: 'revealFinalStake' },
          },
        },
        scoreCue: {
          on: {
            HOST_AUDIO_FINISHED: [
              { guard: and(['moreReveals', 'purposeScore']), target: 'look', actions: ['nextFinalist', 'clearJudgment'], reenter: true },
              { guard: 'purposeScore', target: '#game.wrapUp' },
            ],
          },
        },
      },
    },
    /** Финал: все ответы разобраны — ведущая называет финальный счёт и победителя. */
    wrapUp: {
      entry: 'closeFinalQuestion',
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeBridge', target: '#game.finished' },
      },
    },
    turnCue: {
      // Ход финалиста: ответы финала начинаем с пустого набора.
      entry: ['assignFinalAnswerer', 'resetTypedAnswers'],
      on: {
        HOST_AUDIO_FINISHED: { guard: 'purposeTurn', target: '#game.finalTyped' },
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
            PLAYER_SPEECH_FINISHED: { target: 'settling', actions: 'clearTimer' },
            ANSWER_SETTLED: { target: '#game.judging', actions: 'clearTimer' },
            ANSWER_NONE: { target: '#game.announcing', actions: 'silencePenalty' },
          },
        },
        hearing: {
          // Длинная реплика — не молчание: её конец и оценку ждёт контроллер. Это только страховка от зависшего VAD.
          after: { answerSettleSafetyMs: { target: '#game.announcing', actions: 'judgeTimeout' } },
          on: {
            // Конец фразы — не вердикт: слушаем дальше, решает контроллер (тишина answerSilenceDecideMs).
            PLAYER_SPEECH_FINISHED: 'settling',
            ANSWER_SETTLED: '#game.judging',
            ANSWER_NONE: { target: '#game.announcing', actions: 'silencePenalty' },
          },
        },
        // Реплика закончилась, микрофон открыт: ждём ещё речь или решение контроллера.
        settling: {
          after: { answerSettleSafetyMs: { target: '#game.announcing', actions: 'judgeTimeout' } },
          on: {
            PLAYER_SPEECH_STARTED: 'hearing',
            ANSWER_SETTLED: '#game.judging',
            ANSWER_NONE: { target: '#game.announcing', actions: 'silencePenalty' },
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
        ANSWER_JUDGE_FAILED: { target: 'announcing', actions: 'judgeTimeout' },
      },
    },
    announcing: {
      initial: 'speaking',
      entry: ['clearTimer', 'openAppealNow', 'markAnswerShown'],
      states: {
        speaking: {
          on: {
            QUESTION_SELECTED: [
              { guard: and([({ context }) => earlyPickOpen('announcing.speaking', context), 'selectedCat']), target: '#game.cat', actions: ['openQuestion', 'startCat'] },
              { guard: and([({ context }) => earlyPickOpen('announcing.speaking', context), 'selectedAuction']), target: '#game.auction', actions: ['openQuestion', 'startAuction'] },
              { guard: and([({ context }) => earlyPickOpen('announcing.speaking', context), 'questionAvailable']), target: '#game.flashing', actions: 'openQuestion' },
            ],
            // Просьба повторить ответ: игрок может заговорить, не дожидаясь конца фразы.
            PLAYER_SPEECH_STARTED: { guard: ({ context }) => context.announceKind === 'repeat' && !context.appeal?.activePlayerId, target: '#game.answering', actions: 'rearmAnswer' },
            HOST_AUDIO_FINISHED: [
              { guard: 'samePlayerRepeats', target: '#game.answering', actions: 'rearmAnswer' },
              { guard: 'moreFinalists', target: '#game.turnCue', actions: 'nextFinalist' },
              { guard: and(['purposeAnnounce', 'closedAppeal']), target: '#game.appealNext' },
              { guard: 'othersCanAnswer', target: '#game.buzzing', actions: 'reopenBuzzers' },
              { guard: 'announceMediaHold', target: 'holding', actions: 'anchorAnswerHold' },
              { guard: and(['purposeAnnounce', 'normalRound']), target: '#game.afterQuestion' },
              { guard: 'roundOverAndNext', target: '#game.bridging', actions: 'advanceRound' },
              { guard: 'roundOver', target: '#game.finished' },
              { guard: 'purposeAnnounce', target: '#game.choosing' },
            ],
          },
        },
        holding: {
          on: {
            ANSWER_MEDIA_ENDED: [
              {
                guard: ({ context }) => !context.answerClipEnded && answerHoldLeft({ ...context, answerClipEnded: true }, Date.now()) <= 0,
                actions: 'markAnswerClipEnded',
                target: 'leavingHold',
              },
              {
                guard: ({ context }) => !context.answerClipEnded,
                actions: 'markAnswerClipEnded',
                target: 'holding',
                reenter: true,
              },
            ],
          },
          after: {
            answerHoldLeft: { target: 'leavingHold' },
          },
        },
        leavingHold: {
          always: [
            { guard: 'normalRound', target: '#game.afterQuestion' },
            { guard: 'roundDoneHasNext', target: '#game.bridging', actions: 'advanceRound' },
            { guard: 'roundDoneNoNext', target: '#game.finished' },
            { target: '#game.choosing' },
          ],
        },
      },
    },
    stopped: {},
    paused: {
      on: {
        RESUME: [
        { guard: ({ context }) => context.resumePath.startsWith('cat.'), target: 'cat.resume', actions: 'resumeClock' },
        { guard: ({ context }) => context.resumePath.startsWith('auction.'), target: 'auction.resume', actions: 'resumeClock' },
        { guard: ({ context }) => context.resumePath === 'specialAway', target: 'specialAway', actions: ['resumeClock', 'restartAwayClock'] },
        { guard: ({ context }) => context.resumePath === 'appealCue', target: 'appealCue', actions: 'resumeClock' },
        { guard: ({ context }) => context.resumePath === 'appealConfirm', target: 'announcing', actions: 'resumeClock' },
        { guard: ({ context }) => context.resumePath === 'roundSummaryWindow', target: 'roundSummaryWindow', actions: ['resumeClock', 'restartAppealClock'] },
        // Лобби конференции: паузу ставили до старта партии — «Дальше» возвращает в startMenu.
        { guard: ({ context }) => context.resumePath === 'startMenu', target: 'startMenu', actions: 'resumeClock' },
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
          { guard: ({ context }) => context.resumePath === 'answering.settling', target: 'answering.settling', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'judging', target: 'judging', actions: 'resumeClock' },
          {
            guard: ({ context }) => context.resumePath === 'announcing' || context.resumePath === 'announcing.speaking',
            target: 'announcing',
            actions: 'resumeClock',
          },
          {
            guard: ({ context }) => context.resumePath === 'announcing.holding',
            target: 'announcing.holding',
            actions: 'resumeClock',
          },
          { guard: ({ context }) => context.resumePath === 'turnCue', target: 'turnCue', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'finalDraft', target: 'finalDraft', actions: 'clearResume' },
          { guard: ({ context }) => context.resumePath === 'finalBets.collecting', target: 'finalBets.collecting', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'finalTyped', target: 'finalTyped', actions: 'resumeClock' },
          { guard: ({ context }) => context.resumePath === 'finalReveal.look', target: 'finalReveal.look', actions: 'clearResume' },
          { guard: ({ context }) => context.resumePath === 'finalReveal.verdict', target: 'finalReveal.verdict', actions: 'clearResume' },
          { guard: ({ context }) => context.resumePath === 'finalReveal.stakeCue', target: 'finalReveal.stakeCue', actions: 'clearResume' },
          { guard: ({ context }) => context.resumePath === 'finalReveal.scoreCue', target: 'finalReveal.scoreCue', actions: 'clearResume' },
          { guard: ({ context }) => context.resumePath === 'wrapUp', target: 'wrapUp', actions: 'clearResume' },
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

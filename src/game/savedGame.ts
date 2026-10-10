import { questionById } from './pack.ts'
import { openingChooser } from './players.ts'
import type {
  AnnounceKind,
  Bet,
  GameContext,
  JudgmentStatus,
  Player,
  PlayerId,
  QuestionPack,
  SavedMatch,
} from './types.ts'

/** Снимок партии. Не путать с `aisigame.openaiApiKey`. */
export const gameStorageKey = 'aisigame.game'

export type SavedGame = SavedMatch & {
  version: 1
  packId: string
  packFile: string
  packName: string
}

const announceKinds: AnnounceKind[] = ['correct', 'incorrect', 'silence', 'nobody', 'unclear', 'repeat']
const judgmentStatuses: JudgmentStatus[] = [
  'correct',
  'incorrect',
  'needs_clarification',
  'unintelligible',
  'ambiguous',
  'near_miss',
]

/** Фазы, в которые можно войти заново после нового голосового сеанса. */
const canonicalPhases: Record<string, string> = {
  welcoming: 'welcoming',
  choosing: 'choosing.listening',
  'choosing.listening': 'choosing.listening',
  'choosing.resolving': 'choosing.listening',
  'choosing.clarifying': 'choosing.listening',
  flashing: 'flashing',
  reading: 'reading.sealed',
  'reading.sealed': 'reading.sealed',
  'reading.armed': 'reading.armed',
  falseStartCue: 'falseStartCue',
  buzzing: 'buzzing.open',
  'buzzing.open': 'buzzing.open',
  'buzzing.reminding': 'buzzing.open',
  answering: 'answering.waiting',
  'answering.waiting': 'answering.waiting',
  'answering.hearing': 'answering.waiting',
  judging: 'answering.waiting',
  announcing: 'announcing',
  bridging: 'bridging',
  turnCue: 'turnCue',
  finalBets: 'finalBets.asking',
  'finalBets.asking': 'finalBets.asking',
  'finalBets.hearing': 'finalBets.asking',
  'finalBets.resolving': 'finalBets.asking',
  'finalBets.placed': 'finalBets.asking',
  finished: 'finished',
}

const questionPhases = new Set([
  'flashing',
  'reading.sealed',
  'reading.armed',
  'falseStartCue',
  'buzzing.open',
  'answering.waiting',
  'announcing',
  'turnCue',
  'finalBets.asking',
])

export function readSavedGame(storage: Storage = localStorage): SavedGame | null {
  try {
    const raw = storage.getItem(gameStorageKey)
    if (!raw) return null
    return sanitize(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function writeSavedGame(game: SavedGame, storage: Storage = localStorage): void {
  const clean = sanitize(game)
  if (!clean) return
  storage.setItem(gameStorageKey, JSON.stringify(clean))
}

export function clearSavedGame(storage: Storage = localStorage): void {
  storage.removeItem(gameStorageKey)
}

/** Id своего файла. Совпадает с `ownPackId`: в снимке есть имя, самих байтов нет. */
const uploadedPackId = 'file'

export function packCanResume(
  saved: SavedGame | null,
  catalogIds: readonly string[],
  diskPackId = uploadedPackId,
): boolean {
  if (!saved) return false
  if (saved.packId === diskPackId) return true
  return catalogIds.includes(saved.packId)
}

/** Пакет выбран с диска: продолжение снова спрашивает файл, каталог не нужен. */
export function resumeNeedsFile(saved: SavedGame | null, diskPackId = uploadedPackId): boolean {
  return saved?.packId === diskPackId
}

export function resumePackTitle(saved: SavedGame | null, diskPackId = uploadedPackId): string {
  if (!resumeNeedsFile(saved, diskPackId) || !saved) return ''
  return saved.packName.trim() || saved.packFile.trim()
}

export function persistMatch(
  input: { packId: string; packFile: string; path: string; context: GameContext },
  storage: Storage = localStorage,
): SavedGame | null {
  if (input.path === 'startMenu') return readSavedGame(storage)
  const phase = phaseForSave(input.path, input.context.resumePath)
  if (!phase) return readSavedGame(storage)
  const game = sanitize({
    version: 1,
    packId: input.packId,
    packFile: input.packFile,
    packName: input.context.packName,
    ...matchFromContext(input.context, phase),
  })
  if (!game) return readSavedGame(storage)
  storage.setItem(gameStorageKey, JSON.stringify(game))
  return game
}

export function restoredMatch(pack: QuestionPack, saved: SavedMatch): Pick<
  GameContext,
  | 'players'
  | 'roundIndex'
  | 'playedIds'
  | 'missedIds'
  | 'chooserId'
  | 'finalists'
  | 'finalCursor'
  | 'bets'
  | 'betMisses'
  | 'activeStake'
  | 'activeQuestionId'
  | 'activePlayerId'
  | 'attemptId'
  | 'clarifications'
  | 'heard'
  | 'wrongHeard'
  | 'sayCloseGuess'
  | 'announceKind'
  | 'judgmentStatus'
  | 'resumePath'
  | 'statusLine'
> {
  const roundIndex = pack.rounds.some((round) => round.index === saved.roundIndex)
    ? saved.roundIndex
    : (pack.rounds[0]?.index ?? 0)
  const round = pack.rounds.find((item) => item.index === roundIndex)
  let phase = canonicalResumePhase(saved.phase) ?? 'choosing.listening'
  const question = questionById(pack.questions, saved.activeQuestionId)
  const questionOk = Boolean(question && question.roundIndex === roundIndex)
  if (questionPhases.has(phase) && !questionOk) phase = 'choosing.listening'
  if ((phase === 'finalBets.asking' || phase === 'turnCue') && (round?.kind !== 'final' || saved.finalists.length === 0)) {
    phase = 'choosing.listening'
  }
  const openQuestion = questionOk && questionPhases.has(phase)
  return {
    players: saved.players,
    roundIndex,
    playedIds: saved.playedIds.filter((id) => pack.questions.some((question) => question.id === id)),
    missedIds: saved.missedIds.filter((id) => rosterHas(saved.players, id)),
    chooserId: rosterHas(saved.players, saved.chooserId) ? saved.chooserId : openingChooser(saved.players),
    finalists: saved.finalists.filter((id) => rosterHas(saved.players, id)),
    finalCursor: saved.finalCursor,
    bets: saved.bets.filter((bet) => rosterHas(saved.players, bet.playerId)),
    betMisses: saved.betMisses,
    activeStake: openQuestion ? saved.activeStake : null,
    activeQuestionId: openQuestion ? saved.activeQuestionId : null,
    activePlayerId: openQuestion && saved.activePlayerId !== null && rosterHas(saved.players, saved.activePlayerId) ? saved.activePlayerId : null,
    attemptId: saved.attemptId,
    clarifications: saved.clarifications,
    heard: openQuestion ? saved.heard : '',
    wrongHeard: openQuestion ? saved.wrongHeard : [],
    sayCloseGuess: phase === 'announcing' && openQuestion ? saved.sayCloseGuess : false,
    announceKind: phase === 'announcing' ? saved.announceKind : null,
    judgmentStatus: phase === 'announcing' ? saved.judgmentStatus : null,
    resumePath: phase,
    statusLine: statusFor(phase, pack.name, round?.name ?? 'Раунд', round?.kind === 'final', saved.activePlayerId),
  }
}

function matchFromContext(context: GameContext, phase: string): SavedMatch {
  return {
    players: context.players.map((player) => ({ id: player.id, name: player.name, score: player.score })),
    roundIndex: context.roundIndex,
    playedIds: [...context.playedIds],
    missedIds: [...context.missedIds],
    chooserId: context.chooserId,
    finalists: [...context.finalists],
    bets: context.bets.map((bet) => ({ playerId: bet.playerId, amount: bet.amount })),
    finalCursor: context.finalCursor,
    betMisses: context.betMisses,
    activeQuestionId: context.activeQuestionId,
    activePlayerId: context.activePlayerId,
    activeStake: context.activeStake,
    attemptId: context.attemptId,
    clarifications: context.clarifications,
    heard: context.heard,
    wrongHeard: [...context.wrongHeard],
    sayCloseGuess: context.sayCloseGuess,
    announceKind: context.announceKind,
    judgmentStatus: context.judgmentStatus,
    phase,
  }
}

function phaseForSave(path: string, resumePath: string): string | null {
  if (path === 'failed' || path === 'stopped') return null
  if (path === 'paused' || path === 'connecting' || path === 'restoring') {
    const pending = canonicalResumePhase(resumePath)
    if (pending) return pending
    return path === 'connecting' ? 'welcoming' : null
  }
  return canonicalResumePhase(path)
}

function canonicalResumePhase(path: string): string | null {
  return canonicalPhases[path] ?? null
}

function statusFor(
  phase: string,
  packName: string,
  roundName: string,
  finalRound: boolean,
  playerId: PlayerId | null,
): string {
  if (phase === 'welcoming') return `Пакет «${packName}»`
  if (phase === 'choosing.listening') {
    return finalRound ? 'Выберите тему финала' : 'назовите тему и стоимость'
  }
  if (phase === 'finished') return 'Игра закончена'
  if (phase === 'buzzing.open' || phase === 'reading.armed') return 'Жмите свою кнопку'
  if (phase === 'falseStartCue') return 'Фальстарт'
  if (phase === 'answering.waiting') return `Отвечает игрок ${playerId ?? ''}`.trim()
  if (phase === 'announcing') return 'Объявление'
  if (phase === 'bridging') return roundName
  if (phase === 'finalBets.asking') return 'Назовите ставку'
  if (phase === 'turnCue') return 'Ваш ответ'
  return 'Ведущая читает вопрос'
}

function sanitize(value: unknown): SavedGame | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.version !== 1) return null
  if (typeof record.packId !== 'string' || !record.packId.trim()) return null
  if (typeof record.packFile !== 'string') return null
  if (typeof record.packName !== 'string') return null
  const players = normalizePlayers(record.players)
  const playedIds = stringList(record.playedIds)
  const missedIds = playerList(record.missedIds)
  const finalists = playerList(record.finalists)
  const bets = normalizeBets(record.bets)
  const phase = typeof record.phase === 'string' ? canonicalResumePhase(record.phase) : null
  if (!players || !playedIds || !missedIds || !finalists || !bets || !phase) return null
  if (!isPlayerId(record.chooserId)) return null
  const roster = new Set(players.map((player) => player.id))
  const roundIndex = whole(record.roundIndex)
  const finalCursor = whole(record.finalCursor)
  const betMisses = whole(record.betMisses)
  const attemptId = whole(record.attemptId)
  const clarifications = record.clarifications === undefined ? 0 : whole(record.clarifications)
  if (roundIndex === null || finalCursor === null || betMisses === null || attemptId === null || clarifications === null) {
    return null
  }
  const activeQuestionId = record.activeQuestionId === null ? null : typeof record.activeQuestionId === 'string' ? record.activeQuestionId : undefined
  if (activeQuestionId === undefined) return null
  const activePlayerId =
    record.activePlayerId === null
      ? null
      : isPlayerId(record.activePlayerId) && roster.has(record.activePlayerId)
        ? record.activePlayerId
        : isPlayerId(record.activePlayerId)
          ? null
          : undefined
  if (activePlayerId === undefined) return null
  const activeStake = record.activeStake === null ? null : typeof record.activeStake === 'number' && Number.isFinite(record.activeStake) ? record.activeStake : undefined
  if (activeStake === undefined) return null
  if (typeof record.heard !== 'string') return null
  const wrongHeard = record.wrongHeard === undefined ? [] : stringList(record.wrongHeard)
  if (!wrongHeard) return null
  const sayCloseGuess = record.sayCloseGuess === undefined ? false : record.sayCloseGuess
  if (typeof sayCloseGuess !== 'boolean') return null
  const announceKind = record.announceKind === null ? null : announceKinds.find((kind) => kind === record.announceKind)
  if (announceKind === undefined) return null
  const judgmentStatus =
    record.judgmentStatus === null ? null : judgmentStatuses.find((status) => status === record.judgmentStatus)
  if (judgmentStatus === undefined) return null
  return {
    version: 1,
    packId: record.packId,
    packFile: record.packFile,
    packName: record.packName,
    players,
    roundIndex,
    playedIds,
    missedIds: missedIds.filter((id) => roster.has(id)),
    chooserId: roster.has(record.chooserId) ? record.chooserId : openingChooser(players),
    finalists: finalists.filter((id) => roster.has(id)),
    bets: bets.filter((bet) => roster.has(bet.playerId)),
    finalCursor,
    betMisses,
    activeQuestionId,
    activePlayerId,
    activeStake,
    attemptId,
    clarifications,
    heard: record.heard,
    wrongHeard,
    sayCloseGuess,
    announceKind,
    judgmentStatus,
    phase,
  }
}

function normalizePlayers(value: unknown): Player[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const players: Player[] = []
  const seen = new Set<number>()
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const record = item as Record<string, unknown>
    if (!isPlayerId(record.id) || typeof record.name !== 'string' || !record.name.trim()) return null
    if (typeof record.score !== 'number' || !Number.isFinite(record.score)) return null
    if (seen.has(record.id)) return null
    seen.add(record.id)
    players.push({ id: record.id, name: record.name.trim(), score: record.score })
  }
  return players
}

function rosterHas(players: readonly Player[], id: PlayerId | null): id is PlayerId {
  return id !== null && players.some((player) => player.id === id)
}

function normalizeBets(value: unknown): Bet[] | null {
  if (!Array.isArray(value)) return null
  const bets: Bet[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const record = item as Record<string, unknown>
    if (!isPlayerId(record.playerId)) return null
    if (typeof record.amount !== 'number' || !Number.isFinite(record.amount)) return null
    bets.push({ playerId: record.playerId, amount: record.amount })
  }
  return bets
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return [...value]
}

function playerList(value: unknown): PlayerId[] | null {
  if (!Array.isArray(value) || value.some((item) => !isPlayerId(item))) return null
  return value.filter(isPlayerId)
}

function whole(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function isPlayerId(value: unknown): value is PlayerId {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

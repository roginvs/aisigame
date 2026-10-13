import type { ConferenceMessageRing } from '../conference/messages.ts'
import { messageRingFromLegacyChat, readMessageRing } from '../conference/messageRing.ts'
import { appealMsLeft, readAppeal, readOutcomes } from './appeals.ts'
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

/**
 * Схема снимка `aisigame.game`. Не commit сборки: поднимать только при
 * несовместимом изменении формата. Чужой номер `readSavedGame` отбрасывает.
 */
export const savedGameVersion = 1 as const

export type SavedGame = SavedMatch & {
  version: typeof savedGameVersion
  packId: string
  packFile: string
  packName: string
  /** SHA-256 своего файла, hex. Пусто у каталога и у старых снимков без хеша. */
  packHash: string
  mode?: 'table' | 'conference'
  /** Снимок сделан в комнате мастера до запуска самой партии. */
  conferenceLobby?: boolean
  jitsiUrl?: string
  roomId?: string
  /** Только старые входные снимки; при чтении мигрируется в message0…message199. */
  chat?: { name: string; text: string; at?: string }[]
  /** Мастер: галка «Меньше слышать». Старые снимки без поля — выкл. */
  hearTurnOnly?: boolean
} & Partial<ConferenceMessageRing>

export type PersistMatchConference = {
  messageRing?: ConferenceMessageRing
  mode?: 'table' | 'conference'
  conferenceLobby?: boolean
  jitsiUrl?: string
  roomId?: string
  chat?: { name: string; text: string; at?: string }[]
  hearTurnOnly?: boolean
}

export function persistConferenceLobby(
  input: {
    packId: string
    packFile: string
    packHash?: string
    pack: QuestionPack
    master: Player
    messageRing?: ConferenceMessageRing
    jitsiUrl: string
    roomId: string
    chat?: { name: string; text: string; at?: string }[]
    hearTurnOnly?: boolean
  },
  storage: Storage = localStorage,
): SavedGame | null {
  const game = sanitize({
    version: savedGameVersion,
    packId: input.packId,
    packFile: input.packFile,
    packName: input.pack.name,
    packHash: normalizeHash(input.packHash),
    mode: 'conference',
    conferenceLobby: true,
    jitsiUrl: input.jitsiUrl,
    roomId: input.roomId,
    ...input.messageRing,
    chat: input.chat,
    ...(input.hearTurnOnly === true ? { hearTurnOnly: true } : {}),
    players: [input.master],
    roundIndex: input.pack.rounds[0]?.index ?? 0,
    playedIds: [],
    missedIds: [],
    chooserId: input.master.id,
    finalists: [],
    bets: [],
    finalCursor: 0,
    betMisses: 0,
    activeQuestionId: null,
    activePlayerId: null,
    activeStake: null,
    attemptId: 0,
    clarifications: 0,
    heard: '',
    wrongHeard: [],
    sayCloseGuess: false,
    announceKind: null,
    judgmentStatus: null,
    phase: 'welcoming',
  })
  if (!game) return readSavedGame(storage)
  storage.setItem(gameStorageKey, JSON.stringify(game))
  return game
}

/** Режим партии из снимка. Старые снимки без mode — стол за одним экраном. */
export function readMatchMode(saved: SavedGame | null | undefined): 'table' | 'conference' {
  if (saved?.mode === 'conference') return 'conference'
  return 'table'
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
  appealCue: 'appealCue',
  appealWindow: 'appealWindow',
  welcoming: 'welcoming',
  choosing: 'choosing.listening',
  'choosing.listening': 'choosing.listening',
  'choosing.resolving': 'choosing.listening',
  'choosing.clarifying': 'choosing.listening',
  chooserHandoff: 'choosing.listening',
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
  'announcing.speaking': 'announcing',
  'announcing.holding': 'announcing',
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
  'appealCue',
  'appealWindow',
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

/** Id своего файла. Совпадает с `ownPackId`: в снимке имя и sha256, самих байтов нет. */
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
  if (!saved) return ''
  if (resumeNeedsFile(saved, diskPackId)) {
    return saved.packFile.trim() || saved.packName.trim() || saved.packId.trim()
  }
  return saved.packName.trim() || saved.packId.trim()
}

/** Имя файла с диска, как его выбрали. Пустое не подменяется названием пакета. */
export function resumeFileName(saved: SavedGame | null, diskPackId = uploadedPackId): string {
  if (!resumeNeedsFile(saved, diskPackId) || !saved) return ''
  return saved.packFile.trim()
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type ResumeFileDecision = { ok: true } | { ok: false; message: string }

/**
 * Сверка файла со снимком. Пустой хеш — старое сохранение, продолжаем без проверки.
 * Совпавший хеш продолжает партию, чужой — нет.
 */
export function decideResumeFile(input: {
  savedHash: string | null | undefined
  chosenHash: string
  fileName: string
}): ResumeFileDecision {
  const expected = normalizeHash(input.savedHash)
  if (!expected) return { ok: true }
  const chosen = normalizeHash(input.chosenHash)
  if (expected === chosen) return { ok: true }
  const name = input.fileName.trim()
  const named = name ? ` «${name}»` : ''
  return {
    ok: false,
    message: `Этот файл не из сохранённой игры. Нужен файл${named} с хешем ${expected}, а у выбранного файла хеш ${chosen}.`,
  }
}

function normalizeHash(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function persistMatch(
  input: {
    packId: string
    packFile: string
    packHash?: string
    path: string
    context: GameContext
    conference?: PersistMatchConference
    hearTurnOnly?: boolean
  },
  storage: Storage = localStorage,
): SavedGame | null {
  if (input.path === 'startMenu') {
    // Лобби конференции: фаза машины ещё startMenu, но снимок уже есть — обновить галку.
    return patchHearTurnOnly(input.hearTurnOnly ?? input.conference?.hearTurnOnly, storage)
  }
  const phase = phaseForSave(input.path, input.context.resumePath)
  if (!phase) return readSavedGame(storage)
  const previous = readSavedGame(storage)
  const requested = normalizeHash(input.packHash)
  const packHash =
    requested ||
    (input.packId === uploadedPackId && previous?.packId === input.packId && previous.packFile === input.packFile
      ? previous.packHash
      : '')
  const conference = conferenceForSave(input.conference, previous)
  const hearTurnOnly = resolveHearTurnOnly(input.hearTurnOnly ?? input.conference?.hearTurnOnly, previous?.hearTurnOnly)
  const game = sanitize({
    version: savedGameVersion,
    packId: input.packId,
    packFile: input.packFile,
    packName: input.context.packName,
    packHash,
    ...matchFromContext(input.context, phase),
    ...conference,
    ...(hearTurnOnly ? { hearTurnOnly: true } : {}),
  })
  if (!game) return readSavedGame(storage)
  storage.setItem(gameStorageKey, JSON.stringify(game))
  return game
}

export function restoredMatch(pack: QuestionPack, saved: SavedMatch): Pick<
  GameContext,
  | 'outcomes'
  | 'appeal'
  | 'appealSerial'
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
  let appeal = saved.appeal ?? null
  if (appeal && (questionById(pack.questions, appeal.questionId)?.roundIndex !== roundIndex || round?.kind === 'final')) appeal = null
  if (appeal?.activePlayerId !== null && appeal && phase === 'answering.waiting') phase = 'appealCue'
  if ((phase === 'appealCue' || phase === 'appealWindow') && !appeal) phase = 'choosing.listening'
  const openQuestion = questionOk && questionPhases.has(phase)

  return {
    outcomes: saved.outcomes ?? {},
    appeal: appeal ? { ...appeal, startedAt: null } : null,
    appealSerial: saved.appealSerial ?? 0,
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

function conferenceForSave(
  input: PersistMatchConference | undefined,
  previous: SavedGame | null,
): Pick<SavedGame, 'mode' | 'conferenceLobby' | 'jitsiUrl' | 'roomId'> & Partial<ConferenceMessageRing> {
  if (input?.mode === 'table') return { mode: 'table' }
  const mode = input?.mode ?? previous?.mode
  const conferenceLobby = input?.conferenceLobby ?? previous?.conferenceLobby
  const jitsiUrl = input?.jitsiUrl ?? previous?.jitsiUrl
  const roomId = input?.roomId ?? previous?.roomId
  const messageRing = input?.messageRing ?? readMessageRing(previous) ?? messageRingFromLegacyChat(input?.chat ?? previous?.chat ?? [])
  return {
    ...(mode === 'conference' ? { mode, ...messageRing } : mode === 'table' ? { mode } : {}),
    ...(conferenceLobby === true ? { conferenceLobby: true } : {}),
    ...(typeof jitsiUrl === 'string' && jitsiUrl.trim() ? { jitsiUrl: jitsiUrl.trim() } : {}),
    ...(typeof roomId === 'string' && roomId.trim() ? { roomId: roomId.trim() } : {}),
  }
}

/** Реплика сохраняется синхронно, включая лобби и паузу, без нового хода машины. */
export function persistConferenceHistory(roomId: string, history: ConferenceMessageRing, storage: Storage = localStorage): SavedGame | null {
  const previous = readSavedGame(storage)
  if (!previous || previous.mode !== 'conference' || previous.roomId !== roomId) return null
  const clean = readMessageRing(history)
  if (!clean) return previous
  const game = sanitize({ ...previous, ...clean })
  if (!game) return previous
  storage.setItem(gameStorageKey, JSON.stringify(game))
  return game
}

/** `undefined` — оставить как в прошлом снимке; `false` — выкл. и не писать поле. */
function resolveHearTurnOnly(input: boolean | undefined, previous: boolean | undefined): boolean {
  if (input === true) return true
  if (input === false) return false
  return previous === true
}

function patchHearTurnOnly(input: boolean | undefined, storage: Storage): SavedGame | null {
  const previous = readSavedGame(storage)
  if (!previous || input === undefined) return previous
  const nextOn = input === true
  const wasOn = previous.hearTurnOnly === true
  if (nextOn === wasOn) return previous
  const raw = { ...previous } as SavedGame & { hearTurnOnly?: boolean }
  if (nextOn) raw.hearTurnOnly = true
  else delete raw.hearTurnOnly
  const game = sanitize(raw)
  if (!game) return previous
  storage.setItem(gameStorageKey, JSON.stringify(game))
  return game
}

function matchFromContext(context: GameContext, phase: string): SavedMatch {
  return {
    outcomes: context.outcomes ?? {},
    appeal: context.appeal ? { ...context.appeal, remainingMs: appealMsLeft(context.appeal), startedAt: null } : null,
    appealSerial: context.appealSerial ?? 0,
    players: context.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      ...(player.clientId ? { clientId: player.clientId } : {}),
    })),
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
  if (record.version !== savedGameVersion) return null
  if (typeof record.packId !== 'string' || !record.packId.trim()) return null
  if (typeof record.packFile !== 'string') return null
  if (typeof record.packName !== 'string') return null
  const packHash = typeof record.packHash === 'string' ? record.packHash.trim().toLowerCase() : ''
  const outcomes = readOutcomes(record.outcomes)
  const appeal = readAppeal(record.appeal)
  const appealSerial = whole(record.appealSerial ?? 0)
  if (!outcomes || appeal === undefined || appealSerial === null) return null
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
  const conference = normalizeConference(record)
  return {
    version: savedGameVersion,
    packId: record.packId,
    packFile: record.packFile,
    packName: record.packName,
    packHash,
    ...conference,
    outcomes,
    appeal,
    appealSerial,
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
    const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : ''
    players.push({
      id: record.id,
      name: record.name.trim(),
      score: record.score,
      ...(clientId ? { clientId } : {}),
    })
  }
  return players
}

function normalizeConference(
  record: Record<string, unknown>,
): Pick<SavedGame, 'mode' | 'conferenceLobby' | 'jitsiUrl' | 'roomId' | 'hearTurnOnly'> & Partial<ConferenceMessageRing> {
  const out: Pick<SavedGame, 'mode' | 'conferenceLobby' | 'jitsiUrl' | 'roomId' | 'hearTurnOnly'> & Partial<ConferenceMessageRing> = {}
  if (record.mode === 'conference') out.mode = 'conference'
  else if (record.mode === 'table') out.mode = 'table'
  if (record.conferenceLobby === true) out.conferenceLobby = true
  if (typeof record.jitsiUrl === 'string' && record.jitsiUrl.trim()) out.jitsiUrl = record.jitsiUrl.trim()
  if (typeof record.roomId === 'string' && record.roomId.trim()) out.roomId = record.roomId.trim()
  const chat = normalizeChat(record.chat)
  if (out.mode === 'conference') Object.assign(out, readMessageRing(record) ?? messageRingFromLegacyChat(chat ?? []))
  if (record.hearTurnOnly === true) out.hearTurnOnly = true
  return out
}

function normalizeChat(value: unknown): { name: string; text: string; at?: string }[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return null
  const messages: { name: string; text: string; at?: string }[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    if (typeof row.name !== 'string' || typeof row.text !== 'string') return null
    const at = typeof row.at === 'string' ? row.at : undefined
    messages.push(at ? { name: row.name, text: row.text, at } : { name: row.name, text: row.text })
  }
  return messages
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

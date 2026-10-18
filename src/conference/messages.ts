/** Сообщения конференции — plain JSON, без классов. */
import { readChatMark, type ChatMark } from '../debug/trace.ts'
import { readHostEar, type HostEar } from '../game/hostEar.ts'
import { readAppeal, readOutcomes } from '../game/appeals.ts'
import { readSpecialState } from '../game/specialState.ts'
import type { AppealFields, AppealRequest, AnnounceKind, JudgmentStatus, SpecialState } from '../game/types.ts'

/** Общий кольцевой буфер текстового чата и реплик «Разговора». */
export const CONFERENCE_HISTORY_LIMIT = 200

export type ConferenceConversationLine = {
  /** Стабильный id строки (мастер правит её по id: оборванная реплика ведущей). Старые мастера не шлют. */
  id?: string
  role: 'host' | 'player' | 'judge' | 'error' | 'system'
  text: string
  note?: string
  /** Реплика игрока: как модель её поняла (заминка, шум, засчитано, ячейка…). Старые клиенты игнорируют. */
  mark?: ChatMark
  /** Реплика игрока: id говорившего игрока (ставит мастер); имя каждый экран берёт из players снимка. Нет — «Услышано». */
  speakerId?: number
  /** ISO-время для общего хронологического потока с текстовым чатом. */
  at?: string
}

export type ConferenceChatLine = {
  name: string
  text: string
  /** ISO-время; нужно, чтобы чат не прилипал к низу колонки «Разговор». */
  at?: string
}

export type ConferenceSnapshotPlayer = {
  id: number
  name: string
  score: number
  clientId?: string
}

/** `[jitsiId, clientId]` — см. `ConferenceSnapshot.jitsiIds`. */
export type ConferenceJitsiPair = [jitsiId: string, clientId: string]

export type ConferenceSnapshotPresence = {
  clientId: string
  name: string
  playerId: number | null
  isMaster: boolean
  stale: boolean
  hidden: boolean
  /** 0–100: сборка и сверка пакета у этого клиента */
  percent: number
  /** Байты/с приёма пакета; старые клиенты могут не слать поле. */
  downloadBps?: number | null
  /** Секунды до конца передачи по оценке мастера. */
  etaSeconds?: number | null
  /**
   * Фаза доставки пакета: connecting / downloading / verifying / …
   * Старые снимки могут не слать поле.
   */
  packPhase?: string
  ready: boolean
  hashOk: boolean
  /** RTT мастер ↔ клиент, мс; старые мастера не шлют. */
  pingMs?: number | null
}

export type ConferencePackManifest = {
  hash: string
  size: number
  name: string
  summary: string
}

export type ConferenceSnapshot = AppealFields & {
  /** Хеш коммита сборки мастера (`buildCommit`); joiner сверяет со своим. Старые мастера могут не слать. */
  commit?: string
  /** Пакет — часть глобального статуса, доступная без отдельного packOffer. */
  pack: ConferencePackManifest | null
  phase: string
  players: ConferenceSnapshotPlayer[]
  presence: ConferenceSnapshotPresence[]
  /**
   * Кто есть кто в Jitsi: пары `[jitsiId, clientId]` (сначала id соединения, потом устройство).
   * Ведёт мастер (своё соединение + отправитель hello гостя). Имя для узнавания не используется;
   * одно устройство = одно соединение, поэтому несколько игроков с одним clientId (multi-seat)
   * получают одну и ту же камеру/дорожку без изменения формата.
   */
  jitsiIds: ConferenceJitsiPair[]
  /** Id в Jitsi служебной «Ведущей» мастера; `null` — ещё нет (или режим без Jitsi). */
  hostJitsiId: string | null
  /** Id в Jitsi служебного участника «Звуки игры»; меняется при его переподключении. */
  soundsJitsiId: string | null
  roundIndex: number
  playedIds: string[]
  missedIds: number[]
  finalists: number[]
  finalCursor: number
  activeQuestionId: string | null
  chooserId: number | null
  answererId: number | null
  falseStartIds: number[]
  falseStarts: Record<string, number>
  bets: Record<string, number>
  betMisses: number
  activeStake: number | null
  attemptId: number
  clarifications: number
  spokeWithoutButton: boolean
  talkedDuringRead: boolean
  sayFalseStart: boolean
  heard: string
  wrongHeard: string[]
  sayCloseGuess: boolean
  judgmentReason: string
  judgmentStatus: JudgmentStatus | null
  announceKind: AnnounceKind | null
  clarifyReason: string
  statusLine: string
  phaseDurationMs: number | null
  timerRemainingMs: number | null
  /** Кот в мешке / аукцион; старые мастера не шлют. */
  special?: SpecialState | null
  /** Черновик речи игрока (delta), только для показа; старые мастера не шлют. */
  liveSpeech?: { text: string; at: string } | null
  /** Что ведущая слышит (speech_started/stopped), только для показа; старые мастера не шлют. */
  hostEar?: HostEar
  /** Пауза: куда вернётся партия — гость рисует паузу как мастер (эталон, медиа ответа). */
  resumePath?: string
  resumeStatus?: string
  /** Публичная ошибка ведущей/модели (у мастера `context.error`). */
  error?: string | null
  /** Состояние ведущей у мастера: говорит ли, открыт ли микрофон модели. Настроение карточки у всех из него. */
  /** «Меньше слышать» у мастера: подсказка карточки ведущей у всех одна. */
  hearTurnOnly?: boolean
  /** Пауза в лобби: в модель ничего не шлётся, машина контроллера стоит на паузе. */
  lobbyPaused?: boolean
  hostLink?: { host: 'idle' | 'speaking' | 'blocked'; mic: 'idle' | 'requesting' | 'live' | 'muted' | 'error' }
} & ConferenceMessageRing

/** Единая история состояния, сохранения и экрана — сообщения в отдельных слотах. */
export type ConferenceHistoryMessage =
  | ({ kind: 'conversation' } & ConferenceConversationLine)
  | ({ kind: 'chat' } & ConferenceChatLine)

export type ConferenceMessageSlot = `message${number}`
export type ConferenceMessageRing = Record<ConferenceMessageSlot, ConferenceHistoryMessage | null> & {
  /** Последний записанный слот; -1 означает пустую историю. */
  messageIndex: number
}
export type ConferenceState = ConferenceSnapshot

export type StatusRequestMessage = {
  type: 'statusRequest'
  clientId: string
  authToken: string
}

export type PartialUpdateMessage = {
  type: 'partialUpdate'
  authorityToken: string
  baseRevision: number
  revision: number
  changes: Partial<ConferenceState>
}

export type HelloMessage = {
  type: 'hello'
  clientId: string
  authToken: string
  name: string
}

export type PackOfferMessage = {
  type: 'packOffer'
  authorityToken: string
  /** Пусто у старых клиентов; иначе пакет предназначен только этому клиенту. */
  targetClientId?: string
  /** Хеш коммита сборки мастера; joiner сверяет до загрузки пакета. Старые мастера могут не слать. */
  commit?: string
  hash: string
  size: number
  name: string
  /** Короткая подпись, которую мастер уже собрал */
  summary: string
}

export type PackChunkMessage = {
  type: 'packChunk'
  authorityToken: string
  targetClientId?: string
  hash: string
  index: number
  total: number
  dataBase64: string
}

export type PackAckMessage = {
  type: 'packAck'
  clientId: string
  authToken: string
  hash: string
  /** Первый отсутствующий индекс; 0 также явно перезапускает передачу. */
  nextIndex: number
}

/** Сигнализация прямого WebRTC data channel для раздачи пакета (через Jitsi endpoint). */
export type PackPipeOfferMessage = {
  type: 'packPipeOffer'
  authorityToken: string
  targetClientId: string
  sdp: string
}

export type PackPipeAnswerMessage = {
  type: 'packPipeAnswer'
  clientId: string
  authToken: string
  sdp: string
}

export type PackPipeIceMessage = {
  type: 'packPipeIce'
  /** Мастер → joiner */
  authorityToken?: string
  targetClientId?: string
  /** Joiner → мастер */
  clientId?: string
  authToken?: string
  candidate: RTCIceCandidateInit | null
}

export type ReadyMessage = {
  type: 'ready'
  clientId: string
  authToken: string
}

/** Пакет полностью получен, проверен по hash и успешно открыт клиентом. */
export type PackVerifiedMessage = {
  type: 'packVerified'
  clientId: string
  authToken: string
  hash: string
}

/** Клиент заново проверяет кеш или загружает файл; прежний hashOk/ready уже не актуален. */
export type PackStatusMessage = {
  type: 'packStatus'
  clientId: string
  authToken: string
  hash: string
  percent: number
  packPhase: 'connecting' | 'downloading' | 'verifying'
}

export type AppealMessage = { type: 'appeal'; clientId: string; authToken: string } & AppealRequest
export type AppealReplyMessage = {
  type: 'appealReply'
  authorityToken: string
  targetClientId: string
  requestId: string
  accepted: boolean
  reason: string
}

export type BuzzMessage = {
  type: 'buzz'
  clientId: string
  authToken: string
}

/** Игрок → мастер: toggle паузы. Ставит паузу или снимает по текущему состоянию машины. */
export type PauseToggleMessage = {
  type: 'pause'
  clientId: string
  authToken: string
}

export type PickMessage = {
  type: 'pick'
  clientId: string
  authToken: string
  themeId: string
  value: number
}

/** Кот/аукцион: клик игрока. Мастер сам проверяет право и варианты. */
export type SpecialPickMessage = {
  type: 'specialPick'
  clientId: string
  authToken: string
  target: 'player' | 'stake' | 'auction'
  playerId?: number
  amount?: number
  choice?: 'pass' | 'allIn' | number
}

export type ChatMessage = {
  type: 'chat'
  clientId: string
  authToken: string
  text: string
}

/** Игрок → мастер: на устройстве кончились заготовленные `<audio>`. Мастер пишет строку в чат всем. */
export type AudioSinkNoteMessage = {
  type: 'audioSinkNote'
  clientId: string
  authToken: string
  /** Имя владельца дорожки, как его видит устройство игрока. */
  owner: string
}

export type ConferenceDebugEntry = {
  at: string
  kind: 'in' | 'out' | 'state' | 'chat' | 'note'
  title: string
  detail?: string
}

/** Ограниченный и уже обезличенный журнал вкладки игрока для debug dump мастера. */
export type DebugLogMessage = {
  type: 'debugLog'
  clientId: string
  authToken: string
  entries: ConferenceDebugEntry[]
}

/** Мастер → все: замер задержки; клиент возвращает sentAt в pong без изменений. */
export type PingMessage = { type: 'ping'; authorityToken: string; seq: number; sentAt: number }
export type PongMessage = { type: 'pong'; clientId: string; authToken: string; seq: number; sentAt: number }

export type SnapshotMessage = {
  type: 'snapshot'
  authorityToken: string
  revision: number
} & ConferenceState

export type ConferenceMessage =
  | HelloMessage
  | PackOfferMessage
  | PackChunkMessage
  | PackAckMessage
  | PackPipeOfferMessage
  | PackPipeAnswerMessage
  | PackPipeIceMessage
  | PackVerifiedMessage
  | PackStatusMessage
  | ReadyMessage
  | AppealMessage
  | AppealReplyMessage
  | BuzzMessage
  | PauseToggleMessage
  | PickMessage
  | SpecialPickMessage
  | ChatMessage
  | AudioSinkNoteMessage
  | DebugLogMessage
  | SnapshotMessage
  | PartialUpdateMessage
  | StatusRequestMessage
  | PingMessage
  | PongMessage

export function isConferenceMessage(value: unknown): value is ConferenceMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  const client = () => shortString(value.clientId, 200) && shortString(value.authToken, 300)
  switch (value.type) {
    case 'hello':
      return client() && shortString(value.name, 100)
    case 'packOffer':
      return (
        authority(value) &&
        optionalString(value.targetClientId, 200) &&
        optionalString(value.commit, 80) &&
        shortString(value.hash, 128) &&
        integer(value.size, 0) && (value.size as number) <= 120 * 1024 * 1024 &&
        shortString(value.name, 300) &&
        typeof value.summary === 'string' &&
        value.summary.length <= 10_000
      )
    case 'packChunk':
      return (
        authority(value) &&
        optionalString(value.targetClientId, 200) &&
        shortString(value.hash, 128) &&
        integer(value.index, 0) &&
        integer(value.total, 1) && (value.total as number) <= 10_000 &&
        typeof value.dataBase64 === 'string' &&
        value.dataBase64.length <= 400_000
      )
    case 'packAck':
      return client() && shortString(value.hash, 128) && integer(value.nextIndex, 0)
    case 'packPipeOffer':
      return (
        authority(value) &&
        shortString(value.targetClientId, 200) &&
        typeof value.sdp === 'string' &&
        value.sdp.length > 0 &&
        value.sdp.length <= 100_000
      )
    case 'packPipeAnswer':
      return client() && typeof value.sdp === 'string' && value.sdp.length > 0 && value.sdp.length <= 100_000
    case 'packPipeIce':
      return validPackPipeIce(value)
    case 'packVerified':
      return client() && shortString(value.hash, 128)
    case 'packStatus':
      return client() && shortString(value.hash, 128) && integer(value.percent, 0) &&
        value.percent <= 99 && ['connecting', 'downloading', 'verifying'].includes(String(value.packPhase))
    case 'statusRequest':
    case 'ready':
    case 'buzz':
      return client()
    case 'pause':
      return client()
    case 'appeal':
      return client() && shortString(value.questionId, 2_000) && integer(value.playerId, 1) && integer(value.windowId, 1) && shortString(value.requestId, 200)
    case 'appealReply':
      return authority(value) && shortString(value.targetClientId, 200) && shortString(value.requestId, 200) && typeof value.accepted === 'boolean' && validText(value.reason)
    case 'pick':
      return client() && shortString(value.themeId, 500) && Number.isFinite(value.value)
    case 'specialPick':
      return client() && (
        (value.target === 'player' && integer(value.playerId, 1)) ||
        (value.target === 'stake' && integer(value.amount, 1)) ||
        (value.target === 'auction' && (value.choice === 'pass' || value.choice === 'allIn' || integer(value.choice, 1))))
    case 'chat':
      return client() && typeof value.text === 'string' && value.text.length <= 4_000
    case 'audioSinkNote':
      return client() && typeof value.owner === 'string' && value.owner.length <= 100
    case 'debugLog':
      return (
        client() &&
        Array.isArray(value.entries) &&
        value.entries.length > 0 &&
        value.entries.length <= 24 &&
        value.entries.every(validDebugEntry) &&
        debugEntriesSize(value.entries) <= 32_000
      )
    case 'ping':
      return authority(value) && integer(value.seq, 0) && Number.isFinite(value.sentAt)
    case 'pong':
      return client() && integer(value.seq, 0) && Number.isFinite(value.sentAt)
    case 'snapshot':
      return authority(value) && integer(value.revision, 0) && validConferenceState(value)
    case 'partialUpdate':
      return authority(value) && integer(value.baseRevision, 0) && integer(value.revision, 0) &&
        ((value.revision === value.baseRevision && isRecord(value.changes) && Object.keys(value.changes).length === 0) ||
          (value.revision === (value.baseRevision as number) + 1 && validPartialState(value.changes)))
    default:
      return false
  }
}

function validDebugEntry(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!shortString(value.at, 40) || !shortString(value.title, 500)) return false
  if (!['in', 'out', 'state', 'chat', 'note'].includes(String(value.kind))) return false
  return value.detail === undefined || (typeof value.detail === 'string' && value.detail.length <= 4_000)
}

function debugEntriesSize(entries: unknown[]): number {
  let total = 0
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    total += textSize(entry.at) + textSize(entry.kind) + textSize(entry.title) + textSize(entry.detail)
  }
  return total
}

function textSize(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  return (JSON.stringify(value) ?? '').length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function optionalString(value: unknown, max: number): boolean {
  return value === undefined || shortString(value, max)
}

function integer(value: unknown, min = Number.MIN_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min
}

function authority(value: Record<string, unknown>): boolean {
  return shortString(value.authorityToken, 300)
}

function validPackPipeIce(value: Record<string, unknown>): boolean {
  const fromMaster = shortString(value.authorityToken, 300) && shortString(value.targetClientId, 200)
  const fromJoiner = shortString(value.clientId, 200) && shortString(value.authToken, 300)
  if (!fromMaster && !fromJoiner) return false
  if (value.candidate === null) return true
  if (!isRecord(value.candidate)) return false
  // candidate string can be empty for some end-of-candidates shapes; allow missing.
  if (value.candidate.candidate !== undefined && typeof value.candidate.candidate !== 'string') return false
  if (value.candidate.candidate !== undefined && (value.candidate.candidate as string).length > 8_000) return false
  return true
}

type StateFields = Omit<ConferenceSnapshot, keyof ConferenceMessageRing>
const stateValidators = {
  outcomes: (value: unknown) => readOutcomes(value) !== null,
  appeal: (value: unknown) => readAppeal(value) !== undefined,
  appealSerial: (value: unknown) => value === undefined || integer(value, 0),
  commit: (value: unknown) => optionalString(value, 80),
  pack: (value: unknown) => value === null || validPackManifest(value),
  phase: (value: unknown) => shortString(value, 100),
  players: (value: unknown) => Array.isArray(value) && value.length <= 1_000 && value.every(validPlayer),
  presence: (value: unknown) => Array.isArray(value) && value.length <= 1_000 && value.every(validPresence),
  jitsiIds: validJitsiPairs,
  hostJitsiId: (value: unknown) => value === null || shortString(value, 200),
  soundsJitsiId: (value: unknown) => value === null || shortString(value, 200),
  roundIndex: integer,
  playedIds: (value: unknown) => stringArray(value, 20_000),
  missedIds: (value: unknown) => numberArray(value, 10_000),
  finalists: (value: unknown) => numberArray(value, 10_000),
  finalCursor: (value: unknown) => integer(value, 0),
  activeQuestionId: (value: unknown) => nullableString(value, 2_000),
  chooserId: nullableInteger,
  answererId: nullableInteger,
  falseStartIds: (value: unknown) => numberArray(value, 10_000),
  falseStarts: numericRecord,
  bets: numericRecord,
  betMisses: (value: unknown) => integer(value, 0),
  activeStake: nullableInteger,
  attemptId: (value: unknown) => integer(value, 0),
  clarifications: (value: unknown) => integer(value, 0),
  spokeWithoutButton: (value: unknown) => typeof value === 'boolean',
  talkedDuringRead: (value: unknown) => typeof value === 'boolean',
  sayFalseStart: (value: unknown) => typeof value === 'boolean',
  sayCloseGuess: (value: unknown) => typeof value === 'boolean',
  heard: validText,
  judgmentReason: validText,
  clarifyReason: validText,
  statusLine: validText,
  wrongHeard: (value: unknown) => stringArray(value, 10_000),
  judgmentStatus: (value: unknown) => nullableString(value, 100),
  announceKind: (value: unknown) => nullableString(value, 100),
  phaseDurationMs: nullableFinite,
  timerRemainingMs: nullableFinite,
  special: (value: unknown) => value === undefined || value === null || readSpecialState(value) !== null,
  hostEar: (value: unknown) => value === undefined || readHostEar(value) !== null,
  liveSpeech: (value: unknown) => value === undefined || value === null ||
    (isRecord(value) && typeof value.text === 'string' && value.text.length <= 2000 && typeof value.at === 'string' && value.at.length <= 64),
  resumePath: (value: unknown) => value === undefined || (typeof value === 'string' && value.length <= 100),
  resumeStatus: (value: unknown) => value === undefined || validText(value),
  error: (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.length <= 2_000),
  hearTurnOnly: (value: unknown) => value === undefined || typeof value === 'boolean',
  lobbyPaused: (value: unknown) => value === undefined || typeof value === 'boolean',
  hostLink: (value: unknown) => value === undefined || (isRecord(value) &&
    ['idle', 'speaking', 'blocked'].includes(value.host as string) &&
    ['idle', 'requesting', 'live', 'muted', 'error'].includes(value.mic as string)),
} satisfies Record<keyof StateFields, (value: unknown) => boolean>

function validPackManifest(value: unknown): boolean {
  return isRecord(value) && shortString(value.hash, 128) && integer(value.size, 0) &&
    value.size <= 120 * 1024 * 1024 && shortString(value.name, 300) &&
    typeof value.summary === 'string' && value.summary.length <= 10_000
}

function validText(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 20_000
}

export function validConferenceState(value: unknown): value is ConferenceState {
  if (!isRecord(value)) return false
  for (const [key, validate] of Object.entries(stateValidators)) {
    if (!validate(value[key])) return false
  }
  return validConferenceMessageRing(value)
}

export function validConferenceMessageRing(value: unknown): value is ConferenceMessageRing {
  if (!isRecord(value) || !validMessageIndex(value.messageIndex)) return false
  for (let i = 0; i < CONFERENCE_HISTORY_LIMIT; i++) {
    if (!validHistoryMessage(value[`message${i}`])) return false
  }
  return true
}

function validMessageIndex(value: unknown): boolean {
  return integer(value, -1) && value < CONFERENCE_HISTORY_LIMIT
}

function validHistoryMessage(value: unknown): boolean {
  if (value === null) return true
  return isRecord(value) && ((value.kind === 'conversation' && validConversationLine(value)) ||
    (value.kind === 'chat' && validChatLine(value)))
}

function validPartialState(value: unknown): boolean {
  if (!isRecord(value)) return false
  const fields = Object.entries(value)
  if (fields.length === 0 || fields.length > Object.keys(stateValidators).length + CONFERENCE_HISTORY_LIMIT + 1) return false
  return fields.every(([key, item]) => {
    if (Object.hasOwn(stateValidators, key)) return stateValidators[key as keyof StateFields](item)
    if (key === 'messageIndex') return validMessageIndex(item)
    const slot = /^message(0|[1-9]\d*)$/.exec(key)
    return slot !== null && Number(slot[1]) < CONFERENCE_HISTORY_LIMIT && validHistoryMessage(item)
  })
}

function validPlayer(value: unknown): boolean {
  return isRecord(value) && integer(value.id, 1) && shortString(value.name, 100) && Number.isFinite(value.score) && optionalString(value.clientId, 200)
}

/** Пары `[jitsiId, clientId]`: ровно две непустые строки; clientId не повторяется (одно устройство — одно соединение). */
export function validJitsiPairs(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 1_000) return false
  const clients = new Set<string>()
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || !shortString(pair[0], 200) || !shortString(pair[1], 200)) return false
    if (clients.has(pair[1])) return false
    clients.add(pair[1])
  }
  return true
}

function validPresence(value: unknown): boolean {
  return isRecord(value) && shortString(value.clientId, 200) && shortString(value.name, 100) &&
    nullableInteger(value.playerId) && typeof value.isMaster === 'boolean' && typeof value.stale === 'boolean' &&
    typeof value.hidden === 'boolean' && Number.isFinite(value.percent) && typeof value.ready === 'boolean' &&
    typeof value.hashOk === 'boolean' &&
    (value.downloadBps === undefined || value.downloadBps === null || Number.isFinite(value.downloadBps)) &&
    (value.etaSeconds === undefined || value.etaSeconds === null || Number.isFinite(value.etaSeconds)) &&
    (value.packPhase === undefined || (typeof value.packPhase === 'string' && value.packPhase.length <= 40)) &&
    (value.pingMs === undefined || value.pingMs === null || (Number.isFinite(value.pingMs) && (value.pingMs as number) >= 0))
}

function validConversationLine(value: unknown): boolean {
  return isRecord(value) && (value.role === 'host' || value.role === 'player' || value.role === 'judge' || value.role === 'error' || value.role === 'system') &&
    typeof value.text === 'string' && value.text.length <= 20_000 &&
    (value.note === undefined || (typeof value.note === 'string' && value.note.length <= 20_000)) &&
    (value.at === undefined || shortString(value.at, 40)) &&
    (value.id === undefined || shortString(value.id, 80)) &&
    (value.mark === undefined || readChatMark(value.mark) !== undefined) &&
    (value.speakerId === undefined || (value.role === 'player' && integer(value.speakerId, 1)))
}

function validChatLine(value: unknown): boolean {
  return isRecord(value) && shortString(value.name, 100) && typeof value.text === 'string' && value.text.length <= 4_000 &&
    (value.at === undefined || shortString(value.at, 40))
}

function stringArray(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string')
}

function numberArray(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length <= max && value.every((item) => integer(item))
}

function nullableString(value: unknown, max: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= max)
}

function nullableInteger(value: unknown): boolean {
  return value === null || integer(value)
}

function nullableFinite(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function numericRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 10_000 && entries.every(([key, item]) => /^\d+$/.test(key) && typeof item === 'number' && Number.isFinite(item))
}

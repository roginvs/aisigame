/** Сообщения конференции — plain JSON, без классов. */
import type { AnnounceKind, JudgmentStatus } from '../game/types.ts'

export type ConferenceConversationLine = {
  role: 'host' | 'player' | 'judge'
  text: string
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
  ready: boolean
  hashOk: boolean
}

export type ConferenceSnapshot = {
  phase: string
  players: ConferenceSnapshotPlayer[]
  presence: ConferenceSnapshotPresence[]
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
  conversation: ConferenceConversationLine[]
  chat: ConferenceChatLine[]
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

export type BuzzMessage = {
  type: 'buzz'
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

export type ChatMessage = {
  type: 'chat'
  clientId: string
  authToken: string
  text: string
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

export type SnapshotMessage = {
  type: 'snapshot'
  authorityToken: string
} & ConferenceSnapshot

export type ConferenceMessage =
  | HelloMessage
  | PackOfferMessage
  | PackChunkMessage
  | PackAckMessage
  | PackVerifiedMessage
  | ReadyMessage
  | BuzzMessage
  | PickMessage
  | ChatMessage
  | DebugLogMessage
  | SnapshotMessage

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
    case 'packVerified':
      return client() && shortString(value.hash, 128)
    case 'ready':
    case 'buzz':
      return client()
    case 'pick':
      return client() && shortString(value.themeId, 500) && Number.isFinite(value.value)
    case 'chat':
      return client() && typeof value.text === 'string' && value.text.length <= 4_000
    case 'debugLog':
      return (
        client() &&
        Array.isArray(value.entries) &&
        value.entries.length > 0 &&
        value.entries.length <= 24 &&
        value.entries.every(validDebugEntry) &&
        debugEntriesSize(value.entries) <= 32_000
      )
    case 'snapshot':
      return authority(value) && validSnapshot(value)
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
    total += String(entry.at ?? '').length + String(entry.kind ?? '').length +
      String(entry.title ?? '').length + String(entry.detail ?? '').length
  }
  return total
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

function validSnapshot(value: Record<string, unknown>): boolean {
  if (!shortString(value.phase, 100) || !Array.isArray(value.players) || !Array.isArray(value.presence)) return false
  if (value.players.length > 1_000 || value.presence.length > 1_000) return false
  if (!value.players.every(validPlayer) || !value.presence.every(validPresence)) return false
  if (!integer(value.roundIndex) || !stringArray(value.playedIds, 20_000) || !numberArray(value.missedIds, 10_000)) return false
  if (!numberArray(value.finalists, 10_000) || !integer(value.finalCursor, 0)) return false
  if (!nullableString(value.activeQuestionId, 2_000) || !nullableInteger(value.chooserId) || !nullableInteger(value.answererId)) return false
  if (!numberArray(value.falseStartIds, 10_000) || !numericRecord(value.falseStarts) || !numericRecord(value.bets)) return false
  if (!integer(value.betMisses, 0) || !nullableInteger(value.activeStake) || !integer(value.attemptId, 0)) return false
  if (!integer(value.clarifications, 0)) return false
  for (const key of ['spokeWithoutButton', 'talkedDuringRead', 'sayFalseStart', 'sayCloseGuess'] as const) {
    if (typeof value[key] !== 'boolean') return false
  }
  for (const key of ['heard', 'judgmentReason', 'clarifyReason', 'statusLine'] as const) {
    if (typeof value[key] !== 'string' || value[key].length > 20_000) return false
  }
  if (!stringArray(value.wrongHeard, 10_000)) return false
  if (!nullableString(value.judgmentStatus, 100) || !nullableString(value.announceKind, 100)) return false
  if (!nullableFinite(value.phaseDurationMs) || !nullableFinite(value.timerRemainingMs)) return false
  return Array.isArray(value.conversation) && value.conversation.length <= 200 && value.conversation.every(validConversationLine) &&
    Array.isArray(value.chat) && value.chat.length <= 200 && value.chat.every(validChatLine)
}

function validPlayer(value: unknown): boolean {
  return isRecord(value) && integer(value.id, 1) && shortString(value.name, 100) && Number.isFinite(value.score) && optionalString(value.clientId, 200)
}

function validPresence(value: unknown): boolean {
  return isRecord(value) && shortString(value.clientId, 200) && shortString(value.name, 100) &&
    nullableInteger(value.playerId) && typeof value.isMaster === 'boolean' && typeof value.stale === 'boolean' &&
    typeof value.hidden === 'boolean' && Number.isFinite(value.percent) && typeof value.ready === 'boolean' &&
    typeof value.hashOk === 'boolean' &&
    (value.downloadBps === undefined || value.downloadBps === null || Number.isFinite(value.downloadBps)) &&
    (value.etaSeconds === undefined || value.etaSeconds === null || Number.isFinite(value.etaSeconds))
}

function validConversationLine(value: unknown): boolean {
  return isRecord(value) && (value.role === 'host' || value.role === 'player' || value.role === 'judge') &&
    typeof value.text === 'string' && value.text.length <= 20_000 &&
    (value.at === undefined || shortString(value.at, 40))
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

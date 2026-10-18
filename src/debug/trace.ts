import { stageWordsIn } from './stageWords.ts'
import { buildCommit, pageOrigin } from '../buildInfo.ts'
import { perfWatchSummary } from './perfWatch.ts'
import type { JudgmentStatus } from '../game/types.ts'

export type TraceKind = 'in' | 'out' | 'state' | 'chat' | 'note'

export type ChatRole = 'host' | 'player' | 'judge' | 'error' | 'system'

export type TraceEntry = {
  id: number
  at: string
  kind: TraceKind
  title: string
  detail?: unknown
}

/** Небольшая уже обезличенная запись, которую можно передать мастеру конференции. */
export type SharedDebugEntry = {
  at: string
  kind: TraceKind
  title: string
  detail?: string
}

import { debugLogStore, type StoredLogEntry } from './logDb.ts'

const limit = 1500
const remoteClientLimit = 32
const remoteEntryLimit = 160
let sequence = 0
let snapshot: TraceEntry[] = []
const listeners = new Set<() => void>()
const remoteSnapshot = new Map<string, { name: string; entries: SharedDebugEntry[] }>()
let lastHostLine = ''
let linkStatus = { connection: 'idle', mic: 'idle', host: 'idle' }

export function getLinkStatus(): Readonly<typeof linkStatus> {
  return linkStatus
}

const linkListeners = new Set<() => void>()

export function subscribeLinkStatus(listener: () => void): () => void {
  linkListeners.add(listener)
  return () => linkListeners.delete(listener)
}

export function noteLink(patch: Partial<typeof linkStatus>): void {
  const next = { ...linkStatus, ...patch }
  if (
    next.connection === linkStatus.connection &&
    next.mic === linkStatus.mic &&
    next.host === linkStatus.host
  ) {
    return
  }
  linkStatus = next
  for (const listener of linkListeners) listener()
  pushTrace('note', `связь ${next.connection}, микрофон ${next.mic}, звук ${next.host}`)
}

/**
 * Покадровые `.delta` намеренно нигде не сохраняются и не печатаются. Вывод
 * каждого аудиокадра резко тормозит вкладку, когда открыты DevTools.
 */
export function logTrace(kind: TraceKind, title: string, detail?: unknown): void {
  void kind
  void title
  void detail
}

export function pushTrace(kind: TraceKind, title: string, detail?: unknown): void {
  const entry: TraceEntry = {
    id: ++sequence,
    at: new Date().toISOString(),
    kind,
    title: redact(title),
    detail: detail === undefined ? undefined : sanitize(detail),
  }
  const next = snapshot.length >= limit ? snapshot.slice(snapshot.length - limit + 1) : snapshot.slice()
  next.push(entry)
  snapshot = next
  debugLogStore.push({
    source: 'local',
    at: entry.at,
    kind,
    title: entry.title,
    ...(entry.detail === undefined ? {} : { detail: safeJson(entry.detail) ?? '"[не сериализуется]"' }),
  })
  console.log(`[aisigame ${entry.at}] ${kind} ${entry.title}`, entry.detail ?? '')
  for (const listener of listeners) listener()
}

/** Ставит реплику ведущей в чат; номер записи (для правки) или 0, если строка не добавлена (пусто/повтор). */
export function pushHostLine(text: string, note = ''): number {
  const clean = text.trim()
  if (!clean || clean === lastHostLine) return 0
  lastHostLine = clean
  const caption = note.trim()
  const stage = stageWordsIn(clean)
  if (stage.length) pushTrace('note', `в речи ведущей служебные слова: ${stage.join(', ')}`)
  pushTrace(
    'chat',
    'Ведущая',
    caption
      ? { role: 'host' satisfies ChatRole, text: clean, note: caption }
      : { role: 'host' satisfies ChatRole, text: clean },
  )
  return sequence
}

/** Стабильный id строки чата для истории конференции: уникален между перезагрузками вкладки мастера. */
const chatSession = Math.random().toString(36).slice(2, 10)
export function chatLineId(entryId: number): string {
  return `${chatSession}-${entryId}`
}

/**
 * Пометка реплики игрока в чате: как модель её поняла. Структурное поле, текст не разбирается.
 * Ответ: stall (заминка), noise (шум), counted (взята как ответ; verdict — вердикт оценки, без него «… оцениваю»),
 * guessing (перебор, не засчитано).
 * Выбор: noise, other (не выбор), cell (дала ячейку), picked (по ней выбрана ячейка); cell — подпись ячейки.
 */
export type ChatMark = { kind: 'stall' | 'noise' | 'counted' | 'guessing' | 'other' | 'cell' | 'picked'; cell?: string; verdict?: JudgmentStatus }

const verdicts: readonly JudgmentStatus[] = ['correct', 'incorrect', 'near_miss', 'needs_clarification', 'ambiguous', 'unintelligible']

export function readChatMark(value: unknown): ChatMark | undefined {
  if (!value || typeof value !== 'object') return undefined
  const kind = (value as { kind?: unknown }).kind
  const cell = (value as { cell?: unknown }).cell
  if (kind !== 'stall' && kind !== 'noise' && kind !== 'counted' && kind !== 'guessing' && kind !== 'other' && kind !== 'cell' && kind !== 'picked') return undefined
  if (cell !== undefined && (typeof cell !== 'string' || cell.length > 120)) return undefined
  const verdict = (value as { verdict?: unknown }).verdict
  if (verdict !== undefined && (kind !== 'counted' || !verdicts.includes(verdict as JudgmentStatus))) return undefined
  return { kind, ...(cell ? { cell } : {}), ...(verdict ? { verdict: verdict as JudgmentStatus } : {}) }
}

/** Цвет бейджа: good — зелёный, bad — красный, close — жёлтый, unsure — серый; null — обычный. */
export type ChatMarkTone = 'good' | 'bad' | 'close' | 'unsure' | 'pending'
export function chatMarkTone(mark: ChatMark): ChatMarkTone | null {
  if (mark.kind !== 'counted') return null
  switch (mark.verdict) {
    case undefined: return 'pending'
    case 'correct': return 'good'
    case 'incorrect': return 'bad'
    case 'near_miss': return 'close'
    default: return 'unsure'
  }
}

/** Короткая подпись пометки для бейджа. */
export function chatMarkLabel(mark: ChatMark): string {
  switch (mark.kind) {
    case 'stall': return 'заминка'
    case 'noise': return 'шум'
    case 'counted': return countedLabel(mark.verdict)
    case 'guessing': return '✗ перебор'
    case 'other': return 'не выбор'
    case 'cell': return mark.cell ? `→ ${mark.cell}` : 'ячейка'
    case 'picked': return mark.cell ? `✓ ${mark.cell}` : '✓'
  }
}

function countedLabel(verdict: JudgmentStatus | undefined): string {
  switch (verdict) {
    case undefined: return '… оцениваю'
    case 'correct': return '✓ верно'
    case 'incorrect': return '✗ неверно'
    case 'near_miss': return '≈ близко'
    case 'needs_clarification': return '? уточнение'
    case 'ambiguous': return '? неоднозначно'
    case 'unintelligible': return '? неразборчиво'
  }
}

/** Кто сейчас говорит (id игрока для подписи реплики); ставит контроллер мастера. null — «Услышано». */
let speakerSource: () => number | null = () => null
export function setPlayerSpeakerSource(source: (() => number | null) | null): void {
  speakerSource = source ?? (() => null)
}

export type ChatLineEdit = { id: string; text: string | null; mark?: ChatMark }
const chatEditListeners = new Set<(edit: ChatLineEdit) => void>()
export function subscribeChatEdits(listener: (edit: ChatLineEdit) => void): () => void {
  chatEditListeners.add(listener)
  return () => chatEditListeners.delete(listener)
}

/**
 * Правка уже показанной строки чата (реплику ведущей оборвали мы): новый текст или null — убрать.
 * Запись меняется на месте (у мастера), конференция получает правку по стабильному id.
 */
export function editChatLine(entryId: number, text: string | null): void {
  const index = snapshot.findIndex((entry) => entry.id === entryId)
  if (index < 0) return
  const entry = snapshot[index]!
  if (entry.kind !== 'chat' || !entry.detail || typeof entry.detail !== 'object') return
  const clean = text?.trim() || null
  const detail = clean ? { ...(entry.detail as object), text: clean } : { ...(entry.detail as object), removed: true }
  const next = snapshot.slice()
  next[index] = { ...entry, detail }
  snapshot = next
  for (const listener of listeners) listener()
  for (const listener of chatEditListeners) listener({ id: chatLineId(entryId), text: clean })
}

export function pushPlayerLine(text: string, itemId?: string | null): void {
  const clean = text.trim()
  if (!clean) return
  const mark = itemId ? pendingMarks.get(itemId) : undefined
  if (itemId) pendingMarks.delete(itemId)
  const speakerId = speakerSource() ?? undefined
  pushTrace('chat', 'Игрок', { role: 'player' satisfies ChatRole, text: clean, ...(speakerId !== undefined ? { speakerId } : {}), ...(itemId ? { itemId } : {}), ...(mark ? { mark } : {}) })
}

/** Пометки, пришедшие раньше самой строки (подпись публикуется после оценки). */
const pendingMarks = new Map<string, ChatMark>()

/**
 * Пометить реплику игрока по item_id реплики: у мастера запись меняется на месте,
 * конференция получает правку строки по стабильному id (гости и история).
 */
export function markPlayerLine(itemId: string | null | undefined, mark: ChatMark): void {
  if (!itemId) return
  let index = -1
  for (let i = snapshot.length - 1; i >= 0; i -= 1) {
    const detail = snapshot[i]!.detail
    if (snapshot[i]!.kind === 'chat' && detail && typeof detail === 'object' && (detail as { itemId?: unknown }).itemId === itemId) { index = i; break }
  }
  if (index < 0) {
    pendingMarks.set(itemId, mark)
    if (pendingMarks.size > 50) pendingMarks.delete(pendingMarks.keys().next().value!)
    return
  }
  const entry = snapshot[index]!
  const detail = { ...(entry.detail as object), mark }
  const next = snapshot.slice()
  next[index] = { ...entry, detail }
  snapshot = next
  for (const listener of listeners) listener()
  const text = (detail as { text?: unknown }).text
  for (const listener of chatEditListeners) listener({ id: chatLineId(entry.id), text: typeof text === 'string' ? text : null, mark })
}

export type LivePlayerLine = { itemId: string; text: string; at: string }
let livePlayerLine: LivePlayerLine | null = null
const liveListeners = new Set<() => void>()

/**
 * Черновик реплики игрока, пока он говорит (input_audio_transcription.delta).
 * Не попадает в trace/историю и не влияет на игру: итог даёт только `.completed`.
 */
export function setLivePlayerLine(itemId: string, text: string): void {
  const clean = text.trim()
  if (!clean) return clearLivePlayerLine(itemId)
  if (livePlayerLine?.itemId === itemId && livePlayerLine.text === clean) return
  livePlayerLine = { itemId, text: clean, at: livePlayerLine?.itemId === itemId ? livePlayerLine.at : new Date().toISOString() }
  for (const listener of liveListeners) listener()
}

/** Без itemId — убрать любой черновик. */
export function clearLivePlayerLine(itemId?: string | null): void {
  if (!livePlayerLine || (itemId && livePlayerLine.itemId !== itemId)) return
  livePlayerLine = null
  for (const listener of liveListeners) listener()
}

export function getLivePlayerLine(): LivePlayerLine | null {
  return livePlayerLine
}

export function subscribeLivePlayerLine(listener: () => void): () => void {
  liveListeners.add(listener)
  return () => liveListeners.delete(listener)
}

export function pushJudgeLine(text: string): void {
  const clean = text.trim()
  if (!clean) return
  pushTrace('chat', 'Оценка', { role: 'judge' satisfies ChatRole, text: clean })
}

/** Видимая ошибка в «Разговоре» (у всех в конференции). Модель её не получает. */
export function pushErrorLine(text: string): void {
  const clean = text.trim()
  if (!clean) return
  pushTrace('chat', 'Ошибка', { role: 'error' satisfies ChatRole, text: clean })
}

/** Короткая служебная строка в «Разговоре» (у всех). Модель её не получает. */
export function pushSystemLine(text: string): void {
  const clean = text.trim()
  if (!clean) return
  pushTrace('chat', 'Техническое', { role: 'system' satisfies ChatRole, text: clean })
}

export function getTrace(): TraceEntry[] {
  return snapshot
}

export function subscribeTrace(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Курсор, с которого новый joiner отправит мастеру небольшой хвост до подключения. */
export function sharedDebugBacklogCursor(entries = 72): number {
  const start = snapshot[Math.max(0, snapshot.length - Math.max(0, entries))]
  return start ? start.id - 1 : sequence
}

/**
 * Возвращает ограниченный по числу и размеру безопасный wire-батч. Детали
 * сериализуются здесь, поэтому по каналу никогда не уходит произвольный объект.
 */
export function sharedDebugBatch(
  afterId: number,
  maxEntries = 24,
  maxChars = 30_000,
): { entries: SharedDebugEntry[]; lastId: number; pending: boolean } {
  const source = snapshot.filter((entry) => entry.id > afterId)
  const entries: SharedDebugEntry[] = []
  let chars = 0
  let lastId = afterId
  for (const entry of source) {
    if (entries.length >= maxEntries) break
    const title = clip(redact(entry.title), 500)
    const rawDetail = entry.detail === undefined ? undefined : safeJson(entry.detail)
    const detail = rawDetail === undefined ? undefined : clip(redact(rawDetail), 4_000)
    const nextChars = entry.at.length + entry.kind.length + title.length + (detail?.length ?? 0)
    if (entries.length > 0 && chars + nextChars > maxChars) break
    entries.push({ at: clip(entry.at, 40), kind: entry.kind, title, ...(detail ? { detail } : {}) })
    chars += nextChars
    lastId = entry.id
  }
  return { entries, lastId, pending: source.some((entry) => entry.id > lastId) }
}

/** Складывает проверенный masterSession лог игрока отдельно от локального trace. */
export function appendRemoteDebug(
  clientId: string,
  name: string,
  entries: readonly SharedDebugEntry[],
): void {
  const safeClientId = clip(redact(clientId), 200)
  if (!safeClientId || entries.length === 0) return
  if (!remoteSnapshot.has(safeClientId) && remoteSnapshot.size >= remoteClientLimit) {
    const oldest = remoteSnapshot.keys().next().value
    if (typeof oldest === 'string') remoteSnapshot.delete(oldest)
  }
  const previous = remoteSnapshot.get(safeClientId)?.entries ?? []
  const safeEntries = entries.map((entry) => ({
    at: clip(redact(entry.at), 40),
    kind: entry.kind,
    title: clip(redact(entry.title), 500),
    ...(entry.detail ? { detail: clip(redact(entry.detail), 4_000) } : {}),
  }))
  const safeName = clip(redact(name), 100) || 'Игрок'
  for (const entry of safeEntries) debugLogStore.push({ source: 'remote', clientId: safeClientId, name: safeName, ...entry })
  remoteSnapshot.set(safeClientId, {
    name: safeName,
    entries: [...previous, ...safeEntries].slice(-remoteEntryLimit),
  })
}

export function clearRemoteDebug(): void {
  remoteSnapshot.clear()
}

export const clearRemoteDebugForTests = clearRemoteDebug

/** Дамп из памяти (кольцо 1500 записей) — запасной путь, если IndexedDB нет. */
export function formatDebugDump(extra: { path: string; context: unknown }, stored?: readonly StoredLogEntry[] | null, storeNote = ''): string {
  const lines = [
    '# AI SI Game debug',
    `exported: ${new Date().toISOString()}`,
    `state: ${extra.path}`,
    `link: connection=${linkStatus.connection} mic=${linkStatus.mic} host=${linkStatus.host}`,
    `log: ${stored ? `IndexedDB, ${stored.length} записей` : 'только память (последние записи)'}${storeNote ? ` · ${storeNote}` : ''}`,
    '',
    '## machine context',
    JSON.stringify(sanitize(extra.context), null, 2),
    '',
    '## trace',
  ]
  const local = stored ? stored.filter((entry) => entry.source === 'local') : snapshot.map((entry) => ({ ...entry, detail: entry.detail === undefined ? undefined : JSON.stringify(entry.detail) }))
  for (const entry of local) {
    lines.push(`${entry.at} ${entry.kind} ${entry.title}`)
    if (entry.detail !== undefined) lines.push(entry.detail)
    lines.push('')
  }
  const remote = new Map<string, { name: string; entries: { at: string; kind: string; title: string; detail?: string }[] }>()
  if (stored) {
    for (const entry of stored) {
      if (entry.source !== 'remote' || !entry.clientId) continue
      const bucket = remote.get(entry.clientId) ?? { name: entry.name ?? 'Игрок', entries: [] }
      bucket.name = entry.name ?? bucket.name
      bucket.entries.push(entry)
      remote.set(entry.clientId, bucket)
    }
  } else {
    for (const [clientId, value] of remoteSnapshot) remote.set(clientId, value)
  }
  if (remote.size > 0) {
    lines.push('## remote player trace', '')
    for (const [clientId, value] of remote) {
      lines.push(`### ${value.name} (${clientId})`)
      for (const entry of value.entries) {
        lines.push(`${entry.at} ${entry.kind} ${entry.title}`)
        if (entry.detail !== undefined) lines.push(entry.detail)
        lines.push('')
      }
    }
  }
  lines.push(`origin: ${pageOrigin() || '—'}`)
  lines.push(`commit: ${buildCommit()}`)
  const perf = perfWatchSummary()
  if (perf) lines.push(perf)
  return lines.join('\n')
}

/** Полный дамп: весь лог партии из IndexedDB (переживает перезагрузку), иначе память. */
export async function formatFullDebugDump(extra: { path: string; context: unknown }): Promise<string> {
  let stored: StoredLogEntry[] | null = null
  try {
    stored = await debugLogStore.readAll()
  } catch {
    stored = null
  }
  return formatDebugDump(extra, stored, debugLogStore.lastError())
}

/** Ключ рядом с логом: какой игре принадлежит полный лог в IndexedDB. */
const debugLogGameKey = 'aisigame.debugLogGame'

export function debugLogGame(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): string {
  try {
    return storage?.getItem(debugLogGameKey) ?? ''
  } catch {
    return ''
  }
}

function setDebugLogGame(gameId: string, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeLocalStorage()): void {
  try {
    if (gameId) storage?.setItem(debugLogGameKey, gameId)
    else storage?.removeItem(debugLogGameKey)
  } catch {
    // нет localStorage — лог просто не помнит свою игру
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Выход: стереть полный лог (тот же цикл жизни, что у снимка партии). */
export function wipeDebugLog(): Promise<void> {
  setDebugLogGame('')
  return debugLogStore.wipe()
}

/** Мастер начинает новую игру: лог всегда с чистого листа и принадлежит ей. */
export function startDebugLogFor(gameId: string): Promise<void> {
  setDebugLogGame(gameId)
  return debugLogStore.wipe()
}

/**
 * Игрок входит в игру: лог стирается, только если он от другой игры.
 * Повторный вход в ту же комнату (перезагрузка) лог сохраняет. true — стёрт.
 */
export function joinDebugLogFor(gameId: string, wipe: () => Promise<void> = () => debugLogStore.wipe()): boolean {
  if (debugLogGame() === gameId) return false
  setDebugLogGame(gameId)
  void wipe()
  return true
}

export type SessionRole = 'мастер' | 'игрок' | 'стол'

/** Запись о входе/старте: роль, игра, имя и сборка — у мастера, игрока и общего стола. */
export function noteSession(info: { role: SessionRole; gameId: string; name: string; resumed?: boolean }): void {
  const commit = buildCommit()
  pushTrace('note', `[сессия] ${info.role}${info.resumed ? ' (продолжение)' : ''}: игра ${info.gameId || '—'}, имя ${info.name || '—'}, сборка ${commit}`, { ...info, commit })
}

export type DownloadDebugResult = { ok: boolean; bytes: number; fileName: string }

/** Имя файла дампа по местному времени: aisigame-debug-2026-10-15_22-55-03.txt. */
export function debugFileName(date = new Date()): string {
  const two = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  const time = `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
  return `aisigame-debug-${day}_${time}.txt`
}

/**
 * Скачивает дамп файлом: Blob + `<a download>` (работает и в Chrome на Android,
 * в отличие от буфера обмена с большим текстом).
 */
export async function downloadDebugDump(extra: { path: string; context: unknown }, now = new Date()): Promise<DownloadDebugResult> {
  const text = await formatFullDebugDump(extra)
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const fileName = debugFileName(now)
  try {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.append(link)
    link.click()
    link.remove()
    // Отзываем не сразу: Android Chrome начинает загрузку асинхронно.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return { ok: true, bytes: blob.size, fileName }
  } catch {
    return { ok: false, bytes: blob.size, fileName }
  }
}

export function formatDebugSize(bytes: number): string {
  const safeBytes = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  const mebibyte = 1024 * 1024
  const value = safeBytes >= mebibyte ? safeBytes / mebibyte : safeBytes / 1024
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  const unit = safeBytes >= mebibyte ? 'МБ' : 'КБ'
  return `~${String(rounded).replace('.', ',')} ${unit}`
}

function sanitize(value: unknown): unknown {
  return sanitizeValue(value, 0)
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(sanitize(value))
  } catch {
    return undefined
  }
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return '[глубина]'
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      if ((key === 'audio' || key === 'delta') && typeof nested === 'string') {
        result[key] = '[audio omitted]'
        continue
      }
      if (/authorization|api[_-]?key|bearer/i.test(key)) {
        result[key] = '[скрыто]'
        continue
      }
      result[key] = sanitizeValue(nested, depth + 1)
    }
    return result
  }
  return undefined
}

function redact(text: string): string {
  return text.replace(/\b(?:sk|ek)[_-][A-Za-z0-9_-]+\b/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]')
}

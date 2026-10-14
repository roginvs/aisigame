import { stageWordsIn } from './stageWords.ts'
import { buildCommit, pageOrigin } from '../buildInfo.ts'

export type TraceKind = 'in' | 'out' | 'state' | 'chat' | 'note'

export type ChatRole = 'host' | 'player' | 'judge'

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

const limit = 1500
const remoteClientLimit = 32
const remoteEntryLimit = 160
let sequence = 0
let snapshot: TraceEntry[] = []
const listeners = new Set<() => void>()
const remoteSnapshot = new Map<string, { name: string; entries: SharedDebugEntry[] }>()
let lastHostLine = ''
let linkStatus = { connection: 'idle', mic: 'idle', host: 'idle' }

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
  console.log(`[aisigame ${entry.at}] ${kind} ${entry.title}`, entry.detail ?? '')
  for (const listener of listeners) listener()
}

export function pushHostLine(text: string, note = ''): boolean {
  const clean = text.trim()
  if (!clean || clean === lastHostLine) return false
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
  return true
}

export function pushPlayerLine(text: string): void {
  const clean = text.trim()
  if (!clean) return
  pushTrace('chat', 'Игрок', { role: 'player' satisfies ChatRole, text: clean })
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
  remoteSnapshot.set(safeClientId, {
    name: clip(redact(name), 100) || 'Игрок',
    entries: [...previous, ...safeEntries].slice(-remoteEntryLimit),
  })
}

export function clearRemoteDebug(): void {
  remoteSnapshot.clear()
}

export const clearRemoteDebugForTests = clearRemoteDebug

export function formatDebugDump(extra: { path: string; context: unknown }): string {
  const lines = [
    '# AI SI Game debug',
    `exported: ${new Date().toISOString()}`,
    `state: ${extra.path}`,
    `link: connection=${linkStatus.connection} mic=${linkStatus.mic} host=${linkStatus.host}`,
    '',
    '## machine context',
    JSON.stringify(sanitize(extra.context), null, 2),
    '',
    '## trace',
  ]
  for (const entry of snapshot) {
    lines.push(`${entry.at} ${entry.kind} ${entry.title}`)
    if (entry.detail !== undefined) lines.push(JSON.stringify(entry.detail))
    lines.push('')
  }
  if (remoteSnapshot.size > 0) {
    lines.push('## remote player trace', '')
    for (const [clientId, remote] of remoteSnapshot) {
      lines.push(`### ${remote.name} (${clientId})`)
      for (const entry of remote.entries) {
        lines.push(`${entry.at} ${entry.kind} ${entry.title}`)
        if (entry.detail !== undefined) lines.push(entry.detail)
        lines.push('')
      }
    }
  }
  lines.push(`origin: ${pageOrigin() || '—'}`)
  lines.push(`commit: ${buildCommit()}`)
  return lines.join('\n')
}

export type CopyDebugResult = { ok: boolean; bytes: number }

export async function copyDebugDump(extra: { path: string; context: unknown }): Promise<CopyDebugResult> {
  const text = formatDebugDump(extra)
  const bytes = new TextEncoder().encode(text).byteLength
  try {
    await navigator.clipboard.writeText(text)
    return { ok: true, bytes }
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '0'
    document.body.append(area)
    area.focus()
    area.select()
    area.setSelectionRange(0, text.length)
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    area.remove()
    return { ok: copied, bytes }
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

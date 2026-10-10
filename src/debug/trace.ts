export type TraceKind = 'in' | 'out' | 'state' | 'chat' | 'note'

export type ChatRole = 'host' | 'player' | 'judge'

export type TraceEntry = {
  id: number
  at: string
  kind: TraceKind
  title: string
  detail?: unknown
}

const limit = 1500
let sequence = 0
let snapshot: TraceEntry[] = []
const listeners = new Set<() => void>()
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
  return lines.join('\n')
}

export async function copyDebugDump(extra: { path: string; context: unknown }): Promise<boolean> {
  const text = formatDebugDump(extra)
  try {
    await navigator.clipboard.writeText(text)
    return true
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
    return copied
  }
}

function sanitize(value: unknown): unknown {
  return sanitizeValue(value, 0)
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return '[глубина]'
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
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
  return text.replace(/\b(?:sk|ek)_[A-Za-z0-9_-]+\b/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]')
}

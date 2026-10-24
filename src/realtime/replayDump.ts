import { qwenTranslateInbound } from './qwenWire.ts'

/** Провод, если события ещё не в форме клиента. Grok совпадает с OpenAI. */
export type ReplayWire = 'openai' | 'qwen' | 'gemini'

const recordHeader = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(in|out|state|chat|note)\s+(.*)$/

function isEvent(value: unknown): value is { type: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return typeof (value as { type?: unknown }).type === 'string'
}

/**
 * Входящие события из дебаг-дампа: секция `## trace`, записи `kind === in`,
 * деталь — JSON-объект с полем `type`. Покадровые `.delta` дамп не хранит;
 * если они всё же попали в текст, здесь отбрасываются.
 * Чужой лог (`## remote player trace`) не берётся.
 */
export function eventsFromDebugDump(dump: string): object[] {
  const lines = dump.split(/\r?\n/)
  const events: object[] = []
  let inTrace = false
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!inTrace) {
      if (line.startsWith('## trace')) inTrace = true
      index += 1
      continue
    }
    if (line.startsWith('## ') || line.startsWith('origin:')) break
    const header = recordHeader.exec(line)
    if (!header) {
      index += 1
      continue
    }
    const kind = header[2]
    const title = header[3] ?? ''
    index += 1
    const detail: string[] = []
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next === '' || recordHeader.test(next) || next.startsWith('## ') || next.startsWith('origin:')) break
      detail.push(next)
      index += 1
    }
    while (index < lines.length && lines[index] === '') index += 1
    if (kind !== 'in' || title.endsWith('.delta')) continue
    const raw = detail.join('\n').trim()
    if (!raw) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isEvent(parsed) || parsed.type.endsWith('.delta')) continue
      events.push(parsed)
    } catch {
      // Заметка или обрезанный JSON — не событие провода.
    }
  }
  return events
}

/**
 * Событие провода → то, что ест клиент.
 * Дамп живой партии уже в этой форме (перевод Qwen/Gemini происходит до записи `in`).
 * `qwen` — сырой DashScope (`text`+`stash`, `response.audio_transcript.*`).
 * `gemini` — то, что уже испустил `geminiWire` (форму OpenAI он собирает сам).
 * null — проводу событие не нужно, клиенту его не отдают.
 */
export function translateReplayInbound(event: object, wire: ReplayWire = 'openai'): object | null {
  if (wire === 'qwen') return qwenTranslateInbound(event)
  return event
}

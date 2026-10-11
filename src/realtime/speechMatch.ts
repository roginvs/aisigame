export function speechMatches(said: string, expected: string): boolean {
  const want = words(expected)
  const heard = words(said)
  if (!want.length) return true
  const heardSet = new Set(heard)
  const hits = want.filter((word) => heardSet.has(word)).length
  if (hits / want.length < 0.75) return false
  return heard.length <= want.length + 4
}

export function verbatimSpeech(text: string): string {
  return text.trim()
}

/** Второй абзац модель играет, но игрокам не читает. */
export const playNoteMark = '\n\nКак сыграть, вслух не читать:\n'

export function withPlayNote(spoken: string, note: string): string {
  const line = spoken.trim()
  const aside = note.trim()
  if (!aside) return line
  return `${line}${playNoteMark}${aside}`
}

/** Текст, который можно сказать. Пометка «как сыграть» сюда не входит. */
export function spokenPayload(cue: string): string {
  const at = cue.indexOf(playNoteMark)
  return (at === -1 ? cue : cue.slice(0, at)).trim()
}

/** Как сыграть. Пусто, если пометки нет. */
export function playNote(cue: string): string {
  const at = cue.indexOf(playNoteMark)
  if (at === -1) return ''
  return cue.slice(at + playNoteMark.length).trim()
}

export function isolatedToolResponse(options: {
  name: string
  instructions: string
  purpose: string
  turn: number
  mode: 'text' | 'audio'
  tools: readonly unknown[]
}) {
  return {
    conversation: 'none' as const,
    output_modalities: [options.mode === 'text' ? 'text' : 'audio'] as ['text'] | ['audio'],
    tool_choice: { type: 'function' as const, name: options.name },
    tools: options.tools,
    metadata: { purpose: options.purpose, turn: String(options.turn) },
    instructions: options.instructions,
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: options.instructions }],
      },
    ],
  }
}

const toneAside =
  'Ремарку, скобки и слова про тон вслух не читай и в скобки не ставь: «смешок», «с лёгким смешком», «хихикаем», «тёплая фраза», «сухая фраза», «в скобках».'

export function isolatedCue(instructions: string, meta: { purpose: string; turn: number; take: number }) {
  const spoken = spokenPayload(instructions)
  const aside = playNote(instructions)
  const performance = aside ? `Как сыграть, этот абзац игрокам не говорить: ${aside}` : ''
  return {
    conversation: 'none' as const,
    output_modalities: ['audio'] as const,
    tool_choice: 'none' as const,
    tools: [] as const,
    metadata: { purpose: meta.purpose, turn: String(meta.turn), take: String(meta.take) },
    instructions: [
      'Ты ведущая. По сообщению ниже скажи игрокам короткую реплику своими словами, без предисловия и без пересказа задания. Не объявляй, что сейчас что-то произнесёшь. Если сообщение прямо не просит произнести эталон пакета, не произноси правильный ответ и не вспоминай его из других знаний. Не повторяй вопрос.',
      toneAside,
      performance,
    ]
      .filter(Boolean)
      .join(' '),
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: spoken }],
      },
    ],
  }
}

export function verbatimResponse(text: string, meta: { purpose: string; turn: number; take: number }) {
  return {
    conversation: 'none' as const,
    output_modalities: ['audio'] as const,
    tool_choice: 'none' as const,
    tools: [] as const,
    metadata: { purpose: meta.purpose, turn: String(meta.turn), take: String(meta.take) },
    instructions:
      'Ты ведущая и сейчас говоришь игрокам. Сообщение ниже — готовая фраза: сам вопрос или уже принятая реплика. Начни сразу с этой фразы и скажи только её, символ в символ. Не объявляй тему и номинал. Не говори, что ячейка выбрана. Не добавляй «вопрос», «отлично» и ничего до или после.',
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text }],
      },
    ],
  }
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3)
}

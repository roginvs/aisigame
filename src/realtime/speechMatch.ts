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
  return `Произнеси дословно только эту фразу. Это уже вопрос.\nНе говори, что тема выбрана. Не называй тему и номинал. Не добавляй слово «вопрос» перед фразой.\n${text}`
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

export function isolatedCue(instructions: string, meta: { purpose: string; turn: number; take: number }) {
  return {
    conversation: 'none' as const,
    output_modalities: ['audio'] as const,
    tool_choice: 'none' as const,
    tools: [] as const,
    metadata: { purpose: meta.purpose, turn: String(meta.turn), take: String(meta.take) },
    instructions:
      'Сразу скажи игрокам то, что в реплике, без предисловия. Не пересказывай задание и не говори, что сейчас что-то произнесёшь. Если в реплике нет правильного ответа, не произноси его и не вспоминай его из других знаний. Не повторяй вопрос.',
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: instructions }],
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
      'Повтори фразу пользователя дословно и сразу с неё начни. Это уже текст вопроса. Не говори, что тема или ячейка выбрана. Не называй тему и номинал. Не добавляй «вопрос», «отлично» и никакой другой текст до или после.',
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: `Скажи вслух ровно эту фразу и больше ничего: ${text}` }],
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

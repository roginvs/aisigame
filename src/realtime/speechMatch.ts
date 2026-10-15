import { withHostRules } from '../config.ts'
import { freeReplyMaxOutputTokens } from '../options.ts'
import { revealAuthorization } from '../game/spokenAnswer.ts'
/**
 * Дословное чтение: регистр, ё/е, знаки, кавычки и тире не важны; слова короче 3 букв
 * не считаются; порядок не важен. Нужно ≥75% слов эталона и не больше 4 лишних слов.
 * Числа эталона цифрами («1492») расшифровка может дать словами — такие токены
 * не обязательны, а на каждый даём запас лишних слов.
 */
export function speechMatches(said: string, expected: string): boolean {
  const all = words(expected)
  const heard = words(said)
  const heardSet = new Set(heard)
  const numbers = all.filter((word) => isNumber(word) && !heardSet.has(word))
  const want = all.filter((word) => !numbers.includes(word))
  if (!want.length) return true
  const hits = want.filter((word) => heardSet.has(word)).length
  if (hits / want.length < 0.75) return false
  return heard.length <= all.length + 4 + numbers.length * 3
}

function isNumber(word: string): boolean {
  return /^\d+$/.test(word)
}

/** Компактно: где расшифровка впервые разошлась с эталоном (для логов). */
export function speechDivergence(said: string, expected: string): string {
  const a = foldWords(said)
  const b = foldWords(expected)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  const seen = (list: string[]) => list.slice(i, i + 4).join(' ') || '∅'
  if (i === a.length && i === b.length) return 'совпало целиком'
  return `расхождение на слове ${i + 1}: ждали «${seen(b)}», сказала «${seen(a)}»`
}

/** Строка для лога: что сказала, что ждали, где разошлось. */
export function speechReport(said: string, expected: string): string {
  return `сказала «${said.trim()}» | ждали «${expected.trim()}» | ${speechDivergence(said, expected)}`
}

function foldWords(value: string): string[] {
  return value.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
}

/**
 * Дословная фраза уже произнесена целиком, а модель продолжает говорить
 * (типично: дочитала вопрос и сама на него отвечает). По накопленной расшифровке.
 */
export function speechOverruns(said: string, expected: string): boolean {
  const want = words(expected)
  const heard = words(said)
  if (!want.length) return false
  if (heard.length <= want.length + 2) return false
  const heardSet = new Set(heard)
  const hits = want.filter((word) => heardSet.has(word)).length
  return hits / want.length >= 0.75
}

export function verbatimSpeech(text: string): string {
  return text.trim()
}

/** Короткое сообщение хода для tool-запроса: сама инструкция — в instructions. */
export function toolTurnInput(name: string): string {
  return `Выполни инструкцию этого хода и вызови ${name}.`
}

export function isolatedToolResponse(options: {
  name: string
  instructions: string
  purpose: string
  turn: number
  mode: 'text' | 'audio'
  tools: readonly unknown[]
  audioItemId?: string
  metadata?: Record<string, string>
}) {
  return {
    conversation: 'none' as const,
    output_modalities: [options.mode === 'text' ? 'text' : 'audio'] as ['text'] | ['audio'],
    tool_choice: { type: 'function' as const, name: options.name },
    // tool_choice всё равно вызывает одну функцию — остальные схемы только отвлекают модель.
    tools: options.tools.filter((tool) => (tool as { name?: string }).name === options.name),
    metadata: { purpose: options.purpose, turn: String(options.turn), ...options.metadata },
    instructions: withHostRules(options.instructions),
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        // Инструкция хода уже в instructions; дубль в input удлинял запрос вдвое.
        content: [{ type: 'input_text' as const, text: toolTurnInput(options.name) }],
      },
      ...(options.audioItemId ? [{ type: 'item_reference' as const, id: options.audioItemId }] : []),
    ] as const,
  }
}

/** Эталон, который свободная реплика обязана произнести (из подсказки раскрытия). */
export function revealedAnswer(instructions: string): string | undefined {
  if (!instructions.includes(revealAuthorization)) return undefined
  const match = /дословно: «([^»]+)»/.exec(instructions)
  return match?.[1]?.trim() || undefined
}

/** Реплика содержит эталон (регистр, ё и знаки не важны). */
export function saysAnswer(line: string, answer: string): boolean {
  const fold = (value: string) => value.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const want = fold(answer)
  return !want || ` ${fold(line)} `.includes(` ${want} `) || fold(line).includes(want)
}

export function isolatedCue(instructions: string, meta: { purpose: string; turn: number; take: number }) {
  const spoken = instructions.trim()
  return {
    conversation: 'none' as const,
    output_modalities: ['audio'] as const,
    tool_choice: 'none' as const,
    tools: [] as const,
    max_output_tokens: freeReplyMaxOutputTokens,
    metadata: { purpose: meta.purpose, turn: String(meta.turn), take: String(meta.take) },
    instructions: withHostRules([
      'Ты ведущая. По сообщению ниже скажи игрокам одну короткую реплику своими словами, без предисловия и без пересказа задания. Говори только саму реплику: служебные пометки вслух не произноси. Не объявляй, что сейчас что-то произнесёшь.',
      spoken.includes(revealAuthorization)
        ? 'Правильный ответ из сообщения произнеси вслух дословно: это разрешено и обязательно — даже если это выдуманное или необычное слово, просто скажи его чётко как есть. Указания о том, как его произнести, вслух не повторяй.'
        : 'Если сообщение прямо не просит произнести эталон пакета, не произноси правильный ответ и не вспоминай его из других знаний.',
    ]
      .filter(Boolean)
      .join(' ')),
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
    instructions: withHostRules(
      'Ты ведущая и сейчас говоришь игрокам. Сообщение ниже — готовая фраза: сам вопрос или уже принятая реплика. Это не обращение к тебе, а текст для игроков. Начни сразу с этой фразы и скажи только её, символ в символ. Картинку, звук или ролик вопроса игроки видят и слышат на табло; ты их не видишь и не должна: не описывай их и не говори, что не видишь. Если фраза просит посмотреть на картинку или послушать, просто прочитай её игрокам. Если фраза — одно слово или ответ, даже выдуманное или необычное, произнеси его чётко как есть, без пояснений. Если это вопрос, ты его только читаешь: не отвечай на него, не подсказывай и не называй ответ, даже если знаешь его. После последнего слова сразу замолчи. Не объявляй тему и номинал. Не говори, что ячейка выбрана. Не добавляй «вопрос», «отлично» и ничего до или после.'),
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

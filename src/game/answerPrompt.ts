const transcriptionPromptMax = 1024

export const answerListeningLead =
  'Игрок называет ответ. Может сказать редкое или выдуманное слово или разбить его на слоги.'

const answerListMark = 'Возможные ответы:'

/** Подсказка распознавания, пока после кнопки слушают ответ. Без текста вопроса и без тем. */
export function answerListeningPrompt(answers: readonly string[]): string {
  const lines = uniqueLines(answers)
  if (!lines.length) return 'Игрок отвечает на вопрос викторины по-русски.'
  const head = `${answerListeningLead} ${answerListMark}`
  const picked: string[] = []
  for (const line of lines) {
    if (formatPrompt(head, [...picked, line]).length > transcriptionPromptMax) break
    picked.push(line)
  }
  if (picked.length) return formatPrompt(head, picked)
  const room = Math.max(1, transcriptionPromptMax - `${head} «».`.length)
  return formatPrompt(head, [lines[0]!.slice(0, room)])
}

/** Расшифровка повторяет подсказку ответов, а не слово, которое сказал игрок. */
export function echoesAnswerPrompt(transcript: string, prompt: string): boolean {
  const markAt = prompt.indexOf(answerListMark)
  if (markAt < 0) return false
  const said = canon(transcript)
  const hint = canon(prompt)
  if (!said || !hint) return false
  const bodies = listedAnswers(prompt)
  if (bodies.includes(said)) return false
  if (said === hint) return true
  const list = canon(prompt.slice(markAt + answerListMark.length))
  if (list && said === list) return true
  const lead = canon(prompt.slice(0, markAt))
  if (lead.length >= 16 && (said === lead || said.startsWith(lead))) return true
  if (lead.length >= 16 && lead.startsWith(said) && said.length >= 16) return true
  if (said.includes(canon(answerListMark))) return true
  return false
}

function formatPrompt(head: string, lines: string[]): string {
  return `${head} ${lines.map((line) => `«${line}»`).join(' / ')}.`
}

function uniqueLines(answers: readonly string[]): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const answer of answers) {
    const clean = answer.replace(/[«»]/g, ' ').replace(/\s+/g, ' ').trim()
    const key = canon(clean)
    if (!key || seen.has(key)) continue
    seen.add(key)
    lines.push(clean)
  }
  return lines
}

function listedAnswers(prompt: string): string[] {
  const markAt = prompt.indexOf(answerListMark)
  if (markAt < 0) return []
  return prompt
    .slice(markAt + answerListMark.length)
    .split(' / ')
    .map((part) => canon(part))
    .filter(Boolean)
}

function canon(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

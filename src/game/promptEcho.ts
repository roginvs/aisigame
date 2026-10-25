/**
 * Расшифровка дословно повторила подсказку распознавателю, а не речь игрока.
 * Только точное или почти точное совпадение всего текста подсказки: никаких порогов
 * «названо три темы — значит эхо», чтобы честное «Реки, Кино, Космос… Космос двести» проходило.
 */
export function echoesTranscriptionPrompt(transcript: string, prompt: string): boolean {
  return literalRepeat(canon(transcript), canon(prompt))
}

/** Почти дословно: одна строка содержит другую, и короткая не меньше 85% длинной. */
export function literalRepeat(said: string, hint: string): boolean {
  if (!said || !hint) return false
  if (said === hint) return true
  const [short, long] = said.length <= hint.length ? [said, hint] : [hint, said]
  return short.length >= 12 && long.includes(short) && short.length >= long.length * 0.85
}

export function canon(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Расшифровка равна последней фразе, уже закрытой до кнопки, или только продолжает её.
 * Хвост — то, что сказано после этой фразы. Короткая фраза не режется: иначе «да» съест ответ.
 */
export function cutGluedPhrase(transcript: string, phrase: string): { prefix: string; tail: string } | null {
  const prior = canon(phrase)
  const full = canon(transcript)
  if (prior.length < 8 || !full) return null
  if (full !== prior && !full.startsWith(`${prior} `)) return null
  let end = -1
  for (let index = 0; index < transcript.length; index += 1) {
    if (canon(transcript.slice(0, index + 1)) === prior) end = index + 1
  }
  if (end < 0) return null
  const prefix = transcript.slice(0, end).trim()
  const tail = transcript.slice(end).replace(/^[\s,.;:!?…—\-–]+/u, '').trim()
  return canon(prefix) === prior ? { prefix, tail } : null
}

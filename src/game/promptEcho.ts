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

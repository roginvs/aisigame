/** Расшифровка повторила текущую подсказку Whisper (в т.ч. buzz/reading), а не речь игрока. */
export function echoesTranscriptionPrompt(transcript: string, prompt: string): boolean {
  const said = canon(transcript)
  const hint = canon(prompt)
  if (!said || !hint) return false
  if (said === hint) return true
  if (hint.length >= 20 && said.startsWith(hint)) return true
  if (said.length >= 20 && hint.startsWith(said)) return true
  if (hint.length >= 40 && said.length >= 40 && (said.includes(hint) || hint.includes(said))) return true
  return false
}

function canon(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

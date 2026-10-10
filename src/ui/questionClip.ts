/** Звук и ролик вопроса. Пауза сохраняет позицию: следующий play продолжает с того же места. */
export function questionClipPlaying(input: {
  path: string
  missedCount: number
  held: boolean
  finalRound: boolean
}): boolean {
  if (input.held || reading(input.path)) return false
  if (input.finalRound) return true
  if (input.missedCount > 0) return false
  return input.path.startsWith('buzzing') || input.path === 'falseStartCue'
}

function reading(path: string): boolean {
  return path === 'reading' || path.startsWith('reading.')
}

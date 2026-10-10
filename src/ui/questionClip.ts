/**
 * Звук и ролик вопроса. Пока клип должен играть, он сам стартует и крутится.
 * Пауза снимает цикл и сохраняет позицию: следующий play продолжает с того же места.
 */
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

type ClipNode = {
  loop: boolean
  play: () => Promise<void> | void
  pause: () => void
}

/** Включает цикл вместе с воспроизведением. На паузе цикл снимается, currentTime не меняется. */
export function applyQuestionClip(node: ClipNode, live: boolean): void {
  node.loop = live
  if (!live) {
    node.pause()
    return
  }
  const started = node.play()
  if (started) void started.catch(() => undefined)
}

export const SPEAKING_LEVEL = 0.025
export const SPEAKING_HOLD_MS = 600

export type SpeakerActivity = {
  note: (participantId: string, level: number) => void
  clear: (participantId: string) => void
  has: (participantId: string) => boolean
  dispose: () => void
}

/** Сглаживает редкие уровни Jitsi, чтобы рамка не дёргалась между аудиокадрами. */
export function createSpeakerActivity(onChange: () => void): SpeakerActivity {
  const speaking = new Set<string>()
  const timers = new Map<string, number>()

  function clear(participantId: string): void {
    const timer = timers.get(participantId)
    if (timer !== undefined) window.clearTimeout(timer)
    timers.delete(participantId)
    if (speaking.delete(participantId)) onChange()
  }

  return {
    note(participantId, level) {
      if (!participantId || !Number.isFinite(level) || level < SPEAKING_LEVEL) return
      if (!speaking.has(participantId)) {
        speaking.add(participantId)
        onChange()
      }
      const previous = timers.get(participantId)
      if (previous !== undefined) window.clearTimeout(previous)
      timers.set(
        participantId,
        window.setTimeout(() => clear(participantId), SPEAKING_HOLD_MS),
      )
    },
    clear,
    has: (participantId) => speaking.has(participantId),
    dispose() {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
      speaking.clear()
    },
  }
}

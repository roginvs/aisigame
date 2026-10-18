const LEVEL_THRESHOLD = 0.05
/** Сколько речи подряд считается ответом без кнопки. */
const SUSTAIN_MS = 1000
/** Пауза, которая рвёт счёт речи и открывает новую реплику (короткие — не рвут). */
const GAP_MS = 450

type SpeechState = { since: number; last: number; fired: boolean }

/**
 * Устойчивая речь участника по уровням Jitsi (кадры раз в 200 мс): слово-другое, кашель
 * и стук не считаются. Реплика — одно уведомление; тишина дольше `gapMs` открывает новое.
 */
export function createSpeechLevels(
  onEpisode: (participantId: string) => void,
  now: () => number = Date.now,
): {
  note: (participantId: string, level: number) => void
  clear: (participantId: string) => void
  dispose: () => void
} {
  const running = new Map<string, SpeechState>()

  return {
    note(participantId, level) {
      if (!participantId) return
      const nowMs = now()
      const previous = running.get(participantId)
      if (!Number.isFinite(level) || level <= 0 || (level < LEVEL_THRESHOLD && (!previous || nowMs - previous.last > GAP_MS))) {
        if (previous) running.delete(participantId)
        return
      }
      if (level < LEVEL_THRESHOLD) {
        // Короткая пауза в речи: счёт продолжается, но не начавшийся — тишина не создаёт реплику.
        if (!previous) return
        running.set(participantId, { since: previous.since, last: nowMs, fired: previous.fired })
        return
      }
      const entry: SpeechState = previous && nowMs - previous.last <= GAP_MS
        ? { since: previous.since, last: nowMs, fired: previous.fired }
        : { since: nowMs, last: nowMs, fired: false }
      running.set(participantId, entry)
      if (!entry.fired && nowMs - entry.since >= SUSTAIN_MS) {
        entry.fired = true
        running.set(participantId, entry)
        onEpisode(participantId)
      }
    },
    clear: (participantId) => {
      running.delete(participantId)
    },
    dispose: () => {
      running.clear()
    },
  }
}

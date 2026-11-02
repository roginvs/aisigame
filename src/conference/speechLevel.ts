const LEVEL_THRESHOLD = 0.05
/**
 * Ниже этого RMS шина модели — не речь. Тот же пол, что у битого клона:
 * Jitsi уже громкий, а в миксе тише 0,02 — модель эту речь не получила.
 */
export const modelStreamSpeechRms = 0.02
/** Сколько речи подряд считается ответом без кнопки. */
const SUSTAIN_MS = 1000
/** Пауза, которая рвёт счёт речи и открывает новую реплику (короткие — не рвут). */
const GAP_MS = 450

type SpeechState = { since: number; last: number; fired: boolean }

/**
 * Устойчивая речь участника по уровням Jitsi (кадры раз в 200 мс): слово-другое, кашель
 * и стук не считаются. Реплика — одно уведомление в начале; `onEpisodeEnd` приходит один раз
 * в конце реплики (тишина дольше порога) с длительностью от первого звукового кадра —
 * это запасной источник «реплика закончилась» для commit, когда модельная VAD молчит.
 */
export function createSpeechLevels(
  onEpisode: (participantId: string) => void,
  now: () => number = Date.now,
  onEpisodeEnd: (participantId: string, durationMs: number) => void = () => {},
  threshold = LEVEL_THRESHOLD,
): {
  note: (participantId: string, level: number) => void
  clear: (participantId: string) => void
  dispose: () => void
} {
  const running = new Map<string, SpeechState>()

  const finish = (participantId: string, entry: SpeechState): void => {
    // Длительность реплики — от первого до последнего звукового кадра; хвост тишины до разрыва не в счёт.
    if (entry.fired) onEpisodeEnd(participantId, Math.max(0, entry.last - entry.since))
  }

  return {
    note(participantId, level) {
      if (!participantId) return
      const nowMs = now()
      const previous = running.get(participantId)
      if (!Number.isFinite(level) || level <= 0 || (level < threshold && (!previous || nowMs - previous.last > GAP_MS))) {
        if (previous) {
          running.delete(participantId)
          finish(participantId, previous)
        }
        return
      }
      if (level < threshold) {
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
      const finished = running.get(participantId)
      if (!finished) return
      running.delete(participantId)
      finish(participantId, finished)
    },
    dispose: () => {
      running.clear()
    },
  }
}

/**
 * Конец речи по шине, которая уходит в модель. Чужие уровни сюда не кладут:
 * их в шине нет, поэтому они commit не открывают.
 */
export function createModelStreamSpeech(
  onStart: () => void,
  onEnd: (durationMs: number) => void,
  now: () => number = Date.now,
): { noteBus: (rms: number) => void; dispose: () => void } {
  const levels = createSpeechLevels(() => onStart(), now, (_id, durationMs) => onEnd(durationMs), modelStreamSpeechRms)
  return {
    noteBus(rms: number) {
      levels.note('model', rms)
    },
    dispose() {
      levels.dispose()
    },
  }
}

/** Jitsi уже слышит участника фокуса, а шина модели ещё тихая: клон не донёс речь. */
export function streamSilentWhileJitsiHears(input: {
  inFocus: boolean
  jitsiLevel: number
  busRms: number
  speakingLevel: number
  streamFloor: number
}): boolean {
  return input.inFocus && input.jitsiLevel >= input.speakingLevel && input.busRms < input.streamFloor
}

export function brokenCloneHearLine(name: string, participantId: string, durationMs: number): string {
  const who = name.trim() || 'без имени'
  const ms = Math.max(0, Math.round(durationMs))
  return `техническое: Jitsi слышит речь ${who} (${participantId}), ${ms} мс, а в потоке модели тишина — битый клон`
}

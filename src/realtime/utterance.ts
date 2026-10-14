export type HeardLine = { text: string; arrived: boolean; confidence: number | null }

export type StoredTranscript = { text: string; confidence: number | null }

export function transcriptOf(
  itemId: string | null,
  stored: ReadonlyMap<string, StoredTranscript>,
): HeardLine | null {
  if (!itemId || !stored.has(itemId)) return null
  const line = stored.get(itemId)
  return { text: line?.text ?? '', arrived: true, confidence: line?.confidence ?? null }
}

/** Минимальная вероятность токена с буквой или цифрой. Пробелы и знаки не считаются. */
export function transcriptionConfidence(logprobs: unknown): number | null {
  if (!Array.isArray(logprobs)) return null
  const probs: number[] = []
  for (const item of logprobs) {
    if (!item || typeof item !== 'object') continue
    const token = 'token' in item && typeof item.token === 'string' ? item.token : ''
    const logprob = 'logprob' in item && typeof item.logprob === 'number' ? item.logprob : null
    if (logprob === null || !Number.isFinite(logprob) || !/[a-zа-яё0-9]/i.test(token)) continue
    probs.push(Math.exp(logprob))
  }
  if (!probs.length) return null
  return Math.min(...probs)
}

/** Длительность речи по `audio_start_ms`/`audio_end_ms`; иначе по времени прихода событий. */
export function speechDurationMs(audioStartMs: unknown, audioEndMs: unknown, startedAt: number | null, now: number): number {
  if (typeof audioStartMs === 'number' && typeof audioEndMs === 'number' && audioEndMs >= audioStartMs) {
    return Math.round(audioEndMs - audioStartMs)
  }
  return startedAt === null ? 10_000 : Math.round(now - startedAt)
}

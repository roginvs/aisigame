export function remainingFraction(startedAt: number, durationMs: number, now: number): number {
  if (!(durationMs > 0) || !Number.isFinite(startedAt) || !Number.isFinite(now)) return 0
  return Math.min(1, Math.max(0, (startedAt + durationMs - now) / durationMs))
}

export function remainingSeconds(startedAt: number, durationMs: number, now: number): number {
  if (!(durationMs > 0) || !Number.isFinite(startedAt) || !Number.isFinite(now)) return 0
  return Math.max(0, Math.ceil((startedAt + durationMs - now) / 1000))
}

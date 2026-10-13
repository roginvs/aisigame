/** Local active-time budgets. XState still owns the judging timeout and score. */
export class JudgmentClock {
  private pausedAt: number | null = null
  private pausedMs = 0
  private startedAt = performance.now()
  private deadlineAt: number
  private timers = new Set<{ remaining: number; armedAt: number; timer?: ReturnType<typeof setTimeout>; fire: () => void }>()
  private resumed = new Set<() => void>()
  private stopped = false

  private totalMs: number
  readonly signal: AbortSignal
  constructor(totalMs: number, signal: AbortSignal) {
    this.totalMs = totalMs
    this.signal = signal
    this.deadlineAt = this.startedAt + totalMs
    signal.addEventListener('abort', () => {
      this.stopped = true
      for (const job of this.timers) { if (job.timer !== undefined) clearTimeout(job.timer); job.fire() }
      this.timers.clear()
      for (const wake of [...this.resumed]) wake()
    }, { once: true })
  }

  elapsed(): number { return (this.pausedAt ?? performance.now()) - this.startedAt - this.pausedMs }
  remaining(): number { return Math.max(0, this.deadlineAt - (this.pausedAt ?? performance.now())) }
  pause(): void {
    if (this.pausedAt !== null || this.stopped) return
    this.pausedAt = performance.now()
    for (const job of this.timers) {
      if (job.timer !== undefined) clearTimeout(job.timer)
      job.remaining = Math.max(0, job.remaining - (this.pausedAt - job.armedAt))
      job.timer = undefined
    }
  }
  resume(): void {
    if (this.pausedAt === null || this.stopped) return
    this.pausedMs += performance.now() - this.pausedAt
    this.pausedAt = null
    // Existing machine reenters judging and grants the full judgeMs on RESUME.
    this.deadlineAt = performance.now() + this.totalMs
    for (const job of this.timers) this.arm(job)
    for (const wake of [...this.resumed]) wake()
    this.resumed.clear()
  }
  async active(): Promise<void> {
    if (this.stopped) throw new Error('cancelled')
    if (this.pausedAt !== null) await new Promise<void>((resolve) => this.resumed.add(resolve))
    if (this.stopped) throw new Error('cancelled')
  }
  async within<T>(task: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    await this.active()
    if (this.signal.aborted) throw new Error('cancelled')
    if (ms <= 0) throw new Error('budget-timeout')
    const child = new AbortController()
    let job: { remaining: number; armedAt: number; timer?: ReturnType<typeof setTimeout>; fire: () => void } | undefined
    const abort = () => child.abort()
    this.signal.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([
        task(child.signal),
        new Promise<never>((_, reject) => {
          job = { remaining: Math.max(0, ms), armedAt: performance.now(), fire: () => {
            reject(new Error(this.stopped ? 'cancelled' : 'budget-timeout'))
            child.abort()
          } }
          this.timers.add(job)
          this.arm(job)
        }),
      ])
    } finally {
      child.abort()
      this.signal.removeEventListener('abort', abort)
      if (job) { if (job.timer !== undefined) clearTimeout(job.timer); this.timers.delete(job) }
    }
  }
  private arm(job: { remaining: number; armedAt: number; timer?: ReturnType<typeof setTimeout>; fire: () => void }): void {
    job.armedAt = performance.now()
    job.timer = setTimeout(job.fire, job.remaining)
  }
}

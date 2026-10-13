import { afterEach, describe, expect, it, vi } from 'vitest'
import { JudgmentClock } from './judgmentClock.ts'
describe('judging budgets', () => {
  afterEach(() => vi.useRealTimers())
  it('pauses the request budget, but resumes the full XState judging window', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const clock = new JudgmentClock(20_000, abort.signal)
    const result = clock.within(() => new Promise(() => {}), 1500).catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(500)
    clock.pause()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(clock.elapsed()).toBe(500)
    clock.resume()
    expect(clock.remaining()).toBe(20_000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('budget-timeout')
  })
  it('holds progression while paused and releases on abort', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const clock = new JudgmentClock(20_000, abort.signal)
    clock.pause()
    let ran = false
    const result = clock.within(async () => { ran = true; return 1 }, 100).catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ran).toBe(false)
    abort.abort()
    expect(await result).toBe('cancelled')
  })
})

it('never sends a request after its budget is exhausted', async () => {
  const clock = new JudgmentClock(20_000, new AbortController().signal)
  const send = vi.fn(async () => 1)
  await expect(clock.within(send, 0)).rejects.toThrow('budget-timeout')
  expect(send).not.toHaveBeenCalled()
})

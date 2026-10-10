import { describe, expect, it } from 'vitest'
import { remainingFraction, remainingSeconds } from './timerFraction.ts'

const startedAt = 1_000_000
const durationMs = 10_000

describe('remainingFraction', () => {
  it('starts full and empties at the end of the phase', () => {
    expect(remainingFraction(startedAt, durationMs, startedAt)).toBe(1)
    expect(remainingFraction(startedAt, durationMs, startedAt + 2_500)).toBe(0.75)
    expect(remainingFraction(startedAt, durationMs, startedAt + durationMs)).toBe(0)
  })

  it('stays empty after time is up and full if the clock has not started', () => {
    expect(remainingFraction(startedAt, durationMs, startedAt + durationMs + 40)).toBe(0)
    expect(remainingFraction(startedAt, durationMs, startedAt - 20)).toBe(1)
  })

  it('does not treat a missing duration as a full bar', () => {
    expect(remainingFraction(startedAt, 0, startedAt)).toBe(0)
    expect(remainingFraction(startedAt, -1, startedAt)).toBe(0)
  })
})

describe('remainingSeconds', () => {
  it('rounds the leftover time up to a whole second', () => {
    expect(remainingSeconds(startedAt, durationMs, startedAt)).toBe(10)
    expect(remainingSeconds(startedAt, durationMs, startedAt + 9_001)).toBe(1)
    expect(remainingSeconds(startedAt, durationMs, startedAt + durationMs)).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeakerActivity, SPEAKING_HOLD_MS, SPEAKING_LEVEL } from './speakerActivity.ts'

describe('createSpeakerActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('ignores background noise, lights a speaker and holds the frame between samples', () => {
    const changed = vi.fn()
    const activity = createSpeakerActivity(changed)

    activity.note('host', SPEAKING_LEVEL / 2)
    expect(activity.has('host')).toBe(false)
    activity.note('host', SPEAKING_LEVEL)
    expect(activity.has('host')).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(SPEAKING_HOLD_MS - 100)
    activity.note('host', SPEAKING_LEVEL * 2)
    vi.advanceTimersByTime(SPEAKING_HOLD_MS - 1)
    expect(activity.has('host')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(activity.has('host')).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

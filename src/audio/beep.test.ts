import { afterEach, describe, expect, it, vi } from 'vitest'
import { buzzerBeepMs, buzzerWarningMs, falseStartMs } from '../options.ts'

describe('playTimeoutBeep', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('sounds for one second', async () => {
    const stops: number[] = []
    const now = 4
    class FakeParam {
      setValueAtTime() {}
      exponentialRampToValueAtTime() {}
    }
    class FakeNode {
      frequency = new FakeParam()
      gain = new FakeParam()
      connect() {
        return this
      }
      start() {}
      stop(when: number) {
        stops.push(when)
      }
    }
    vi.stubGlobal(
      'AudioContext',
      class {
        currentTime = now
        destination = {}
        resume() {}
        createOscillator() {
          return new FakeNode()
        }
        createGain() {
          return new FakeNode()
        }
      },
    )

    const { playTimeoutBeep, unlockAudio } = await import('./beep.ts')
    unlockAudio()
    playTimeoutBeep()

    expect(buzzerBeepMs).toBe(1_000)
    expect(stops).toEqual([now + 1])
    expect(buzzerWarningMs).toBe(2_000)
    expect(falseStartMs).toBe(2_500)
  })
})

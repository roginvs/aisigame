import { afterEach, describe, expect, it, vi } from 'vitest'
import { buzzerBeepMs, buzzerWarningMs, falseStartMs } from '../options.ts'

describe('playTimeoutBeep', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('пи-пи-пи: три коротких гудка внутри секунды, контекст сам открывается', async () => {
    const spans: Array<{ start: number; stop: number }> = []
    const now = 4
    let constructed = 0
    let resumes = 0
    class FakeParam {
      value = 0
      setValueAtTime() {}
      linearRampToValueAtTime() {}
      exponentialRampToValueAtTime() {}
    }
    class FakeNode {
      type = 'sine'
      frequency = new FakeParam()
      gain = new FakeParam()
      private startedAt = 0
      connect() {
        return this
      }
      start(when: number) {
        this.startedAt = when
      }
      stop(when: number) {
        spans.push({ start: this.startedAt, stop: when })
      }
    }
    vi.stubGlobal(
      'AudioContext',
      class {
        state: AudioContextState = 'suspended'
        currentTime = now
        destination = {}
        constructor() {
          constructed += 1
        }
        resume() {
          resumes += 1
          this.state = 'running'
        }
        createOscillator() {
          return new FakeNode()
        }
        createGain() {
          return new FakeNode()
        }
      },
    )

    const { playTimeoutBeep } = await import('./beep.ts')
    playTimeoutBeep()

    expect(constructed).toBe(1)
    expect(resumes).toBe(1)
    expect(buzzerBeepMs).toBe(1_000)
    expect(spans).toHaveLength(3)
    expect(spans[0]!.start).toBeCloseTo(now)
    for (const span of spans) {
      expect(span.stop - span.start).toBeGreaterThan(0.05)
      expect(span.stop - span.start).toBeLessThan(0.15)
      expect(span.stop).toBeLessThanOrEqual(now + buzzerBeepMs / 1000)
    }
    expect(spans[1]!.start - spans[0]!.stop).toBeGreaterThan(0.04)
    expect(spans[2]!.start - spans[1]!.stop).toBeGreaterThan(0.04)
    expect(spans[2]!.stop - spans[0]!.start).toBeLessThanOrEqual(1)
    expect(buzzerWarningMs).toBe(2_000)
    expect(falseStartMs).toBe(2_500)
  })

  it('повторный сигнал идёт в уже открытый контекст', async () => {
    let constructed = 0
    class FakeParam {
      value = 0
      setValueAtTime() {}
      linearRampToValueAtTime() {}
    }
    class FakeNode {
      type = 'sine'
      frequency = new FakeParam()
      gain = new FakeParam()
      connect() {
        return this
      }
      start() {}
      stop() {}
    }
    vi.stubGlobal(
      'AudioContext',
      class {
        state: AudioContextState = 'running'
        currentTime = 1
        destination = {}
        constructor() {
          constructed += 1
        }
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
    playTimeoutBeep()
    expect(constructed).toBe(1)
  })
})

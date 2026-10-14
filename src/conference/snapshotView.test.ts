import { beforeEach, describe, expect, it } from 'vitest'
import { TIMER_RESYNC_THRESHOLD_MS } from '../options.ts'
import type { ConferenceSnapshot } from './messages.ts'
import { anchoredPhaseStart, resetTimerAnchor } from './snapshotView.ts'

const snap = (over: Partial<ConferenceSnapshot>): ConferenceSnapshot =>
  ({ phase: 'buzzing.open', phaseDurationMs: 10_000, timerRemainingMs: 10_000, activeQuestionId: 'q1', attemptId: 1, ...over }) as ConferenceSnapshot

beforeEach(() => resetTimerAnchor())

describe('якорь полоски таймера у гостя', () => {
  it('мелкий джиттер сети держит прежний старт', () => {
    const first = anchoredPhaseStart(snap({ timerRemainingMs: 10_000 }), 1_000)
    expect(first).toBe(1_000)
    // Через 1 с снимок пришёл с задержкой 200 мс: расчёт дал бы 1_200.
    expect(anchoredPhaseStart(snap({ timerRemainingMs: 9_200 }), 2_000)).toBe(1_000)
    expect(anchoredPhaseStart(snap({ timerRemainingMs: 8_000 + TIMER_RESYNC_THRESHOLD_MS }), 3_000)).toBe(1_000)
  })

  it('большой дрейф переякоривает', () => {
    anchoredPhaseStart(snap({}), 1_000)
    expect(anchoredPhaseStart(snap({ timerRemainingMs: 8_000 }), 2_500)).toBe(500)
  })

  it('смена фазы, длительности или попытки переякоривает', () => {
    anchoredPhaseStart(snap({}), 1_000)
    expect(anchoredPhaseStart(snap({ phase: 'answering.waiting', timerRemainingMs: 9_900 }), 1_000)).toBe(900)
    expect(anchoredPhaseStart(snap({ phase: 'answering.waiting', phaseDurationMs: 5_000, timerRemainingMs: 4_900 }), 1_000)).toBe(900)
    expect(anchoredPhaseStart(snap({ phase: 'answering.waiting', phaseDurationMs: 5_000, timerRemainingMs: 4_950, attemptId: 2 }), 1_000)).toBe(950)
  })

  it('пауза и отсутствие таймера сбрасывают якорь', () => {
    anchoredPhaseStart(snap({}), 1_000)
    expect(anchoredPhaseStart(snap({ timerRemainingMs: null }), 1_500)).toBeNull()
    expect(anchoredPhaseStart(snap({ timerRemainingMs: 9_800 }), 1_900)).toBe(1_700)
    expect(anchoredPhaseStart(snap({ phase: 'paused' }), 2_000)).toBeNull()
  })
})

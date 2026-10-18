import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTileLevels, noteTileLevel, resetTileLevels, subscribeTileLevels } from './tileLevels.ts'

afterEach(() => {
  resetTileLevels()
  vi.useRealTimers()
})

describe('tileLevels — уровень речи участников для полосок на плитках', () => {
  it('свой и чужие уровни меняются независимо от фаз: записанный кадр читается', () => {
    noteTileLevel('local', 0.312)
    noteTileLevel('p2', 0.08)
    expect(getTileLevels().byParticipant).toEqual({ local: 0.31, p2: 0.08 })
  })

  it('уведомляет только при изменении видимого снимка', () => {
    const listener = vi.fn()
    const stop = subscribeTileLevels(listener)
    expect(getTileLevels().byParticipant).toEqual({})
    noteTileLevel('p1', 0.2)
    expect(listener).toHaveBeenCalledTimes(1)
    noteTileLevel('p1', 0.2)
    expect(listener).toHaveBeenCalledTimes(1)
    noteTileLevel('p1', 0)
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })

  it('молчание источника гасит уровень: через удержание полоска на нуле', () => {
    vi.useFakeTimers()
    noteTileLevel('p1', 0.4)
    expect(getTileLevels().byParticipant.p1).toBe(0.4)
    vi.advanceTimersByTime(700)
    // Источник замолчал и больше не присылает кадры: чтение без его записей — ноль.
    expect(getTileLevels().byParticipant).toEqual({})
  })

  it('значение за границей обрезается в 0..1', () => {
    noteTileLevel('p1', 5)
    expect(getTileLevels().byParticipant.p1).toBe(1)
    noteTileLevel('p2', -1)
    expect('p2' in getTileLevels().byParticipant).toBe(false)
  })

  it('пустой id и нечисленный уровень не пишутся', () => {
    noteTileLevel('', 0.5)
    noteTileLevel('p1', Number.NaN)
    expect(getTileLevels().byParticipant).toEqual({})
  })
})

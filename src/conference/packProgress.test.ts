import { describe, expect, it } from 'vitest'
import { CHUNK_BYTES } from './chunks.ts'
import {
  formatEta,
  formatSpeed,
  packProgressLabel,
  paceAfterAck,
} from './packProgress.ts'

describe('paceAfterAck', () => {
  it('на нуле ещё без скорости и ETA', () => {
    const { pace, view } = paceAfterAck(undefined, 0, CHUNK_BYTES * 10, 1_000)
    expect(view).toEqual({ percent: 0, downloadBps: null, etaSeconds: null })
    expect(pace?.lastBytes).toBe(0)
  })

  it('считает скорость и ETA по прогрессу ACK', () => {
    const packBytes = CHUNK_BYTES * 10
    const first = paceAfterAck(undefined, 2, packBytes, 1_000)
    expect(first.view.percent).toBe(20)
    expect(first.view.downloadBps).toBeNull()

    const second = paceAfterAck(first.pace!, 4, packBytes, 2_000)
    expect(second.view.percent).toBe(40)
    expect(second.view.downloadBps).toBeGreaterThan(0)
    expect(second.view.etaSeconds).toBeGreaterThan(0)
    // 2 чанка за 1 с → ~2·CHUNK_BYTES/с, осталось 6 чанков
    expect(second.view.etaSeconds).toBe(Math.ceil((6 * CHUNK_BYTES) / second.view.downloadBps!))
  })

  it('на полном префиксе сбрасывает pace', () => {
    const packBytes = CHUNK_BYTES * 4
    const done = paceAfterAck(undefined, 4, packBytes, 1_000)
    expect(done.pace).toBeNull()
    expect(done.view).toEqual({ percent: 100, downloadBps: null, etaSeconds: null })
  })
})

describe('packProgressLabel', () => {
  it('показывает процент, скорость и ETA', () => {
    expect(
      packProgressLabel({
        percent: 40,
        hashOk: false,
        ready: false,
        downloadBps: 64_000,
        etaSeconds: 90,
      }),
    ).toBe('Загрузка 40% · 64 КБ/с · ещё ~2 мин')
  })

  it('после сверки не показывает скорость', () => {
    expect(packProgressLabel({ percent: 100, hashOk: true, ready: true })).toBe('Пакет сверен · готов')
    expect(formatSpeed(null)).toBe('')
    expect(formatEta(0)).toBe('')
  })
})

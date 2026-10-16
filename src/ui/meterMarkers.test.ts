import { describe, expect, it } from 'vitest'
import type { TraceEntry } from '../debug/trace.ts'
import { classifyTraceEntry, createMarkerCollector, meterMarkerColors, meterMarkerLegend, phaseGroup } from './meterMarkers.ts'

const at = (ms: number) => new Date(ms).toISOString()
let id = 0
const e = (kind: TraceEntry['kind'], title: string, ms = 1000): TraceEntry => ({ id: ++id, at: at(ms), kind, title })

describe('метки индикатора модели', () => {
  it('фазы раскрашены по группам, цвета различаются', () => {
    expect(phaseGroup('reading.armed')).toBe('reading')
    expect(phaseGroup('buzzing.open')).toBe('buzzing')
    expect(phaseGroup('answering.waiting')).toBe('answering')
    expect(phaseGroup('choosing.listening')).toBe('choosing')
    expect(phaseGroup('cat.announcing')).toBe('special')
    expect(phaseGroup('appealCue')).toBe('appeal')
    const colors = Object.values(meterMarkerColors)
    expect(new Set(colors).size).toBe(colors.length)
    expect(meterMarkerLegend.map(([g]) => g).sort()).toEqual(Object.keys(meterMarkerColors).sort())
  })
  it('кнопка — переход из окна кнопки или чтения в ответ', () => {
    expect(classifyTraceEntry({ kind: 'state', title: 'answering.waiting' }, 'buzzing.open')).toEqual(['buzzer', 'answering'])
    expect(classifyTraceEntry({ kind: 'state', title: 'answering.waiting' }, 'appealCue')).toEqual(['answering'])
  })
  it('события модели и микшера', () => {
    expect(classifyTraceEntry({ kind: 'in', title: 'input_audio_buffer.speech_started' })).toEqual(['vadStart'])
    expect(classifyTraceEntry({ kind: 'in', title: 'input_audio_buffer.speech_stopped' })).toEqual(['vadStop'])
    expect(classifyTraceEntry({ kind: 'in', title: 'conversation.item.input_audio_transcription.completed' })).toEqual(['transcript'])
    expect(classifyTraceEntry({ kind: 'in', title: 'output_audio_buffer.started' })).toEqual(['hostStart'])
    expect(classifyTraceEntry({ kind: 'out', title: 'response.create' })).toEqual(['response'])
    expect(classifyTraceEntry({ kind: 'out', title: 'response.cancel' })).toEqual(['cancel'])
    expect(classifyTraceEntry({ kind: 'note', title: 'Модель: фокус микшера' })).toEqual(['mixer'])
    expect(classifyTraceEntry({ kind: 'in', title: 'response.audio.delta' })).toEqual([])
  })
  it('сборщик: только новые записи, старые уходят', () => {
    const c = createMarkerCollector(5000)
    const list = [e('note', 'связь connected, микрофон muted, звук idle'), e('state', 'buzzing.open'), e('note', 'связь connected, микрофон live, звук idle'), e('state', 'answering.waiting', 2000)]
    const first = c.ingest(list, 2000).map((m) => m.group)
    expect(first).toEqual(['buzzing', 'buzzer', 'answering'])
    expect(c.ingest(list, 2000)).toHaveLength(3)
    expect(c.ingest(list, 6500).map((m) => m.group)).toEqual(['buzzer', 'answering'])
  })
})

describe('закрытый вход модели', () => {
  it('серый цвет и вуаль, только mic=live открыт', async () => {
    const m = await import('./meterDraw.ts')
    expect(m.modelInputOpen('live')).toBe(true)
    expect(m.modelInputOpen('muted')).toBe(false)
    expect(m.modelInputOpen('idle')).toBe(false)
    expect(m.waveColor(true, true)).toBe('#4ade80')
    expect(m.waveColor(true, false)).not.toBe(m.waveColor(true, true))
    expect(m.CLOSED_OVERLAY).toMatch(/rgba\(.*0\.\d+\)/)
  })
})

describe('дорожки пар начало–конец', () => {
  it('пары складываются в отрезки, у каждого типа своя непересекающаяся строка', async () => {
    const { buildIntervals, laneRect, meterLanes, isLaneGroup } = await import('./meterMarkers.ts')
    const m = (group: Parameters<typeof isLaneGroup>[0], at: number) => ({ group, at })
    const intervals = buildIntervals([
      m('vadStop', 50), // конец без начала — от левого края
      m('hostStart', 100), m('vadStart', 150), m('hostStart', 160), m('hostEnd', 300),
      m('response', 120), m('vadStop', 200), m('reading', 210), m('vadStart', 400),
    ])
    expect(intervals).toEqual(expect.arrayContaining([
      { lane: 0, group: 'hostStart', start: 100, end: 300 },
      { lane: 1, group: 'vadStart', start: null, end: 50 },
      { lane: 1, group: 'vadStart', start: 150, end: 200 },
      { lane: 1, group: 'vadStart', start: 400, end: null },
      { lane: 2, group: 'response', start: 120, end: null },
    ]))
    expect(intervals).toHaveLength(5)
    const rows = meterLanes.map((_, i) => laneRect(i))
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.y).toBeGreaterThanOrEqual(rows[i - 1]!.y + rows[i - 1]!.h)
    expect(rows.at(-1)!.y + rows.at(-1)!.h).toBeLessThanOrEqual(10)
    expect(isLaneGroup('reading')).toBe(false)
    expect(isLaneGroup('hostEnd')).toBe(true)
  })
})

describe('подписи при наведении', () => {
  it('hit-test с допуском, черта выигрывает, длительность словами', async () => {
    const { hitTest, intervalTitle, formatSeconds } = await import('./meterMarkers.ts')
    const bar = { x0: 10, x1: 50, y0: 3, y1: 5, title: 'bar', kind: 'bar' as const }
    const line = { x0: 30, x1: 31, y0: 0, y1: 20, title: 'line', kind: 'line' as const }
    expect(hitTest([bar, line], 20, 4, 3, 3)?.title).toBe('bar')
    expect(hitTest([bar, line], 32, 4, 3, 3)?.title).toBe('line')
    expect(hitTest([bar, line], 33, 15, 3, 3)?.title).toBe('line')
    expect(hitTest([bar, line], 80, 15, 3, 3)).toBeNull()
    expect(formatSeconds(1800)).toBe('1,8 с')
    expect(intervalTitle({ lane: 1, group: 'vadStart', start: 1000, end: 2800 }, 5000, 0)).toBe('Речь игрока (VAD), 1,8 с')
    expect(intervalTitle({ lane: 0, group: 'hostStart', start: 1000, end: null }, 3000, 0)).toBe('Речь ведущей, идёт 2,0 с')
  })
})

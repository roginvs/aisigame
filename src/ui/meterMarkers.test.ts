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
    const m = await import('./ModelInputMeter.tsx')
    expect(m.modelInputOpen('live')).toBe(true)
    expect(m.modelInputOpen('muted')).toBe(false)
    expect(m.modelInputOpen('idle')).toBe(false)
    expect(m.waveColor(true, true)).toBe('#4ade80')
    expect(m.waveColor(true, false)).not.toBe(m.waveColor(true, true))
    expect(m.CLOSED_OVERLAY).toMatch(/rgba\(.*0\.\d+\)/)
  })
})

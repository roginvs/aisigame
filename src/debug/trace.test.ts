import { describe, expect, it } from 'vitest'
import { buildCommit, pageOrigin } from '../buildInfo.ts'
import {
  appendRemoteDebug,
  clearRemoteDebugForTests,
  formatDebugDump,
  formatDebugSize,
  getTrace,
  logTrace,
  noteLink,
  pushTrace,
  sharedDebugBatch,
} from './trace.ts'

describe('formatDebugDump', () => {
  it('форматирует размер копии в КБ и МБ', () => {
    expect(formatDebugSize(1_536)).toBe('~1,5 КБ')
    expect(formatDebugSize(4 * 1024 * 1024)).toBe('~4 МБ')
  })

  it('сохраняет путь машины, полный контекст, связь и обмен', () => {
    noteLink({ connection: 'connected', mic: 'live', host: 'blocked' })
    pushTrace('out', 'session.update', { type: 'session.update', session: { model: 'gpt-realtime-2.1-mini' } })
    pushTrace('in', 'session.updated', { type: 'session.updated' })
    pushTrace('out', 'response.create', { type: 'response.create' })
    pushTrace('state', 'buzzing.open', { resumePath: 'buzzing.open' })
    pushTrace('note', 'SDP принят через multipart')
    pushTrace('note', 'не отправлено, канал закрыт: response.create', { type: 'response.create' })
    pushTrace('note', 'Ошибка API: bad')
    pushTrace('chat', 'Ведущая', { role: 'host', text: 'Вопрос из пакета' })
    pushTrace('note', 'Bearer sk_live_secret не должен остаться')

    const text = formatDebugDump({
      path: 'buzzing.open',
      context: {
        players: [{ id: 1, name: 'Левый', score: 200 }],
        roundIndex: 1,
        playedIds: ['q1'],
        missedIds: [2],
        activeQuestionId: 'q2',
        heard: 'Бетельгейзе',
        judgmentStatus: 'incorrect',
        judgmentReason: 'это не Солнце',
        announceKind: 'incorrect',
        error: null,
        resumePath: 'buzzing.open',
        apiKey: 'sk_test_secret',
        questions: [{ media: [{ kind: 'image', name: 'star.png', url: 'blob:http://127.0.0.1/abc' }] }],
      },
    })

    expect(text).toContain('state: buzzing.open')
    expect(text).toContain('link: connection=connected mic=live host=blocked')
    expect(text).toContain('"score": 200')
    expect(text).toContain('"roundIndex": 1')
    expect(text).toContain('"playedIds"')
    expect(text).toContain('"missedIds"')
    expect(text).toContain('"activeQuestionId": "q2"')
    expect(text).toContain('"heard": "Бетельгейзе"')
    expect(text).toContain('"judgmentReason": "это не Солнце"')
    expect(text).toContain('"announceKind": "incorrect"')
    expect(text).toContain('"resumePath": "buzzing.open"')
    expect(text).toContain('star.png')
    expect(text).not.toContain('sk_test_secret')
    expect(text).not.toContain('sk_live_secret')
    expect(text).toContain('session.update')
    expect(text).toContain('session.updated')
    expect(text).toContain('response.create')
    expect(text).toContain('state buzzing.open')
    expect(text).toContain('SDP принят через multipart')
    expect(text).toContain('не отправлено, канал закрыт: response.create')
    expect(text).toContain('Ошибка API: bad')
    expect(text).toContain('Ведущая')
    expect(text).toContain('связь connected, микрофон live, звук blocked')
    const tail = text.trimEnd().split('\n').slice(-2)
    expect(tail).toEqual([`origin: ${pageOrigin() || '—'}`, `commit: ${buildCommit()}`])
    expect(text).not.toContain('sk-')
  })

  it('покадровое событие не пишет в консоль и не попадает в копию', () => {
    const lines: unknown[][] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args)
    }
    const before = getTrace().length
    try {
      logTrace('in', 'response.output_audio.delta', { responseId: 'r1', chars: 12 })
    } finally {
      console.log = original
    }
    expect(getTrace().length).toBe(before)
    expect(formatDebugDump({ path: 'choosing.listening', context: {} })).not.toContain('response.output_audio.delta')
    expect(lines).toEqual([])
  })

  it('готовит ограниченный и обезличенный батч для мастера', () => {
    const cursor = getTrace().at(-1)?.id ?? 0
    pushTrace('note', 'joiner error Bearer secret-value', {
      apiKey: 'sk-test-secret',
      detail: 'x'.repeat(8_000),
    })
    const batch = sharedDebugBatch(cursor)

    expect(batch.entries).toHaveLength(1)
    expect(batch.entries[0]?.title).toContain('Bearer [key]')
    expect(batch.entries[0]?.detail?.length).toBeLessThanOrEqual(4_000)
    expect(batch.entries[0]?.detail).not.toContain('sk-test-secret')
  })

  it('добавляет в debug dump мастера ограниченный лог игрока', () => {
    clearRemoteDebugForTests()
    appendRemoteDebug('phone-client', 'Маша', [
      { at: '2026-10-11T08:44:18.000Z', kind: 'note', title: 'застряла сверка', detail: '{"token":"Bearer secret"}' },
    ])

    const text = formatDebugDump({ path: 'lobby', context: {} })
    expect(text).toContain('## remote player trace')
    expect(text).toContain('### Маша (phone-client)')
    expect(text).toContain('застряла сверка')
    expect(text).not.toContain('Bearer secret')
    expect(text).toContain('Bearer [key]')
    clearRemoteDebugForTests()
  })
})

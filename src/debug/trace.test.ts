import { describe, expect, it } from 'vitest'
import { buildCommit, pageOrigin } from '../buildInfo.ts'
import { formatDebugDump, noteLink, pushTrace } from './trace.ts'

describe('formatDebugDump', () => {
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
})

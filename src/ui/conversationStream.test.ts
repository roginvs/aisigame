import { describe, expect, it } from 'vitest'
import { emptyMessageRing } from '../conference/messageRing.ts'
import { conversationStreamFromRing, mergeConversationStream } from './conversationStream.ts'

describe('mergeConversationStream', () => {
  it('читает конференцию одним потоком: порядок слотов важнее совпавших или сбившихся часов, note сохраняется', () => {
    const ring = emptyMessageRing()
    ring.messageIndex = 1
    ring.message199 = { kind: 'conversation', role: 'host', text: 'Первая', at: '2026-10-12T12:00:00.000Z' }
    ring.message0 = { kind: 'chat', name: 'Гость', text: 'Вторая', at: '2026-10-12T12:00:00.000Z' }
    ring.message1 = { kind: 'conversation', role: 'judge', text: 'Третья', note: 'Правильный ответ: Август', at: '2026-10-11T12:00:00.000Z' }
    const stream = conversationStreamFromRing(ring)
    expect(stream.map((item) => item.text)).toEqual(['Первая', 'Вторая', 'Третья'])
    expect(stream.at(-1)).toMatchObject({ note: 'Правильный ответ: Август' })
    expect(conversationStreamFromRing(emptyMessageRing())).toEqual([])
  })

  it('вставляет текстовый чат между голосовыми репликами по времени', () => {
    const stream = mergeConversationStream(
      [
        { role: 'host', text: 'Привет', at: '2026-10-11T10:00:00.000Z' },
        { role: 'player', text: 'Сто', at: '2026-10-11T10:00:20.000Z' },
        { role: 'judge', text: 'Верно', at: '2026-10-11T10:00:30.000Z' },
      ],
      [
        { name: 'Вася', text: 'grad', at: '2026-10-11T10:00:10.000Z' },
        { name: 'Вася', text: 'lisopad', at: '2026-10-11T10:00:25.000Z' },
      ],
    )
    expect(stream.map((item) => ('text' in item ? item.text : ''))).toEqual([
      'Привет',
      'grad',
      'Сто',
      'lisopad',
      'Верно',
    ])
    expect(stream.filter((item) => item.kind === 'typed')).toHaveLength(2)
  })

  it('без меток времени сохраняет относительный порядок внутри списков', () => {
    const stream = mergeConversationStream(
      [
        { role: 'host', text: 'А' },
        { role: 'host', text: 'Б' },
      ],
      [
        { name: 'Вася', text: 'чат1' },
        { name: 'Вася', text: 'чат2' },
      ],
    )
    // Без at оба списка уходят в конец с Infinity; стабильный order ставит голос раньше чата.
    expect(stream.map((item) => item.text)).toEqual(['А', 'Б', 'чат1', 'чат2'])
  })
})

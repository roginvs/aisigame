import { describe, expect, it } from 'vitest'
import { mergeConversationStream } from './conversationStream.ts'

describe('mergeConversationStream', () => {
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

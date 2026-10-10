import { describe, expect, it } from 'vitest'
import { chatPinKey, isAtTail, pinColumn } from './chatScroll.ts'

describe('chatPinKey', () => {
  it('changes when a row is appended inside a fixed-length window', () => {
    const before = [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
    ]
    const after = [
      { id: 2, title: 'b' },
      { id: 3, title: 'c' },
    ]
    expect(before.length).toBe(after.length)
    expect(chatPinKey(after)).not.toBe(chatPinKey(before))
  })

  it('changes when an existing row grows', () => {
    const short = [{ id: 4, title: 'Ведущая', detail: { text: 'коротко', note: '' } }]
    const longer = [{ id: 4, title: 'Ведущая', detail: { text: 'коротко и ещё', note: '' } }]
    const noted = [{ id: 4, title: 'Ведущая', detail: { text: 'коротко', note: 'Правильный ответ: да' } }]
    expect(chatPinKey(longer)).not.toBe(chatPinKey(short))
    expect(chatPinKey(noted)).not.toBe(chatPinKey(short))
  })

  it('stays put for the same rendered rows', () => {
    const rows = [{ id: 7, title: 'Игрок', detail: { text: 'Москва' } }]
    expect(chatPinKey(rows)).toBe(chatPinKey(rows.map((row) => ({ ...row }))))
    expect(chatPinKey([])).toBe('0:0:0')
  })
})

describe('pinColumn', () => {
  it('sets the container itself to its full height', () => {
    const node = { scrollTop: 12, scrollHeight: 800, clientHeight: 200 }
    pinColumn(node)
    expect(node.scrollTop).toBe(800)
    expect(isAtTail({ ...node, scrollTop: 600 })).toBe(true)
    expect(isAtTail({ scrollTop: 0, scrollHeight: 800, clientHeight: 200 })).toBe(false)
  })
})

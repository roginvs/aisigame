import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { conversationLineFromTrace } from '../conference/traceConversation.ts'
import { CONFERENCE_HISTORY_LIMIT, validConferenceMessageRing } from '../conference/messages.ts'
import { ConversationChat } from '../ui/DebugChat.tsx'
import { roleLabel, speakerName } from '../ui/chatRoleLabel.ts'
import { chatMarkLabel, chatMarkTone, getTrace, pushPlayerLine, readChatMark, setPlayerSpeakerSource, type ChatMark } from './trace.ts'

afterEach(() => setPlayerSpeakerSource(null))

/** Полное кольцо истории: пустые слоты — null. */
function fullRing(lines: object[]): Record<string, unknown> {
  const ring: Record<string, unknown> = { messageIndex: lines.length - 1 }
  for (let i = 0; i < CONFERENCE_HISTORY_LIMIT; i++) ring[`message${i}`] = lines[i] ?? null
  return ring
}

describe('пометки реплики игрока', () => {
  const cases: Array<[ChatMark, string, string | null]> = [
    [{ kind: 'counted' }, '… оцениваю', 'pending'],
    [{ kind: 'counted', verdict: 'correct' }, '✓ верно', 'good'],
    [{ kind: 'counted', verdict: 'incorrect' }, '✗ неверно', 'bad'],
    [{ kind: 'counted', verdict: 'near_miss' }, '≈ близко', 'close'],
    [{ kind: 'counted', verdict: 'needs_clarification' }, '? уточнение', 'unsure'],
    [{ kind: 'counted', verdict: 'ambiguous' }, '? неоднозначно', 'unsure'],
    [{ kind: 'counted', verdict: 'unintelligible' }, '? неразборчиво', 'unsure'],
    [{ kind: 'guessing' }, '✗ перебор', null],
    [{ kind: 'stall' }, 'заминка', null],
    [{ kind: 'noise' }, 'шум', null],
    [{ kind: 'other' }, 'не выбор', null],
    [{ kind: 'cell', cell: 'Реки 200' }, '→ Реки 200', null],
    [{ kind: 'picked', cell: 'Реки 200' }, '✓ Реки 200', null],
  ]
  it.each(cases)('%j → «%s», тон %s', (mark, label, tone) => {
    expect(chatMarkLabel(mark)).toBe(label)
    expect(chatMarkTone(mark)).toBe(tone)
    expect(readChatMark(JSON.parse(JSON.stringify(mark)))).toEqual(mark)
  })

  it('«выбрано» больше не пишется', () => {
    expect(chatMarkLabel({ kind: 'picked', cell: 'Тема 200' })).not.toContain('выбрано')
  })

  it('валидатор отбрасывает чужой вердикт и вердикт не у «counted»', () => {
    expect(readChatMark({ kind: 'counted', verdict: 'great' })).toBeUndefined()
    expect(readChatMark({ kind: 'counted', verdict: 1 })).toBeUndefined()
    expect(readChatMark({ kind: 'guessing', verdict: 'incorrect' })).toBeUndefined()
    expect(readChatMark({ kind: 'picked', cell: 'Тема 200', verdict: 'correct' })).toBeUndefined()
  })

  it('бейдж: класс цвета и data-verdict', () => {
    const messageRing = fullRing([
      { kind: 'conversation', role: 'player', text: 'Земля', speakerId: 1, mark: { kind: 'counted', verdict: 'incorrect' } },
      { kind: 'conversation', role: 'player', text: 'Марс', mark: { kind: 'counted', verdict: 'near_miss' } },
      { kind: 'conversation', role: 'player', text: 'Луна', speakerId: 3, mark: { kind: 'counted' } },
    ])
    expect(validConferenceMessageRing(messageRing)).toBe(true)
    const players = [{ id: 1, name: 'Вася' }, { id: 3, name: 'Маша' }]
    const html = renderToStaticMarkup(createElement(ConversationChat, { messageRing: messageRing as never, liveSpeech: null, players } as never))
    expect(html).toContain('chat-mark-bad')
    expect(html).toContain('data-verdict="incorrect"')
    expect(html).toContain('✗ неверно')
    expect(html).toContain('chat-mark-close')
    expect(html).toContain('chat-mark-pending')
    expect(html).toContain('… оцениваю')
    expect(html).toContain('>Вася<')
    expect(html).toContain('>Маша<')
    expect(html).toContain('>Услышано<')
  })
})

describe('подпись реплики игрока', () => {
  it('имя по id из players снимка: одинаковые имена, переименование, неизвестный id', () => {
    const line = (speakerId?: number) => fullRing([{ kind: 'conversation', role: 'player', text: 'Земля', ...(speakerId ? { speakerId } : {}) }])
    const render = (ring: object, players?: object[]) => renderToStaticMarkup(createElement(ConversationChat, { messageRing: ring as never, liveSpeech: null, players } as never))
    const twins = [{ id: 1, name: 'Вася' }, { id: 2, name: 'Вася' }]
    expect(render(line(2), twins)).toContain('>Вася<')
    expect(speakerName(twins, 2)).toBe('Вася')
    // Переименование: та же строка показывает новое имя — в строке только id.
    expect(render(line(2), [{ id: 1, name: 'Вася' }, { id: 2, name: 'Петя' }])).toContain('>Петя<')
    expect(render(line(9), twins)).toContain('>Услышано<')
    expect(render(line(1))).toContain('>Услышано<')
    expect(render(line(), twins)).toContain('>Услышано<')
  })

  it('имя говорящего, без глагола; без имени (лобби) — «Услышано»', () => {
    expect(roleLabel('player', 'Вася')).toBe('Вася')
    expect(roleLabel('player', '  ')).toBe('Услышано')
    expect(roleLabel('player')).toBe('Услышано')
    expect(roleLabel('host', 'Вася')).toBe('Ведущая')
  })

  it('мастер кладёт в строку только id говорящего, и он уходит в историю конференции', () => {
    setPlayerSpeakerSource(() => 2)
    pushPlayerLine('Земля', 'sp1')
    const entry = getTrace().at(-1)!
    expect((entry.detail as { speakerId?: number }).speakerId).toBe(2)
    expect(JSON.stringify(entry.detail)).not.toContain('Вася')
    expect(conversationLineFromTrace(entry)).toMatchObject({ role: 'player', text: 'Земля', speakerId: 2 })
    setPlayerSpeakerSource(() => null)
    pushPlayerLine('Привет', 'sp2')
    const lobby = getTrace().at(-1)!
    expect('speakerId' in (lobby.detail as object)).toBe(false)
    expect(conversationLineFromTrace(lobby)?.speakerId).toBeUndefined()
  })

  it('валидатор истории: speakerId — целое ≥ 1 и только у реплики игрока', () => {
    const ring = (line: object) => fullRing([{ kind: 'conversation', role: 'player', text: 'x', ...line }])
    expect(validConferenceMessageRing(ring({ speakerId: 2 }))).toBe(true)
    expect(validConferenceMessageRing(ring({ speakerId: 2, mark: { kind: 'counted', verdict: 'correct' } }))).toBe(true)
    expect(validConferenceMessageRing(ring({ speakerId: 'Вася' }))).toBe(false)
    expect(validConferenceMessageRing(ring({ speakerId: 0 }))).toBe(false)
    expect(validConferenceMessageRing(ring({ speakerId: 1.5 }))).toBe(false)
    expect(validConferenceMessageRing(fullRing([{ kind: 'conversation', role: 'host', text: 'x', speakerId: 1 }]))).toBe(false)
    expect(validConferenceMessageRing(ring({ mark: { kind: 'counted', verdict: 'nope' } }))).toBe(false)
  })
})

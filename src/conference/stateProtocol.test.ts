import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { gameMachine } from '../game/machine.ts'
import { buildConferenceSnapshot } from './buildSnapshot.ts'
import { messageRingEntries } from './messageRing.ts'
import { isConferenceMessage } from './messages.ts'
import { ConferenceStatePublisher, snapshotFromState } from './stateProtocol.ts'

function publisher() {
  const actor = createActor(gameMachine).start()
  const snapshot = buildConferenceSnapshot({
    pack: null,
    phase: 'lobby', context: actor.getSnapshot().context, roster: [],
    timerRemainingMs: null, falseStartIds: [],
  })
  actor.stop()
  return { state: new ConferenceStatePublisher(snapshot, 'master-token'), snapshot }
}

describe('conference state protocol', () => {
  it('отдаёт полный статус с 200 слотами и диф только изменённых полей, включая null и пустой массив', () => {
    const { state, snapshot } = publisher()
    expect(isConferenceMessage(state.full())).toBe(true)
    expect(Object.keys(state.full()).filter((key) => /^message\d+$/.test(key))).toHaveLength(200)
    expect(state.full()).not.toHaveProperty('conversation')
    expect(state.full()).not.toHaveProperty('chat')
    const update = state.update({ ...snapshot, phase: 'answering.waiting', activeQuestionId: 'q', playedIds: ['old'] })
    expect(update.changes).toEqual({ phase: 'answering.waiting', activeQuestionId: 'q', playedIds: ['old'] })
    expect(isConferenceMessage(update)).toBe(true)
    const clear = state.update(snapshot)
    expect(clear.changes).toEqual({ phase: 'lobby', activeQuestionId: null, playedIds: [] })
    expect(clear).toMatchObject({ baseRevision: 1, revision: 2 })
    expect(state.update(snapshot)).toMatchObject({ baseRevision: 2, revision: 2, changes: {} })
  })

  it('каждая запись меняет ровно индекс и слот; после нескольких оборотов остаются последние 200 сообщений', () => {
    const { state } = publisher()
    for (let i = 0; i < 605; i++) {
      const line = i % 2 ? { kind: 'chat' as const, name: 'Игрок', text: String(i) }
        : { kind: 'conversation' as const, role: 'host' as const, text: String(i) }
      const update = state.appendMessage(line)
      expect(Object.keys(update.changes).sort()).toEqual([`message${i % 200}`, 'messageIndex'].sort())
      expect(isConferenceMessage(update)).toBe(true)
    }
    const full = state.full()
    expect(full.messageIndex).toBe(4)
    expect(full.message4?.text).toBe('604')
    expect(full.message5?.text).toBe('405')
    const view = snapshotFromState(full)
    const entries = messageRingEntries(view)
    expect(entries).toHaveLength(200)
    expect(entries.map(({ message }) => message.text)).toEqual(Array.from({ length: 200 }, (_, i) => String(405 + i)))
    expect(isConferenceMessage(full)).toBe(true)
  })

  it('отбрасывает неизвестные поля, неправильные слоты, индексы, значения и ревизии дифа', () => {
    const { state } = publisher()
    const valid = state.update({ ...publisher().snapshot, statusLine: 'Новый статус' })
    for (const changes of [
      { phase: null }, { players: {} }, { pack: { hash: 'hash' } },
      { pack: { hash: 'hash', size: -1, name: 'Пакет', summary: '' } }, { chat: [] }, { conversation: [] },
      { message200: null }, { message01: null }, { messageIndex: 200 }, { messageIndex: -2 },
      { message0: { kind: 'chat', text: 'нет имени' } }, JSON.parse('{"__proto__": {"phase":"finished"}}'),
    ]) {
      expect(isConferenceMessage({ ...valid, changes })).toBe(false)
    }
    expect(isConferenceMessage({ ...valid, revision: 7 })).toBe(false)
    const full = state.full()
    expect(isConferenceMessage({ ...full, message0: undefined })).toBe(false)
    expect(isConferenceMessage({ ...full, revision: -1 })).toBe(false)
    expect(isConferenceMessage({ type: 'statusRequest', clientId: 'guest', authToken: 'token' })).toBe(true)
    expect(isConferenceMessage({ type: 'statusRequest', clientId: 'guest' })).toBe(false)
  })
})

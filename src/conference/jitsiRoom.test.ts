import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConferenceMessage } from './messages.ts'
import { JitsiMessageTransport, visibleJitsiParticipants } from './jitsiRoom.ts'

describe('JitsiMessageTransport', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('не роняет сессию, если BridgeChannel ещё не готов, и повторяет отправку', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const sent: ConferenceMessage[] = []
    let attempts = 0
    const conference = {
      on: vi.fn(),
      sendEndpointMessage: (_to: string, message: ConferenceMessage) => {
        attempts += 1
        if (attempts === 1) throw new Error('BridgeChannel has not been initialized yet')
        sent.push(message)
      },
    }
    const transport = new JitsiMessageTransport(conference as never, 'endpoint', 'data-open')
    const message: ConferenceMessage = { type: 'hello', clientId: 'master', authToken: 'token', name: 'Мастер' }

    expect(() => transport.send(message)).not.toThrow()
    expect(sent).toEqual([])
    vi.advanceTimersByTime(250)
    expect(sent).toEqual([message])

    transport.close()
  })

  it('сохраняет порядок сообщений до открытия data channel', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const handlers = new Map<string, () => void>()
    const sent: ConferenceMessage[] = []
    let ready = false
    const conference = {
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      sendEndpointMessage: (_to: string, message: ConferenceMessage) => {
        if (!ready) throw new Error('not ready')
        sent.push(message)
      },
    }
    const transport = new JitsiMessageTransport(conference as never, 'endpoint', 'data-open')
    const first: ConferenceMessage = { type: 'hello', clientId: 'one', authToken: 'token', name: 'Один' }
    const second: ConferenceMessage = { type: 'ready', clientId: 'one', authToken: 'token' }

    transport.send(first)
    transport.send(second)
    ready = true
    handlers.get('data-open')?.()

    expect(sent).toEqual([first, second])
    transport.close()
  })

  it('ставит свежий снимок вперёд кусков пакета', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const sent: ConferenceMessage[] = []
    let blocked = false
    const conference = {
      on: vi.fn(),
      sendEndpointMessage: (_to: string, message: ConferenceMessage) => {
        if (blocked) throw new Error('busy')
        sent.push(message)
      },
    }
    const transport = new JitsiMessageTransport(conference as never, 'endpoint', 'data-open')
    transport.send({
      type: 'packChunk',
      authorityToken: 'master',
      targetClientId: 'guest',
      hash: 'h',
      index: 0,
      total: 2,
      dataBase64: 'YQ==',
    })
    blocked = true
    transport.send({
      type: 'packChunk',
      authorityToken: 'master',
      targetClientId: 'guest',
      hash: 'h',
      index: 1,
      total: 2,
      dataBase64: 'YQ==',
    })
    transport.send({ type: 'snapshot', authorityToken: 'master', phase: 'lobby' } as ConferenceMessage)

    blocked = false
    vi.advanceTimersByTime(250)
    expect(sent.map((message) => message.type)).toEqual(['packChunk', 'snapshot', 'packChunk'])
    transport.close()
  })

  it('не копит heartbeat и устаревшие снимки, пока канал закрыт', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const handlers = new Map<string, () => void>()
    const sent: ConferenceMessage[] = []
    let ready = false
    const conference = {
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      sendEndpointMessage: (_to: string, message: ConferenceMessage) => {
        if (!ready) throw new Error('not ready')
        sent.push(message)
      },
    }
    const transport = new JitsiMessageTransport(conference as never, 'endpoint', 'data-open')
    transport.send({ type: 'hello', clientId: 'one', authToken: 'token', name: 'Старое имя' })
    transport.send({ type: 'hello', clientId: 'one', authToken: 'token', name: 'Новое имя' })
    const snapshot = (phase: string) => ({ type: 'snapshot', phase }) as unknown as ConferenceMessage
    transport.send(snapshot('lobby'))
    transport.send(snapshot('choosing.listening'))

    ready = true
    handlers.get('data-open')?.()

    expect(sent).toHaveLength(2)
    // Снимок впереди hello: presence не должен ждать за кусками/служебными.
    expect(sent[0]).toMatchObject({ type: 'snapshot', phase: 'choosing.listening' })
    expect(sent[1]).toMatchObject({ type: 'hello', name: 'Новое имя' })
    transport.close()
  })
})

describe('visibleJitsiParticipants', () => {
  it('восстанавливает уже находившихся в комнате участников и пропускает скрытых', () => {
    const visible = {
      getId: () => 'master-endpoint',
      getDisplayName: () => 'Василий Петров',
      isHidden: () => false,
    }
    const hidden = {
      getId: () => 'focus',
      getDisplayName: () => 'Focus',
      isHidden: () => true,
    }

    expect(
      visibleJitsiParticipants(new Map([
        ['fallback-master', visible],
        ['fallback-focus', hidden],
      ])),
    ).toEqual([{ id: 'master-endpoint', name: 'Василий Петров', participant: visible }])
  })
})

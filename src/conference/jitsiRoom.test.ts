import { afterEach, describe, expect, it, vi } from 'vitest'
import { PACK_CHANNEL_HIGH_WATER_BYTES, PACK_CHANNEL_LOW_WATER_BYTES } from './chunks.ts'
import type { ConferenceMessage } from './messages.ts'
import { findBridgeDataChannel, JitsiMessageTransport, visibleJitsiParticipants } from './jitsiRoom.ts'

function fakeDataChannel(bufferedAmount: number): RTCDataChannel {
  const listeners = new Map<string, Set<() => void>>()
  return {
    bufferedAmount,
    readyState: 'open',
    bufferedAmountLowThreshold: 0,
    addEventListener(type: string, handler: EventListenerOrEventListenerObject) {
      const fn = typeof handler === 'function' ? (handler as () => void) : () => undefined
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type: string, handler: EventListenerOrEventListenerObject) {
      const fn = typeof handler === 'function' ? (handler as () => void) : () => undefined
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(event: Event) {
      for (const fn of listeners.get(event.type) ?? []) fn()
      return true
    },
  } as unknown as RTCDataChannel
}

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

  it('не досылает packChunk при высоком bufferedAmount, снимок пропускает', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const sent: ConferenceMessage[] = []
    const channel = fakeDataChannel(PACK_CHANNEL_HIGH_WATER_BYTES + 1)
    const conference = {
      on: vi.fn(),
      sendEndpointMessage: (_to: string, message: ConferenceMessage) => {
        sent.push(message)
      },
      rtc: { _channel: channel },
    }
    const transport = new JitsiMessageTransport(conference as never, 'endpoint', 'data-open')
    transport.send({
      type: 'packChunk',
      authorityToken: 'master',
      targetClientId: 'guest',
      hash: 'h',
      index: 0,
      total: 1,
      dataBase64: 'YQ==',
    })
    expect(sent).toEqual([])
    expect(channel.bufferedAmountLowThreshold).toBe(PACK_CHANNEL_LOW_WATER_BYTES)

    transport.send({ type: 'snapshot', authorityToken: 'master', phase: 'lobby' } as ConferenceMessage)
    expect(sent.map((message) => message.type)).toEqual(['snapshot'])

    Object.defineProperty(channel, 'bufferedAmount', { value: 0, configurable: true })
    channel.dispatchEvent(new Event('bufferedamountlow'))
    expect(sent.map((message) => message.type)).toEqual(['snapshot', 'packChunk'])
    transport.close()
  })

  it('findBridgeDataChannel читает rtc._channel', () => {
    const channel = fakeDataChannel(0)
    expect(findBridgeDataChannel({ rtc: { _channel: channel } })).toBe(channel)
    expect(findBridgeDataChannel({ rtc: { _channel: { _channel: channel } } })).toBe(channel)
    expect(findBridgeDataChannel({})).toBeNull()
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

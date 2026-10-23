import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiWire } from './geminiWire.ts'
import type { VoiceSink } from './wire.ts'

/** Сколько попыток переподключения допускает провод (см. geminiWire.ts). */
const maxAttempts = 5

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = 0
  binaryType = ''
  sent: string[] = []
  readonly url: string
  private readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    const bucket = this.listeners.get(type) ?? []
    bucket.push(listener)
    this.listeners.set(type, bucket)
  }

  removeEventListener(): void {}

  send(raw: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('сокет не открыт')
    this.sent.push(raw)
  }

  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', { code: 1000, reason: '' })
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.fire('open', {})
  }

  serverClose(code: number, reason: string): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', { code, reason })
  }

  message(payload: object): void {
    this.fire('message', { data: JSON.stringify(payload) })
  }
}

type Harness = {
  socket: FakeWebSocket | null
  sink: VoiceSink | null
  apiKey: string
  openSocket(apiKey: string, resumption: string | null): Promise<void>
  sendPcm(pcm: Int16Array): void
}

describe('Gemini: длинные сессии — сжатие контекста и восстановление соединения', () => {
  let wire: GeminiWire
  let harness: Harness
  let received: Array<Record<string, unknown>>
  let closed: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    received = []
    closed = []
    wire = new GeminiWire('gemini-3.8-live', false)
    harness = wire as unknown as Harness
    harness.sink = {
      message: (raw) => received.push(JSON.parse(raw) as Record<string, unknown>),
      closed: (message) => closed.push(message),
    }
    harness.apiKey = 'k'
  })

  afterEach(() => {
    wire.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Живая сессия: setup отправлен и подтверждён, микрофон условно работает. */
  async function liveSession(): Promise<FakeWebSocket> {
    const opened = harness.openSocket('k', null)
    const socket = FakeWebSocket.instances.at(-1)!
    socket.serverOpen()
    socket.message({ setupComplete: {} })
    await opened
    return socket
  }

  it('штатное закрытие соединения переподключается последним resumable-токеном', async () => {
    const socket = await liveSession()
    socket.message({ sessionResumptionUpdate: { resumable: true, newHandle: 'tok-1' } })
    // не-resumable обновление токен не меняет
    socket.message({ sessionResumptionUpdate: { resumable: false, newHandle: 'tok-2' } })
    socket.serverClose(1000, '')
    // события игры в разрыв уходят в очередь и не роняют связь
    expect(wire.send({ type: 'response.create', response: { instructions: 'Скажи привет' } })).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    const next = FakeWebSocket.instances.at(-1)!
    expect(next).not.toBe(socket)
    next.serverOpen()
    const setup = JSON.parse(next.sent[0]!) as { setup: { sessionResumption: { handle?: string } } }
    expect(setup.setup.sessionResumption).toEqual({ handle: 'tok-1' })
    next.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    // очередь доставлена ровно один раз
    expect(next.sent.filter((raw) => raw.includes('Скажи привет'))).toHaveLength(1)
    expect(wire.send({ type: 'response.create', response: { instructions: 'Ещё реплика' } })).toBe(true)
    expect(next.sent.filter((raw) => raw.includes('Ещё реплика'))).toHaveLength(1)
    expect(received.find((event) => event.type === 'gemini.reconnected')).toEqual({ type: 'gemini.reconnected', resumed: true })
    expect(closed).toEqual([])
  })

  it('истёкший токен: следующая попытка открывает новую сессию и помечает потерю контекста', async () => {
    const socket = await liveSession()
    socket.message({ sessionResumptionUpdate: { resumable: true, newHandle: 'tok-old' } })
    socket.serverClose(1000, '')
    await vi.advanceTimersByTimeAsync(500)
    const withToken = FakeWebSocket.instances.at(-1)!
    withToken.serverOpen()
    withToken.serverClose(1007, 'session resumption handle expired')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    const fresh = FakeWebSocket.instances.at(-1)!
    expect(fresh).not.toBe(withToken)
    fresh.serverOpen()
    const setup = JSON.parse(fresh.sent[0]!) as { setup: { sessionResumption: { handle?: string } } }
    expect(setup.setup.sessionResumption).toEqual({})
    fresh.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(received.find((event) => event.type === 'gemini.reconnected')).toEqual({ type: 'gemini.reconnected', resumed: false })
    expect(closed).toEqual([])
  })

  it('ошибка ключа при переподключении роняет связь без новых попыток', async () => {
    const socket = await liveSession()
    socket.serverClose(1000, '')
    await vi.advanceTimersByTimeAsync(500)
    const attempt = FakeWebSocket.instances.at(-1)!
    attempt.serverOpen()
    attempt.serverClose(1008, 'API key not valid')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(closed).toEqual(['Gemini не принял переподключение: API key not valid'])
  })

  it('фатальная причина на живой сессии (квота) роняет связь сразу', async () => {
    const socket = await liveSession()
    socket.serverClose(1000, 'RESOURCE_EXHAUSTED: quota exceeded')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(closed).toEqual(['Gemini оборвал сессию: RESOURCE_EXHAUSTED: quota exceeded'])
  })

  it('сетевой обрыв 1006: задержка растёт, попытки сбрасываются после успеха', async () => {
    const socket = await liveSession()
    socket.serverClose(1006, '')
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    FakeWebSocket.instances.at(-1)!.serverClose(1006, '')
    await vi.advanceTimersByTimeAsync(0)
    // вторая попытка ждёт 1000 мс
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    const third = FakeWebSocket.instances.at(-1)!
    third.serverOpen()
    third.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toEqual([])
    // успех сбросил счётчик: следующий разрыв снова начинает с 500 мс
    third.serverClose(1000, '')
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('неудачные попытки ограничены: после максимума связь падает', async () => {
    const socket = await liveSession()
    socket.serverClose(1006, '')
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await vi.advanceTimersByTimeAsync(500 * 2 ** attempt)
      FakeWebSocket.instances.at(-1)!.serverClose(1006, '')
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(FakeWebSocket.instances).toHaveLength(1 + maxAttempts)
    expect(closed.at(-1)).toMatch(/Gemini не восстановился за \d+ попыток/)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1 + maxAttempts)
  })

  it('обрыв во время речи: заготовленный ход не переотправляется, stopped нет', async () => {
    const socket = await liveSession()
    expect(wire.send({ type: 'response.create', response: { instructions: 'Читаю вопрос' } })).toBe(true)
    expect(socket.sent.filter((raw) => raw.includes('Читаю вопрос'))).toHaveLength(1)
    // звук шёл, но turnComplete не пришёл — сервер оборвал соединение
    socket.serverClose(1000, '')
    await vi.advanceTimersByTimeAsync(500)
    const next = FakeWebSocket.instances.at(-1)!
    next.serverOpen()
    next.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    // реплика не уехала повторно: реплику и её судьбу решает контроллер по своим таймерам
    expect(next.sent.filter((raw) => raw.includes('Читаю вопрос'))).toHaveLength(0)
    expect(received.some((event) => event.type === 'output_audio_buffer.stopped')).toBe(false)
    expect(closed).toEqual([])
  })

  it('разрыв во время ответа игрока: аудио теряется молча, реплика продолжается', async () => {
    const socket = await liveSession()
    socket.message({ voiceActivity: { type: 'ACTIVITY_START' } })
    socket.message({ serverContent: { inputTranscription: { text: 'Александр Серге' } } })
    socket.serverClose(1006, '')
    const pcm = new Int16Array(1600)
    expect(() => harness.sendPcm(pcm)).not.toThrow()
    await vi.advanceTimersByTimeAsync(500)
    const next = FakeWebSocket.instances.at(-1)!
    next.serverOpen()
    next.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    // микрофон снова доходит до сервера
    harness.sendPcm(pcm)
    expect(next.sent.some((raw) => raw.includes('realtimeInput'))).toBe(true)
    // распознавание продолжилось с той же реплики и дошло до completed
    next.message({ serverContent: { inputTranscription: { text: 'Александр Сергеевич Пушкин' } } })
    next.message({ voiceActivity: { type: 'ACTIVITY_END' } })
    await vi.advanceTimersByTimeAsync(0)
    const completed = received.find((event) => event.type === 'conversation.item.input_audio_transcription.completed')
    expect(completed?.transcript).toBe('Александр Сергеевич Пушкин')
    expect(closed).toEqual([])
  })

  it('goAway — только предупреждение: переподключение по факту close сервера', async () => {
    const socket = await liveSession()
    socket.message({ goAway: { timeLeft: '3s' } })
    expect(closed).toEqual([])
    expect(FakeWebSocket.instances).toHaveLength(1)
    socket.serverClose(1000, '')
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const next = FakeWebSocket.instances.at(-1)!
    next.serverOpen()
    next.message({ setupComplete: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toEqual([])
  })

  it('close по воле клиента не включает переподключение', async () => {
    await liveSession()
    wire.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(closed).toEqual([])
  })

  it('отвергнутый setup сразу доносит причину до ждущего connect', async () => {
    const opening = harness.openSocket('k', null)
    const socket = FakeWebSocket.instances.at(-1)!
    socket.serverOpen()
    socket.serverClose(1007, 'Request contains an invalid argument')
    await opening
    const failure = received.find((event) => event.type === 'session.wait-failed')
    expect(String(failure?.message)).toContain('invalid argument')
  })
})

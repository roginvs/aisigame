import { hostInstructions } from '../config.ts'
import { gameAudioContext } from '../audio/beep.ts'
import { createSilentMicStream } from './pcm.ts'
import { sessionTools } from './tools.ts'
import type { VoiceOpenOptions, VoiceSink, VoiceWire } from './wire.ts'

/**
 * Провод Qwen (DashScope, qwen3.8-omni-flash-realtime) — WebRTC, как у OpenAI:
 * SDP-обмен через HTTP POST с ключом (браузер может поставить Authorization),
 * события гоняются по data-каналу «oai-events» в почти OpenAI-форме.
 *
 * Диалект отличается от OpenAI:
 * — session.update должен иметь DashScope-форму целиком (tools вложены в function),
 *   голос Tina, распознавание фиксированное qwen3-asr-flash-realtime;
 * — response.create у DashScope «голый»: инструкции хода у него только в сессии,
 *   поэтому ход = conversation.item.create (реплика-подсказка) + session.update
 *   (инструкции хода в сессию) + response.create без payload;
 * — изолированных ответов conversation:none у него нет: контекст партии модель видит весь,
 *   подсказки ходов написаны самодостаточно, но оценку надо проверять на живой партии;
 * — расшифровка игрока идёт с окном text+stash — переводим в OpenAI-поле transcript;
 * — доп. поля turn_detection (create_response/interrupt_response) не документированы
 *   для клиента: шлём их, а при ошибке сервера повторяем обновление без них;
 * — output_audio_buffer.started/stopped у него нет: живёт и замолкает по уровню
 *   громкости самой WebRTC-дорожки (как уровни плиток в конференции).
 */

export const qwenVoice = 'Tina'

/** Расшифровка у DashScope фиксированная, не меняется. */
export const qwenTranscriptionModel = 'qwen3-asr-flash-realtime'

type Loose = Record<string, unknown>

export function qwenTool(tool: unknown): Loose {
  const record = asRecord(tool)
  return {
    type: 'function',
    function: {
      name: text(record.name),
      ...(text(record.description) ? { description: text(record.description) } : {}),
      ...(record.parameters ? { parameters: record.parameters } : {}),
    },
  }
}

export function qwenSessionBody(
  overrides: { instructions?: string; modalities?: string[]; tools?: readonly unknown[]; vadExtras?: boolean } = {},
): Loose {
  return {
    modalities: overrides.modalities ?? ['text', 'audio'],
    voice: qwenVoice,
    instructions: overrides.instructions || hostInstructions,
    input_audio_format: 'pcm',
    output_audio_format: 'pcm',
    input_audio_transcription: { model: qwenTranscriptionModel },
    turn_detection:
      overrides.vadExtras === false
        ? { type: 'semantic_vad' }
        : { type: 'semantic_vad', create_response: false, interrupt_response: false },
    tools: (overrides.tools ?? sessionTools).map(qwenTool),
  }
}

export type QwenOutbound = { events: object[]; clearOutput?: boolean; drop?: boolean }

/** Ход модели в DashScope: событие OpenAI-формы → очередь событий провода. */
export function qwenTranslateOutbound(event: object, options: { vadExtras?: boolean } = {}): QwenOutbound {
  const record = asRecord(event)
  const type = text(record.type)
  if (type === 'session.update') {
    const body = asRecord(record.session)
    return {
      events: [
        {
          type: 'session.update',
          session: qwenSessionBody({ instructions: text(body.instructions), vadExtras: options.vadExtras }),
        },
      ],
    }
  }
  if (type === 'response.create') {
    const response = asRecord(record.response)
    const modalities = responseOnlyText(response) ? ['text'] : ['text', 'audio']
    const instructions = text(response.instructions) || hostInstructions
    const message = inputTextOf(response.input)
    const events: object[] = []
    if (message) {
      events.push({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] },
      })
    }
    events.push({
      type: 'session.update',
      session: qwenSessionBody({
        instructions,
        modalities,
        tools: Array.isArray(response.tools) ? response.tools : undefined,
        vadExtras: options.vadExtras,
      }),
    })
    events.push({ type: 'response.create' })
    return { events }
  }
  if (type === 'response.cancel') {
    // response_id у DashScope не принимается: отменяется идущий ответ целиком.
    return { events: [{ type: 'response.cancel' }] }
  }
  if (type === 'output_audio_buffer.clear') {
    return { events: [], clearOutput: true }
  }
  if (type === 'input_audio_buffer.commit' || type === 'input_audio_buffer.clear') {
    return { events: [event] }
  }
  if (type === 'conversation.item.create' && text(asRecord(record.item).type) === 'function_call_output') {
    return { events: [event] }
  }
  return { events: [], drop: true }
}

function responseOnlyText(response: Loose): boolean {
  const modalities = Array.isArray(response.output_modalities) ? response.output_modalities : []
  return modalities.length > 0 && modalities.every((item) => item === 'text')
}

/** Сообщение хода из payload OpenAI (реплика пользователя с input_text). */
function inputTextOf(input: unknown): string {
  if (!Array.isArray(input)) return ''
  const lines: string[] = []
  for (const item of input) {
    const record = asRecord(item)
    if (text(record.type) !== 'message' || text(record.role) !== 'user') continue
    const content = Array.isArray(record.content) ? record.content : []
    for (const part of content) {
      const line = text(asRecord(part).text)
      if (line) lines.push(line)
    }
  }
  return lines.join('\n').trim()
}

/** Событие DashScope → форма OpenAI; null — игре событие не нужно. */
export function qwenTranslateInbound(event: object): object | null {
  const record = asRecord(event)
  const type = text(record.type)
  if (type === 'conversation.item.input_audio_transcription.delta') {
    const transcript = `${text(record.text)}${text(record.stash)}`.trim()
    return { type, item_id: text(record.item_id), transcript }
  }
  if (type === 'response.audio_transcript.delta') {
    return { type: 'response.output_audio_transcript.delta', response_id: text(record.response_id), delta: text(record.delta) }
  }
  if (type === 'response.audio_transcript.done') {
    return {
      type: 'response.output_audio_transcript.done',
      response_id: text(record.response_id),
      transcript: text(record.transcript),
    }
  }
  if (type === 'response.text.done') {
    return { type: 'response.output_text.done', response_id: text(record.response_id), text: text(record.text) }
  }
  if (type === 'response.audio.delta' || type === 'response.audio.done') {
    // Звук идёт дорожкой WebRTC, куски по каналу игре не нужны.
    return null
  }
  if (type.startsWith('mcp_') || type.startsWith('response.mcp_')) {
    // MCP-серверов игра не заводит, события только шумят.
    return null
  }
  return event
}

export function qwenSdpUrl(endpoint: string, model: string): string {
  return `https://${qwenEndpointHost(endpoint)}/api/v1/webrtc/realtime?model=${encodeURIComponent(model)}`
}

/**
 * Хост SDP-обмена из того, что ввёл автор: полный хост, адрес с https://
 * или голый id workspace — тогда по умолчанию регион Пекин (cn-beijing),
 * у workspace в Сингапуре в поле стоит полный хост ap-southeast-1.
 */
export function qwenEndpointHost(endpoint: string): string {
  const value = endpoint.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!value) return ''
  return value.includes('.') ? value : `${value}.cn-beijing.maas.aliyuncs.com`
}

/**
 * Полный адрес релея из того, что ввёл автор: путь от корня («/qwen-relay» — тот же
 * origin, работает под dev-сервером Vite), хост или полный адрес. Пусто — прямой
 * вызов DashScope: он отклонён им самим (нет CORS-заголовков), так что на проде
 * без релея будет внятная ошибка, а не молчание.
 */
export function qwenRelayEndpoint(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  const base = raw.startsWith('/')
    ? `/${raw.replace(/^\/+/, '')}`.replace(/\/+$/, '')
    : (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, '')
  if (!base || base === '/') return ''
  return base.endsWith('/qwen-relay') ? base : `${base}/qwen-relay`
}

/** Приёмник речи ведущей: дорожка WebRTC в <audio>, уровни — через AnalyserNode. */
class TrackPlayer {
  private readonly audio = new Audio()
  private analyser: AnalyserNode | null = null
  private timer: number | null = null
  private speaking = false
  private quiet = 0
  private hostTap: MediaStreamAudioDestinationNode | null = null
  private readonly emit: (event: object) => void
  private readonly turn: () => string

  constructor(emit: (event: object) => void, turn: () => string) {
    this.emit = emit
    this.turn = turn
    this.audio.autoplay = true
  }

  attach(stream: MediaStream): void {
    this.audio.srcObject = stream
    void this.audio.play().catch(() => undefined)
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
      this.analyser = null
      this.speaking = false
      this.quiet = 0
    }
    const track = stream.getAudioTracks()[0]
    if (!track) return
    const ctx = gameAudioContext()
    void ctx.resume()
    const source = ctx.createMediaStreamSource(new MediaStream([track]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    this.analyser = analyser
    // Комната может запросить поток раньше ontrack: подключаю destination, когда она уже ждёт.
    if (this.hostTap) source.connect(this.hostTap)
    this.timer = window.setInterval(() => this.probe(), 100)
  }

  private probe(): void {
    const analyser = this.analyser
    if (!analyser || !this.turn()) return
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const value of data) sum += value * value
    const rms = Math.sqrt(sum / (data.length || 1))
    if (!this.speaking) {
      if (rms >= 0.015) {
        this.speaking = true
        this.emit({ type: 'output_audio_buffer.started', response_id: this.turn() })
      }
      return
    }
    if (rms < 0.006) {
      this.quiet += 1
      if (this.quiet >= 3) {
        this.speaking = false
        this.quiet = 0
        this.emit({ type: 'output_audio_buffer.stopped', response_id: this.turn() })
      }
    } else {
      this.quiet = 0
    }
  }

  /** Модель обрывается сама (отмена): гасим текущее «говорит» без ожидания тишины. */
  cut(): void {
    if (!this.speaking) return
    this.speaking = false
    this.quiet = 0
    this.emit({ type: 'output_audio_buffer.stopped', response_id: this.turn() })
  }

  setMuted(muted: boolean): void {
    this.audio.muted = muted
  }

  /** Ответ ведущей в комнату Jitsi: destination отдаём сразу, дорожку подключаем при приходе. */
  attachHostOutput(handler: (stream: MediaStream) => void): void {
    if (!this.hostTap) {
      const ctx = gameAudioContext()
      void ctx.resume()
      this.hostTap = ctx.createMediaStreamDestination()
    }
    handler(this.hostTap.stream)
  }

  close(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.analyser = null
    this.hostTap = null
    this.speaking = false
    this.audio.pause()
  }
}

export class QwenWire implements VoiceWire {
  private sink: VoiceSink | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private micStream: MediaStream | null = null
  private player = new TrackPlayer(
    (event) => this.emit(event),
    () => this.responseId,
  )
  private opened = false
  private responseId = ''
  private vadExtrasBroken = false
  private relayEndpoint = ''
  private sessionChannel: RTCDataChannel | null = null
  private readonly model: string
  private readonly endpoint: string | (() => string)
  private readonly relay: string | (() => string)
  private host = ''

  constructor(model: string, endpoint: string | (() => string), relay: string | (() => string) = '') {
    this.model = model
    this.endpoint = endpoint
    this.relay = relay
  }

  async open(apiKey: string, sink: VoiceSink, options?: VoiceOpenOptions): Promise<void> {
    this.close()
    // Адрес и релей читаются при каждом подключении: автор мог ввести их уже после
    // того, как клиент голоса создался при выборе модели (иначе поле терялось).
    const endpoint = typeof this.endpoint === 'function' ? this.endpoint() : this.endpoint
    this.host = qwenEndpointHost(endpoint)
    if (!this.host) {
      throw new Error('Укажите «Адрес workspace DashScope» под ключом: id workspace или полный хост ws-xxxx.cn-beijing.maas.aliyuncs.com')
    }
    const relayValue = typeof this.relay === 'function' ? this.relay() : this.relay
    this.relayEndpoint = qwenRelayEndpoint(relayValue)
    this.sink = sink
    this.responseId = ''
    this.vadExtrasBroken = false
    let mic: MediaStream
    if (options?.captureMic !== false) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (error) {
        throw new Error(micError(error))
      }
    } else {
      mic = createSilentMicStream()
    }
    for (const track of mic.getAudioTracks()) track.enabled = false
    this.micStream = mic
    await this.openSession(apiKey, mic)
  }

  send(event: object): boolean {
    const outbound = qwenTranslateOutbound(event, { vadExtras: !this.vadExtrasBroken })
    if (outbound.drop) return true
    let ok = true
    for (const item of outbound.events) {
      if (!this.dcSend(item)) ok = false
    }
    if (outbound.clearOutput) {
      this.player.cut()
      queueMicrotask(() => this.emit({ type: 'output_audio_buffer.cleared' }))
      return true
    }
    return ok
  }

  setMicEnabled(enabled: boolean): void {
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = enabled
  }

  setOutputMuted(muted: boolean): void {
    this.player.setMuted(muted)
  }

  setLocalPlayback(enabled: boolean): void {
    this.player.setMuted(!enabled)
  }

  attachHostOutput(handler: (stream: MediaStream) => void): void {
    this.player.attachHostOutput(handler)
  }

  /** null — вернуть микрофон из open(); иначе заменить дорожку отправителя WebRTC. */
  setInputStream(stream: MediaStream | null): void {
    const pc = this.pc
    if (!pc) return
    const sender = pc.getSenders().find((item) => item.track?.kind === 'audio')
    if (!sender) return
    const track = stream?.getAudioTracks()[0] ?? this.micStream?.getAudioTracks()[0] ?? null
    if (track) void sender.replaceTrack(track)
  }

  close(): void {
    this.opened = false
    this.sessionChannel = null
    this.player.close()
    for (const track of this.micStream?.getAudioTracks() ?? []) track.stop()
    this.micStream = null
    const dc = this.dc
    this.dc = null
    if (dc && dc.readyState !== 'closed') dc.close()
    const pc = this.pc
    this.pc = null
    if (pc && pc.connectionState !== 'closed') pc.close()
  }

  private async openSession(apiKey: string, mic: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection()
    this.pc = pc
    pc.ontrack = (event) => {
      const [stream] = event.streams
      if (stream) this.player.attach(stream)
    }
    pc.onconnectionstatechange = () => {
      if (!this.opened) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.sink?.closed('Соединение с DashScope прервалось')
      }
    }
    for (const track of mic.getAudioTracks()) pc.addTrack(track, mic)

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    this.bindChannel(dc)
    // Свои события шлём в oai-events, но DashScope отвечает и по серверному каналу
    // (их пример — «txt»): слушать надо оба, а session.update отдавать в тот,
    // где пришёл session.created. Пока тот не объявился — шлём в oai-events.
    pc.ondatachannel = (event) => this.bindChannel(event.channel)
    const opened = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Канал событий не открылся')), 15_000)
      dc.addEventListener(
        'open',
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      dc.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer)
          reject(new Error('Канал событий закрылся с ошибкой'))
        },
        { once: true },
      )
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitIce(pc)
    const sdp = pc.localDescription?.sdp
    if (!sdp) throw new Error('Браузер не подготовил описание соединения')
    const answer = await exchangeQwenSdp(apiKey, qwenSdpUrl(this.host, this.model), sdp, this.relayEndpoint)
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    try {
      await opened
    } catch (error) {
      throw error instanceof Error ? error : new Error('Канал событий DashScope закрылся с ошибкой')
    }
    this.opened = true
  }

  private bindChannel(channel: RTCDataChannel): void {
    channel.addEventListener('message', (event) => this.onMessage(event.data, channel))
  }

  private dcSend(event: object): boolean {
    // После session.created все события сессии уходят в серверный канал, как в их примере WebRTC.
    const dc = this.sessionChannel && this.sessionChannel.readyState === 'open' ? this.sessionChannel : this.dc
    if (!dc || dc.readyState !== 'open') return false
    try {
      dc.send(JSON.stringify(event))
    } catch {
      return false
    }
    return true
  }

  private emit(event: object): void {
    this.sink?.message(JSON.stringify(event))
  }

  private onMessage(data: unknown, channel?: RTCDataChannel): void {
    if (typeof data !== 'string') return
    let parsed: Loose
    try {
      parsed = JSON.parse(data) as Loose
    } catch {
      return
    }
    const type = text(parsed.type)
    if (type === 'session.created' && channel) this.sessionChannel = channel
    if (type === 'response.created' || type === 'response.done') {
      const id = text(asRecord(parsed.response).id)
      if (id) this.responseId = type === 'response.created' ? id : ''
    }
    if (this.retryVadExtras(parsed, type)) return
    const event = qwenTranslateInbound(parsed)
    if (event) this.emit(event)
  }

  /**
   * create_response/interrupt_response в turn_detection не документированы: если сервер
   * отверг session.update из-за них (или аудио-формата), шлём повтор без доп. полей.
   * В session.updated обе попытки поднимут сессию, повторный ответ лишний.
   */
  private retryVadExtras(parsed: Loose, type: string): boolean {
    if (type !== 'error' || this.vadExtrasBroken) return false
    const error = asRecord(parsed.error)
    const param = text(error.param)
    const message = text(error.message)
    if (!/turn_detection/i.test(param) && !/turn_detection/i.test(message)) return false
    this.vadExtrasBroken = true
    this.dcSend({ type: 'session.update', session: qwenSessionBody({ vadExtras: false }) })
    return false
  }
}

function micError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Нет доступа к микрофону. Разрешите его в браузере и нажмите «Начать игру» снова.'
  }
  if (error instanceof Error && error.message) return error.message
  return 'Не удалось открыть микрофон'
}

function clip(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > 180 ? `${clean.slice(0, 180)}…` : clean
}

async function waitIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', done)
      resolve()
    }
    pc.addEventListener('icegatheringstatechange', done)
    // Как в примере DashScope: сбор крыльев может занять до 15 секунд.
    window.setTimeout(done, 15_000)
  })
}

async function exchangeQwenSdp(apiKey: string, directUrl: string, sdp: string, relay: string): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/sdp' }
  if (relay) headers['X-Qwen-Target'] = directUrl
  let response: Response
  try {
    response = await fetch(relay || directUrl, {
      method: 'POST',
      headers,
      body: sdp,
    })
  } catch {
    throw new Error(
      relay
        ? `Релей DashScope (${relay}) не ответил. Проверьте адрес релея и что релей запущен.`
        : 'DashScope не принимает прямые вызовы из браузера (нет CORS-заголовков). Укажите «Адрес релея» под полем workspace: /qwen-relay под dev-сервером или адрес своего Worker (relay/README.md).',
    )
  }
  const body = await response.text()
  if (!response.ok) {
    if (response.status === 401) throw new Error('DashScope отклонил ключ (401). Проверьте ключ и workspace.')
    throw new Error(`DashScope ответил ${response.status}. ${clip(body)}`)
  }
  const answer = body.trim().replace(/\r?\n/g, '\r\n') + '\r\n'
  if (!answer.includes('v=')) throw new Error(`Ответ DashScope не похож на SDP. ${clip(body)}`)
  return answer
}

function asRecord(value: unknown): Loose {
  return value && typeof value === 'object' ? (value as Loose) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

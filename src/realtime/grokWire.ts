import { base64ToPcm, pcmToBase64, PcmMic, PcmPlayer } from './pcm.ts'
import type { VoiceSink, VoiceWire } from './wire.ts'

const sampleRate = 24_000
const secretsUrl = 'https://api.x.ai/v1/realtime/client_secrets'

type Loose = Record<string, unknown>

export type GrokTurn = {
  responseId: string
  pendingTranscript: string
  pendingItemId: string | null
  transcriptDone: boolean
  handledCalls: string[]
}

export function freshGrokTurn(): GrokTurn {
  return {
    responseId: '',
    pendingTranscript: '',
    pendingItemId: null,
    transcriptDone: false,
    handledCalls: [],
  }
}

/** Исходящее событие OpenAI → событие Grok. `null` значит «не слать, сделать локально». */
export function grokOutbound(event: object): object | 'clear-output' | 'drop' {
  const record = asRecord(event)
  const type = text(record.type)
  if (type === 'output_audio_buffer.clear') return 'clear-output'
  if (type === 'session.update') return grokSession(asRecord(record.session))
  return event
}

export function grokInbound(event: object, turn: GrokTurn): { turn: GrokTurn; events: object[]; audio: Int16Array | null } {
  const record = asRecord(event)
  const type = text(record.type)
  const next: GrokTurn = { ...turn, handledCalls: [...turn.handledCalls] }
  if (type === 'response.created') {
    const response = asRecord(record.response)
    const id = text(response.id)
    if (id) next.responseId = id
    return { turn: next, events: [event], audio: null }
  }
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    const delta = text(record.delta) || text(record.audio)
    const responseId = text(record.response_id) || next.responseId
    if (responseId) next.responseId = responseId
    if (!delta) return { turn: next, events: [], audio: null }
    return { turn: next, events: [], audio: base64ToPcm(delta) }
  }
  if (type === 'conversation.item.input_audio_transcription.updated') {
    next.pendingTranscript = text(record.transcript)
    next.pendingItemId = text(record.item_id) || next.pendingItemId
    // Grok шлёт полный промежуточный текст — отдаём как delta с полным transcript.
    const events = next.pendingTranscript && !next.transcriptDone
      ? [{ type: 'conversation.item.input_audio_transcription.delta', item_id: next.pendingItemId, transcript: next.pendingTranscript }]
      : []
    return { turn: next, events, audio: null }
  }
  if (type === 'input_audio_buffer.speech_started') {
    next.pendingTranscript = ''
    next.pendingItemId = text(record.item_id) || null
    next.transcriptDone = false
    return { turn: next, events: [event], audio: null }
  }
  if (type === 'input_audio_buffer.speech_stopped') {
    const events: object[] = [event]
    if (!next.transcriptDone && next.pendingTranscript) {
      events.push(completedTranscript(next.pendingItemId, next.pendingTranscript))
      next.transcriptDone = true
    }
    return { turn: next, events, audio: null }
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    next.transcriptDone = true
    next.pendingTranscript = ''
    return { turn: next, events: [event], audio: null }
  }
  if (type === 'response.function_call_arguments.done') {
    const callId = text(record.call_id)
    if (!callId || next.handledCalls.includes(callId)) return { turn: next, events: [], audio: null }
    next.handledCalls.push(callId)
    return { turn: next, events: [functionDone(next.responseId, record)], audio: null }
  }
  if (type === 'response.done') {
    const response = asRecord(record.response)
    const output = Array.isArray(response.output) ? response.output : []
    const kept = output.filter((item) => {
      const call = asRecord(item)
      if (call.type !== 'function_call') return true
      const callId = text(call.call_id)
      if (!callId) return true
      if (next.handledCalls.includes(callId)) return false
      next.handledCalls.push(callId)
      return true
    })
    return {
      turn: next,
      events: [{ ...record, response: { ...response, output: kept } }],
      audio: null,
    }
  }
  return { turn: next, events: [event], audio: null }
}

function grokSession(session: Loose): object {
  const speed = numberAt(session, ['audio', 'output', 'speed'])
  const prompt = textAt(session, ['audio', 'input', 'transcription', 'prompt'])
  const instructions = text(session.instructions) || undefined
  const tools = Array.isArray(session.tools) ? session.tools : undefined
  const full = Boolean(instructions)
  const next: Loose = {}
  if (instructions) next.instructions = instructions
  if (tools) next.tools = tools
  if (full) {
    next.voice = 'eve'
    next.turn_detection = { type: 'server_vad' }
    next.audio = {
      input: {
        format: { type: 'audio/pcm', rate: sampleRate },
        transcription: transcription(prompt),
      },
      output: {
        format: { type: 'audio/pcm', rate: sampleRate },
        speed: speed ?? 1,
      },
    }
    return { type: 'session.update', session: next }
  }
  if (speed !== null || prompt) {
    next.audio = {
      ...(speed !== null ? { output: { speed } } : {}),
      ...(prompt ? { input: { transcription: transcription(prompt) } } : {}),
    }
  }
  return { type: 'session.update', session: next }
}

function transcription(prompt: string): Loose {
  const terms = keyterms(prompt)
  return {
    model: 'grok-transcribe',
    language_hint: 'ru',
    ...(terms.length ? { keyterms: terms } : {}),
  }
}

export function keyterms(prompt: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of prompt.split(/[^\p{L}\p{N}]+/u)) {
    const term = raw.trim().slice(0, 50)
    if (term.length < 3) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= 100) break
  }
  return terms
}

function completedTranscript(itemId: string | null, transcript: string): object {
  return {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  }
}

function functionDone(responseId: string, call: Loose): object {
  return {
    type: 'response.done',
    response: {
      id: responseId || `grok-${text(call.call_id)}`,
      output: [
        {
          type: 'function_call',
          name: text(call.name),
          call_id: text(call.call_id),
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      ],
    },
  }
}

export class GrokWire implements VoiceWire {
  private sink: VoiceSink | null = null
  private socket: WebSocket | null = null
  private mic: PcmMic | null = null
  private player: PcmPlayer
  private turn = freshGrokTurn()
  private opened = false
  private readonly model: string

  constructor(model: string) {
    this.model = model
    this.player = new PcmPlayer(sampleRate, () => this.markPlayback(true), () => this.markPlayback(false))
  }

  async open(apiKey: string, sink: VoiceSink, options?: { captureMic?: boolean }): Promise<void> {
    this.close()
    this.sink = sink
    this.turn = freshGrokTurn()
    const secret = await ephemeralSecret(apiKey)
    const mic = new PcmMic(sampleRate, (pcm) => this.sendPcm(pcm))
    try {
      await mic.open({ captureMic: options?.captureMic !== false })
    } catch (error) {
      throw new Error(micError(error))
    }
    this.mic = mic
    await this.openSocket(secret)
  }

  send(event: object): boolean {
    const outbound = grokOutbound(event)
    if (outbound === 'clear-output') {
      this.player.stop()
      queueMicrotask(() => this.emit({ type: 'output_audio_buffer.cleared' }))
      return true
    }
    if (outbound === 'drop') return true
    return this.socketSend(outbound)
  }

  setMicEnabled(enabled: boolean): void {
    this.mic?.setEnabled(enabled)
  }

  setOutputMuted(muted: boolean): void {
    this.player.setMuted(muted)
  }

  attachHostOutput(handler: (stream: MediaStream) => void): void {
    this.player.attachHostOutput(handler)
  }

  setInputStream(stream: MediaStream | null): void {
    this.mic?.setInputStream(stream)
  }

  close(): void {
    this.opened = false
    this.player.stop()
    this.mic?.close()
    this.mic = null
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  }

  private markPlayback(started: boolean): void {
    this.emit({
      type: started ? 'output_audio_buffer.started' : 'output_audio_buffer.stopped',
      response_id: this.turn.responseId,
    })
  }

  private sendPcm(pcm: Int16Array): void {
    this.socketSend({ type: 'input_audio_buffer.append', audio: pcmToBase64(pcm) })
  }

  private openSocket(secret: string): Promise<void> {
    const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(this.model)}`
    const protocol = secret.startsWith('xai-client-secret.') ? secret : `xai-client-secret.${secret}`
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, [protocol])
      this.socket = socket
      let settled = false
      const rejectOnce = (message: string) => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }
      socket.addEventListener('open', () => {
        settled = true
        this.opened = true
        resolve()
      })
      socket.addEventListener('message', (event) => this.onMessage(event.data))
      socket.addEventListener('error', () => {
        if (this.opened) this.sink?.closed('Соединение с xAI прервалось')
        else rejectOnce('Соединение с xAI прервалось')
      })
      socket.addEventListener('close', () => {
        if (!this.opened) {
          rejectOnce('Канал xAI закрылся')
          return
        }
        this.opened = false
        this.sink?.closed('Канал xAI закрылся')
      })
    })
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let event: object
    try {
      event = JSON.parse(data) as object
    } catch {
      return
    }
    const parsed = grokInbound(event, this.turn)
    this.turn = parsed.turn
    if (parsed.audio) this.player.enqueue(parsed.audio)
    for (const item of parsed.events) this.emit(item)
    if (text(asRecord(event).type) === 'response.done') this.player.finish()
  }

  private socketSend(event: object): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(event))
    return true
  }

  private emit(event: object): void {
    this.sink?.message(JSON.stringify(event))
  }
}

async function ephemeralSecret(apiKey: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(secretsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expires_after: { seconds: 3600 } }),
    })
  } catch {
    throw new Error('Браузер не пустил запрос короткого ключа xAI. Прямой вызов из страницы не прошёл.')
  }
  const body = await response.text()
  if (!response.ok) {
    if (response.status === 401) throw new Error('xAI отклонил ключ (401). Проверьте ключ и доступ к Voice.')
    throw new Error(`xAI ответил ${response.status}. ${clip(body)}`)
  }
  let value = ''
  try {
    const parsed = JSON.parse(body) as { value?: unknown }
    if (typeof parsed.value === 'string') value = parsed.value
  } catch {
    value = ''
  }
  if (!value) throw new Error('xAI не вернул короткий ключ для браузера.')
  return value
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

function asRecord(value: unknown): Loose {
  return value && typeof value === 'object' ? (value as Loose) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textAt(root: Loose, path: string[]): string {
  let cursor: unknown = root
  for (const key of path) {
    cursor = asRecord(cursor)[key]
  }
  return text(cursor)
}

function numberAt(root: Loose, path: string[]): number | null {
  let cursor: unknown = root
  for (const key of path) cursor = asRecord(cursor)[key]
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null
}

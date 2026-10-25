import { base64ToPcm, pcmToBase64, PcmMic, PcmPlayer } from './pcm.ts'
import type { VoiceSink, VoiceWire } from './wire.ts'

const sampleRate = 24_000
const secretsUrl = 'https://api.x.ai/v1/realtime/client_secrets'

type Loose = Record<string, unknown>

export type GrokTurn = {
  responseId: string
  pendingTranscript: string
  pendingItemId: string | null
  /** updated — черновик старого события; draft — незакрытый transcription.completed. */
  pendingKind: 'none' | 'updated' | 'draft'
  /** speech_stopped уже был: финал можно отдать, ранний черновик — нет. */
  speechClosed: boolean
  transcriptDone: boolean
  handledCalls: string[]
}

/** Сколько ждём финальную completed после конца речи, если status=completed так и не пришёл. */
export const grokTranscriptSettleMs = 1_200

export function freshGrokTurn(): GrokTurn {
  return {
    responseId: '',
    pendingTranscript: '',
    pendingItemId: null,
    pendingKind: 'none',
    speechClosed: false,
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
  if (type === 'response.create') return grokResponseCreate(record)
  return event
}

/**
 * Ответ xAI на `response.create`: инструмент `type=function` обязан иметь вложенное `function`
 * (`name`, `description`, `parameters`). Плоская схема OpenAI даёт
 * `Tool with type='function' must have 'function' field set`.
 * `session.update` плоскую схему принимает и сам перекладывает её в этот вид — её не трогаем.
 * `tool_choice` остаётся `{type, name}`: ошибка была только про `response.tools`.
 */
function grokResponseCreate(record: Loose): object {
  const response = asRecord(record.response)
  const tools = Array.isArray(response.tools) ? response.tools.map(grokFunctionTool) : undefined
  if (!('max_output_tokens' in response) && !tools) return record
  // Потолок длины — поле OpenAI; Grok его не документирует, не рискуем ошибкой.
  const { max_output_tokens: _cap, ...rest } = response
  void _cap
  return { ...record, response: tools ? { ...rest, tools } : rest }
}

/** Вложить плоский инструмент OpenAI. Уже вложенный и не-function не меняются. */
export function grokFunctionTool(tool: unknown): unknown {
  const record = asRecord(tool)
  if (record.type !== 'function') return tool
  const nested = asRecord(record.function)
  if (text(nested.name)) return tool
  const name = text(record.name)
  if (!name) return tool
  const fn: Loose = { name }
  if (typeof record.description === 'string') fn.description = record.description
  if (record.parameters !== undefined) fn.parameters = record.parameters
  return { type: 'function', function: fn }
}

export function grokInbound(event: object, turn: GrokTurn): { turn: GrokTurn; events: object[]; audio: Int16Array | null; holdDraft: boolean } {
  const record = asRecord(event)
  const type = text(record.type)
  const next: GrokTurn = { ...turn, handledCalls: [...turn.handledCalls] }
  if (type === 'response.created') {
    const response = asRecord(record.response)
    const id = text(response.id)
    if (id) next.responseId = id
    return { turn: next, events: [event], audio: null, holdDraft: false }
  }
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    const delta = text(record.delta) || text(record.audio)
    const responseId = text(record.response_id) || next.responseId
    if (responseId) next.responseId = responseId
    if (!delta) return { turn: next, events: [], audio: null, holdDraft: false }
    return { turn: next, events: [], audio: base64ToPcm(delta), holdDraft: false }
  }
  if (type === 'conversation.item.input_audio_transcription.updated') {
    next.pendingTranscript = text(record.transcript)
    next.pendingItemId = text(record.item_id) || next.pendingItemId
    if (next.pendingKind !== 'draft') next.pendingKind = 'updated'
    // Grok шлёт полный промежуточный текст — отдаём как delta с полным transcript.
    const events = next.pendingTranscript && !next.transcriptDone
      ? [{ type: 'conversation.item.input_audio_transcription.delta', item_id: next.pendingItemId, transcript: next.pendingTranscript }]
      : []
    return { turn: next, events, audio: null, holdDraft: false }
  }
  if (type === 'input_audio_buffer.speech_started') {
    next.pendingTranscript = ''
    next.pendingItemId = text(record.item_id) || null
    next.pendingKind = 'none'
    next.speechClosed = false
    next.transcriptDone = false
    return { turn: next, events: [event], audio: null, holdDraft: false }
  }
  if (type === 'input_audio_buffer.speech_stopped') {
    next.speechClosed = true
    const events: object[] = [event]
    // Черновик `.updated` закрываем сразу. Повторные completed с status=in_progress
    // не закрываем: финал приходит следом, ранний «Text» не должен запереть реплику.
    if (!next.transcriptDone && next.pendingTranscript && next.pendingKind !== 'draft') {
      events.push(completedTranscript(next.pendingItemId, next.pendingTranscript))
      next.transcriptDone = true
      next.pendingTranscript = ''
      next.pendingKind = 'none'
    }
    const holdDraft = !next.transcriptDone && next.pendingKind === 'draft' && Boolean(next.pendingTranscript)
    return { turn: next, events, audio: null, holdDraft }
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    return finishGrokTranscript(next, record)
  }
  if (type === 'response.function_call_arguments.done') {
    const callId = text(record.call_id)
    if (!callId || next.handledCalls.includes(callId)) return { turn: next, events: [], audio: null, holdDraft: false }
    next.handledCalls.push(callId)
    return { turn: next, events: [functionDone(next.responseId, record)], audio: null, holdDraft: false }
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
      holdDraft: false,
    }
  }
  return { turn: next, events: [event], audio: null, holdDraft: false }
}

/**
 * Повторные `transcription.completed` одного item: в ход идёт финальная
 * (`status=completed` или единственная без status). `in_progress` — черновик.
 * После финала поздняя правка не уходит клиенту и ход не открывает.
 */
function finishGrokTranscript(next: GrokTurn, record: Loose): { turn: GrokTurn; events: object[]; audio: Int16Array | null; holdDraft: boolean } {
  if (next.transcriptDone) return { turn: next, events: [], audio: null, holdDraft: false }
  const transcript = text(record.transcript)
  const itemId = text(record.item_id) || next.pendingItemId
  const status = text(record.status)
  const final = status === 'completed' || status === ''
  if (!final) {
    next.pendingTranscript = transcript
    next.pendingItemId = itemId
    next.pendingKind = 'draft'
    const events = transcript
      ? [{ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, transcript }]
      : []
    return { turn: next, events, audio: null, holdDraft: next.speechClosed && Boolean(transcript) }
  }
  next.transcriptDone = true
  next.pendingTranscript = ''
  next.pendingKind = 'none'
  return { turn: next, events: [record], audio: null, holdDraft: false }
}

/** Запасной финал, если после конца речи status=completed так и не пришёл. */
export function grokReleaseDraft(turn: GrokTurn): { turn: GrokTurn; event: object | null } {
  if (turn.transcriptDone || turn.pendingKind !== 'draft' || !turn.pendingTranscript) return { turn, event: null }
  return {
    turn: { ...turn, transcriptDone: true, pendingTranscript: '', pendingKind: 'none' },
    event: completedTranscript(turn.pendingItemId, turn.pendingTranscript),
  }
}

function grokSession(session: Loose): object {
  const speed = numberAt(session, ['audio', 'output', 'speed'])
  const prompt = textAt(session, ['audio', 'input', 'transcription', 'prompt'])
  // Пустая строка — явная очистка подсказки: старые keyterms не должны дожить до чтения вопроса.
  const promptSet = typeof ((session.audio as { input?: { transcription?: { prompt?: unknown } } } | undefined)?.input?.transcription?.prompt) === 'string'
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
  if (speed !== null || promptSet) {
    next.audio = {
      ...(speed !== null ? { output: { speed } } : {}),
      ...(promptSet ? { input: { transcription: transcription(prompt, true) } } : {}),
    }
  }
  return { type: 'session.update', session: next }
}

function transcription(prompt: string, clear = false): Loose {
  const terms = keyterms(prompt)
  return {
    model: 'grok-transcribe',
    language_hint: 'ru',
    ...(terms.length || clear ? { keyterms: terms } : {}),
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
  /** События commit/clear уходят как у OpenAI. Запасной commit ответа по-прежнему выключен. */
  readonly supportsButtonCut = true
  /** xAI ждёт function_call_output даже на вызов, который игра не принимала. */
  readonly acksForeignToolCalls = true
  private sink: VoiceSink | null = null
  private socket: WebSocket | null = null
  private mic: PcmMic | null = null
  private player: PcmPlayer
  private turn = freshGrokTurn()
  private opened = false
  private draftTimer: ReturnType<typeof setTimeout> | null = null
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

  setLocalPlayback(enabled: boolean): void {
    this.player.setLocalPlayback(enabled)
  }

  attachHostOutput(handler: (stream: MediaStream) => void): void {
    this.player.attachHostOutput(handler)
  }

  setInputStream(stream: MediaStream | null): void {
    this.mic?.setInputStream(stream)
  }

  close(): void {
    this.opened = false
    this.clearDraftTimer()
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
    this.syncDraft(parsed.holdDraft)
    if (text(asRecord(event).type) === 'response.done') this.player.finish()
  }

  /** Финал пришёл — таймер снять. Черновик после конца речи — отдать, если финал не придёт. */
  private syncDraft(hold: boolean): void {
    if (!hold) {
      this.clearDraftTimer()
      return
    }
    if (this.draftTimer) return
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null
      const released = grokReleaseDraft(this.turn)
      this.turn = released.turn
      if (released.event) this.emit(released.event)
    }, grokTranscriptSettleMs)
  }

  private clearDraftTimer(): void {
    if (!this.draftTimer) return
    clearTimeout(this.draftTimer)
    this.draftTimer = null
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

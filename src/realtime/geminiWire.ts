import { hostInstructions, withoutHostRules } from '../config.ts'
import { readIsolateSessionHistory } from './models.ts'
import { base64ToPcm, pcmToBase64, PcmMic, PcmPlayer } from './pcm.ts'
import { sessionTools } from './tools.ts'
import type { VoiceSink, VoiceWire } from './wire.ts'
import { geminiTempoRule } from '../options.ts'

const inputRate = 16_000
const outputRate = 24_000

/** Переподключение: не больше попыток, задержка растёт и ограничена сверху. */
const reconnectMaxAttempts = 5
const reconnectBaseDelayMs = 500
const reconnectMaxDelayMs = 8_000
/** Столько попыток с токеном; дальше — новая сессия без восстановления контекста. */
const resumptionTokenAttempts = 2
/** Сколько ждать setupComplete: молчащее соединение считается неудачей, а не зависанием. */
const setupConfirmTimeoutMs = 15_000

type Loose = Record<string, unknown>

const socketPath =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

/**
 * Схемы функций чистятся от полей OpenAI-стиля: сервер Gemini отвергает setup
 * с «Invalid JSON payload received. Unknown name "additionalProperties"».
 */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => geminiSchema(item))
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    out[key] = geminiSchema(value)
  }
  return out
}

/** `resumptionHandle` — токен прошлой сессии: reconnect продолжает её контекст вместо новой. */
export function geminiSetup(model: string, thinking: boolean, options: { resumptionHandle?: string } = {}): object {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        ...(thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
      },
      systemInstruction: { parts: [{ text: `${hostInstructions}\n\n${geminiTempoRule}` }] },
      tools: [
        {
          functionDeclarations: sessionTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: geminiSchema(tool.parameters),
            ...(thinking ? { behavior: 'NON_BLOCKING' } : {}),
          })),
        },
      ],
      inputAudioTranscription: { languageCodes: ['ru-RU'] },
      outputAudioTranscription: {},
      // Длинная партия: сжатие контекста скользящим окном снимает лимит длительности сессии,
      // а sessionResumption переносит ту же сессию на новое соединение (~10 минут жизни).
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: options.resumptionHandle ? { handle: options.resumptionHandle } : {},
    },
  }
}

/** Текст причины закрытия сокета; пусто, если сервер не оставил ни код, ни пояснения. */
export function geminiCloseNote(code: number, reason: string): string {
  const clean = reason.trim()
  if (clean) return clean
  if (code !== 1000 && code !== 1005 && code !== 1006) return `код ${code}`
  return ''
}

/** Ключ, квота, права и отсутствие модели повторами не лечатся — связь падает сразу. */
export function geminiFatalClose(reason: string): boolean {
  return /api[ _]?key|unauthenticated|unauthorized|permission|denied|quota|exhausted|resource_exhausted|not found|not supported|unsupported|deprecat|billing/i.test(reason)
}

/** Похоже, сервер отверг именно токен восстановления: следующая попытка — без него. */
export function geminiResumptionRejected(reason: string): boolean {
  return /resum|handle|expired|invalid/i.test(reason)
}

export function absorbTranscript(current: string, next: string): string {
  const piece = next.trim()
  if (!piece) return current
  if (!current) return piece
  if (piece.startsWith(current)) return piece
  if (current.endsWith(piece)) return current
  return `${current} ${piece}`.replace(/\s+/g, ' ').trim()
}

/** Текст, который модель должна произнести или по которому вызвать функцию. */
export function responseCue(event: object): { text: string; tool: string } {
  const response = asRecord(asRecord(event).response)
  const choice = asRecord(response.tool_choice)
  const tool = text(choice.name)
  const parts: string[] = []
  const instructions = withoutHostRules(text(response.instructions))
  if (instructions) parts.push(instructions)
  const input = Array.isArray(response.input) ? response.input : []
  for (const item of input) {
    const content = Array.isArray(asRecord(item).content) ? (asRecord(item).content as unknown[]) : []
    for (const part of content) {
      const line = text(asRecord(part).text)
      if (line) parts.push(line)
    }
  }
  return { text: parts.join('\n').trim(), tool }
}

/** Чтение и оценка: вопрос или эталон. В историю clientContent их не кладём. */
const sessionIsolatedPurposes = new Set(['read', 'judge', 'finalJudge'])

export function geminiBaseInstruction(): string {
  return `${hostInstructions}\n\n${geminiTempoRule}`
}

function geminiIsolatedTrigger(tool: string): string {
  if (tool) return `Выполни инструкцию этого хода и вызови ${tool}. Текст инструкции игрокам не зачитывай.`
  return 'Зачитай игрокам текст этого хода из инструкции, символ в символ, и ничего больше.'
}

export type GeminiTurnPlan = {
  messages: object[]
  /** Инструкция сессии заменена текстом хода: следующий обычный ход её вернёт. */
  isolated: boolean
}

/**
 * Ход Gemini 3.8. Чтение и оценка при флаге кладут текст в systemInstruction
 * (`contextUpdate` — она заменяется следующим ходом), а в историю уходит короткая команда.
 * Обычный ход после такого возвращает базовую инструкцию ведущей.
 */
export function geminiOutboundTurns(
  event: object,
  options: { isolateHistory: boolean; historyIsolated: boolean },
): GeminiTurnPlan {
  const record = asRecord(event)
  if (text(record.type) !== 'response.create') return { messages: [], isolated: options.historyIsolated }
  const response = asRecord(record.response)
  const cue = responseCue(event)
  if (!cue.text) return { messages: [], isolated: options.historyIsolated }
  const purpose = text(asRecord(response.metadata).purpose)
  const isolate = options.isolateHistory && sessionIsolatedPurposes.has(purpose)
  if (isolate) {
    return {
      isolated: true,
      messages: [
        {
          contextUpdate: {
            systemInstruction: { parts: [{ text: `${geminiBaseInstruction()}\n\n${cue.text}` }] },
          },
        },
        {
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: geminiIsolatedTrigger(cue.tool) }] }],
            turnComplete: true,
          },
        },
      ],
    }
  }
  const messages: object[] = []
  if (options.historyIsolated) {
    messages.push({
      contextUpdate: {
        systemInstruction: { parts: [{ text: geminiBaseInstruction() }] },
      },
    })
  }
  messages.push({
    clientContent: {
      turns: [{ role: 'user', parts: [{ text: cue.text }] }],
      turnComplete: true,
    },
  })
  return { messages, isolated: false }
}

export class GeminiWire implements VoiceWire {
  private sink: VoiceSink | null = null
  private socket: WebSocket | null = null
  private mic: PcmMic | null = null
  private player: PcmPlayer
  private responseId = ''
  /** Два хода в одну миллисекунду не должны делить id: клиент второй created отбросит. */
  private responseSerial = 0
  private said = ''
  private heard = ''
  private heardId: string | null = null
  private hearing = false
  private names = new Map<string, string>()
  private usage: Loose | null = null
  private toolTurn = false
  /** Прошлый ход заменил systemInstruction текстом чтения или оценки. */
  private historyIsolated = false
  private readonly model: string
  private readonly thinking: boolean
  /** Текущий токен восстановления: сервер обновляет его в sessionResumptionUpdate. */
  private resumptionHandle: string | null = null
  /** setupComplete уже был: значит, разрыв сокета — это разрыв живой сессии, а не неудавшийся вход. */
  private sessionLive = false
  /** close() по воле клиента: переподключаться не надо. */
  private closing = false
  private apiKey = ''
  /** Сокет умер, попытка восстановления ждёт своей очереди или идёт. */
  private reconnecting = false
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  /** События игры, посланные в разрыв: доставляются после setupComplete ровно один раз. */
  private outbox: object[] = []
  /** Подтверждение setup текущего сокета; rejecting — причина от close-кадра. */
  private confirmed: Promise<void> = new Promise((resolve) => resolve())
  private confirmResolve: (() => void) | null = null
  private confirmReject: ((reason: Error) => void) | null = null
  private confirmTimer: number | null = null

  constructor(model: string, thinking: boolean) {
    this.model = model
    this.thinking = thinking
    this.player = new PcmPlayer(
      outputRate,
      () => this.emit({ type: 'output_audio_buffer.started', response_id: this.responseId }),
      () => this.emit({ type: 'output_audio_buffer.stopped', response_id: this.responseId }),
    )
  }

  async open(apiKey: string, sink: VoiceSink, options?: { captureMic?: boolean }): Promise<void> {
    this.close()
    this.sink = sink
    this.apiKey = apiKey
    this.closing = false
    this.sessionLive = false
    this.resumptionHandle = null
    this.reconnecting = false
    this.reconnectAttempts = 0
    this.outbox = []
    this.responseId = ''
    this.historyIsolated = false
    this.said = ''
    this.heard = ''
    this.heardId = null
    this.hearing = false
    this.names.clear()
    const mic = new PcmMic(inputRate, (pcm) => this.sendPcm(pcm))
    try {
      await mic.open({ captureMic: options?.captureMic !== false })
    } catch (error) {
      throw new Error(micError(error))
    }
    this.mic = mic
    await this.openSocket(apiKey, null)
  }

  send(event: object): boolean {
    const record = asRecord(event)
    const type = text(record.type)
    if (type === 'session.update') return true
    if (type === 'output_audio_buffer.clear') {
      this.player.stop()
      queueMicrotask(() => this.emit({ type: 'output_audio_buffer.cleared' }))
      return true
    }
    if (type === 'input_audio_buffer.clear') return true
    if (type === 'response.cancel') {
      this.player.stop()
      return this.deliver({ clientContent: { turnComplete: false } })
    }
    if (type === 'response.create') {
      const cue = responseCue(event)
      const plan = geminiOutboundTurns(event, {
        isolateHistory: readIsolateSessionHistory(),
        historyIsolated: this.historyIsolated,
      })
      this.toolTurn = Boolean(cue.tool)
      this.said = ''
      this.responseId = `gem-${Date.now()}-${++this.responseSerial}`
      if (!cue.text || plan.messages.length === 0) return false
      for (const message of plan.messages) {
        if (!this.deliver(message)) return false
      }
      this.historyIsolated = plan.isolated
      // Сервер Gemini не шлёт response.created и не эхомит метку хода.
      // Провод сообщает свой id без metadata: клиент связывает его с этой отправкой.
      // Метку turn не выдумываем — инвариант 9, контроллер не чинится под один дамп.
      this.emit({
        type: 'response.created',
        response: { id: this.responseId, status: 'in_progress', output: [] },
      })
      return true
    }
    if (type === 'conversation.item.create') {
      const item = asRecord(record.item)
      if (item.type !== 'function_call_output') return true
      const id = text(item.call_id)
      const name = this.names.get(id) ?? ''
      let response: unknown = {}
      if (typeof item.output === 'string') {
        try {
          response = JSON.parse(item.output) as unknown
        } catch {
          response = { result: item.output }
        }
      }
      if (!response || typeof response !== 'object') response = { result: response }
      return this.deliver({
        toolResponse: { functionResponses: [{ id, name, response }] },
      })
    }
    return true
  }

  setMicEnabled(enabled: boolean): void {
    this.mic?.setEnabled(enabled)
    if (!enabled) this.socketSend({ realtimeInput: { audioStreamEnd: true } })
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
    this.closing = true
    this.sessionLive = false
    this.reconnecting = false
    this.reconnectAttempts = 0
    this.outbox = []
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearConfirm()
    this.player.stop()
    this.mic?.close()
    this.mic = null
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  }

  private sendPcm(pcm: Int16Array): void {
    this.socketSend({
      realtimeInput: {
        audio: { data: pcmToBase64(pcm), mimeType: `audio/pcm;rate=${inputRate}` },
      },
    })
  }

  private openSocket(apiKey: string, resumption: string | null): Promise<void> {
    const socket = new WebSocket(`${socketPath}?key=${encodeURIComponent(apiKey)}`)
    this.socket = socket
    socket.binaryType = 'blob'
    // Подтверждение setup этого сокета: reject закрывает попытку переподключения,
    // а до client-ового session.updated ждать нельзя — open() обязан resolve по отправке setup.
    this.confirmed = new Promise<void>((resolve, reject) => {
      this.confirmResolve = resolve
      this.confirmReject = reject
    })
    this.confirmed.catch(() => {})
    // Сервер может замолчать на полуоткрытом соединении: без таймаута попытка зависнет навсегда.
    this.confirmTimer = window.setTimeout(() => this.failConfirm('Gemini не подтвердил настройки'), setupConfirmTimeoutMs)
    return new Promise((resolve, reject) => {
      let settled = false
      const rejectOnce = (message: string) => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }
      socket.addEventListener('open', () => {
        if (!this.socketSend(geminiSetup(this.model, this.thinking, resumption ? { resumptionHandle: resumption } : {}))) {
          rejectOnce('Канал Gemini не открылся')
          return
        }
        settled = true
        resolve()
      })
      socket.addEventListener('message', (event) => {
        if (this.socket === socket) void this.onMessage(event.data)
      })
      socket.addEventListener('close', (event) => {
        if (this.socket === socket) this.socket = null
        const note = geminiCloseNote(event.code, typeof event.reason === 'string' ? event.reason : '')
        const message = note ? `Канал Gemini закрылся: ${note}` : 'Канал Gemini закрылся'
        // setup не подтверждён: ждущий connect увидит причину сразу, без 15-секундного таймаута
        this.failConfirm(message)
        if (!settled) {
          rejectOnce(message)
          return
        }
        // Разрыв живой сессии; неудача самой попытки переподключения идёт через её промис.
        if (this.sessionLive && !this.reconnecting) this.handleDisconnect(note)
      })
    })
  }

  /** Отправка сейчас или в отложенную очередь, пока соединение восстанавливается. */
  private deliver(message: object): boolean {
    const socket = this.socket
    if (socket && socket.readyState === WebSocket.OPEN) return this.socketSend(message)
    if (this.reconnecting) {
      this.outbox.push(message)
      return true
    }
    return false
  }

  private flushOutbox(): void {
    const pending = this.outbox
    this.outbox = []
    for (const message of pending) this.socketSend(message)
  }

  /** setup так и не подтверждён: сообщить ждущему причину и погасить ожидание. */
  private failConfirm(message: string): void {
    if (this.confirmReject === null) return
    const reject = this.confirmReject
    this.clearConfirm()
    this.emit({ type: 'session.wait-failed', message })
    reject(new Error(message))
  }

  private clearConfirm(): void {
    if (this.confirmTimer !== null) {
      window.clearTimeout(this.confirmTimer)
      this.confirmTimer = null
    }
    this.confirmResolve = null
    this.confirmReject = null
  }

  /** Сокет живой сессии закрылся. Фатальная причина роняет связь, остальное — переподключение. */
  private handleDisconnect(note: string): void {
    if (this.closing) return
    if (geminiFatalClose(note)) {
      this.failLink(note ? `Gemini оборвал сессию: ${note}` : 'Gemini оборвал сессию')
      return
    }
    this.scheduleReconnect(note)
  }

  private scheduleReconnect(note: string): void {
    if (this.reconnectTimer !== null) return
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > reconnectMaxAttempts) {
      this.failLink(`Gemini не восстановился за ${reconnectMaxAttempts} попыток${note ? `: ${note}` : ''}`)
      return
    }
    const delay = Math.min(reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1), reconnectMaxDelayMs)
    this.emit({ type: 'gemini.reconnect', attempt: this.reconnectAttempts, delayMs: delay, reason: note })
    this.reconnecting = true
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnectNow()
    }, delay)
  }

  private async reconnectNow(): Promise<void> {
    if (this.closing) return
    const handle = this.resumptionHandle
    try {
      await this.openSocket(this.apiKey, handle)
      await this.confirmed
      this.reconnecting = false
      this.reconnectAttempts = 0
      // Токен мог не приняться: сессия теперь новая, контекст модели пуст —
      // следующий ход принесёт свои инструкции, как после перезагрузки страницы.
      this.emit({ type: 'gemini.reconnected', resumed: Boolean(handle) })
      this.flushOutbox()
      return
    } catch (error) {
      if (this.closing) return
      const message = error instanceof Error ? error.message : 'Канал Gemini закрылся'
      const note = message.replace(/^Канал Gemini закрылся: /, '')
      if (geminiFatalClose(note)) {
        this.failLink(`Gemini не принял переподключение: ${note}`)
        return
      }
      // Похоже на отказ токена восстановления — следующая попытка начнёт новую сессию.
      if (handle && (geminiResumptionRejected(note) || this.reconnectAttempts >= resumptionTokenAttempts)) {
        this.resumptionHandle = null
      }
      this.scheduleReconnect(note)
    }
  }

  /** Переподключение исчерпано или бессмысленно: связь падает, игру ведёт контроллер. */
  private failLink(message: string): void {

    this.reconnecting = false
    this.outbox = []
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.sink?.closed(message)
  }

  private async onMessage(data: unknown): Promise<void> {
    const raw = await messageText(data)
    if (!raw) return
    let message: Loose
    try {
      message = JSON.parse(raw) as Loose
    } catch {
      return
    }
    if ('setupComplete' in message) {
      this.sessionLive = true
      const resolve = this.confirmResolve
      this.clearConfirm()
      resolve?.()
      this.emit({ type: 'session.updated' })
      return
    }
    // Сервер обновляет токен восстановления; храним только помеченный resumable.
    const update = asRecord(message.sessionResumptionUpdate)
    const newHandle = text(update.newHandle)
    if (newHandle && update.resumable === true) this.resumptionHandle = newHandle
    if (message.usageMetadata && typeof message.usageMetadata === 'object') {
      this.usage = message.usageMetadata as Loose
    }
    if (message.voiceActivity && typeof message.voiceActivity === 'object') {
      this.onVoice(message.voiceActivity as Loose)
    }
    if (message.toolCall && typeof message.toolCall === 'object') {
      this.onTool(message.toolCall as Loose)
    }
    const content = asRecord(message.serverContent)
    if (Object.keys(content).length) this.onContent(content)
    if (message.goAway) {
      // Сервер скоро закроет соединение (~10 минут жизни): ждём его close и переподключаемся.
      const left = text(asRecord(message.goAway).timeLeft)
      this.emit({ type: 'gemini.goaway', timeLeft: left })
    }
  }

  private onVoice(activity: Loose): void {
    const kind = text(activity.type)
    if (kind === 'ACTIVITY_START') {
      this.hearing = true
      this.heard = ''
      this.heardId = `gem-in-${Date.now()}`
      this.emit({ type: 'input_audio_buffer.speech_started', item_id: this.heardId })
      return
    }
    if (kind !== 'ACTIVITY_END') return
    this.hearing = false
    this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: this.heardId })
    if (this.heard) this.emitCompleted()
  }

  private onTool(call: Loose): void {
    const functions = Array.isArray(call.functionCalls) ? call.functionCalls : []
    const first = asRecord(functions[0])
    const id = text(first.id)
    const name = text(first.name)
    if (!id || !name) return
    this.names.set(id, name)
    const args = first.args
    this.emit({
      type: 'response.done',
      response: {
        id: this.responseId || `gem-${id}`,
        usage: usageOf(this.usage),
        output: [
          {
            type: 'function_call',
            name,
            call_id: id,
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          },
        ],
      },
    })
    this.usage = null
  }

  private onContent(content: Loose): void {
    const input = asRecord(content.inputTranscription).text
    if (typeof input === 'string' && input.trim()) {
      this.heard = absorbTranscript(this.heard, input)
      if (!this.hearing && this.heardId) this.emitCompleted()
      else this.emitPartial()
    }
    const interim = asRecord(content.interimInputTranscription).text
    if (typeof interim === 'string' && interim.trim()) {
      this.heard = absorbTranscript(this.heard, interim)
      this.emitPartial()
    }
    const output = asRecord(content.outputTranscription).text
    if (typeof output === 'string' && output.trim()) {
      this.said = absorbTranscript(this.said, output)
      if (!this.toolTurn) {
        this.emit({
          type: 'response.output_audio_transcript.done',
          response_id: this.responseId,
          transcript: this.said,
        })
      }
    }
    if (!this.toolTurn) this.playTurn(content.modelTurn)
    if (content.interrupted === true) this.player.stop()
    const status = text(content.interactionStatus)
    const stillThinking = status === 'IN_PROGRESS'
    if (content.turnComplete === true && !stillThinking) this.finishTurn()
  }

  private playTurn(turn: unknown): void {
    const parts = Array.isArray(asRecord(turn).parts) ? (asRecord(turn).parts as unknown[]) : []
    for (const part of parts) {
      const inline = asRecord(asRecord(part).inlineData)
      const data = text(inline.data)
      if (!data) continue
      const mime = text(inline.mimeType)
      if (mime && !mime.includes('audio')) continue
      this.player.enqueue(base64ToPcm(data))
    }
  }

  private finishTurn(): void {
    if (this.toolTurn) return
    this.emit({
      type: 'response.done',
      response: {
        id: this.responseId,
        usage: usageOf(this.usage),
        output: this.said
          ? [{ type: 'message', content: [{ type: 'audio', transcript: this.said }] }]
          : [],
      },
    })
    this.usage = null
    this.player.finish()
  }

  private emitPartial(): void {
    if (!this.heardId || !this.heard) return
    this.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: this.heardId, transcript: this.heard })
  }

  private emitCompleted(): void {
    const itemId = this.heardId
    const transcript = this.heard
    if (!itemId || !transcript) return
    this.heard = ''
    this.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript,
    })
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

function usageOf(meta: Loose | null): Loose | undefined {
  if (!meta) return undefined
  const input = number(meta.promptTokenCount)
  const output = number(meta.candidatesTokenCount) || number(meta.responseTokenCount)
  if (!input && !output) return undefined
  return { input_tokens: input, output_tokens: output }
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return data.text()
  return ''
}

function micError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Нет доступа к микрофону. Разрешите его в браузере и нажмите «Начать игру» снова.'
  }
  if (error instanceof Error && error.message) return error.message
  return 'Не удалось открыть микрофон'
}

function asRecord(value: unknown): Loose {
  return value && typeof value === 'object' ? (value as Loose) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

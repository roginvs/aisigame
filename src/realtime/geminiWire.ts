import { hostInstructions, withoutHostRules } from '../config.ts'
import { base64ToPcm, pcmToBase64, PcmMic, PcmPlayer } from './pcm.ts'
import { sessionTools } from './tools.ts'
import type { VoiceSink, VoiceWire } from './wire.ts'

const inputRate = 16_000
const outputRate = 24_000

type Loose = Record<string, unknown>

const socketPath =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

export function geminiSetup(model: string, thinking: boolean): object {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        ...(thinking ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
      },
      systemInstruction: { parts: [{ text: hostInstructions }] },
      tools: [
        {
          functionDeclarations: sessionTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(thinking ? { behavior: 'NON_BLOCKING' } : {}),
          })),
        },
      ],
      inputAudioTranscription: { languageCodes: ['ru-RU'] },
      outputAudioTranscription: {},
    },
  }
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

export class GeminiWire implements VoiceWire {
  private sink: VoiceSink | null = null
  private socket: WebSocket | null = null
  private mic: PcmMic | null = null
  private player: PcmPlayer
  private opened = false
  private responseId = ''
  private said = ''
  private heard = ''
  private heardId: string | null = null
  private hearing = false
  private names = new Map<string, string>()
  private usage: Loose | null = null
  private toolTurn = false
  private readonly model: string
  private readonly thinking: boolean

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
    this.responseId = ''
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
    await this.openSocket(apiKey)
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
      return this.socketSend({ clientContent: { turnComplete: false } })
    }
    if (type === 'response.create') {
      const cue = responseCue(event)
      this.toolTurn = Boolean(cue.tool)
      this.said = ''
      this.responseId = `gem-${Date.now()}`
      if (!cue.text) return false
      return this.socketSend({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: cue.text }] }],
          turnComplete: true,
        },
      })
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
      return this.socketSend({
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
    this.opened = false
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

  private openSocket(apiKey: string): Promise<void> {
    const socket = new WebSocket(`${socketPath}?key=${encodeURIComponent(apiKey)}`)
    this.socket = socket
    socket.binaryType = 'blob'
    return new Promise((resolve, reject) => {
      let settled = false
      const rejectOnce = (message: string) => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }
      socket.addEventListener('open', () => {
        if (!this.socketSend(geminiSetup(this.model, this.thinking))) {
          rejectOnce('Канал Gemini не открылся')
          return
        }
        settled = true
        this.opened = true
        resolve()
      })
      socket.addEventListener('message', (event) => {
        void this.onMessage(event.data)
      })
      socket.addEventListener('error', () => {
        if (this.opened) this.sink?.closed('Соединение с Gemini прервалось')
        else rejectOnce('Соединение с Gemini прервалось')
      })
      socket.addEventListener('close', () => {
        if (!this.opened) {
          rejectOnce('Канал Gemini закрылся')
          return
        }
        this.opened = false
        this.sink?.closed('Канал Gemini закрылся')
      })
    })
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
      this.emit({ type: 'session.updated' })
      return
    }
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
    if (message.goAway) this.sink?.closed('Gemini закрывает сессию')
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

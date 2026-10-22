import { diag } from '../debug/diag.ts'
import { gameAudioContext, onAudioOutputsReopen, recreateStreamElement, reopenAudioOutputs, unlockAudio } from '../audio/beep.ts'
import { createHostOutputReader } from './hostOutputLevel.ts'
import { gameConfig, hostInstructions, withHostRules } from '../config.ts'
import { recordResponseUsage, resetUsage } from './usage.ts'
import { livePlayerChatVisible } from './liveSpeech.ts'
import { clearLivePlayerLine, editChatLine, logTrace, pushHostLine, pushPlayerLine, pushTrace, setLivePlayerLine } from '../debug/trace.ts'
import { checkHostUtterance } from '../debug/suspicious.ts'
import { outputCut, outputFlushWaitMs, timersAfterPlaybackStarted, timersAfterResponseDone } from './playback.ts'
import type { HostAudioTimers, OutputCutState } from './playback.ts'
import { openAiVadEagerness, freeReplyMaxOutputTokens, hostCutCaptionWaitMs } from '../options.ts'
import { cutCaption, HostPace } from './hostCaption.ts'
import { speechDurationMs } from './utterance.ts'
import { isolatedCue, isolatedToolResponse, revealedAnswer, saysAnswer, speechMatches, speechReport, speechOverruns, verbatimResponse } from './speechMatch.ts'
import { AudioItems, type AudioReference, type AudioItemReady } from './audioItems.ts'
import { audioJudgmentCapable, type JudgmentCapabilities, type JudgeRequestContext } from './judgmentRequest.ts'
import { sessionTools, toolPurposes } from './tools.ts'
import { createSilentMicStream } from './pcm.ts'
import type { VoiceWire } from './wire.ts'
import { ItemPrompts, echoesAnyPrompt } from './itemPrompts.ts'
import { ResponseRequests } from './responseRequests.ts'
import { transcriptionConfidence, transcriptOf, type StoredTranscript } from './utterance.ts'

export type LinkStatus = {
  connection: 'idle' | 'connecting' | 'connected' | 'error'
  mic: 'idle' | 'requesting' | 'live' | 'muted' | 'error'
  host: 'idle' | 'speaking' | 'blocked'
}

type LooseEvent = Record<string, unknown> & { type?: string }

type SpeechTurn = {
  purpose: string
  turn: number
  started: boolean
  done: boolean
  expect?: string
  isolated: boolean
  retries: number
  ended: boolean
  liveResponseId: string | null
  dropResponseId: string | null
  ignoreResponseId: string | null
  itemId: string | null
  chatNote?: (spoken: string) => string
  /** Свободная реплика с эталоном: если ответа в ней нет, переспрашиваем его дословно. */
  mustSay?: string
  /** Накопленная расшифровка дословной фразы — чтобы оборвать «довесок» (ответ после вопроса). */
  liveTranscript?: string
  /** Вопрос уже сгенерирован целиком, пошёл довесок: генерацию остановили, звук доигрывает до `stopped`. */
  overran?: boolean
  /** Date.now() на output_audio_buffer.started — позиция звука при обрыве, если truncated не придёт. */
  playStartedAt?: number
}

export type ToolCall = {
  name: string
  callId: string
  arguments: unknown
}

const callsUrl = 'https://api.openai.com/v1/realtime/calls'

/** Одна настройка распознавания для старта сессии и для смены подсказки. */
export const transcriptionConfig = { model: 'gpt-4o-mini-transcribe', language: 'ru' } as const

function sessionBody(model: string) {
  return {
    type: 'realtime',
    model,
    instructions: hostInstructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        noise_reduction: { type: 'far_field' },
        transcription: { ...transcriptionConfig },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: openAiVadEagerness,
          create_response: false,
          interrupt_response: false,
        },
      },
      output: {
        voice: gameConfig.voice,
        speed: gameConfig.welcomeSpeechSpeed,
      },
    },
    tools: sessionTools,
    tool_choice: 'auto',
    include: ['item.input_audio_transcription.logprobs'],
  }
}

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Нет доступа к микрофону. Разрешите его в браузере и нажмите «Начать игру» снова.'
  }
  if (error instanceof Error && error.message) return error.message
  return 'Не удалось подключиться'
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 280 ? `${clean.slice(0, 280)}…` : clean
}

type CutSource = 'audio_end_ms' | 'оценка по часам' | 'звук не начинался'

/** Заголовок записи лога об обрыве: кто/почему, сколько сыграно и откуда, что в чате. */
export function cutTraceTitle(reason: string, playedMs: number, source: CutSource, shown: string): string {
  return `реплика ведущей оборвана (${reason}) на ${playedMs} мс [${source}]; в чате: ${shown ? `«${shown}»` : 'строка убрана'}`
}

export class RealtimeClient {
  readonly model: string
  private wire: VoiceWire | null
  private wireOpen = false
  private micLive = false
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audio = new Audio()
  /** Android: после микрофона голос ведущей играет новый элемент — в потоке «звонок», под качелькой. */
  private stopReopen: () => void = () => undefined
  private outputMuted = false
  private localPlayback = true
  /** Клон дорожки ведущей в анализатор (OpenAI без провода): один и тот же трек в <audio> и в Web Audio глушит элемент. */
  private hostOutputAnalyser: AnalyserNode | null = null
  private hostAnalyserTeardown: (() => void) | null = null
  private readonly readHostOutput: (analyser: AnalyserNode | null) => number = createHostOutputReader()
  /** itemId → когда пришёл speech_stopped (для задержки расшифровки в дебаге). */
  private speechStoppedAt = new Map<string, number>()
  private audioItems = new AudioItems()
  private judgeRequests = new Map<string, {
    context: JudgeRequestContext
    responseId?: string
    ended: boolean
    release: () => void
    finish: (call: ToolCall | null, error?: string) => void
  }>()
  private judgeResponseIds = new Map<string, string>()
  private sessionToken = 0
  private speech: SpeechTurn | null = null
  private fallbackTimer: number | null = null
  private hardTimer: number | null = null
  private flushTimer: number | null = null
  private playbackResponseId: string | null = null
  private pendingSpeak: string | null = null
  private outputFlush: 'idle' | 'inflight' = 'idle'
  private toolMode: 'text' | 'audio' = 'text'
  private pendingTool: {
    name: string
    instructions: string
    purpose: string
    turn: number
    isolated: boolean
    tool?: { name: string }
    audioItemId?: string
    /** Конкретная отправка response.create; повтор этого же хода получает новый token. */
    responseToken: number | null
    /** Повтор хода, когда ответ пришёл без вызова функции (Qwen иногда отвечает текстом). */
    retries: number
  } | null = null
  /** Isolated tool calls use conversation:none — their call_id is not in the session. */
  private lastToolIsolated = false
  private inputStartedAt: number | null = null
  /** `audio_start_ms` из speech_started — длительность по аудиобуферу, а не по времени прихода событий. */
  private inputAudioStartMs: number | null = null
  /** Идущие ответы модели: unscoped `response.cancel` шлём только при них (иначе `response_cancel_not_active`). */
  private activeResponses = new Set<string>()
  private responseRequests = new ResponseRequests()
  private inputItemId: string | null = null
  /** Запасной commit: длительность реплики, которую видит уровень, а модель — нет (fa584db п. 1). */
  private pendingForcedUtterance: { durationMs: number } | null = null
  private itemPrompts = new ItemPrompts()
  private promptEchoLogged = new Set<string>()
  private transcripts = new Map<string, StoredTranscript>()
  /** Реплики ведущей (item_id), уже отданные в чат по готовой расшифровке: response.done их не повторяет. */
  private hostItemsInChat = new Set<string>()
  /** Подпись свободной реплики уже в чате: при нашем обрыве её правим (до места обрыва и «…» или убираем). */
  private shownCaptions = new Map<string, { entryId: number; text: string; startedAt?: number }>()
  /** Реплики, оборванные нами: itemId → сыгранные мс (null — ждём truncated), время обрыва по часам. */
  private cutItems = new Map<string, { reason: string; playedMs: number | null; fallbackMs: number; waiters: Array<() => void> }>()
  private hostPace = new HostPace()
  /** audio_end_ms из conversation.item.truncated — если обрыв отмечен уже после события. */
  private truncatedMs = new Map<string, number>()
  private transcriptWaiters = new Map<string, Array<(text: string) => void>>()
  /** Пока открыта попытка ответа: в чат только после allow / не после suppress. */
  private playerChatGated = false
  private playerChatAllowed = new Set<string>()
  private playerChatSuppressed = new Set<string>()
  private playerChatPending = new Map<string, string>()
  private playerChatPublished = new Set<string>()
  private livePartials = new Map<string, string>()
  private dropped = false
  private hostOutputHandler: ((stream: MediaStream) => void) | null = null
  private usingExternalInput = false

  onLink: (patch: Partial<LinkStatus>) => void = () => {}
  onFailure: (message: string) => void = () => {}
  onAudioFinished: (info: { purpose: string; turn: number }) => void = () => {}
  onToolCall: (call: ToolCall | null, purpose: string, turn: number) => void = () => {}
  onSpeechStarted: (info?: { itemId: string | null }) => void = () => {}
  onSpeechStopped: (info: { durationMs: number; itemId: string | null }) => void = () => {}

  constructor(options: { model?: string; wire?: VoiceWire | null } = {}) {
    this.model = options.model ?? gameConfig.model
    this.wire = options.wire ?? null
  }

  judgmentCapabilities(): JudgmentCapabilities {
    const supported = !this.wire && audioJudgmentCapable(this.model)
    return { isolatedAudioReference: supported, parallelOutOfBand: supported, model: this.model }
  }

  audioReference(itemId: string): AudioReference { return this.audioItems.reference(itemId) }

  waitForAudioItem(ref: AudioReference, deadlineAt: number, signal?: AbortSignal): Promise<AudioItemReady> {
    return this.audioItems.wait(ref, deadlineAt, signal)
  }

  /** Independent out-of-band request: never changes host playback/pendingTool. */
  requestAudioJudgment(context: JudgeRequestContext, instructions: string, signal?: AbortSignal): Promise<ToolCall> {
    if (!this.judgmentCapabilities().isolatedAudioReference) return Promise.reject(new Error('audio-unsupported'))
    if (!this.audioItems.status(context.audio).ready) return Promise.reject(new Error('audio-item-not-ready'))
    if (signal?.aborted) return Promise.reject(new Error('cancelled'))
    if ([...this.judgeRequests.values()].some((job) => !job.ended && job.context.role === context.role)) return Promise.reject(new Error('audio-request-busy'))
    return new Promise((resolve, reject) => {
      const request = {
        context, responseId: undefined as string | undefined, ended: false,
        release: this.audioItems.pin(context.audio),
        finish: (call: ToolCall | null, error?: string) => {
          if (request.ended) return
          request.ended = true
          request.release()
          signal?.removeEventListener('abort', abort)
          if (error || !call) reject(new Error(error || 'missing-judge-tool'))
          else resolve(call)
        },
      }
      const abort = () => {
        request.finish(null, 'cancelled')
        if (request.responseId) this.send({ type: 'response.cancel', response_id: request.responseId })
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.judgeRequests.set(context.requestId, request)
      this.trimJudgeRequests()
      const response = isolatedToolResponse({
        name: 'submitAnswerJudgment', instructions, purpose: 'judge', turn: context.turn,
        mode: 'text', tools: sessionTools, audioItemId: context.audio.itemId,
        metadata: { requestId: context.requestId, source: 'audio', role: context.role,
          sessionGeneration: String(context.audio.sessionGeneration), attemptId: String(context.attemptId),
          questionId: context.questionId, playerId: String(context.playerId) },
      })
      if (!this.send({ type: 'response.create', event_id: context.requestId, response })) request.finish(null, 'channel-closed')
    })
  }

  /** Caption is exactly the authoritative heard; late ASR cannot rewrite it. */
  publishAudioPlayerChat(itemId: string | null, heard: string): void {
    if (!itemId || this.playerChatPublished.has(itemId)) {
      diag('чат', 'строка оценки: уже показана — дубль отброшен', { itemId, source: 'оценка' })
      return
    }
    diag('чат', 'строка оценки показана', { itemId, source: 'оценка', chars: heard.length })
    this.suppressPlayerChat(itemId)
    this.playerChatPublished.add(itemId)
    pushPlayerLine(heard.trim() || 'речь не распознана', itemId)
  }

  private trimJudgeRequests(): void {
    for (const [id, job] of this.judgeRequests) {
      if (this.judgeRequests.size <= 200) break
      if (job.ended) {
        this.judgeRequests.delete(id)
        if (job.responseId) this.judgeResponseIds.delete(job.responseId)
      }
    }
  }

  private resetAudioJudgments(): void {
    for (const job of this.judgeRequests.values()) job.finish(null, 'session-changed')
    this.judgeRequests.clear()
    this.judgeResponseIds.clear()
    this.audioItems.reset()
  }

  async connect(apiKey: string, options?: { captureMic?: boolean }): Promise<void> {
    this.stopSession()
    this.dropped = false
    resetUsage()
    const token = this.sessionToken
    const alive = () => token === this.sessionToken
    const captureMic = options?.captureMic !== false
    this.onLink({
      connection: 'connecting',
      mic: captureMic ? 'requesting' : 'muted',
      host: 'idle',
    })
    unlockAudio()
    if (this.wire) {
      await this.connectWire(apiKey, token, alive, { captureMic })
      return
    }

    let mic: MediaStream
    try {
      if (captureMic) {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        reopenAudioOutputs()
      } else {
        mic = createSilentMicStream()
      }
    } catch (error) {
      this.onLink({ connection: 'error', mic: 'error' })
      throw new Error(errorText(error))
    }
    if (!alive()) {
      mic.getTracks().forEach((track) => track.stop())
      return
    }
    this.mic = mic
    for (const track of mic.getAudioTracks()) track.enabled = false
    this.onLink({ mic: 'muted' })

    const pc = new RTCPeerConnection()
    this.pc = pc
    this.audio.autoplay = true
    pc.ontrack = (event) => {
      const [stream] = event.streams
      if (!stream || !alive()) return
      this.audio.srcObject = stream
      this.attachHostAnalyser(stream)
      this.stopReopen()
      this.stopReopen = onAudioOutputsReopen(() => {
        const current = this.audio.srcObject
        if (current instanceof MediaStream) this.audio = recreateStreamElement(this.audio, current)
      })
      this.hostOutputHandler?.(forkHostStream(stream))
      void this.audio.play().then(
        () => this.onLink({ host: 'idle' }),
        () => this.onLink({ host: 'blocked' }),
      )
    }
    pc.onconnectionstatechange = () => {
      if (!alive()) return
      pushTrace('note', `WebRTC connectionState ${pc.connectionState}`)
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.dropLink('Соединение с OpenAI прервалось')
      }
    }
    pc.oniceconnectionstatechange = () => {
      if (!alive()) return
      pushTrace('note', `WebRTC iceConnectionState ${pc.iceConnectionState}`)
    }
    for (const track of mic.getAudioTracks()) pc.addTrack(track, mic)

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.addEventListener('message', (event) => {
      if (!alive()) return
      this.handleMessage(String(event.data))
    })
    dc.addEventListener('close', () => {
      if (!alive()) return
      this.dropLink('Канал событий закрылся')
    })
    const opened = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Канал событий не открылся')), 15_000)
      dc.addEventListener(
        'open',
        () => {
          window.clearTimeout(timer)
          if (alive()) pushTrace('note', 'канал событий открыт')
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
    await waitForIce(pc)
    if (!alive()) return
    const sdp = pc.localDescription?.sdp
    if (!sdp) throw new Error('Браузер не подготовил описание соединения')

    const answer = await exchangeSdp(apiKey, sdp, this.model)
    if (!alive()) return
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    await opened
    if (!alive()) return
    this.send({
      type: 'session.update',
      session: sessionBody(this.model),
    })
    await this.waitForSessionUpdated(token)
    if (!alive()) return
    this.onLink({ connection: 'connected' })
    pushTrace('note', 'Сессия Realtime готова')
  }

  attachHostOutput(handler: (stream: MediaStream) => void): void {
    if (this.wire) {
      this.wire.attachHostOutput(handler)
      return
    }
    this.hostOutputHandler = handler
    const current = this.audio.srcObject
    if (current instanceof MediaStream) handler(forkHostStream(current))
  }

  /** Уровень речи ведущей 0..1 (что модель говорит) — для индикатора мастера. */
  outputLevel(): number {
    if (this.wire) return this.wire.outputLevel?.() ?? 0
    return this.readHostOutput(this.hostOutputAnalyser)
  }

  private attachHostAnalyser(stream: MediaStream): void {
    this.hostAnalyserTeardown?.()
    this.hostAnalyserTeardown = null
    this.hostOutputAnalyser = null
    const track = stream.getAudioTracks()[0]
    if (!track) return
    const ctx = gameAudioContext()
    void ctx.resume()
    // Тот же трек в <audio> и в Web Audio на Chromium глушит элемент: анализатору отдаю клон.
    const clone = track.clone()
    const source = ctx.createMediaStreamSource(new MediaStream([clone]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    this.hostOutputAnalyser = analyser
    this.hostAnalyserTeardown = () => {
      this.hostOutputAnalyser = null
      source.disconnect()
      analyser.disconnect()
      clone.stop()
    }
  }

  /** null — снова микрофон из connect(); иначе replaceTrack на отправителе WebRTC. */
  setInputStream(stream: MediaStream | null): void {
    if (this.wire) {
      this.wire.setInputStream(stream)
      return
    }
    if (!this.pc) return
    const sender = this.pc.getSenders().find((item) => item.track?.kind === 'audio')
    if (!sender) return
    if (stream === null) {
      this.usingExternalInput = false
      const track = this.mic?.getAudioTracks()[0] ?? null
      void sender.replaceTrack(track)
      return
    }
    const track = stream.getAudioTracks()[0] ?? null
    if (!track) return
    this.usingExternalInput = true
    void sender.replaceTrack(track)
  }

  /** Запасной commit (fa584db п. 1): модельная VAD промахнулась, а уровни Jitsi показывают реплику — коммитим буфер сами. */
  forceInputCommit(durationMs: number): boolean {
    if (this.wire && !this.wire.supportsInputCommit) {
      pushTrace('note', 'запасной commit: провод этого провайдера не даёт input_audio_buffer.commit, реплика остаётся на его VAD')
      return false
    }
    if (this.pendingForcedUtterance) return false
    this.pendingForcedUtterance = { durationMs }
    const sent = this.send({ type: 'input_audio_buffer.commit' })
    if (!sent) this.pendingForcedUtterance = null
    return sent
  }

  setMicEnabled(enabled: boolean): void {
    if (this.wire) {
      const wasLive = this.micLive
      this.micLive = enabled
      this.wire.setMicEnabled(enabled)
      if (enabled && !this.canSend()) {
        this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
        return
      }
      this.onLink({ mic: enabled ? 'live' : 'muted' })
      if (enabled && !wasLive) this.send({ type: 'input_audio_buffer.clear' })
      return
    }
    if (!this.mic || !this.pc) return
    const sender = this.pc.getSenders().find((item) => item.track?.kind === 'audio')
    const wasLive = this.usingExternalInput
      ? Boolean(sender?.track?.enabled)
      : this.mic.getAudioTracks().some((track) => track.enabled)
    if (this.usingExternalInput) {
      if (sender?.track) sender.track.enabled = enabled
    } else {
      for (const track of this.mic.getAudioTracks()) track.enabled = enabled
    }
    if (enabled && !this.canSend()) {
      this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
      return
    }
    this.onLink({ mic: enabled ? 'live' : 'muted' })
    if (enabled && !wasLive) this.send({ type: 'input_audio_buffer.clear' })
  }

  setOutputMuted(muted: boolean): void {
    this.outputMuted = muted
    if (this.wire) this.wire.setOutputMuted(muted)
    else this.applyLocalMute()
  }

  /**
   * Мастер Jitsi: false — свой `<audio>` ведущей молчит (но играет, чтобы шли события и поток в комнату),
   * ведущую мастер слышит из комнаты, как все. Одиночная игра — true.
   */
  setLocalPlayback(enabled: boolean): void {
    if (enabled !== this.localPlayback) {
      diag('ведущая-звук', enabled ? 'локальный звук ведущей включён (без комнаты)' : 'локальный звук ведущей выключен: слышим её из комнаты')
    }
    this.localPlayback = enabled
    if (this.wire) this.wire.setLocalPlayback?.(enabled)
    else this.applyLocalMute()
  }

  private applyLocalMute(): void {
    this.audio.muted = this.outputMuted || !this.localPlayback
  }

  /** Пауза: выбросить недослушанную речь игрока. Звук ведущей тут ни при чём. */
  discardInputAudio(): void {
    this.send({ type: 'input_audio_buffer.clear' })
  }

  setSpeechSpeed(speed: number): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { output: { voice: gameConfig.voice, speed } },
      },
    })
  }

  setTranscriptionPrompt(prompt: string): void {
    this.itemPrompts.set(prompt)
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            transcription: { ...transcriptionConfig, prompt },
          },
        },
      },
    })
  }

  /** Во время ответа держим «Услышано» до принятия речи попыткой. */
  gatePlayerChat(gate: boolean): void {
    this.playerChatGated = gate
    if (!gate) {
      this.playerChatPending.clear()
      this.playerChatAllowed.clear()
      this.playerChatSuppressed.clear()
    }
  }

  allowPlayerChat(itemId: string | null): void {
    if (!itemId) return
    this.playerChatSuppressed.delete(itemId)
    this.playerChatAllowed.add(itemId)
    const pending = this.playerChatPending.get(itemId)
    if (pending !== undefined) {
      this.playerChatPending.delete(itemId)
      this.publishPlayerChat(itemId, pending)
      return
    }
    const known = this.transcripts.get(itemId)
    if (known) this.publishPlayerChat(itemId, known.text)
  }

  suppressPlayerChat(itemId: string | null): void {
    if (!itemId) return
    clearLivePlayerLine(itemId)
    this.playerChatSuppressed.add(itemId)
    this.playerChatPending.delete(itemId)
    this.playerChatAllowed.delete(itemId)
  }

  waitForTranscript(
    itemId: string | null,
    timeoutMs: number,
  ): Promise<{ text: string; arrived: boolean; confidence: number | null }> {
    // Без id нельзя отличить ответ этой попытки от предыдущей/следующей реплики.
    if (!itemId) return Promise.resolve({ text: '', arrived: false, confidence: null })
    const token = this.sessionToken
    const ready = transcriptOf(itemId, this.transcripts)
    if (ready) return Promise.resolve(ready)
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.removeTranscriptWaiter(itemId, finish)
        resolve(token === this.sessionToken ? transcriptOf(itemId, this.transcripts) ?? { text: '', arrived: false, confidence: null }
          : { text: '', arrived: false, confidence: null })
      }, timeoutMs)
      const finish = (text: string) => {
        window.clearTimeout(timer)
        resolve(token === this.sessionToken ? transcriptOf(itemId, this.transcripts) ?? { text, arrived: true, confidence: null }
          : { text: '', arrived: false, confidence: null })
      }
      const bucket = this.transcriptWaiters.get(itemId) ?? []
      bucket.push(finish)
      this.transcriptWaiters.set(itemId, bucket)
    })
  }

  private rememberTranscript(itemId: string, text: string, confidence: number | null = null): void {
    if (this.transcripts.has(itemId)) return
    this.transcripts.set(itemId, { text, confidence })
    this.livePartials.delete(itemId)
    this.itemPrompts.finished(itemId)
    clearLivePlayerLine(itemId)
    this.offerPlayerChat(itemId, text)
    const matched = this.transcriptWaiters.get(itemId) ?? []
    this.transcriptWaiters.delete(itemId)
    for (const waiter of matched) waiter(text)
  }

  /** Черновик в чате: только показ, игра его не читает. */
  private offerLivePlayerChat(itemId: string, event: LooseEvent): void {
    if (this.transcripts.has(itemId)) return
    const full = typeof event.transcript === 'string' ? event.transcript : null
    const delta = typeof event.delta === 'string' ? event.delta : ''
    const text = full ?? (this.livePartials.get(itemId) ?? '') + delta
    this.livePartials.set(itemId, text)
    if (this.livePartials.size > 16) this.livePartials.delete(this.livePartials.keys().next().value!)
    if (!livePlayerChatVisible({
      suppressed: this.playerChatSuppressed.has(itemId) || this.playerChatPublished.has(itemId),
      gated: this.playerChatGated && !this.playerChatAllowed.has(itemId),
      echo: this.isPromptEcho(text, itemId),
    })) {
      clearLivePlayerLine(itemId)
      return
    }
    setLivePlayerLine(itemId, text)
  }

  private offerPlayerChat(itemId: string, text: string): void {
    const chat = (decision: string) => diag('чат', `строка игрока: ${decision}`, { itemId, source: 'расшифровка', chars: text.length })
    if (this.isPromptEcho(text, itemId)) return chat('эхо подсказки — не показываем')
    if (this.playerChatPublished.has(itemId)) return chat('уже показана — дубль отброшен')
    if (this.playerChatSuppressed.has(itemId)) return chat('подавлена (будет текст оценки)')
    if (this.playerChatGated && !this.playerChatAllowed.has(itemId)) {
      this.playerChatPending.set(itemId, text)
      chat('отложена до кнопки')
      return
    }
    chat('показана')
    this.publishPlayerChat(itemId, text)
  }

  private publishPlayerChat(itemId: string, text: string): void {
    if (this.playerChatPublished.has(itemId) || this.playerChatSuppressed.has(itemId)) return
    if (this.isPromptEcho(text, itemId)) return
    this.playerChatPublished.add(itemId)
    pushPlayerLine(text || 'речь не распознана', itemId)
  }

  private isPromptEcho(text: string, itemId: string | null): boolean {
    const prompts = this.itemPrompts.promptsFor(itemId)
    const echo = echoesAnyPrompt(text, prompts)
    if (echo && !this.promptEchoLogged.has(itemId ?? '')) {
      this.promptEchoLogged.add(itemId ?? '')
      pushTrace('note', `распознавание повторило подсказку (${prompts.length} подсказок реплики), в чат не идёт`)
    }
    return echo
  }

  private removeTranscriptWaiter(itemId: string, finish: (text: string) => void): void {
    const left = (this.transcriptWaiters.get(itemId) ?? []).filter((waiter) => waiter !== finish)
    if (left.length) this.transcriptWaiters.set(itemId, left)
    else this.transcriptWaiters.delete(itemId)
  }

  interruptSpeech(reason = ''): void {
    diag('обрыв', `ведущую обрываем: ${reason || 'без причины'}`, {
      speaking: this.speech !== null || this.playbackResponseId !== null,
      responseId: this.playbackResponseId ?? this.speech?.liveResponseId ?? null,
      purpose: this.speech?.purpose ?? null,
    })
    this.markCut(this.speech, `оборвали мы: ${reason || 'без причины'}`)
    this.speech = null
    this.pendingSpeak = null
    this.clearFlushTimer()
    this.clearSpeechTimers()
    this.cancelActiveResponse()
    if (this.outputFlush !== 'inflight') this.sendOutputClear()
    this.playbackResponseId = null
    this.onLink({ host: 'idle' })
  }

  requestSpeech(
    purpose: string,
    turn: number,
    instructions: string,
    expect?: string,
    isolated = false,
    chatNote?: (spoken: string) => string,
  ): void {
    const ignoreResponseId = this.playbackResponseId ?? this.speech?.liveResponseId ?? null
    // Пустой буфер не сбрасываем: clear, отправленный вместе с response.create,
    // сервер иногда применяет уже после started и стирает новую фразу.
    const flushFirst = this.playbackResponseId !== null || this.outputFlush === 'inflight'
    // Новая реплика поверх ещё звучащей: прежнюю обрываем мы — подпись до места обрыва.
    if (this.speech && this.speech.started && !this.speech.ended && flushFirst) this.markCut(this.speech, `новая реплика поверх: ${purpose}`)
    this.clearFlushTimer()
    this.clearSpeechTimers()
    this.pendingSpeak = null
    this.pendingTool = null
    this.speech = {
      purpose,
      turn,
      started: false,
      done: false,
      expect,
      isolated,
      retries: 0,
      ended: false,
      liveResponseId: null,
      dropResponseId: null,
      ignoreResponseId,
      itemId: null,
      chatNote,
      mustSay: expect ? undefined : revealedAnswer(instructions),
    }
    if (expect) {
      pushHostLine(expect)
      checkHostUtterance(expect)
    }
    this.armHardLimit()
    this.cancelActiveResponse()
    if (flushFirst) {
      if (!this.canSend()) {
        this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
        return
      }
      this.holdSpeech(instructions)
      return
    }
    const sent = this.sendSpeech(instructions)
    if (!sent) this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
  }

  /** tool — суженная схема на этот запрос (enum открытых тем, вариантов ставки); иначе общая из сессии. */
  /** audioItemId — реплика игрока: модель получает её звук (item_reference), а не только расшифровку. */
  requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false, tool?: { name: string }, audioItemId?: string): void {
    this.clearSpeechTimers()
    this.clearFlushTimer()
    this.pendingSpeak = null
    this.speech = null
    this.toolMode = 'text'
    this.lastToolIsolated = isolated
    const audioReady = Boolean(audioItemId && isolated && this.judgmentCapabilities().isolatedAudioReference &&
      this.audioItems.status(this.audioItems.reference(audioItemId)).ready)
    if (audioItemId) diag('слух', `${name}: ${audioReady ? 'со звуком реплики' : 'без звука (только текст)'}`, { audioItemId })
    this.pendingTool = {
      purpose, turn, name, instructions, isolated, tool,
      audioItemId: audioReady ? audioItemId : undefined,
      responseToken: null,
      retries: 0,
    }
    this.sendToolRequest('text')
  }

  sendToolOutput(callId: string, output: unknown): void {
    // У isolated tool response conversation:none — call_id в сессии нет,
    // conversation.item.create даёт invalid_tool_call_id и только шумит в лог.
    if (this.lastToolIsolated) return
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output),
      },
    })
  }

  stopSession(): void {
    clearLivePlayerLine()
    this.livePartials.clear()
    this.sessionToken += 1
    this.resetAudioJudgments()
    this.sessionUpdatedWaiter = null
    this.clearSpeechTimers()
    this.clearFlushTimer()
    this.speech = null
    this.pendingSpeak = null
    this.playbackResponseId = null
    this.outputFlush = 'idle'
    this.pendingTool = null
    this.wireOpen = false
    this.inputAudioStartMs = null
    this.activeResponses.clear()
    this.responseRequests.reset()
    this.micLive = false
    this.wire?.close()
    this.inputStartedAt = null
    this.inputItemId = null
    this.pendingForcedUtterance = null
    this.itemPrompts.reset()
    this.transcripts.clear()
    this.hostItemsInChat.clear()
    this.shownCaptions.clear()
    this.cutItems.clear()
    this.truncatedMs.clear()
    this.transcriptWaiters.clear()
    this.playerChatGated = false
    this.playerChatAllowed.clear()
    this.playerChatSuppressed.clear()
    this.playerChatPending.clear()
    this.playerChatPublished.clear()
    const dc = this.dc
    const pc = this.pc
    const mic = this.mic
    this.dc = null
    this.pc = null
    this.mic = null
    this.hostOutputHandler = null
    this.hostAnalyserTeardown?.()
    this.hostAnalyserTeardown = null
    this.hostOutputAnalyser = null
    this.usingExternalInput = false
    if (dc) dc.onmessage = null
    if (pc) {
      pc.onconnectionstatechange = null
      pc.oniceconnectionstatechange = null
      pc.ontrack = null
      pc.close()
    }
    mic?.getTracks().forEach((track) => track.stop())
    this.audio.pause()
    this.audio.srcObject = null
    this.stopReopen()
    this.onLink({ connection: 'idle', mic: 'idle', host: 'idle' })
  }

  private canSend(): boolean {
    if (this.wire) return this.wireOpen
    return Boolean(this.dc && this.dc.readyState === 'open')
  }

  private dropLink(message: string): void {
    if (this.dropped) return
    this.dropped = true
    this.resetAudioJudgments()
    this.clearSpeechTimers()
    this.clearFlushTimer()
    this.speech = null
    this.pendingSpeak = null
    this.playbackResponseId = null
    this.outputFlush = 'idle'
    this.pendingTool = null
    const waiter = this.sessionUpdatedWaiter
    this.sessionUpdatedWaiter = null
    waiter?.({ type: 'session.wait-failed', message })
    pushTrace('note', message)
    this.onLink({ connection: 'error', mic: 'error', host: 'idle' })
    this.onFailure(message)
  }

  private cancelActiveResponse(): void {
    if (this.activeResponses.size === 0) return
    this.send({ type: 'response.cancel' })
  }

  private send(event: object, owner?: { responseToken: number | null }): boolean {
    const type = eventType(event)
    if (type === 'input_audio_buffer.clear') this.pendingForcedUtterance = null
    if (!this.canSend()) {
      pushTrace('note', `не отправлено, канал закрыт: ${type}`, event)
      return false
    }
    const record = asRecord(event)
    const request = type === 'response.create' ? this.responseRequests.sent(asRecord(record.response),
      typeof record.event_id === 'string' ? record.event_id : undefined) : null
    if (owner && request) owner.responseToken = request.token
    const outbound = request ? { ...event, event_id: request.eventId } : event
    pushTrace('out', type, outbound)
    try {
      if (this.wire) {
        const sent = this.wire.send(outbound)
        if (!sent && request) this.responseRequests.rejected(request.eventId)
        return sent
      }
      this.dc?.send(JSON.stringify(outbound))
    } catch {
      if (request) this.responseRequests.rejected(request.eventId)
      pushTrace('note', `не отправлено, канал закрыт: ${type}`, event)
      return false
    }
    return true
  }

  private sendToolRequest(mode: 'text' | 'audio'): void {
    const pending = this.pendingTool
    if (!pending) return
    this.cancelActiveResponse()
    const response = pending.isolated
      ? isolatedToolResponse({
          name: pending.name,
          instructions: pending.instructions,
          purpose: pending.purpose,
          turn: pending.turn,
          mode,
          tools: pending.tool ? sessionTools.map((tool) => (tool.name === pending.tool?.name ? pending.tool : tool)) : sessionTools,
          audioItemId: pending.audioItemId,
        })
      : {
          output_modalities: mode === 'text' ? ['text'] : ['audio'],
          tool_choice: { type: 'function', name: pending.name },
          metadata: { purpose: pending.purpose, turn: String(pending.turn) },
          instructions: withHostRules(pending.instructions),
        }
    this.send({ type: 'response.create', response }, pending)
    if (!this.canSend()) this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
  }

  private waitForSessionUpdated(token: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Сессия не подтвердила настройки')), 15_000)
      const check = (event: LooseEvent) => {
        if (token !== this.sessionToken) {
          window.clearTimeout(timer)
          reject(new Error('Подключение отменено'))
          return
        }
        if (event.type === 'session.wait-failed') {
          window.clearTimeout(timer)
          const message = typeof event.message === 'string' ? event.message : 'Сессия не открылась'
          reject(new Error(message))
          return
        }
        if (event.type === 'session.updated') {
          window.clearTimeout(timer)
          resolve()
        }
      }
      this.sessionUpdatedWaiter = check
    })
  }

  private sessionUpdatedWaiter: ((event: LooseEvent) => void) | null = null

  private async connectWire(
    apiKey: string,
    token: number,
    alive: () => boolean,
    options?: { captureMic?: boolean },
  ): Promise<void> {
    const wire = this.wire
    if (!wire) return
    try {
      await wire.open(
        apiKey,
        {
          message: (raw) => {
            if (alive()) this.handleMessage(raw)
          },
          closed: (message) => {
            if (alive()) this.dropLink(message)
          },
        },
        { captureMic: options?.captureMic !== false },
      )
    } catch (error) {
      this.onLink({ connection: 'error', mic: 'error' })
      throw error instanceof Error ? error : new Error('Не удалось подключиться')
    }
    if (!alive()) return
    this.wireOpen = true
    this.onLink({ mic: 'muted' })
    this.send({
      type: 'session.update',
      session: sessionBody(this.model),
    })
    await this.waitForSessionUpdated(token)
    if (!alive()) return
    this.onLink({ connection: 'connected' })
    pushTrace('note', 'Сессия Realtime готова')
  }

  private handleMessage(raw: string): void {
    let event: LooseEvent
    try {
      event = JSON.parse(raw) as LooseEvent
    } catch {
      return
    }
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    if (type.endsWith('.delta')) logTrace('in', type, deltaNote(event))
    else pushTrace('in', type, event)
    this.audioItems.observe(event)
    this.sessionUpdatedWaiter?.(event)
    if (type === 'session.updated') this.sessionUpdatedWaiter = null
    if (type === 'response.created' || type === 'response.done') {
      if (type === 'response.created') this.responseRequests.created(asRecord(event.response))
      const id = asRecord(event.response).id
      if (typeof id === 'string') {
        if (type === 'response.created') this.activeResponses.add(id)
        else this.activeResponses.delete(id)
      }
    }

    if (type === 'error' || type === 'invalid_request_error') {
      const error = asRecord(event.error)
      if (typeof error.event_id === 'string') this.responseRequests.rejected(error.event_id)
      // Гонка: ответ закончился раньше нашей отмены. Не ошибка и не повод проваливать tool.
      if (error.code === 'response_cancel_not_active') return
      if (error.code === 'input_audio_buffer_commit_empty') {
        // Мы сами коммитили переполненный буфер, а его уже очистили (discard/пауза) — не ошибка.
        pushTrace('note', 'запасной commit пуст: в буфере нет аудио')
        this.pendingForcedUtterance = null
        return
      }
      const message = readErrorMessage(event)
      pushTrace('note', `Ошибка API: ${message}`)
      const errorId = typeof error.event_id === 'string' ? error.event_id : ''
      const responseId = typeof error.response_id === 'string' ? error.response_id : ''
      const judge = this.judgeRequests.get(errorId || this.judgeResponseIds.get(responseId) || '')
      if (judge) { judge.finish(null, message); return }
      if (this.pendingTool && this.toolMode === 'text' && /modalit|output/i.test(message)) {
        this.toolMode = 'audio'
        this.sendToolRequest('audio')
        return
      }
      const pending = this.pendingTool
      if (pending && failsPendingTool(message, typeof error.code === 'string' ? error.code : '')) {
        // Быстрый отказ: машина сразу переспросит, а не ждёт таймаута tool.
        this.pendingTool = null
        this.onToolCall(null, toolPurposes[pending.name] ?? pending.purpose, pending.turn)
      }
      return
    }

    // Route known and cancelled judge responses before any host/generic handler.
    const response = asRecord(event.response)
    const metadata = asRecord(response.metadata)
    const responseId = typeof response.id === 'string' ? response.id : typeof event.response_id === 'string' ? event.response_id : ''
    const requestId = typeof metadata.requestId === 'string' ? metadata.requestId : this.judgeResponseIds.get(responseId)
    const nativeJudge = requestId ? this.judgeRequests.get(requestId) : undefined
    if (nativeJudge || metadata.source === 'audio' || this.judgeResponseIds.has(responseId)) {
      if (nativeJudge && type === 'response.created' && responseId) {
        nativeJudge.responseId = responseId
        this.judgeResponseIds.set(responseId, nativeJudge.context.requestId)
        if (nativeJudge.ended) this.send({ type: 'response.cancel', response_id: responseId })
      }
      if (nativeJudge && type.startsWith('response.output_audio')) {
        nativeJudge.finish(null, 'unexpected-audio-output')
        if (responseId) this.send({ type: 'response.cancel', response_id: responseId })
      }
      if (type === 'response.done') {
        recordResponseUsage(response)
        const call = readToolCall(response)
        const valid = call?.name === 'submitAnswerJudgment' && response.status === 'completed'
        nativeJudge?.finish(valid ? call : null, valid ? undefined : 'audio-response-failed')
      }
      return
    }

    if (type === 'response.created' && this.speech) {
      const response = asRecord(event.response)
      const id = typeof response.id === 'string' ? response.id : null
      if (id && this.skipsResponse(id)) return
      this.speech.liveResponseId = id
    }

    if (type === 'response.output_item.added' && this.speech) this.rememberAssistantItem(event)

    if (type === 'output_audio_buffer.started' && this.speech) {
      const responseId = typeof event.response_id === 'string' ? event.response_id : ''
      if (responseId && this.skipsResponse(responseId)) return
      this.speech.started = true
      this.speech.playStartedAt = Date.now()
      if (responseId) this.playbackResponseId = responseId
      this.syncHostAudioTimers(timersAfterPlaybackStarted(this.hostAudioTimers(), this.speech.ended))
      this.onLink({ host: 'speaking' })
    }

    if (type === 'response.output_audio_transcript.delta' && this.speech?.expect) {
      const responseId = typeof event.response_id === 'string' ? event.response_id : ''
      if (!responseId || !this.skipsResponse(responseId)) {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        this.speech.liveTranscript = (this.speech.liveTranscript ?? '') + delta
        if (!this.speech.overran && speechOverruns(this.speech.liveTranscript, this.speech.expect)) {
          // Текст обгоняет звук: хвост вопроса ещё может быть в буфере. Буфер не сбрасываем и конец
          // чтения не шлём — только останавливаем генерацию довеска; конец — по реальному `stopped`.
          pushTrace('note', `ведущая продолжила после дословной фразы — останавливаю генерацию, звук доигрывает: ${speechReport(this.speech.liveTranscript, this.speech.expect)}`, { said: this.speech.liveTranscript })
          this.speech.overran = true
          this.cancelActiveResponse()
          return
        }
      }
    }

    if (type === 'response.output_audio_transcript.done' || type === 'response.output_text.done') {
      this.rememberAssistantItem(event)
      const transcript = typeof event.transcript === 'string' ? event.transcript : ''
      const text = typeof event.text === 'string' ? event.text : ''
      const line = (transcript || text).trim()
      if (line) this.noteHostLine(event, line)
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = readItemId(event) ?? this.inputItemId
      if (itemId) this.offerLivePlayerChat(itemId, event)
    }
    if (
      type === 'conversation.item.input_audio_transcription.completed' ||
      type === 'conversation.item.input_audio_transcription.failed'
    ) {
      if (type.endsWith('.failed')) {
        pushTrace('note', `распознавание не удалось: ${readErrorMessage(event)}`)
      }
      const itemId = readItemId(event) ?? this.inputItemId ?? `anon-${Date.now()}`
      const failed = type.endsWith('.failed')
      const stoppedAt = this.speechStoppedAt.get(itemId)
      diag('слух', failed ? 'расшифровка не удалась' : 'расшифровка готова', {
        itemId,
        afterStopMs: stoppedAt === undefined ? null : Math.round(performance.now() - stoppedAt),
        chars: failed ? 0 : readTranscript(event).length,
      })
      this.speechStoppedAt.delete(itemId)
      this.rememberTranscript(itemId, failed ? '' : readTranscript(event), failed ? null : transcriptionConfidence(event.logprobs))
    }

    if (type === 'response.done') this.onResponseDone(event)
    if (type === 'output_audio_buffer.stopped') this.onPlaybackStopped(event)
    if (type === 'output_audio_buffer.cleared') this.onOutputCleared(event)
    if (type === 'conversation.item.truncated') this.onTruncated(event)
    if (type === 'input_audio_buffer.committed') {
      // Запасной commit (fa584db п. 1): обычные коммиты серверной VAD приходят без нашего ожидания —
      // реагируем только на свой. Реплика идёт обычным путём: синтетический speech_stopped
      // открывает попытку через контроллер, судья получает item по этому itemId.
      const forced = this.pendingForcedUtterance
      this.pendingForcedUtterance = null
      if (!forced) return
      const itemId = readItemId(event)
      diag('слух', 'запасной commit принят', { itemId, speechMs: Math.round(forced.durationMs) })
      if (itemId) this.speechStoppedAt.set(itemId, performance.now())
      this.onSpeechStopped({ durationMs: forced.durationMs, itemId })
      return
    }
    if (type === 'input_audio_buffer.speech_started') {
      this.inputStartedAt = performance.now()
      this.inputAudioStartMs = typeof event.audio_start_ms === 'number' ? event.audio_start_ms : null
      this.inputItemId = readItemId(event)
      this.itemPrompts.started(this.inputItemId)
      this.onSpeechStarted({ itemId: this.inputItemId })
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      const started = this.inputStartedAt
      const durationMs = speechDurationMs(this.inputAudioStartMs, event.audio_end_ms, started, performance.now())
      this.inputAudioStartMs = null
      const itemId = readItemId(event) ?? this.inputItemId
      this.inputStartedAt = null
      if (itemId) {
        this.speechStoppedAt.set(itemId, performance.now())
        if (this.speechStoppedAt.size > 50) this.speechStoppedAt.delete(this.speechStoppedAt.keys().next().value as string)
      }
      diag('слух', 'модель: конец речи', {
        itemId,
        speechMs: Math.round(durationMs),
        detectLagMs: started === null ? null : Math.round(performance.now() - started - durationMs),
      })
      this.onSpeechStopped({ durationMs, itemId })
    }
  }

  private onResponseDone(event: LooseEvent): void {
    const response = asRecord(event.response)
    recordResponseUsage(response)
    const call = readToolCall(response)
    const request = this.responseRequests.get(response)
    const earlyMeta = asRecord(response.metadata)
    const earlyPurpose = typeof earlyMeta.purpose === 'string' ? earlyMeta.purpose : request?.purpose ?? ''
    const toolResponseId = typeof response.id === 'string' ? response.id : ''
    const pendingTool = this.pendingTool
    // Даже created старого ответа может прийти ПОСЛЕ нового запроса. Без метки хода
    // принимаем только id, связанный через очередь отправок с этой конкретной отправкой.
    const unmarkedToolDone = pendingTool && !this.speech && Number.isNaN(Number(earlyMeta.turn))
      && request?.token === pendingTool.responseToken
    if (pendingTool && Number.isNaN(Number(earlyMeta.turn)) && !unmarkedToolDone &&
      (call || !request || Object.values(toolPurposes).includes(request.purpose))) {
      pushTrace('note', `поздний или неопознанный ответ без метки хода (${toolResponseId}), жду ${pendingTool.turn}`)
      return
    }
    if (pendingTool && unmarkedToolDone && (!call || call.name !== pendingTool.name)) {
      // Модель ответила текстом/пусто вместо вызова: текст не пишем в чат, один повтор
      // той же подсказки, потом быстрый отказ контроллеру (у judge/finalJudge нулевой
      // call — сразу вердикт, там отдаём штатному таймауту).
      if (pendingTool.retries < 1) {
        pendingTool.retries += 1
        const status = typeof response.status === 'string' ? response.status : 'completed'
        pushTrace('note', `${pendingTool.name}: ответ без вызова функции (${status}) — повторяю ход`)
        this.sendToolRequest(this.toolMode)
        return
      }
      pushTrace('note', `${pendingTool.name}: ответ без вызова функции и после повтора — отдаю ходу`)
      this.pendingTool = null
      if (pendingTool.purpose === 'select' || pendingTool.purpose === 'catPick' || pendingTool.purpose === 'specialBid') {
        this.onToolCall(null, toolPurposes[pendingTool.name] ?? pendingTool.purpose, pendingTool.turn)
      }
      return
    }
    if (!call && !this.speech?.expect && earlyPurpose !== 'read') {
      for (const { line, itemId } of assistantUtterances(response)) this.publishHostLine(line, earlyPurpose, itemId)
    }
    if (call && toolPurposes[call.name]) {
      // Не трогаем speech: оценка может прийти уже после таймаута, когда
      // announce/read уже идёт. Раньше здесь обнуляли речь — stopped не
      // вызывал finishSpeech, и партия зависала в announcing.
      const turn = Number(earlyMeta.turn)
      const purpose = toolPurposes[call.name]!
      const pending = this.pendingTool
      const responseId = toolResponseId
      if (pending && !Number.isNaN(turn) && turn !== pending.turn) {
        pushTrace('note', `поздний ${call.name} turn=${turn}, жду ${pending.turn}`)
        return
      }
      if (pending && request && request.token !== pending.responseToken) {
        pushTrace('note', `поздний ${call.name} от другой отправки (ответ ${responseId}), жду ${pending.turn}`)
        return
      }
      if (Number.isNaN(turn) && (!pending || !request || request.token !== pending.responseToken)) return
      if (pending && (Number.isNaN(turn) || turn === pending.turn)) this.pendingTool = null
      // Метка отсутствует: конкретную отправку уже проверили по response.created.
      this.onToolCall(call, purpose, Number.isNaN(turn) ? (pending ? pending.turn : -1) : turn)
      return
    }
    if (!this.speech) return
    const metadata = asRecord(response.metadata)
    const purpose = typeof metadata.purpose === 'string' ? metadata.purpose : ''
    const turn = Number(metadata.turn)
    const responseId = typeof response.id === 'string' ? response.id : ''
    if (responseId && this.skipsResponse(responseId)) return
    const sameTurn = purpose === '' || (purpose === this.speech.purpose && (Number.isNaN(turn) || turn === this.speech.turn))
    if (!sameTurn) return
    if (this.speech.expect) {
      const said = assistantUtterances(response)
        .map(({ line }) => line)
        .join(' ')
        .trim()
      if (!said) return
      if (!this.speech.overran && !speechMatches(said, this.speech.expect)) {
        this.rejectSpokenLine(responseId, said)
        return
      }
    }
    this.speech.done = true
    const decision = timersAfterResponseDone(this.speech, this.hostAudioTimers())
    this.syncHostAudioTimers(decision.timers)
    if (decision.wait === 'finish') this.finishSpeech('stopped')
  }

  private onPlaybackStopped(event: LooseEvent): void {
    if (!this.speech) return
    const responseId = typeof event.response_id === 'string' ? event.response_id : ''
    if (responseId && responseId === this.speech.dropResponseId) {
      pushTrace('note', 'сброшено аудио не той реплики')
      return
    }
    if (responseId && responseId === this.speech.ignoreResponseId) return
    if (!responseId || this.playbackResponseId === responseId) this.playbackResponseId = null
    this.speech.ended = true
    if (this.speech.expect && !this.speech.done) {
      if (this.fallbackTimer !== null) window.clearTimeout(this.fallbackTimer)
      this.fallbackTimer = window.setTimeout(() => {
        const speech = this.speech
        if (!speech?.expect) return
        if (speech.done && speech.ended) this.finishSpeech('stopped')
        else if (!speech.done) this.rejectSpokenLine(responseId, '')
      }, 2500)
      return
    }
    if (!this.speech.started && !this.speech.done) return
    this.finishSpeech('stopped')
  }

  private noteHostLine(event: LooseEvent, line: string): void {
    const speech = this.speech
    const responseId = typeof event.response_id === 'string' ? event.response_id : speech?.liveResponseId ?? ''
    if (responseId && speech && this.skipsResponse(responseId)) return
    pushTrace('note', `ведущая сказала: ${line}`)
    if (!speech) return
    if (speech.expect) {
      if (!speech.overran && !speechMatches(line, speech.expect)) {
        this.rejectSpokenLine(responseId, line)
        return
      }
      speech.done = true
      if (speech.ended) {
        this.clearSpeechTimers()
        this.finishSpeech('stopped')
      }
      return
    }
    this.publishHostLine(line, speech.purpose, readItemId(event))
  }

  private publishHostLine(line: string, purpose: string, itemId: string | null = null): void {
    if (itemId) {
      if (this.hostItemsInChat.has(itemId)) return
      this.hostItemsInChat.add(itemId)
      if (this.hostItemsInChat.size > 200) this.hostItemsInChat.delete(this.hostItemsInChat.values().next().value!)
    }
    const speech = this.speech
    if (speech?.mustSay && purpose === speech.purpose && !saysAnswer(line, speech.mustSay)) {
      this.missedReveal(line)
      return
    }
    const ownAnnounce = speech?.purpose === 'announce' && purpose === 'announce'
    const caption = ownAnnounce ? (speech?.chatNote?.(line).trim() ?? '') : ''
    if (ownAnnounce && speech) speech.chatNote = undefined
    const cut = itemId ? this.cutItems.get(itemId) : undefined
    if (cut) {
      // Текст пришёл уже после нашего обрыва: сразу только прозвучавшее.
      this.whenCutKnown(cut, (played, source) => {
        const shown = cutCaption(line, played, this.hostPace.msPerChar)
        pushTrace('note', cutTraceTitle(cut.reason, played, source, shown), { full: line, playedMs: played, source, shown: shown || null, msPerChar: this.hostPace.msPerChar })
        if (shown) {
          pushHostLine(shown, caption)
          checkHostUtterance(shown)
        }
      })
      return
    }
    const entryId = pushHostLine(line, caption)
    checkHostUtterance(line)
    const liveItem = itemId ?? (speech && purpose === speech.purpose ? speech.itemId : null)
    if (entryId && liveItem) {
      this.shownCaptions.set(liveItem, { entryId, text: line })
      if (this.shownCaptions.size > 50) this.shownCaptions.delete(this.shownCaptions.keys().next().value!)
    }
  }

  /** Мы обрываем реплику: запомнить, сколько её звука сыграно (точно — из truncated, иначе по часам), и поправить подпись. */
  private markCut(speech: SpeechTurn | null, reason: string): void {
    const itemId = speech?.itemId
    if (!speech || !itemId || speech.expect || this.cutItems.has(itemId)) return
    const fallbackMs = speech.started && speech.playStartedAt ? Date.now() - speech.playStartedAt : 0
    const cut = { reason, playedMs: this.truncatedMs.get(itemId) ?? (speech.started ? null : 0), fallbackMs, waiters: [] as Array<() => void> }
    this.cutItems.set(itemId, cut)
    if (this.cutItems.size > 50) this.cutItems.delete(this.cutItems.keys().next().value!)
    const shown = this.shownCaptions.get(itemId)
    if (!shown) return
    this.shownCaptions.delete(itemId)
    this.whenCutKnown(cut, (played, source) => {
      const next = cutCaption(shown.text, played, this.hostPace.msPerChar)
      pushTrace('note', cutTraceTitle(reason, played, source, next === shown.text ? shown.text : next), { full: shown.text, playedMs: played, source, shown: next || null, msPerChar: this.hostPace.msPerChar })
      if (next === shown.text) return
      editChatLine(shown.entryId, next || null)
    })
  }

  private whenCutKnown(cut: { playedMs: number | null; fallbackMs: number; waiters: Array<() => void> }, run: (playedMs: number, source: CutSource) => void): void {
    if (cut.playedMs !== null) return run(cut.playedMs, cut.playedMs === 0 ? 'звук не начинался' : 'audio_end_ms')
    let done = false
    const once = () => { if (!done) { done = true; run(cut.playedMs ?? cut.fallbackMs, cut.playedMs === null ? 'оценка по часам' : 'audio_end_ms') } }
    cut.waiters.push(once)
    window.setTimeout(once, hostCutCaptionWaitMs)
  }

  /** Реплика раскрытия без самого эталона (часто — пересказ указания): в чат не идёт, эталон — дословно. */
  private missedReveal(said: string): void {
    const speech = this.speech
    if (!speech?.mustSay) return
    const answer = speech.mustSay
    speech.mustSay = undefined
    pushTrace('note', `в реплике раскрытия нет эталона, говорю его дословно: ${said}`)
    speech.expect = answer
    speech.liveTranscript = ''
    speech.overran = false
    speech.started = false
    speech.done = false
    speech.ended = false
    speech.ignoreResponseId = speech.liveResponseId
    this.clearSpeechTimers()
    this.cancelActiveResponse()
    pushHostLine(answer)
    checkHostUtterance(answer)
    if (!this.canSend()) {
      this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
      return
    }
    this.holdSpeech('')
  }

  private rejectSpokenLine(responseId: string, line: string): void {
    const speech = this.speech
    if (!speech?.expect) return
    const said = line || speech.liveTranscript || ''
    const heardId = responseId || speech.liveResponseId
    if (heardId && speech.dropResponseId === heardId) return
    speech.dropResponseId = heardId
    speech.liveTranscript = ''
    speech.overran = false
    if (!speech.ignoreResponseId) speech.ignoreResponseId = heardId || speech.liveResponseId
    speech.started = false
    speech.done = false
    speech.ended = false
    this.clearSpeechTimers()
    this.cancelActiveResponse()
    if (!this.canSend()) {
      this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
      return
    }
    if (speech.retries < 1) {
      speech.retries += 1
      pushTrace('note', `не та фраза, повтор дословно: ${speechReport(said, speech.expect)}`)
      this.holdSpeech('')
      return
    }
    this.sendOutputClear()
    pushTrace('note', `модель не прочитала точную фразу; продолжаем по тексту на экране: ${speechReport(said, speech.expect)}`)
    this.finishSpeech('screen-text')
  }

  private sendSpeech(instructions: string): boolean {
    const speech = this.speech
    if (!speech) return false
    if (speech.expect) {
      return this.send({
        type: 'response.create',
        response: verbatimResponse(speech.expect, {
          purpose: speech.purpose,
          turn: speech.turn,
          take: speech.retries + 1,
        }),
      })
    }
    if (speech.isolated) {
      return this.send({
        type: 'response.create',
        response: isolatedCue(instructions, {
          purpose: speech.purpose,
          turn: speech.turn,
          take: speech.retries + 1,
        }),
      })
    }
    return this.send({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        tool_choice: 'none',
        max_output_tokens: freeReplyMaxOutputTokens,
        metadata: { purpose: speech.purpose, turn: String(speech.turn), take: String(speech.retries + 1) },
        instructions: withHostRules(instructions),
      },
    })
  }

  private finishSpeech(reason: string): void {
    const speech = this.speech
    if (!speech) return
    const hung = reason === 'hard' && speech.started && !speech.ended
    if (reason === 'cleared' || reason === 'truncated') this.markCut(speech, `сброс звука (${reason})`)
    else if (reason === 'stopped' && speech.playStartedAt && speech.itemId) {
      const shown = this.shownCaptions.get(speech.itemId)
      if (shown) this.hostPace.note(Date.now() - speech.playStartedAt, shown.text)
    }
    this.speech = null
    this.pendingSpeak = null
    this.clearFlushTimer()
    this.clearSpeechTimers()
    if (!hung) {
      this.playbackResponseId = null
      this.outputFlush = 'idle'
    }
    this.onLink({ host: 'idle' })
    pushTrace('note', `Аудио ведущей завершено (${reason})`)
    this.onAudioFinished({ purpose: speech.purpose, turn: speech.turn })
  }

  private cutState(): OutputCutState {
    const speech = this.speech
    return {
      holdingForFlush: this.pendingSpeak !== null,
      started: Boolean(speech?.started),
      liveResponseId: speech?.liveResponseId ?? null,
      itemId: speech?.itemId ?? null,
      ignoreResponseId: speech?.ignoreResponseId ?? null,
    }
  }

  private onOutputCleared(event: LooseEvent): void {
    const responseId = typeof event.response_id === 'string' ? event.response_id : ''
    const decision = outputCut(this.cutState(), { kind: 'cleared', responseId })
    this.outputFlush = 'idle'
    if (decision === 'release') {
      this.playbackResponseId = null
      pushTrace('note', 'сброс предыдущей реплики прошёл до новой фразы')
      this.beginPendingSpeech()
      return
    }
    if (decision === 'finish') {
      this.playbackResponseId = null
      this.finishSpeech('cleared')
      return
    }
    if (responseId && this.playbackResponseId === responseId && responseId !== this.speech?.liveResponseId) {
      this.playbackResponseId = null
    }
  }

  private onTruncated(event: LooseEvent): void {
    const itemId = typeof event.item_id === 'string' ? event.item_id : ''
    if (itemId && typeof event.audio_end_ms === 'number') {
      this.truncatedMs.set(itemId, event.audio_end_ms)
      if (this.truncatedMs.size > 50) this.truncatedMs.delete(this.truncatedMs.keys().next().value!)
    }
    const cut = itemId ? this.cutItems.get(itemId) : undefined
    if (cut && typeof event.audio_end_ms === 'number') {
      cut.playedMs = event.audio_end_ms
      for (const waiter of cut.waiters.splice(0)) waiter()
    }
    if (!this.speech) return
    if (outputCut(this.cutState(), { kind: 'truncated', itemId }) !== 'finish') return
    this.finishSpeech('truncated')
  }

  /** Сброс уже играющего буфера заканчивается до response.create, иначе он попадает в новую фразу. */
  private holdSpeech(instructions: string): void {
    this.pendingSpeak = instructions
    if (this.outputFlush !== 'inflight') this.sendOutputClear()
    this.armFlushWait()
  }

  private beginPendingSpeech(): void {
    this.clearFlushTimer()
    if (this.pendingSpeak === null || !this.speech) return
    const instructions = this.pendingSpeak
    this.pendingSpeak = null
    this.outputFlush = 'idle'
    this.playbackResponseId = null
    if (!this.sendSpeech(instructions)) this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
  }

  private armFlushWait(): void {
    this.clearFlushTimer()
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      this.outputFlush = 'idle'
      this.playbackResponseId = null
      this.beginPendingSpeech()
    }, outputFlushWaitMs)
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private sendOutputClear(): void {
    this.outputFlush = 'inflight'
    this.send({ type: 'output_audio_buffer.clear' })
  }

  private skipsResponse(responseId: string): boolean {
    const speech = this.speech
    if (!speech) return false
    return responseId === speech.dropResponseId || responseId === speech.ignoreResponseId
  }

  private rememberAssistantItem(event: LooseEvent): void {
    const speech = this.speech
    if (!speech) return
    const responseId = typeof event.response_id === 'string' ? event.response_id : ''
    if (responseId && this.skipsResponse(responseId)) return
    const item = asRecord(event.item)
    const nested = typeof item.id === 'string' ? item.id : ''
    const direct = typeof event.item_id === 'string' ? event.item_id : ''
    const itemId = direct || nested
    if (itemId) speech.itemId = itemId
  }

  private hostAudioTimers(): HostAudioTimers {
    return { fallback: this.fallbackTimer !== null, hard: this.hardTimer !== null }
  }

  /** Уже идущий жёсткий предел не перезапускает: 8 с снимаются, недостающий предел ставится заново. */
  private syncHostAudioTimers(next: HostAudioTimers): void {
    if (next.fallback) {
      if (this.fallbackTimer === null) {
        this.fallbackTimer = window.setTimeout(() => this.finishSpeech('fallback'), gameConfig.hostAudioFallbackMs)
      }
    } else if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
    if (next.hard) {
      if (this.hardTimer === null) this.armHardLimit()
    } else if (this.hardTimer !== null) {
      window.clearTimeout(this.hardTimer)
      this.hardTimer = null
    }
  }

  private armHardLimit(): void {
    if (this.hardTimer !== null) window.clearTimeout(this.hardTimer)
    this.hardTimer = window.setTimeout(() => {
      const speech = this.speech
      if (speech?.expect && !speech.done) {
        speech.retries = 1
        this.rejectSpokenLine(speech.liveResponseId ?? '', '')
        return
      }
      if (speech && !speech.started && !this.canSend()) {
        this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
        return
      }
      this.finishSpeech('hard')
    }, gameConfig.hostAudioHardLimitMs)
  }

  private clearSpeechTimers(): void {
    if (this.fallbackTimer !== null) window.clearTimeout(this.fallbackTimer)
    if (this.hardTimer !== null) window.clearTimeout(this.hardTimer)
    this.fallbackTimer = null
    this.hardTimer = null
  }
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onState)
      reject(new Error('Не удалось собрать сетевые кандидаты'))
    }, 10_000)
    const onState = () => {
      if (pc.iceGatheringState !== 'complete') return
      window.clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onState)
      resolve()
    }
    pc.addEventListener('icegatheringstatechange', onState)
  })
}

async function exchangeSdp(apiKey: string, sdp: string, model: string): Promise<string> {
  const multipart = await postMultipart(apiKey, sdp, model)
  if (multipart.sdp) {
    pushTrace('note', 'SDP принят через multipart')
    return multipart.sdp
  }
  if (multipart.message?.includes('(401)')) throw new Error(multipart.message)
  const raw = await postRaw(apiKey, sdp)
  if (raw.sdp) {
    pushTrace('note', 'SDP принят как application/sdp')
    return raw.sdp
  }
  throw new Error(multipart.message ?? raw.message ?? 'OpenAI не принял соединение')
}

async function postMultipart(apiKey: string, sdp: string, model: string): Promise<{ sdp?: string; message?: string }> {
  const body = new FormData()
  body.set('sdp', sdp)
  body.set('session', JSON.stringify(sessionBody(model)))
  return postSdp(apiKey, body, undefined)
}

async function postRaw(apiKey: string, sdp: string): Promise<{ sdp?: string; message?: string }> {
  return postSdp(apiKey, sdp, 'application/sdp')
}

async function postSdp(
  apiKey: string,
  body: BodyInit,
  contentType: string | undefined,
): Promise<{ sdp?: string; message?: string }> {
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
    if (contentType) headers['Content-Type'] = contentType
    const response = await fetch(callsUrl, { method: 'POST', headers, body })
    const text = await response.text()
    if (!response.ok) return { message: httpFailure(response.status, text) }
    if (!text.includes('v=')) return { message: `Ответ OpenAI не похож на SDP. ${clip(text)}` }
    return { sdp: text }
  } catch {
    return {
      message:
        'Браузер не смог отправить запрос к api.openai.com. Часто это сеть или CORS. Обычный ключ из браузера официально рассчитан на сервер.',
    }
  }
}

function httpFailure(status: number, text: string): string {
  if (status === 401) return 'OpenAI отклонил ключ (401). Проверьте ключ и доступ к Realtime.'
  return `OpenAI ответил ${status}. ${clip(text)}`
}

function readItemId(event: LooseEvent): string | null {
  return typeof event.item_id === 'string' && event.item_id ? event.item_id : null
}

function readTranscript(event: LooseEvent): string {
  if (typeof event.transcript === 'string') return event.transcript.trim()
  if (typeof event.text === 'string') return event.text.trim()
  return ''
}

function eventType(event: object): string {
  if ('type' in event && typeof event.type === 'string') return event.type
  return 'event'
}

/** Реплики ответа с item_id: по нему чат не пишет одну реплику дважды. */
export function assistantUtterances(response: Record<string, unknown>): Array<{ line: string; itemId: string | null }> {
  const output = Array.isArray(response.output) ? response.output : []
  const lines: Array<{ line: string; itemId: string | null }> = []
  for (const item of output) {
    const record = asRecord(item)
    if (record.type !== 'message') continue
    const itemId = typeof record.id === 'string' && record.id ? record.id : null
    const content = Array.isArray(record.content) ? record.content : []
    for (const part of content) {
      const piece = asRecord(part)
      if (typeof piece.transcript === 'string' && piece.transcript.trim()) lines.push({ line: piece.transcript, itemId })
      if (typeof piece.text === 'string' && piece.text.trim()) lines.push({ line: piece.text, itemId })
    }
  }
  return lines
}

function deltaNote(event: LooseEvent): { responseId: string; chars: number } {
  const delta = typeof event.delta === 'string' ? event.delta : ''
  const responseId = typeof event.response_id === 'string' ? event.response_id : ''
  return { responseId, chars: delta.length }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readErrorMessage(event: LooseEvent): string {
  const nested = asRecord(event.error)
  if (typeof nested.message === 'string') return nested.message
  if (typeof event.message === 'string') return event.message
  return 'неизвестная ошибка'
}

export type GameVoice = Pick<
  RealtimeClient,
  | 'judgmentCapabilities'
  | 'audioReference'
  | 'waitForAudioItem'
  | 'requestAudioJudgment'
  | 'publishAudioPlayerChat'
  | 'onLink'
  | 'onFailure'
  | 'onAudioFinished'
  | 'onToolCall'
  | 'onSpeechStarted'
  | 'onSpeechStopped'
  | 'connect'
  | 'setMicEnabled'
  | 'setOutputMuted'
  | 'outputLevel'
  | 'setLocalPlayback'
  | 'discardInputAudio'
  | 'forceInputCommit'
  | 'setSpeechSpeed'
  | 'setTranscriptionPrompt'
  | 'gatePlayerChat'
  | 'allowPlayerChat'
  | 'suppressPlayerChat'
  | 'waitForTranscript'
  | 'interruptSpeech'
  | 'requestSpeech'
  | 'requestTool'
  | 'sendToolOutput'
  | 'stopSession'
  | 'attachHostOutput'
  | 'setInputStream'
>

function forkHostStream(stream: MediaStream): MediaStream {
  return new MediaStream(stream.getAudioTracks().map((track) => track.clone()))
}

function readToolCall(response: Record<string, unknown>): ToolCall | null {
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    const record = asRecord(item)
    if (record.type !== 'function_call') continue
    if (typeof record.name !== 'string' || typeof record.call_id !== 'string') continue
    let args: unknown = {}
    if (typeof record.arguments === 'string') {
      try {
        args = JSON.parse(record.arguments)
      } catch {
        args = null
      }
    } else if (record.arguments && typeof record.arguments === 'object') {
      args = record.arguments
    }
    return { name: record.name, callId: record.call_id, arguments: args }
  }
  return null
}


/** Ошибка API, при которой ждущий tool-запрос не придёт. Отмена неактивного ответа — не про него. */
export function failsPendingTool(message: string, code: string): boolean {
  return !/cancel/i.test(`${code} ${message}`)
}

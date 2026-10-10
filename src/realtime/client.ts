import { unlockAudio } from '../audio/beep.ts'
import { speakExact } from '../audio/localSpeech.ts'
import { gameConfig, hostInstructions } from '../config.ts'
import { recordResponseUsage, resetUsage } from './usage.ts'
import { pushHostLine, pushPlayerLine, pushTrace } from '../debug/trace.ts'
import { outputCut, outputFlushWaitMs, timersAfterPlaybackStarted, timersAfterResponseDone } from './playback.ts'
import type { HostAudioTimers, OutputCutState } from './playback.ts'
import { isolatedCue, isolatedToolResponse, speechMatches, verbatimResponse } from './speechMatch.ts'
import { sessionTools } from './tools.ts'
import type { VoiceWire } from './wire.ts'
import { echoesAnswerPrompt } from '../game/answerPrompt.ts'
import { echoesChoicePrompt } from '../game/choicePrompt.ts'
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
  local: boolean
  ended: boolean
  liveResponseId: string | null
  dropResponseId: string | null
  ignoreResponseId: string | null
  itemId: string | null
  chatNote?: (spoken: string) => string
}

export type ToolCall = {
  name: string
  callId: string
  arguments: unknown
}

const callsUrl = 'https://api.openai.com/v1/realtime/calls'

function sessionBody(model: string) {
  return {
    type: 'realtime',
    model,
    instructions: hostInstructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        noise_reduction: { type: 'far_field' },
        transcription: {
          model: 'gpt-4o-mini-transcribe',
          language: 'ru',
        },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'low',
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

export class RealtimeClient {
  readonly model: string
  private wire: VoiceWire | null
  private wireOpen = false
  private micLive = false
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audio = new Audio()
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
  } | null = null
  private inputStartedAt: number | null = null
  private inputItemId: string | null = null
  private transcriptionPrompt = ''
  private transcripts = new Map<string, StoredTranscript>()
  private transcriptWaiters = new Map<string, Array<(text: string) => void>>()
  private looseTranscriptWaiters: Array<(text: string) => void> = []
  private dropped = false

  onLink: (patch: Partial<LinkStatus>) => void = () => {}
  onFailure: (message: string) => void = () => {}
  onAudioFinished: (info: { purpose: string; turn: number }) => void = () => {}
  onToolCall: (call: ToolCall | null, purpose: string) => void = () => {}
  onSpeechStarted: () => void = () => {}
  onSpeechStopped: (info: { durationMs: number; itemId: string | null }) => void = () => {}

  constructor(options: { model?: string; wire?: VoiceWire | null } = {}) {
    this.model = options.model ?? gameConfig.model
    this.wire = options.wire ?? null
  }

  async connect(apiKey: string): Promise<void> {
    this.stopSession()
    this.dropped = false
    resetUsage()
    const token = this.sessionToken
    const alive = () => token === this.sessionToken
    this.onLink({ connection: 'connecting', mic: 'requesting', host: 'idle' })
    unlockAudio()
    if (this.wire) {
      await this.connectWire(apiKey, token, alive)
      return
    }

    let mic: MediaStream
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
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
    if (!this.mic) return
    const wasLive = this.mic.getAudioTracks().some((track) => track.enabled)
    for (const track of this.mic.getAudioTracks()) track.enabled = enabled
    if (enabled && !this.canSend()) {
      this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
      return
    }
    this.onLink({ mic: enabled ? 'live' : 'muted' })
    if (enabled && !wasLive) this.send({ type: 'input_audio_buffer.clear' })
  }

  setOutputMuted(muted: boolean): void {
    if (this.wire) this.wire.setOutputMuted(muted)
    else this.audio.muted = muted
    if (muted) this.send({ type: 'input_audio_buffer.clear' })
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
    this.transcriptionPrompt = prompt
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            transcription: {
              model: 'gpt-4o-mini-transcribe',
              language: 'ru',
              prompt,
            },
          },
        },
      },
    })
  }

  waitForTranscript(
    itemId: string | null,
    timeoutMs: number,
  ): Promise<{ text: string; arrived: boolean; confidence: number | null }> {
    const known = itemId ?? this.inputItemId
    const ready = transcriptOf(known, this.transcripts)
    if (ready) return Promise.resolve(ready)
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.removeTranscriptWaiter(known, finish)
        resolve(transcriptOf(known, this.transcripts) ?? { text: '', arrived: false, confidence: null })
      }, timeoutMs)
      const finish = (text: string) => {
        window.clearTimeout(timer)
        resolve(transcriptOf(known ?? this.inputItemId, this.transcripts) ?? { text, arrived: true, confidence: null })
      }
      if (known) {
        const bucket = this.transcriptWaiters.get(known) ?? []
        bucket.push(finish)
        this.transcriptWaiters.set(known, bucket)
      } else {
        this.looseTranscriptWaiters.push(finish)
      }
    })
  }

  private rememberTranscript(itemId: string, text: string, confidence: number | null = null): void {
    if (this.transcripts.has(itemId)) return
    this.transcripts.set(itemId, { text, confidence })
    if (!echoesChoicePrompt(text, this.transcriptionPrompt) && !echoesAnswerPrompt(text, this.transcriptionPrompt)) {
      pushPlayerLine(text || 'речь не распознана')
    }
    const matched = this.transcriptWaiters.get(itemId) ?? []
    this.transcriptWaiters.delete(itemId)
    for (const waiter of matched) waiter(text)
    const loose = this.looseTranscriptWaiters
    this.looseTranscriptWaiters = []
    for (const waiter of loose) waiter(text)
  }

  private removeTranscriptWaiter(itemId: string | null, finish: (text: string) => void): void {
    if (!itemId) {
      this.looseTranscriptWaiters = this.looseTranscriptWaiters.filter((waiter) => waiter !== finish)
      return
    }
    const left = (this.transcriptWaiters.get(itemId) ?? []).filter((waiter) => waiter !== finish)
    if (left.length) this.transcriptWaiters.set(itemId, left)
    else this.transcriptWaiters.delete(itemId)
  }

  interruptSpeech(): void {
    this.speech = null
    this.pendingSpeak = null
    this.clearFlushTimer()
    this.clearSpeechTimers()
    window.speechSynthesis?.cancel()
    this.send({ type: 'response.cancel' })
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
      local: false,
      ended: false,
      liveResponseId: null,
      dropResponseId: null,
      ignoreResponseId,
      itemId: null,
      chatNote,
    }
    if (expect) pushHostLine(expect)
    this.armHardLimit()
    this.send({ type: 'response.cancel' })
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

  requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false): void {
    this.clearSpeechTimers()
    this.clearFlushTimer()
    this.pendingSpeak = null
    this.speech = null
    this.toolMode = 'text'
    this.pendingTool = { purpose, turn, name, instructions, isolated }
    this.sendToolRequest('text')
  }

  sendToolOutput(callId: string, output: unknown): void {
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
    this.sessionToken += 1
    this.sessionUpdatedWaiter = null
    this.clearSpeechTimers()
    this.clearFlushTimer()
    this.speech = null
    this.pendingSpeak = null
    this.playbackResponseId = null
    this.outputFlush = 'idle'
    this.pendingTool = null
    this.wireOpen = false
    this.micLive = false
    this.wire?.close()
    this.inputStartedAt = null
    this.inputItemId = null
    this.transcriptionPrompt = ''
    this.transcripts.clear()
    this.transcriptWaiters.clear()
    this.looseTranscriptWaiters = []
    const dc = this.dc
    const pc = this.pc
    const mic = this.mic
    this.dc = null
    this.pc = null
    this.mic = null
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
    this.onLink({ connection: 'idle', mic: 'idle', host: 'idle' })
  }

  private canSend(): boolean {
    if (this.wire) return this.wireOpen
    return Boolean(this.dc && this.dc.readyState === 'open')
  }

  private dropLink(message: string): void {
    if (this.dropped) return
    this.dropped = true
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

  private send(event: object): boolean {
    const type = eventType(event)
    if (this.wire) {
      if (!this.wireOpen) {
        pushTrace('note', `не отправлено, канал закрыт: ${type}`, event)
        return false
      }
      pushTrace('out', type, event)
      return this.wire.send(event)
    }
    if (!this.canSend() || !this.dc) {
      pushTrace('note', `не отправлено, канал закрыт: ${type}`, event)
      return false
    }
    pushTrace('out', type, event)
    try {
      this.dc.send(JSON.stringify(event))
    } catch {
      pushTrace('note', `не отправлено, канал закрыт: ${type}`, event)
      return false
    }
    return true
  }

  private sendToolRequest(mode: 'text' | 'audio'): void {
    const pending = this.pendingTool
    if (!pending) return
    this.send({ type: 'response.cancel' })
    const response = pending.isolated
      ? isolatedToolResponse({
          name: pending.name,
          instructions: pending.instructions,
          purpose: pending.purpose,
          turn: pending.turn,
          mode,
          tools: sessionTools,
        })
      : {
          output_modalities: mode === 'text' ? ['text'] : ['audio'],
          tool_choice: { type: 'function', name: pending.name },
          metadata: { purpose: pending.purpose, turn: String(pending.turn) },
          instructions: pending.instructions,
        }
    this.send({ type: 'response.create', response })
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

  private async connectWire(apiKey: string, token: number, alive: () => boolean): Promise<void> {
    const wire = this.wire
    if (!wire) return
    try {
      await wire.open(apiKey, {
        message: (raw) => {
          if (alive()) this.handleMessage(raw)
        },
        closed: (message) => {
          if (alive()) this.dropLink(message)
        },
      })
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
    if (!type.endsWith('.delta')) pushTrace('in', type, event)
    this.sessionUpdatedWaiter?.(event)
    if (type === 'session.updated') this.sessionUpdatedWaiter = null

    if (type === 'error' || type === 'invalid_request_error') {
      const message = readErrorMessage(event)
      pushTrace('note', `Ошибка API: ${message}`)
      if (this.pendingTool && this.toolMode === 'text' && /modalit|output/i.test(message)) {
        this.toolMode = 'audio'
        this.sendToolRequest('audio')
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
      if (responseId) this.playbackResponseId = responseId
      this.syncHostAudioTimers(timersAfterPlaybackStarted(this.hostAudioTimers(), this.speech.ended))
      this.onLink({ host: 'speaking' })
    }

    if (type === 'response.output_audio_transcript.done' || type === 'response.output_text.done') {
      this.rememberAssistantItem(event)
      const transcript = typeof event.transcript === 'string' ? event.transcript : ''
      const text = typeof event.text === 'string' ? event.text : ''
      const line = (transcript || text).trim()
      if (line) this.noteHostLine(event, line)
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
      this.rememberTranscript(itemId, failed ? '' : readTranscript(event), failed ? null : transcriptionConfidence(event.logprobs))
    }

    if (type === 'response.done') this.onResponseDone(event)
    if (type === 'output_audio_buffer.stopped') this.onPlaybackStopped(event)
    if (type === 'output_audio_buffer.cleared') this.onOutputCleared(event)
    if (type === 'conversation.item.truncated') this.onTruncated(event)
    if (type === 'input_audio_buffer.speech_started') {
      this.inputStartedAt = performance.now()
      this.inputItemId = readItemId(event)
      this.onSpeechStarted()
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      const started = this.inputStartedAt
      const durationMs = started === null ? 10_000 : Math.round(performance.now() - started)
      const itemId = readItemId(event) ?? this.inputItemId
      this.inputStartedAt = null
      this.onSpeechStopped({ durationMs, itemId })
    }
  }

  private onResponseDone(event: LooseEvent): void {
    const response = asRecord(event.response)
    recordResponseUsage(response)
    const call = readToolCall(response)
    const earlyMeta = asRecord(response.metadata)
    const earlyPurpose = typeof earlyMeta.purpose === 'string' ? earlyMeta.purpose : ''
    if (!call && !this.speech?.expect && earlyPurpose !== 'read') {
      for (const line of assistantUtterances(response)) this.publishHostLine(line, earlyPurpose)
    }
    if (call?.name === 'selectQuestion' || call?.name === 'submitAnswerJudgment') {
      this.pendingTool = null
      this.pendingSpeak = null
      this.clearFlushTimer()
      this.speech = null
      this.clearSpeechTimers()
      this.onToolCall(call, call.name === 'selectQuestion' ? 'select' : 'judge')
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
      const said = assistantUtterances(response).join(' ').trim()
      if (!said) return
      if (!speechMatches(said, this.speech.expect)) {
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
    if (!this.speech || this.speech.local) return
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
      if (!speechMatches(line, speech.expect)) {
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
    this.publishHostLine(line, speech.purpose)
  }

  private publishHostLine(line: string, purpose: string): void {
    const speech = this.speech
    const ownAnnounce = speech?.purpose === 'announce' && purpose === 'announce'
    const caption = ownAnnounce ? (speech?.chatNote?.(line).trim() ?? '') : ''
    const stored = pushHostLine(line, caption)
    if (stored && ownAnnounce && speech) speech.chatNote = undefined
  }

  private rejectSpokenLine(responseId: string, said: string): void {
    const speech = this.speech
    if (!speech?.expect || speech.local) return
    const heardId = responseId || speech.liveResponseId
    if (heardId && speech.dropResponseId === heardId) return
    speech.dropResponseId = heardId
    if (!speech.ignoreResponseId) speech.ignoreResponseId = heardId || speech.liveResponseId
    speech.started = false
    speech.done = false
    speech.ended = false
    this.clearSpeechTimers()
    this.send({ type: 'response.cancel' })
    if (!this.canSend()) {
      this.dropLink('Связь с ведущей прервалась. Начните игру ещё раз.')
      return
    }
    if (speech.retries < 1) {
      speech.retries += 1
      pushTrace('note', `не та фраза, повтор дословно: ${said}`)
      this.holdSpeech('')
      return
    }
    this.sendOutputClear()
    speech.local = true
    pushTrace('note', `голос модели заменён на точную фразу: ${said}`)
    this.onLink({ host: 'speaking' })
    void speakExact(speech.expect).then(() => {
      if (this.speech === speech) this.finishSpeech('local')
    })
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
        metadata: { purpose: speech.purpose, turn: String(speech.turn), take: String(speech.retries + 1) },
        instructions,
      },
    })
  }

  private finishSpeech(reason: string): void {
    const speech = this.speech
    if (!speech) return
    const hung = reason === 'hard' && speech.started && !speech.ended
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
    if (this.speech?.local) {
      this.outputFlush = 'idle'
      return
    }
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
    if (!this.speech || this.speech.local) return
    const itemId = typeof event.item_id === 'string' ? event.item_id : ''
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
      if (speech?.expect && !speech.done && !speech.local) {
        speech.retries = 1
        this.rejectSpokenLine(speech.liveResponseId ?? '', '')
        return
      }
      if (speech && !speech.started && !speech.local && !this.canSend()) {
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

function assistantUtterances(response: Record<string, unknown>): string[] {
  const output = Array.isArray(response.output) ? response.output : []
  const lines: string[] = []
  for (const item of output) {
    const record = asRecord(item)
    if (record.type !== 'message') continue
    const content = Array.isArray(record.content) ? record.content : []
    for (const part of content) {
      const piece = asRecord(part)
      if (typeof piece.transcript === 'string' && piece.transcript.trim()) lines.push(piece.transcript)
      if (typeof piece.text === 'string' && piece.text.trim()) lines.push(piece.text)
    }
  }
  return lines
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
  | 'onLink'
  | 'onFailure'
  | 'onAudioFinished'
  | 'onToolCall'
  | 'onSpeechStarted'
  | 'onSpeechStopped'
  | 'connect'
  | 'setMicEnabled'
  | 'setOutputMuted'
  | 'setSpeechSpeed'
  | 'setTranscriptionPrompt'
  | 'waitForTranscript'
  | 'interruptSpeech'
  | 'requestSpeech'
  | 'requestTool'
  | 'sendToolOutput'
  | 'stopSession'
>

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

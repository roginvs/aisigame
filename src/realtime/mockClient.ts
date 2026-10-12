import { pushHostLine, pushPlayerLine } from '../debug/trace.ts'
import { echoesAnswerPrompt } from '../game/answerPrompt.ts'
import { echoesChoicePrompt } from '../game/choicePrompt.ts'
import { echoesTranscriptionPrompt } from '../game/promptEcho.ts'
import { nearHomophone, sharesAnswer } from '../game/judgment.ts'
import type { GameVoice, LinkStatus, ToolCall } from './client.ts'
import type { StoredTranscript } from './utterance.ts'
import { recordResponseUsage, resetUsage } from './usage.ts'

const speechPauseMs = 40
/** Длинная дословная фраза: полоска кнопки успевает открыться, пока заглушка ещё «читает». */
const longSpeechChars = 180
// Должно быть строго дольше максимального раннего окна (8 с), иначе два таймера
// финишируют одновременно и e2e не успевает увидеть reading.armed.
const longSpeechMs = 10_000

export type MockControls = {
  hear: (text: string, durationMs?: number) => void
  setSpeechMs: (ms: number) => void
  /** Только конференция на заглушке: портит байт пакета у joiner. */
  flipPackByte?: () => void
}

declare global {
  interface Window {
    __aisigame?: MockControls
  }
}

export class MockRealtimeClient implements GameVoice {
  onLink: (patch: Partial<LinkStatus>) => void = () => {}
  onFailure: (message: string) => void = () => {}
  onAudioFinished: (info: { purpose: string; turn: number }) => void = () => {}
  onToolCall: (call: ToolCall | null, purpose: string, turn: number) => void = () => {}
  onSpeechStarted: (info?: { itemId: string | null }) => void = () => {}
  onSpeechStopped: (info: { durationMs: number; itemId: string | null }) => void = () => {}

  private transcriptionPrompt = ''
  private speechToken = 0
  private speechMs = speechPauseMs
  private itemSeq = 0
  private callSeq = 0
  private transcripts = new Map<string, StoredTranscript>()
  private transcriptWaiters = new Map<string, Array<(line: StoredTranscript) => void>>()
  private playerChatGated = false
  private playerChatAllowed = new Set<string>()
  private playerChatSuppressed = new Set<string>()
  private playerChatPending = new Map<string, string>()
  private playerChatPublished = new Set<string>()
  private hostOutputContext: AudioContext | null = null

  async connect(_apiKey: string, _options?: { captureMic?: boolean }): Promise<void> {
    resetUsage()
    recordResponseUsage({
      id: 'mock-session',
      usage: {
        input_tokens: 657,
        output_tokens: 316,
        input_token_details: { text_tokens: 657, audio_tokens: 0, image_tokens: 0 },
        output_token_details: { text_tokens: 98, audio_tokens: 218 },
      },
    })
    this.onLink({ connection: 'connected', mic: 'muted', host: 'idle' })
  }

  setMicEnabled(enabled: boolean): void {
    this.onLink({ mic: enabled ? 'live' : 'muted' })
  }

  setOutputMuted(muted: boolean): void {
    if (muted) this.onLink({ host: 'idle' })
  }

  setSpeechSpeed(_speed: number): void {}

  attachHostOutput(handler: (stream: MediaStream) => void): void {
    this.hostOutputContext?.close().catch(() => undefined)
    const context = new AudioContext()
    const destination = context.createMediaStreamDestination()
    this.hostOutputContext = context
    // У мока нет PCM, но Jitsi-мастер всё равно должен опубликовать ровно
    // одну дорожку участника «Ведущая» и пройти тот же lifecycle.
    handler(destination.stream)
  }

  setInputStream(_stream: MediaStream | null): void {}

  setTranscriptionPrompt(prompt: string): void {
    this.transcriptionPrompt = prompt
  }

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
    this.playerChatSuppressed.add(itemId)
    this.playerChatPending.delete(itemId)
    this.playerChatAllowed.delete(itemId)
  }

  setSpeechMs(ms: number): void {
    this.speechMs = ms
  }

  waitForTranscript(
    itemId: string | null,
    timeoutMs: number,
  ): Promise<{ text: string; arrived: boolean; confidence: number | null }> {
    if (!itemId) return Promise.resolve({ text: '', arrived: false, confidence: null })
    const ready = this.transcripts.get(itemId)
    if (ready) return Promise.resolve({ text: ready.text, arrived: true, confidence: ready.confidence })
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.removeTranscriptWaiter(itemId, finish)
        const late = this.transcripts.get(itemId)
        resolve(
          late
            ? { text: late.text, arrived: true, confidence: late.confidence }
            : { text: '', arrived: false, confidence: null },
        )
      }, timeoutMs)
      const finish = (line: StoredTranscript) => {
        window.clearTimeout(timer)
        resolve({ text: line.text, arrived: true, confidence: line.confidence })
      }
      const bucket = this.transcriptWaiters.get(itemId) ?? []
      bucket.push(finish)
      this.transcriptWaiters.set(itemId, bucket)
    })
  }

  /** Тесты: положить транскрипт после speech_stopped, как запоздавший OpenAI. */
  deliverTranscript(itemId: string, text: string, confidence: number | null = null): void {
    if (this.transcripts.has(itemId)) return
    const line = { text, confidence }
    this.transcripts.set(itemId, line)
    this.offerPlayerChat(itemId, text)
    const matched = this.transcriptWaiters.get(itemId) ?? []
    this.transcriptWaiters.delete(itemId)
    for (const waiter of matched) waiter(line)
  }

  private removeTranscriptWaiter(itemId: string, finish: (line: StoredTranscript) => void): void {
    const left = (this.transcriptWaiters.get(itemId) ?? []).filter((waiter) => waiter !== finish)
    if (left.length) this.transcriptWaiters.set(itemId, left)
    else this.transcriptWaiters.delete(itemId)
  }

  interruptSpeech(): void {
    this.speechToken += 1
    this.onLink({ host: 'idle' })
  }

  requestSpeech(
    purpose: string,
    turn: number,
    instructions: string,
    expect?: string,
    _isolated = false,
    chatNote?: (spoken: string) => string,
  ): void {
    const token = ++this.speechToken
    const line = expect || hostLine(purpose, instructions)
    if (!line.trim()) return
    const wait = expect && expect.length > longSpeechChars ? longSpeechMs : this.speechMs
    pushHostLine(line, chatNote?.(line) ?? '')
    this.onLink({ host: 'speaking' })
    window.setTimeout(() => {
      if (token !== this.speechToken) return
      this.onLink({ host: 'idle' })
      this.onAudioFinished({ purpose, turn })
    }, wait)
  }

  requestTool(purpose: string, turn: number, name: string, instructions: string, _isolated = false): void {
    const call: ToolCall = {
      name,
      callId: `mock-call-${++this.callSeq}`,
      arguments: name === 'submitAnswerJudgment' ? judgeArguments(instructions) : selectArguments(instructions),
    }
    window.setTimeout(() => this.onToolCall(call, purpose, turn), speechPauseMs)
  }

  sendToolOutput(_callId: string, _output: unknown): void {}

  stopSession(): void {
    this.speechToken += 1
    this.transcriptionPrompt = ''
    this.transcripts.clear()
    this.playerChatGated = false
    this.playerChatAllowed.clear()
    this.playerChatSuppressed.clear()
    this.playerChatPending.clear()
    this.playerChatPublished.clear()
    this.hostOutputContext?.close().catch(() => undefined)
    this.hostOutputContext = null
    this.onLink({ connection: 'idle', mic: 'idle', host: 'idle' })
  }

  hear(text: string, durationMs = 1000, confidence: number | null = null): void {
    const itemId = `mock-item-${++this.itemSeq}`
    this.transcripts.set(itemId, { text, confidence })
    this.offerPlayerChat(itemId, text)
    this.onSpeechStarted({ itemId })
    // Запрошенная длительность, не wall-clock: иначе при fake timers (~40 мс)
    // фантом-гард принимал бы любой эталон за тишину.
    window.setTimeout(() => {
      this.onSpeechStopped({ durationMs, itemId })
    }, speechPauseMs)
  }

  private offerPlayerChat(itemId: string, text: string): void {
    if (this.isPromptEcho(text)) return
    if (this.playerChatSuppressed.has(itemId) || this.playerChatPublished.has(itemId)) return
    if (this.playerChatGated && !this.playerChatAllowed.has(itemId)) {
      this.playerChatPending.set(itemId, text)
      return
    }
    this.publishPlayerChat(itemId, text)
  }

  private publishPlayerChat(itemId: string, text: string): void {
    if (this.playerChatPublished.has(itemId) || this.playerChatSuppressed.has(itemId)) return
    if (this.isPromptEcho(text)) return
    this.playerChatPublished.add(itemId)
    pushPlayerLine(text || 'речь не распознана')
  }

  private isPromptEcho(text: string): boolean {
    const prompt = this.transcriptionPrompt
    return (
      echoesChoicePrompt(text, prompt) ||
      echoesAnswerPrompt(text, prompt) ||
      echoesTranscriptionPrompt(text, prompt)
    )
  }

  /** Тесты: только конец речи с известным itemId, без started (запоздавший VAD). */
  emitSpeechStopped(itemId: string, durationMs: number): void {
    this.onSpeechStopped({ durationMs, itemId })
  }

  /** Тесты: started/stopped сразу, транскрипт позже через deliverTranscript. */
  hearDeferred(durationMs = 1000): string {
    const itemId = `mock-item-${++this.itemSeq}`
    this.onSpeechStarted({ itemId })
    window.setTimeout(() => {
      this.onSpeechStopped({ durationMs, itemId })
    }, speechPauseMs)
    return itemId
  }
}

function hostLine(purpose: string, instructions = ''): string {
  if (purpose === 'welcome') return 'Здравствуйте. Выбирайте вопрос.'
  if (purpose === 'lobby') {
    if (instructions.includes('Игра создана')) return 'Игра создана. Ждём игроков.'
    return ''
  }
  if (purpose === 'clarify') return 'Не расслышала. Назовите тему и стоимость ещё раз.'
  if (purpose === 'announce') return announceLine(instructions)
  if (purpose === 'bridge') return 'Следующий раунд. Выбирайте вопрос.'
  if (purpose === 'finished') return 'Игра окончена.'
  if (purpose === 'bet') return 'Назовите ставку.'
  if (purpose === 'turn') return 'Ваш ответ.'
  if (purpose === 'micWarning') {
    const name =
      /Имя игрока:\s*(.+)/.exec(instructions)?.[1]?.split('\n')[0]?.trim() ||
      /обратись к\s+(.+?)\s+по имени/i.exec(instructions)?.[1]?.trim() ||
      /выбирает вопрос[\s\S]*?([А-ЯA-Z][^\s,]+)/.exec(instructions)?.[1]?.trim()
    return name ? `${name}, включи микрофон.` : 'Микрофон выключен.'
  }
  if (purpose === 'chooserHandoff') {
    const left = /что\s+(.+?)\s+отключился/i.exec(instructions)?.[1]?.trim()
    const next = /назови\s+(.+?)\s+как нового/i.exec(instructions)?.[1]?.trim()
    if (left && next) return `${left} отключился. ${next}, выбирайте.`
    return 'Игрок отключился. Выбирайте.'
  }
  if (purpose === 'falseStart') {
    const line = [...instructions.matchAll(/«([^»]+)»/g)].map((match) => match[1]?.trim() ?? '').find(Boolean)
    return line || 'Фальстарт.'
  }
  return 'Слушаю.'
}

function announceLine(instructions: string): string {
  const folded = instructions.toLowerCase().replaceAll('ё', 'е')
  const quoted = [...instructions.matchAll(/«([^»]+)»/g)].map((match) => match[1]?.trim() ?? '').filter(Boolean)
  if (folded.includes('произнеси') && quoted[0]) return quoted[0]
  if (folded.includes('исход: повтор') || folded.includes('попроси повторить')) return 'Повторите, пожалуйста.'
  if (folded.includes('исход: верно') || folded.includes('ответ верный')) return 'Верно.'
  if (folded.includes('исход: неверно') || folded.includes('что неверно') || folded.includes('ответ неверный')) {
    return 'Неверно.'
  }
  if (
    folded.includes('исход: молчание') ||
    folded.includes('время на ответ вышло') ||
    folded.includes('ответа не было') ||
    folded.includes('ничего не услышала') ||
    folded.includes('ничего не услышал')
  ) {
    return 'Ничего не услышала, минус.'
  }
  return 'Дальше.'
}

function selectArguments(instructions: string): Record<string, unknown> {
  const heard = quoted(instructions, 'Распознанный текст')
  const needle = normalize(heard)
  const cells = [...instructions.matchAll(/^(.+?) — (.+?) — (\d+)\s*$/gm)].map((match) => ({
    id: (match[1] ?? '').trim(),
    name: (match[2] ?? '').trim(),
    value: Number(match[3]),
  }))
  const hit = cells.find((cell) => {
    const name = normalize(cell.name)
    return name.length > 0 && needle.includes(name) && hasNumber(needle, cell.value)
  })
  return {
    themeId: hit?.id ?? '',
    value: hit?.value ?? 0,
    confident: Boolean(hit),
    heard,
  }
}

function judgeArguments(instructions: string): Record<string, unknown> {
  const heard = quoted(instructions, 'Реплика игрока')
  const answers = choiceForms(
    instructions,
    field(instructions, 'Эталон, с которым нужно сравнить смысл')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const correct = sharesAnswer(heard, answers)
  const clarify = !correct && nearHomophone(heard, answers)
  return {
    questionId: field(instructions, 'questionId'),
    playerId: Number(field(instructions, 'playerId')) || 0,
    attemptId: Number(field(instructions, 'attemptId')) || 0,
    status: correct ? 'correct' : clarify ? 'needs_clarification' : 'incorrect',
    heard,
    reason: correct
      ? 'Смысл совпал с эталоном.'
      : clarify
        ? 'Реплика созвучна эталону, нужно повторить.'
        : 'Смысл не совпал с эталоном.',
  }
}

/** Буква эталона и текст того же варианта — один ответ, как в инструкции оценки. */
function choiceForms(instructions: string, answers: string[]): string[] {
  const letters = new Set(answers.map((item) => item.trim().toLowerCase()))
  const forms = [...answers]
  for (const match of instructions.matchAll(/(?:^|\n)([A-Za-zА-Яа-я])\.\s+([^\n]+)/g)) {
    const letter = (match[1] ?? '').trim().toLowerCase()
    const text = (match[2] ?? '').trim()
    if (!letters.has(letter) || !text) continue
    forms.push(text)
  }
  return forms
}

function quoted(instructions: string, label: string): string {
  return new RegExp(`${label}: «([^»]*)»`).exec(instructions)?.[1] ?? ''
}

function field(instructions: string, label: string): string {
  return new RegExp(`${escapeRegExp(label)}: (.+)`).exec(instructions)?.[1]?.trim() ?? ''
}

function hasNumber(text: string, value: number): boolean {
  return new RegExp(`(^|\\D)${value}(\\D|$)`).test(text)
}

function normalize(value: string): string {
  return value.toLowerCase().replaceAll('ё', 'е')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

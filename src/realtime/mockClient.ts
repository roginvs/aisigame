import { pushHostLine, pushPlayerLine } from '../debug/trace.ts'
import { echoesAnswerPrompt } from '../game/answerPrompt.ts'
import { echoesChoicePrompt } from '../game/choicePrompt.ts'
import { sharesAnswer } from '../game/judgment.ts'
import type { GameVoice, LinkStatus, ToolCall } from './client.ts'
import type { StoredTranscript } from './utterance.ts'
import { recordResponseUsage, resetUsage } from './usage.ts'

const speechPauseMs = 40

export type MockControls = {
  hear: (text: string, durationMs?: number) => void
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
  onToolCall: (call: ToolCall | null, purpose: string) => void = () => {}
  onSpeechStarted: () => void = () => {}
  onSpeechStopped: (info: { durationMs: number; itemId: string | null }) => void = () => {}

  private transcriptionPrompt = ''
  private speechToken = 0
  private itemSeq = 0
  private callSeq = 0
  private transcripts = new Map<string, StoredTranscript>()

  async connect(_apiKey: string): Promise<void> {
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

  setTranscriptionPrompt(prompt: string): void {
    this.transcriptionPrompt = prompt
  }

  waitForTranscript(
    itemId: string | null,
    _timeoutMs: number,
  ): Promise<{ text: string; arrived: boolean; confidence: number | null }> {
    const line = itemId ? this.transcripts.get(itemId) : undefined
    if (!line) return Promise.resolve({ text: '', arrived: false, confidence: null })
    return Promise.resolve({ text: line.text, arrived: true, confidence: line.confidence })
  }

  interruptSpeech(): void {
    this.speechToken += 1
    this.onLink({ host: 'idle' })
  }

  requestSpeech(
    purpose: string,
    turn: number,
    _instructions: string,
    expect?: string,
    _isolated = false,
    chatNote?: (spoken: string) => string,
  ): void {
    const token = ++this.speechToken
    const line = expect || hostLine(purpose)
    pushHostLine(line, chatNote?.(line) ?? '')
    this.onLink({ host: 'speaking' })
    window.setTimeout(() => {
      if (token !== this.speechToken) return
      this.onLink({ host: 'idle' })
      this.onAudioFinished({ purpose, turn })
    }, speechPauseMs)
  }

  requestTool(purpose: string, _turn: number, name: string, instructions: string, _isolated = false): void {
    const call: ToolCall = {
      name,
      callId: `mock-call-${++this.callSeq}`,
      arguments: name === 'submitAnswerJudgment' ? judgeArguments(instructions) : selectArguments(instructions),
    }
    window.setTimeout(() => this.onToolCall(call, purpose), speechPauseMs)
  }

  sendToolOutput(_callId: string, _output: unknown): void {}

  stopSession(): void {
    this.speechToken += 1
    this.transcriptionPrompt = ''
    this.transcripts.clear()
    this.onLink({ connection: 'idle', mic: 'idle', host: 'idle' })
  }

  hear(text: string, durationMs = 1000): void {
    const itemId = `mock-item-${++this.itemSeq}`
    const started = Date.now()
    this.transcripts.set(itemId, { text, confidence: null })
    if (!echoesChoicePrompt(text, this.transcriptionPrompt) && !echoesAnswerPrompt(text, this.transcriptionPrompt)) {
      pushPlayerLine(text || 'речь не распознана')
    }
    this.onSpeechStarted()
    window.setTimeout(() => {
      const elapsed = Math.max(1, Date.now() - started)
      this.onSpeechStopped({ durationMs: Math.min(durationMs, elapsed), itemId })
    }, speechPauseMs)
  }
}

function hostLine(purpose: string): string {
  if (purpose === 'welcome') return 'Здравствуйте. Выбирайте вопрос.'
  if (purpose === 'clarify') return 'Не расслышала. Назовите тему и стоимость ещё раз.'
  if (purpose === 'announce') return 'Неверно.'
  if (purpose === 'bridge') return 'Следующий раунд. Выбирайте вопрос.'
  if (purpose === 'finished') return 'Игра окончена.'
  if (purpose === 'bet') return 'Назовите ставку.'
  if (purpose === 'turn') return 'Ваш ответ.'
  return 'Слушаю.'
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
  const answers = field(instructions, 'Эталон, с которым нужно сравнить смысл')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  const correct = sharesAnswer(heard, answers)
  return {
    questionId: field(instructions, 'questionId'),
    playerId: Number(field(instructions, 'playerId')) || 0,
    attemptId: Number(field(instructions, 'attemptId')) || 0,
    status: correct ? 'correct' : 'incorrect',
    heard,
    reason: correct ? 'Смысл совпал с эталоном.' : 'Смысл не совпал с эталоном.',
  }
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

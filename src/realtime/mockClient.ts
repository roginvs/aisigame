import { amountWords, appealResultLine } from '../game/appealSpeech.ts'
import { AudioItems, type AudioReference, type AudioItemReady } from './audioItems.ts'
import type { JudgeRequestContext, JudgmentCapabilities } from './judgmentRequest.ts'
import { livePlayerChatVisible } from './liveSpeech.ts'
import { clearLivePlayerLine, pushHostLine, pushPlayerLine, pushTrace, setLivePlayerLine } from '../debug/trace.ts'
import { ItemPrompts, echoesAnyPrompt } from './itemPrompts.ts'
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
  hearAudio?: (audioText: string, asrText: string, durationMs?: number) => void
  hear: (text: string, durationMs?: number) => void
  /** Демо: текст растёт в чате по словам (как delta), затем обычный hear. */
  hearLive?: (text: string, stepMs?: number) => void
  /** Демо плашки ведущей: «Слышу…» hearMs, потом «Поняла, думаю…» thinkMs, потом итоговый текст. */
  hearSlow?: (text: string, hearMs?: number, thinkMs?: number) => void
  setSpeechMs: (ms: number) => void
  /** Демо: ускорить отсчёт молчания (0.1 — в 10 раз быстрее, 1 — как в игре). */
  setIdleScale?: (scale: number) => void
  /** Демо/e2e: растянуть окно апелляции. */
  setAppealScale?: (scale: number) => void
  /** Только конференция на заглушке: портит байт пакета у joiner. */
  flipPackByte?: () => void
  /** Демо: сыграть эффект игры; возвращает маршрут (`local` / `stream` — через «Звуки игры» / `remote` / `broken` — участник не подключён, тишина). */
  playGameSound?: (kind: 'beep' | 'cat' | 'auction') => 'local' | 'stream' | 'remote' | 'broken'
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
  onSpeechStopped: (info: { durationMs: number; itemId: string | null; forced?: boolean }) => void = () => {}

  private audioItems = new AudioItems()
  private audioTexts = new Map<string, string>()
  private itemPrompts = new ItemPrompts()
  private promptEchoLogged = new Set<string>()
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

  judgmentCapabilities(): JudgmentCapabilities { return { isolatedAudioReference: true, parallelOutOfBand: true, model: 'mock' } }
  audioReference(itemId: string): AudioReference { return this.audioItems.reference(itemId) }
  waitForAudioItem(ref: AudioReference, deadlineAt: number, signal?: AbortSignal): Promise<AudioItemReady> {
    return this.audioItems.wait(ref, deadlineAt, signal)
  }
  requestAudioJudgment(context: JudgeRequestContext, instructions: string, signal?: AbortSignal): Promise<ToolCall> {
    if (!this.audioItems.status(context.audio).ready || signal?.aborted) return Promise.reject(new Error('audio-item-not-ready'))
    const text = this.audioTexts.get(context.audio.itemId) ?? ''
    return new Promise((resolve, reject) => {
      const generation = this.audioItems.generation
      const abort = () => { clearTimeout(timer); reject(new Error('cancelled')) }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        if (generation !== this.audioItems.generation) { reject(new Error('session-changed')); return }
        const args = judgeArguments(`${instructions}\nРеплика игрока: «${text}»`)
        if (!text.trim()) args.status = 'unintelligible'
        resolve({ name: 'submitAnswerJudgment', callId: `mock-audio-${++this.callSeq}`, arguments: args })
      }, speechPauseMs)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  publishAudioPlayerChat(itemId: string | null, heard: string): void {
    if (!itemId || this.playerChatPublished.has(itemId)) return
    this.suppressPlayerChat(itemId)
    this.playerChatPublished.add(itemId)
    pushPlayerLine(heard.trim() || 'речь не распознана', itemId)
  }

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

  /** Мок сам имитирует начало/конец речи — запасной commit не нужен, остаётся заглушкой для тестов. */
  forceInputCommit(_durationMs: number): boolean { return true }

  /** Последняя суженная схема инструмента — для тестов. */
  lastTool: { name: string } | null = null
  lastToolAudioItemId: string | null = null

  /** Сколько раз мастер выключал/включал локальную ведущую — для тестов. */
  localPlayback = true
  setLocalPlayback(enabled: boolean): void {
    this.localPlayback = enabled
  }

  outputLevel(): number {
    return 0
  }

  setOutputMuted(muted: boolean): void {
    if (muted) this.onLink({ host: 'idle' })
  }

  /** Сколько раз пауза выбрасывала речь игрока — для тестов. */
  discardedInput = 0
  discardInputAudio(): void {
    this.discardedInput += 1
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
    this.itemPrompts.set(prompt)
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
    clearLivePlayerLine(itemId)
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
    this.itemPrompts.finished(itemId)
    const matched = this.transcriptWaiters.get(itemId) ?? []
    this.transcriptWaiters.delete(itemId)
    for (const waiter of matched) waiter(line)
  }

  private removeTranscriptWaiter(itemId: string, finish: (line: StoredTranscript) => void): void {
    const left = (this.transcriptWaiters.get(itemId) ?? []).filter((waiter) => waiter !== finish)
    if (left.length) this.transcriptWaiters.set(itemId, left)
    else this.transcriptWaiters.delete(itemId)
  }

  interruptSpeech(_reason = ''): void {
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

  requestTool(purpose: string, turn: number, name: string, instructions: string, _isolated = false, tool?: { name: string }, audioItemId?: string): void {
    this.lastTool = tool ?? null
    this.lastToolAudioItemId = audioItemId ?? null
    const call: ToolCall = {
      name,
      callId: `mock-call-${++this.callSeq}`,
      arguments: name === 'submitAnswerJudgment' ? judgeArguments(instructions)
        : name === 'selectCatRecipient' ? catRecipientArguments(instructions)
          : name === 'pickCatStake' ? catStakeArguments(instructions)
            : name === 'auctionBid' ? auctionBidArguments(instructions, tool)
              : name === 'finalBet' ? finalBetArguments(instructions, tool)
            : selectArguments(instructions, audioItemId === undefined ? undefined : this.audioTexts.get(audioItemId)),
    }
    window.setTimeout(() => this.onToolCall(call, purpose, turn), speechPauseMs)
  }

  sendToolOutput(_callId: string, _output: unknown): void {}

  stopSession(): void {
    clearLivePlayerLine()
    this.speechToken += 1
    this.audioItems.reset()
    this.audioTexts.clear()
    this.itemPrompts.reset()
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
    this.hearAudio(text, text, durationMs, confidence)
  }

  /** Как delta у OpenAI: черновик растёт по словам; игра видит только итоговый hear. */
  hearLive(text: string, stepMs = 180, durationMs = 1000): string {
    const itemId = `mock-item-${++this.itemSeq}`
    const words = text.trim().split(/\s+/).filter(Boolean)
    words.forEach((_, index) => {
      window.setTimeout(() => this.offerLivePlayerChat(itemId, words.slice(0, index + 1).join(' ')), stepMs * index)
    })
    window.setTimeout(() => this.hearAudio(text, text, durationMs, null, itemId), stepMs * Math.max(1, words.length))
    return itemId
  }

  /** Как живой OpenAI: speech_started → (речь hearMs) → speech_stopped → (распознавание thinkMs) → completed. */
  hearSlow(text: string, hearMs = 2500, thinkMs = 1500): string {
    const itemId = `mock-item-${++this.itemSeq}`
    this.audioTexts.set(itemId, text)
    this.audioItems.observe({ type: 'input_audio_buffer.speech_started', item_id: itemId })
    this.itemPrompts.started(itemId)
    this.onSpeechStarted({ itemId })
    const words = text.trim().split(/\s+/).filter(Boolean)
    const stepMs = hearMs / Math.max(1, words.length)
    words.forEach((_, index) => {
      window.setTimeout(() => this.offerLivePlayerChat(itemId, words.slice(0, index + 1).join(' ')), stepMs * index)
    })
    window.setTimeout(() => {
      this.audioItems.observe({ type: 'input_audio_buffer.speech_stopped', item_id: itemId })
      this.audioItems.observe({ type: 'input_audio_buffer.committed', item_id: itemId })
      this.onSpeechStopped({ durationMs: hearMs, itemId })
      window.setTimeout(() => {
        clearLivePlayerLine(itemId)
        this.deliverTranscript(itemId, text)
      }, thinkMs)
    }, hearMs)
    return itemId
  }

  private offerLivePlayerChat(itemId: string, text: string): void {
    if (this.transcripts.has(itemId)) return
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

  hearAudio(audioText: string, text: string, durationMs = 1000, confidence: number | null = null, reservedId?: string): void {
    const itemId = reservedId ?? `mock-item-${++this.itemSeq}`
    clearLivePlayerLine(itemId)
    this.audioTexts.set(itemId, audioText)
    this.audioItems.observe({ type: 'input_audio_buffer.speech_started', item_id: itemId })
    this.itemPrompts.started(itemId)
    // Как живой сервер: speech_started раньше расшифровки.
    this.onSpeechStarted({ itemId })
    this.transcripts.set(itemId, { text, confidence })
    this.offerPlayerChat(itemId, text)
    this.itemPrompts.finished(itemId)
    // Запрошенная длительность, не wall-clock: иначе при fake timers (~40 мс)
    // фантом-гард принимал бы любой эталон за тишину.
    window.setTimeout(() => {
      this.audioItems.observe({ type: 'input_audio_buffer.speech_stopped', item_id: itemId })
      this.audioItems.observe({ type: 'input_audio_buffer.committed', item_id: itemId })
      this.onSpeechStopped({ durationMs, itemId })
    }, speechPauseMs)
  }

  private offerPlayerChat(itemId: string, text: string): void {
    if (this.isPromptEcho(text, itemId)) return
    if (this.playerChatSuppressed.has(itemId) || this.playerChatPublished.has(itemId)) return
    if (this.playerChatGated && !this.playerChatAllowed.has(itemId)) {
      this.playerChatPending.set(itemId, text)
      return
    }
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
    if (instructions.includes('Комната только открыта')) return 'Игра создана. Ждём игроков.'
    return ''
  }
  if (purpose === 'clarify') return 'Не расслышала. Назовите тему и стоимость ещё раз.'
  if (purpose === 'announce') return announceLine(instructions)
  if (purpose === 'bridge') return 'Следующий раунд. Выбирайте вопрос.'
  if (purpose === 'finished') return 'Игра окончена.'
  if (purpose === 'bet') return 'Назовите ставку.'
  if (purpose === 'turn') return 'Ваш ответ.'
  if (purpose === 'finalIntro') return 'Ответ вводим на табло: короткий ответ, 30 секунд.'
  if (purpose === 'finalTyped') return 'Напечатайте короткий ответ на табло.'
  if (purpose === 'stake') return 'Смотрим ставку.'
  if (purpose === 'score') return 'Ставка раскрыта.'
  if (purpose === 'appeal') return 'Повторите ответ, пожалуйста.'
  if (purpose === 'roundSummary') return 'Раунд окончен. Впереди следующий раунд.'
  if (purpose === 'buzzCall') {
    const name = /Игрок (.+?) первым нажал/.exec(instructions)?.[1]?.trim()
    return name ? `${name}, ваш ответ.` : 'Ваш ответ.'
  }
  if (purpose === 'micWarning') {
    const name =
      /Имя игрока:\s*(.+)/.exec(instructions)?.[1]?.split('\n')[0]?.trim() ||
      /(?:Выбирает вопрос|Отвечает после кнопки) игрок:\s*(.+?)\.\s/.exec(instructions)?.[1]?.trim() ||
      /выбирает вопрос[\s\S]*?([А-ЯA-Z][^\s,]+)/.exec(instructions)?.[1]?.trim()
    return name ? `${name}, включи микрофон.` : 'Микрофон выключен.'
  }
  if (purpose === 'idleNudge') return 'Ждём ваш выбор.'
  if (purpose === 'idleAuto') return 'Ставка минимальная.'
  if (purpose === 'chooserHandoff' && /не выбран/.test(instructions)) {
    const next = /теперь выбирает\s+([^.]+)\./.exec(instructions)?.[1]?.trim()
    return next ? `Время вышло. Выбирает ${next}.` : 'Время вышло. Выбирайте снова.'
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
  const special: Record<string, string> = {
    cat: 'Кот в мешке! Кому отдаёте вопрос?',
    catClarify: 'Не расслышала. Кому отдаёте?',
    catStake: 'Ваша ставка?',
    catStakeClarify: 'Минимум или максимум?',
    auction: 'Аукцион! Ваша ставка?',
    auctionAsk: 'Перекупаете?',
    auctionClarify: 'Не расслышала ставку.',
    auctionWon: 'Торги закончены.',
    specialAway: 'Игрок отключился, подождём.',
  }
  if (special[purpose]) return special[purpose]
  return 'Слушаю.'
}

function announceLine(instructions: string): string {
  // Current cue wins over older outcomes in commentary and negative constraints.
  instructions = instructions.split('\n\nПубличный контекст')[0] ?? instructions
  const folded = instructions.toLowerCase().replaceAll('ё', 'е')
  const quoted = [...instructions.matchAll(/«([^»]+)»/g)].map((match) => match[1]?.trim() ?? '').filter(Boolean)
  // Итог апелляции: заглушка говорит ровно пример из подсказки (итог за этот вопрос числом).
  const appeal = /Апелляция игрока (.+?) (принята|не принята)[^.]*\. За этот вопрос (?:осталось (.+?)|было (.+?), стало (.+?))\. Общий счёт (-?\d+)\./.exec(instructions)
  if (appeal) {
    const number = (words: string | undefined) => {
      for (let n = -5000; n <= 5000; n += 50) if (amountWords(n) === words) return n
      return 0
    }
    const amount = number(appeal[3] ?? appeal[5])
    const previous = appeal[3] ? amount : number(appeal[4])
    return appealResultLine({ name: appeal[1] ?? '', accepted: appeal[2] === 'принята', previous, amount, total: Number(appeal[6]) })
  }
  if (folded.includes('произнеси') && quoted[0]) return quoted[0]
  if (folded.includes('исход: молчание')) return 'Ничего не услышала, минус.'
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

/** Мок запасного выбора получателя: имя по первым двум буквам, ровно один кандидат. */
function catRecipientArguments(instructions: string): Record<string, unknown> {
  const heard = quoted(instructions, 'Распознанный текст')
  const words = normalize(heard).split(' ').filter(Boolean)
  const candidates = [...instructions.matchAll(/^(\d+): (.+)$/gm)].map((match) => ({ id: Number(match[1]), name: normalize(match[2] ?? '') }))
  const hits = candidates.filter((candidate) => words.some((word) => word.length >= 3 && word.slice(0, 2) === candidate.name.slice(0, 2)))
  const hit = hits.length === 1 ? hits[0] : undefined
  return { playerId: hit?.id ?? 0, confident: Boolean(hit), heard }
}

/** Мок запасной ставки: «по-крупному» — максимум, «поскромнее» — минимум, «до конца» — ва-банк, «отказываюсь» — пас. */
function catStakeArguments(instructions: string): Record<string, unknown> {
  const heard = quoted(instructions, 'Распознанный текст')
  const text = normalize(heard)
  if (/крупн/.test(text)) return { option: 'max', heard }
  if (/скромн/.test(text)) return { option: 'min', heard }
  return { option: 'unclear', heard }
}

function schemaEnum(tool: unknown, key: string): unknown[] {
  const value = (tool as { parameters?: { properties?: Record<string, { enum?: unknown[] }> } } | undefined)?.parameters?.properties?.[key]?.enum
  return Array.isArray(value) ? value : []
}

function auctionBidArguments(instructions: string, tool: unknown): Record<string, unknown> {
  const heard = quoted(instructions, 'Распознанный текст')
  const text = normalize(heard)
  const choices = schemaEnum(tool, 'choice')
  const amounts = schemaEnum(tool, 'amount').map(Number).filter((amount) => amount > 0)
  if (/отказ|сдаюсь/.test(text) && choices.includes('pass')) return { choice: 'pass', amount: 0, heard }
  if (/до конца/.test(text) && choices.includes('allIn')) return { choice: 'allIn', amount: 0, heard }
  if (/крупн/.test(text) && amounts.length) return { choice: 'amount', amount: Math.max(...amounts), heard }
  if (/скромн/.test(text) && amounts.length) return { choice: 'amount', amount: Math.min(...amounts), heard }
  return { choice: 'unclear', amount: 0, heard }
}

function finalBetArguments(instructions: string, tool: unknown): Record<string, unknown> {
  const heard = quoted(instructions, 'Распознанный текст')
  const text = normalize(heard)
  const max = Number((tool as { parameters?: { properties?: { amount?: { maximum?: number } } } } | undefined)?.parameters?.properties?.amount?.maximum ?? 0)
  if (/до конца|ва-?банк/.test(text)) return { amount: 0, allIn: true, unclear: false, heard }
  if (/крупн/.test(text)) return { amount: max, allIn: false, unclear: false, heard }
  return { amount: 0, allIn: false, unclear: true, heard }
}

/** audioText — «звук» реплики в моке: пустой — шума без речи (распознавание могло выдумать текст). */
function selectArguments(instructions: string, audioText?: string): Record<string, unknown> {
  if (audioText !== undefined && !audioText.trim()) return { themeId: '', value: 0, confident: false, heard: '', speech: 'noise' }
  const heard = quoted(instructions, 'Распознанный текст')
  const needle = normalize(heard)
  // Строки «id — тема: 200, 400» (свободные ячейки по темам).
  const cells = [...instructions.matchAll(/^(\S+) — (.+): ([\d, ]+)$/gm)].flatMap((match) =>
    (match[3] ?? '').split(',').map((value) => ({
      id: (match[1] ?? '').trim(),
      name: (match[2] ?? '').trim(),
      value: Number(value.trim()),
    })))
  const hint = /уже назвала тему (\S+) — /.exec(instructions)?.[1]
  const hit = cells.find((cell) => {
    const name = normalize(cell.name)
    return name.length > 0 && needle.includes(name) && hasNumber(needle, cell.value)
  }) ?? cells.find((cell) => cell.id === hint && hasNumber(needle, cell.value))
  return {
    themeId: hit?.id ?? '',
    value: hit?.value ?? 0,
    confident: Boolean(hit),
    heard,
    speech: hit ? 'choice' : 'other',
  }
}

const mockStall = /^(?:(?:э+|м+|хе|ха|щас|сейчас|секунду|подождите|дайте подумать|отвечу)[\s,.!…-]*)+$/i

function judgeArguments(instructions: string): Record<string, unknown> {
  const heard = quoted(instructions, 'Реплика игрока')
  const answers = choiceForms(
    instructions,
    (field(instructions, 'Эталонные ответы пакета (список может быть неполным)') || field(instructions, 'Эталон, с которым нужно сравнить смысл'))
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const correct = sharesAnswer(heard, answers)
  const clarify = !correct && nearHomophone(heard, answers)
  // Имитация модели (только мок/демо): пусто — шум, заминки — stall, остальное — ответ.
  const speech = !heard.trim() || heard === 'речь не распознана' ? 'noise' : !correct && mockStall.test(heard.trim()) ? 'stall' : 'answer'
  return {
    status: speech === 'noise' ? 'unintelligible' : correct ? 'correct' : clarify ? 'needs_clarification' : 'incorrect',
    speech,
    guessing: false,
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

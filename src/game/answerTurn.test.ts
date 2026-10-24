import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
import { answerMs, answerOverrunSafetyMs, answerSilenceDecideMs } from '../options.ts'
import { attachController, judgmentInstructions } from './controller.ts'
import { gameMachine, statePath } from './machine.ts'
import type { QuestionPack } from './types.ts'

/**
 * Ответ из нескольких реплик (как выбор ячейки): каждая реплика оценивается моделью сама,
 * решение — после answerSilenceDecideMs тишины, засчитывается строго последний разборчивый ответ.
 */
vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
const pack: QuestionPack = {
  name: 'Turn', rounds: [{ index: 0, kind: 'normal', name: 'Раунд' }], warnings: [],
  questions: [{ id: 'q', themeId: 't', themeName: 'Тема', roundIndex: 0, value: 100, text: 'Пылесос плюс осел?', answers: ['пылесосел'] }],
}
let cleanups: Array<() => void> = []
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => { for (const stop of cleanups) stop(); cleanups = []; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Мок-модель, которая на N-й оценке говорит «перебор вариантов». */
class GuessClient extends MockRealtimeClient {
  judged = 0
  guessOn = new Set<number>()
  instructions: string[] = []
  override requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false, tool?: { name: string }): void {
    if (name !== 'submitAnswerJudgment') { super.requestTool(purpose, turn, name, instructions, isolated, tool); return }
    this.judged += 1
    this.instructions.push(instructions)
    if (!this.guessOn.has(this.judged)) { super.requestTool(purpose, turn, name, instructions, isolated, tool); return }
    window.setTimeout(() => this.onToolCall({ name, callId: `g${this.judged}`, arguments: {
      status: 'correct', heard: 'пылесосел', reason: 'Игрок перебирал варианты.', speech: 'answer', guessing: true } }, purpose, turn), 40)
  }
}

/** Мок-модель, которая для каждой реплики по порядку возвращает заданный вердикт. */
class StatusClient extends MockRealtimeClient {
  statuses: Array<{ status: string; heard?: string }> = []
  judged = 0
  override requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false, tool?: { name: string }): void {
    if (name !== 'submitAnswerJudgment') { super.requestTool(purpose, turn, name, instructions, isolated, tool); return }
    const verdict = this.statuses[this.judged] ?? { status: 'correct', heard: 'пылесосел' }
    this.judged += 1
    window.setTimeout(() => this.onToolCall({ name, callId: `s${this.judged}`, arguments: {
      status: verdict.status, heard: verdict.heard ?? '', reason: '', speech: 'answer' } }, purpose, turn), 40)
  }
}

async function boot(client: MockRealtimeClient, beforeBuzz?: () => void, questions?: QuestionPack) {
  const actor = createActor(gameMachine); actor.start()
  const stop = attachController({ actor, client, judgmentMode: 'text', getApiKey: () => 'k', setLink: () => {} })
  cleanups.push(() => { stop(); actor.stop() })
  actor.send({ type: 'START_GAME', pack: questions ?? pack })
  await vi.advanceTimersByTimeAsync(80)
  actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 100 })
  await vi.advanceTimersByTimeAsync(1200)
  expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
  beforeBuzz?.()
  actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
  return { actor, score: () => actor.getSnapshot().context.players[0]!.score, path: () => statePath(actor.getSnapshot().value) }
}
const notes = () => getTrace().filter((e) => e.kind === 'note').map((e) => e.title)

describe('ответ из нескольких реплик', () => {
  it('Qwen подменила Per di manocchio на Первый диманокль и сказала correct: нет начисления или штрафа', async () => {
    const client = new StatusClient()
    client.statuses = [{ status: 'correct', heard: 'Первый диманокль.' }]
    const roman: QuestionPack = { ...pack, questions: [{ ...pack.questions[0]!,
      text: 'Как звали первого римского императора?', answers: ['Октавиан Август', 'Август'] }] }
    const { actor, score, path } = await boot(client, undefined, roman)
    client.hear('Per di manocchio.', 850)
    await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(0)
    expect(path()).toBe('buzzing.open')
    expect(actor.getSnapshot().context.outcomes).toMatchObject({ q: { 1: { amount: 0, correct: false } } })
  })

  it('«хе-хе» → «щас-щас, отвечу» → ответ: засчитан ответ, вердикт только после тишины', async () => {
    const client = new MockRealtimeClient()
    const { score, path } = await boot(client)
    client.hear('хе-хе', 600); await vi.advanceTimersByTimeAsync(1000)
    expect(path()).toBe('answering.settling')
    client.hear('щас-щас, отвечу', 900); await vi.advanceTimersByTimeAsync(1500)
    client.hear('пылесосел', 900); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs - 500)
    expect(score()).toBe(0)
    expect(path()).toBe('answering.settling')
    await vi.advanceTimersByTimeAsync(800)
    expect(score()).toBe(100)
    expect(notes().some((t) => t.startsWith('ответ: берём реплику #3 из 3'))).toBe(true)
  })

  it('ответ, потом «эээ»: заминка после ответа пропускается', async () => {
    const client = new MockRealtimeClient()
    const { score } = await boot(client)
    client.hear('пылесосел', 900); await vi.advanceTimersByTimeAsync(1000)
    client.hear('эээ', 500); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(100)
    expect(notes().some((t) => t.startsWith('ответ: берём реплику #1 из 2'))).toBe(true)
  })

  it('верный ответ, потом «нет, Бетельгейзе»: считается последний, неверный', async () => {
    const client = new MockRealtimeClient()
    const { score } = await boot(client)
    client.hear('пылесосел', 900); await vi.advanceTimersByTimeAsync(1000)
    client.hear('нет, Бетельгейзе', 900); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(-100)
  })

  it('верный ответ, потом неразборчивая реплика: верное остаётся решающим', async () => {
    const client = new StatusClient()
    client.statuses = [{ status: 'correct', heard: 'пылесосел' }, { status: 'unintelligible' }]
    const { score } = await boot(client)
    client.hear('пылесосел', 900); await vi.advanceTimersByTimeAsync(1000)
    client.hear('пкпф', 600); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(100)
    expect(notes().some((t) => t.startsWith('ответ: берём реплику #1 из 2'))).toBe(true)
  })

  it('верный ответ, потом спорная реплика: верное остаётся решающим', async () => {
    const client = new StatusClient()
    client.statuses = [{ status: 'correct', heard: 'пылесосел' }, { status: 'ambiguous' }]
    const { score } = await boot(client)
    client.hear('пылесосел', 900); await vi.advanceTimersByTimeAsync(1000)
    client.hear('кажется, пылесос', 800); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(100)
  })

  it('созвучие всё равно просит повтор, даже если раньше был верный ответ', async () => {
    const client = new StatusClient()
    const titov: QuestionPack = {
      name: 'Turn', rounds: [{ index: 0, kind: 'normal', name: 'Раунд' }], warnings: [],
      questions: [{ id: 'q', themeId: 't', themeName: 'Тема', roundIndex: 0, value: 100, text: 'Кто был вторым человеком в космосе?', answers: ['Герман Титов'] }],
    }
    client.statuses = [{ status: 'correct', heard: 'Герман Титов' }, { status: 'incorrect', heard: 'Читов' }]
    const { score, path } = await boot(client, undefined, titov)
    client.hear('Герман Титов', 900); await vi.advanceTimersByTimeAsync(1000)
    client.hear('Читов', 800); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 200)
    // Решением стала реплика с созвучием: очки ещё не начислены, созвучие просит повтор.
    expect(score()).toBe(0)
    expect(path()).toBe('answering.waiting')
  })

  it('новая речь в паузе тишины откладывает вердикт: таймер начинается заново', async () => {
    const client = new MockRealtimeClient()
    const { score, path } = await boot(client)
    client.hear('Бетельгейзе', 900); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs - 300)
    client.onSpeechStarted({ itemId: 'long' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(path()).toBe('answering.hearing')
    expect(score()).toBe(0)
    client.deliverTranscript('long', 'пылесосел')
    client.emitSpeechStopped('long', 1000)
    await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(100)
  })

  it('перебор вариантов: модель почти уверена (guessing) → не засчитано, ведущая подмечает перебор', async () => {
    const client = new GuessClient()
    client.guessOn.add(3)
    const speech = vi.spyOn(client, 'requestSpeech')
    const { score } = await boot(client)
    client.hear('Бетельгейзе', 700); await vi.advanceTimersByTimeAsync(800)
    client.hear('Солнце', 700); await vi.advanceTimersByTimeAsync(800)
    client.hear('пылесосел', 700); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(-100)
    // Третья оценка видит прежние реплики по порядку.
    expect(client.instructions[2]).toContain('1) «Бетельгейзе» 2) «Солнце»')
    const announce = speech.mock.calls.filter((call) => call[0] === 'announce').map((call) => call[2]).join('\n')
    expect(announce).toContain('перебирал несколько вариантов наугад')
  })

  it('без перебора тот же ответ засчитан, и в вердикте нет замечания о переборе', async () => {
    const client = new GuessClient()
    const speech = vi.spyOn(client, 'requestSpeech')
    const { score } = await boot(client)
    client.hear('Бетельгейзе', 700); await vi.advanceTimersByTimeAsync(800)
    client.hear('пылесосел', 700); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(100)
    expect(speech.mock.calls.filter((call) => call[0] === 'announce').map((call) => call[2]).join('\n')).not.toContain('перебирал')
  })

  it('пауза посреди реплики: после «Дальше» окно ответа снова полное, не остаток', async () => {
    const client = new MockRealtimeClient()
    const { actor, score, path } = await boot(client)
    client.onSpeechStarted({ itemId: 'mid' })
    expect(path()).toBe('answering.hearing')
    await vi.advanceTimersByTimeAsync(answerMs - 2_000)
    expect(score()).toBe(0)
    expect(notes().some((t) => t.startsWith('ответ: общий лимит вышел'))).toBe(false)
    actor.send({ type: 'PAUSE', path: path() })
    expect(path()).toBe('paused')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(score()).toBe(0)
    actor.send({ type: 'RESUME' })
    expect(path()).toBe('answering.hearing')
    // Старый остаток был около 2 с: он не должен оборвать попытку.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(score()).toBe(0)
    expect(path()).toBe('answering.hearing')
    expect(notes().some((t) => t.startsWith('ответ: общий лимит вышел'))).toBe(false)
    await vi.advanceTimersByTimeAsync(answerMs - 4_000 - 200)
    expect(notes().some((t) => t.startsWith('ответ: общий лимит вышел'))).toBe(false)
    await vi.advanceTimersByTimeAsync(400)
    expect(notes().some((t) => t.startsWith('ответ: общий лимит вышел (посреди реплики'))).toBe(true)
    expect(score()).toBe(0)
    expect(path()).toBe('answering.hearing')
    client.deliverTranscript('mid', 'пылесосел')
    client.emitSpeechStopped('mid', answerMs)
    await vi.advanceTimersByTimeAsync(300)
    expect(score()).toBe(100)
  })

  it('пауза во время ожидания: таймеры стоят, после RESUME тишина считается заново', async () => {
    const client = new MockRealtimeClient()
    const { actor, score, path } = await boot(client)
    client.hear('пылесосел', 900); await vi.advanceTimersByTimeAsync(500)
    expect(path()).toBe('answering.settling')
    actor.send({ type: 'PAUSE', path: path() })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(score()).toBe(0)
    actor.send({ type: 'RESUME' })
    await vi.advanceTimersByTimeAsync(100)
    expect(path()).toBe('answering.settling')
    await vi.advanceTimersByTimeAsync(answerSilenceDecideMs)
    expect(score()).toBe(100)
  })

  it('общий лимит вышел посреди реплики: ждём её конец и оценку, решаем без паузы тишины', async () => {
    const client = new MockRealtimeClient()
    const { score, path } = await boot(client)
    await vi.advanceTimersByTimeAsync(answerMs - 1000)
    client.onSpeechStarted({ itemId: 'late' })
    await vi.advanceTimersByTimeAsync(2500)
    expect(path()).toBe('answering.hearing')
    expect(notes().some((t) => t.startsWith('ответ: общий лимит вышел (посреди реплики'))).toBe(true)
    client.deliverTranscript('late', 'пылесосел')
    client.emitSpeechStopped('late', 3500)
    await vi.advanceTimersByTimeAsync(300)
    expect(score()).toBe(100)
  })

  it('только шум и заминки: слушаем до общего лимита, потом как молчание', async () => {
    const client = new MockRealtimeClient()
    const { score, path } = await boot(client)
    client.hear('эээ', 600); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 500)
    expect(path()).toBe('answering.settling')
    expect(score()).toBe(0)
    await vi.advanceTimersByTimeAsync(answerMs)
    expect(score()).toBe(-100)
    expect(noAnswerNoted(getTrace())).toBe(true)
  })

  it('промпт оценки: строго последний разборчивый ответ, виды реплик и строгое правило перебора', () => {
    const actor = createActor(gameMachine); actor.start()
    actor.send({ type: 'START_GAME', pack })
    const text = judgmentInstructions(actor.getSnapshot().context, 'пылесосел', 'text', ['хе-хе', 'щас'])
    expect(text).toContain('Засчитывается строго последний разборчивый ответ')
    expect(text).toContain('speech — что в этой реплике')
    expect(text).toContain('только при почти полной уверенности')
    expect(text).toContain('Сомневаешься — false')
    expect(text).toContain('1) «хе-хе» 2) «щас»')
    expect(text).toContain('heard — дословная копия всей реплики игрока')
    expect(text).toContain('без сокращения, перевода и исправления под эталон')
    expect(text).toContain('При пустой расшифровке — unintelligible')
    expect(judgmentInstructions(actor.getSnapshot().context, 'x')).not.toContain('Это не первая реплика')
    actor.stop()
  })
})

function noAnswerNoted(trace: ReturnType<typeof getTrace>): boolean {
  return trace.some((e) => e.kind === 'note' && e.title.startsWith('ответ: разборчивого ответа нет'))
}

describe('шум после кнопки и эхо ведущей', () => {
  it('кашель во время обращения обрывает ведущую, но ответом не становится: потом засчитан настоящий ответ', async () => {
    const client = new MockRealtimeClient()
    const interrupt = vi.spyOn(client, 'interruptSpeech')
    const { score, path } = await boot(client, () => client.setSpeechMs(5000))
    await vi.advanceTimersByTimeAsync(50)
    client.hearAudio('', '', 300); await vi.advanceTimersByTimeAsync(400)
    expect(interrupt).toHaveBeenCalledWith('игрок заговорил на ответе')
    expect(path().startsWith('answering')).toBe(true)
    await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(path().startsWith('answering')).toBe(true)
    client.hear('пылесосел', 800); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(score()).toBe(100)
  })

  it('промпт оценки получает последнюю реплику ведущей: эхо — noise', () => {
    const actor = createActor(gameMachine); actor.start()
    actor.send({ type: 'START_GAME', pack })
    const text = judgmentInstructions(actor.getSnapshot().context, 'Вася, вам слово', 'text', [], 'Вася, вам слово')
    expect(text).toContain('Последняя реплика ведущей')
    expect(text).toContain('эхо этих слов ведущей')
    actor.stop()
  })
})

describe('длинная реплика', () => {
  it('реплика 25 с — не молчание: её оценивают, прежние реплики тоже учитываются', async () => {
    const client = new MockRealtimeClient()
    const { score, path } = await boot(client)
    client.hear('эээ', 500); await vi.advanceTimersByTimeAsync(800)
    client.onSpeechStarted({ itemId: 'long' })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(path()).toBe('answering.hearing')
    expect(score()).toBe(0)
    client.deliverTranscript('long', 'пылесосел')
    client.emitSpeechStopped('long', 25_000)
    await vi.advanceTimersByTimeAsync(300)
    expect(score()).toBe(100)
  })

  it('бесконечная реплика (VAD завис): по страховке без штрафа молчания', async () => {
    const client = new MockRealtimeClient()
    const { score, path } = await boot(client)
    client.onSpeechStarted({ itemId: 'stuck' })
    await vi.advanceTimersByTimeAsync(answerMs + answerOverrunSafetyMs + 500)
    expect(path().startsWith('answering')).toBe(false)
    expect(score()).toBe(0)
  })
})

describe('пометки реплик в чате', () => {
  const playerMarks = () => getTrace().filter((e) => e.kind === 'chat' && (e.detail as { role?: string }).role === 'player')
    .map((e) => { const d = e.detail as { text: string; mark?: { kind: string; verdict?: string } }; return `${d.text}:${d.mark?.kind ?? ''}${d.mark?.verdict ? `:${d.mark.verdict}` : ''}` })
  const speakers = () => getTrace().filter((e) => e.kind === 'chat' && (e.detail as { role?: string }).role === 'player')
    .map((e) => (e.detail as { speakerId?: number }).speakerId)

  it('ответ: заминка и шум помечены, взятая реплика — с вердиктом оценки, подпись — имя отвечающего', async () => {
    const client = new MockRealtimeClient()
    await boot(client)
    client.hear('хе-хе', 600); await vi.advanceTimersByTimeAsync(800)
    client.hear('пылесосел', 700); await vi.advanceTimersByTimeAsync(800)
    client.hear('эээ', 500); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    expect(playerMarks().slice(-3)).toEqual(['хе-хе:stall', 'пылесосел:counted:correct', 'эээ:stall'])
    expect(speakers().slice(-3)).toEqual([1, 1, 1]) // отвечает игрок 1 — в строке его id, не имя
  })

  it('ответ: перебор помечен «перебор»', async () => {
    const client = new GuessClient()
    client.guessOn.add(2)
    await boot(client)
    client.hear('Бетельгейзе', 700); await vi.advanceTimersByTimeAsync(800)
    client.hear('пылесосел', 700); await vi.advanceTimersByTimeAsync(answerSilenceDecideMs + 300)
    // Перебор: вердикта нет — бейдж «✗ перебор», а не «✗ неверно».
    expect(playerMarks().slice(-2)).toEqual(['Бетельгейзе:', 'пылесосел:guessing'])
  })
})

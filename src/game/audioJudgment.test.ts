import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
import type { ToolCall } from '../realtime/client.ts'
import type { JudgeRequestContext, JudgmentInputMode } from '../realtime/judgmentRequest.ts'
import { attachController } from './controller.ts'
import { gameMachine, statePath } from './machine.ts'
import type { QuestionPack } from './types.ts'
import { answerMs, answerSilenceDecideMs as quietMs } from '../options.ts'

vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
const pack: QuestionPack = {
  name: 'Audio', rounds: [{ index: 0, kind: 'normal', name: 'Раунд' }], warnings: [],
  questions: [{ id: 'q', themeId: 't', themeName: 'Тема', roundIndex: 0, value: 100, text: 'Пылесос плюс осел?', answers: ['пылесосел'] },
    { id: 'q2', themeId: 't', themeName: 'Тема', roundIndex: 0, value: 200, text: 'Другой вопрос', answers: ['Солнце'] }],
}
let cleanups: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { for (const stop of cleanups) stop(); cleanups = []; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function boot(client: MockRealtimeClient, mode: JudgmentInputMode, questions = pack, getJudgmentMode?: () => JudgmentInputMode) {
  const actor = createActor(gameMachine); actor.start()
  const cursor = getTrace().at(-1)?.id ?? 0
  const stop = attachController({ actor, client, judgmentMode: mode, getJudgmentMode, getApiKey: () => 'test-key', setLink: () => {} })
  cleanups.push(() => { stop(); actor.stop() })
  actor.send({ type: 'START_GAME', pack: questions })
  await vi.advanceTimersByTimeAsync(80)
  actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 100 })
  await vi.advanceTimersByTimeAsync(1200)
  expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
  actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
  return { actor, score: () => actor.getSnapshot().context.players[0]!.score,
    lines: (title: string) => getTrace().filter((e) => e.id > cursor && e.kind === 'chat' && e.title === title).map((e) => (e.detail as { text: string }).text)
      // Эталон в чат пишется отдельной строкой «Оценки»; здесь считаем только вердикты.
      .filter((text) => !text.startsWith('Правильный ответ:')),
    answerLines: () => getTrace().filter((e) => e.id > cursor && e.kind === 'chat').map((e) => (e.detail as { text: string }).text).filter((text) => text.startsWith('Правильный ответ:')),
    notes: () => getTrace().filter((e) => e.id > cursor && e.kind === 'note') }
}
class DeferredJudge extends MockRealtimeClient {
  calls = 0
  complete: ((call: ToolCall) => void) | null = null
  request: JudgeRequestContext | null = null
  override requestAudioJudgment(context: JudgeRequestContext, _instructions: string, signal?: AbortSignal): Promise<ToolCall> {
    this.calls++
    this.request = context
    return new Promise((resolve, reject) => {
      this.complete = resolve
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  }
  finish(overrides: object = {}) {
    const q = this.request!
    this.complete?.({ name: 'submitAnswerJudgment', callId: 'audio', arguments: { questionId: q.questionId, playerId: q.playerId,
      attemptId: q.attemptId, status: 'correct', heard: 'пылесосел', reason: 'То же слово', ...overrides } })
  }
}
describe('audio judging gameplay', () => {
  it('uses audio heard instead of a wrong ASR and publishes one caption', async () => {
    const client = new MockRealtimeClient()
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const { score, lines, answerLines } = await boot(client, 'audio')
    client.hearAudio('пылесосел', 'пылесос и осел')
    await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(score()).toBe(100)
    expect(answerLines()).toHaveLength(1)
    expect(lines('Игрок')).toEqual(['пылесосел'])
    expect(lines('Оценка')).toEqual(['Статус: correct\nУслышала: пылесосел'])
    expect(audio.mock.calls[0]![1]).not.toContain('Реплика игрока:')
    expect(audio.mock.calls[0]![1]).not.toContain('ПУБЛИЧНЫЙ')
  })
  it('does not force correct from a lucky ASR when audio heard a wrong answer', async () => {
    const client = new MockRealtimeClient()
    const { score, lines } = await boot(client, 'audio')
    client.hearAudio('Бетельгейзе', 'пылесосел')
    await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(score()).toBe(-100)
    expect(lines('Игрок')).toEqual(['Бетельгейзе'])
  })
  it('shadow cannot award points or change public captions', async () => {
    const client = new MockRealtimeClient()
    const { score, lines, notes } = await boot(client, 'shadow')
    client.hearAudio('пылесосел', 'Бетельгейзе')
    await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(score()).toBe(-100)
    expect(lines('Игрок')).toEqual(['Бетельгейзе'])
    expect(lines('Оценка')).toHaveLength(1)
    const comparison = notes().find((e) => e.title === 'judgment shadow comparison')
    expect(comparison?.detail).toMatchObject({ agrees: false, text: { status: 'incorrect' }, audio: { status: 'correct' } })
  })
  it('has one technical fallback after the 12-second audio budget', async () => {
    const client = new DeferredJudge()
    const text = vi.spyOn(client, 'requestTool')
    const { score, lines, notes } = await boot(client, 'audio')
    client.hearAudio('это пылесосел', 'это пылесосел')
    await vi.advanceTimersByTimeAsync(12_120)
    expect(client.calls).toBe(1)
    expect(text.mock.calls.filter((call) => call[0] === 'judge')).toHaveLength(1)
    expect(score()).toBe(100)
    expect(lines('Оценка')).toHaveLength(1)
    expect(notes().filter((e) => e.title === 'audio judgment fallback')).toHaveLength(1)
    client.finish()
    await vi.advanceTimersByTimeAsync(20)
    expect(score()).toBe(100)
    expect(lines('Оценка')).toHaveLength(1)
  })
  it('does not fallback for an intelligible incorrect result', async () => {
    const client = new DeferredJudge()
    const text = vi.spyOn(client, 'requestTool')
    const { score } = await boot(client, 'audio')
    client.hear('пылесосел')
    await vi.advanceTimersByTimeAsync(80)
    client.finish({ status: 'incorrect', heard: 'Бетельгейзе' })
    await vi.advanceTimersByTimeAsync(100 + quietMs)
    expect(score()).toBe(-100)
    expect(text).not.toHaveBeenCalled()
  })
  it('holds an audio result on pause and applies once after RESUME', async () => {
    const client = new DeferredJudge()
    const { actor, score, lines } = await boot(client, 'audio')
    client.hear('пылесосел')
    await vi.advanceTimersByTimeAsync(80)
    actor.send({ type: 'PAUSE', path: statePath(actor.getSnapshot().value) })
    client.finish()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(score()).toBe(0)
    expect(lines('Оценка')).toHaveLength(0)
    actor.send({ type: 'RESUME' })
    await vi.advanceTimersByTimeAsync(100 + quietMs)
    expect(client.calls).toBe(1)
    expect(score()).toBe(100)
    expect(lines('Оценка')).toHaveLength(1)
  })
  it('does not resend a pending request when resuming without a held result', async () => {
    const client = new DeferredJudge()
    const { actor, score } = await boot(client, 'audio')
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(80)
    actor.send({ type: 'PAUSE', path: statePath(actor.getSnapshot().value) }); await vi.advanceTimersByTimeAsync(30_000)
    actor.send({ type: 'RESUME' }); await vi.advanceTimersByTimeAsync(100)
    expect(client.calls).toBe(1)
    client.finish(); await vi.advanceTimersByTimeAsync(100 + quietMs)
    expect(score()).toBe(100)
  })
  it.each(['STOP', 'NEXT_ROUND'] as const)('drops late audio after %s, including while paused', async (type) => {
    const client = new DeferredJudge()
    const { actor, score, lines } = await boot(client, 'audio')
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(80)
    actor.send({ type: 'PAUSE', path: statePath(actor.getSnapshot().value) }); actor.send({ type })
    client.finish(); await vi.advanceTimersByTimeAsync(100 + quietMs)
    expect(score()).toBe(0)
    expect(lines('Оценка')).toHaveLength(0)
  })
  it('rejects an audio judgment with an invalid status instead of forcing an ASR match; ids come from the request', async () => {
    const client = new DeferredJudge()
    const { score, notes } = await boot(client, 'audio')
    client.hearAudio('пылесосел', 'Бетельгейзе'); await vi.advanceTimersByTimeAsync(80)
    client.finish({ status: 'maybe' }); await vi.advanceTimersByTimeAsync(100 + quietMs)
    expect(score()).toBe(-100)
    expect(notes().find((e) => e.title === 'audio judgment fallback')?.detail).toMatchObject({ reason: 'invalid-audio-judgment' })
  })
  it('switches the next attempt without changing an in-flight audio judgment', async () => {
    const client = new DeferredJudge()
    let preference: JudgmentInputMode = 'audio'
    const { actor, score } = await boot(client, 'text', pack, () => preference)
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(80)
    preference = 'text'
    client.finish(); await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(score()).toBe(100)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 200 })
    await vi.advanceTimersByTimeAsync(1200)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    client.hearAudio('Бетельгейзе', 'Солнце'); await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(client.calls).toBe(1)
    expect(score()).toBe(300)
  })
  it('noise does not gain points from a hallucinated ASR etalon', async () => {
    const client = new MockRealtimeClient()
    const { score, lines } = await boot(client, 'audio')
    client.hearAudio('', 'пылесосел', 400)
    await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(score()).toBe(0)
    // Модель по звуку: речи нет (speech=noise). Ответа нет ни в одной реплике → как молчание: ждём общий лимит, потом минус.
    await vi.advanceTimersByTimeAsync(answerMs)
    expect(score()).toBe(-100)
    expect(lines('Оценка')).toEqual([])
  })
  it('cannot settle native audio through an unowned legacy callback', async () => {
    const client = new DeferredJudge()
    const { score, lines } = await boot(client, 'audio')
    client.hear('Бетельгейзе'); await vi.advanceTimersByTimeAsync(80)
    const request = client.request!
    client.onToolCall({ name: 'submitAnswerJudgment', callId: 'rogue', arguments: {
      questionId: request.questionId, playerId: request.playerId, attemptId: request.attemptId,
      status: 'correct', heard: 'пылесосел', reason: 'No ownership metadata',
    } }, 'judge', request.turn)
    expect(score()).toBe(0); expect(lines('Оценка')).toHaveLength(0)
    client.finish(); await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(score()).toBe(100); expect(lines('Оценка')).toHaveLength(1)
  })
  it('does not wait for ASR when the accepted audio item is already ready', async () => {
    const client = new MockRealtimeClient()
    const wait = vi.spyOn(client, 'waitForTranscript')
    const { score } = await boot(client, 'audio')
    client.hearAudio('пылесосел', '')
    await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(wait).not.toHaveBeenCalled()
    expect(score()).toBe(100)
  })
  it('falls back once when commit never arrives and keeps the total judging window', async () => {
    const client = new MockRealtimeClient()
    const text = vi.spyOn(client, 'requestTool')
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const { score, notes } = await boot(client, 'audio')
    const item = client.hearDeferred()
    client.deliverTranscript(item, 'это пылесосел')
    await vi.advanceTimersByTimeAsync(1700 + quietMs)
    expect(audio).not.toHaveBeenCalled()
    expect(text.mock.calls.filter((call) => call[0] === 'judge')).toHaveLength(1)
    expect(score()).toBe(100)
    expect(notes().find((e) => e.title === 'audio judgment fallback')?.detail).toMatchObject({ reason: 'budget-timeout' })
  })
  it('в финале ответы печатают на табло и аудиооценка не вызывается', async () => {
    const client = new MockRealtimeClient()
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const finalPack: QuestionPack = { ...pack,
      rounds: [...pack.rounds, { index: 1, kind: 'final', name: 'Финал' }],
      questions: [...pack.questions, { ...pack.questions[1]!, id: 'final', roundIndex: 1, themeId: 'final', themeName: 'Финал', value: 0 }],
    }
    const { actor, score } = await boot(client, 'audio', finalPack)
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(score()).toBe(100)
    actor.send({ type: 'NEXT_ROUND' }); await vi.advanceTimersByTimeAsync(80)
    // При единственной теме мок сам завершает объявление финала; вычёркивать нечего.
    // Ставки — только на табло, тайпер 30 секунд.
    expect(statePath(actor.getSnapshot().value)).toBe('finalBets.collecting')
    actor.send({ type: 'FINAL_STAKE', playerId: 1, amount: 10 })
    actor.send({ type: 'FINAL_STAKE', playerId: 2, amount: 0 })
    actor.send({ type: 'FINAL_STAKE', playerId: 3, amount: 0 })
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    audio.mockClear()
    // Мок доводит чтение и вызов отвечающего сам: ждём печать ответа.
    await vi.advanceTimersByTimeAsync(1500)
    expect(statePath(actor.getSnapshot().value)).toBe('finalTyped')
    actor.send({ type: 'FINAL_TYPED', playerId: 1, text: 'Солнце' })
    actor.send({ type: 'FINAL_TYPED', playerId: 2, text: '' })
    actor.send({ type: 'FINAL_TYPED', playerId: 3, text: '' })
    expect(statePath(actor.getSnapshot().value)).toContain('finalReveal')
    // Разбор от меньшего счёта вверх: тишина вдвоём — минус нуля; «Солнце» от большего счёта — верно.
    const text = vi.spyOn(client, 'requestTool')
    for (let i = 0; i < 12 && statePath(actor.getSnapshot().value) !== 'finished'; i++) {
      await vi.advanceTimersByTimeAsync(12000)
    }
    expect(score()).toBe(110)
    expect(audio).not.toHaveBeenCalled()
    // Точный эталон решает машина: модель не дёргаем.
    expect(text).not.toHaveBeenCalled()
  })
  it('печатный ответ не слово-в-слово решает модель: неверный — минус ставки', async () => {
    const client = new MockRealtimeClient()
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const finalPack: QuestionPack = { ...pack,
      rounds: [...pack.rounds, { index: 1, kind: 'final', name: 'Финал' }],
      questions: [...pack.questions, { ...pack.questions[1]!, id: 'final', roundIndex: 1, themeId: 'final', themeName: 'Финал', value: 0 }],
    }
    const { actor, score } = await boot(client, 'audio', finalPack)
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(180 + quietMs)
    actor.send({ type: 'NEXT_ROUND' }); await vi.advanceTimersByTimeAsync(80)
    audio.mockClear()
    expect(statePath(actor.getSnapshot().value)).toBe('finalBets.collecting')
    actor.send({ type: 'FINAL_STAKE', playerId: 1, amount: 10 })
    actor.send({ type: 'FINAL_STAKE', playerId: 2, amount: 0 })
    actor.send({ type: 'FINAL_STAKE', playerId: 3, amount: 0 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(statePath(actor.getSnapshot().value)).toBe('finalTyped')
    actor.send({ type: 'FINAL_TYPED', playerId: 1, text: 'Пылесос' })
    actor.send({ type: 'FINAL_TYPED', playerId: 2, text: '' })
    actor.send({ type: 'FINAL_TYPED', playerId: 3, text: '' })
    // Не слово-в-слово — просим модель.
    const text = vi.spyOn(client, 'requestTool')
    for (let i = 0; i < 12 && statePath(actor.getSnapshot().value) !== 'finished'; i++) {
      await vi.advanceTimersByTimeAsync(12000)
    }
    // Модель вернула incorrect: минус ставки (10), у нулевых ставка — ноль.
    expect(score()).toBe(90)
    expect(audio).not.toHaveBeenCalled()
    expect(text.mock.calls.filter((call) => call[0] === 'finalJudge')).toHaveLength(1)
  })
  it('uses text when a provider does not support isolated references', async () => {
    const client = new MockRealtimeClient()
    vi.spyOn(client, 'judgmentCapabilities').mockReturnValue({ isolatedAudioReference: false, parallelOutOfBand: false, model: 'gemini-3.8-live' })
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const { score } = await boot(client, 'audio')
    client.hearAudio('Бетельгейзе', 'пылесосел'); await vi.advanceTimersByTimeAsync(180 + quietMs)
    expect(audio).not.toHaveBeenCalled(); expect(score()).toBe(100)
  })
})

describe('аудиооценка усомнилась, но услышала эталон (случай «Spotify» по картинке)', () => {
  it('ambiguous + heard = эталон + расшифровка = эталон → correct', async () => {
    const client = new DeferredJudge()
    const { score } = await boot(client, 'audio')
    client.hearAudio('пылесосел', 'пылесосел', 1500, 0.95)
    await vi.advanceTimersByTimeAsync(200)
    client.finish({ status: 'ambiguous', heard: 'пылесосел', reason: 'без картинки не подтвердить' })
    await vi.advanceTimersByTimeAsync(200 + quietMs)
    expect(score()).toBe(100)
  })
  it('ambiguous + heard = эталон, но расшифровка другая → остаётся спорным', async () => {
    const client = new DeferredJudge()
    const { score, lines } = await boot(client, 'audio')
    client.hearAudio('пылесосел', 'пылесос', 1500, 0.95)
    await vi.advanceTimersByTimeAsync(200)
    client.finish({ status: 'ambiguous', heard: 'пылесосел', reason: 'не уверена' })
    await vi.advanceTimersByTimeAsync(200 + quietMs)
    expect(score()).toBe(0)
    expect(lines('Оценка').join('\n')).toContain('ambiguous')
  })
})

describe('подтверждение эталона ждёт расшифровку по transcriptWaitMs', () => {
  it('расшифровка через 2 с (больше прежних 1,5 с) ещё подтверждает эталон', async () => {
    const client = new DeferredJudge()
    const { score, notes } = await boot(client, 'audio')
    client.hearAudio('пылесосел', '', 3000, 0.95, 'late-item')
    ;(client as unknown as { transcripts: Map<string, unknown> }).transcripts.delete('late-item')
    await vi.advanceTimersByTimeAsync(200)
    client.finish({ status: 'ambiguous', heard: 'пылесосел', reason: 'не уверена' })
    await vi.advanceTimersByTimeAsync(2000)
    client.deliverTranscript('late-item', 'пылесосел', 0.95)
    await vi.advanceTimersByTimeAsync(200 + quietMs)
    expect(notes().some((e) => e.title.startsWith('аудио и расшифровка обе дали эталон'))).toBe(true)
    expect(score()).toBe(100)
  })
})

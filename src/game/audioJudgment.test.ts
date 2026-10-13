import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTrace } from '../debug/trace.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
import type { ToolCall } from '../realtime/client.ts'
import type { JudgeRequestContext, JudgmentInputMode } from '../realtime/judgmentRequest.ts'
import { attachController } from './controller.ts'
import { gameMachine, statePath } from './machine.ts'
import type { QuestionPack } from './types.ts'

vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
const pack: QuestionPack = {
  name: 'Audio', rounds: [{ index: 0, kind: 'normal', name: 'Раунд' }], warnings: [],
  questions: [{ id: 'q', themeId: 't', themeName: 'Тема', roundIndex: 0, value: 100, text: 'Пылесос плюс осел?', answers: ['пылесосел'] },
    { id: 'q2', themeId: 't', themeName: 'Тема', roundIndex: 0, value: 200, text: 'Другой вопрос', answers: ['Солнце'] }],
}
let cleanups: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis); vi.spyOn(console, 'log').mockImplementation(() => {})
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
    lines: (title: string) => getTrace().filter((e) => e.id > cursor && e.kind === 'chat' && e.title === title).map((e) => (e.detail as { text: string }).text),
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
    const { score, lines } = await boot(client, 'audio')
    client.hearAudio('пылесосел', 'пылесос и осел')
    await vi.advanceTimersByTimeAsync(180)
    expect(score()).toBe(100)
    expect(lines('Игрок')).toEqual(['пылесосел'])
    expect(lines('Оценка')).toEqual(['Статус: correct\nУслышала: пылесосел'])
    expect(audio.mock.calls[0]![1]).not.toContain('Реплика игрока:')
    expect(audio.mock.calls[0]![1]).not.toContain('ПУБЛИЧНЫЙ')
  })
  it('does not force correct from a lucky ASR when audio heard a wrong answer', async () => {
    const client = new MockRealtimeClient()
    const { score, lines } = await boot(client, 'audio')
    client.hearAudio('Бетельгейзе', 'пылесосел')
    await vi.advanceTimersByTimeAsync(180)
    expect(score()).toBe(-100)
    expect(lines('Игрок')).toEqual(['Бетельгейзе'])
  })
  it('shadow cannot award points or change public captions', async () => {
    const client = new MockRealtimeClient()
    const { score, lines, notes } = await boot(client, 'shadow')
    client.hearAudio('пылесосел', 'Бетельгейзе')
    await vi.advanceTimersByTimeAsync(180)
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
    client.hearAudio('пылесосел', 'пылесосел')
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
    await vi.advanceTimersByTimeAsync(100)
    expect(score()).toBe(-100)
    expect(text).not.toHaveBeenCalled()
  })
  it('holds an audio result on pause and applies once after RESUME', async () => {
    const client = new DeferredJudge()
    const { actor, score, lines } = await boot(client, 'audio')
    client.hear('пылесосел')
    await vi.advanceTimersByTimeAsync(80)
    actor.send({ type: 'PAUSE', path: 'judging' })
    client.finish()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(score()).toBe(0)
    expect(lines('Оценка')).toHaveLength(0)
    actor.send({ type: 'RESUME' })
    await vi.advanceTimersByTimeAsync(100)
    expect(client.calls).toBe(1)
    expect(score()).toBe(100)
    expect(lines('Оценка')).toHaveLength(1)
  })
  it('does not resend a pending request when resuming without a held result', async () => {
    const client = new DeferredJudge()
    const { actor, score } = await boot(client, 'audio')
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(80)
    actor.send({ type: 'PAUSE', path: 'judging' }); await vi.advanceTimersByTimeAsync(30_000)
    actor.send({ type: 'RESUME' }); await vi.advanceTimersByTimeAsync(100)
    expect(client.calls).toBe(1)
    client.finish(); await vi.advanceTimersByTimeAsync(100)
    expect(score()).toBe(100)
  })
  it.each(['STOP', 'NEXT_ROUND'] as const)('drops late audio after %s, including while paused', async (type) => {
    const client = new DeferredJudge()
    const { actor, score, lines } = await boot(client, 'audio')
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(80)
    actor.send({ type: 'PAUSE', path: 'judging' }); actor.send({ type })
    client.finish(); await vi.advanceTimersByTimeAsync(100)
    expect(score()).toBe(0)
    expect(lines('Оценка')).toHaveLength(0)
  })
  it('rejects audio with foreign ids instead of forcing an ASR match', async () => {
    const client = new DeferredJudge()
    const { score, notes } = await boot(client, 'audio')
    client.hearAudio('пылесосел', 'Бетельгейзе'); await vi.advanceTimersByTimeAsync(80)
    client.finish({ questionId: 'other' }); await vi.advanceTimersByTimeAsync(100)
    expect(score()).toBe(-100)
    expect(notes().find((e) => e.title === 'audio judgment fallback')?.detail).toMatchObject({ reason: 'invalid-audio-judgment' })
  })
  it('switches the next attempt without changing an in-flight audio judgment', async () => {
    const client = new DeferredJudge()
    let preference: JudgmentInputMode = 'audio'
    const { actor, score } = await boot(client, 'text', pack, () => preference)
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(80)
    preference = 'text'
    client.finish(); await vi.advanceTimersByTimeAsync(180)
    expect(score()).toBe(100)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 't', value: 200 })
    await vi.advanceTimersByTimeAsync(1200)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    client.hearAudio('Бетельгейзе', 'Солнце'); await vi.advanceTimersByTimeAsync(180)
    expect(client.calls).toBe(1)
    expect(score()).toBe(300)
  })
  it('noise does not gain points from a hallucinated ASR etalon', async () => {
    const client = new MockRealtimeClient()
    const { score, lines } = await boot(client, 'audio')
    client.hearAudio('', 'пылесосел', 400)
    await vi.advanceTimersByTimeAsync(180)
    expect(score()).toBe(0)
    expect(lines('Оценка')).toEqual(['Статус: unintelligible\nУслышала: —'])
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
    client.finish(); await vi.advanceTimersByTimeAsync(180)
    expect(score()).toBe(100); expect(lines('Оценка')).toHaveLength(1)
  })
  it('does not wait for ASR when the accepted audio item is already ready', async () => {
    const client = new MockRealtimeClient()
    const wait = vi.spyOn(client, 'waitForTranscript')
    const { score } = await boot(client, 'audio')
    client.hearAudio('пылесосел', '')
    await vi.advanceTimersByTimeAsync(180)
    expect(wait).not.toHaveBeenCalled()
    expect(score()).toBe(100)
  })
  it('falls back once when commit never arrives and keeps the total judging window', async () => {
    const client = new MockRealtimeClient()
    const text = vi.spyOn(client, 'requestTool')
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const { score, notes } = await boot(client, 'audio')
    const item = client.hearDeferred()
    client.deliverTranscript(item, 'пылесосел')
    await vi.advanceTimersByTimeAsync(1700)
    expect(audio).not.toHaveBeenCalled()
    expect(text.mock.calls.filter((call) => call[0] === 'judge')).toHaveLength(1)
    expect(score()).toBe(100)
    expect(notes().find((e) => e.title === 'audio judgment fallback')?.detail).toMatchObject({ reason: 'budget-timeout' })
  })
  it('keeps final answers on text, even when ordinary questions used audio', async () => {
    const client = new MockRealtimeClient()
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const finalPack: QuestionPack = { ...pack,
      rounds: [...pack.rounds, { index: 1, kind: 'final', name: 'Финал' }],
      questions: [...pack.questions, { ...pack.questions[1]!, id: 'final', roundIndex: 1, themeId: 'final', themeName: 'Финал', value: 0 }],
    }
    const { actor, score } = await boot(client, 'audio', finalPack)
    client.hear('пылесосел'); await vi.advanceTimersByTimeAsync(180)
    expect(score()).toBe(100)
    actor.send({ type: 'NEXT_ROUND' }); await vi.advanceTimersByTimeAsync(80)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'final', value: 0 })
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('finalBets.hearing')
    client.hear('10'); await vi.advanceTimersByTimeAsync(1300)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    audio.mockClear()
    client.hearAudio('Бетельгейзе', 'Солнце'); await vi.advanceTimersByTimeAsync(180)
    expect(audio).not.toHaveBeenCalled()
    expect(score()).toBe(110)
  })
  it('uses text when a provider does not support isolated references', async () => {
    const client = new MockRealtimeClient()
    vi.spyOn(client, 'judgmentCapabilities').mockReturnValue({ isolatedAudioReference: false, parallelOutOfBand: false, model: 'gemini-3.8-live' })
    const audio = vi.spyOn(client, 'requestAudioJudgment')
    const { score } = await boot(client, 'audio')
    client.hearAudio('Бетельгейзе', 'пылесосел'); await vi.advanceTimersByTimeAsync(180)
    expect(audio).not.toHaveBeenCalled(); expect(score()).toBe(100)
  })
})

import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { getTrace } from '../debug/trace.ts'
import type { ToolCall } from '../realtime/client.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
import { attachController } from './controller.ts'
import { gameMachine, statePath } from './machine.ts'
import type { Question, QuestionPack } from './types.ts'

function cell(id: string, themeId: string, themeName: string, value: number, text = 'Вопрос'): Question {
  return {
    id,
    roundIndex: 0,
    themeId,
    themeName,
    value,
    text,
    answers: ['ответ'],
  }
}

const pack: QuestionPack = {
  name: 'Тест',
  rounds: [{ index: 0, name: 'Раунд', kind: 'normal' }],
  warnings: [],
  questions: [
    cell('p-400', 'p', 'П......Ц', 400),
    cell('s-400', 's', 'СВОБОДНАЯ', 400),
    cell('v-200', 'v', 'ВОЛГА', 200),
    cell('f-500', 'f', 'ИЗВЕСТНЫЕ ФАМИЛИИ', 500),
  ],
}

class RewritingClient extends MockRealtimeClient {
  override requestTool(
    purpose: string,
    turn: number,
    name: string,
    instructions: string,
    isolated = false,
  ): void {
    const forward = this.onToolCall
    this.onToolCall = (call, toolPurpose) => {
      this.onToolCall = forward
      const rewritten: ToolCall | null = call
        ? {
            ...call,
            arguments: {
              ...(call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : {}),
              themeId: '',
              value: 0,
              confident: false,
              heard: 'Свободная касса. Ой.',
            },
          }
        : null
      forward(rewritten, toolPurpose)
    }
    super.requestTool(purpose, turn, name, instructions, isolated)
  }
}

function playerLines(): string[] {
  return getTrace().flatMap((entry) => {
    if (entry.kind !== 'chat' || entry.title !== 'Игрок') return []
    const text = (entry.detail as { text?: string } | undefined)?.text
    return text ? [text] : []
  })
}

function judgeLines(): string[] {
  return getTrace().flatMap((entry) => {
    if (entry.kind !== 'chat' || entry.title !== 'Оценка') return []
    const text = (entry.detail as { text?: string } | undefined)?.text
    return text ? [text] : []
  })
}

async function boot(client: MockRealtimeClient, questions = pack) {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    speechSynthesis: { cancel() {} },
  })
  const actor = createActor(gameMachine)
  actor.start()
  const stop = attachController({
    actor,
    client,
    getApiKey: () => 'test-key',
    setLink: () => {},
  })
  actor.send({ type: 'START_GAME', pack: questions })
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(80)
  return { actor, stop }
}

describe('attachController choice', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('оставляет выбор открытым, если распознавание повторило каталог', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    const echo = 'Тема и цена: ОРДЫ И ХАНЫ 200 двести, 400 четыреста, 600 шестьсот, 800 восемьсот.'
    client.hear(echo, 400)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(playerLines().some((line) => line.includes('Тема и цена'))).toBe(false)
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('подсказку'))).toBe(true)

    client.hear('ПЦ 400.', 800)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    expect(actor.getSnapshot().context.activeQuestionId).toBe('p-400')
    expect(playerLines().some((line) => line.includes('ПЦ 400'))).toBe(true)
    stop()
    actor.stop()
  })

  it('перебивает уточнение и не подменяет услышанное пересказом модели', async () => {
    const client = new RewritingClient()
    const { actor, stop } = await boot(client)
    client.hear('просто болтовня без темы', 1200)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.clarifying')
    const judge = judgeLines().at(-1) ?? ''
    expect(judge).toContain('Услышала: просто болтовня без темы')
    expect(judge).not.toContain('Свободная касса')

    client.hear('Свободная 400', 900)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    expect(actor.getSnapshot().context.activeQuestionId).toBe('s-400')
    stop()
    actor.stop()
  })
})

class PromptClient extends MockRealtimeClient {
  prompts: string[] = []

  override setTranscriptionPrompt(prompt: string): void {
    this.prompts.push(prompt)
    super.setTranscriptionPrompt(prompt)
  }
}

describe('attachController answer listening', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('подсказывает ответы только после кнопки и не оценивает эхо подсказки', async () => {
    const question = cell(
      'slag-100',
      'slag',
      'Шлакоблокунь',
      100,
      'Стороны заключили договор купли-продажи.',
    )
    question.answers = ['Пылесосел', 'Утюгусь']
    const coined: QuestionPack = {
      name: 'Тест',
      rounds: [{ index: 0, name: 'Раунд', kind: 'normal' }],
      warnings: [],
      questions: [question, cell('other-200', 'other', 'Другое', 200)],
    }
    const client = new PromptClient()
    const { actor, stop } = await boot(client, coined)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'slag', value: 100 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    const buzzer = client.prompts.at(-1) ?? ''
    expect(buzzer).toContain('кнопку')
    expect(buzzer).not.toContain('Пылесосел')
    expect(buzzer).not.toContain('Утюгусь')

    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    const hint = client.prompts.at(-1) ?? ''
    expect(hint).toContain('«Пылесосел»')
    expect(hint).toContain('«Утюгусь»')
    expect(hint).toContain('на слоги')
    expect(hint).not.toContain('Шлакоблокунь')
    expect(hint).not.toContain('договор')

    const score = () => actor.getSnapshot().context.players.find((player) => player.id === 1)?.score
    client.hear(hint, 800)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.hearing')
    expect(client.prompts.at(-1)).toContain('«Пылесосел»')
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(score()).toBe(0)
    expect(playerLines().some((line) => line.includes('Возможные ответы') || line.includes('Пылесосел'))).toBe(false)
    expect(judgeLines().some((line) => line.includes('Пылесосел'))).toBe(false)
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('подсказку ответа'))).toBe(true)

    client.hear('пылесосел', 800)
    await vi.advanceTimersByTimeAsync(120)
    expect(playerLines().some((line) => line.toLowerCase().includes('пылесосел'))).toBe(true)
    expect(judgeLines().some((line) => line.includes('correct') && line.toLowerCase().includes('пылесосел'))).toBe(true)
    expect(score()).toBe(100)
    stop()
    actor.stop()
  })
})

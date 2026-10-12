import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import { getTrace } from '../debug/trace.ts'
import type { ToolCall } from '../realtime/client.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
import { attachController, type GameControllerActions } from './controller.ts'
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
    this.onToolCall = (call, toolPurpose, turn) => {
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
      forward(rewritten, toolPurpose, turn)
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
  let actions: GameControllerActions | null = null
  const stop = attachController({
    actor,
    client,
    getApiKey: () => 'test-key',
    setLink: () => {},
    onActions: (next) => {
      actions = next
    },
  })
  actor.send({ type: 'START_GAME', pack: questions })
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(80)
  return {
    actor,
    stop,
    actions: () => {
      if (!actions) throw new Error('Действия контроллера не подключены')
      return actions
    },
  }
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

  it('свободно объявляет передачу выбора после отключения', async () => {
    const client = new MockRealtimeClient()
    const requestSpeech = vi.spyOn(client, 'requestSpeech')
    const { actor, stop } = await boot(client)

    actor.send({ type: 'CHOOSER_OFFLINE', fromPlayerId: 2, toPlayerId: 1 })
    const cue = String(requestSpeech.mock.calls.at(-1)?.[2] ?? '')
    expect(requestSpeech).toHaveBeenLastCalledWith(
      'chooserHandoff',
      expect.any(Number),
      cue,
      undefined,
      true,
      undefined,
    )
    expect(cue).toContain('Ситуация:')
    expect(cue).toContain('Игрок 2')
    expect(cue).toContain('Игрок 1')
    expect(cue).toContain('отключился')
    expect(cue).toContain('выбирает вопрос')
    expect(cue).not.toContain('Игрок 2 отключился. Игрок 1, выбирайте вопрос.')
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.chooserId).toBe(1)

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

  it('напоминает отвечающему о выключенном микрофоне, не закрывая ожидание ответа', async () => {
    const client = new MockRealtimeClient()
    const requestSpeech = vi.spyOn(client, 'requestSpeech')
    const { actor, stop, actions } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'p', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    actions().remindMutedChooser('Маша')
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    actions().remindMutedAnswerer('Игрок 1')
    const cue = String(requestSpeech.mock.calls.at(-1)?.[2] ?? '')
    expect(requestSpeech).toHaveBeenLastCalledWith('micWarning', expect.any(Number), cue, undefined, true)
    expect(cue).toContain('Игрок 1')
    expect(cue).toContain('Ситуация:')
    expect(cue).toContain('отвечает')
    expect(cue).toContain('микрофон выключен')
    expect(cue).not.toContain('микрофон-то выключен')
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    stop()
    actor.stop()
  })

  it('на выборе вопроса просит модель самой сказать про микрофон и не уходит из выбора', async () => {
    const client = new MockRealtimeClient()
    const requestSpeech = vi.spyOn(client, 'requestSpeech')
    const { actor, stop, actions } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    actions().remindMutedChooser('Маша')
    const cue = String(requestSpeech.mock.calls.at(-1)?.[2] ?? '')
    expect(requestSpeech).toHaveBeenLastCalledWith('micWarning', expect.any(Number), cue, undefined, true)
    expect(cue).toContain('Маша')
    expect(cue).toContain('Ситуация:')
    expect(cue).toContain('новыми словами')
    expect(cue).not.toContain('микрофон-то выключен')
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    stop()
    actor.stop()
  })

  it('после паузы с завершённой подсказкой про микрофон снова открывает микрофон', async () => {
    const client = new MockRealtimeClient()
    const setMic = vi.spyOn(client, 'setMicEnabled')
    const { actor, stop, actions } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    actions().remindMutedChooser('Маша')
    actor.send({ type: 'PAUSE', path: 'choosing.listening' })
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    await vi.advanceTimersByTimeAsync(80)
    setMic.mockClear()
    actor.send({ type: 'RESUME' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(setMic).toHaveBeenCalledWith(true)

    stop()
    actor.stop()
  })

  it('не принимает поздний selectQuestion после таймаута разбора выбора', async () => {
    class SilentToolClient extends MockRealtimeClient {
      lastToolTurn = 0
      override requestTool(_purpose: string, turn: number, _name: string, _instructions: string, _isolated = false): void {
        this.lastToolTurn = turn
      }
    }
    const client = new SilentToolClient()
    const { actor, stop } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    // Длинная фраза без ячейки → resolving и selectQuestion, ответ инструмента не шлём.
    client.hear('назовите пожалуйста какую-нибудь открытую тему', 1200)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.resolving')
    expect(client.lastToolTurn).toBeGreaterThan(0)
    const staleTurn = client.lastToolTurn

    await vi.advanceTimersByTimeAsync(gameConfig.judgeMs)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    client.onToolCall(
      {
        name: 'selectQuestion',
        callId: 'late-select',
        arguments: { themeId: 'p', value: 400, confident: true, heard: 'ПЦ 400' },
      },
      'select',
      staleTurn,
    )
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.activeQuestionId).toBeNull()

    stop()
    actor.stop()
  })

  it('обрывает подсказку про микрофон, когда игрок начал отвечать', async () => {
    const client = new MockRealtimeClient()
    const interrupt = vi.spyOn(client, 'interruptSpeech')
    const { actor, stop, actions } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'p', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    actions().remindMutedAnswerer('Игрок 1')
    interrupt.mockClear()
    client.hear('ответ', 800)
    expect(interrupt).toHaveBeenCalled()
    expect(statePath(actor.getSnapshot().value)).toBe('answering.hearing')

    stop()
    actor.stop()
  })

  it('не принимает запоздавшую речь прошлой попытки за ответ следующего игрока', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running'
        currentTime = 0
        destination = {}
        resume() {
          return Promise.resolve()
        }
        createOscillator() {
          return {
            type: 'sine',
            frequency: { value: 0 },
            connect() {},
            start() {},
            stop() {},
          }
        }
        createGain() {
          return {
            gain: {
              value: 0,
              setValueAtTime() {},
              linearRampToValueAtTime() {},
            },
            connect() {},
          }
        }
        close() {
          return Promise.resolve()
        }
      },
    )
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'p', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')

    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    await vi.advanceTimersByTimeAsync(gameConfig.answerMs)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing.speaking')
    expect(actor.getSnapshot().context.announceKind).toBe('silence')
    expect(actor.getSnapshot().context.players.find((player) => player.id === 1)?.score).toBe(-400)

    await vi.advanceTimersByTimeAsync(gameConfig.timeoutBeepMs + 80)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')

    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    const scoreBefore = actor.getSnapshot().context.players.find((player) => player.id === 2)?.score ?? 0

    client.deliverTranscript('late-masha', 'ответ')
    // durationMs больше возраста попытки Васи → речь началась ещё у Маши.
    client.emitSpeechStopped('late-masha', 8_000)
    await vi.advanceTimersByTimeAsync(80)

    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(actor.getSnapshot().context.players.find((player) => player.id === 2)?.score).toBe(scoreBefore)
    expect(actor.getSnapshot().context.activePlayerId).toBe(2)
    expect(
      getTrace().some((entry) => entry.kind === 'note' && String(entry.title).includes('поздняя речь ответа')),
    ).toBe(true)

    client.hear('ответ', 800)
    await vi.advanceTimersByTimeAsync(120)
    expect(actor.getSnapshot().context.players.find((player) => player.id === 2)?.score).toBe(scoreBefore + 400)

    stop()
    actor.stop()
  })

  it('после смены выбирающего не открывает ячейку по запоздавшему транскрипту', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    const itemId = client.hearDeferred(800)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    actor.send({ type: 'CHOOSER_OFFLINE', fromPlayerId: 2, toPlayerId: 1 })
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.chooserId).toBe(1)

    client.deliverTranscript(itemId, 'ПЦ 400.')
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(actor.getSnapshot().context.activeQuestionId).toBeNull()

    stop()
    actor.stop()
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

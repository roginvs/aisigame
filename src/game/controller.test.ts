import { focusedModelParticipantId } from '../conference/audioMix.ts'
import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameConfig } from '../config.ts'
import type { ConferenceHistoryMessage } from '../conference/messages.ts'
import { getTrace } from '../debug/trace.ts'
import type { ToolCall } from '../realtime/client.ts'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
import { attachController, specialListening, type GameControllerActions } from './controller.ts'
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

async function boot(client: MockRealtimeClient, questions = pack, getPublicHistory?: () => readonly ConferenceHistoryMessage[], playSpecialSound?: (kind: 'cat' | 'auction') => void) {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  })
  const actor = createActor(gameMachine)
  actor.start()
  let actions: GameControllerActions | null = null
  const stop = attachController({
    actor,
    client,
    getApiKey: () => 'test-key',
    getPublicHistory,
    playSpecialSound,
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

  it('до и во время чтения вопроса модель не видит эталон ответа', async () => {
    const secret = 'ЭТАЛОНСЕКРЕТ'
    const questions: QuestionPack = {
      ...pack,
      questions: pack.questions.map((q) => (q.id === 's-400' ? { ...q, text: 'Кто написал «Онегина»?', answers: [secret] } : q)),
    }
    const client = new MockRealtimeClient()
    const speech = vi.spyOn(client, 'requestSpeech')
    const tools = vi.spyOn(client, 'requestTool')
    const prompts = vi.spyOn(client, 'setTranscriptionPrompt')
    const { actor, stop } = await boot(client, questions, () => [])
    actor.send({ type: 'QUESTION_SELECTED', themeId: 's', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 100)
    const read = speech.mock.calls.find(([purpose]) => purpose === 'read')
    expect(read?.[3]).toBe('Кто написал «Онегина»?')
    const seen = JSON.stringify([speech.mock.calls, tools.mock.calls, prompts.mock.calls])
    expect(seen).not.toContain(secret)
    // Чтение вопроса: подсказка распознавателю пустая, без фраз-команд.
    expect(prompts.mock.calls.at(-1)?.[0]).toBe('')
    expect(JSON.stringify(prompts.mock.calls)).not.toContain('Пока ведущая читает')
    stop()
  })

  it('shares chat with free cues but keeps reading and judgment isolated', async () => {
    const client = new MockRealtimeClient()
    const speech = vi.spyOn(client, 'requestSpeech')
    const tools = vi.spyOn(client, 'requestTool')
    const { actor, stop } = await boot(client, pack, () => [{ kind: 'chat', name: 'Маша', text: 'CHAT_MARKER' }])
    expect(speech.mock.calls[0]?.[2]).toContain('CHAT_MARKER')
    actor.send({ type: 'QUESTION_SELECTED', themeId: 's', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 100)
    const read = speech.mock.calls.find(([purpose]) => purpose === 'read')
    expect(read?.[2]).not.toContain('CHAT_MARKER')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    client.hear('мой ответ', 1200)
    await vi.advanceTimersByTimeAsync(100)
    const judge = tools.mock.calls.find(([purpose]) => purpose === 'judge')
    expect(judge?.[3]).toContain('Вопрос: Вопрос')
    expect(judge?.[3]).toContain('ответ')
    expect(judge?.[3]).toContain('другим фактически верным ответом')
    expect(judge?.[3]).not.toContain('CHAT_MARKER')
    expect(judge?.[4]).toBe(true)
    stop()
    actor.stop()
  })

  it('мяу кота играет контроллер один раз на входе, не экран', async () => {
    const questions: QuestionPack = {
      ...pack,
      questions: pack.questions.map((q) => (q.id === 's-400'
        ? { ...q, cat: { source: 'cat' as const, theme: 'Звери', price: { kind: 'fixed' as const, value: 400 }, knows: 'after' as const, options: [400] } }
        : q)),
    }
    const sounds: string[] = []
    const { actor, stop } = await boot(new MockRealtimeClient(), questions, () => [], (kind) => sounds.push(kind))
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 's', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 3000)
    expect(sounds).toEqual(['cat'])
    stop()
    actor.stop()
  })

  it('после кнопки ведущая коротко зовёт по имени, а ответ поверх обращения принимается', async () => {
    const client = new MockRealtimeClient()
    client.setSpeechMs(60_000)
    const speech = vi.spyOn(client, 'requestSpeech')
    const interrupt = vi.spyOn(client, 'interruptSpeech')
    const tools = vi.spyOn(client, 'requestTool')
    const mic = vi.spyOn(client, 'setMicEnabled')
    const { actor, stop } = await boot(client, pack, () => [])
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 's', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 100)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    await vi.advanceTimersByTimeAsync(50)
    expect(statePath(actor.getSnapshot().value)).toMatch(/^buzzing/)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const call = speech.mock.calls.find(([purpose]) => purpose === 'buzzCall')
    expect(call?.[2]).toContain(actor.getSnapshot().context.players[0]!.name)
    expect(call?.[2]).toContain('Каждый раз формулируй иначе')
    expect(call?.[2]).not.toMatch(/«[^»]*отвечайте/i)
    // Слух открыт до начала обращения, а не после него.
    const callOrder = speech.mock.invocationCallOrder[speech.mock.calls.findIndex(([purpose]) => purpose === 'buzzCall')]!
    expect(mic.mock.calls.some(([on], i) => on === true && mic.mock.invocationCallOrder[i]! < callOrder)).toBe(true)
    expect(focusedModelParticipantId(statePath(actor.getSnapshot().value), null, 'p-answerer')).toBe('p-answerer')
    const before = interrupt.mock.calls.length
    client.hear('мой ответ', 1200)
    await vi.advanceTimersByTimeAsync(100)
    expect(interrupt.mock.calls.length).toBeGreaterThan(before)
    const judge = tools.mock.calls.find(([purpose]) => purpose === 'judge')
    expect(judge?.[3]).toContain('мой ответ')
    expect(getTrace().map((e) => e.title).some((t) => /эхо|отброшен/.test(t))).toBe(false)
    stop()
    actor.stop()
  })

  it('эталон пишется в чат ровно один раз, даже если речь ведущей не случилась', async () => {
    const client = new MockRealtimeClient()
    vi.spyOn(client, 'requestSpeech').mockImplementation(() => {})
    const { actor, stop } = await boot(client, pack, () => [])
    const start = getTrace().at(-1)?.id ?? 0
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'welcome' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 's', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 100)
    actor.send({ type: 'HOST_AUDIO_FINISHED', purpose: 'read' })
    await vi.advanceTimersByTimeAsync(gameConfig.buzzerMs + 200)
    expect(statePath(actor.getSnapshot().value)).toMatch(/^announcing/)
    const answers = getTrace().filter((e) => e.id > start && e.kind === 'chat' &&
      String((e.detail as { text?: string }).text ?? '').startsWith('Правильный ответ:'))
    expect(answers).toHaveLength(1)
    expect((answers[0]!.detail as { text: string }).text).toBe('Правильный ответ: ответ')
    stop()
    actor.stop()
  })

  it('оставляет выбор открытым, если распознавание повторило каталог', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    const echo = (client as unknown as { itemPrompts: { prompt: string } }).itemPrompts.prompt
    expect(echo.length).toBeGreaterThan(20)
    client.hear(echo, 400)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(playerLines().some((line) => line.includes(echo.slice(1, 15)))).toBe(false)
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('подсказку'))).toBe(true)

    client.hear('ПЦ 400.', 800)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('flashing')
    expect(actor.getSnapshot().context.activeQuestionId).toBe('p-400')
    expect(playerLines().some((line) => line.includes('ПЦ 400'))).toBe(true)
    stop()
    actor.stop()
  })

  it('шум, на котором распознавание выдумало список тем: модель по звуку — не речь, в чат «речь не распознана»', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    client.hearAudio('', 'П......Ц; СВОБОДНАЯ; ВОЛГА', 1300)
    await vi.advanceTimersByTimeAsync(400)
    expect(client.lastToolAudioItemId).toMatch(/^mock-item-/)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(playerLines().some((line) => line.includes('СВОБОДНАЯ; ВОЛГА'))).toBe(false)
    expect(playerLines()).toContain('речь не распознана')
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('модель по звуку: не речь'))).toBe(true)
    stop()
    actor.stop()
  })

  it('новый выбирающий может говорить, пока ведущая объявляет передачу хода', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    client.setSpeechMs(8000)
    actor.send({ type: 'CHOOSER_OFFLINE', fromPlayerId: 2, toPlayerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('chooserHandoff')
    client.hear('история сто', 1200)
    await vi.advanceTimersByTimeAsync(50)
    expect(statePath(actor.getSnapshot().value)).not.toBe('chooserHandoff')
    stop()
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
    )
    expect(cue).toContain('Ситуация:')
    expect(cue).toContain('Игрок 2')
    expect(cue).toContain('Игрок 1')
    expect(cue).toContain('отключён')
    expect(cue).toContain('попроси выбрать вопрос')
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
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    await vi.advanceTimersByTimeAsync(choiceClarifyAfterMs)
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

    actions().setChooserMicOff(true)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    actions().remindMutedAnswerer('Игрок 1')
    const cue = String(requestSpeech.mock.calls.at(-1)?.[2] ?? '')
    expect(requestSpeech).toHaveBeenLastCalledWith('micWarning', expect.any(Number), cue, undefined, true)
    expect(cue).toContain('Игрок 1')
    expect(cue).toContain('Ситуация:')
    expect(cue).toContain('Отвечает после кнопки')
    expect(cue).toContain('микрофон выключен')
    expect(cue).not.toContain('микрофон-то выключен')
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    stop()
    actor.stop()
  })

  it('микрофон выбирающего выключен: обычное напоминание говорит про микрофон, не больше двух раз за ход', async () => {
    const client = new MockRealtimeClient()
    const requestSpeech = vi.spyOn(client, 'requestSpeech')
    const { actor, stop, actions } = await boot(client)
    await toChoosing(actor)
    actions().setChooserMicOff(true)
    requestSpeech.mockClear()
    // Три напоминания подряд (20/40/60 с): два про микрофон, третье обычное.
    for (let i = 0; i < 3; i += 1) {
      const nudges = actor.getSnapshot().context.idleNudges ?? 0
      for (let t = 0; t < 400 && (actor.getSnapshot().context.idleNudges ?? 0) === nudges && statePath(actor.getSnapshot().value) === 'choosing.listening'; t += 1) await vi.advanceTimersByTimeAsync(100)
    }
    expect(requestSpeech.mock.calls.filter((call) => call[0] === 'micWarning')).toHaveLength(2)
    const cue = String(requestSpeech.mock.calls.find((call) => call[0] === 'micWarning')?.[2] ?? '')
    expect(cue).toContain('Ситуация:')
    expect(cue).toContain('новыми словами')
    stop()
    actor.stop()
  })

  it('отдельного цикла про микрофон нет: до напоминания выбора тишина', async () => {
    const client = new MockRealtimeClient()
    const requestSpeech = vi.spyOn(client, 'requestSpeech')
    const { actor, stop, actions } = await boot(client)
    await toChoosing(actor)
    actions().setChooserMicOff(true)
    requestSpeech.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestSpeech.mock.calls.filter((call) => call[0] === 'micWarning')).toHaveLength(0)
    stop()
    actor.stop()
  })

  it('после паузы с завершённой подсказкой про микрофон снова открывает микрофон', async () => {
    const client = new MockRealtimeClient()
    const setMic = vi.spyOn(client, 'setMicEnabled')
    const { actor, stop, actions } = await boot(client)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')

    actions().setChooserMicOff(true)
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

    // Длинная фраза без ячейки → selectQuestion (слушаем дальше, микрофон открыт), ответ инструмента не шлём.
    client.hear('назовите пожалуйста какую-нибудь открытую тему', 1200)
    await vi.advanceTimersByTimeAsync(80)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    expect(client.lastToolTurn).toBeGreaterThan(0)
    const staleTurn = client.lastToolTurn

    await vi.advanceTimersByTimeAsync(choiceResolveTimeoutMs)
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('модель не ответила'))).toBe(true)

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
    await vi.advanceTimersByTimeAsync(120 + answerSilenceDecideMs)
    expect(actor.getSnapshot().context.players.find((player) => player.id === 2)?.score).toBe(scoreBefore + 400)

    stop()
    actor.stop()
  })

  it('подхватывает речь, начатую до кнопки, в ту же попытку ответа', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'p', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')

    const itemId = 'carry-before-buzz'
    client.onSpeechStarted({ itemId })
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    client.deliverTranscript(itemId, 'ответ')
    client.emitSpeechStopped(itemId, 8_000)
    await vi.advanceTimersByTimeAsync(120 + answerSilenceDecideMs)

    expect(actor.getSnapshot().context.players.find((player) => player.id === 1)?.score).toBe(400)
    expect(playerLines().some((line) => line.includes('ответ'))).toBe(true)
    expect(
      getTrace().some((entry) => entry.kind === 'note' && String(entry.title).includes('подхвачена')),
    ).toBe(true)

    stop()
    actor.stop()
  })

  it('короткая расшифровка, равная эталону, перепроверяется по аудио: тишина не засчитывается, настоящий ответ — да', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'p', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    const scoreBefore = actor.getSnapshot().context.players.find((player) => player.id === 1)?.score ?? 0

    // Шум 400 мс: распознаватель подставил эталон из подсказки, а в аудио слов нет.
    client.hearAudio('', 'ответ', 400)
    await vi.advanceTimersByTimeAsync(400)
    expect(getTrace().some((entry) => entry.kind === 'note' && String(entry.title).includes('проверяю по аудио'))).toBe(true)
    expect(actor.getSnapshot().context.players.find((player) => player.id === 1)?.score).not.toBe(scoreBefore + 400)
    const after = actor.getSnapshot().context.players.find((player) => player.id === 1)?.score ?? 0
    expect(after).toBeLessThanOrEqual(scoreBefore)

    stop()
    actor.stop()
  })

  it('короткий настоящий ответ, равный эталону, подтверждается по аудио и засчитывается', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'p', value: 400 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    const scoreBefore = actor.getSnapshot().context.players.find((player) => player.id === 1)?.score ?? 0
    client.hearAudio('ответ', 'ответ', 400)
    await vi.advanceTimersByTimeAsync(400 + answerSilenceDecideMs)
    expect(actor.getSnapshot().context.players.find((player) => player.id === 1)?.score).toBe(scoreBefore + 400)
    stop()
    actor.stop()
  })

  it('не пишет в чат транскрипт отброшенной речи ответа', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running'
        destination = {}
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
        resume() {
          return Promise.resolve()
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
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

    client.deliverTranscript('discarded-early', 'Фотосинтез')
    client.emitSpeechStopped('discarded-early', 8_000)
    await vi.advanceTimersByTimeAsync(80)

    expect(playerLines().some((line) => line.includes('Фотосинтез'))).toBe(false)
    expect(
      getTrace().some((entry) => entry.kind === 'note' && String(entry.title).includes('поздняя речь ответа')),
    ).toBe(true)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')

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
    expect(buzzer).toBe('')
    expect(buzzer).not.toContain('Пылесосел')
    expect(buzzer).not.toContain('Утюгусь')

    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    const hint = client.prompts.at(-1) ?? ''
    expect(hint).toContain('Пылесосел')
    expect(hint).toContain('Утюгусь')
    expect(hint).not.toContain('отвечает')
    expect(hint).toContain('Редкие слова')
    expect(hint).not.toContain('«Пылесосел»')
    expect(hint).not.toContain('Шлакоблокунь')
    expect(hint).not.toContain('договор')

    const score = () => actor.getSnapshot().context.players.find((player) => player.id === 1)?.score
    client.hear(hint, 800)
    expect(statePath(actor.getSnapshot().value)).toBe('answering.hearing')
    expect(client.prompts.at(-1)).toContain('Пылесосел')
    await vi.advanceTimersByTimeAsync(80 + answerSilenceDecideMs)
    // Эхо подсказки — реплика «шум»: ответа нет, слушаем дальше до общего лимита.
    expect(statePath(actor.getSnapshot().value)).toBe('answering.settling')
    expect(score()).toBe(0)
    expect(playerLines().some((line) => line.includes('Редкие слова') || line.includes('Пылесосел'))).toBe(false)
    expect(judgeLines().some((line) => line.includes('Пылесосел'))).toBe(false)
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('подсказку ответа'))).toBe(true)

    client.hear('пылесосел', 800)
    await vi.advanceTimersByTimeAsync(120 + answerSilenceDecideMs)
    expect(playerLines().some((line) => line.toLowerCase().includes('пылесосел'))).toBe(true)
    expect(judgeLines().some((line) => line.includes('correct') && line.toLowerCase().includes('пылесосел'))).toBe(true)
    expect(score()).toBe(100)
    stop()
    actor.stop()
  })
})

describe('specialListening — ранний слух', () => {
  it('открыт на объявлении и ставке, пока ведущая ещё говорит', () => {
    expect(specialListening('cat.announcing')).toBe(true)
    expect(specialListening('cat.picking')).toBe(true)
    expect(specialListening('cat.staking.asking')).toBe(true)
    expect(specialListening('cat.staking.listening')).toBe(true)
    expect(specialListening('auction.announcing')).toBe(true)
    expect(specialListening('auction.asking')).toBe(true)
    expect(specialListening('auction.listening')).toBe(true)
    expect(specialListening('reading.sealed')).toBe(false)
    expect(specialListening('choosing.listening')).toBe(false)
  })
})

import { selectionInstructions } from './controller.ts'
import { answerSilenceDecideMs, choiceClarifyAfterMs, choiceLateTranscriptMs, choiceResolveTimeoutMs, transcriptWaitMs } from '../options.ts'

async function toChoosing(actor: { getSnapshot: () => { value: unknown } }) {
  for (let i = 0; i < 40 && statePath(actor.getSnapshot().value as never) !== 'choosing.listening'; i += 1) await vi.advanceTimersByTimeAsync(250)
}

describe('выбор ячейки голосом: тема в любой форме, мягкий номинал, опоздавшая расшифровка', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('промпт выбора: свободные ячейки по темам и правила формы темы и номинала', async () => {
    const { actor, stop } = await boot(new MockRealtimeClient())
    const text = selectionInstructions(actor.getSnapshot().context, 'Волге 200')
    expect(text).toContain('v — ВОЛГА: 200')
    expect(text).toContain('в любом падеже или числе')
    expect(text).toContain('лишней буквой у числа')
    expect(text).toContain('хватает одного его слова, если оно есть только в одной теме')
    expect(text).toContain('Номинал — только после того, как тема ясно названа')
    expect(text).toContain('бери ближайший')
    expect(text).toContain('Без ясно названной темы — confident=false')
    expect(text).toContain('Часто это не выбор: шум, кашель, междометие')
    expect(text).toContain('Не угадывай ячейку')
    stop(); actor.stop()
  })

  it('тема понятна без номинала → переспрос только стоимости, следующая реплика «200» открывает ячейку', async () => {
    class ThemeOnlyClient extends MockRealtimeClient {
      calls = 0
      override requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false, tool?: { name: string }): void {
        this.calls += 1
        if (this.calls > 1) { super.requestTool(purpose, turn, name, instructions, isolated, tool); return }
        window.setTimeout(() => this.onToolCall({ name, callId: 'c1', arguments: { themeId: 'v', value: 0, confident: false, heard: 'Волжское что-то' } }, purpose, turn), 10)
      }
    }
    const client = new ThemeOnlyClient()
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    client.hear('Волжское что-то такое длинное', 1500)
    await vi.advanceTimersByTimeAsync(200 + choiceClarifyAfterMs)
    expect(getTrace().some((line) => line.kind === 'state' && JSON.stringify(line.detail).includes('«ВОЛГА» понятна'))).toBe(true)
    for (let i = 0; i < 20 && statePath(actor.getSnapshot().value) !== 'choosing.listening'; i += 1) await vi.advanceTimersByTimeAsync(100)
    client.hear('двести', 800)
    await vi.advanceTimersByTimeAsync(300)
    expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
    stop(); actor.stop()
  })

  it('ожидание расшифровки растёт с длиной реплики до потолка', () => {
    expect(transcriptWaitMs(0)).toBe(2500)
    expect(transcriptWaitMs(5000)).toBe(4000)
    expect(transcriptWaitMs(60_000)).toBe(6000)
  })

  it('расшифровка не пришла — selectQuestion решает по звуку реплики, без немедленного переспроса', async () => {
    const client = new MockRealtimeClient()
    const tools = vi.spyOn(client, 'requestTool')
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    const item = client.hearDeferred(10_000)
    await vi.advanceTimersByTimeAsync(transcriptWaitMs(10_000) + 500)
    expect(tools.mock.calls.some((call) => call[2] === 'selectQuestion' && call[6] === item)).toBe(true)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    stop(); actor.stop()
  })

  describe('выбор по звуку без расшифровки: ячейка ждёт позднюю расшифровку', () => {
    class AudioPick extends MockRealtimeClient {
      calls = 0
      override requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false, tool?: { name: string }, audioItemId?: string): void {
        if (name !== 'selectQuestion') { super.requestTool(purpose, turn, name, instructions, isolated, tool, audioItemId); return }
        this.calls += 1
        window.setTimeout(() => this.onToolCall({ name, callId: `a${this.calls}`, arguments: { themeId: 'v', value: 200, confident: true, speech: 'choice', heard: 'Волга 200' } }, purpose, turn), 10)
      }
    }
    async function pickByAudio() {
      const client = new AudioPick()
      const prompts = vi.spyOn(client, 'setTranscriptionPrompt')
      const booted = await boot(client)
      await toChoosing(booted.actor)
      const item = client.hearDeferred(1500)
      // Ждём, пока выйдет ожидание расшифровки и модель ответит по звуку.
      await vi.advanceTimersByTimeAsync(transcriptWaitMs(1500) + 100)
      expect(client.calls).toBe(1)
      return { client, item, prompts, ...booted }
    }

    it('эхо каталога через 58 мс после уверенного выбора — ячейка не открыта (дамп 19:28:00.119Z)', async () => {
      const { client, item, prompts, actor, stop } = await pickByAudio()
      expect(actor.getSnapshot().context.activeQuestionId).toBeNull()
      const catalog = String(prompts.mock.calls.at(-1)?.[0] ?? '').replace(/^\{|\}$/g, '')
      expect(catalog.length).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(58)
      client.deliverTranscript(item, catalog)
      await vi.advanceTimersByTimeAsync(choiceLateTranscriptMs + choiceClarifyAfterMs)
      expect(actor.getSnapshot().context.activeQuestionId).toBeNull()
      expect(statePath(actor.getSnapshot().value)).toMatch(/^choosing/)
      stop(); actor.stop()
    })

    it('поздняя расшифровка — обычная речь: ячейка открывается сразу после неё', async () => {
      const { client, item, actor, stop } = await pickByAudio()
      client.deliverTranscript(item, 'Волга за двести')
      await vi.advanceTimersByTimeAsync(50)
      expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
      stop(); actor.stop()
    })

    it('расшифровка так и не пришла — после choiceLateTranscriptMs верим модели', async () => {
      const { actor, stop } = await pickByAudio()
      await vi.advanceTimersByTimeAsync(choiceLateTranscriptMs - 200)
      expect(actor.getSnapshot().context.activeQuestionId).toBeNull()
      await vi.advanceTimersByTimeAsync(400)
      expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
      stop(); actor.stop()
    })
  })

  it('шум на переспросе не обрывает ведущую; подтверждённая речь — обрывает', async () => {
    const client = new MockRealtimeClient()
    const interrupt = vi.spyOn(client, 'interruptSpeech')
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    client.setSpeechMs(15_000)
    client.hear('просто болтовня без темы', 1200)
    await vi.advanceTimersByTimeAsync(300 + choiceClarifyAfterMs)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.clarifying')
    interrupt.mockClear()
    client.hearAudio('', '', 1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(interrupt).not.toHaveBeenCalled()
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.clarifying')
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('переспрос: не речь'))).toBe(true)
    client.hear('Волга 200', 900)
    await vi.advanceTimersByTimeAsync(300)
    expect(interrupt).toHaveBeenCalled()
    expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
    stop(); actor.stop()
  })
})

import { judgmentMediaNote } from './controller.ts'

describe('оценка: эталон засчитывается без модели, медиа вопроса не повод для ambiguous', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('расшифровка равна эталону → correct без запроса оценки к модели', async () => {
    const client = new MockRealtimeClient()
    const tool = vi.spyOn(client, 'requestTool')
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'v', value: 200 })
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs + 80)
    for (let i = 0; i < 40 && statePath(actor.getSnapshot().value) !== 'buzzing.open'; i += 1) await vi.advanceTimersByTimeAsync(100)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    tool.mockClear()
    client.hear('Ответ.', 900)
    await vi.advanceTimersByTimeAsync(300 + answerSilenceDecideMs)
    expect(tool.mock.calls.some((call) => call[0] === 'judge')).toBe(false)
    expect(actor.getSnapshot().context.players[0]?.score).toBe(200)
    stop(); actor.stop()
  })

  it('правило про невидимые медиа и транслитерацию есть в промпте и не конфликтует с needs_clarification', () => {
    expect(judgmentMediaNote).toContain('это не причина для ambiguous')
    expect(judgmentMediaNote).toContain('транслитерация')
  })
})

import { unclearSituation } from './controller.ts'

describe('спорный ответ: модели — объяснение ситуации, не готовая фраза', () => {
  it('объяснение называет игрока и разницу «спорный» / «не расслышала»', async () => {
    const { actor, stop } = await boot(new MockRealtimeClient())
    const context = { ...actor.getSnapshot().context, activePlayerId: 1 }
    expect(unclearSituation({ ...context, judgmentStatus: 'ambiguous' })).toContain('неверным он не признан')
    expect(unclearSituation({ ...context, judgmentStatus: 'unintelligible' })).toContain('не удалось расслышать')
    expect(unclearSituation({ ...context, judgmentStatus: 'ambiguous' })).not.toContain('итог нулевой')
    stop(); actor.stop()
  })
})

describe('оценка ждёт расшифровку по общей формуле transcriptWaitMs', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('длинный ответ: расшифровка через 3,5 с (больше прежних 2,2 с) ещё попадает в оценку', async () => {
    const client = new MockRealtimeClient()
    const tool = vi.spyOn(client, 'requestTool')
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'v', value: 200 })
    for (let i = 0; i < 40 && statePath(actor.getSnapshot().value) !== 'buzzing.open'; i += 1) await vi.advanceTimersByTimeAsync(100)
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    const item = client.hearDeferred(5000)
    await vi.advanceTimersByTimeAsync(3500)
    client.deliverTranscript(item, 'мой ответ')
    await vi.advanceTimersByTimeAsync(100)
    const judge = tool.mock.calls.find((call) => call[0] === 'judge')
    expect(judge?.[3]).toContain('Реплика игрока: «мой ответ»')
    stop(); actor.stop()
  })
})

describe('выбор голосом: шум и посторонняя речь решает модель по правилам промпта (регрессия b3d454d)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const twoCells: QuestionPack = { ...pack, questions: [
    cell('a-300', 'a', 'Приложения', 300), cell('a-900', 'a', 'Приложения', 900), cell('m-300', 'm', 'Мультфильмы', 300),
  ] }
  /** Модель отвечает заданным вердиктом; запоминаем её промпт. */
  class ScriptedModel extends MockRealtimeClient {
    prompts: string[] = []
    private readonly verdict: Record<string, unknown>
    constructor(verdict: Record<string, unknown>) { super(); this.verdict = verdict }
    override requestTool(purpose: string, turn: number, name: string, instructions: string, isolated = false, tool?: { name: string }): void {
      if (name !== 'selectQuestion') { super.requestTool(purpose, turn, name, instructions, isolated, tool); return }
      this.prompts.push(instructions)
      window.setTimeout(() => this.onToolCall({ name, callId: `s${this.prompts.length}`, arguments: { heard: 'x', ...this.verdict } }, purpose, turn), 10)
    }
  }
  async function hearIn(text: string, verdict: Record<string, unknown>) {
    const client = new ScriptedModel(verdict)
    const { actor, stop } = await boot(client, twoCells)
    await toChoosing(actor)
    client.hear(text, 1500)
    await vi.advanceTimersByTimeAsync(400)
    const opened = actor.getSnapshot().context.activeQuestionId
    stop(); actor.stop()
    return { opened, prompts: client.prompts }
  }
  const noChoice = { themeId: 'a', value: 0, confident: false }

  it('промпт: шум, междометия, эхо и разговор — не выбор; тема только по слову из названия', async () => {
    const { prompts } = await hearIn('слушай, а что у нас сегодня на ужин будет', noChoice)
    const prompt = prompts[0] ?? ''
    expect(prompt).toContain('Часто это не выбор: шум, кашель, междометие')
    expect(prompt).toContain('«мм»')
    expect(prompt).toContain('эхо ведущей')
    expect(prompt).toContain('разговор игроков между собой')
    expect(prompt).toContain('Тема названа, только если в реплике есть слово из названия темы')
    expect(prompt).toContain('Без ясно названной темы — confident=false')
  })
  it('посторонний разговор: модель не выбрала — ячейка не открыта', async () => {
    expect((await hearIn('слушай, а что у нас сегодня на ужин будет', noChoice)).opened).toBeNull()
  })
  it('«что-то сто» с темой: решает модель, без проверки числа в коде', async () => {
    expect((await hearIn('Приложения что-то сто', { themeId: 'a', value: 300, confident: true })).opened).toBe('a-300')
  })
  it('эхо реплики ведущей отсекается до модели', async () => {
    const result = await hearIn('Здравствуйте. Выбирайте вопрос.', { themeId: 'a', value: 900, confident: true })
    expect(result.opened).toBeNull()
    expect(result.prompts).toHaveLength(0)
  })
  it('«Приложение 900» по-прежнему открывает ячейку', async () => {
    expect((await hearIn('Приложение 900', { themeId: 'a', value: 900, confident: true })).opened).toBe('a-900')
  })
})

describe('выбор из нескольких реплик хода', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('тема с номиналом, потом болтовня → берём ячейку из первой реплики', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    client.hearSlow('берём Волга за 200', 1200, 1500)
    await vi.advanceTimersByTimeAsync(1300)
    client.hearSlow('ну давайте посмотрим что там', 1500, 300)
    await vi.advanceTimersByTimeAsync(1700)
    // первая разобрана локально, вторая в модели/разборе — решение только когда обе готовы
    for (let i = 0; i < 30 && statePath(actor.getSnapshot().value) === 'choosing.listening'; i += 1) await vi.advanceTimersByTimeAsync(100)
    expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
    expect(getTrace().some((entry) => entry.kind === 'note' && entry.title.includes('выбор: берём реплику #'))).toBe(true)
    stop(); actor.stop()
  })

  it('не решаем, пока игрок говорит: длинная реплика с болтовнёй, ячейка в середине', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    client.hear('Волга 200', 600)
    // игрок сразу продолжает говорить: speech_started до разбора — решение ждёт
    client.hearDeferred(2000)
    await vi.advanceTimersByTimeAsync(100)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    for (let i = 0; i < 80 && statePath(actor.getSnapshot().value) === 'choosing.listening'; i += 1) await vi.advanceTimersByTimeAsync(100)
    expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
    stop(); actor.stop()
  })

  it('фраза — пауза — тема: без ячейки молчим, вторая реплика открывает ячейку без переспроса', async () => {
    const client = new MockRealtimeClient()
    const tools = vi.spyOn(client, 'requestTool')
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    client.hear('так, что бы такое выбрать', 1200)
    await vi.advanceTimersByTimeAsync(choiceClarifyAfterMs / 2)
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    client.hear('Свободная 400', 900)
    await vi.advanceTimersByTimeAsync(200)
    expect(actor.getSnapshot().context.activeQuestionId).toBe('s-400')
    expect(getTrace().some((entry) => entry.kind === 'chat' && entry.title === 'Ведущая' && JSON.stringify(entry.detail).includes('clarify'))).toBe(false)
    const select = tools.mock.calls.filter((call) => call[2] === 'selectQuestion')
    expect(select.length).toBeGreaterThan(0)
    stop(); actor.stop()
  })

  it('модель получает прошлые реплики хода по порядку', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    const text = selectionInstructions(actor.getSnapshot().context, 'за триста', null, null, ['ну шутки', 'наверное'])
    stop(); actor.stop()
    expect(text).toContain('1. «ну шутки»')
    expect(text).toContain('2. «наверное»')
  })
})

describe('пометки реплик выбора в чате', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  it('реплика без ячейки — «не выбор», реплика, по которой выбрана ячейка, — «✓ Тема 200»', async () => {
    const client = new MockRealtimeClient()
    const { actor, stop } = await boot(client)
    await toChoosing(actor)
    client.hear('ну давайте посмотрим что там', 1500)
    await vi.advanceTimersByTimeAsync(300)
    client.hear('Волга 200', 900)
    await vi.advanceTimersByTimeAsync(300)
    expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
    const marks = getTrace().filter((e) => e.kind === 'chat' && (e.detail as { role?: string }).role === 'player')
      .map((e) => (e.detail as { mark?: { kind: string; cell?: string } }).mark)
    expect(marks.slice(-2)).toEqual([{ kind: 'other' }, { kind: 'picked', cell: 'ВОЛГА 200' }])
    stop(); actor.stop()
  })
})

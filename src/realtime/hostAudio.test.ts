import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playTimeoutBeep } from '../audio/beep.ts'
import { gameConfig } from '../config.ts'

vi.mock('../audio/beep.ts', () => ({
  playTimeoutBeep: vi.fn(),
  unlockAudio: vi.fn(),
}))
import { attachController } from '../game/controller.ts'
import { earlyBuzzerRoll } from '../game/earlyBuzzer.ts'
import { gameMachine, statePath } from '../game/machine.ts'
import { demoPack } from '../game/questions.ts'
import { outputFlushWaitMs } from './playback.ts'
import { RealtimeClient } from './client.ts'

class FakeAudio {
  muted = false
  autoplay = false
  srcObject: unknown = null
  pause(): void {}
  play(): Promise<void> {
    return Promise.resolve()
  }
}

type OpenChannel = {
  dc: {
    readyState: string
    onmessage: ((event: MessageEvent) => void) | null
    send: (data: string) => void
  }
  handleMessage(raw: string): void
}

function harness(client: RealtimeClient): OpenChannel {
  return client as unknown as OpenChannel
}

describe('host audio completion', () => {
  let client: RealtimeClient | null = null
  const originalEarlyUnit = earlyBuzzerRoll.unit

  afterEach(() => {
    client?.stopSession()
    client = null
    earlyBuzzerRoll.unit = originalEarlyUnit
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function open() {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers()
    earlyBuzzerRoll.unit = () => 0.5
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('window', globalThis)
    const sent: string[] = []
    client = new RealtimeClient()
    const opened = harness(client)
    opened.dc = {
      readyState: 'open',
      onmessage: null,
      send(data: string) {
        const event = JSON.parse(data) as { type?: string }
        if (event.type) sent.push(event.type)
      },
    }
    const finished: string[] = []
    client.onAudioFinished = ({ purpose }) => {
      finished.push(purpose)
    }
    const feed = (event: object) => {
      opened.handleMessage(JSON.stringify(event))
    }
    const ask = (expect?: string) => {
      client?.requestSpeech(expect ? 'read' : 'welcome', 1, 'фраза', expect)
    }
    const done = () => {
      feed({
        type: 'response.done',
        response: {
          id: 'resp-1',
          metadata: { purpose: 'welcome', turn: '1' },
          output: [],
        },
      })
    }
    const started = () => {
      feed({ type: 'output_audio_buffer.started', response_id: 'resp-1' })
    }
    const stopped = () => {
      feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-1' })
    }
    return { finished, sent, ask, done, started, stopped, feed, client }
  }

  it('after a failed retry continues once without invoking browser speech', () => {
    const { finished, ask, feed } = open()
    const synthSpeak = vi.fn()
    vi.stubGlobal('speechSynthesis', { speak: synthSpeak, cancel: vi.fn() })
    ask('Посмотрите на картинку.')
    for (const id of ['bad-1', 'bad-2']) {
      feed({ type: 'response.created', response: { id } })
      feed({ type: 'response.output_audio_transcript.done', response_id: id, transcript: 'Совсем другой вопрос.' })
      if (id === 'bad-1') {
        expect(finished).toEqual([])
        vi.advanceTimersByTime(outputFlushWaitMs)
      }
    }
    expect(finished).toEqual(['read'])
    expect(synthSpeak).not.toHaveBeenCalled()
    feed({ type: 'output_audio_buffer.stopped', response_id: 'bad-2' })
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs)
    expect(finished).toEqual(['read'])
  })

  it('cuts the host off when she keeps talking after the verbatim question (answer leak)', () => {
    const { finished, sent, ask, feed } = open()
    const question = 'Кто написал роман «Евгений Онегин»?'
    ask(question)
    feed({ type: 'response.created', response: { id: 'leak-1' } })
    feed({ type: 'output_audio_buffer.started', response_id: 'leak-1' })
    feed({ type: 'response.output_audio_transcript.delta', response_id: 'leak-1', delta: question })
    expect(finished).toEqual([])
    const before = sent.length
    feed({ type: 'response.output_audio_transcript.delta', response_id: 'leak-1', delta: ' Конечно, это Александр Сергеевич Пушкин.' })
    expect(finished).toEqual(['read'])
    expect(sent.slice(before)).toEqual(expect.arrayContaining(['response.cancel', 'output_audio_buffer.clear']))
  })

  it('a silent exact reading reaches completion without browser speech', () => {
    const { finished, ask } = open()
    ask('Посмотрите на картинку.')
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs)
    expect(finished).toEqual(['read'])
  })

  it('снимает 8 с, когда звук начался после конца генерации, и ждёт stopped', () => {
    const { finished, sent, ask, done, started, stopped } = open()
    ask()
    vi.advanceTimersByTime(25_000)
    done()
    started()
    client?.setOutputMuted(true)
    const mark = sent.length
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs)
    expect(finished).toEqual([])
    expect(sent.slice(mark)).toEqual([])
    const left = gameConfig.hostAudioHardLimitMs - gameConfig.hostAudioFallbackMs
    vi.advanceTimersByTime(left - 1)
    expect(finished).toEqual([])
    stopped()
    expect(finished).toEqual(['welcome'])
  })

  it('если звук так и не начался, через 8 с после генерации фаза продолжается', () => {
    const { finished, ask, done } = open()
    ask()
    vi.advanceTimersByTime(25_000)
    done()
    vi.advanceTimersByTime(5_000)
    expect(finished).toEqual([])
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs - 5_000)
    expect(finished).toEqual(['welcome'])
  })

  it('не ставит 8 с, если звук уже шёл к концу генерации', () => {
    const { finished, ask, done, started, stopped } = open()
    ask()
    started()
    done()
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs)
    expect(finished).toEqual([])
    stopped()
    expect(finished).toEqual(['welcome'])
  })

  it('после начала звука жёсткий предел остаётся, если stopped так и не пришёл', () => {
    const { finished, ask, done, started } = open()
    ask()
    vi.advanceTimersByTime(25_000)
    done()
    started()
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs)
    expect(finished).toEqual([])
    const left = gameConfig.hostAudioHardLimitMs - gameConfig.hostAudioFallbackMs
    vi.advanceTimersByTime(left - 1)
    expect(finished).toEqual([])
    vi.advanceTimersByTime(1)
    expect(finished).toEqual(['welcome'])
  })

  it('stopped гасит запасные 8 с, если они уже стояли', () => {
    const { finished, ask, done, stopped } = open()
    ask()
    done()
    stopped()
    expect(finished).toEqual(['welcome'])
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs)
    expect(finished).toEqual(['welcome'])
  })

  it('поздний started не снимает сверку дословной фразы и не подменяет её 8 с', () => {
    const { finished, sent, ask, started, stopped, feed } = open()
    ask('Солнце')
    started()
    stopped()
    started()
    vi.advanceTimersByTime(2_499)
    expect(finished).toEqual([])
    const mark = sent.length
    vi.advanceTimersByTime(1)
    expect(finished).toEqual([])
    expect(sent.slice(mark)).toContain('output_audio_buffer.clear')
    expect(sent.slice(mark)).not.toContain('response.create')
    feed({ type: 'output_audio_buffer.cleared', response_id: 'resp-1' })
    expect(sent.slice(mark)).toContain('response.create')
    vi.advanceTimersByTime(gameConfig.hostAudioFallbackMs)
    expect(finished).toEqual([])
  })

  it('пустое чтение не шлёт сброс буфера, речь в комнате тоже', () => {
    const { sent, ask, feed, started } = open()
    ask('Посмотрите на картинку.')
    expect(sent).not.toContain('output_audio_buffer.clear')
    feed({ type: 'response.created', response: { id: 'resp-1' } })
    started()
    const mark = sent.length
    feed({ type: 'input_audio_buffer.speech_started', item_id: 'in-1' })
    expect(sent.slice(mark)).toEqual([])
  })

  it('сброс или обрез уже начатого чтения не ждёт жёсткий предел', () => {
    const { finished, ask, feed, started } = open()
    ask('Посмотрите на картинку.')
    feed({ type: 'response.created', response: { id: 'resp-1' } })
    feed({ type: 'response.output_item.added', response_id: 'resp-1', item: { id: 'item-1', type: 'message' } })
    started()
    feed({ type: 'input_audio_buffer.speech_started', item_id: 'in-1' })
    feed({ type: 'output_audio_buffer.cleared', response_id: 'resp-1' })
    expect(finished).toEqual(['read'])
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs)
    expect(finished).toEqual(['read'])

    ask('Посмотрите на картинку.')
    feed({ type: 'response.created', response: { id: 'resp-2' } })
    feed({
      type: 'response.output_item.added',
      response_id: 'resp-2',
      item: { id: 'item-2', type: 'message' },
    })
    feed({ type: 'output_audio_buffer.started', response_id: 'resp-2' })
    feed({ type: 'conversation.item.truncated', item_id: 'item-2', audio_end_ms: 1440 })
    expect(finished).toEqual(['read', 'read'])
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs)
    expect(finished).toEqual(['read', 'read'])
  })

  it('сброс предыдущей реплики дожидается cleared и не обрывает уже начатое чтение', () => {
    const { finished, sent, ask, feed, started } = open()
    ask()
    feed({ type: 'response.created', response: { id: 'resp-1' } })
    started()
    const mark = sent.length
    client?.requestSpeech('read', 2, 'фраза')
    expect(sent.slice(mark)).toContain('output_audio_buffer.clear')
    expect(sent.slice(mark)).not.toContain('response.create')
    feed({ type: 'output_audio_buffer.cleared', response_id: 'resp-1' })
    expect(sent.slice(mark)).toContain('response.create')
    feed({ type: 'response.created', response: { id: 'resp-2' } })
    feed({ type: 'output_audio_buffer.started', response_id: 'resp-2' })
    feed({ type: 'output_audio_buffer.cleared', response_id: 'resp-1' })
    expect(finished).toEqual([])
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs - 1)
    expect(finished).toEqual([])
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-2' })
    expect(finished).toEqual(['read'])
  })

  it('если сброс всё же пришёл после started, чтение заканчивается сразу', () => {
    const { finished, sent, ask, feed, started } = open()
    ask()
    feed({ type: 'response.created', response: { id: 'resp-1' } })
    started()
    const mark = sent.length
    client?.requestSpeech('read', 2, 'фраза', 'Посмотрите на картинку.')
    expect(sent.slice(mark)).not.toContain('response.create')
    vi.advanceTimersByTime(outputFlushWaitMs)
    expect(sent.slice(mark)).toContain('response.create')
    feed({ type: 'response.created', response: { id: 'resp-2' } })
    feed({ type: 'output_audio_buffer.started', response_id: 'resp-2' })
    feed({ type: 'output_audio_buffer.cleared', response_id: 'resp-2' })
    expect(finished).toEqual(['read'])
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs)
    expect(finished).toEqual(['read'])
  })

  it('кнопка по-прежнему обрывает чтение', () => {
    const { sent, ask, feed, started } = open()
    ask()
    feed({ type: 'response.created', response: { id: 'resp-1' } })
    started()
    const mark = sent.length
    client?.interruptSpeech()
    expect(sent.slice(mark)).toEqual(['response.cancel', 'output_audio_buffer.clear'])
  })

  it('поздняя оценка во время объявления не срывает finishSpeech', () => {
    const { finished, feed } = open()
    client?.requestSpeech(
      'announce',
      30,
      'Ты ведущая и сейчас говоришь игрокам. Сообщение ниже — готовая фраза.',
      'Сплин',
    )
    feed({
      type: 'response.created',
      response: { id: 'resp-announce', metadata: { purpose: 'announce', turn: '30', take: '1' } },
    })
    feed({ type: 'output_audio_buffer.started', response_id: 'resp-announce' })
    feed({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp-announce',
      item_id: 'item-announce',
      transcript: 'Сплин',
    })
    feed({
      type: 'response.done',
      response: {
        id: 'resp-judge-late',
        metadata: { purpose: 'judge', turn: '15' },
        output: [
          {
            type: 'function_call',
            name: 'submitAnswerJudgment',
            call_id: 'call-late',
            arguments: JSON.stringify({
              questionId: 'r2-t5-1800-5',
              playerId: 1,
              attemptId: 83,
              status: 'unintelligible',
              heard: 'речь не распознана',
              reason: 'поздно',
            }),
          },
        ],
      },
    })
    expect(finished).toEqual([])
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-announce' })
    expect(finished).toEqual(['announce'])
  })

  it('поздний selectQuestion не сбрасывает новый pending tool', () => {
    const { feed } = open()
    const tools: Array<{ purpose: string; turn: number }> = []
    client!.onToolCall = (_call, purpose, turn) => {
      tools.push({ purpose, turn })
    }
    client!.requestTool('select', 2, 'selectQuestion', 'Вызови selectQuestion.', true)
    feed({
      type: 'response.done',
      response: {
        id: 'resp-select-stale',
        metadata: { purpose: 'select', turn: '1' },
        output: [
          {
            type: 'function_call',
            name: 'selectQuestion',
            call_id: 'call-stale',
            arguments: JSON.stringify({ themeId: 'p', value: 400, confident: true }),
          },
        ],
      },
    })
    expect(tools).toEqual([])
    feed({
      type: 'response.done',
      response: {
        id: 'resp-select-live',
        metadata: { purpose: 'select', turn: '2' },
        output: [
          {
            type: 'function_call',
            name: 'selectQuestion',
            call_id: 'call-live',
            arguments: JSON.stringify({ themeId: 's', value: 400, confident: true }),
          },
        ],
      },
    })
    expect(tools).toEqual([{ purpose: 'select', turn: 2 }])
  })

  async function reachReading(feed: (event: object) => void, sent: string[]) {
    vi.spyOn(client!, 'connect').mockResolvedValue(undefined)
    const actor = createActor(gameMachine)
    actor.start()
    const detach = attachController({
      actor,
      client: client!,
      getApiKey: () => 'test-key',
      setLink: () => {},
    })
    actor.send({ type: 'START_GAME', pack: demoPack })
    await vi.advanceTimersByTimeAsync(0)
    expect(statePath(actor.getSnapshot().value)).toBe('welcoming')
    feed({ type: 'response.created', response: { id: 'resp-w' } })
    feed({ type: 'output_audio_buffer.started', response_id: 'resp-w' })
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-w' })
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'history', value: 100 })
    const before = sent.length
    await vi.advanceTimersByTimeAsync(gameConfig.cellFlashMs)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    expect(sent.slice(before)).not.toContain('output_audio_buffer.clear')
    const text = actor.getSnapshot().context.questions.find((item) => item.id === 'history-100')?.text ?? ''
    return { actor, detach, text }
  }

  function armRead(feed: (event: object) => void, text: string) {
    feed({ type: 'response.created', response: { id: 'resp-read' } })
    feed({
      type: 'response.output_item.added',
      response_id: 'resp-read',
      item: { id: 'item-read', type: 'message' },
    })
    feed({ type: 'output_audio_buffer.started', response_id: 'resp-read' })
    feed({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp-read',
      item_id: 'item-read',
      transcript: text,
    })
  }

  it('речь и сброс во время чтения сразу открывают первое окно кнопки, не жёсткий предел', async () => {
    const { feed, sent } = open()
    const { actor, detach } = await reachReading(feed, sent)
    armRead(feed, actor.getSnapshot().context.questions.find((item) => item.id === 'history-100')?.text ?? '')
    const mark = sent.length
    feed({ type: 'input_audio_buffer.speech_started', item_id: 'in-1' })
    expect(sent.slice(mark)).toEqual([])
    feed({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'in-1',
      transcript: 'Так это эти черепашки',
    })
    feed({ type: 'output_audio_buffer.cleared', response_id: 'resp-read' })
    feed({ type: 'conversation.item.truncated', item_id: 'item-read', audio_end_ms: 1440 })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.phaseStartedAt).not.toBeNull()
    feed({ type: 'input_audio_buffer.speech_stopped', item_id: 'in-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(actor.getSnapshot().context.talkedDuringRead).toBe(true)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    vi.advanceTimersByTime(gameConfig.buzzerMs - 1)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    vi.advanceTimersByTime(1)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(actor.getSnapshot().context.talkedDuringRead).toBe(true)
    detach()
    actor.stop()
  })

  it('конец воспроизведения тоже сразу открывает первое окно кнопки', async () => {
    const { feed, sent } = open()
    const { actor, detach, text } = await reachReading(feed, sent)
    armRead(feed, text)
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-read' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    expect(actor.getSnapshot().context.phaseStartedAt).not.toBeNull()
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    detach()
    actor.stop()
  })

  it('длинное чтение открывает кнопку и полоску после ранней задержки, пока звук ещё идёт', async () => {
    const { feed, sent } = open()
    const { actor, detach, text } = await reachReading(feed, sent)
    armRead(feed, text)
    const early = actor.getSnapshot().context.earlyLeftMs ?? gameConfig.earlyBuzzerMs
    vi.advanceTimersByTime(early - 1)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(actor.getSnapshot().context.falseStarts[1]).toEqual(expect.any(Number))
    expect(statePath(actor.getSnapshot().value)).toBe('reading.sealed')
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    expect(actor.getSnapshot().context.statusLine).toBe('Жмите свою кнопку')
    expect(actor.getSnapshot().context.phaseDurationMs).toBe(gameConfig.buzzerMs)
    const startedAt = actor.getSnapshot().context.phaseStartedAt
    expect(startedAt).toEqual(expect.any(Number))
    const beep = vi.mocked(playTimeoutBeep)
    beep.mockClear()
    vi.advanceTimersByTime(gameConfig.buzzerMs - gameConfig.buzzerWarningMs - 1)
    expect(beep).not.toHaveBeenCalled()
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    vi.advanceTimersByTime(1)
    expect(beep).toHaveBeenCalledTimes(1)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    const mark = sent.length
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-read' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(actor.getSnapshot().context.phaseStartedAt).toBe(startedAt)
    expect(sent.slice(mark)).not.toContain('response.cancel')
    vi.advanceTimersByTime(gameConfig.buzzerWarningMs - 1)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    expect(beep).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing.speaking')
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(sent.slice(mark)).toContain('response.cancel')
    const untilOldCap = gameConfig.hostAudioHardLimitMs - early - gameConfig.buzzerMs
    vi.advanceTimersByTime(untilOldCap)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing.speaking')
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    detach()
    actor.stop()
  })

  it('окно кнопки закрывается посреди чтения и не ждёт жёсткий предел', async () => {
    const { feed, sent } = open()
    const { actor, detach, text } = await reachReading(feed, sent)
    armRead(feed, text)
    const early = actor.getSnapshot().context.earlyLeftMs ?? gameConfig.earlyBuzzerMs
    vi.advanceTimersByTime(early)
    expect(statePath(actor.getSnapshot().value)).toBe('reading.armed')
    const mark = sent.length
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing.speaking')
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    expect(sent.slice(mark)).toContain('response.cancel')
    vi.advanceTimersByTime(gameConfig.hostAudioHardLimitMs - early - gameConfig.buzzerMs)
    expect(statePath(actor.getSnapshot().value)).toBe('announcing.speaking')
    expect(actor.getSnapshot().context.playedIds).toContain('history-100')
    detach()
    actor.stop()
  })

  it('нажатие в уже открытом чтении обрывает звук', async () => {
    const { feed, sent } = open()
    const { actor, detach, text } = await reachReading(feed, sent)
    armRead(feed, text)
    vi.advanceTimersByTime(actor.getSnapshot().context.earlyLeftMs ?? gameConfig.earlyBuzzerMs)
    const mark = sent.length
    actor.send({ type: 'BUZZER_PRESSED', playerId: 2 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    expect(sent.slice(mark)).toContain('response.cancel')
    expect(sent.slice(mark)).toContain('output_audio_buffer.clear')
    detach()
    actor.stop()
  })

  it('пищит за две секунды до конца окна, и нажатие в эти две секунды ещё принимается', async () => {
    const { feed, sent } = open()
    const { actor, detach, text } = await reachReading(feed, sent)
    armRead(feed, text)
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-read' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    const beep = vi.mocked(playTimeoutBeep)
    beep.mockClear()
    vi.advanceTimersByTime(gameConfig.buzzerMs - gameConfig.buzzerWarningMs - 1)
    expect(beep).not.toHaveBeenCalled()
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    vi.advanceTimersByTime(1)
    expect(beep).toHaveBeenCalledTimes(1)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    actor.send({ type: 'BUZZER_PRESSED', playerId: 1 })
    expect(statePath(actor.getSnapshot().value)).toBe('answering.waiting')
    vi.advanceTimersByTime(gameConfig.buzzerWarningMs)
    expect(beep).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().context.announceKind).toBeNull()
    detach()
    actor.stop()
  })

  it('когда кнопку так и не нажали, второго сигнала в момент закрытия нет', async () => {
    const { feed, sent } = open()
    const { actor, detach, text } = await reachReading(feed, sent)
    armRead(feed, text)
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-read' })
    const beep = vi.mocked(playTimeoutBeep)
    beep.mockClear()
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    expect(beep).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().context.announceKind).toBe('nobody')
    detach()
    actor.stop()
  })

  it('пауза не даёт сигналу прозвучать раньше времени', async () => {
    const { feed, sent } = open()
    const { actor, detach, text } = await reachReading(feed, sent)
    armRead(feed, text)
    feed({ type: 'output_audio_buffer.stopped', response_id: 'resp-read' })
    const beep = vi.mocked(playTimeoutBeep)
    beep.mockClear()
    vi.advanceTimersByTime(3_000)
    actor.send({ type: 'PAUSE', path: 'buzzing' })
    vi.advanceTimersByTime(gameConfig.buzzerMs)
    expect(beep).not.toHaveBeenCalled()
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    actor.send({ type: 'RESUME' })
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    vi.advanceTimersByTime(gameConfig.buzzerMs - gameConfig.buzzerWarningMs - 1)
    expect(beep).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(beep).toHaveBeenCalledTimes(1)
    expect(statePath(actor.getSnapshot().value)).toBe('buzzing.open')
    detach()
    actor.stop()
  })
})

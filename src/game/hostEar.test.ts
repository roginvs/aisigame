import { createActor } from 'xstate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
import { attachController } from './controller.ts'
import {
  clearHostEar, getHostEar, HOST_EAR_HEARING_MAX_MS, HOST_EAR_PROCESSING_MAX_MS,
  hostEarHearing, hostEarMicClosed, hostEarProcessing, hostEarSurvives, readHostEar, subscribeHostEar,
} from './hostEar.ts'
import { gameMachine, statePath } from './machine.ts'
import type { QuestionPack } from './types.ts'

const pack: QuestionPack = {
  name: 'Тест',
  rounds: [{ index: 0, name: 'Раунд', kind: 'normal' }],
  warnings: [],
  questions: [
    { id: 'v-200', roundIndex: 0, themeId: 'v', themeName: 'ВОЛГА', value: 200, text: 'Вопрос', answers: ['ответ'] },
    { id: 'v-400', roundIndex: 0, themeId: 'v', themeName: 'ВОЛГА', value: 400, text: 'Вопрос', answers: ['ответ'] },
  ],
}

describe('hostEar: стор', () => {
  beforeEach(() => { vi.useFakeTimers(); clearHostEar() })
  afterEach(() => { clearHostEar(); vi.useRealTimers() })

  it('started → hearing, stopped → processing, уведомляет подписчиков', () => {
    const seen: string[] = []
    const off = subscribeHostEar(() => seen.push(getHostEar()))
    hostEarHearing()
    hostEarProcessing()
    clearHostEar()
    off()
    expect(seen).toEqual(['hearing', 'processing', 'idle'])
  })

  it('speech_stopped без hearing ничего не зажигает', () => {
    hostEarProcessing()
    expect(getHostEar()).toBe('idle')
  })

  it('hearing гаснет по страховке, если speech_stopped потерялся', () => {
    hostEarHearing()
    vi.advanceTimersByTime(HOST_EAR_HEARING_MAX_MS - 1)
    expect(getHostEar()).toBe('hearing')
    vi.advanceTimersByTime(1)
    expect(getHostEar()).toBe('idle')
  })

  it('processing гаснет по страховке', () => {
    hostEarHearing()
    hostEarProcessing()
    vi.advanceTimersByTime(HOST_EAR_PROCESSING_MAX_MS)
    expect(getHostEar()).toBe('idle')
  })

  it('новый старт перезапускает страховку', () => {
    hostEarHearing()
    vi.advanceTimersByTime(HOST_EAR_HEARING_MAX_MS - 100)
    hostEarHearing()
    vi.advanceTimersByTime(200)
    expect(getHostEar()).toBe('hearing')
  })

  it('закрытый микрофон посреди речи переводит в processing', () => {
    hostEarHearing()
    hostEarMicClosed()
    expect(getHostEar()).toBe('processing')
    clearHostEar()
    hostEarMicClosed()
    expect(getHostEar()).toBe('idle')
  })

  it('переживают только переходы, вызванные самой речью', () => {
    expect(hostEarSurvives('answering.hearing')).toBe(true)
    expect(hostEarSurvives('judging')).toBe(true)
    expect(hostEarSurvives('choosing.resolving')).toBe(true)
    expect(hostEarSurvives('cat.staking.resolving')).toBe(true)
    expect(hostEarSurvives('choosing.listening', 'choosing.clarifying')).toBe(true)
    expect(hostEarSurvives('flashing')).toBe(false)
    expect(hostEarSurvives('reading.armed')).toBe(false)
    expect(hostEarSurvives('announcing.speaking')).toBe(false)
  })

  it('readHostEar валидирует значение из сети', () => {
    expect(readHostEar('hearing')).toBe('hearing')
    expect(readHostEar('loud')).toBeNull()
  })
})

describe('hostEar: контроллер', () => {
  afterEach(() => { clearHostEar(); vi.useRealTimers(); vi.unstubAllGlobals() })

  async function boot() {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    })
    const client = new MockRealtimeClient()
    const actor = createActor(gameMachine)
    actor.start()
    const stop = attachController({ actor, client, getApiKey: () => 'k', setLink: () => {} })
    actor.send({ type: 'START_GAME', pack })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(80)
    for (let i = 0; i < 40 && statePath(actor.getSnapshot().value) !== 'choosing.listening'; i += 1) await vi.advanceTimersByTimeAsync(250)
    return { client, actor, stop }
  }

  it('на выборе: speech_started → hearing, speech_stopped → processing', async () => {
    const { client, actor, stop } = await boot()
    expect(statePath(actor.getSnapshot().value)).toBe('choosing.listening')
    client.onSpeechStarted({ itemId: 'a' })
    expect(getHostEar()).toBe('hearing')
    client.onSpeechStopped({ durationMs: 900, itemId: 'a' })
    expect(getHostEar()).toBe('processing')
    stop()
  })

  it('обрыв связи гасит hearing — speech_stopped уже не придёт', async () => {
    const { client, stop } = await boot()
    client.onSpeechStarted({ itemId: 'b' })
    client.onLink({ connection: 'error', mic: 'error', host: 'idle' })
    expect(getHostEar()).toBe('idle')
    stop()
  })

  it('stopSession и переподключение гасят', async () => {
    const { client, stop } = await boot()
    client.onSpeechStarted({ itemId: 'c' })
    client.stopSession()
    expect(getHostEar()).toBe('idle')
    client.onSpeechStarted({ itemId: 'd' })
    client.onLink({ connection: 'connecting' })
    expect(getHostEar()).toBe('idle')
    stop()
  })

  it('выключенный мик посреди речи → processing, затем страховка', async () => {
    const { client, stop } = await boot()
    client.onSpeechStarted({ itemId: 'e' })
    client.setMicEnabled(false)
    expect(getHostEar()).toBe('processing')
    await vi.advanceTimersByTimeAsync(HOST_EAR_PROCESSING_MAX_MS)
    expect(getHostEar()).toBe('idle')
    stop()
  })

  it('смена ситуации (пауза, стоп) гасит', async () => {
    const { client, actor, stop } = await boot()
    client.onSpeechStarted({ itemId: 'f' })
    actor.send({ type: 'PAUSE', path: statePath(actor.getSnapshot().value) })
    await vi.advanceTimersByTimeAsync(0)
    expect(statePath(actor.getSnapshot().value)).toBe('paused')
    expect(getHostEar()).toBe('idle')
    client.onSpeechStarted({ itemId: 'g' })
    expect(getHostEar()).toBe('idle')
    stop()
    expect(getHostEar()).toBe('idle')
  })

  it('поздний speech_stopped после смены ситуации не зажигает processing', async () => {
    const { client, actor, stop } = await boot()
    client.onSpeechStarted({ itemId: 'h' })
    actor.send({ type: 'QUESTION_SELECTED', themeId: 'v', value: 200 } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(statePath(actor.getSnapshot().value)).not.toMatch(/^choosing/)
    expect(getHostEar()).toBe('idle')
    client.onSpeechStopped({ durationMs: 900, itemId: 'h' })
    expect(getHostEar()).toBe('idle')
    stop()
  })

  it('демо hearSlow: «Слышу…» → «Поняла, думаю…» → выбор вопроса гасит', async () => {
    const { client, actor, stop } = await boot()
    client.hearSlow('Волга двести', 1000, 500)
    expect(getHostEar()).toBe('hearing')
    await vi.advanceTimersByTimeAsync(1000)
    expect(getHostEar()).toBe('processing')
    for (let i = 0; i < 40 && statePath(actor.getSnapshot().value).startsWith('choosing'); i += 1) await vi.advanceTimersByTimeAsync(100)
    expect(actor.getSnapshot().context.activeQuestionId).toBe('v-200')
    expect(getHostEar()).toBe('idle')
    stop()
  })
})

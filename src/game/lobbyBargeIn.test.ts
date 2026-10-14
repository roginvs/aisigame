import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockRealtimeClient } from '../realtime/mockClient.ts'
vi.mock('../audio/beep.ts', () => ({ playTimeoutBeep: vi.fn(), unlockAudio: vi.fn() }))
import { pushHostLine } from '../debug/trace.ts'
import { LOBBY_BARGE_IN_MIN_MS, attachController } from './controller.ts'
import { gameMachine } from './machine.ts'

function setup(lobby = true) {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  })
  const client = new MockRealtimeClient()
  const interrupt = vi.spyOn(client, 'interruptSpeech')
  const actor = createActor(gameMachine).start()
  const stop = attachController({ actor, client, getApiKey: () => 'k', setLink: () => {}, onActions: () => {}, keepVoiceSession: () => lobby })
  client.setSpeechMs(10_000)
  client.requestSpeech('lobby', 1, 'Лобби до старта партии.', 'Привет всем, ждём Борю, он качает пакет.', true)
  return { client, interrupt, stop, actor }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('лобби: перебивание ведущей', () => {
  it('игрок говорит дольше порога — ведущая замолкает', async () => {
    const { client, interrupt, stop, actor } = setup()
    client.hearSlow('Подожди, а Вера тоже придёт?', 2000, 0)
    await vi.advanceTimersByTimeAsync(LOBBY_BARGE_IN_MIN_MS - 100)
    expect(interrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(interrupt).toHaveBeenCalledTimes(1)
    stop(); actor.stop()
  })

  it('короткий шум ведущую не обрывает', async () => {
    const { client, interrupt, stop, actor } = setup()
    client.hear('кх', 200)
    await vi.advanceTimersByTimeAsync(2000)
    expect(interrupt).not.toHaveBeenCalled()
    stop(); actor.stop()
  })

  it('эхо реплики ведущей (живой черновик) не перебивание', async () => {
    const { client, interrupt, stop, actor } = setup()
    pushHostLine('Привет всем, ждём Борю, он качает пакет.')
    client.hearLive('Привет всем, ждём Борю, он качает пакет.', 50, 2000)
    await vi.advanceTimersByTimeAsync(LOBBY_BARGE_IN_MIN_MS + 600)
    expect(interrupt).not.toHaveBeenCalled()
    stop(); actor.stop()
  })

  it('вне лобби (стартовое меню без конференции) — не трогаем', async () => {
    const { client, interrupt, stop, actor } = setup(false)
    client.hearSlow('Подожди, а Вера тоже придёт?', 2000, 0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(interrupt).not.toHaveBeenCalled()
    stop(); actor.stop()
  })
})

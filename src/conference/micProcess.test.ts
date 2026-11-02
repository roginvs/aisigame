import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import { gameMachine } from '../game/machine.ts'
import { buildConferenceSnapshot } from './buildSnapshot.ts'
import { createBroadcastMedia } from './media.ts'
import { validConferenceState } from './messages.ts'

describe('ШК в снимке и у гостя', () => {
  it('мастер кладёт флаг в снимок; без поля снимок всё ещё принимается', () => {
    const actor = createActor(gameMachine).start()
    const snapshot = buildConferenceSnapshot({
      pack: null,
      phase: 'lobby',
      context: actor.getSnapshot().context,
      roster: [],
      timerRemainingMs: null,
      falseStartIds: [],
      micProcess: true,
    })
    actor.stop()
    expect(snapshot.micProcess).toBe(true)
    expect(validConferenceState(snapshot)).toBe(true)
    const without = { ...snapshot }
    delete without.micProcess
    expect(validConferenceState(without)).toBe(true)
    expect(without.micProcess).toBeUndefined()
  })

  it('гость применяет флаг к своему захвату: выкл — без шумодава, вкл — с ним, комнату не трогает', async () => {
    const calls: boolean[] = []
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async (constraints: { audio: { noiseSuppression: boolean } }) => {
          calls.push(constraints.audio.noiseSuppression)
          const track = { enabled: true, stop() {} }
          return { getAudioTracks: () => [track], getTracks: () => [track] }
        },
      },
    })
    const media = createBroadcastMedia('Гость')
    await media.setMicLive(true)
    expect(calls).toEqual([false])
    await media.setPlayerMicProcess(true)
    expect(calls).toEqual([false, true])
    await media.setPlayerMicProcess(false)
    expect(calls).toEqual([false, true, false])
    media.dispose()
    vi.unstubAllGlobals()
  })
})

import { createActor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gameMachine } from '../game/machine.ts'
import { buildConferenceSnapshot } from './buildSnapshot.ts'
import { LoopbackStateReceiver, ReceivedState } from './receivedState.ts'
import { ConferenceStatePublisher } from './stateProtocol.ts'
import type { ConferenceSnapshot } from './messages.ts'

function base(): ConferenceSnapshot {
  const actor = createActor(gameMachine).start()
  const snapshot = buildConferenceSnapshot({ pack: null, phase: 'lobby', context: actor.getSnapshot().context, roster: [], timerRemainingMs: null, falseStartIds: [] })
  actor.stop()
  return snapshot
}

describe('полученное состояние мастера идёт через провод', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('петля: только сериализованные байты, асинхронно; гость и мастер собирают одинаково', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout: (h: () => void, t?: number) => globalThis.setTimeout(h, t) })
    const snap = base()
    const publisher = new ConferenceStatePublisher(snap, 'tok')
    const seen: ConferenceSnapshot[] = []
    const requestFull = vi.fn()
    const loop = new LoopbackStateReceiver((s) => seen.push(s), requestFull)
    const joiner = new ReceivedState()
    const wires = [JSON.stringify({ ...publisher.full(), sentAt: 1 }), JSON.stringify({ ...publisher.update({ ...snap, statusLine: 'Жмите кнопку' }), sentAt: 2 })]
    for (const wire of wires) loop.deliver(wire)
    expect(seen).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    for (const wire of wires) {
      const step = joiner.next(JSON.parse(wire))
      if (step.kind === 'apply') joiner.commit(step)
    }
    expect(seen.at(-1)?.statusLine).toBe('Жмите кнопку')
    expect(seen.at(-1)).toEqual(joiner.snapshot())
    expect(requestFull).not.toHaveBeenCalled()
  })

  it('пропущенное изменение — просим полный снимок, мусор игнорируем', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout: (h: () => void, t?: number) => globalThis.setTimeout(h, t) })
    const snap = base()
    const publisher = new ConferenceStatePublisher(snap, 'tok')
    publisher.full()
    const requestFull = vi.fn()
    const loop = new LoopbackStateReceiver(() => {}, requestFull)
    loop.deliver('{not json')
    loop.deliver(JSON.stringify(publisher.update({ ...snap, statusLine: 'x' })))
    await vi.advanceTimersByTimeAsync(0)
    expect(requestFull).toHaveBeenCalledTimes(1)
  })
})

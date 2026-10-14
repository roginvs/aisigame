import { afterEach, describe, expect, it, vi } from 'vitest'

function fakeAudio() {
  const connects: unknown[] = []
  const destination = { name: 'speaker' }
  class FakeParam { value = 0; setValueAtTime() {} linearRampToValueAtTime() {} }
  class FakeNode {
    type = 'sine'; frequency = new FakeParam(); gain = new FakeParam(); buffer: unknown = null
    connect(target: unknown) { if (!(target instanceof FakeNode)) connects.push(target); return target }
    start() {} stop() {}
  }
  class FakeContext {
    state = 'running'; currentTime = 0; destination = destination
    resume() { return Promise.resolve() }
    createOscillator() { return new FakeNode() }
    createGain() { return new FakeNode() }
    createBufferSource() { return new FakeNode() }
    createMediaStreamDestination() { return { name: 'sink', context: this, stream: { id: 'sounds' } } }
    decodeAudioData() { return Promise.resolve({ duration: 0.3 }) }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })))
  return { connects, destination }
}

describe('маршрут звуков игры', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('без конференции — в динамик', async () => {
    const { connects, destination } = fakeAudio()
    const beep = await import('./beep.ts')
    beep.playTimeoutBeep()
    expect(await beep.playCatMeow()).toBe(true)
    expect(connects.length).toBeGreaterThan(0)
    expect(connects.every((target) => target === destination)).toBe(true)
  })

  it('мастер Jitsi — только в поток участника «Звуки игры», не в динамик', async () => {
    const { connects, destination } = fakeAudio()
    const beep = await import('./beep.ts')
    expect(beep.gameSoundStream()).toEqual({ id: 'sounds' })
    expect(beep.gameSoundRoute()).toBe('stream')
    beep.playTimeoutBeep()
    await beep.playAuctionDing()
    expect(connects.length).toBeGreaterThan(0)
    expect(connects).not.toContain(destination)
    expect(connects.every((target) => (target as { name: string }).name === 'sink')).toBe(true)
  })

  it('joiner Jitsi — локально молчит, но тайминги и события те же', async () => {
    const { connects } = fakeAudio()
    const beep = await import('./beep.ts')
    beep.setGameSoundRoute('remote')
    beep.playTimeoutBeep()
    expect(await beep.playCatMeow()).toBe(true)
    expect(connects).toEqual([])
    beep.setGameSoundRoute('local')
    beep.playTimeoutBeep()
    expect(connects.length).toBeGreaterThan(0)
  })
  it('сбой «Звуков игры» у мастера: тишина без локального запасного пути, ошибка один раз на сбой', async () => {
    const { connects } = fakeAudio()
    const beep = await import('./beep.ts')
    beep.gameSoundStream()
    expect(beep.markGameSoundsBroken()).toBe(true)
    expect(beep.markGameSoundsBroken()).toBe(false)
    expect(beep.gameSoundRoute()).toBe('broken')
    beep.playTimeoutBeep()
    expect(await beep.playCatMeow()).toBe(true)
    expect(connects).toEqual([])
    // Новая попытка (teardown → local → новый поток) снова может сообщить о сбое.
    beep.setGameSoundRoute('local')
    beep.gameSoundStream()
    expect(beep.markGameSoundsBroken()).toBe(true)
  })
})

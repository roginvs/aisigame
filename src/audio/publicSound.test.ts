import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

function stubAudio() {
  const started: unknown[] = []
  let decodes = 0
  vi.stubGlobal('AudioContext', class {
    state = 'running'
    destination = {}
    resume() { return Promise.resolve() }
    decodeAudioData() { decodes += 1; return Promise.resolve({ duration: 1 }) }
    createBufferSource() {
      return { buffer: null as unknown, connect() {}, start() { started.push(this.buffer) } }
    }
  })
  return { started, decodes: () => decodes }
}

describe('звуки кота и аукциона', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('файлы лежат в public/', () => {
    for (const file of ['sounds/meow.wav', 'sounds/auction.wav', 'images/cat.svg', 'images/auction.svg']) {
      expect(existsSync(`public/${file}`), file).toBe(true)
    }
    expect(readFileSync('public/sounds/meow.wav').subarray(0, 4).toString()).toBe('RIFF')
    expect(readFileSync('public/sounds/auction.wav').subarray(0, 4).toString()).toBe('RIFF')
  })

  it('мяу качается и декодируется один раз, играет каждый раз', async () => {
    const audio = stubAudio()
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    vi.stubGlobal('fetch', fetchMock)
    const beep = await import('./beep.ts')
    expect(await beep.playCatMeow()).toBe(true)
    expect(await beep.playCatMeow()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0 as never])).toMatch(/sounds\/meow\.wav$/)
    expect(audio.decodes()).toBe(1)
    expect(audio.started).toHaveLength(2)
  })

  it('без файла игра идёт молча', async () => {
    const audio = stubAudio()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    const beep = await import('./beep.ts')
    expect(await beep.playAuctionDing()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    beep.resetPublicSoundsForTest()
    expect(await beep.playAuctionDing()).toBe(false)
    expect(audio.started).toHaveLength(0)
  })
})

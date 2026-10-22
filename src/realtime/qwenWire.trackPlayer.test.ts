import { afterEach, describe, expect, it, vi } from 'vitest'

// Регрессия 22 октября: в конференции комната запрашивает поток ведущей позже,
// чем приходит дорожка DashScope (attachHostOutput зовётся после connectVoice).
// Приёмник обязан подключить к новому destination уже живой граф дорожки —
// иначе участник «Ведущая» публикуется тишиной и её не слышит никто.
const fake = vi.hoisted(() => {
  const destination = { stream: '?dest' }
  const analyser = { fftSize: 2048, getFloatTimeDomainData: vi.fn() }
  const source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  const ctx = {
    resume: vi.fn(() => Promise.resolve()),
    createMediaStreamSource: vi.fn<() => typeof source>(() => source),
    createAnalyser: vi.fn(() => analyser),
    createMediaStreamDestination: vi.fn(() => destination),
  }
  return { source, destination, analyser, ctx }
})

vi.mock('../audio/beep.ts', () => ({ gameAudioContext: () => fake.ctx }))

import { TrackPlayer } from './qwenWire.ts'

class FakeAudio {
  muted = false
  autoplay = false
  srcObject: unknown = null
  pause(): void {}
  play(): Promise<void> {
    return Promise.resolve()
  }
}

function streamWithTrack(id: string): MediaStream {
  const clone = { id: `${id}-клон`, stop: vi.fn() }
  const track = { kind: 'audio', id, clone: vi.fn(() => clone) }
  return { getAudioTracks: () => [track] } as unknown as MediaStream
}

class FakeMediaStream {
  tracks: unknown[]
  constructor(tracks: unknown[]) {
    this.tracks = tracks
  }
  getAudioTracks(): unknown[] {
    return this.tracks
  }
}

describe('TrackPlayer: поток ведущей в комнату', () => {
  afterEach(() => {
    fake.source.connect.mockClear()
    fake.source.disconnect.mockClear()
    fake.ctx.createMediaStreamSource.mockClear()
    fake.ctx.createMediaStreamDestination.mockClear()
    vi.unstubAllGlobals()
  })

  function player(): TrackPlayer {
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('window', globalThis)
    return new TrackPlayer(() => undefined, () => 'resp_example')
  }

  it('комната просит поток позже ontrack: destination подключается к живому графу', () => {
    const p = player()
    // Конференция: connectVoice (дорожка пришла) раньше attachHostOutput.
    p.attach(streamWithTrack('dashscope'))
    expect(fake.source.connect).toHaveBeenCalledTimes(1)
    expect(fake.ctx.createMediaStreamDestination).not.toHaveBeenCalled()

    let stream: MediaStream | undefined
    p.attachHostOutput((value) => { stream = value })
    expect(stream).toBe(fake.destination.stream)
    expect(fake.source.connect).toHaveBeenCalledWith(fake.destination)
    p.close()
    expect(fake.source.disconnect).toHaveBeenCalled()
  })

  it('комната просит поток раньше ontrack: подключение делается при приходе дорожки', () => {
    const p = player()
    let stream: MediaStream | undefined
    p.attachHostOutput((value) => { stream = value })
    expect(stream).toBe(fake.destination.stream)
    expect(fake.source.connect).not.toHaveBeenCalledWith(fake.destination)

    p.attach(streamWithTrack('dashscope'))
    expect(fake.source.connect).toHaveBeenCalledWith(fake.destination)
    p.close()
  })

  it('новая дорожка переподключает граф со свежим клоном', () => {
    const p = player()
    p.attachHostOutput(() => undefined)
    p.attach(streamWithTrack('первая'))
    expect(fake.source.disconnect).not.toHaveBeenCalled()
    p.attach(streamWithTrack('вторая'))
    expect(fake.source.disconnect).toHaveBeenCalledTimes(1)
    expect(fake.ctx.createMediaStreamSource).toHaveBeenCalledTimes(2)
    p.close()
    expect(fake.source.disconnect).toHaveBeenCalledTimes(2)
  })

  it('outputLevel до подключения тишина, после — из анализатора', () => {
    const p = player()
    expect(p.outputLevel()).toBe(0)
    p.attach(streamWithTrack('dashscope'))
    expect(p.outputLevel()).toBe(0)
    p.close()
  })
})

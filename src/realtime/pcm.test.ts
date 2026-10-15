import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeNode {
  connections: FakeNode[] = []
  connect(to: FakeNode) {
    this.connections.push(to)
  }
  disconnect(): void {
    this.connections = []
  }
}

class FakeDestination extends FakeNode {
  stream = { id: 'tap-stream' } as MediaStream
}

class FakeBufferSource extends FakeNode {
  buffer: { duration: number } | null = { duration: 0.01 }
  onended: (() => void) | null = null
  start(): void {
    queueMicrotask(() => this.onended?.())
  }
  stop(): void {}
}

class FakeContext {
  destination = new FakeNode()
  currentTime = 0
  sampleRate = 48_000
  destinations: FakeDestination[] = []
  sources: FakeBufferSource[] = []

  resume() {
    return Promise.resolve()
  }

  createBuffer(_channels: number, length: number, _rate: number) {
    return {
      duration: length / this.sampleRate,
      getChannelData: () => new Float32Array(length),
    }
  }

  createBufferSource() {
    const node = new FakeBufferSource()
    this.sources.push(node)
    return node
  }

  createMediaStreamDestination() {
    const node = new FakeDestination()
    this.destinations.push(node)
    return node
  }
}

describe('PcmPlayer attachHostOutput', () => {
  let ctx: FakeContext

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('создаёт tap один раз и подключает воспроизведение к нему и к выходу', async () => {
    ctx = new FakeContext()
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return ctx
        }
      },
    )
    const { PcmPlayer } = await import('./pcm.ts')
    const player = new PcmPlayer(24_000, () => {}, () => {})
    const seen: MediaStream[] = []
    player.attachHostOutput((stream) => seen.push(stream))
    player.attachHostOutput((stream) => seen.push(stream))
    expect(ctx.destinations).toHaveLength(1)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])

    player.enqueue(Int16Array.from([1000, -1000]))
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0]?.connections).toContain(ctx.destination)
    expect(ctx.sources[0]?.connections).toContain(ctx.destinations[0])
  })

  it('мастер Jitsi: без локального динамика — звук только в поток комнаты', async () => {
    ctx = new FakeContext()
    vi.stubGlobal('AudioContext', class { constructor() { return ctx } })
    const { PcmPlayer } = await import('./pcm.ts')
    const player = new PcmPlayer(24_000, () => {}, () => {})
    player.attachHostOutput(() => {})
    player.setLocalPlayback(false)
    player.enqueue(Int16Array.from([1000, -1000]))
    expect(ctx.sources[0]?.connections).not.toContain(ctx.destination)
    expect(ctx.sources[0]?.connections).toContain(ctx.destinations[0])
    player.setLocalPlayback(true)
    player.enqueue(Int16Array.from([1000, -1000]))
    expect(ctx.sources[1]?.connections).toContain(ctx.destination)
  })

  it('без потока комнаты локальный выход не отключается (одиночная игра не немеет)', async () => {
    ctx = new FakeContext()
    vi.stubGlobal('AudioContext', class { constructor() { return ctx } })
    const { PcmPlayer } = await import('./pcm.ts')
    const player = new PcmPlayer(24_000, () => {}, () => {})
    player.setLocalPlayback(false)
    player.enqueue(Int16Array.from([1000, -1000]))
    expect(ctx.sources[0]?.connections).toContain(ctx.destination)
  })
})

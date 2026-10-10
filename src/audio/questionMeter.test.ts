import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeParam {
  value = 1
}

class FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  gain = new FakeParam()
  samples = new Float32Array(2048)
  connections: Array<{ to: FakeNode; output?: number; input?: number }> = []

  connect(to: FakeNode, output?: number, input?: number) {
    this.connections.push({ to, output, input })
  }

  getFloatTimeDomainData(buffer: Float32Array) {
    buffer.set(this.samples.subarray(0, buffer.length))
  }
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam()
  knee = new FakeParam()
  ratio = new FakeParam()
  attack = new FakeParam()
  release = new FakeParam()
}

class FakeContext {
  state: AudioContextState = 'suspended'
  destination = new FakeNode()
  source: FakeNode | null = null
  sources = 0
  resumed = 0
  oscillators = 0
  analysers: FakeNode[] = []
  gains: FakeNode[] = []
  compressors: FakeCompressor[] = []
  splitters: FakeNode[] = []

  resume() {
    this.resumed += 1
    this.state = 'running'
    return Promise.resolve()
  }

  createOscillator() {
    this.oscillators += 1
    return new FakeNode()
  }

  createGain() {
    const node = new FakeNode()
    this.gains.push(node)
    return node
  }

  createDynamicsCompressor() {
    const node = new FakeCompressor()
    this.compressors.push(node)
    return node
  }

  createMediaElementSource() {
    this.sources += 1
    this.source = new FakeNode()
    return this.source
  }

  createChannelSplitter() {
    const node = new FakeNode()
    this.splitters.push(node)
    return node
  }

  createAnalyser() {
    const node = new FakeNode()
    this.analysers.push(node)
    return node
  }
}

describe('attachQuestionMeter', () => {
  let constructed = 0
  let current: FakeContext

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function install() {
    constructed = 0
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          constructed += 1
          const ctx = new FakeContext()
          current = ctx
          return ctx
        }
      },
    )
  }

  it('подключает клип к лимитеру, анализатору и к выходу один раз, без осциллятора сигнала', async () => {
    install()
    const { attachQuestionMeter, questionLimiter, questionMakeupGain } = await import('./questionMeter.ts')
    const element = {} as HTMLMediaElement
    attachQuestionMeter(element)
    attachQuestionMeter(element)

    expect(constructed).toBe(1)
    expect(current.sources).toBe(1)
    expect(current.oscillators).toBe(0)
    expect(current.resumed).toBeGreaterThan(0)
    expect(current.state).toBe('running')
    expect(current.analysers).toHaveLength(2)
    expect(current.analysers[0]?.fftSize).toBe(1024)
    expect(current.analysers[0]?.smoothingTimeConstant).toBe(0)
    expect(current.compressors).toHaveLength(1)
    expect(current.gains).toHaveLength(2)
    const limiter = current.compressors[0]
    const makeup = current.gains[0]
    const mute = current.gains[1]
    expect(limiter?.threshold.value).toBe(questionLimiter.threshold)
    expect(limiter?.knee.value).toBe(questionLimiter.knee)
    expect(limiter?.ratio.value).toBe(questionLimiter.ratio)
    expect(limiter?.attack.value).toBe(questionLimiter.attack)
    expect(limiter?.release.value).toBe(questionLimiter.release)
    expect(makeup?.gain.value).toBe(questionMakeupGain)
    expect(mute?.gain.value).toBe(0)

    const source = current.source
    const splitter = current.splitters[0]
    expect(source).toBeTruthy()
    expect(splitter).toBeTruthy()
    expect(limiter).toBeTruthy()
    expect(makeup).toBeTruthy()
    expect(mute).toBeTruthy()
    if (!source || !splitter || !limiter || !makeup || !mute) return
    expect(source.connections.map((link) => link.to)).toEqual([limiter, splitter])
    expect(limiter.connections.map((link) => link.to)).toEqual([makeup])
    expect(makeup.connections.map((link) => link.to)).toEqual([current.destination])
    expect(splitter.connections).toEqual([
      { to: current.analysers[0], output: 0, input: undefined },
      { to: current.analysers[1], output: 1, input: undefined },
    ])
    expect(current.analysers[0]?.connections[0]?.to).toBe(mute)
    expect(current.analysers[1]?.connections[0]?.to).toBe(mute)
    expect(mute.connections[0]?.to).toBe(current.destination)
  })

  it('берёт контекст, который уже открыл старт партии', async () => {
    install()
    const { unlockAudio } = await import('./beep.ts')
    const { attachQuestionMeter } = await import('./questionMeter.ts')
    unlockAudio()
    const opened = current
    attachQuestionMeter({} as HTMLMediaElement)
    expect(constructed).toBe(1)
    expect(current).toBe(opened)
  })

  it('тишина лежит на нуле, моно качает обе стрелки, стерео держит каналы порознь', async () => {
    install()
    const { attachQuestionMeter, readMeterLevels } = await import('./questionMeter.ts')
    const meter = attachQuestionMeter({} as HTMLMediaElement)
    const left = meter.left as unknown as FakeNode
    const right = meter.right as unknown as FakeNode

    expect(readMeterLevels(meter)).toEqual({ left: 0, right: 0 })

    left.samples.fill(0.25)
    const mono = readMeterLevels(meter)
    expect(mono.left).toBeGreaterThan(0.5)
    expect(mono.right).toBeCloseTo(mono.left)

    right.samples.fill(0.1)
    const stereo = readMeterLevels(meter)
    expect(stereo.left).toBeGreaterThan(stereo.right)
    expect(stereo.right).toBeGreaterThan(0.2)
  })
})

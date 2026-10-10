import { gameAudioContext } from './beep.ts'

const silenceRms = 0.012
const loudRms = 0.28
const channelPresent = 0.04

/** Мягкий лимитер: быстро сажает пики и держит, без сильной «качки» динамики. */
export const questionLimiter = {
  threshold: -10,
  knee: 8,
  ratio: 14,
  attack: 0.003,
  release: 0.22,
} as const

/** Чуть поднимает тихие клипы после лимитера; громкие уже сжаты. */
export const questionMakeupGain = 1.28

export type QuestionMeterGraph = {
  left: AnalyserNode
  right: AnalyserNode
  leftSamples: Float32Array<ArrayBuffer>
  rightSamples: Float32Array<ArrayBuffer>
}

const graphs = new WeakMap<HTMLMediaElement, QuestionMeterGraph>()

/**
 * Один раз заводит элемент в граф: лимитер на выход, анализаторы для стрелок.
 * Повторный вызов тот же элемент не подключает заново — второй source браузер запрещает.
 * Пи-пи-пи кнопки сюда не входит. То же для звука и для ролика.
 */
export function attachQuestionMeter(element: HTMLMediaElement): QuestionMeterGraph {
  const ctx = gameAudioContext()
  void ctx.resume()
  const existing = graphs.get(element)
  if (existing) return existing

  const source = ctx.createMediaElementSource(element)
  const limiter = makeLimiter(ctx)
  const makeup = ctx.createGain()
  makeup.gain.value = questionMakeupGain
  const splitter = ctx.createChannelSplitter(2)
  const left = makeAnalyser(ctx)
  const right = makeAnalyser(ctx)
  const mute = ctx.createGain()
  mute.gain.value = 0

  source.connect(limiter)
  limiter.connect(makeup)
  makeup.connect(ctx.destination)

  source.connect(splitter)
  splitter.connect(left, 0)
  splitter.connect(right, 1)
  left.connect(mute)
  right.connect(mute)
  mute.connect(ctx.destination)

  const graph: QuestionMeterGraph = {
    left,
    right,
    leftSamples: new Float32Array(left.fftSize),
    rightSamples: new Float32Array(right.fftSize),
  }
  graphs.set(element, graph)
  return graph
}

/** 0 — тишина, 1 — громко. Моно, где второй канал пуст, качает обе стрелки. */
export function readMeterLevels(graph: QuestionMeterGraph): { left: number; right: number } {
  const left = levelOf(graph.left, graph.leftSamples)
  const right = levelOf(graph.right, graph.rightSamples)
  if (left >= channelPresent && right < channelPresent) return { left, right: left }
  if (right >= channelPresent && left < channelPresent) return { left: right, right }
  return { left, right }
}

function makeLimiter(ctx: AudioContext): DynamicsCompressorNode {
  const node = ctx.createDynamicsCompressor()
  node.threshold.value = questionLimiter.threshold
  node.knee.value = questionLimiter.knee
  node.ratio.value = questionLimiter.ratio
  node.attack.value = questionLimiter.attack
  node.release.value = questionLimiter.release
  return node
}

function makeAnalyser(ctx: AudioContext): AnalyserNode {
  const node = ctx.createAnalyser()
  node.fftSize = 1024
  node.smoothingTimeConstant = 0
  return node
}

function levelOf(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples)
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0
    sum += sample * sample
  }
  const rms = Math.sqrt(sum / samples.length)
  if (rms <= silenceRms) return 0
  return Math.sqrt(Math.min(1, (rms - silenceRms) / loudRms))
}

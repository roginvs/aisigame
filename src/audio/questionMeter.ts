import { gameAudioContext } from './beep.ts'

const silenceRms = 0.012
const loudRms = 0.28
const channelPresent = 0.04

export type QuestionMeterGraph = {
  left: AnalyserNode
  right: AnalyserNode
  leftSamples: Float32Array<ArrayBuffer>
  rightSamples: Float32Array<ArrayBuffer>
}

const graphs = new WeakMap<HTMLMediaElement, QuestionMeterGraph>()

/**
 * Один раз заводит элемент в граф: и в анализаторы, и в выход.
 * Повторный вызов тот же элемент не подключает заново — второй source браузер запрещает.
 * Пи-пи-пи кнопки сюда не входит.
 */
export function attachQuestionMeter(element: HTMLMediaElement): QuestionMeterGraph {
  const ctx = gameAudioContext()
  void ctx.resume()
  const existing = graphs.get(element)
  if (existing) return existing

  const source = ctx.createMediaElementSource(element)
  const splitter = ctx.createChannelSplitter(2)
  const left = makeAnalyser(ctx)
  const right = makeAnalyser(ctx)
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(ctx.destination)
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

import { diag } from '../debug/diag.ts'

/**
 * Компрессор опубликованного микрофона конференции: сужает разницу громких и тихих
 * и makeup-подъёмом возвращает тихих слышимыми. Использованный Web Audio граф живёт
 * только над сырой дорожкой устройства; сама дорожка остаётся свободной — микс модели,
 * индикаторы уровня и аналитики читают её без обработки.
 */

export type MicCompression = {
  /** Поток с обработанной дорожкой — публикация в комнату именно его. */
  stream: MediaStream
  /**
   * RMS выходного сигнала (что уходит в комнату, 0..1) — источник собственного
   * уровня на плитке и «ячейки» уровней, независимый от уровней Jitsi по себе.
   */
  level: () => number
  /** Отдать устройство назад: глушит обработанную дорожку и закрывает контекст. */
  stop: () => void
}

/** Мониторинг уровня без обработки — публикация сырой дорожки (iOS, не удался граф). */
export type MicLevelMonitor = {
  level: () => number
  stop: () => void
}

/** iOS/iPadOS нестабильно держит живой вход Web Audio при активной телефонии — там без компрессора. */
export function compressMicEligible(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as { platform?: string; maxTouchPoints?: number; userAgent?: string }
  const ua = `${nav.userAgent ?? ''} ${nav.platform ?? ''}`
  if (/iphone|ipad|ipod/i.test(ua)) return false
  // iPadOS притворяется Mac-ом: даёт touch на Mac-платформе.
  if (/Mac/i.test(nav.platform ?? '') && (nav.maxTouchPoints ?? 0) > 1) return false
  return Boolean(window.AudioContext)
    && Boolean(window.MediaStreamAudioSourceNode)
    && Boolean(window.MediaStreamAudioDestinationNode)
}

const GATE_OPEN = 0.005
const GATE_CLOSE = 0.003
const GATE_MUTE = 0.4
const GATE_TIMER_MS = 80

/** RMS одного кадра AnalyserNode. */
function analyserRms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples)
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] ?? 0) ** 2
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/** Обработка опубликованной дорожки или null — публикация без обработки, как раньше. */
export function compressMic(rawTrack: MediaStreamTrack): MicCompression | null {
  const Ctx = typeof window === 'undefined' ? undefined : window.AudioContext
  if (!Ctx || rawTrack.readyState === 'ended') return null
  let ctx: AudioContext | null = null
  let processed: MediaStreamTrack | null = null
  let gateTimer: number | null = null
  let outAnalyser: AnalyserNode | null = null
  let outAnalyserSamples: Float32Array<ArrayBuffer> | null = null
  try {
    ctx = new Ctx()
    const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]))
    // Консервативный broadcast-компрессор: тихие ≈ −10 дБ вверху, пики заметно сжаты.
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -26
    compressor.knee.value = 24
    compressor.ratio.value = 3
    compressor.attack.value = 0.01
    compressor.release.value = 0.3
    // После сжатия пиков общий запас есть: makeup возвращает тихую речь слышимой.
    const makeup = ctx.createGain()
    makeup.gain.value = 1.7
    // Лёгкий шумодав: гейт с гистерезисом мягко приглушает комнатный фон, речь не режет.
    const gate = ctx.createGain()
    gate.gain.value = 1
    // Анализатор выхода: уровень ровно того сигнала, что уходит в комнату.
    outAnalyser = ctx.createAnalyser()
    outAnalyser.fftSize = 512
    outAnalyserSamples = new Float32Array(outAnalyser.fftSize) as Float32Array<ArrayBuffer>
    makeup.connect(outAnalyser)
    const gateAnalyser = ctx.createAnalyser()
    gateAnalyser.fftSize = 512
    source.connect(gateAnalyser)
    const gateSamples = new Float32Array(gateAnalyser.fftSize) as Float32Array<ArrayBuffer>
    let gateOpen = true
    gateTimer = window.setInterval(() => {
      if (!context || context.state === 'closed') return
      const rms = analyserRms(gateAnalyser, gateSamples)
      if (gateOpen && rms < GATE_CLOSE) gateOpen = false
      else if (!gateOpen && rms > GATE_OPEN) gateOpen = true
      const target = gateOpen ? 1 : GATE_MUTE
      if (Math.abs(gate.gain.value - target) > 0.01) gate.gain.setTargetAtTime(target, context.currentTime, 0.05)
    }, GATE_TIMER_MS)
    const destination = ctx.createMediaStreamDestination()
    source.connect(gate)
    gate.connect(compressor)
    compressor.connect(makeup)
    makeup.connect(destination)
    processed = destination.stream.getAudioTracks()[0] ?? null
    if (!processed || processed.readyState !== 'live') {
      processed?.stop()
      void ctx.close().catch(() => undefined)
      return null
    }
    void ctx.resume().catch(() => undefined)
  } catch (error) {
    diag('микрофон', 'компрессор не создан — публикация без обработки', { reason: error instanceof Error ? error.message : String(error) })
    if (processed) processed.stop()
    if (gateTimer !== null) window.clearInterval(gateTimer)
    if (ctx) void ctx.close().catch(() => undefined)
    return null
  }
  const context = ctx
  const track = processed!
  return {
    stream: new MediaStream([track]),
    level: () => {
      if (context.state === 'closed' || !outAnalyser || !outAnalyserSamples) return 0
      return analyserRms(outAnalyser, outAnalyserSamples)
    },
    stop() {
      window.clearInterval(gateTimer)
      try {
        track.stop()
      } catch {
        // дорожка уже остановлена
      }
      void context.close().catch(() => undefined)
    },
  }
}

/**
 * Анализатор уровня сырой дорожки без обработки: публикация без компрессора
 * (iOS или не удался граф) всё равно держит собственный уровень на плитке.
 */
export function monitorMicLevel(rawTrack: MediaStreamTrack): MicLevelMonitor | null {
  const Ctx = typeof window === 'undefined' ? undefined : window.AudioContext
  if (!Ctx || rawTrack.readyState === 'ended') return null
  let context: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  try {
    context = new Ctx()
    const source = context.createMediaStreamSource(new MediaStream([rawTrack]))
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    void context.resume().catch(() => undefined)
  } catch {
    if (context) void context.close().catch(() => undefined)
    return null
  }
  const samples = new Float32Array(analyser!.fftSize) as Float32Array<ArrayBuffer>
  const node = analyser!
  const ctx = context
  return {
    level: () => (ctx.state === 'closed' ? 0 : analyserRms(node, samples)),
    stop() {
      void ctx.close().catch(() => undefined)
    },
  }
}

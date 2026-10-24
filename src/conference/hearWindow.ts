import { hearWindowSampleMs, silentClonePeak, silentCloneSamples } from '../options.ts'
import { SPEAKING_LEVEL } from './speakerActivity.ts'

/** Один замер источника микса модели. level/peak — 0..1 до гейна; jitsi — уровень, который шлёт Jitsi. */
export type HearSample = {
  key: string
  participantId: string
  gain: 0 | 1
  rms: number
  peak: number
  /** RMS после гейна — то, что этот источник реально добавил в поток модели. */
  postRms: number
  /** Доля отсчётов кадра с |x| ≥ порога клиппинга (0..1). */
  clip: number
  jitsi: number | null
}

type SourceStats = {
  participantId: string
  samples: number
  heardSamples: number
  rmsSum: number
  postSum: number
  peak: number
  jitsiPeak: number
  jitsiSpeaking: number
  gainOn: number
  silentRun: number
  clipSum: number
}

export type HearWindowSummary = {
  focus: string | false | null
  ms: number
  sources: Array<{
    key: string
    participantId: string
    gainOnShare: number
    /** До гейна: что пришло из комнаты. */
    rms: number
    /** После гейна: что ушло в модель. */
    modelRms: number
    peak: number
    jitsiPeak: number | null
    jitsiSpeakingMs: number
    /** Средняя доля клиппинга по замерам окна. */
    clipShare: number
  }>
}

const round = (value: number) => Math.round(value * 10_000) / 10_000

/**
 * Накопитель окна «модель слушает»: средний RMS и пик каждого источника микса,
 * доля времени с открытым гейном и сколько Jitsi видел речь. Детектор «немого клона»:
 * Jitsi слышит речь, а клон в миксе молчит `silentCloneSamples` замеров подряд.
 */
export function createHearWindow(focus: string | false | null, startedAt: number) {
  const stats = new Map<string, SourceStats>()
  const flagged = new Set<string>()

  return {
    focus,
    /** Возвращает ключи, у которых только что сработал детектор немого клона. */
    add(samples: HearSample[]): string[] {
      const silent: string[] = []
      for (const sample of samples) {
        let item = stats.get(sample.key)
        if (!item) {
          item = { participantId: sample.participantId, samples: 0, heardSamples: 0, rmsSum: 0, postSum: 0, peak: 0, jitsiPeak: -1, jitsiSpeaking: 0, gainOn: 0, silentRun: 0, clipSum: 0 }
          stats.set(sample.key, item)
        }
        item.participantId = sample.participantId
        item.samples += 1
        item.rmsSum += sample.rms
        item.postSum += sample.postRms
        item.peak = Math.max(item.peak, sample.peak)
        item.clipSum += sample.clip
        if (sample.gain === 1) item.gainOn += 1
        const speaking = sample.jitsi !== null && sample.jitsi >= SPEAKING_LEVEL
        if (sample.jitsi !== null) item.jitsiPeak = Math.max(item.jitsiPeak, sample.jitsi)
        if (speaking) item.jitsiSpeaking += 1
        if (speaking && sample.peak < silentClonePeak) item.silentRun += 1
        else if (speaking) item.silentRun = 0
        if (item.silentRun >= silentCloneSamples && !flagged.has(sample.key)) {
          flagged.add(sample.key)
          silent.push(sample.key)
        }
      }
      return silent
    },
    summary(now: number): HearWindowSummary {
      return {
        focus,
        ms: Math.max(0, Math.round(now - startedAt)),
        sources: [...stats].map(([key, item]) => ({
          key,
          participantId: item.participantId,
          gainOnShare: round(item.samples ? item.gainOn / item.samples : 0),
          rms: round(item.samples ? item.rmsSum / item.samples : 0),
          modelRms: round(item.samples ? item.postSum / item.samples : 0),
          peak: round(item.peak),
          jitsiPeak: item.jitsiPeak < 0 ? null : round(item.jitsiPeak),
          jitsiSpeakingMs: item.jitsiSpeaking * hearWindowSampleMs,
          clipShare: round(item.samples ? item.clipSum / item.samples : 0),
        })),
      }
    },
  }
}

/** |отсчёт| на этом уровне и выше считаем клиппингом (полная шкала ±1). */
const clipAbs = 0.98

/** RMS, пик и доля клиппинга по временным отсчётам анализатора (float, -1..1). Один проход. */
export function levelOf(data: Float32Array): { rms: number; peak: number; clip: number } {
  let sum = 0
  let peak = 0
  let clipped = 0
  for (const value of data) {
    const abs = Math.abs(value)
    sum += value * value
    if (abs > peak) peak = abs
    if (abs >= clipAbs) clipped += 1
  }
  const length = data.length
  return { rms: length ? Math.sqrt(sum / length) : 0, peak, clip: length ? clipped / length : 0 }
}

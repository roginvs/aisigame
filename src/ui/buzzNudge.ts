import { buzzNudge } from '../options.ts'

export type NudgeOptions = { rms: number; sustainMs: number; gapMs: number; cooldownMs: number }
/** Состояние детектора: начало текущего «звука подряд», последний звук выше порога, последняя вспышка. */
export type NudgeState = { since: number | null; lastLoud: number | null; firedAt: number | null }

export const nudgeIdle: NudgeState = { since: null, lastLoud: null, firedAt: null }

/**
 * Один отсчёт уровня. Вспышка — когда звук выше порога держится `sustainMs`
 * (паузы короче `gapMs` не рвут счёт), подсказка активна и прошёл `cooldownMs` с прошлой.
 * Неактивна — счёт сбрасывается (cooldown помнится).
 */
export function stepNudge(
  state: NudgeState,
  sample: { now: number; rms: number; active: boolean },
  options: NudgeOptions = buzzNudge,
): { state: NudgeState; fire: boolean } {
  const { now, rms, active } = sample
  if (!active) return { state: { since: null, lastLoud: null, firedAt: state.firedAt }, fire: false }
  const loud = Number.isFinite(rms) && rms >= options.rms
  let { since, lastLoud } = state
  if (loud) {
    if (since === null || lastLoud === null || now - lastLoud > options.gapMs) since = now
    lastLoud = now
  } else if (lastLoud !== null && now - lastLoud > options.gapMs) {
    since = null
    lastLoud = null
  }
  const cooled = state.firedAt === null || now - state.firedAt >= options.cooldownMs
  if (since !== null && lastLoud !== null && lastLoud - since >= options.sustainMs && cooled) {
    return { state: { since: null, lastLoud: null, firedAt: now }, fire: true }
  }
  return { state: { since, lastLoud, firedAt: state.firedAt }, fire: false }
}

/**
 * Когда подсказка вообще слушает: идёт чтение вопроса (`reading.*`) или открыта кнопка
 * (`buzzing.open`), этот игрок ещё не отвечал, не в штрафе фальстарта, не финал, микрофон включён.
 */
export function nudgeActive(input: {
  path: string
  finalRound: boolean
  hasSelf: boolean
  missed: boolean
  answering: boolean
  cooling: boolean
  micLive: boolean
}): boolean {
  const phase = input.path.startsWith('reading') || input.path === 'buzzing.open'
  return phase && !input.finalRound && input.hasSelf && !input.missed && !input.answering && !input.cooling && input.micLive
}

/** RMS одного кадра AnalyserNode. */
export function analyserRms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples)
  if (!samples.length) return 0
  let sum = 0
  for (const value of samples) sum += value * value
  return Math.sqrt(sum / samples.length)
}

/**
 * Демо и e2e: подменить уровень микрофона (RMS) без настоящего микрофона.
 * `window.__aisigameNudge.setLevel(0.05)` — «говорю», `setLevel(null)` — снова настоящий микрофон.
 * Только локальный показ: в игру и в сеть ничего не идёт.
 */
let levelOverride: number | null = null
export function nudgeLevelOverride(): number | null {
  return levelOverride
}
export function setNudgeLevelOverride(level: number | null): void {
  levelOverride = level
}
declare global {
  interface Window {
    __aisigameNudge?: { setLevel: (level: number | null) => void }
  }
}
if (typeof window !== 'undefined') window.__aisigameNudge = { setLevel: setNudgeLevelOverride }

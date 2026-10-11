import { primeConferencePlayback } from '../conference/conferenceAudio.ts'
import { buzzerBeepMs } from '../options.ts'

let audioContext: AudioContext | null = null

const pipCount = 3
const pipSeconds = 0.085
const pipGapSeconds = 0.07

export function unlockAudio(): void {
  const ctx = ensureContext()
  void ctx.resume()
  primeConferencePlayback()
}

/** Контекст, который открывает жест старта. Индикатор вопроса берёт его же, чтобы не остаться suspended. */
export function gameAudioContext(): AudioContext {
  return ensureContext()
}

/**
 * Пи-пи-пи через Web Audio, не через элемент <audio>.
 * Пауза клипа вопроса этот сигнал не останавливает: осциллятор идёт в выход контекста, не в анализатор клипа.
 */
export function playTimeoutBeep(): void {
  const ctx = ensureContext()
  void ctx.resume()
  const duration = buzzerBeepMs / 1000
  const origin = ctx.currentTime
  for (let index = 0; index < pipCount; index += 1) {
    const at = origin + index * (pipSeconds + pipGapSeconds)
    const until = at + pipSeconds
    if (until > origin + duration + 0.0001) break
    pip(ctx, at, until)
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('aisigame-beep'))
  }
}

function ensureContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext()
  return audioContext
}

function pip(ctx: AudioContext, at: number, until: number): void {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'square'
  oscillator.frequency.value = 1400
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  gain.gain.setValueAtTime(0.08, at)
  gain.gain.linearRampToValueAtTime(0.0001, until)
  oscillator.start(at)
  oscillator.stop(until)
}

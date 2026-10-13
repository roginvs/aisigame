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

const publicBuffers = new Map<string, Promise<AudioBuffer | null>>()

function publicUrl(path: string): string {
  const base = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/'
  return `${base}${path.replace(/^\//, '')}`
}

/** Скачивает и декодирует звук из public/ один раз; ошибки глушатся — без звука игра идёт дальше. */
export function preloadPublicSound(path: string): Promise<AudioBuffer | null> {
  const cached = publicBuffers.get(path)
  if (cached) return cached
  const loading = (async () => {
    try {
      const response = await fetch(publicUrl(path))
      if (!response.ok) return null
      return await ensureContext().decodeAudioData(await response.arrayBuffer())
    } catch {
      return null
    }
  })()
  publicBuffers.set(path, loading)
  return loading
}

/** Короткий звук из public/ через Web Audio (тот же контекст, что и пи-пи-пи). */
export async function playPublicSound(path: string): Promise<boolean> {
  const buffer = await preloadPublicSound(path)
  if (!buffer) return false
  const ctx = ensureContext()
  void ctx.resume()
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('aisigame-special-sound', { detail: path }))
  }
  return true
}

export const catMeowSound = 'sounds/meow.wav'
export const auctionDingSound = 'sounds/auction.wav'

export function playCatMeow(): Promise<boolean> {
  return playPublicSound(catMeowSound)
}

export function playAuctionDing(): Promise<boolean> {
  return playPublicSound(auctionDingSound)
}

export function resetPublicSoundsForTest(): void {
  publicBuffers.clear()
}

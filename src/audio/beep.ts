import { buzzerBeepMs } from '../options.ts'

let audioContext: AudioContext | null = null

export function unlockAudio(): void {
  audioContext ??= new AudioContext()
  void audioContext.resume()
}

export function playTimeoutBeep(): void {
  if (!audioContext) return
  const now = audioContext.currentTime
  const duration = buzzerBeepMs / 1000
  const oscillator = audioContext.createOscillator()
  const gain = audioContext.createGain()
  oscillator.frequency.value = 880
  oscillator.connect(gain)
  gain.connect(audioContext.destination)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.12, now + duration - 0.12)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
  oscillator.start(now)
  oscillator.stop(now + duration)
}

import {
  earlyBuzzerCharsPerSec,
  earlyBuzzerJitterMs,
  earlyBuzzerMaxMs,
  earlyBuzzerMinMs,
  earlyBuzzerMs,
} from '../options.ts'

/** 0…1 для разброса. Тесты подменяют unit, чтобы длительность не плясала. */
export const earlyBuzzerRoll = {
  unit(): number {
    return Math.random()
  },
}

/**
 * Раннее окно до живой кнопки: короткие вопросы ближе к 3 с, длинные — к 8 с.
 * Оценка по длине фразы чтения (~chars/sec речи), плюс небольшой случайный разброс.
 */
export function earlyBuzzerMsFor(text: string, unit = earlyBuzzerRoll.unit()): number {
  const chars = Math.max(0, text.length)
  if (!chars) return earlyBuzzerMs
  const base = (chars / earlyBuzzerCharsPerSec) * 1000
  const jitter = (clamp01(unit) * 2 - 1) * earlyBuzzerJitterMs
  return Math.round(clamp(base + jitter, earlyBuzzerMinMs, earlyBuzzerMaxMs))
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

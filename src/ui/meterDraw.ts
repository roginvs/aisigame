/** Отрисовка индикатора «что слышит модель» без React: уровень, цвета, метки на canvas. */
import { buildIntervals, intervalTitle, isLaneGroup, laneRect, markerTitle, meterMarkerColors, type MeterHit, type MeterMarker } from './meterMarkers.ts'

/** RMS уровня по time-domain байтам AnalyserNode (128 = тишина) → 0..1, с усилением для речи. */
export function meterLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const value of samples) {
    const centered = (value - 128) / 128
    sum += centered * centered
  }
  const rms = Math.sqrt(sum / samples.length)
  return Math.min(1, rms * 4)
}

export const METER_WIDTH = 320
/** Полупрозрачная серая вуаль поверх отрезка, когда вход модели закрыт. */
export const CLOSED_OVERLAY = 'rgba(148, 163, 184, 0.35)'

/** Вход модели открыт только при mic === 'live' (client.setMicEnabled). */
export function modelInputOpen(mic: string): boolean {
  return mic === 'live'
}

/** Цвет волны: зелёная — ушло в модель; серая — вход закрыт (звук есть, но модели не отправлен). */
export function waveColor(live: boolean, open: boolean): string {
  if (!live) return '#888'
  return open ? '#4ade80' : '#6b7280'
}
/** Подложка под полосами дорожек. */
export const LANE_BACKING = 'rgba(10, 12, 20, 0.85)'
export const WIDTH = METER_WIDTH
export const HEIGHT = 20

/** Столбец события: первый, чьё время ≥ at; -1 — левее окна, WIDTH — ещё не наступило. */
function columnAt(at: number, times: Float64Array, head: number): number {
  let seenSample = false
  for (let i = 0; i < WIDTH; i += 1) {
    const time = times[(head + i) % WIDTH] ?? 0
    if (!time) continue
    if (!seenSample && at < time) return -1
    seenSample = true
    if (time >= at) return i
  }
  return WIDTH
}

export function drawMarkers(ctx: CanvasRenderingContext2D, markers: readonly MeterMarker[], times: Float64Array, head: number): MeterHit[] {
  const hits: MeterHit[] = []
  const now = times[(head + WIDTH - 1) % WIDTH] || Date.now()
  let windowStart = now
  for (let i = 0; i < WIDTH; i += 1) { const t = times[(head + i) % WIDTH]; if (t) { windowStart = t; break } }
  // Пары «начало–конец» — горизонтальные полосы на своих дорожках сверху.
  for (const interval of buildIntervals(markers)) {
    const x0 = interval.start === null ? 0 : Math.max(0, columnAt(interval.start, times, head))
    const x1 = interval.end === null ? WIDTH : columnAt(interval.end, times, head)
    if (x1 < 0 || x0 >= WIDTH) continue
    const { y, h } = laneRect(interval.lane)
    const left = Math.max(0, x0 - 1)
    const right = Math.min(WIDTH, Math.max(x0 + 1, x1) + 1)
    // Тёмная подложка: полоса не сливается с зелёной волной.
    ctx.fillStyle = LANE_BACKING
    ctx.fillRect(left, Math.max(0, y - 1), right - left, h + 2)
    ctx.fillStyle = meterMarkerColors[interval.group]
    const bx1 = x0 + Math.max(1, Math.min(WIDTH, x1) - x0)
    ctx.fillRect(x0, y, bx1 - x0, h)
    hits.push({ x0, x1: bx1, y0: y, y1: y + h, title: intervalTitle(interval, now, windowStart), kind: 'bar' })
  }
  for (const marker of markers) {
    if (isLaneGroup(marker.group)) continue
    const x = columnAt(marker.at, times, head)
    if (x < 0 || x >= WIDTH) continue
    ctx.fillStyle = meterMarkerColors[marker.group]
    const w = marker.group === 'buzzer' ? 3 : 1
    ctx.fillRect(x, 0, w, HEIGHT)
    hits.push({ x0: x, x1: x + w, y0: 0, y1: HEIGHT, title: markerTitle(marker), kind: 'line' })
  }
  return hits
}

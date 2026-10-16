import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { meterHitTolerancePx } from '../options.ts'
import { getLinkStatus, getTrace, pushTrace, subscribeTrace } from '../debug/trace.ts'
import { buildIntervals, createMarkerCollector, hitTest, intervalTitle, isLaneGroup, markerTitle, type MeterHit, laneRect, meterLegendText, meterMarkerColors, meterMarkerLegend, type MeterMarker } from './meterMarkers.ts'

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
const WIDTH = METER_WIDTH
const HEIGHT = 20

/**
 * Индикатор того, что реально слышит модель: история уровня выхода микшера
 * (тот же поток, что уходит в realtime). В конференции — `getLevel` из общих уровней
 * мастера (после микшера, разосланы всем), без конференции — свой AnalyserNode.
 */
export function ModelInputMeter({ getAnalyser, getLevel }: { getAnalyser?: () => AnalyserNode | null; getLevel?: () => number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hitsRef = useRef<MeterHit[]>([])
  // Пока мышь над индикатором, картинка стоит (данные пишутся дальше): подпись не убегает из-под курсора.
  const frozenRef = useRef(false)
  const [tip, setTip] = useState<{ title: string; left: number } | null>(null)
  const onMove = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const sx = WIDTH / rect.width
    const sy = HEIGHT / rect.height
    const x = (event.clientX - rect.left) * sx
    const y = (event.clientY - rect.top) * sy
    const hit = hitTest(hitsRef.current, x, y, meterHitTolerancePx * sx, meterHitTolerancePx * sy)
    setTip(hit ? { title: hit.title, left: event.clientX - rect.left } : null)
  }

  useEffect(() => {
    let frame = 0
    let stopped = false
    const history = new Float32Array(WIDTH)
    let head = 0
    // Время каждого столбца: метки ставим по реальному времени, а не по числу кадров.
    const times = new Float64Array(WIDTH)
    // Открыт ли вход модели (setMicEnabled) в момент каждого столбца: закрытое — серым, в модель не ушло.
    const open = new Uint8Array(WIDTH)
    let samples: Uint8Array<ArrayBuffer> | null = null
    const collector = createMarkerCollector()
    let markers: MeterMarker[] = collector.ingest(getTrace())
    const unsubscribe = subscribeTrace(() => { markers = collector.ingest(getTrace()) })
    const tick = () => {
      if (stopped) return
      frame = requestAnimationFrame(tick)
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const analyser = getLevel ? null : getAnalyser?.() ?? null
      let level = getLevel ? getLevel() : 0
      if (analyser) {
        if (!samples || samples.length !== analyser.fftSize) samples = new Uint8Array(analyser.fftSize)
        analyser.getByteTimeDomainData(samples)
        level = meterLevel(samples)
      }
      history[head] = level
      times[head] = Date.now()
      open[head] = modelInputOpen(getLinkStatus().mic) ? 1 : 0
      head = (head + 1) % WIDTH
      if (frozenRef.current) return
      ctx.clearRect(0, 0, WIDTH, HEIGHT)
      const live = Boolean(analyser || getLevel)
      for (let x = 0; x < WIDTH; x += 1) {
        const i = (head + x) % WIDTH
        const value = history[i] ?? 0
        const isOpen = open[i] === 1
        const h = Math.max(1, Math.round(value * HEIGHT))
        ctx.fillStyle = waveColor(live, isOpen)
        ctx.fillRect(x, HEIGHT - h, 1, h)
        if (!isOpen && times[i]) {
          ctx.fillStyle = CLOSED_OVERLAY
          ctx.fillRect(x, 0, 1, HEIGHT)
        }
      }
      hitsRef.current = drawMarkers(ctx, markers, times, head)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      stopped = true
      unsubscribe()
      cancelAnimationFrame(frame)
    }
  }, [getAnalyser, getLevel])

  return (
    <span className={tip ? 'model-meter-wrap has-hit' : 'model-meter-wrap'} tabIndex={0} aria-describedby="model-meter-legend">
      <canvas
        ref={canvasRef}
        className="model-meter"
        width={WIDTH}
        height={HEIGHT}
        aria-label={meterLegendText()}
        data-testid="model-meter"
        onMouseMove={onMove}
        onMouseEnter={() => { frozenRef.current = true }}
        onMouseLeave={() => { frozenRef.current = false; setTip(null) }}
      />
      {tip && <span className="model-meter-tip" role="tooltip" data-testid="model-meter-tip" style={{ left: tip.left }}>{tip.title}</span>}
      <span id="model-meter-legend" role="tooltip" className="model-meter-legend" data-testid="model-meter-legend">
        <span><b>Что слышит модель</b> (выход микшера, справа — сейчас).</span>
        <span><i className="sw" style={{ background: waveColor(true, true) }} /> волна — звук, который ушёл в модель</span>
        <span><i className="sw" style={{ background: CLOSED_OVERLAY }} /> серая вуаль — вход модели закрыт, в модель не ушло</span>
        <span><b>Полосы сверху</b> — от начала до конца, у каждого типа своя строка; <b>черты</b> — события:</span>
        {meterMarkerLegend.map(([group, label]) => (
          <span key={group} data-group={group}><i className="sw" style={{ background: meterMarkerColors[group] }} /> {label}</span>
        ))}
      </span>
    </span>
  )
}

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

declare global {
  interface Window { __aisigameTrace?: typeof pushTrace }
}
// Dev/e2e: подложить события в trace, чтобы проверить подписи на индикаторе.
if (import.meta.env.DEV && typeof window !== 'undefined') window.__aisigameTrace = pushTrace

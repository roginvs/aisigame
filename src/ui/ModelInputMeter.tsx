import { useEffect, useRef } from 'react'
import { getTrace, subscribeTrace } from '../debug/trace.ts'
import { createMarkerCollector, meterLegendText, meterMarkerColors, type MeterMarker } from './meterMarkers.ts'

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
const WIDTH = METER_WIDTH
const HEIGHT = 20

/**
 * Индикатор того, что реально слышит модель: история уровня выхода микшера
 * (тот же поток, что уходит в realtime). В конференции — `getLevel` из общих уровней
 * мастера (после микшера, разосланы всем), без конференции — свой AnalyserNode.
 */
export function ModelInputMeter({ getAnalyser, getLevel }: { getAnalyser?: () => AnalyserNode | null; getLevel?: () => number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let frame = 0
    let stopped = false
    const history = new Float32Array(WIDTH)
    let head = 0
    // Время каждого столбца: метки ставим по реальному времени, а не по числу кадров.
    const times = new Float64Array(WIDTH)
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
      head = (head + 1) % WIDTH
      ctx.clearRect(0, 0, WIDTH, HEIGHT)
      ctx.fillStyle = analyser || getLevel ? '#4ade80' : '#888'
      for (let x = 0; x < WIDTH; x += 1) {
        const value = history[(head + x) % WIDTH] ?? 0
        const h = Math.max(1, Math.round(value * HEIGHT))
        ctx.fillRect(x, HEIGHT - h, 1, h)
      }
      drawMarkers(ctx, markers, times, head)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      stopped = true
      unsubscribe()
      cancelAnimationFrame(frame)
    }
  }, [getAnalyser, getLevel])

  return (
    <canvas
      ref={canvasRef}
      className="model-meter"
      width={WIDTH}
      height={HEIGHT}
      title={meterLegendText()}
      aria-label="Уровень звука, который слышит модель"
      data-testid="model-meter"
    />
  )
}

/** Вертикальные метки событий: столбец — первый, чьё время ≥ времени события. */
function drawMarkers(ctx: CanvasRenderingContext2D, markers: readonly MeterMarker[], times: Float64Array, head: number): void {
  for (const marker of markers) {
    let x = -1
    let seenSample = false
    for (let i = 0; i < WIDTH; i += 1) {
      const time = times[(head + i) % WIDTH] ?? 0
      if (!time) continue
      // Событие старше самого старого столбца — за левым краем.
      if (!seenSample && marker.at < time) break
      seenSample = true
      if (time >= marker.at) { x = i; break }
    }
    if (x < 0) continue
    ctx.fillStyle = meterMarkerColors[marker.group]
    ctx.fillRect(x, 0, marker.group === 'buzzer' ? 3 : 1, HEIGHT)
  }
}

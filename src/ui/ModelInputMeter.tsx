import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { meterHitTolerancePx } from '../options.ts'
import { getLinkStatus, getTrace, pushTrace, subscribeTrace } from '../debug/trace.ts'
import { createMarkerCollector, hitTest, type MeterHit, meterLegendText, meterMarkerColors, meterMarkerLegend, type MeterMarker } from './meterMarkers.ts'
import { CLOSED_OVERLAY, INPUT_BAND_H, OUTPUT_WAVE_COLOR, drawMarkers, HEIGHT, inputBandColor, meterLevel, modelInputOpen, waveColor, WIDTH } from './meterDraw.ts'

/**
 * Индикатор того, что реально слышит модель: история уровня выхода микшера
 * (тот же поток, что уходит в realtime). В конференции — `getLevel` из общих уровней
 * мастера (после микшера, разосланы всем), без конференции — свой AnalyserNode.
 * `getOutLevel` — уровень дорожки ведущей (что модель говорит): прозрачно-серая волна сверху.
 * Намеренно только у мастера, с подсказками и метками событий.
 */
export function ModelInputMeter({ getAnalyser, getLevel, getOutLevel }: { getAnalyser?: () => AnalyserNode | null; getLevel?: () => number; getOutLevel?: () => number }) {
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
    // Уровень дорожки ведущей (что модель говорит) — серая волна сверху.
    const outHistory = new Float32Array(WIDTH)
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
      outHistory[head] = getOutLevel ? getOutLevel() : 0
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
      // Волна «что говорит модель»: от верхнего края вниз, прозрачно-серая; полосы дорожек рисуются поверх.
      for (let x = 0; x < WIDTH; x += 1) {
        const value = outHistory[(head + x) % WIDTH] ?? 0
        const h = Math.max(1, Math.round(value * HEIGHT * 0.8) - 1)
        if (h > 0) {
          ctx.fillStyle = OUTPUT_WAVE_COLOR
          ctx.fillRect(x, 0, 1, h)
        }
      }
      // Постоянный след «что слышит модель»: поверх вуали, чтобы светлая/серая читались и на закрытых окнах.
      for (let x = 0; x < WIDTH; x += 1) {
        const i = (head + x) % WIDTH
        ctx.fillStyle = inputBandColor(open[i] === 1)
        ctx.fillRect(x, HEIGHT - INPUT_BAND_H, 1, INPUT_BAND_H)
      }
      hitsRef.current = drawMarkers(ctx, markers, times, head)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      stopped = true
      unsubscribe()
      cancelAnimationFrame(frame)
    }
  }, [getAnalyser, getLevel, getOutLevel])

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
        <span><i className="sw" style={{ background: OUTPUT_WAVE_COLOR }} /> серая волна сверху — что говорит модель (уровень дорожки ведущей)</span>
        <span><i className="sw" style={{ background: CLOSED_OVERLAY }} /> серая вуаль — вход модели закрыт, в модель не ушло</span>
        <span><b>Полосы сверху</b> — от начала до конца, у каждого типа своя строка; <b>черты</b> — события:</span>
        {meterMarkerLegend.map(([group, label]) => (
          <span key={group} data-group={group}><i className="sw" style={{ background: meterMarkerColors[group] }} /> {label}</span>
        ))}
      </span>
    </span>
  )
}


declare global {
  interface Window { __aisigameTrace?: typeof pushTrace }
}
// Dev/e2e: подложить события в trace, чтобы проверить подписи на индикаторе.
if (import.meta.env.DEV && typeof window !== 'undefined') window.__aisigameTrace = pushTrace

import { useEffect, useRef } from 'react'

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

const WIDTH = 160
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
    let samples: Uint8Array<ArrayBuffer> | null = null
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
      head = (head + 1) % WIDTH
      ctx.clearRect(0, 0, WIDTH, HEIGHT)
      ctx.fillStyle = analyser || getLevel ? '#4ade80' : '#888'
      for (let x = 0; x < WIDTH; x += 1) {
        const value = history[(head + x) % WIDTH] ?? 0
        const h = Math.max(1, Math.round(value * HEIGHT))
        ctx.fillRect(x, HEIGHT - h, 1, h)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
    }
  }, [getAnalyser, getLevel])

  return (
    <canvas
      ref={canvasRef}
      className="model-meter"
      width={WIDTH}
      height={HEIGHT}
      title="Что слышит модель (выход микшера)"
      aria-label="Уровень звука, который слышит модель"
      data-testid="model-meter"
    />
  )
}

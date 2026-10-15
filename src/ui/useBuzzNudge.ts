import { useEffect, useRef, useState } from 'react'
import { buzzNudge } from '../options.ts'
import { analyserRms, nudgeIdle, nudgeLevelOverride, stepNudge, type NudgeState } from './buzzNudge.ts'

/**
 * Локальная подсказка «жми кнопку»: слушает собственный микрофон (дорожку, опубликованную в Jitsi)
 * и, пока `active`, на речеподобный звук возвращает метку вспышки (время старта), иначе 0.
 * Ничего не отправляет и состояние игры не меняет.
 */
export function useBuzzNudge(getStream: (() => MediaStream | null) | undefined, active: boolean): number {
  const [flashAt, setFlashAt] = useState(0)
  const state = useRef<NudgeState>(nudgeIdle)
  useEffect(() => {
    if (!active) {
      state.current = { ...nudgeIdle, firedAt: state.current.firedAt }
      setFlashAt(0)
      return
    }
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    let samples: Float32Array<ArrayBuffer> | null = null
    let clearTimer = 0
    const release = () => {
      source?.disconnect()
      void ctx?.close().catch(() => undefined)
      ctx = null; source = null; analyser = null; samples = null; stream = null
    }
    const bind = () => {
      const next = getStream?.() ?? null
      if (next === stream) return
      release()
      stream = next
      if (!next || !next.getAudioTracks().length || typeof AudioContext === 'undefined') return
      try {
        ctx = new AudioContext()
        source = ctx.createMediaStreamSource(next)
        analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0
        source.connect(analyser) // только анализ: в динамик не идёт
        samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
      } catch {
        release()
      }
    }
    const timer = window.setInterval(() => {
      const override = nudgeLevelOverride()
      if (override === null) bind()
      const rms = override ?? (analyser && samples ? analyserRms(analyser, samples) : 0)
      const now = Date.now()
      const step = stepNudge(state.current, { now, rms, active: true })
      state.current = step.state
      if (!step.fire) return
      setFlashAt(now)
      window.clearTimeout(clearTimer)
      clearTimer = window.setTimeout(() => setFlashAt(0), buzzNudge.flashMs * buzzNudge.flashes)
    }, buzzNudge.sampleMs)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(clearTimer)
      release()
    }
  }, [active, getStream])
  return flashAt
}

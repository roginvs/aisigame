import { describe, expect, it } from 'vitest'
import { createHearWindow, levelOf, type HearSample } from './hearWindow.ts'
import { silentCloneSamples } from '../options.ts'

const sample = (over: Partial<HearSample>): HearSample => ({
  key: 'remote-t1', participantId: 'irina', gain: 1, rms: 0, peak: 0, postRms: 0, clip: 0, jitsi: 0, ...over,
})

describe('hearWindow', () => {
  it('немой клон: Jitsi слышит речь, клон молчит N замеров подряд — сигнал один раз', () => {
    const win = createHearWindow('irina', 0)
    const hits: string[] = []
    for (let i = 0; i < silentCloneSamples + 3; i += 1) hits.push(...win.add([sample({ jitsi: 0.2 })]))
    expect(hits).toEqual(['remote-t1'])
  })

  it('живой звук или тишина в комнате — не немой клон', () => {
    const win = createHearWindow('irina', 0)
    for (let i = 0; i < 20; i += 1) {
      expect(win.add([sample({ jitsi: 0.2, peak: 0.1, rms: 0.05, postRms: 0.05 })])).toEqual([])
      expect(win.add([sample({ jitsi: 0, peak: 0 })])).toEqual([])
    }
  })

  it('сводка: до/после гейна, доля открытого гейна, речь по Jitsi', () => {
    const win = createHearWindow('irina', 1000)
    win.add([sample({ rms: 0.1, peak: 0.4, postRms: 0.1, jitsi: 0.3 }), sample({ key: 'remote-t2', participantId: 'igor', gain: 0, rms: 0.2, postRms: 0 })])
    win.add([sample({ rms: 0.3, peak: 0.2, postRms: 0.3, jitsi: 0.01 }), sample({ key: 'remote-t2', participantId: 'igor', gain: 0, rms: 0.2, postRms: 0 })])
    const summary = win.summary(3500)
    expect(summary.focus).toBe('irina')
    expect(summary.ms).toBe(2500)
    expect(summary.sources[0]).toMatchObject({ key: 'remote-t1', rms: 0.2, modelRms: 0.2, peak: 0.4, gainOnShare: 1, jitsiPeak: 0.3, jitsiSpeakingMs: 250 })
    expect(summary.sources[1]).toMatchObject({ participantId: 'igor', rms: 0.2, modelRms: 0, gainOnShare: 0, clipShare: 0 })
  })

  it('доля клиппинга — среднее по замерам, тихий кадр её не поднимает', () => {
    const win = createHearWindow('bus', 0)
    win.add([sample({ key: 'bus', clip: 1 })])
    win.add([sample({ key: 'bus', clip: 0 })])
    expect(win.summary(500).sources[0]).toMatchObject({ key: 'bus', clipShare: 0.5 })
  })

  it('levelOf: RMS, пик и доля отсчётов у полной шкалы', () => {
    expect(levelOf(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toEqual({ rms: 0.5, peak: 0.5, clip: 0 })
    expect(levelOf(new Float32Array())).toEqual({ rms: 0, peak: 0, clip: 0 })
    expect(levelOf(new Float32Array([1, -0.99, 0.5, -0.2]))).toEqual({ rms: expect.any(Number), peak: 1, clip: 0.5 })
    expect(levelOf(new Float32Array([0.98, -1])).clip).toBe(1)
    expect(levelOf(new Float32Array([0.979])).clip).toBe(0)
  })
})

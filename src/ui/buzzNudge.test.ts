import { describe, expect, it } from 'vitest'
import { nudgeActive, nudgeIdle, stepNudge, type NudgeState } from './buzzNudge.ts'

const options = { rms: 0.02, sustainMs: 600, gapMs: 200, cooldownMs: 5000 }

/** Прогнать уровни с шагом 50 мс; вернуть моменты вспышек. */
function run(levels: number[], active = true, start: NudgeState = nudgeIdle, t0 = 0): { fires: number[]; state: NudgeState } {
  let state = start
  const fires: number[] = []
  levels.forEach((rms, index) => {
    const now = t0 + index * 50
    const step = stepNudge(state, { now, rms, active }, options)
    state = step.state
    if (step.fire) fires.push(now)
  })
  return { fires, state }
}

const loud = (ms: number) => Array<number>(ms / 50).fill(0.06)
const quiet = (ms: number) => Array<number>(ms / 50).fill(0.003)

describe('stepNudge: речь, а не стук', () => {
  it('речь ~0,6 с подряд → одна вспышка', () => {
    const { fires } = run([...loud(1000)])
    expect(fires).toEqual([600])
  })

  it('стук 150 мс и кашель 300 мс — нет вспышки', () => {
    expect(run([...loud(150), ...quiet(500), ...loud(300), ...quiet(500)]).fires).toEqual([])
  })

  it('короткие паузы между слогами (≤ 200 мс) не рвут счёт', () => {
    const syllables = [...loud(200), ...quiet(150), ...loud(200), ...quiet(150), ...loud(300)]
    expect(run(syllables).fires.length).toBe(1)
  })

  it('пауза длиннее 200 мс сбрасывает счёт', () => {
    expect(run([...loud(400), ...quiet(400), ...loud(400)]).fires).toEqual([])
  })

  it('тихий фон ниже порога не срабатывает', () => {
    expect(run(Array<number>(60).fill(0.015)).fires).toEqual([])
  })

  it('cooldown 5 с: продолжение речи не мигает снова, после 5 с — можно', () => {
    const { fires } = run([...loud(7000)])
    expect(fires[0]).toBe(600)
    expect(fires[1]).toBeGreaterThanOrEqual(5600)
    expect(fires).toHaveLength(2)
  })

  it('неактивна — не мигает и сбрасывает счёт, cooldown помнит', () => {
    expect(run(loud(2000), false).fires).toEqual([])
    const first = run(loud(700))
    const again = run(loud(1000), true, first.state, 1000)
    expect(again.fires).toEqual([])
  })
})

describe('nudgeActive', () => {
  const base = { path: 'reading.armed', finalRound: false, hasSelf: true, missed: false, answering: false, cooling: false, micLive: true }
  it('чтение (sealed/armed) и buzzing.open', () => {
    expect(nudgeActive(base)).toBe(true)
    expect(nudgeActive({ ...base, path: 'reading.sealed' })).toBe(true)
    expect(nudgeActive({ ...base, path: 'buzzing.open' })).toBe(true)
    expect(nudgeActive({ ...base, path: 'choosing.listening' })).toBe(false)
    expect(nudgeActive({ ...base, path: 'answering.waiting' })).toBe(false)
  })
  it('не во время фальстарта, не после ответа, не с выключенным микрофоном, не в финале', () => {
    expect(nudgeActive({ ...base, cooling: true })).toBe(false)
    expect(nudgeActive({ ...base, missed: true })).toBe(false)
    expect(nudgeActive({ ...base, micLive: false })).toBe(false)
    expect(nudgeActive({ ...base, finalRound: true })).toBe(false)
    expect(nudgeActive({ ...base, hasSelf: false })).toBe(false)
  })
})

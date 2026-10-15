import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateZoom, installDisplayMetricsLog, readDisplayMetrics } from './displayMetrics.ts'
import { getTrace, sharedDebugBatch } from './trace.ts'

type Listener = () => void

function fakeWindow(inner = 1229, outer = 1536, dpr = 1.25) {
  const listeners: Record<string, Listener[]> = {}
  const vvListeners: Listener[] = []
  const mq = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const win = {
    innerWidth: inner,
    innerHeight: 700,
    outerWidth: outer,
    outerHeight: 824,
    devicePixelRatio: dpr,
    screen: { width: 1536, height: 864, availWidth: 1536, availHeight: 824, colorDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } },
    visualViewport: { width: inner, height: 700, scale: 1, offsetTop: 0, addEventListener: (_: string, f: Listener) => vvListeners.push(f), removeEventListener: vi.fn() },
    navigator: { userAgent: 'UA test', platform: 'Win32', maxTouchPoints: 0 },
    document: { documentElement: { clientWidth: inner - 15, clientHeight: 700 } },
    matchMedia: vi.fn(() => mq),
    addEventListener: (type: string, f: Listener) => (listeners[type] ??= []).push(f),
    removeEventListener: vi.fn(),
  }
  return { win: win as unknown as Window & typeof globalThis, raw: win, fire: (type: string) => listeners[type]?.forEach((f) => f()), fireVv: () => vvListeners.forEach((f) => f()) }
}

const screenNotes = () => getTrace().filter((e) => e.title.startsWith('[экран]'))

afterEach(() => vi.useRealTimers())

describe('метрики экрана', () => {
  it('оценка зума по outer/inner', () => {
    expect(estimateZoom(1536, 1229)).toBe(1.25)
    expect(estimateZoom(1920, 1920)).toBe(1)
    expect(estimateZoom(0, 100)).toBeNull()
  })

  it('снимок содержит всё нужное для воспроизведения раскладки', () => {
    const m = readDisplayMetrics(fakeWindow().win)
    expect(m).toMatchObject({
      screen: { width: 1536, height: 864, availHeight: 824 },
      window: { innerWidth: 1229, innerHeight: 700, outerWidth: 1536 },
      visualViewport: { width: 1229, scale: 1 },
      devicePixelRatio: 1.25,
      zoomEstimate: 1.25,
      orientation: { type: 'landscape-primary', angle: 0 },
      userAgent: 'UA test',
      platform: 'Win32',
      colorScheme: 'light',
    })
  })

  it('старт, затем одна строка на серию resize (дебаунс), без дублей; уходит игроку→мастеру', () => {
    vi.useFakeTimers()
    const f = fakeWindow()
    const before = screenNotes().length
    const stop = installDisplayMetricsLog(f.win, { debounceMs: 500, repeatMs: 60_000 })
    expect(screenNotes().length).toBe(before + 1)
    expect(screenNotes().at(-1)?.title).toBe('[экран] метрики экрана: старт')
    f.raw.innerWidth = 800
    f.fire('resize')
    f.fire('resize')
    f.fireVv()
    vi.advanceTimersByTime(499)
    expect(screenNotes().length).toBe(before + 1)
    vi.advanceTimersByTime(1)
    expect(screenNotes().length).toBe(before + 2)
    f.fire('resize') // ничего не изменилось — не пишем
    vi.advanceTimersByTime(600)
    expect(screenNotes().length).toBe(before + 2)
    vi.advanceTimersByTime(60_000)
    expect(screenNotes().at(-1)?.title).toBe('[экран] метрики экрана: повтор')
    const shared = sharedDebugBatch(0, 2000, 10_000_000).entries.filter((e) => e.title.startsWith('[экран]'))
    expect(shared.at(-1)?.detail).toContain('innerWidth')
    stop()
  })
})

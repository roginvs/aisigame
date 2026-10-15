import { displayMetricsLog } from '../options.ts'
import { diag } from './diag.ts'

/**
 * Метрики экрана для дебаг-дампа: чтобы по жалобе «не видно вопрос» воспроизвести раскладку.
 * Пишутся строкой `[экран] …` в свой trace; у игрока trace уходит мастеру (`debugLog`),
 * поэтому они видны и в дампе мастера в `## remote player trace`.
 */
export type DisplayMetrics = Record<string, unknown>

type Win = Window & typeof globalThis

const round = (value: number | undefined, digits = 3): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null

function media(win: Win, query: string): boolean | null {
  try {
    return typeof win.matchMedia === 'function' ? win.matchMedia(query).matches : null
  } catch {
    return null
  }
}

/**
 * Масштаб браузера (Ctrl+/−) напрямую не читается. Оценка: на десктопе `outerWidth` не зависит
 * от зума, а `innerWidth` в CSS-пикселях делится на него → outer/inner ≈ зум (минус рамки и
 * полосы прокрутки). На телефонах outer обычно = inner, оценка не даётся.
 */
export function estimateZoom(outerWidth: number, innerWidth: number): number | null {
  if (!(outerWidth > 0) || !(innerWidth > 0)) return null
  const ratio = outerWidth / innerWidth
  if (Math.abs(ratio - 1) < 0.03) return 1
  return round(ratio, 2)
}

export function readDisplayMetrics(win: Win = window): DisplayMetrics {
  const s = win.screen
  const vv = win.visualViewport
  const nav = win.navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }
  return {
    screen: { width: s?.width, height: s?.height, availWidth: s?.availWidth, availHeight: s?.availHeight, colorDepth: s?.colorDepth },
    window: { innerWidth: win.innerWidth, innerHeight: win.innerHeight, outerWidth: win.outerWidth, outerHeight: win.outerHeight },
    document: { clientWidth: win.document?.documentElement?.clientWidth, clientHeight: win.document?.documentElement?.clientHeight },
    visualViewport: vv ? { width: round(vv.width, 1), height: round(vv.height, 1), scale: round(vv.scale), offsetTop: round(vv.offsetTop, 1) } : null,
    devicePixelRatio: round(win.devicePixelRatio),
    zoomEstimate: estimateZoom(win.outerWidth, win.innerWidth),
    orientation: s?.orientation ? { type: s.orientation.type, angle: s.orientation.angle } : null,
    userAgent: nav?.userAgent,
    platform: nav?.userAgentData?.platform ?? nav?.platform,
    mobile: nav?.userAgentData?.mobile ?? null,
    touch: { maxTouchPoints: nav?.maxTouchPoints ?? 0, coarse: media(win, '(pointer: coarse)'), hover: media(win, '(hover: hover)') },
    reducedMotion: media(win, '(prefers-reduced-motion: reduce)'),
    colorScheme: media(win, '(prefers-color-scheme: dark)') ? 'dark' : 'light',
  }
}

let installed = false

/** Запись при старте, после изменений (resize, поворот, visualViewport, DPR) с дебаунсом и раз в `repeatMs`. */
export function installDisplayMetricsLog(win: Win = window, options = displayMetricsLog): () => void {
  if (installed) return () => {}
  installed = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = ''
  const write = (reason: string, force = false) => {
    const metrics = readDisplayMetrics(win)
    const key = JSON.stringify(metrics)
    if (!force && key === last) return
    last = key
    diag('экран', `метрики экрана: ${reason}`, metrics)
  }
  const schedule = (reason: string) => () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => write(reason), options.debounceMs)
  }
  write('старт', true)
  const onResize = schedule('размер окна')
  const onOrientation = schedule('поворот')
  const onViewport = schedule('visualViewport (зум/клавиатура)')
  win.addEventListener('resize', onResize)
  win.addEventListener('orientationchange', onOrientation)
  win.visualViewport?.addEventListener('resize', onViewport)
  // Смена DPR (зум, перенос окна на другой монитор): matchMedia на текущее значение, пересоздаётся после срабатывания.
  let dprQuery: MediaQueryList | null = null
  const onDpr = () => {
    schedule('devicePixelRatio (зум/другой монитор)')()
    watchDpr()
  }
  const watchDpr = () => {
    dprQuery?.removeEventListener?.('change', onDpr)
    dprQuery = typeof win.matchMedia === 'function' ? win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`) : null
    dprQuery?.addEventListener?.('change', onDpr)
  }
  watchDpr()
  const repeat = setInterval(() => write('повтор', true), options.repeatMs)
  return () => {
    installed = false
    if (timer) clearTimeout(timer)
    clearInterval(repeat)
    win.removeEventListener('resize', onResize)
    win.removeEventListener('orientationchange', onOrientation)
    win.visualViewport?.removeEventListener('resize', onViewport)
    dprQuery?.removeEventListener?.('change', onDpr)
  }
}

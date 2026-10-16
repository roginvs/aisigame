import { useLayoutEffect, type RefObject } from 'react'
import { questionFit } from '../options.ts'

/**
 * Наибольший размер шрифта из [min, max], при котором `fits(size)` истинно (двоичный поиск).
 * Если не влезает даже `min` — возвращает `min` и `fits: false` (тогда текст прокручивается).
 */
export function fitFontSize(max: number, min: number, fits: (size: number) => boolean, steps = questionFit.steps): { size: number; fits: boolean } {
  if (max <= min || fits(max)) return { size: max, fits: fits(max) }
  if (!fits(min)) return { size: min, fits: false }
  let lo = min
  let hi = max
  for (let i = 0; i < steps; i += 1) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return { size: Math.floor(lo * 10) / 10, fits: true }
}

/**
 * Подгоняет шрифт `<h2>` вопроса под место в карточке. На широком экране карточка фиксированной
 * высоты, и длинный текст раньше обрезался снизу. С вариантами ответа подгоняется так,
 * чтобы влезла вся карточка; не влезает и при минимуме — карточка листается (`.question.has-choices`). На узком (≤1100 px)
 * карточка растёт по тексту, тут ничего не меняется: текст и так влезает.
 */
export function useFitQuestionText(ref: RefObject<HTMLElement | null>, text: string): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const fit = () => {
      el.style.fontSize = ''
      el.classList.remove('question-text-scroll')
      const base = Number.parseFloat(getComputedStyle(el).fontSize)
      // Влезает и сам текст, и вся карточка (варианты ответа под текстом тоже должны поместиться).
      const card = el.parentElement
      const fits = () => el.scrollHeight <= el.clientHeight + 1 && (!card || card.scrollHeight <= card.clientHeight + 1)
      if (!(base > 0) || fits()) return
      const result = fitFontSize(base, questionFit.minFontPx, (size) => {
        el.style.fontSize = `${size}px`
        return fits()
      })
      el.style.fontSize = `${result.size}px`
      if (!result.fits) el.classList.add('question-text-scroll')
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    // Следим за карточкой (её размер от шрифта не зависит на широком экране) и окном.
    const card = el.parentElement ?? el
    let last = ''
    const observer = new ResizeObserver(() => {
      const key = `${card.clientWidth}x${card.clientHeight}x${window.innerHeight}`
      if (key === last) return
      last = key
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    observer.observe(card)
    void document.fonts?.ready.then(() => fit())
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [ref, text])
}

import { describe, expect, it } from 'vitest'
import { getTrace } from './trace.ts'
import { checkHostUtterance, failedAttempts, resetFailedAttempts, resetSuspiciousState, setLeakTarget, suspicious, suspiciousOnce } from './suspicious.ts'

function traceTitles(): string[] {
  return getTrace().map((entry) => entry.title)
}

describe('suspicious — слой «подозрительно» (диагностика, логику не меняет)', () => {
  it('строка в лог легко ищется по «подозрительно», мастеру идёт техническая строка в чат', () => {
    const before = getTrace().length
    suspicious('слегка', 'детектор теста сработал')
    const latest = getTrace().slice(before)
    expect(latest.some((entry) => entry.title.includes('подозрительно · слегка:'))).toBe(true)
    expect(latest.some((entry) => {
      const detail = entry.detail as { role?: string; text?: string } | undefined
      return detail?.role === 'system' && detail.text?.startsWith('подозрительно (слегка):') === true
    })).toBe(true)
  })

  it('suspiciousOnce держит cooldown: тот же ключ недавно уже был', () => {
    expect(suspiciousOnce('сильно', 'test-cooldown', 60_000, 'первый раз')).toBe(true)
    expect(suspiciousOnce('сильно', 'test-cooldown', 60_000, 'второй раз')).toBe(false)
  })

  it('сброс партии снова пускает ту же заметку и обнуляет неудачи', () => {
    expect(suspiciousOnce('сильно', 'reset-key', 60_000, 'первый')).toBe(true)
    expect(suspiciousOnce('сильно', 'reset-key', 60_000, 'второй')).toBe(false)
    resetSuspiciousState()
    expect(suspiciousOnce('сильно', 'reset-key', 60_000, 'после сброса')).toBe(true)
    failedAttempts('q-reset', 1, 'раз')
    failedAttempts('q-reset', 1, 'два')
    resetSuspiciousState()
    const before = getTrace().length
    failedAttempts('q-reset', 1, 'снова одна')
    expect(getTrace().slice(before).every((entry) => !entry.title.startsWith('подозрительно'))).toBe(true)
  })

  describe('неудачные попытки ответа подряд', () => {
    it('одна молчит, две подряд — «слегка», три — «сильно»', () => {
      const before = getTrace().length
      failedAttempts('r1-t0', 1, 'вердикт unintelligible', { attemptId: 7 })
      expect(getTrace().slice(before).every((entry) => !entry.title.startsWith('подозрительно'))).toBe(true)
      failedAttempts('r1-t0', 1, 'вердикт unintelligible', { attemptId: 8 })
      expect(getTrace().slice(before).filter((entry) => entry.title.startsWith('подозрительно')).length).toBe(1)
      failedAttempts('r1-t0', 1, 'ответа за окно не услышано', { attemptId: 9 })
      expect(getTrace().slice(before).some((entry) => entry.title.includes('подозрительно · сильно:'))).toBe(true)
    })

    it('смена игрока или вопроса пересчитывает заново, верный ответ обнуляет', () => {
      const before = getTrace().length
      failedAttempts('r1-t1', 2, 'первая')
      failedAttempts('r1-t1', 3, 'игрок сменился')
      failedAttempts('r1-t2', 3, 'вопрос сменился')
      expect(getTrace().slice(before).every((entry) => !entry.title.startsWith('подозрительно'))).toBe(true)
      resetFailedAttempts()
      failedAttempts('r1-t2', 3, 'снова первая')
      expect(getTrace().slice(before).every((entry) => !entry.title.startsWith('подозрительно'))).toBe(true)
      failedAttempts('r1-t2', 3, 'вторая подряд')
      expect(getTrace().slice(before).some((entry) => entry.title.includes('подозрительно · слегка:'))).toBe(true)
    })
  })

  describe('утечка эталона открытой ячейки в свободной реплике ведущей', () => {
    it('эталон в реплике при открытой ячейке — «сильно»', () => {
      setLeakTarget(() => ({ questionId: 'r0-t2', answers: ['Собор Василия Блаженного'], closed: false }))
      const before = getTrace().length
      checkHostUtterance('А у нас тут собор Василия Блаженного стоит, между прочим')
      const titles = traceTitles().slice(before)
      expect(titles.some((title) => title.includes('подозрительно · сильно:'))).toBe(true)
    })

    it('то же слово эталона (≥6 букв) тоже ловится', () => {
      setLeakTarget(() => ({ questionId: 'r0-t3', answers: ['машина времени'], closed: false }))
      const before = getTrace().length
      checkHostUtterance('Ну что за машина тут у нас')
      expect(traceTitles().slice(before).some((title) => title.includes('подозрительно · сильно:'))).toBe(true)
    })

    it('закрытая ячейка, короткие эталоны и посторонний текст молчат', () => {
      setLeakTarget(() => ({ questionId: 'r0-t4', answers: ['да'], closed: false }))
      const before = getTrace().length
      checkHostUtterance('да, конечно выбирайте')
      checkHostUtterance('Вася, выбирайте вопрос')
      setLeakTarget(() => ({ questionId: 'r0-t5', answers: ['Собор Василия Блаженного'], closed: true }))
      checkHostUtterance('Правильный ответ: Собор Василия Блаженного')
      expect(getTrace().slice(before).every((entry) => !entry.title.startsWith('подозрительно'))).toBe(true)
    })

    it('без источника ничего не происходит', () => {
      setLeakTarget(null)
      const before = getTrace().length
      checkHostUtterance('собор Василия Блаженного снова в эфире')
      expect(getTrace().length).toBe(before)
    })
  })
})

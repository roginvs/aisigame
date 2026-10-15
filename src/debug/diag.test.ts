import { describe, expect, it } from 'vitest'
import { audioEnvironment, createDiagSummary, diag } from './diag.ts'
import { getTrace } from './trace.ts'

const last = () => getTrace()[getTrace().length - 1]

describe('diag', () => {
  it('строка с меткой области', () => {
    diag('обрыв', 'ведущую обрываем: тест', { speaking: true })
    expect(last()?.title).toBe('[обрыв] ведущую обрываем: тест')
    expect(last()?.kind).toBe('note')
  })

  it('сводка частых событий: одна строка за период, avg/max/теги', () => {
    let now = 0
    const before = getTrace().length
    const add = createDiagSummary('снимок', 'тест сводки', 10_000, () => now)
    add(100, 'a')
    now = 5_000
    add(300, 'b')
    expect(getTrace().length).toBe(before)
    now = 10_000
    add(200, 'a')
    expect(last()?.title).toBe('[снимок] тест сводки')
    expect(last()?.detail).toEqual({ count: 3, avg: 200, max: 300, tags: { a: 2, b: 1 } })
  })

  it('звуковое окружение без DOM не падает', () => {
    const env = audioEnvironment(null)
    expect(env).toMatchObject({ context: null })
    expect(typeof env.android).toBe('boolean')
  })
})

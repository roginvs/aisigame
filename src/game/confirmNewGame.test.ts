import { describe, expect, it, vi } from 'vitest'
import { confirmNewGame, newGameOverwriteQuestion, type SavedGame } from './savedGame.ts'

describe('confirmNewGame', () => {
  it('без сохранённой игры не спрашивает', () => {
    const ask = vi.fn(() => false)
    expect(confirmNewGame(null, ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })
  it('с сохранённой спрашивает и уважает отказ', () => {
    const saved = {} as SavedGame
    expect(confirmNewGame(saved, () => false)).toBe(false)
    const ask = vi.fn(() => true)
    expect(confirmNewGame(saved, ask)).toBe(true)
    expect(ask).toHaveBeenCalledWith(newGameOverwriteQuestion)
  })
})

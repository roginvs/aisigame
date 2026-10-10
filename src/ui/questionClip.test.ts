import { describe, expect, it } from 'vitest'
import { questionClipPlaying } from './questionClip.ts'

const open = { path: 'buzzing.open', missedCount: 0, held: false, finalRound: false }

describe('questionClipPlaying', () => {
  it('играет в первом окне кнопки', () => {
    expect(questionClipPlaying(open)).toBe(true)
    expect(questionClipPlaying({ ...open, path: 'falseStartCue' })).toBe(true)
  })

  it('ставит паузу, когда игрок нажал кнопку', () => {
    expect(questionClipPlaying({ ...open, path: 'answering.waiting' })).toBe(false)
    expect(questionClipPlaying({ ...open, path: 'reading.armed' })).toBe(false)
  })

  it('ставит паузу, когда окно кнопки кончилось, и не продолжает клип в перехвате', () => {
    expect(questionClipPlaying({ ...open, path: 'announcing' })).toBe(false)
    expect(questionClipPlaying({ ...open, missedCount: 1 })).toBe(false)
  })

  it('в финале клип идёт после чтения, а пауза партии его останавливает', () => {
    expect(questionClipPlaying({ ...open, path: 'answering.waiting', finalRound: true })).toBe(true)
    expect(questionClipPlaying({ ...open, path: 'reading.sealed', finalRound: true })).toBe(false)
    expect(questionClipPlaying({ ...open, held: true })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { applyQuestionClip, questionClipPlaying } from './questionClip.ts'

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

describe('applyQuestionClip', () => {
  it('пока окно открыто, сам играет и крутится, не сбрасывая позицию', () => {
    const node = clipAt(4.2)
    applyQuestionClip(node, questionClipPlaying(open))
    expect(node.loop).toBe(true)
    expect(node.playing).toBe(true)
    expect(node.currentTime).toBe(4.2)
  })

  it('по кнопке и по концу окна снимает цикл и ставит паузу на том же месте', () => {
    for (const input of [
      { ...open, path: 'answering.waiting' },
      { ...open, path: 'announcing' },
      { ...open, missedCount: 1 },
    ]) {
      const node = clipAt(4.2)
      node.loop = true
      node.playing = true
      applyQuestionClip(node, questionClipPlaying(input))
      expect(node.loop).toBe(false)
      expect(node.playing).toBe(false)
      expect(node.currentTime).toBe(4.2)
    }
  })
})

function clipAt(currentTime: number) {
  return {
    loop: false,
    currentTime,
    playing: false,
    play() {
      this.playing = true
      return Promise.resolve()
    },
    pause() {
      this.playing = false
    },
  }
}

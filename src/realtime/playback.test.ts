import { describe, expect, it } from 'vitest'
import { outputCut, playbackWait, timersAfterPlaybackStarted, timersAfterResponseDone } from './playback.ts'

describe('playbackWait', () => {
  it('ends the turn when playback already stopped', () => {
    expect(playbackWait({ started: true, ended: true })).toBe('finish')
  })

  it('keeps waiting while audio that already started is still playing', () => {
    expect(playbackWait({ started: true, ended: false })).toBe('keep')
  })

  it('uses the short fallback only when playback never started', () => {
    expect(playbackWait({ started: false, ended: false })).toBe('fallback')
  })
})

describe('host audio timers', () => {
  it('arms the 8s spare only when playback has not started and drops the hard limit until then', () => {
    expect(timersAfterResponseDone({ started: false, ended: false }, { fallback: false, hard: true })).toEqual({
      wait: 'fallback',
      timers: { fallback: true, hard: false },
    })
  })

  it('does not arm the spare while audio is already playing', () => {
    expect(timersAfterResponseDone({ started: true, ended: false }, { fallback: false, hard: true })).toEqual({
      wait: 'keep',
      timers: { fallback: false, hard: true },
    })
  })

  it('cancels the spare once playback starts and restores the hard limit', () => {
    const armed = timersAfterResponseDone({ started: false, ended: false }, { fallback: false, hard: true })
    expect(timersAfterPlaybackStarted(armed.timers, false)).toEqual({ fallback: false, hard: true })
  })

  it('leaves the transcript grace timer alone after playback has already ended', () => {
    const grace = { fallback: true, hard: true }
    expect(timersAfterPlaybackStarted(grace, true)).toEqual(grace)
  })
})

describe('outputCut', () => {
  const reading = {
    holdingForFlush: false,
    started: true,
    liveResponseId: 'resp-read',
    itemId: 'item-read',
    ignoreResponseId: 'resp-old',
  }

  it('сброс предыдущей реплики отпускает новую, пока та ещё не играет', () => {
    expect(
      outputCut(
        { ...reading, holdingForFlush: true, started: false, liveResponseId: null },
        { kind: 'cleared', responseId: 'resp-old' },
      ),
    ).toBe('release')
  })

  it('поздний сброс предыдущего ответа не обрывает уже начатое чтение', () => {
    expect(outputCut(reading, { kind: 'cleared', responseId: 'resp-old' })).toBe('ignore')
  })

  it('сброс или обрез уже начатого чтения заканчивает фразу', () => {
    expect(outputCut(reading, { kind: 'cleared', responseId: 'resp-read' })).toBe('finish')
    expect(outputCut(reading, { kind: 'truncated', itemId: 'item-read' })).toBe('finish')
  })

  it('обрез чужого пункта и сброс до начала звука чтение не заканчивают', () => {
    expect(outputCut(reading, { kind: 'truncated', itemId: 'item-old' })).toBe('ignore')
    expect(outputCut({ ...reading, started: false }, { kind: 'cleared', responseId: 'resp-other' })).toBe('ignore')
  })
})

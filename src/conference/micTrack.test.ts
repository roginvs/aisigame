import { describe, expect, it } from 'vitest'
import { mediaStreamTrackFromJitsi, micTrackIsDead } from './micTrack.ts'

describe('micTrack', () => {
  it('prefers getTrack over the original stream', () => {
    const preferred = { readyState: 'live' } as MediaStreamTrack
    const other = { readyState: 'ended' } as MediaStreamTrack
    expect(
      mediaStreamTrackFromJitsi({
        getTrack: () => preferred,
        getOriginalStream: () =>
          ({ getAudioTracks: () => [other] }) as unknown as MediaStream,
      }),
    ).toBe(preferred)
  })

  it('falls back to the first audio track of the original stream', () => {
    const audio = { readyState: 'live' } as MediaStreamTrack
    expect(
      mediaStreamTrackFromJitsi({
        getOriginalStream: () =>
          ({ getAudioTracks: () => [audio] }) as unknown as MediaStream,
      }),
    ).toBe(audio)
  })

  it('treats missing or ended tracks as dead', () => {
    expect(micTrackIsDead(null)).toBe(true)
    expect(micTrackIsDead({ readyState: 'ended' } as MediaStreamTrack)).toBe(true)
    expect(micTrackIsDead({ readyState: 'live' } as MediaStreamTrack)).toBe(false)
  })
})

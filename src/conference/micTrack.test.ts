import { describe, expect, it } from 'vitest'
import { jitsiVideoLive, mediaStreamTrackFromJitsi, micTrackIsDead } from './micTrack.ts'

describe('micTrack', () => {
  it('prefers getTrack over the original stream', () => {
    const preferred = { readyState: 'live' } as MediaStreamTrack
    const other = { readyState: 'ended' } as MediaStreamTrack
    expect(
      mediaStreamTrackFromJitsi({
        getTrack: () => preferred,
        getOriginalStream: () =>
          ({
            getAudioTracks: () => [other],
            getVideoTracks: () => [],
          }) as unknown as MediaStream,
      }),
    ).toBe(preferred)
  })

  it('falls back to the first audio track of the original stream', () => {
    const audio = { readyState: 'live' } as MediaStreamTrack
    expect(
      mediaStreamTrackFromJitsi({
        getOriginalStream: () =>
          ({
            getAudioTracks: () => [audio],
            getVideoTracks: () => [],
          }) as unknown as MediaStream,
      }),
    ).toBe(audio)
  })

  it('falls back to a video track when there is no audio', () => {
    const video = { readyState: 'live' } as MediaStreamTrack
    expect(
      mediaStreamTrackFromJitsi({
        getOriginalStream: () =>
          ({
            getAudioTracks: () => [],
            getVideoTracks: () => [video],
          }) as unknown as MediaStream,
      }),
    ).toBe(video)
  })

  it('treats missing or ended tracks as dead', () => {
    expect(micTrackIsDead(null)).toBe(true)
    expect(micTrackIsDead({ readyState: 'ended' } as MediaStreamTrack)).toBe(true)
    expect(micTrackIsDead({ readyState: 'live' } as MediaStreamTrack)).toBe(false)
  })

  it('hides muted or ended video so the UI can show a placeholder', () => {
    expect(jitsiVideoLive(null)).toBe(false)
    expect(jitsiVideoLive({ isMuted: () => true, getTrack: () => ({ readyState: 'live' }) as MediaStreamTrack })).toBe(
      false,
    )
    expect(jitsiVideoLive({ isMuted: () => false, getTrack: () => ({ readyState: 'ended' }) as MediaStreamTrack })).toBe(
      false,
    )
    expect(jitsiVideoLive({ isMuted: () => false, getTrack: () => ({ readyState: 'live' }) as MediaStreamTrack })).toBe(
      true,
    )
  })
})

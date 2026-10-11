import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMicMixer } from './audioMix.ts'

class FakeTrack {
  kind: string
  enabled: boolean
  readyState: string
  clone: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>

  constructor(kind: string, enabled = true, readyState = 'live') {
    this.kind = kind
    this.enabled = enabled
    this.readyState = readyState
    this.clone = vi.fn(() => new FakeTrack(kind, enabled, readyState))
    this.stop = vi.fn()
  }
}

class FakeMediaStream {
  tracks: FakeTrack[]

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }

  getTracks() {
    return this.tracks
  }
}

class FakeAudioContext {
  destination = {}
  state = 'running'
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  createGain = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
  }))
  createMediaStreamDestination = vi.fn(() => ({
    stream: new FakeMediaStream(),
  }))
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
}

describe('createMicMixer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext(this: FakeAudioContext) {
        Object.assign(this, new FakeAudioContext())
      }),
    )
    vi.stubGlobal('MediaStream', FakeMediaStream)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clones remote audio for the model mix', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio')
    const remoteVideo = new FakeTrack('video')
    mixer.setRemoteStreams([
      {
        getAudioTracks: () => [remoteAudio],
        getTracks: () => [remoteAudio, remoteVideo],
      } as unknown as MediaStream,
    ])

    expect(remoteAudio.clone).toHaveBeenCalledTimes(1)
    expect(remoteVideo.clone).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('clones the local mic for the model mix', () => {
    const mixer = createMicMixer()
    const localAudio = new FakeTrack('audio')
    mixer.setLocalMic({
      getAudioTracks: () => [localAudio],
      getTracks: () => [localAudio],
    } as unknown as MediaStream)

    expect(localAudio.clone).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })

  it('stops clones when streams are cleared', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio')
    mixer.setRemoteStreams([
      {
        getAudioTracks: () => [remoteAudio],
        getTracks: () => [remoteAudio],
      } as unknown as MediaStream,
    ])
    const clone = remoteAudio.clone.mock.results[0]?.value as FakeTrack
    mixer.setRemoteStreams([])

    expect(clone.stop).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })
})

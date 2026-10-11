import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMicMixer } from './audioMix.ts'

class FakeTrack {
  id: string
  kind: string
  enabled: boolean
  readyState: string
  clone: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>

  constructor(kind: string, enabled = true, readyState = 'live', id = `track-${Math.random()}`) {
    this.id = id
    this.kind = kind
    this.enabled = enabled
    this.readyState = readyState
    this.clone = vi.fn(() => new FakeTrack(kind, enabled, readyState, `${id}-clone`))
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
    const remoteAudio = new FakeTrack('audio', true, 'live', 'remote-a')
    const remoteVideo = new FakeTrack('video', true, 'live', 'remote-v')
    mixer.setRemoteStreams([
      {
        id: 'guest',
        stream: {
          getAudioTracks: () => [remoteAudio],
          getTracks: () => [remoteAudio, remoteVideo],
        } as unknown as MediaStream,
      },
    ])

    expect(remoteAudio.clone).toHaveBeenCalledTimes(1)
    expect(remoteVideo.clone).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('does not clone the local mic so Jitsi mute still reaches the model', () => {
    const mixer = createMicMixer()
    const localAudio = new FakeTrack('audio', true, 'live', 'local-a')
    mixer.setLocalMic({
      getAudioTracks: () => [localAudio],
      getTracks: () => [localAudio],
    } as unknown as MediaStream)

    expect(localAudio.clone).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('stops remote clones when streams are cleared and leaves the original alone', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio', true, 'live', 'remote-a')
    mixer.setRemoteStreams([
      {
        id: 'guest',
        stream: {
          getAudioTracks: () => [remoteAudio],
          getTracks: () => [remoteAudio],
        } as unknown as MediaStream,
      },
    ])
    const clone = remoteAudio.clone.mock.results[0]?.value as FakeTrack
    mixer.setRemoteStreams([])

    expect(clone.stop).toHaveBeenCalledTimes(1)
    expect(remoteAudio.stop).not.toHaveBeenCalled()
    mixer.dispose()
  })

  it('keeps stable remote ids and skips re-clone when the same live tracks return', () => {
    const mixer = createMicMixer()
    const remoteAudio = new FakeTrack('audio', true, 'live', 'remote-a')
    const stream = {
      getAudioTracks: () => [remoteAudio],
      getTracks: () => [remoteAudio],
    } as unknown as MediaStream
    mixer.setRemoteStreams([{ id: 'guest', stream }])
    mixer.setRemoteStreams([{ id: 'guest', stream }])

    expect(remoteAudio.clone).toHaveBeenCalledTimes(1)
    mixer.dispose()
  })

  it('does not stop the local mic track when the local source is cleared', () => {
    const mixer = createMicMixer()
    const localAudio = new FakeTrack('audio', true, 'live', 'local-a')
    mixer.setLocalMic({
      getAudioTracks: () => [localAudio],
      getTracks: () => [localAudio],
    } as unknown as MediaStream)
    mixer.setLocalMic(null)

    expect(localAudio.stop).not.toHaveBeenCalled()
    mixer.dispose()
  })
})

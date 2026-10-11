import { describe, expect, it, vi } from 'vitest'
import {
  conferenceAudioStream,
  createConferenceAudioOutput,
  preferConferenceSpeaker,
  type ConferenceAudioSink,
} from './conferenceAudio.ts'

function sink(): ConferenceAudioSink & { streams: Array<MediaStream | null>; plays: number; pauses: number; released: number } {
  const state = {
    streams: [] as Array<MediaStream | null>,
    plays: 0,
    pauses: 0,
    released: 0,
    setStream(stream: MediaStream | null) {
      state.streams.push(stream)
    },
    play() {
      state.plays += 1
      return Promise.resolve()
    },
    pause() {
      state.pauses += 1
    },
    release() {
      state.released += 1
    },
  }
  return state
}

describe('createConferenceAudioOutput', () => {
  it('plays each remote stream on its own element and replaces the stream without a second element', async () => {
    const first = sink()
    const second = sink()
    const taken = [first, second]
    const output = createConferenceAudioOutput(() => taken.shift() ?? sink())
    const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream
    const next = { getAudioTracks: () => [{}] } as unknown as MediaStream

    output.attach('host', stream)
    output.attach('host', next)
    output.attach('quiet', { getAudioTracks: () => [] } as unknown as MediaStream)
    await Promise.resolve()

    expect(first.streams).toEqual([stream, next])
    expect(first.plays).toBe(2)
    expect(second.plays).toBe(0)

    output.resume()
    expect(first.plays).toBe(3)

    output.dispose()
    expect(first.pauses).toBe(1)
    expect(first.released).toBe(1)
    expect(first.streams.at(-1)).toBeNull()
  })

  it('записывает отказ play, не роняя комнату', async () => {
    const broken = sink()
    broken.play = () => {
      broken.plays += 1
      return Promise.reject(new Error('NotAllowedError'))
    }
    const output = createConferenceAudioOutput(() => broken)
    output.attach('guest', { getAudioTracks: () => [{}] } as unknown as MediaStream)
    await Promise.resolve()
    await Promise.resolve()
    expect(broken.plays).toBe(1)
    output.dispose()
  })
})

describe('conferenceAudioStream', () => {
  it('берёт исходный поток, а если в нём нет звука — дорожку трека', () => {
    const original = { getAudioTracks: () => [{}] } as unknown as MediaStream
    expect(conferenceAudioStream({ getOriginalStream: () => original })).toBe(original)

    const media = { kind: 'audio' } as MediaStreamTrack
    vi.stubGlobal(
      'MediaStream',
      class {
        tracks: MediaStreamTrack[]
        constructor(tracks: MediaStreamTrack[]) {
          this.tracks = tracks
        }
      },
    )
    const wrapped = conferenceAudioStream({
      getOriginalStream: () => ({ getAudioTracks: () => [] }) as unknown as MediaStream,
      getTrack: () => media,
    })
    expect(wrapped).toBeInstanceOf(MediaStream)
    expect((wrapped as unknown as { tracks: MediaStreamTrack[] }).tracks).toEqual([media])
    expect(conferenceAudioStream({ getTrack: () => ({ kind: 'video' }) as MediaStreamTrack })).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('preferConferenceSpeaker', () => {
  it('просит динамик и не трогает уже выбранный playback', () => {
    const host = { audioSession: { type: 'auto' } }
    preferConferenceSpeaker(host)
    expect(host.audioSession.type).toBe('playback')
    preferConferenceSpeaker(host)
    expect(host.audioSession.type).toBe('playback')
    expect(() => preferConferenceSpeaker(undefined)).not.toThrow()
  })
})

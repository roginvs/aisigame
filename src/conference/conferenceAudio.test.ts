import { describe, expect, it, vi } from 'vitest'
import { createConferenceAudioOutput } from './conferenceAudio.ts'

describe('createConferenceAudioOutput', () => {
  it('connects remote streams to the unlocked Web Audio destination and replaces old sources', () => {
    const first = { connect: vi.fn(), disconnect: vi.fn() }
    const second = { connect: vi.fn(), disconnect: vi.fn() }
    const destination = {}
    const context = {
      destination,
      createMediaStreamSource: vi.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
      resume: vi.fn().mockResolvedValue(undefined),
    }
    const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream
    const output = createConferenceAudioOutput(context as unknown as AudioContext)

    output.attach('host', stream)
    expect(first.connect).toHaveBeenCalledWith(destination)
    output.attach('host', stream)
    expect(first.disconnect).toHaveBeenCalledOnce()
    expect(second.connect).toHaveBeenCalledWith(destination)

    output.dispose()
    expect(second.disconnect).toHaveBeenCalledOnce()
  })
})

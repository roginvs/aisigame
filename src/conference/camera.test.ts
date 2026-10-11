import { describe, expect, it } from 'vitest'
import { nextCameraDeviceId, type VideoInput } from './camera.ts'

const devices: VideoInput[] = [
  { kind: 'audioinput', deviceId: 'mic' },
  { kind: 'videoinput', deviceId: 'front' },
  { kind: 'videoinput', deviceId: 'back' },
  { kind: 'videoinput', deviceId: 'wide' },
]

describe('nextCameraDeviceId', () => {
  it('cycles through every camera and wraps to the first one', () => {
    expect(nextCameraDeviceId(devices, 'front')).toBe('back')
    expect(nextCameraDeviceId(devices, 'back')).toBe('wide')
    expect(nextCameraDeviceId(devices, 'wide')).toBe('front')
  })

  it('starts at the first camera for an unknown current device', () => {
    expect(nextCameraDeviceId(devices, 'missing')).toBe('front')
  })

  it('returns null when there are no cameras', () => {
    expect(nextCameraDeviceId([{ kind: 'audioinput', deviceId: 'mic' }], null)).toBeNull()
  })
})

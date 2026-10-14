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

import { cameraFacing, isMobileCameraDevice, shouldMirrorVideo, switchFacingCamera } from './camera.ts'

describe('камера телефона', () => {
  it('определяет телефон и iPad, десктоп — нет', () => {
    expect(isMobileCameraDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile' })).toBe(true)
    expect(isMobileCameraDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBe(true)
    expect(isMobileCameraDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isMobileCameraDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(isMobileCameraDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64)' })).toBe(false)
  })

  it('зеркало: только своя и не тыловая; неизвестная своя — зеркалим; чужая — никогда', () => {
    expect(shouldMirrorVideo(true, 'user')).toBe(true)
    expect(shouldMirrorVideo(true, null)).toBe(true)
    expect(shouldMirrorVideo(true, 'environment')).toBe(false)
    expect(shouldMirrorVideo(false, 'user')).toBe(false)
    expect(shouldMirrorVideo(false, null)).toBe(false)
  })

  it('facingMode: настройки браузера, потом Jitsi, потом запрошенный', () => {
    expect(cameraFacing({ facingMode: 'environment' }, 'user', 'user')).toBe('environment')
    expect(cameraFacing({}, 'user', 'environment')).toBe('user')
    expect(cameraFacing(undefined, undefined, 'environment')).toBe('environment')
    expect(cameraFacing({ facingMode: 'left' }, undefined, null)).toBeNull()
  })

  it('сначала отпускает старую, потом открывает другую', async () => {
    const log: string[] = []
    const result = await switchFacingCamera({
      current: 'user',
      release: async () => { log.push('release') },
      open: async (facing) => { log.push(`open ${facing}`); return facing },
      install: async (track) => { log.push(`install ${track}`) },
      dispose: () => log.push('dispose'),
    })
    expect(log).toEqual(['release', 'open environment', 'install environment'])
    expect(result).toEqual({ facing: 'environment', restored: false })
  })

  it('другая камера не открылась — открывает прежнюю', async () => {
    const log: string[] = []
    const result = await switchFacingCamera({
      current: 'user',
      release: async () => { log.push('release') },
      open: async (facing) => { if (facing === 'environment') throw new Error('NotReadableError'); return facing },
      install: async (track) => { log.push(`install ${track}`) },
      dispose: () => log.push('dispose'),
    })
    expect(log).toEqual(['release', 'install user'])
    expect(result.restored).toBe(true)
    expect(String(result.error)).toContain('NotReadableError')
  })

  it('не прошла установка новой — дорожка закрывается, возврат к прежней; обе не вышли — ошибка', async () => {
    const disposed: string[] = []
    const restored = await switchFacingCamera({
      current: 'environment',
      release: async () => {},
      open: async (facing) => facing,
      install: async (track) => { if (track === 'user') throw new Error('addTrack failed') },
      dispose: (track) => disposed.push(track),
    })
    expect(disposed).toEqual(['user'])
    expect(restored).toMatchObject({ facing: 'environment', restored: true })
    await expect(switchFacingCamera({
      current: 'user',
      release: async () => {},
      open: async () => { throw new Error('нет камеры') },
      install: async () => {},
      dispose: () => {},
    })).rejects.toThrow('нет камеры')
  })
})

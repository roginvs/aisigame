import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressMic, compressMicEligible } from './micCompression.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Окно с Web Audio-узлами, как в браузере: модуль читает их только с window. */
function stubWindow(withNodes: boolean): void {
  vi.stubGlobal('window', withNodes
    ? {
        AudioContext: class {},
        MediaStreamAudioSourceNode: class {},
        MediaStreamAudioDestinationNode: class {},
      }
    : {})
}

describe('compressMicEligible — iOS и старые браузеры без обработки', () => {
  it('в обычном браузере с Web Audio — да', () => {
    stubWindow(true)
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', maxTouchPoints: 0, userAgent: 'Chrome' })
    expect(compressMicEligible()).toBe(true)
  })

  it('на iPhone и iPadOS — нет', () => {
    stubWindow(true)
    vi.stubGlobal('navigator', { platform: 'iPhone', maxTouchPoints: 5, userAgent: 'Safari' })
    expect(compressMicEligible()).toBeFalsy()
    vi.stubGlobal('navigator', { platform: 'MacIntel', maxTouchPoints: 3, userAgent: 'iPad' })
    expect(compressMicEligible()).toBeFalsy()
  })

  it('без окна или без Web Audio — нет', () => {
    stubWindow(false)
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', maxTouchPoints: 0, userAgent: 'Chrome' })
    expect(compressMicEligible()).toBeFalsy()
  })

  it('живая дорожка без AudioContext-графа — null, дорожка не останавливается', () => {
    const stop = vi.fn()
    const rawTrack = { readyState: 'live', stop } as unknown as MediaStreamTrack
    expect(compressMic(rawTrack)).toBeNull()
    expect(stop).not.toHaveBeenCalled()
  })
})

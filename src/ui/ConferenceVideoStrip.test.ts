import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConferenceVideoStrip } from './ConferenceVideoStrip.tsx'

describe('ConferenceVideoStrip', () => {
  it('marks the active speaker and offers cyclic camera switching for the local tile', () => {
    const html = renderToStaticMarkup(
      createElement(ConferenceVideoStrip, {
        tiles: [
          {
            id: 'local',
            name: 'Мастер',
            isLocal: true,
            micLive: true,
            cameraOn: true,
            speaking: true,
          },
        ],
        onToggleMic: vi.fn(),
        onToggleCamera: vi.fn(),
        onNextCamera: vi.fn(),
        bindVideo: vi.fn(),
      }),
    )

    expect(html).toContain('video-tile mic-live speaking')
    expect(html).toContain('aria-label="Следующая камера"')
  })
})

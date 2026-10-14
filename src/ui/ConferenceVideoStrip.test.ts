import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConferenceMediaControls, ConferenceVideoTile } from './ConferenceVideoStrip.tsx'

describe('ConferenceVideoTile', () => {
  it('marks the active speaker and shows a full-name placeholder without local controls', () => {
    const html = renderToStaticMarkup(
      createElement(ConferenceVideoTile, {
        tile: {
          id: 'local',
          name: 'Мастер',
          isLocal: true,
          micLive: true,
          cameraOn: true,
          speaking: true,
        },
        bindVideo: vi.fn(),
      }),
    )

    expect(html).toContain('video-tile local mirrored mic-live speaking')
    expect(html).toContain('<video autoPlay="" playsInline="" muted=""')
    expect(html).not.toContain('aria-label="Следующая камера"')
  })

  it('does not mark remote tiles as local', () => {
    const html = renderToStaticMarkup(
      createElement(ConferenceVideoTile, {
        tile: {
          id: 'remote',
          name: 'Вася',
          isLocal: false,
          micLive: true,
          cameraOn: true,
          speaking: false,
        },
        bindVideo: vi.fn(),
      }),
    )
    expect(html).toContain('video-tile mic-live')
    expect(html).not.toContain('video-tile local')
  })

  it('shows the full name when the camera is off', () => {
    const html = renderToStaticMarkup(
      createElement(ConferenceVideoTile, {
        tile: {
          id: 'remote',
          name: 'Василий Петров',
          isLocal: false,
          micLive: false,
          cameraOn: false,
          speaking: false,
        },
        bindVideo: vi.fn(),
      }),
    )
    expect(html).toContain('<span class="video-placeholder">Василий Петров</span>')
    expect(html).toContain('мик выкл.')
  })

  it('with hideName does not repeat the name in the frame', () => {
    const html = renderToStaticMarkup(
      createElement(ConferenceVideoTile, {
        tile: {
          id: 'remote',
          name: 'Вася',
          isLocal: false,
          micLive: false,
          cameraOn: false,
          speaking: false,
        },
        bindVideo: vi.fn(),
        hideName: true,
      }),
    )
    expect(html).toContain('video-placeholder-muted">камера выкл.')
    expect(html).not.toContain('video-name')
    expect(html).not.toContain('>Вася<')
    expect(html).toContain('мик выкл.')
  })
})

describe('ConferenceMediaControls', () => {
  it('shows next-camera only when cycling is available', () => {
    const withNext = renderToStaticMarkup(
      createElement(ConferenceMediaControls, {
        micLive: true,
        cameraOn: true,
        canCycleCamera: true,
        onToggleMic: vi.fn(),
        onToggleCamera: vi.fn(),
        onNextCamera: vi.fn(),
      }),
    )
    expect(withNext).toContain('aria-label="Следующая камера"')
    expect(withNext).toContain('chat-media-controls with-next')

    const pair = renderToStaticMarkup(
      createElement(ConferenceMediaControls, {
        micLive: false,
        cameraOn: true,
        canCycleCamera: false,
        onToggleMic: vi.fn(),
        onToggleCamera: vi.fn(),
        onNextCamera: vi.fn(),
      }),
    )
    expect(pair).not.toContain('aria-label="Следующая камера"')
    expect(pair).toContain('chat-media-controls pair')
    expect(pair).toContain('aria-label="Включить микрофон"')
  })
})

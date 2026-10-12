import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostPresence } from './HostPresence.tsx'

describe('HostPresence', () => {
  it('adds speaking class when conference audio level is active', () => {
    const quiet = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'lobby',
        link: { host: 'idle', mic: 'idle' },
        status: 'Ждём начала игры',
      }),
    )
    const speaking = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'lobby',
        link: { host: 'idle', mic: 'idle' },
        status: 'Ждём начала игры',
        conferenceSpeaking: true,
      }),
    )

    expect(quiet).not.toContain(' speaking')
    expect(speaking).toContain('host host-think speaking')
  })

  it('shows hear-turn-only checkbox only when the master callback is passed', () => {
    const plain = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'choosing.listening',
        link: { host: 'idle', mic: 'live' },
        status: '',
      }),
    )
    const master = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'choosing.listening',
        link: { host: 'idle', mic: 'live' },
        status: '',
        hearTurnOnly: true,
        onHearTurnOnlyChange: () => {},
      }),
    )

    expect(plain).not.toContain('Меньше слышать')
    expect(master).toContain('Меньше слышать')
    expect(master).toContain('host-hear-less is-on')
    expect(master).toContain('role="switch"')
    expect(master).toContain('checked')
  })
})

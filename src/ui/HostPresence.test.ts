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
})

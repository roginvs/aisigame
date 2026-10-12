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

  it('invites chat in conference lobby instead of silence', () => {
    const joiner = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'lobby',
        link: { host: 'idle', mic: 'idle' },
        status: 'Ждём начала игры',
      }),
    )
    const master = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'startMenu',
        link: { host: 'idle', mic: 'idle' },
        status: 'Ждём начала игры',
        lobbyInvite: true,
      }),
    )
    const inMatch = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'judging',
        link: { host: 'idle', mic: 'idle' },
        status: 'Ведущая оценивает ответ',
      }),
    )

    expect(joiner).toContain('Можно поболтать')
    expect(joiner).not.toContain('Не говорите')
    expect(joiner).toContain('Ждём начала игры')
    expect(master).toContain('Можно поболтать')
    expect(master).not.toContain('Не говорите')
    expect(inMatch).toContain('Не говорите')
    expect(inMatch).not.toContain('Можно поболтать')
  })

  it('prefers conference listen hint over buzz mood copy when hear-turn-only is on', () => {
    const html = renderToStaticMarkup(
      createElement(HostPresence, {
        path: 'buzzing.open',
        link: { host: 'idle', mic: 'live' },
        status: 'Жмите свою кнопку',
        titleHint: 'Ничего не слышу',
        hearTurnOnly: true,
        onHearTurnOnlyChange: () => {},
      }),
    )

    expect(html).toContain('Жмите кнопку')
    expect(html).toContain('Ничего не слышу')
    expect(html).not.toContain('Слышу вас, засчитаю только после кнопки')
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

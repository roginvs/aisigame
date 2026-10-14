import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostPresence } from './HostPresence.tsx'

describe('HostPresence', () => {
  it('показывает «Слышу…» и «Поняла, думаю…» со значком; ход игрока уходит в подсказку', () => {
    const hear = renderToStaticMarkup(createElement(HostPresence, {
      path: 'choosing.listening', link: { host: 'idle', mic: 'live' }, status: '', ear: 'hearing', title: 'Вася выбирает вопрос',
    }))
    expect(hear).toContain('host host-hear')
    expect(hear).toContain('Слышу…')
    expect(hear).toContain('Вася выбирает вопрос')
    expect(hear).toContain('data-ear="hearing"')
    const process = renderToStaticMarkup(createElement(HostPresence, {
      path: 'judging', link: { host: 'idle', mic: 'muted' }, status: '', ear: 'processing',
    }))
    expect(process).toContain('host host-process')
    expect(process).toContain('Поняла, думаю…')
    expect(process).toContain('data-ear="processing"')
    const quiet = renderToStaticMarkup(createElement(HostPresence, {
      path: 'choosing.listening', link: { host: 'idle', mic: 'live' }, status: '',
    }))
    expect(quiet).toContain('host host-listen')
    expect(quiet).not.toContain('data-ear')
  })

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

it('places the audio switch beside the hear-less switch and disables unsupported providers', () => {
  const html = renderToStaticMarkup(createElement(HostPresence, {
    path: 'choosing.listening', link: { host: 'idle', mic: 'live' }, status: '',
    hearTurnOnly: false, onHearTurnOnlyChange: () => {},
    audioJudgment: true, audioJudgmentSupported: true, onAudioJudgmentChange: () => {},
  }))
  expect(html).toContain('host-with-two-switches')
  expect(html).toContain('Оценивать по аудио')
  expect(html).toContain('Меньше слышать')
  expect(html.match(/role="switch"/g)).toHaveLength(2)
  const unsupported = renderToStaticMarkup(createElement(HostPresence, {
    path: 'lobby', link: { host: 'idle', mic: 'live' }, status: '',
    audioJudgment: true, audioJudgmentSupported: false, onAudioJudgmentChange: () => {},
  }))
  expect(unsupported).toContain('disabled')
  expect(unsupported).toContain('aria-checked="false"')
  expect(unsupported).not.toContain('Меньше слышать')
})

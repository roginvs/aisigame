import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QuestionClip, QuestionMedia } from './QuestionMedia.tsx'
import { meterRestAngle } from './QuestionMeter.tsx'

describe('QuestionClip', () => {
  it('без кнопок, сам играет и крутится, пока клип должен звучать', () => {
    const html = renderToStaticMarkup(
      createElement(QuestionClip, { kind: 'audio', url: 'studio/beeps.wav', live: true, label: 'Звук вопроса' }),
    )
    expect(html).not.toMatch(/controls/i)
    expect(html).toMatch(/autoplay/i)
    expect(html).toMatch(/\bloop\b/i)
    expect(html).toContain('data-live="1"')
    expect(html).toContain('vu-meter')
    expect(html).toContain(`rotate(${meterRestAngle}`)
  })

  it('на паузе нет кнопок, цикла и автозапуска', () => {
    const html = renderToStaticMarkup(
      createElement(QuestionClip, { kind: 'video', url: 'studio/square.mp4', live: false, label: 'Ролик вопроса' }),
    )
    expect(html).not.toMatch(/controls/i)
    expect(html).not.toMatch(/autoplay/i)
    expect(html).not.toMatch(/\bloop\b/i)
    expect(html).toContain('data-live="0"')
    expect(html).toMatch(/playsinline/i)
    expect(html).not.toContain('vu-meter')
  })

  it('медиа вопроса: картинка как есть, звук без кнопок; под ответ цикл снят', () => {
    const playing = renderToStaticMarkup(
      createElement(QuestionMedia, {
        play: true,
        media: [
          { kind: 'image', name: 'круг', url: 'studio/circle.svg' },
          { kind: 'audio', name: 'сигналы', url: 'studio/beeps.wav' },
        ],
      }),
    )
    expect(playing).toContain('<img')
    expect(playing).toContain('vu-meter')
    expect(playing).not.toMatch(/controls/i)
    expect(playing).toMatch(/autoplay/i)
    expect(playing).toMatch(/\bloop\b/i)

    const quiet = renderToStaticMarkup(
      createElement(QuestionMedia, {
        play: true,
        quiet: new Set(['studio/beeps.wav']),
        media: [{ kind: 'audio', name: 'сигналы', url: 'studio/beeps.wav' }],
      }),
    )
    expect(quiet).not.toMatch(/controls/i)
    expect(quiet).not.toMatch(/autoplay/i)
    expect(quiet).not.toMatch(/\bloop\b/i)
    expect(quiet).toContain('data-live="0"')
    expect(quiet).toContain('vu-meter')
    expect(quiet).toContain(`rotate(${meterRestAngle}`)
  })
})

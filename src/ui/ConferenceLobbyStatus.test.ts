import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConferenceLobbyStatus } from './ConferenceLobbyStatus.tsx'

describe('ConferenceLobbyStatus', () => {
  it('показывает баннер отключения мастера и может отдать его родителю', () => {
    const withBanner = renderToStaticMarkup(
      createElement(ConferenceLobbyStatus, { masterOffline: true }),
    )
    const withoutBanner = renderToStaticMarkup(
      createElement(ConferenceLobbyStatus, { masterOffline: true, banner: false }),
    )

    expect(withBanner).toContain('Мастер-игрок отключился')
    expect(withBanner).toContain('error banner')
    expect(withoutBanner).toContain('Мастер-игрок отключился')
    expect(withoutBanner).not.toContain('error banner')
  })
})

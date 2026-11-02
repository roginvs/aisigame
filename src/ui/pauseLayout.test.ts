import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('пауза: камера целиком', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

  it('видео на паузе вписано в ячейку целиком, а не обрезано overflow', () => {
    expect(css).toMatch(/\.play\.is-paused \.conference-player \.video-tile \{[^}]*height:\s*100%/)
    const video = css.match(/\.play\.is-paused \.conference-player \.video-frame video \{([^}]*)\}/)
    expect(video?.[1]).toMatch(/position:\s*absolute/)
    expect(video?.[1]).toMatch(/inset:\s*0/)
    expect(video?.[1]).toMatch(/object-fit:\s*contain/)
  })
})

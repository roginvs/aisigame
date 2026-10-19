import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { timerFlashKey } from './flash.ts'

describe('вспышки', () => {
  it('ключ таймера меняется на новое окно и стабилен на перерисовках', () => {
    const a = timerFlashKey('question.open', 'q1', 3)
    expect(timerFlashKey('question.open', 'q1', 3)).toBe(a)
    expect(timerFlashKey('question.open', 'q1', 4)).not.toBe(a)
    expect(timerFlashKey('question.open', 'q2', 3)).not.toBe(a)
    expect(timerFlashKey('answering', 'q1', 3)).not.toBe(a)
  })
  it('CSS: анимации без смены размеров и с prefers-reduced-motion', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8')
    for (const name of ['timer-flash', 'focus-flash']) {
      const body = css.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
      expect(body).not.toBe('')
      expect(body).not.toMatch(/\b(width|height|margin|padding|border-width|outline-width)\s*:/)
    }
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.timer-bar \{ animation: none; \}\s*\.player\.active \{ animation: none; \}/)
  })
  it('Countdown перемонтируется по ключу окна', () => {
    const src = readFileSync(join(process.cwd(), 'src/ui/GameScreen.tsx'), 'utf8')
    expect(src.match(/<Countdown key=\{timerKey\}/g)?.length).toBe(3)
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Звук ведущей, звуки игры и запросы к модели — от машины/контроллера, не от экрана:
// экран мастера рисуется из снимка (новый объект каждую отправку и раз в секунду), эффекты
// на нём не должны ничего говорить, отменять или играть.
const forbidden = /\b(playCatMeow|playAuctionDing|playTimeoutBeep|requestSpeech|interruptSpeech|requestTool|sendSessionUpdate)\s*\(/

describe('экран только рисует', () => {
  it('src/ui не вызывает модель и не играет звуки игры', () => {
    const dir = join(process.cwd(), 'src/ui')
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
      .filter((name) => forbidden.test(readFileSync(join(dir, name), 'utf8')))
    expect(offenders).toEqual([])
  })
})

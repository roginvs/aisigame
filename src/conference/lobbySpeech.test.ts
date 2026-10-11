import { describe, expect, it } from 'vitest'
import { lobbySpeechInstructions } from './lobbySpeech.ts'

describe('lobbySpeechInstructions', () => {
  it('разрешает коротко участвовать в разговоре игроков без длинного монолога', () => {
    const instructions = lobbySpeechInstructions({
      kind: 'idle',
      packName: 'Демо',
      packSummary: 'Один раунд.',
      roster: [],
    })

    expect(instructions).toContain('можешь коротко и естественно его прокомментировать, ответить или поддержать беседу')
    expect(instructions).toContain('не больше двух коротких предложений')
    expect(instructions).toContain('лучше коротко подхвати их разговор')
    expect(instructions).not.toContain('Не отвечай на разговоры игроков')
  })
})

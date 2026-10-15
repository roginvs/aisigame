import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { commentaryContext, withCommentary } from './commentary.ts'
import { gameMachine } from './machine.ts'

describe('public commentary context', () => {
  it('contains names, chat and scores but never serialized hidden answers or credentials', () => {
    const actor = createActor(gameMachine).start()
    const context = { ...actor.getSnapshot().context, secret: 'API_SECRET' }
    context.questions = [{ ...context.questions[0]!, answers: ['HIDDEN_ANSWER'] }]
    const prompt = commentaryContext(context, [{ kind: 'chat', name: 'Маша', text: 'Привет' }])
    expect(prompt).toContain('Маша')
    expect(prompt).toContain('Привет')
    expect(prompt).toContain('score')
    expect(prompt).not.toContain('HIDDEN_ANSWER')
    expect(prompt).not.toContain('API_SECRET')
    actor.stop()
  })

  it('bounds recent history and preserves input order instead of timestamp sorting', () => {
    const prompt = commentaryContext(null, Array.from({ length: 220 }, (_, i) => ({ kind: 'chat' as const, name: 'Игрок', text: `line-${i}`, at: String(220 - i) })))
    expect(prompt).not.toContain('"line-19"')
    expect(prompt.indexOf('"line-20"')).toBeLessThan(prompt.indexOf('"line-219"'))
    expect(commentaryContext(null, Array.from({ length: 200 }, () => ({ kind: 'chat' as const, name: 'Игрок', text: 'x'.repeat(10000) }))).length).toBeLessThan(26000)
  })

  it('appends public history after the cue', () => {
    const actor = createActor(gameMachine).start()
    const cue = withCommentary('Объяви счёт', actor.getSnapshot().context, [])
    expect(cue.startsWith('Объяви счёт')).toBe(true)
    expect(cue).toContain('Публичный контекст')
    actor.stop()
  })
})

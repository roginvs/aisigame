import { describe, expect, it } from 'vitest'
import { isolatedCue, isolatedToolResponse, speechMatches, speechOverruns, verbatimResponse, withPlayNote } from './speechMatch.ts'

const newton = 'Кто сформулировал закон всемирного тяготения?'
const melting = 'Как называется процесс, при котором вещество переходит из твердого состояния в жидкое, и наоборот?'

describe('speechMatches', () => {
  it('accepts the package question and a light spoken variant', () => {
    expect(speechMatches(newton, newton)).toBe(true)
    expect(speechMatches('Кто сформулировал закон всемирного тяготения', newton)).toBe(true)
  })

  it('rejects a different question', () => {
    expect(speechMatches(melting, newton)).toBe(false)
    expect(speechMatches('Кто написал симфонию «Лунная соната»?', 'Сколько струн у обычной скрипки?')).toBe(false)
  })

  it('rejects an announcement of the chosen cell', () => {
    expect(
      speechMatches(
        'Отличный выбор, музыка за двести! Дальше выбирайте тему или номинал, или задавайте своего вопроса.',
        'Кто написал «Времена года»?',
      ),
    ).toBe(false)
    expect(
      speechMatches(
        'Отлично, «Реки за 200» выбрано. Готов к следующему вопросу, давайте его дальше!',
        'На какой реке стоит Рим?',
      ),
    ).toBe(false)
  })
})

describe('isolatedToolResponse', () => {
  it('оценивает ответ без предыдущих реплик ведущей', () => {
    const response = isolatedToolResponse({
      name: 'submitAnswerJudgment',
      instructions: 'Вопрос: Кто написал «Времена года»?\nРеплика игрока: «Бетховен»',
      purpose: 'judge',
      turn: 8,
      mode: 'text',
      tools: [],
    })
    expect(response.conversation).toBe('none')
    expect(response.tool_choice.name).toBe('submitAnswerJudgment')
    expect(response.input[0]?.content[0]?.text).toContain('Бетховен')
    expect(response.input[0]?.content[0]?.text).toContain('Времена года')
  })
})

describe('isolatedCue', () => {
  it('подтверждает ответ без истории и без эталона, если его не просят', () => {
    const response = isolatedCue('Одна короткая фраза: верно. Сразу назови очки: плюс 100.', {
      purpose: 'announce',
      turn: 3,
      take: 1,
    })
    expect(response.conversation).toBe('none')
    expect(response.instructions).toContain('не произноси правильный ответ')
    expect(response.instructions).toContain('без предисловия')
    expect(response.instructions).toContain('своими словами')
    expect(response.input[0]?.content[0]?.text).toContain('плюс 100')
    expect(response.input[0]?.content[0]?.text).not.toContain('Вивальди')
  })

  it('пометку как сыграть не кладёт в текст, который говорят игрокам', () => {
    const response = isolatedCue(
      withPlayNote(
        'Одна короткая фраза: верно. Сразу назови очки: плюс 300. Можно добавить «дальше».',
        'Один короткий звук «хи-хи». Не произноси «смешок» и «хихикаем».',
      ),
      { purpose: 'announce', turn: 4, take: 1 },
    )
    const said = response.input[0]?.content[0]?.text ?? ''
    expect(said).toContain('плюс 300')
    expect(said).toContain('дальше')
    expect(said).not.toContain('смешок')
    expect(said).not.toContain('хихикаем')
    expect(said).not.toContain('хи-хи')
    expect(response.instructions).toContain('без предисловия')
    expect(response.instructions).toContain('своими словами')
    expect(response.instructions).toContain('хи-хи')
    expect(response.instructions).toContain('смешок')
    expect(response.instructions).toContain('не читай')
  })
})

describe('verbatimResponse', () => {
  it('читает вопрос отдельно от истории разговора', () => {
    const response = verbatimResponse('Сколько струн у обычной скрипки?', { purpose: 'read', turn: 8, take: 1 })
    expect(response.conversation).toBe('none')
    expect(response.tools).toEqual([])
    expect(response.instructions).toContain('ведущая')
    expect(response.instructions).toContain('Не объявляй тему')
    expect(response.instructions).not.toContain('Повтори фразу')
    expect(response.instructions).not.toContain('Скажи вслух')
    expect(response.input[0]?.content[0]?.text).toBe('Сколько струн у обычной скрипки?')
    expect(response.input[0]?.content[0]?.text).not.toContain('больше ничего')
    expect(response.input[0]?.content[0]?.text).not.toContain('смешок')
  })
})

describe('speechOverruns', () => {
  it('ловит ответ, произнесённый после дословного вопроса', () => {
    expect(speechOverruns(`${newton} Исаак Ньютон, конечно.`, newton)).toBe(true)
  })
  it('не трогает сам вопрос и его начало', () => {
    expect(speechOverruns(newton, newton)).toBe(false)
    expect(speechOverruns('Кто сформулировал', newton)).toBe(false)
  })
  it('не считает чужую длинную речь «довеском»', () => {
    expect(speechOverruns('Сейчас я расскажу вам совсем другую длинную историю про котов', newton)).toBe(false)
  })
})

describe('verbatimResponse', () => {
  it('отправляет только текст вопроса и запрещает на него отвечать', () => {
    const body = verbatimResponse(newton, { purpose: 'read', turn: 1, take: 1 })
    expect(body.conversation).toBe('none')
    expect(body.input).toHaveLength(1)
    expect(body.input[0]?.content[0]?.text).toBe(newton)
    expect(body.instructions).toContain('не отвечай на него')
  })
})

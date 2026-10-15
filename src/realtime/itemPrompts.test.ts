import { describe, expect, it } from 'vitest'
import { ItemPrompts, echoesAnyPrompt } from './itemPrompts.ts'

const catalog = '{Глобус и меридианы 10, 20, 30; Кисточка и камертон 10, 20}'
const hallucinated = 'Глобус и меридианы 10, 20, 30; Кисточка и камертон 10, 20.'

describe('ItemPrompts', () => {
  it('поздняя расшифровка сравнивается с подсказкой, что была во время речи', () => {
    const prompts = new ItemPrompts()
    prompts.set(catalog)
    prompts.started('item-1')
    prompts.set('') // выбор сделан, началось чтение вопроса
    expect(echoesAnyPrompt(hallucinated, [prompts.prompt])).toBe(false)
    expect(echoesAnyPrompt(hallucinated, prompts.promptsFor('item-1'))).toBe(true)
  })

  it('подсказка, сменённая до прихода расшифровки, тоже учитывается', () => {
    const prompts = new ItemPrompts()
    prompts.started('item-2')
    prompts.set(catalog)
    expect(prompts.promptsFor('item-2')).toContain(catalog)
    prompts.finished('item-2')
    prompts.set('другая')
    expect(prompts.promptsFor('item-2')).not.toContain('X')
    expect(prompts.promptsFor('item-2')).toEqual(['', catalog, 'другая'])
  })

  it('без item_id — только текущая подсказка', () => {
    const prompts = new ItemPrompts()
    prompts.set(catalog)
    expect(prompts.promptsFor(null)).toEqual([catalog])
  })

  it('обычная речь не считается эхом', () => {
    expect(echoesAnyPrompt('Глобус и меридианы за тридцать', [catalog])).toBe(false)
  })
})

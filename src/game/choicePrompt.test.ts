import { describe, expect, it } from 'vitest'
import { choicePrompt, echoesChoicePrompt, priceWords } from './choicePrompt.ts'

describe('choicePrompt', () => {
  it('подсказывает распознаванию открытые темы и номиналы', () => {
    expect(priceWords(100)).toBe('сто')
    expect(priceWords(1200)).toBe('тысяча двести')
    const prompt = choicePrompt('normal', [
      { theme: 'Реки', value: 100 },
      { theme: 'Музыка', value: 200 },
    ])
    expect(prompt).toContain('Реки 100 сто')
    expect(prompt).toContain('Музыка 200 двести')
    expect(prompt.length).toBeLessThanOrEqual(1024)
  })

  it('укладывает шесть тем в лимит подсказки распознавания', () => {
    const themes = ['Поехали', 'Апрель', 'Столицы мира', 'Холодное оружие', 'Б.Б.', 'Известные люди']
    const cells = themes.flatMap((theme) => [100, 200, 300, 400, 500].map((value) => ({ theme, value })))
    const prompt = choicePrompt('normal', cells)
    expect(prompt.length).toBeLessThanOrEqual(1024)
    expect(prompt).toContain('Б.Б.')
    expect(prompt).toContain('сто')
    for (const theme of themes) expect(prompt).toContain(theme)
  })

  it('убирает словесные цены, если иначе подсказка длиннее 1024', () => {
    const themes = Array.from({ length: 6 }, (_, index) => `Очень длинное название темы номер ${index + 1} ${'слово '.repeat(12)}`.trim())
    const cells = themes.flatMap((theme) => [100, 200, 300, 400, 500, 600, 700, 800].map((value) => ({ theme, value })))
    const prompt = choicePrompt('normal', cells)
    expect(prompt.length).toBeLessThanOrEqual(1024)
    expect(prompt).toContain(themes[0]?.slice(0, 24))
    expect(prompt).not.toContain('двести')
    expect(prompt).toContain('100')
  })

  it('в финале называет только темы', () => {
    expect(choicePrompt('final', [{ theme: 'Столицы', value: 0 }])).toContain('Столицы')
    expect(choicePrompt('final', [{ theme: 'Столицы', value: 0 }])).not.toContain('0')
  })

  it('не принимает расшифровку, которая повторяет подсказку тем', () => {
    const cells = [
      { theme: 'Супчики', value: 100 },
      { theme: 'Нарисованные афиши', value: 100 },
      { theme: 'Космос', value: 200 },
      { theme: 'Реки', value: 300 },
      { theme: 'Музыка', value: 400 },
      { theme: 'Кино', value: 500 },
    ]
    const prompt = choicePrompt('normal', cells)
    expect(prompt.startsWith('Тема и цена')).toBe(false)
    expect(prompt.length).toBeLessThanOrEqual(1024)
    const body = prompt.replace(/^\{/, '').replace(/\}$/, '')
    const slice = body.split('; ').slice(0, 4).join('; ')
    expect(echoesChoicePrompt(prompt, prompt)).toBe(true)
    expect(echoesChoicePrompt(slice, prompt)).toBe(true)
    expect(echoesChoicePrompt(`Тема и цена: ${body}.`, prompt)).toBe(true)
    expect(echoesChoicePrompt('Супчики сто', prompt)).toBe(false)
    expect(echoesChoicePrompt('Нарисованные афиши 100', prompt)).toBe(false)
    expect(echoesChoicePrompt('Супчики 100 сто', prompt)).toBe(false)
    expect(echoesChoicePrompt('кхе', prompt)).toBe(false)
    expect(echoesChoicePrompt('Пока', prompt)).toBe(false)
    const alone = choicePrompt('normal', [{ theme: 'Супчики', value: 100 }])
    expect(echoesChoicePrompt('Супчики сто', alone)).toBe(false)
    expect(echoesChoicePrompt('Супчики 100 сто', alone)).toBe(false)
    expect(echoesChoicePrompt(alone, alone)).toBe(false)
  })

  it('не принимает каталог из дампа, даже со старым началом «Тема и цена»', () => {
    const cells = [
      [200, 400, 600, 800, 1000].map((value) => ({ theme: 'ОРДЫ И ХАНЫ', value })),
      [400, 600, 800, 1000].map((value) => ({ theme: 'СВОБОДНАЯ', value })),
      [200, 400, 600, 1000].map((value) => ({ theme: 'ГОВОРИТ БАНДИТ С ЭКРАНА', value })),
      [600, 800, 1000].map((value) => ({ theme: 'П......Ц', value })),
      [200, 400, 600, 800, 1000].map((value) => ({ theme: 'ВОЛГА', value })),
      [200, 400, 600, 1000].map((value) => ({ theme: 'БОГИ И ГЕРОИ', value })),
    ].flat()
    const prompt = choicePrompt('normal', cells)
    expect(prompt.length).toBeLessThanOrEqual(1024)
    expect(prompt.startsWith('{')).toBe(true)
    const body = prompt.slice(1, -1)
    expect(echoesChoicePrompt(`Тема и цена: ${body}.`, prompt)).toBe(true)
    expect(echoesChoicePrompt(prompt, prompt)).toBe(true)
    expect(echoesChoicePrompt(body.split('; ').slice(0, 4).join('; '), prompt)).toBe(true)
    expect(echoesChoicePrompt('Тема и цена: Свободная 400.', prompt)).toBe(true)
    expect(echoesChoicePrompt('Свободная 400', prompt)).toBe(false)
    expect(echoesChoicePrompt('Известные фамилии за 500', prompt)).toBe(false)
    expect(echoesChoicePrompt('Пиздец 400', prompt)).toBe(false)
    expect(echoesChoicePrompt('ПЦ 400', prompt)).toBe(false)
  })
})
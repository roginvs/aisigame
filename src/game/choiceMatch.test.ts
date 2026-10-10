import { describe, expect, it } from 'vitest'
import { matchSpokenCell, selectionChatText, type ChoiceCell } from './choiceMatch.ts'

const cells: ChoiceCell[] = [
  { themeId: 'p', themeName: 'П......Ц', value: 400 },
  { themeId: 'p', themeName: 'П......Ц', value: 600 },
  { themeId: 'free', themeName: 'СВОБОДНАЯ', value: 400 },
  { themeId: 'volga', themeName: 'ВОЛГА', value: 200 },
  { themeId: 'names', themeName: 'ИЗВЕСТНЫЕ ФАМИЛИИ', value: 500 },
  { themeId: 'cheap', themeName: 'СОТКА ТЕМЫ', value: 100 },
  { themeId: 'grand', themeName: 'БОЛЬШАЯ', value: 1000 },
]

describe('matchSpokenCell', () => {
  it('берёт тему с точками по аббревиатуре и по слову с теми же краями', () => {
    expect(matchSpokenCell('ПЦ 400.', cells, 'normal')?.themeId).toBe('p')
    expect(matchSpokenCell('пиздец 400', cells, 'normal')?.value).toBe(400)
    expect(matchSpokenCell('П......Ц 600', cells, 'normal')?.value).toBe(600)
    expect(matchSpokenCell('ПЦ 400', cells.filter((cell) => cell.value !== 400), 'normal')).toBeNull()
  })

  it('берёт обычную тему и цену цифрой или словом', () => {
    expect(matchSpokenCell('Свободная 400', cells, 'normal')?.themeId).toBe('free')
    expect(matchSpokenCell('Известные фамилии за 500', cells, 'normal')?.themeId).toBe('names')
    expect(matchSpokenCell('Волга двести', cells, 'normal')?.themeId).toBe('volga')
    expect(matchSpokenCell('Волга четыреста', cells, 'normal')).toBeNull()
    expect(matchSpokenCell('сотка темы сотка', cells, 'normal')?.value).toBe(100)
    expect(matchSpokenCell('Большая тысяча', cells, 'normal')?.value).toBe(1000)
  })

  it('не угадывает, если подходят две темы или две цены', () => {
    const twins: ChoiceCell[] = [
      { themeId: 'a', themeName: 'П......Ц', value: 400 },
      { themeId: 'b', themeName: 'П.....Ц', value: 400 },
    ]
    expect(matchSpokenCell('пиздец 400', twins, 'normal')).toBeNull()
    expect(matchSpokenCell('ПЦ 400', twins, 'normal')).toBeNull()
    expect(matchSpokenCell('Свободная и Волга 400', cells, 'normal')).toBeNull()
    expect(matchSpokenCell('Свободная 400 600', cells, 'normal')).toBeNull()
    expect(matchSpokenCell('Свободная касса', cells, 'normal')).toBeNull()
    expect(matchSpokenCell('400', cells, 'normal')).toBeNull()
  })

  it('в финале хватает одной темы', () => {
    const finalCells = [{ themeId: 'capitals', themeName: 'Столицы', value: 0 }]
    expect(matchSpokenCell('Столицы', finalCells, 'final')?.themeId).toBe('capitals')
    expect(matchSpokenCell('Столицы и Реки', [...finalCells, { themeId: 'rivers', themeName: 'Реки', value: 0 }], 'final')).toBeNull()
  })
})

describe('selectionChatText', () => {
  it('показывает расшифровку распознавателя, а не пересказ модели', () => {
    expect(selectionChatText('ПЦ 400.', false, '')).toBe('Выбор: не уверена\nУслышала: ПЦ 400.\nЯчейка: —')
    expect(selectionChatText('Свободная 400.', true, 'СВОБОДНАЯ 400')).toContain('Услышала: Свободная 400.')
    expect(selectionChatText('Свободная 400.', true, 'СВОБОДНАЯ 400')).not.toContain('Свободная касса')
  })
})

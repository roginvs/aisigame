/**
 * Колонки крупных карточек на паузе и в «Игра окончена»: один игрок — одно место,
 * до четырёх — два на два, дальше три колонки, больше восьми — четыре.
 */
export function pauseColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 6) return 3
  return 4
}

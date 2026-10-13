/** Фразы ведущей про апелляцию: итог ЭТОГО вопроса у игрока числом словами, без «счёт не изменился». */
import { priceWords } from './choicePrompt.ts'

const genitiveHundreds: Record<string, string> = {
  'сто': 'ста', 'двести': 'двухсот', 'триста': 'трёхсот', 'четыреста': 'четырёхсот', 'пятьсот': 'пятисот',
  'шестьсот': 'шестисот', 'семьсот': 'семисот', 'восемьсот': 'восьмисот', 'девятьсот': 'девятисот', 'тысяча': 'тысячи',
}

/** «минус триста», «плюс сто», «ноль»; родительный — «минус трёхсот», «нуля». Не круглые суммы — цифрами. */
export function amountWords(amount: number, genitive = false): string {
  if (amount === 0) return genitive ? 'нуля' : 'ноль'
  const sign = amount < 0 ? 'минус' : 'плюс'
  const abs = Math.abs(amount)
  const words = priceWords(abs)
  if (words === String(abs)) return `${sign} ${abs}`
  const body = genitive ? words.split(' ').map((word) => genitiveHundreds[word] ?? word).join(' ') : words
  return `${sign} ${body}`
}

/**
 * Итог апелляции одной фразой. Один итог на игрока за ячейку: новый заменяет прежний, это не доплата и не второе списание.
 * accepted — решение в пользу игрока (верно), иначе апелляция не помогла.
 */
export function appealResultLine(input: { name: string; amount: number; previous: number; accepted: boolean; total?: number }): string {
  const { name, amount, previous, accepted, total } = input
  const who = `у игрока ${name}`
  const tail = total === undefined ? '' : ` Общий счёт ${total}.`
  if (amount === previous) {
    return accepted
      ? `Апелляция ничего не меняет: за этот вопрос ${who} по-прежнему ${amountWords(amount)}.${tail}`
      : `Апелляция не помогла: за этот вопрос ${who} по-прежнему ${amountWords(amount)}.${tail}`
  }
  return `${accepted ? 'Апелляция принята' : 'Апелляция не помогла'}: за этот вопрос ${who} теперь ${amountWords(amount)} вместо ${amountWords(previous, true)}.${tail}`
}

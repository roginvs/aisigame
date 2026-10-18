import { jokeCueChance } from '../options.ts'

/**
 * true — подсказке свободной реплики можно добавить настроение: короткую добрую шутку или
 * кокетство (константа jokeCueChance). Тесты подменяют flip, чтобы не зависеть от случайности.
 */
export const jokeCoin = {
  flip(): boolean {
    return Math.random() < jokeCueChance
  },
}

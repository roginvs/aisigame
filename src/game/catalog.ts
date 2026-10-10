import { localPackFiles } from 'virtual:local-packs'

/** Подписи своих пакетов. Чужой файл из public/packs показывается по имени. */
const knownTitles: Record<string, string> = {
  studio: 'Наглядно: картинка, звук и ролик',
  demo: 'Демо, один раунд',
  tournament: 'Турнир: три раунда и финал',
  evening: 'Вечерний: два раунда и финал',
}

const knownOrder = ['studio', 'demo', 'tournament', 'evening']

export type PackCatalogItem = {
  id: string
  title: string
  href: string
}

function stem(file: string): string {
  return file.replace(/\.siq$/i, '')
}

export const packCatalog: PackCatalogItem[] = localPackFiles
  .filter((file) => file.toLowerCase().endsWith('.siq'))
  .map((file) => {
    const id = stem(file)
    return {
      id,
      title: knownTitles[id] ?? id,
      href: `/packs/${file}`,
    }
  })
  .sort((left, right) => {
    const leftRank = knownOrder.indexOf(left.id)
    const rightRank = knownOrder.indexOf(right.id)
    const leftOrder = leftRank === -1 ? knownOrder.length : leftRank
    const rightOrder = rightRank === -1 ? knownOrder.length : rightRank
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return left.id.localeCompare(right.id, 'en')
  })

export const ownPackId = 'file'

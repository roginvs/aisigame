import { localPackFiles } from 'virtual:local-packs'

/** Подписи встроенных пакетов. Внешний файл показывается по имени. */
const knownTitles: Record<string, string> = {
  demo: 'Демо: два раунда',
}

export type PackCatalogItem = {
  id: string
  title: string
  href: string
}

function stem(file: string): string {
  return file.split('/').at(-1)!.replace(/\.siq$/i, '')
}

const builtinIds = new Set(localPackFiles.filter((file) => file.startsWith('builtin/')).map(stem))

export const packCatalog: PackCatalogItem[] = localPackFiles
  .filter((file) => file.toLowerCase().endsWith('.siq'))
  .map((file) => {
    const name = stem(file)
    const builtin = file.startsWith('builtin/')
    // Сохраняем прежние id для продолжения; одноимённый внешний файл не затеняет встроенный.
    const id = !builtin && builtinIds.has(name) ? `external/${name}` : name
    return {
      id,
      title: builtin ? (knownTitles[name] ?? name) : name,
      href: `${import.meta.env.BASE_URL}packs/${file}`,
    }
  })

export const ownPackId = 'file'

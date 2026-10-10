/** Выбор на стартовом экране. Не партия (`aisigame.game`) и не ключ (`aisigame.openaiApiKey`). */
export const startStorageKey = 'aisigame.start'

export type StartPrefs = {
  names: string
  packId: string
}

const empty: StartPrefs = { names: '', packId: '' }

export function readStartPrefs(storage: Storage = localStorage): StartPrefs {
  try {
    const raw = storage.getItem(startStorageKey)
    if (!raw) return empty
    const record = JSON.parse(raw) as Record<string, unknown>
    return {
      names: typeof record.names === 'string' ? record.names : '',
      packId: typeof record.packId === 'string' ? record.packId : '',
    }
  } catch {
    return empty
  }
}

/** Пакет с диска и чужой id не запоминаются: остаётся прошлый пакет каталога. */
export function writeStartPrefs(
  input: { names: string; packId: string },
  catalogIds: readonly string[],
  storage: Storage = localStorage,
): StartPrefs {
  const previous = readStartPrefs(storage)
  const packId = catalogIds.includes(input.packId)
    ? input.packId
    : catalogIds.includes(previous.packId)
      ? previous.packId
      : ''
  const next: StartPrefs = { names: input.names, packId }
  storage.setItem(startStorageKey, JSON.stringify(next))
  return next
}

export function preferredPackId(savedPackId: string, catalogIds: readonly string[], fallback: string): string {
  return catalogIds.includes(savedPackId) ? savedPackId : fallback
}

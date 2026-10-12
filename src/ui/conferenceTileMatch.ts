import type { ConferenceTile } from '../conference/media.ts'

/** Локальная плитка или remote по совпадению имени (Jitsi id ≠ clientId). */
export function matchConferenceTile(
  tiles: readonly ConferenceTile[],
  input: { selfClientId?: string; clientId?: string | null; name: string },
): ConferenceTile | undefined {
  const name = input.name.trim()
  if (input.clientId && input.selfClientId && input.clientId === input.selfClientId) {
    return tiles.find((tile) => tile.isLocal) ?? tiles.find((tile) => tile.name.trim() === name)
  }
  const byName = tiles.find((tile) => !tile.isLocal && tile.name.trim() === name)
  if (byName) return byName
  if (!input.clientId && input.selfClientId) {
    return tiles.find((tile) => tile.isLocal)
  }
  return tiles.find((tile) => tile.name.trim() === name)
}

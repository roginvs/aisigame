import type { ConferenceJitsiPair } from './messages.ts'

/**
 * Id соединения Jitsi устройства по парам `[jitsiId, clientId]` из полученного снимка.
 * Несколько игроков одного устройства (multi-seat) делят один clientId — и один jitsiId.
 */
export function jitsiIdOfClient(
  pairs: readonly ConferenceJitsiPair[] | undefined,
  clientId: string | null | undefined,
): string | null {
  if (!pairs || !clientId) return null
  for (const [jitsiId, owner] of pairs) if (owner === clientId) return jitsiId
  return null
}

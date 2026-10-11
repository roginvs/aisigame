import { verifyPack } from './chunks.ts'

export type PackGateDecision = {
  ready: boolean
  store: boolean
  buzz: boolean
}

/** Решение без IndexedDB — для тестов и UI до записи в базу. */
export async function decidePackGate(
  bytes: Uint8Array,
  expectedHash: string,
  expectedSize?: number,
): Promise<PackGateDecision> {
  const { ok } = await verifyPack(bytes, expectedHash, expectedSize)
  if (ok) return { ready: true, store: true, buzz: true }
  return { ready: false, store: false, buzz: false }
}

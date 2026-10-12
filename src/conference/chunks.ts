import { sha256Hex } from '../game/savedGame.ts'

/** Сырой кусок пакета до base64. 64 KiB → ~87 KiB в JSON; лимит `dataBase64` в messages — 400K. */
export const CHUNK_BYTES = 64 * 1024
/** Верхняя граница числа кусков в полёте, пока ждём ACK. */
export const CHUNK_WINDOW = 16
/** Верхняя граница сырых байтов в полёте (до base64). 512 KiB ≈ 8 полных кусков. */
export const CHUNK_WINDOW_BYTES = 512 * 1024
/** Не кладём новые packChunk в data channel, пока bufferedAmount выше этого. */
export const PACK_CHANNEL_HIGH_WATER_BYTES = 256 * 1024
/** Порог bufferedAmountLowThreshold / возобновление отправки кусков. */
export const PACK_CHANNEL_LOW_WATER_BYTES = 64 * 1024

export type SplitChunk = {
  index: number
  total: number
  bytes: Uint8Array
}

export type WireChunk = {
  hash: string
  index: number
  total: number
  dataBase64: string
}

export function splitChunks(bytes: Uint8Array): SplitChunk[] {
  const total = bytes.length === 0 ? 1 : Math.ceil(bytes.length / CHUNK_BYTES)
  const out: SplitChunk[] = []
  for (let index = 0; index < total; index += 1) {
    const start = index * CHUNK_BYTES
    const end = Math.min(bytes.length, start + CHUNK_BYTES)
    out.push({ index, total, bytes: bytes.subarray(start, end) })
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function chunkToWire(hash: string, chunk: SplitChunk): WireChunk {
  return {
    hash,
    index: chunk.index,
    total: chunk.total,
    dataBase64: bytesToBase64(chunk.bytes),
  }
}

export type ChunkSender = {
  readonly inflight: ReadonlySet<number>
  nextToSend: () => number | null
  onAck: (nextIndex: number) => void
}

export function createSender(
  chunks: SplitChunk[],
  windowSize = CHUNK_WINDOW,
  windowBytes = CHUNK_WINDOW_BYTES,
): ChunkSender {
  const total = chunks.length
  const inflight = new Set<number>()
  let ackedPrefix = 0

  function inflightBytes(): number {
    let sum = 0
    for (const index of inflight) sum += chunks[index]?.bytes.byteLength ?? 0
    return sum
  }

  return {
    get inflight() {
      return inflight
    },
    nextToSend() {
      if (total === 0) return null
      for (let index = ackedPrefix; index < total; index += 1) {
        if (inflight.size >= windowSize) return null
        if (inflight.has(index)) continue
        const size = chunks[index]?.bytes.byteLength ?? 0
        // Хотя бы один кусок всегда можно отправить, даже если он больше окна по байтам.
        if (inflight.size > 0 && inflightBytes() + size > windowBytes) return null
        inflight.add(index)
        return index
      }
      return null
    },
    onAck(nextIndex: number) {
      ackedPrefix = Math.max(0, Math.min(nextIndex, total))
      for (const index of [...inflight]) {
        if (index < ackedPrefix) inflight.delete(index)
      }
      if (inflight.has(ackedPrefix)) inflight.delete(ackedPrefix)
    },
  }
}

export type ChunkPushInput = {
  hash: string
  index: number
  total: number
  dataBase64: string
}

export type ChunkReceiver = {
  push: (chunk: ChunkPushInput) => { nextIndex: number; bytes: Uint8Array | null }
}

export function createReceiver(): ChunkReceiver {
  let activeHash = ''
  let expectedTotal = 0
  const received = new Map<number, Uint8Array>()

  function contiguousPrefix(): number {
    let next = 0
    while (received.has(next)) next += 1
    return next
  }

  function tryAssemble(): Uint8Array | null {
    if (expectedTotal === 0) return null
    if (contiguousPrefix() < expectedTotal) return null
    let length = 0
    for (let index = 0; index < expectedTotal; index += 1) {
      length += received.get(index)?.byteLength ?? 0
    }
    const out = new Uint8Array(length)
    let offset = 0
    for (let index = 0; index < expectedTotal; index += 1) {
      const part = received.get(index)
      if (!part) return null
      out.set(part, offset)
      offset += part.byteLength
    }
    return out
  }

  return {
    push(chunk) {
      if (activeHash && chunk.hash !== activeHash) {
        received.clear()
      }
      activeHash = chunk.hash
      expectedTotal = chunk.total
      if (chunk.index < 0 || chunk.index >= chunk.total) {
        return { nextIndex: contiguousPrefix(), bytes: tryAssemble() }
      }
      received.set(chunk.index, base64ToBytes(chunk.dataBase64))
      const nextIndex = contiguousPrefix()
      return { nextIndex, bytes: tryAssemble() }
    },
  }
}

export async function verifyPack(
  bytes: Uint8Array,
  expectedHash: string,
  expectedSize?: number,
): Promise<{ ok: boolean; percent: number }> {
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
    return { ok: false, percent: 0 }
  }
  const hash = await sha256Hex(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )
  if (hash === expectedHash) return { ok: true, percent: 100 }
  return { ok: false, percent: 0 }
}

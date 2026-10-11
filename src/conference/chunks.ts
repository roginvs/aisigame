import { sha256Hex } from '../game/savedGame.ts'

export const CHUNK_BYTES = 16 * 1024

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

export function createSender(chunks: SplitChunk[], windowSize = 4): ChunkSender {
  const total = chunks.length
  const inflight = new Set<number>()
  let ackedPrefix = 0

  return {
    get inflight() {
      return inflight
    },
    nextToSend() {
      if (total === 0) return null
      for (let index = ackedPrefix; index < total; index += 1) {
        if (inflight.size >= windowSize) return null
        if (!inflight.has(index)) {
          inflight.add(index)
          return index
        }
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

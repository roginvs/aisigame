/** Бинарный кусок пакета по прямому data channel (без base64). */
export const PACK_CHUNK_BINARY_TYPE = 0x01

export type BinaryPackChunk = {
  hash: string
  index: number
  total: number
  data: Uint8Array
}

export function encodePackChunkBinary(chunk: BinaryPackChunk): ArrayBuffer {
  const hashBytes = new TextEncoder().encode(chunk.hash)
  if (hashBytes.byteLength > 255) throw new Error('pack hash too long for binary frame')
  const out = new Uint8Array(1 + 4 + 4 + 1 + hashBytes.byteLength + chunk.data.byteLength)
  out[0] = PACK_CHUNK_BINARY_TYPE
  const view = new DataView(out.buffer)
  view.setUint32(1, chunk.index >>> 0)
  view.setUint32(5, chunk.total >>> 0)
  out[9] = hashBytes.byteLength
  out.set(hashBytes, 10)
  out.set(chunk.data, 10 + hashBytes.byteLength)
  return out.buffer
}

export function decodePackChunkBinary(buffer: ArrayBuffer): BinaryPackChunk | null {
  if (buffer.byteLength < 10) return null
  const bytes = new Uint8Array(buffer)
  if (bytes[0] !== PACK_CHUNK_BINARY_TYPE) return null
  const view = new DataView(buffer)
  const index = view.getUint32(1)
  const total = view.getUint32(5)
  const hashLen = bytes[9]!
  if (buffer.byteLength < 10 + hashLen) return null
  const hash = new TextDecoder().decode(bytes.subarray(10, 10 + hashLen))
  const data = bytes.subarray(10 + hashLen)
  return { hash, index, total, data }
}

/** JSON-кадр на DC: packOffer / packAck и служебные. */
export function encodePackJson(value: unknown): string {
  return JSON.stringify(value)
}

export function decodePackJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

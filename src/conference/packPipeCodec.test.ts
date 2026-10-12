import { describe, expect, it } from 'vitest'
import { decodePackChunkBinary, encodePackChunkBinary } from './packPipeCodec.ts'

describe('packPipeCodec', () => {
  it('кодирует и декодирует бинарный кусок', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const encoded = encodePackChunkBinary({
      hash: 'abc123',
      index: 7,
      total: 42,
      data,
    })
    const decoded = decodePackChunkBinary(encoded)
    expect(decoded).toEqual({
      hash: 'abc123',
      index: 7,
      total: 42,
      data,
    })
  })

  it('отбрасывает битый кадр', () => {
    expect(decodePackChunkBinary(new ArrayBuffer(3))).toBeNull()
    expect(decodePackChunkBinary(new Uint8Array([0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBeNull()
  })
})

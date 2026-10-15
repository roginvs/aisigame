import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../game/savedGame.ts'
import { decidePackGate } from './packGate.ts'
import { getPack, putPack } from './packDb.ts'

describe('decidePackGate', () => {
  it('совпадение хеша — ready, store и buzz', async () => {
    const bytes = new TextEncoder().encode('pack-bytes')
    const hash = await sha256Hex(bytes)
    expect(await decidePackGate(bytes, hash)).toEqual({ ready: true, store: true, buzz: true })
  })

  it('подменённый байт — без пакета, ready и buzz закрыты', async () => {
    const bytes = new TextEncoder().encode('pack-bytes')
    const hash = await sha256Hex(bytes)
    const bad = bytes.slice()
    bad[3] = bad[3]! ^ 0x01
    expect(await decidePackGate(bad, hash)).toEqual({ ready: false, store: false, buzz: false })
  })

  it('обрезанный хвост — то же', async () => {
    const bytes = new TextEncoder().encode('longer payload')
    const hash = await sha256Hex(bytes)
    expect(await decidePackGate(bytes.subarray(0, 4), hash)).toEqual({
      ready: false,
      store: false,
      buzz: false,
    })
  })
})

describe('packDb', () => {
  it.skipIf(typeof indexedDB === 'undefined')('put/get по hash', async () => {
    const bytes = new TextEncoder().encode('stored')
    const hash = await sha256Hex(bytes)
    await putPack(hash, bytes)
    const loaded = await getPack(hash)
    expect(loaded).toEqual(bytes)
  })
})

import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../game/savedGame.ts'
import {
  CHUNK_BYTES,
  CHUNK_WINDOW,
  base64ToBytes,
  bytesToBase64,
  chunkToWire,
  createReceiver,
  createSender,
  splitChunks,
  verifyPack,
} from './chunks.ts'

describe('splitChunks', () => {
  it('режет по CHUNK_BYTES и собирает обратно через приёмник', () => {
    const payload = new Uint8Array(CHUNK_BYTES * 2 + 100)
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
    const parts = splitChunks(payload)
    expect(parts.length).toBe(3)
    expect(parts[0]?.total).toBe(3)
    expect(parts[0]?.bytes.byteLength).toBe(CHUNK_BYTES)
    expect(parts[2]?.bytes.byteLength).toBe(100)

    const receiver = createReceiver()
    const hash = 'abc'
    for (const part of parts) {
      const wire = chunkToWire(hash, part)
      const result = receiver.push(wire)
      if (part.index < parts.length - 1) {
        expect(result.bytes).toBeNull()
        expect(result.nextIndex).toBe(part.index + 1)
      }
    }
    const last = receiver.push(chunkToWire(hash, parts[2]!))
    expect(last.nextIndex).toBe(3)
    expect(last.bytes).not.toBeNull()
    expect(last.bytes?.byteLength).toBe(payload.length)
    expect(last.bytes).toEqual(payload)
  })

  it('base64 туда-обратно', () => {
    const bytes = new Uint8Array([0, 1, 255, 42])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })
})

describe('createSender window', () => {
  it('повторяет индекс, пока ack nextIndex его не закрыл', () => {
    const payload = new Uint8Array(CHUNK_BYTES + 1)
    const parts = splitChunks(payload)
    const sender = createSender(parts, 4)
    expect(sender.nextToSend()).toBe(0)
    expect(sender.inflight.size).toBe(1)

    sender.onAck(0)
    expect(sender.nextToSend()).toBe(0)

    sender.onAck(1)
    expect(sender.nextToSend()).toBe(1)
  })

  it('окно по умолчанию — CHUNK_WINDOW кусков', () => {
    const payload = new Uint8Array(CHUNK_BYTES * (CHUNK_WINDOW + 1))
    const parts = splitChunks(payload)
    const sender = createSender(parts)
    const first: number[] = []
    for (;;) {
      const index = sender.nextToSend()
      if (index === null) break
      first.push(index)
    }
    expect(first).toEqual([...Array(CHUNK_WINDOW).keys()])
    expect(sender.inflight.size).toBe(CHUNK_WINDOW)
    expect(sender.nextToSend()).toBeNull()

    sender.onAck(2)
    // Префикс до 2 закрыт, индекс 2 тоже снят с inflight — остаётся 3…WINDOW-1.
    expect([...sender.inflight].sort((a, b) => a - b)).toEqual([...Array(CHUNK_WINDOW).keys()].slice(3))
    const after = sender.nextToSend()
    expect(after).toBe(2)
  })
})

describe('createReceiver prefix ack', () => {
  it('nextIndex — первый пропущенный в префиксе', () => {
    const payload = new Uint8Array(CHUNK_BYTES * 2 + 50)
    const parts = splitChunks(payload)
    const receiver = createReceiver()
    const hash = 'h1'
    expect(receiver.push(chunkToWire(hash, parts[0]!)).nextIndex).toBe(1)
    expect(receiver.push(chunkToWire(hash, parts[2]!)).nextIndex).toBe(1)
    expect(receiver.push(chunkToWire(hash, parts[1]!)).nextIndex).toBe(3)
  })
})

describe('verifyPack', () => {
  it('100% только при совпадении sha256', async () => {
    const bytes = new TextEncoder().encode('small pack payload')
    const hash = await sha256Hex(bytes)
    expect(await verifyPack(bytes, hash)).toEqual({ ok: true, percent: 100 })
  })

  it('длина совпала, хеш нет — ok false и percent 0', async () => {
    const bytes = new TextEncoder().encode('payload')
    const hash = await sha256Hex(bytes)
    const tampered = bytes.slice()
    tampered[0] ^= 0xff
    expect(await verifyPack(tampered, hash)).toEqual({ ok: false, percent: 0 })
    expect(await verifyPack(bytes.slice(0, 4), hash)).toEqual({ ok: false, percent: 0 })
  })

  it('expectedSize: обрезанный хвост не проходит даже при совпадении длины проверки', async () => {
    const bytes = new TextEncoder().encode('abc')
    const hash = await sha256Hex(bytes)
    expect(await verifyPack(bytes.slice(0, 2), hash, bytes.length)).toEqual({ ok: false, percent: 0 })
  })
})

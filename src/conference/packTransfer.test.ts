import { describe, expect, it } from 'vitest'
import { buildCommit } from '../buildInfo.ts'
import type { ConferenceMessage } from './messages.ts'
import { CHUNK_BYTES, createPackTransferMaster } from './packTransfer.ts'
import type { ConferenceTransport } from './transport.ts'

describe('createPackTransferMaster', () => {
  it('посылает offer каждому позднему клиенту и адресует его куски', () => {
    const messages: ConferenceMessage[] = []
    const transport: ConferenceTransport = {
      send: (message) => messages.push(message),
      subscribe: () => () => undefined,
      close: () => undefined,
    }
    const transfer = createPackTransferMaster({
      transport,
      hash: 'pack-hash',
      bytes: new Uint8Array([1, 2, 3]),
      name: 'Пакет',
      summary: 'Один раунд',
      authorityToken: 'master-token',
      targetClientIds: () => ['first'],
    })

    transfer.start()
    transfer.pumpClient('second')
    // Повторный nudge уже известному клиенту не шлёт второй offer.
    transfer.pumpClient('first')

    const offers = messages.filter((message) => message.type === 'packOffer')
    expect(offers.map((message) => message.targetClientId)).toEqual(['first', 'second'])
    expect(offers.every((message) => message.commit === buildCommit())).toBe(true)
    const chunks = messages.filter((message) => message.type === 'packChunk')
    expect(chunks.map((message) => message.targetClientId)).toEqual(['first', 'second'])
  })

  it('ACK 0 перезапускает отправку с первого куска после ошибки хеша', () => {
    const messages: ConferenceMessage[] = []
    const transport: ConferenceTransport = {
      send: (message) => messages.push(message),
      subscribe: () => () => undefined,
      close: () => undefined,
    }
    const transfer = createPackTransferMaster({
      transport,
      hash: 'pack-hash',
      bytes: new Uint8Array(CHUNK_BYTES * 5),
      name: 'Пакет',
      summary: 'Один раунд',
      authorityToken: 'master-token',
      targetClientIds: () => ['client'],
    })

    transfer.start()
    transfer.handleAck('client', 2)
    transfer.handleAck('client', 0)

    const indexes = messages
      .filter((message) => message.type === 'packChunk')
      .map((message) => message.index)
    // После ACK 0 снова уходит полное окно с нуля (здесь весь файл — 5 кусков).
    expect(indexes.slice(-5)).toEqual([0, 1, 2, 3, 4])
  })
})

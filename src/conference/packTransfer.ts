import {
  CHUNK_BYTES,
  chunkToWire,
  createReceiver,
  createSender,
  splitChunks,
  type ChunkReceiver,
  type ChunkSender,
} from './chunks.ts'
import type { ConferenceMessage, PackChunkMessage } from './messages.ts'
import type { ConferenceTransport } from './transport.ts'

export type PackTransferMaster = {
  start: () => void
  pumpClient: (clientId: string) => void
  handleAck: (clientId: string, nextIndex: number) => void
  dispose: () => void
}

export function createPackTransferMaster(input: {
  transport: ConferenceTransport
  hash: string
  bytes: Uint8Array
  name: string
  summary: string
  authorityToken: string
  targetClientIds: () => string[]
}): PackTransferMaster {
  const chunks = splitChunks(input.bytes)
  const senders = new Map<string, ChunkSender>()

  function senderFor(clientId: string): ChunkSender {
    let sender = senders.get(clientId)
    if (!sender) {
      sender = createSender(chunks)
      senders.set(clientId, sender)
    }
    return sender
  }

  function pump(clientId: string): void {
    const sender = senderFor(clientId)
    for (;;) {
      const index = sender.nextToSend()
      if (index === null) break
      const chunk = chunks[index]
      if (!chunk) break
      const wire = chunkToWire(input.hash, chunk)
      const message: PackChunkMessage = {
        type: 'packChunk',
        targetClientId: clientId,
        authorityToken: input.authorityToken,
        ...wire,
      }
      input.transport.send(message)
    }
  }

  function offer(clientId: string): void {
    input.transport.send({
      type: 'packOffer',
      authorityToken: input.authorityToken,
      targetClientId: clientId,
      hash: input.hash,
      size: input.bytes.byteLength,
      name: input.name,
      summary: input.summary,
    })
  }

  function pumpForClient(clientId: string): void {
    offer(clientId)
    pump(clientId)
  }

  return {
    start() {
      for (const clientId of input.targetClientIds()) pumpForClient(clientId)
    },
    pumpClient(clientId: string) {
      pumpForClient(clientId)
    },
    handleAck(clientId: string, nextIndex: number) {
      // ACK 0 is also an explicit request to restart after a missing/corrupt
      // cache or a failed final hash check. createSender intentionally never
      // rewinds its acknowledged prefix, so replace it here.
      if (nextIndex === 0) senders.set(clientId, createSender(chunks))
      const sender = senderFor(clientId)
      sender.onAck(nextIndex)
      pump(clientId)
    },
    dispose() {
      senders.clear()
    },
  }
}

export type PackReceiveState = {
  hash: string
  expectedSize: number
  name: string
  summary: string
  percent: number
  nextIndex: number
  bytes: Uint8Array | null
  hashOk: boolean
}

export function createPackReceiver(onProgress: (percent: number) => void): {
  state: () => PackReceiveState | null
  handle: (message: ConferenceMessage) => PackAck | null
  restart: () => void
  setTamperFirstByte: (value: boolean) => void
} {
  let offer: PackReceiveState | null = null
  let receiver: ChunkReceiver = createReceiver()
  let tamperFirstByte = false

  return {
    state: () => offer,
    setTamperFirstByte: (value: boolean) => {
      tamperFirstByte = value
    },
    restart: () => {
      receiver = createReceiver()
      if (offer) offer = { ...offer, percent: 0, nextIndex: 0, bytes: null, hashOk: false }
      onProgress(0)
    },
    handle(message) {
      if (message.type === 'packOffer') {
        if (
          offer?.hash === message.hash &&
          offer.expectedSize === message.size &&
          offer.name === message.name
        ) {
          return null
        }
        receiver = createReceiver()
        offer = {
          hash: message.hash,
          expectedSize: message.size,
          name: message.name,
          summary: message.summary,
          percent: 0,
          nextIndex: 0,
          bytes: null,
          hashOk: false,
        }
        return null
      }
      if (message.type !== 'packChunk' || !offer || message.hash !== offer.hash) return null
      const { nextIndex, bytes } = receiver.push(message)
      const total = message.total || 1
      const pct = Math.min(99, Math.floor((nextIndex / total) * 100))
      offer = { ...offer, percent: pct, nextIndex }
      onProgress(pct)
      if (!bytes) {
        return { hash: offer.hash, nextIndex }
      }
      if (tamperFirstByte && bytes.length > 0) {
        bytes[0] ^= 0xff
      }
      offer = { ...offer, bytes, percent: 100, nextIndex }
      return { hash: offer.hash, nextIndex, bytes }
    },
  }
}

export type PackAck = { hash: string; nextIndex: number; bytes?: Uint8Array }

export { CHUNK_BYTES }

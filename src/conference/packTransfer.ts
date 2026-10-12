import { buildCommit } from '../buildInfo.ts'
import {
  CHUNK_BYTES,
  chunkToWire,
  createReceiver,
  createSender,
  splitChunks,
  type ChunkReceiver,
  type ChunkSender,
  type SplitChunk,
} from './chunks.ts'
import type { ConferenceMessage, PackChunkMessage, PackOfferMessage } from './messages.ts'
import type { ConferenceTransport } from './transport.ts'

/** Прямой data channel: куски без Jitsi Bridge. */
export type PackClientPipe = {
  ready: (clientId: string) => boolean
  canSend: (clientId: string) => boolean
  sendOffer: (clientId: string, message: PackOfferMessage) => boolean
  sendChunk: (clientId: string, hash: string, index: number, total: number, data: Uint8Array) => boolean
}

export type PackTransferMaster = {
  start: () => void
  /** Новый endpoint того же клиента: прежние offer/ACK больше не относятся к его странице. */
  resetClient: (clientId: string) => void
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
  /** Если задан — packOffer/packChunk только по DC, когда канал открыт. */
  pipe?: PackClientPipe
}): PackTransferMaster {
  const chunks = splitChunks(input.bytes)
  const senders = new Map<string, ChunkSender>()
  const offered = new Set<string>()

  function senderFor(clientId: string): ChunkSender {
    let sender = senders.get(clientId)
    if (!sender) {
      sender = createSender(chunks)
      senders.set(clientId, sender)
    }
    return sender
  }

  function buildOffer(clientId: string): PackOfferMessage {
    return {
      type: 'packOffer',
      authorityToken: input.authorityToken,
      targetClientId: clientId,
      commit: buildCommit(),
      hash: input.hash,
      size: input.bytes.byteLength,
      name: input.name,
      summary: input.summary,
    }
  }

  function offerViaTransport(clientId: string): void {
    input.transport.send(buildOffer(clientId))
    offered.add(clientId)
  }

  function offerViaPipe(clientId: string): boolean {
    if (!input.pipe?.ready(clientId)) return false
    const ok = input.pipe.sendOffer(clientId, buildOffer(clientId))
    if (ok) offered.add(clientId)
    return ok
  }

  function sendChunkWire(clientId: string, chunk: SplitChunk): boolean {
    if (input.pipe) {
      if (!input.pipe.ready(clientId)) return false
      return input.pipe.sendChunk(clientId, input.hash, chunk.index, chunk.total, chunk.bytes)
    }
    const wire = chunkToWire(input.hash, chunk)
    const message: PackChunkMessage = {
      type: 'packChunk',
      targetClientId: clientId,
      authorityToken: input.authorityToken,
      ...wire,
    }
    input.transport.send(message)
    return true
  }

  function pump(clientId: string): void {
    if (input.pipe && !input.pipe.ready(clientId)) return
    if (!offered.has(clientId)) {
      if (input.pipe) {
        if (!input.pipe.canSend(clientId) || !offerViaPipe(clientId)) return
      } else {
        offerViaTransport(clientId)
      }
    }
    const sender = senderFor(clientId)
    for (;;) {
      if (input.pipe && !input.pipe.canSend(clientId)) break
      const index = sender.nextToSend()
      if (index === null) break
      const chunk = chunks[index]
      if (!chunk) break
      if (!sendChunkWire(clientId, chunk)) break
    }
  }

  function pumpForClient(clientId: string): void {
    if (input.pipe && !input.pipe.ready(clientId)) return
    offered.delete(clientId)
    if (input.pipe) {
      if (!offerViaPipe(clientId)) return
    } else {
      offerViaTransport(clientId)
    }
    pump(clientId)
  }

  return {
    resetClient(clientId) {
      senders.delete(clientId)
      offered.delete(clientId)
    },
    start() {
      for (const clientId of input.targetClientIds()) pumpForClient(clientId)
    },
    /** Первому контакту — offer+окно; повторному hello — только дозаполнить окно, без нового флода. */
    pumpClient(clientId: string) {
      if (!senders.has(clientId)) {
        pumpForClient(clientId)
        return
      }
      pump(clientId)
    },
    handleAck(clientId: string, nextIndex: number) {
      // ACK 0 is also an explicit request to restart after a missing/corrupt
      // cache or a failed final hash check. createSender intentionally never
      // rewinds its acknowledged prefix, so replace it here.
      if (nextIndex === 0) {
        senders.set(clientId, createSender(chunks))
        offered.delete(clientId)
      }
      const sender = senderFor(clientId)
      sender.onAck(nextIndex)
      pump(clientId)
    },
    dispose() {
      senders.clear()
      offered.clear()
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
  handleBinaryChunk: (chunk: { hash: string; index: number; total: number; data: Uint8Array }) => PackAck | null
  restart: () => void
  setTamperFirstByte: (value: boolean) => void
} {
  let offer: PackReceiveState | null = null
  let receiver: ChunkReceiver = createReceiver()
  let tamperFirstByte = false

  function afterPush(nextIndex: number, bytes: Uint8Array | null, total: number): PackAck | null {
    if (!offer) return null
    const pct = Math.min(99, Math.floor((nextIndex / (total || 1)) * 100))
    offer = { ...offer, percent: pct, nextIndex }
    onProgress(pct)
    if (!bytes) return { hash: offer.hash, nextIndex }
    if (tamperFirstByte && bytes.length > 0) bytes[0] ^= 0xff
    offer = { ...offer, bytes, percent: 100, nextIndex }
    return { hash: offer.hash, nextIndex, bytes }
  }

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
      return afterPush(nextIndex, bytes, message.total)
    },
    handleBinaryChunk(chunk) {
      if (!offer || chunk.hash !== offer.hash) return null
      const { nextIndex, bytes } = receiver.push({
        hash: chunk.hash,
        index: chunk.index,
        total: chunk.total,
        dataBytes: chunk.data,
      })
      return afterPush(nextIndex, bytes, chunk.total)
    },
  }
}

export type PackAck = { hash: string; nextIndex: number; bytes?: Uint8Array }

export { CHUNK_BYTES }

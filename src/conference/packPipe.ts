import { decodePackChunkBinary, decodePackJson, encodePackChunkBinary, encodePackJson } from './packPipeCodec.ts'
import type {
  ConferenceMessage,
  PackAckMessage,
  PackChunkMessage,
  PackOfferMessage,
  PackPipeAnswerMessage,
  PackPipeIceMessage,
  PackPipeOfferMessage,
} from './messages.ts'
import { isConferenceMessage } from './messages.ts'
import { PACK_CHANNEL_HIGH_WATER_BYTES, PACK_CHANNEL_LOW_WATER_BYTES } from './chunks.ts'

const PACK_DC_LABEL = 'aisigame-pack'
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export type PackPipeLinkState = 'idle' | 'connecting' | 'open' | 'failed' | 'closed'

export type PackPipeInbound =
  | { kind: 'offer'; message: PackOfferMessage }
  | { kind: 'chunk'; message: PackChunkMessage }
  | { kind: 'binaryChunk'; hash: string; index: number; total: number; data: Uint8Array }
  | { kind: 'ack'; message: PackAckMessage }

type SignalSend = (message: ConferenceMessage) => void

function iceInit(candidate: RTCIceCandidate | null): RTCIceCandidateInit | null {
  if (!candidate) return null
  return candidate.toJSON()
}

function applyIce(pc: RTCPeerConnection, init: RTCIceCandidateInit | null): Promise<void> {
  if (!init) return Promise.resolve()
  return pc.addIceCandidate(init).catch(() => undefined)
}

/** Мастер: по одному RTCPeerConnection + data channel на каждого joiner. */
export function createPackPipeHub(input: {
  authorityToken: string
  sendSignal: SignalSend
  onOpen: (clientId: string) => void
  onInbound: (clientId: string, inbound: PackPipeInbound) => void
  onState: (clientId: string, state: PackPipeLinkState) => void
}): {
  ensure: (clientId: string) => void
  /** Закрывает peer прежнего endpoint; следующий ensure создаёт новый. */
  reset: (clientId: string) => void
  ready: (clientId: string) => boolean
  /** Канал открыт и bufferedAmount не выше high-water. */
  canSend: (clientId: string) => boolean
  sendOffer: (clientId: string, message: PackOfferMessage) => boolean
  sendChunk: (clientId: string, hash: string, index: number, total: number, data: Uint8Array) => boolean
  handleSignal: (message: ConferenceMessage, fromClientId: string) => void
  state: (clientId: string) => PackPipeLinkState
  dispose: () => void
} {
  type Peer = {
    pc: RTCPeerConnection
    dc: RTCDataChannel | null
    state: PackPipeLinkState
    makingOffer: boolean
  }
  const peers = new Map<string, Peer>()

  function setState(clientId: string, state: PackPipeLinkState): void {
    const peer = peers.get(clientId)
    if (!peer || peer.state === state) return
    peer.state = state
    input.onState(clientId, state)
  }

  function wireChannel(clientId: string, peer: Peer, dc: RTCDataChannel): void {
    peer.dc = dc
    try {
      dc.bufferedAmountLowThreshold = PACK_CHANNEL_LOW_WATER_BYTES
    } catch {
      // ignore
    }
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => {
      if (peers.get(clientId) !== peer || peer.dc !== dc) return
      setState(clientId, 'open')
      input.onOpen(clientId)
    }
    dc.onbufferedamountlow = () => {
      if (peers.get(clientId) !== peer || peer.dc !== dc) return
      if (dc.readyState === 'open') input.onOpen(clientId)
    }
    dc.onclose = () => {
      if (peers.get(clientId) === peer && peer.dc === dc) setState(clientId, 'closed')
    }
    dc.onerror = () => {
      if (peers.get(clientId) === peer && peer.dc === dc) setState(clientId, 'failed')
    }
    dc.onmessage = (event) => {
      if (peers.get(clientId) !== peer || peer.dc !== dc) return
      const inbound = parseInbound(event.data)
      if (inbound) input.onInbound(clientId, inbound)
    }
  }

  async function startOffer(clientId: string, peer: Peer): Promise<void> {
    if (peer.makingOffer) return
    peer.makingOffer = true
    setState(clientId, 'connecting')
    try {
      const dc = peer.pc.createDataChannel(PACK_DC_LABEL, { ordered: true })
      wireChannel(clientId, peer, dc)
      const offer = await peer.pc.createOffer()
      if (peers.get(clientId) !== peer) return
      await peer.pc.setLocalDescription(offer)
      if (peers.get(clientId) !== peer) return
      const sdp = peer.pc.localDescription?.sdp
      if (!sdp) return
      const message: PackPipeOfferMessage = {
        type: 'packPipeOffer',
        authorityToken: input.authorityToken,
        targetClientId: clientId,
        sdp,
      }
      input.sendSignal(message)
    } catch {
      if (peers.get(clientId) === peer) setState(clientId, 'failed')
    } finally {
      peer.makingOffer = false
    }
  }

  function reset(clientId: string): void {
    const peer = peers.get(clientId)
    if (!peer) return
    // Сначала убираем из карты: поздние callbacks/offer старого peer не должны
    // менять новый канал или подтверждать пакет перезагруженной страницы.
    peers.delete(clientId)
    peer.dc?.close()
    peer.pc.close()
  }

  function ensure(clientId: string): void {
    if (peers.has(clientId)) {
      const existing = peers.get(clientId)!
      if (existing.state === 'failed' || existing.state === 'closed') {
        reset(clientId)
      } else {
        return
      }
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const peer: Peer = { pc, dc: null, state: 'idle', makingOffer: false }
    peers.set(clientId, peer)
    setState(clientId, 'connecting')
    pc.onicecandidate = (event) => {
      if (peers.get(clientId) !== peer) return
      const message: PackPipeIceMessage = {
        type: 'packPipeIce',
        authorityToken: input.authorityToken,
        targetClientId: clientId,
        candidate: iceInit(event.candidate),
      }
      input.sendSignal(message)
    }
    pc.onconnectionstatechange = () => {
      if (peers.get(clientId) !== peer) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (peer.state !== 'open') setState(clientId, 'failed')
      }
    }
    void startOffer(clientId, peer)
  }

  function handleSignal(message: ConferenceMessage, fromClientId: string): void {
    if (message.type === 'packPipeAnswer') {
      const peer = peers.get(fromClientId)
      if (!peer) return
      void peer.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp }).catch(() => {
        if (peers.get(fromClientId) === peer) setState(fromClientId, 'failed')
      })
      return
    }
    if (message.type === 'packPipeIce') {
      const peer = peers.get(fromClientId)
      if (!peer) return
      void applyIce(peer.pc, message.candidate)
    }
  }

  function openChannel(clientId: string): RTCDataChannel | null {
    const peer = peers.get(clientId)
    if (!peer?.dc || peer.dc.readyState !== 'open') return null
    return peer.dc
  }

  function canSend(clientId: string): boolean {
    const dc = openChannel(clientId)
    return Boolean(dc && dc.bufferedAmount <= PACK_CHANNEL_HIGH_WATER_BYTES)
  }

  function sendOffer(clientId: string, message: PackOfferMessage): boolean {
    const dc = openChannel(clientId)
    if (!dc || dc.bufferedAmount > PACK_CHANNEL_HIGH_WATER_BYTES) return false
    dc.send(encodePackJson(message))
    return true
  }

  function sendChunk(
    clientId: string,
    hash: string,
    index: number,
    total: number,
    data: Uint8Array,
  ): boolean {
    const dc = openChannel(clientId)
    if (!dc || dc.bufferedAmount > PACK_CHANNEL_HIGH_WATER_BYTES) return false
    dc.send(encodePackChunkBinary({ hash, index, total, data }))
    return true
  }

  return {
    ensure,
    reset,
    ready: (clientId) => openChannel(clientId) !== null,
    canSend,
    sendOffer,
    sendChunk,
    handleSignal,
    state: (clientId) => peers.get(clientId)?.state ?? 'idle',
    dispose() {
      for (const clientId of peers.keys()) reset(clientId)
    },
  }
}

/** Joiner: один peer к мастеру; ответ на offer и ICE через Jitsi. */
export function createPackPipeJoiner(input: {
  clientId: string
  authToken: string
  sendSignal: SignalSend
  onInbound: (inbound: PackPipeInbound) => void
  onState: (state: PackPipeLinkState) => void
  onOpen: () => void
}): {
  handleSignal: (message: ConferenceMessage) => void
  sendAck: (message: PackAckMessage) => boolean
  state: () => PackPipeLinkState
  dispose: () => void
} {
  let pc: RTCPeerConnection | null = null
  let dc: RTCDataChannel | null = null
  let state: PackPipeLinkState = 'idle'

  function setState(next: PackPipeLinkState): void {
    if (state === next) return
    state = next
    input.onState(next)
  }

  function wireChannel(channel: RTCDataChannel): void {
    dc = channel
    channel.binaryType = 'arraybuffer'
    channel.onopen = () => {
      setState('open')
      input.onOpen()
    }
    channel.onclose = () => setState('closed')
    channel.onerror = () => setState('failed')
    channel.onmessage = (event) => {
      const inbound = parseInbound(event.data)
      if (inbound) input.onInbound(inbound)
    }
  }

  function ensurePc(): RTCPeerConnection {
    if (pc) return pc
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    setState('connecting')
    pc.onicecandidate = (event) => {
      const message: PackPipeIceMessage = {
        type: 'packPipeIce',
        clientId: input.clientId,
        authToken: input.authToken,
        candidate: iceInit(event.candidate),
      }
      input.sendSignal(message)
    }
    pc.ondatachannel = (event) => {
      if (event.channel.label !== PACK_DC_LABEL) return
      wireChannel(event.channel)
    }
    pc.onconnectionstatechange = () => {
      if (!pc) return
      if (pc.connectionState === 'failed') setState('failed')
    }
    return pc
  }

  async function handleOffer(message: PackPipeOfferMessage): Promise<void> {
    const peer = ensurePc()
    // Уже открытый DC: повторный offer не мигает «Устанавливаю соединение».
    if (state !== 'open') setState('connecting')
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp })
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      const sdp = peer.localDescription?.sdp
      if (!sdp) return
      const reply: PackPipeAnswerMessage = {
        type: 'packPipeAnswer',
        clientId: input.clientId,
        authToken: input.authToken,
        sdp,
      }
      input.sendSignal(reply)
    } catch {
      setState('failed')
    }
  }

  function handleSignal(message: ConferenceMessage): void {
    if (message.type === 'packPipeOffer') {
      void handleOffer(message)
      return
    }
    if (message.type === 'packPipeIce') {
      if (!pc) return
      void applyIce(pc, message.candidate)
    }
  }

  function sendAck(message: PackAckMessage): boolean {
    if (!dc || dc.readyState !== 'open') return false
    dc.send(encodePackJson(message))
    return true
  }

  return {
    handleSignal,
    sendAck,
    state: () => state,
    dispose() {
      dc?.close()
      pc?.close()
      dc = null
      pc = null
      setState('closed')
    },
  }
}

function parseInbound(data: unknown): PackPipeInbound | null {
  if (typeof data === 'string') {
    try {
      const value = decodePackJson(data)
      if (!isConferenceMessage(value)) return null
      if (value.type === 'packOffer') return { kind: 'offer', message: value }
      if (value.type === 'packAck') return { kind: 'ack', message: value }
      if (value.type === 'packChunk') return { kind: 'chunk', message: value }
    } catch {
      return null
    }
    return null
  }
  let buffer: ArrayBuffer | null = null
  if (data instanceof ArrayBuffer) buffer = data
  else if (ArrayBuffer.isView(data)) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  if (!buffer) return null
  const decoded = decodePackChunkBinary(buffer)
  if (!decoded) return null
  return {
    kind: 'binaryChunk',
    hash: decoded.hash,
    index: decoded.index,
    total: decoded.total,
    data: decoded.data,
  }
}

import { masterBuildMismatchMessage } from './buildMatch.ts'
import { decidePackGate } from './packGate.ts'
import { deletePack, getPack, putPack } from './packDb.ts'
import type { ConferenceMessage, ConferenceSnapshot, PackOfferMessage } from './messages.ts'
import { CHUNK_BYTES, createPackReceiver } from './packTransfer.ts'
import type { ConferenceTransport } from './transport.ts'
import { PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from './presence.ts'
import { sharedDebugBacklogCursor, sharedDebugBatch } from '../debug/trace.ts'

export type JoinerSessionCallbacks = {
  onSnapshot: (snapshot: ConferenceSnapshot) => void
  onLobby: (state: JoinerLobbyState) => void
  onPackReady: (bytes: Uint8Array, hash: string) => void | Promise<void>
  onError: (message: string) => void
  /** Чужой commit мастера: joiner не продолжает, App рвёт комнату. */
  onFatalError: (message: string) => void
}

export type JoinerLobbyState = {
  waitingMaster: boolean
  masterOffline: boolean
  percent: number
  hashOk: boolean
  readySent: boolean
  packName: string
  rosterNames: string[]
}

export type JoinerPackCache = {
  get: (hash: string) => Promise<Uint8Array | null>
  put: (hash: string, bytes: Uint8Array) => Promise<void>
  delete: (hash: string) => Promise<void>
}

const defaultPackCache: JoinerPackCache = {
  get: getPack,
  put: putPack,
  delete: deletePack,
}

export class JoinerSession {
  private transport: ConferenceTransport
  private clientId: string
  private authToken: string
  private name: string
  private callbacks: JoinerSessionCallbacks
  private unsub: () => void
  private heartbeatTimer = 0
  private debugTimer = 0
  private debugCursor = sharedDebugBacklogCursor()
  private disposed = false
  private messageQueue: Promise<void> = Promise.resolve()
  private packCache: JoinerPackCache
  private packReceiver = createPackReceiver((percent) => {
    this.lobbyPercent = percent
    this.emitLobby()
  })
  private lobbyPercent = 0
  private hashOk = false
  private readySent = false
  private readyRequested = false
  private gameStarted = false
  private waitingMaster = true
  private masterOffline = false
  private packName = ''
  private lastSnapshot: ConferenceSnapshot | null = null
  /** Любой трафик от мастера (снимок, offer, chunk) — признак, что он жив. */
  private lastMasterAliveAt: number | null = null
  private activeOfferKey = ''
  private readyPackHash: string | null = null
  private masterAuthorityToken: string | null = null
  private masterSenderId: string | null = null
  private buildRejected = false
  constructor(input: {
    transport: ConferenceTransport
    clientId: string
    authToken: string
    name: string
    callbacks: JoinerSessionCallbacks
    packCache?: JoinerPackCache
  }) {
    this.transport = input.transport
    this.clientId = input.clientId
    this.authToken = input.authToken
    this.name = input.name
    this.callbacks = input.callbacks
    this.packCache = input.packCache ?? defaultPackCache
    this.unsub = this.transport.subscribe((message, senderId) => {
      this.messageQueue = this.messageQueue
        .then(() => (this.disposed ? undefined : this.onMessage(message, senderId)))
        .catch((error: unknown) => {
          if (this.disposed) return
          const detail = error instanceof Error ? error.message : String(error)
          this.callbacks.onError(`Не удалось принять пакет: ${detail}`)
        })
    })
    this.sendHello()
    this.heartbeatTimer = window.setInterval(() => {
      this.sendHello()
      const offline =
        this.lastMasterAliveAt !== null && Date.now() - this.lastMasterAliveAt >= PRESENCE_STALE_MS
      if (offline !== this.masterOffline) {
        this.masterOffline = offline
        this.emitLobby()
      }
    }, PRESENCE_HEARTBEAT_MS)
    this.debugTimer = window.setInterval(() => this.sendDebugBatch(), 2_000)
    this.emitLobby()
  }

  setTamperPack(value: boolean): void {
    this.packReceiver.setTamperFirstByte(value)
  }

  sendReady(): void {
    this.readyRequested = true
    if (!this.hashOk || this.readySent) return
    this.readySent = true
    this.transport.send({ type: 'ready', clientId: this.clientId, authToken: this.authToken })
    this.emitLobby()
  }

  sendBuzz(): void {
    if (!this.hashOk) return
    this.transport.send({ type: 'buzz', clientId: this.clientId, authToken: this.authToken })
  }

  sendPick(themeId: string, value: number): void {
    if (!this.hashOk) return
    this.transport.send({ type: 'pick', clientId: this.clientId, authToken: this.authToken, themeId, value })
  }

  sendChat(text: string): void {
    const clean = text.trim()
    if (!clean) return
    this.transport.send({ type: 'chat', clientId: this.clientId, authToken: this.authToken, text: clean })
  }

  dispose(): void {
    this.disposed = true
    window.clearInterval(this.heartbeatTimer)
    window.clearInterval(this.debugTimer)
    this.unsub()
    this.transport.close()
  }

  snapshot(): ConferenceSnapshot | null {
    return this.lastSnapshot
  }

  private emitLobby(): void {
    this.callbacks.onLobby({
      waitingMaster: this.waitingMaster,
      masterOffline: this.masterOffline,
      percent: this.lobbyPercent,
      hashOk: this.hashOk,
      readySent: this.readySent,
      packName: this.packName,
      rosterNames: this.lastSnapshot?.presence.filter((entry) => !entry.hidden).map((entry) => entry.name) ?? [],
    })
  }

  private async onMessage(message: ConferenceMessage, senderId: string): Promise<void> {
    if (this.buildRejected || this.disposed) return
    if (
      (message.type === 'packOffer' || message.type === 'packChunk') &&
      message.targetClientId &&
      message.targetClientId !== this.clientId
    ) {
      return
    }
    if (message.type === 'snapshot' || message.type === 'packOffer') {
      if (!this.acceptMaster(message.authorityToken, senderId, true)) return
      if (!this.acceptMasterBuild(message.commit)) return
    } else if (message.type === 'packChunk') {
      if (!this.acceptMaster(message.authorityToken, senderId, false)) return
    } else {
      return
    }
    if (message.type === 'snapshot') {
      this.noteMasterAlive()
      this.lastSnapshot = message
      this.gameStarted = message.phase !== 'lobby'
      this.callbacks.onSnapshot(message)
      if (this.gameStarted) this.sendReady()
      this.emitLobby()
      return
    }
    if (message.type === 'packOffer') {
      this.noteMasterAlive()
      await this.handlePackOffer(message)
      return
    }
    if (message.type === 'packChunk') {
      this.noteMasterAlive()
      if (this.readyPackHash === message.hash) {
        this.sendPackAck(message.hash, message.total)
        return
      }
      const ack = this.packReceiver.handle(message)
      if (ack) {
        this.sendPackAck(ack.hash, ack.nextIndex)
        if (ack.bytes) {
          const offer = this.packReceiver.state()
          if (offer) {
            const gate = await decidePackGate(ack.bytes, offer.hash, offer.expectedSize)
            if (gate.ready) {
              await this.acceptPack(ack.bytes, offer.hash, gate.store)
              this.sendPackAck(offer.hash, ack.nextIndex)
            } else {
              this.hashOk = false
              this.readySent = false
              this.readyPackHash = null
              this.callbacks.onError('Пакет повредился при передаче. Загружаем заново.')
              this.packReceiver.restart()
              await this.deleteCachedPack(offer.hash)
              this.sendPackAck(offer.hash, 0)
            }
          }
        }
        this.emitLobby()
      }
    }
  }

  private async handlePackOffer(message: PackOfferMessage): Promise<void> {
    const offerKey = `${message.hash}:${message.size}`
    this.packName = message.name

    if (this.readyPackHash === message.hash && this.hashOk) {
      this.sendPackAck(message.hash, this.chunkCount(message.size))
      this.sendPackVerified(message.hash)
      // Новый мастер после перезагрузки ещё не знает прежний ready. Повторяем
      // его в ответ на offer, не заставляя игрока возвращаться в лобби.
      if (this.readyRequested || this.gameStarted) {
        this.transport.send({ type: 'ready', clientId: this.clientId, authToken: this.authToken })
      }
      this.emitLobby()
      return
    }

    if (offerKey === this.activeOfferKey) {
      const nextIndex = this.packReceiver.state()?.nextIndex ?? 0
      this.sendPackAck(message.hash, nextIndex)
      return
    }

    this.activeOfferKey = offerKey
    this.lobbyPercent = 0
    this.hashOk = false
    this.readySent = false
    this.readyPackHash = null
    this.packReceiver.handle(message)
    this.emitLobby()

    let cached: Uint8Array | null = null
    try {
      cached = await this.packCache.get(message.hash)
    } catch {
      // IndexedDB can be unavailable in private/restricted browser contexts.
      // The wire transfer remains the source of truth in that case.
    }
    if (this.disposed) return

    if (cached) {
      const gate = await decidePackGate(cached, message.hash, message.size)
      if (gate.ready) {
        await this.acceptPack(cached, message.hash, false)
        this.sendPackAck(message.hash, this.chunkCount(message.size))
        this.emitLobby()
        return
      }
      await this.deleteCachedPack(message.hash)
    }

    // ACK 0 doubles as an explicit request/restart. This also makes late join
    // work when the master's first automatic chunk window was missed.
    this.packReceiver.restart()
    this.sendPackAck(message.hash, 0)
    this.emitLobby()
  }

  private async acceptPack(bytes: Uint8Array, hash: string, store: boolean): Promise<void> {
    if (this.readyPackHash === hash && this.hashOk) return
    try {
      // Await parsing/application before enabling Ready/Buzz. It also makes a
      // repeated offer unable to start a second parse concurrently.
      await this.callbacks.onPackReady(bytes, hash)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      this.callbacks.onError(`Не удалось открыть пакет: ${detail}`)
      this.hashOk = false
      this.readySent = false
      return
    }
    if (this.disposed) return
    this.readyPackHash = hash
    this.hashOk = true
    this.lobbyPercent = 100
    this.sendPackVerified(hash)
    if (this.readyRequested || this.gameStarted) this.sendReady()
    if (store) {
      try {
        await this.packCache.put(hash, bytes)
      } catch {
        // A full IndexedDB does not invalidate already parsed, verified bytes.
      }
    }
  }

  private async deleteCachedPack(hash: string): Promise<void> {
    try {
      await this.packCache.delete(hash)
    } catch {
      // Cache cleanup is best-effort; ACK 0 still requests clean bytes.
    }
  }

  private chunkCount(size: number): number {
    return size === 0 ? 1 : Math.ceil(size / CHUNK_BYTES)
  }

  private sendPackAck(hash: string, nextIndex: number): void {
    this.transport.send({ type: 'packAck', clientId: this.clientId, authToken: this.authToken, hash, nextIndex })
  }

  private sendHello(): void {
    this.transport.send({
      type: 'hello',
      clientId: this.clientId,
      authToken: this.authToken,
      name: this.name,
    })
  }

  private sendPackVerified(hash: string): void {
    this.transport.send(this.packVerifiedMessage(hash))
  }

  private packVerifiedMessage(hash: string) {
    return {
      type: 'packVerified' as const,
      clientId: this.clientId,
      authToken: this.authToken,
      hash,
    }
  }

  private sendDebugBatch(): void {
    if (this.disposed) return
    const batch = sharedDebugBatch(this.debugCursor)
    if (batch.entries.length === 0) return
    this.transport.send({
      type: 'debugLog',
      clientId: this.clientId,
      authToken: this.authToken,
      entries: batch.entries,
    })
    this.debugCursor = batch.lastId
  }

  private noteMasterAlive(): void {
    this.waitingMaster = false
    this.masterOffline = false
    this.lastMasterAliveAt = Date.now()
  }

  private acceptMasterBuild(masterCommit: string | undefined): boolean {
    if (this.buildRejected) return false
    const mismatch = masterBuildMismatchMessage(masterCommit)
    if (!mismatch) return true
    this.buildRejected = true
    this.callbacks.onFatalError(mismatch)
    this.dispose()
    return false
  }

  private acceptMaster(authorityToken: string, senderId: string, canRebind: boolean): boolean {
    if (!senderId) return false
    if (this.masterAuthorityToken === null) {
      this.masterAuthorityToken = authorityToken
      this.masterSenderId = senderId
      return true
    }
    if (this.masterAuthorityToken !== authorityToken) return false
    if (this.masterSenderId === senderId) return true
    if (!canRebind) return false
    this.masterSenderId = senderId
    // После перезагрузки у мастера новый Jitsi endpoint и пустая таблица
    // привязок. Старые ready/hello нельзя считать доставленными ему.
    this.readySent = false
    this.sendHello()
    return true
  }
}

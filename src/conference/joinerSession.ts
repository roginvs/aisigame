import { createDiagSummary } from '../debug/diag.ts'
import type { AppealRequest } from '../game/types.ts'
import { masterBuildMismatchMessage } from './buildMatch.ts'
import { decidePackGate } from './packGate.ts'
import { deletePack, getPack, putPack } from './packDb.ts'
import { type ConferenceMessage, type ConferenceSnapshot, type ConferenceState, type PackOfferMessage } from './messages.ts'
import { snapshotFromState } from './stateProtocol.ts'
import { ReceivedState } from './receivedState.ts'
import { createPackPipeJoiner, type PackPipeInbound } from './packPipe.ts'
import { derivePackPhase, type PackPhase } from './packProgress.ts'
import { CHUNK_BYTES, createPackReceiver } from './packTransfer.ts'
import type { ConferenceTransport } from './transport.ts'
import { PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from './presence.ts'
import { pushTrace, sharedDebugBacklogCursor, sharedDebugBatch } from '../debug/trace.ts'
import { buildCommit } from '../buildInfo.ts'

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
  packPhase: PackPhase
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
  private appealRequests = new Map<string, AppealRequest>()
  private appealPending = new Map<string, { finish: (value: { accepted: boolean; reason: string }) => void; timer: number }>()
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
  private masterState: ConferenceState | null = null
  private readonly received = new ReceivedState()
  private waitingStatus = true
  /** Любой трафик от мастера (снимок, offer, chunk) — признак, что он жив. */
  private lastMasterAliveAt: number | null = null
  private activeOfferKey = ''
  private statePackSenderId: string | null = null
  private readyPackHash: string | null = null
  private masterAuthorityToken: string | null = null
  private masterSenderId: string | null = null
  private buildRejected = false
  private usePackPipe = false
  private packPipe: ReturnType<typeof createPackPipeJoiner> | null = null
  private pipeState: PackPhase | 'idle' | 'open' | 'closed' = 'idle'
  /** Последняя отданная UI фаза — чтобы flap pipe не откатывал «Загрузка» в connecting. */
  private lastPackPhase: PackPhase = 'waiting'
  constructor(input: {
    transport: ConferenceTransport
    clientId: string
    authToken: string
    name: string
    callbacks: JoinerSessionCallbacks
    packCache?: JoinerPackCache
    /** Прямой data channel для пакета; Jitsi — только сигнализация. */
    usePackPipe?: boolean
  }) {
    this.transport = input.transport
    this.clientId = input.clientId
    this.authToken = input.authToken
    this.name = input.name
    this.callbacks = input.callbacks
    this.packCache = input.packCache ?? defaultPackCache
    this.usePackPipe = input.usePackPipe === true
    if (this.usePackPipe) {
      this.pipeState = 'connecting'
      this.packPipe = createPackPipeJoiner({
        clientId: this.clientId,
        authToken: this.authToken,
        sendSignal: (message) => this.transport.send(message),
        onOpen: () => {
          this.pipeState = 'open'
          this.noteMasterAlive()
          this.emitLobby()
        },
        onState: (state) => {
          this.pipeState = state
          this.emitLobby()
        },
        onInbound: (inbound) => {
          this.messageQueue = this.messageQueue
            .then(() => (this.disposed ? undefined : this.onPipeInbound(inbound)))
            .catch((error: unknown) => {
              if (this.disposed) return
              const detail = error instanceof Error ? error.message : String(error)
              this.callbacks.onError(`Не удалось принять пакет: ${detail}`)
            })
        },
      })
    }
    this.unsub = this.transport.subscribe((message, senderId) => {
      // Ping отвечаем сразу, мимо очереди: иначе RTT включает время, пока очередь
      // ждёт проверку пакета (реальный sha256), и pong опаздывает или теряется.
      if (message.type === 'ping') {
        if (!this.disposed && !this.buildRejected) this.answerPing(message, senderId)
        return
      }
      this.messageQueue = this.messageQueue
        .then(() => (this.disposed ? undefined : this.onMessage(message, senderId)))
        .catch((error: unknown) => {
          if (this.disposed) return
          const detail = error instanceof Error ? error.message : String(error)
          this.callbacks.onError(`Не удалось принять пакет: ${detail}`)
        })
    })
    this.sendHello()
    this.requestStatus()
    this.heartbeatTimer = window.setInterval(() => {
      this.sendHello()
      if (this.waitingStatus) this.requestStatus()
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

  sendAppeal(request: AppealRequest): Promise<{ accepted: boolean; reason: string }> {
    if (this.disposed) return Promise.resolve({ accepted: false, reason: 'Нет связи с мастером' })
    return new Promise((finish) => {
      const timer = window.setTimeout(() => {
        this.appealPending.delete(request.requestId)
        this.appealRequests.delete(request.requestId)
        this.requestStatus()
        finish({ accepted: false, reason: 'Нет подтверждения мастера. Статус запрошен заново.' })
      }, 4_000)
      this.appealRequests.set(request.requestId, request)
      this.appealPending.set(request.requestId, { finish, timer })
      this.transport.send({ ...request, type: 'appeal', clientId: this.clientId, authToken: this.authToken })
    })
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

  sendSpecialPick(pick: { target: 'player' | 'stake' | 'auction'; playerId?: number; amount?: number; choice?: 'pass' | 'allIn' | number }): void {
    this.transport.send({ type: 'specialPick', clientId: this.clientId, authToken: this.authToken, ...pick })
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
    for (const pending of this.appealPending.values()) { window.clearTimeout(pending.timer); pending.finish({ accepted: false, reason: 'Нет связи с мастером' }) }
    this.appealPending.clear()
    this.appealRequests.clear()
    window.clearInterval(this.heartbeatTimer)
    window.clearInterval(this.debugTimer)
    this.packPipe?.dispose()
    this.unsub()
    this.transport.close()
  }

  snapshot(): ConferenceSnapshot | null {
    return this.lastSnapshot
  }

  /** Полный статус можно запросить повторно в любой момент. Ответ общий для комнаты. */
  requestStatus(): void {
    if (this.disposed) return
    this.waitingStatus = true
    this.transport.send({ type: 'statusRequest', clientId: this.clientId, authToken: this.authToken })
  }

  private emitLobby(): void {
    const packPhase = derivePackPhase({
      waitingMaster: this.waitingMaster,
      pipeState: this.usePackPipe ? this.pipeState : 'open',
      percent: this.lobbyPercent,
      hashOk: this.hashOk,
      ready: this.readySent,
      previousPhase: this.lastPackPhase,
    })
    this.lastPackPhase = packPhase
    this.callbacks.onLobby({
      waitingMaster: this.waitingMaster,
      masterOffline: this.masterOffline,
      percent: this.lobbyPercent,
      hashOk: this.hashOk,
      readySent: this.readySent,
      packName: this.packName,
      rosterNames: this.lastSnapshot?.presence.filter((entry) => !entry.hidden).map((entry) => entry.name) ?? [],
      packPhase,
    })
  }

  private async onPipeInbound(inbound: PackPipeInbound): Promise<void> {
    if (this.buildRejected || this.disposed) return
    this.noteMasterAlive()
    if (inbound.kind === 'offer') {
      if (!this.acceptMasterBuild(inbound.message.commit)) return
      await this.handlePackOffer(inbound.message)
      return
    }
    if (inbound.kind === 'chunk') {
      await this.handlePackChunkMessage(inbound.message)
      return
    }
    if (inbound.kind === 'binaryChunk') {
      if (this.readyPackHash === inbound.hash) {
        this.sendPackAck(inbound.hash, inbound.total)
        return
      }
      const ack = this.packReceiver.handleBinaryChunk(inbound)
      await this.finishPackAck(ack)
    }
  }

  private async onMessage(message: ConferenceMessage, senderId: string): Promise<void> {
    if (this.buildRejected || this.disposed) return
    if (message.type === 'appealReply') {
      if (message.targetClientId !== this.clientId || !this.acceptMaster(message.authorityToken, senderId, false)) return
      const pending = this.appealPending.get(message.requestId)
      if (pending) { window.clearTimeout(pending.timer); this.appealPending.delete(message.requestId); this.appealRequests.delete(message.requestId); pending.finish({ accepted: message.accepted, reason: message.reason }) }
      this.noteMasterAlive()
      return
    }
    if (message.type === 'packPipeOffer' || message.type === 'packPipeIce') {
      if (message.type === 'packPipeOffer') {
        if (message.targetClientId !== this.clientId) return
        if (!this.acceptMaster(message.authorityToken, senderId, true)) return
      } else if (message.authorityToken) {
        if (message.targetClientId && message.targetClientId !== this.clientId) return
        if (!this.acceptMaster(message.authorityToken, senderId, false)) return
      } else {
        return
      }
      this.noteMasterAlive()
      this.pipeState = this.pipeState === 'open' ? 'open' : 'connecting'
      this.packPipe?.handleSignal(message)
      this.emitLobby()
      return
    }
    if (
      (message.type === 'packOffer' || message.type === 'packChunk') &&
      message.targetClientId &&
      message.targetClientId !== this.clientId
    ) {
      return
    }
    // Fallback: если WebRTC не поднялся за 30 с, мастер шлёт offer/куски по Jitsi — принимаем.
    if (this.usePackPipe && (message.type === 'packOffer' || message.type === 'packChunk')) this.pipeState = 'open'
    if (message.type === 'snapshot' || message.type === 'packOffer') {
      if (!this.acceptMaster(message.authorityToken, senderId, true)) return
      if (!this.acceptMasterBuild(message.commit)) return
    } else if (message.type === 'packChunk' || message.type === 'partialUpdate') {
      if (!this.acceptMaster(message.authorityToken, senderId, false)) return
    } else {
      return
    }
    const sentAt = (message as { sentAt?: unknown }).sentAt
    if ((message.type === 'snapshot' || message.type === 'partialUpdate') && typeof sentAt === 'number') {
      this.stateLatency(Date.now() - sentAt, message.type === 'snapshot' ? 'полный' : 'изменение')
    }
    if (message.type === 'snapshot' || message.type === 'partialUpdate') {
      this.noteMasterAlive()
      // Тот же сборщик «полученного состояния», что у мастера (receivedState.ts).
      const step = this.received.next(message)
      if (step.kind === 'needFull') {
        if (!this.waitingStatus) this.requestStatus()
        return
      }
      if (step.kind !== 'apply') return
      if (message.type === 'partialUpdate' && !this.acceptMasterBuild(step.state.commit)) return
      this.received.commit(step)
      this.masterState = step.state
      if (message.type === 'snapshot') this.waitingStatus = false
      if (step.changed) this.emitSnapshot()
      await this.syncPackFromState(message.authorityToken)
      return
    }
    if (message.type === 'packOffer') {
      this.noteMasterAlive()
      await this.handlePackOffer(message)
      return
    }
    if (message.type === 'packChunk') {
      this.noteMasterAlive()
      await this.handlePackChunkMessage(message)
    }
  }

  private emitSnapshot(): void {
    const appeal = this.masterState?.appeal
    if (appeal) {
      // Pending requests retain their player/window below; snapshot is authoritative.
      for (const [requestId, pending] of this.appealPending) {
        const request = this.appealRequests.get(requestId)
        if (request && request.questionId === appeal.questionId && request.windowId === appeal.windowId &&
          (appeal.activePlayerId === request.playerId || appeal.queue.includes(request.playerId))) {
          window.clearTimeout(pending.timer); this.appealPending.delete(requestId); this.appealRequests.delete(requestId)
          pending.finish({ accepted: true, reason: '' })
        }
      }
    }

    if (!this.masterState) return
    this.lastSnapshot = snapshotFromState(this.masterState)
    this.gameStarted = this.lastSnapshot.phase !== 'lobby'
    this.callbacks.onSnapshot(this.lastSnapshot)
    if (this.gameStarted) this.sendReady()
    this.emitLobby()
  }

  private async syncPackFromState(authorityToken: string): Promise<void> {
    const pack = this.masterState?.pack
    if (!pack) return
    const key = `${pack.hash}:${pack.size}`
    if (key === this.activeOfferKey && this.statePackSenderId === this.masterSenderId) return
    this.statePackSenderId = this.masterSenderId
    // Мастер мог появиться позже первого hello клиента. Связываем endpoint
    // перед статусом кеша/запросом файла, чтобы эти сообщения были приняты.
    this.sendHello()
    await this.handlePackOffer({
      type: 'packOffer', authorityToken, targetClientId: this.clientId,
      commit: this.masterState?.commit, ...pack,
    })
  }

  private async handlePackChunkMessage(message: {
    hash: string
    index: number
    total: number
    dataBase64?: string
    authorityToken?: string
    type?: string
  }): Promise<void> {
    if (this.readyPackHash === message.hash) {
      this.sendPackAck(message.hash, message.total)
      return
    }
    const ack = this.packReceiver.handle(message as ConferenceMessage)
    await this.finishPackAck(ack)
  }

  private async finishPackAck(
    ack: { hash: string; nextIndex: number; bytes?: Uint8Array } | null,
  ): Promise<void> {
    if (!ack) return
    this.sendPackAck(ack.hash, ack.nextIndex)
    if (ack.bytes) {
      const offer = this.packReceiver.state()
      if (offer) {
        this.sendPackStatus(offer.hash, 'verifying', 99)
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

  private async handlePackOffer(message: PackOfferMessage): Promise<void> {
    const offerKey = `${message.hash}:${message.size}`
    this.packName = message.name

    if (this.readyPackHash === message.hash && this.hashOk) {
      this.sendPackAck(message.hash, this.chunkCount(message.size))
      this.sendPackVerified(message.hash)
      // Новый мастер после перезагрузки ещё не знает прежний ready. Повторяем
      // его в ответ на offer, не заставляя игрока возвращаться в лобби.
      if (this.readyRequested || this.gameStarted) {
        this.sendReady()
      }
      this.emitLobby()
      return
    }

    if (offerKey === this.activeOfferKey) {
      const nextIndex = this.packReceiver.state()?.nextIndex ?? 0
      // Метаданные из полного статуса уже запустили проверку кеша/ACK 0.
      // Ответный offer перед первым куском не перезапускает то же окно снова.
      if (nextIndex > 0) this.sendPackAck(message.hash, nextIndex)
      return
    }

    this.activeOfferKey = offerKey
    this.lobbyPercent = 0
    this.hashOk = false
    this.readySent = false
    this.readyPackHash = null
    this.packReceiver.handle(message)
    this.sendPackStatus(message.hash, this.usePackPipe && this.pipeState !== 'open' ? 'connecting' : 'downloading', 0)
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
      this.lobbyPercent = 99
      this.sendPackStatus(message.hash, 'verifying', 99)
      this.emitLobby()
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
    this.lastPackPhase = this.usePackPipe && this.pipeState !== 'open' ? 'connecting' : 'downloading'
    this.packReceiver.restart()
    this.sendPackStatus(message.hash, this.usePackPipe && this.pipeState !== 'open' ? 'connecting' : 'downloading', 0)
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
    const message = {
      type: 'packAck' as const,
      clientId: this.clientId,
      authToken: this.authToken,
      hash,
      nextIndex,
    }
    if (this.packPipe?.sendAck(message)) return
    this.transport.send(message)
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

  private sendPackStatus(hash: string, packPhase: 'connecting' | 'downloading' | 'verifying', percent: number): void {
    this.transport.send({ type: 'packStatus', clientId: this.clientId, authToken: this.authToken, hash, packPhase, percent })
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
    const changed = this.waitingMaster || this.masterOffline
    this.waitingMaster = false
    this.masterOffline = false
    this.lastMasterAliveAt = Date.now()
    if (changed) this.emitLobby()
  }

  private acceptMasterBuild(masterCommit: string | undefined): boolean {
    if (this.buildRejected) return false
    const mismatch = masterBuildMismatchMessage(masterCommit)
    if (!mismatch) return true
    this.buildRejected = true
    pushTrace('note', `[версия] мастер на другой сборке — игрок отключён: у игрока ${buildCommit()}, у мастера ${masterCommit?.trim() || 'неизвестна'}`)
    this.callbacks.onFatalError(mismatch)
    this.dispose()
    return false
  }

  /**
   * Задержка снимков: часы игрока минус часы мастера. Включает разницу часов устройств,
   * поэтому рядом пишем то же для ping (`clockMs`): реальная задержка ≈ state − ping + RTT/2.
   */
  private stateLatency = createDiagSummary('снимок', 'игрок получил: задержка мс (часы игрока − мастера), за минуту', 60_000)
  private pingClock = createDiagSummary('снимок', 'ping: часы игрока − мастера, мс', 120_000)

  private answerPing(message: { authorityToken: string; seq: number; sentAt: number }, senderId: string): void {
    this.pingClock(Date.now() - message.sentAt)
    if (!this.acceptMaster(message.authorityToken, senderId, false)) return
    this.transport.send({ type: 'pong', clientId: this.clientId, authToken: this.authToken, seq: message.seq, sentAt: message.sentAt })
    this.noteMasterAlive()
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
    this.masterState = null
    this.received.reset()
    this.sendHello()
    this.requestStatus()
    return true
  }
}

import { appealRequestError } from '../game/appeals.ts'
import type { Actor, SnapshotFrom } from 'xstate'
import type { GameVoice } from '../realtime/client.ts'
import { gameMachine } from '../game/machine.ts'
import { pickOpen, statePath } from '../game/machine.ts'
import type { GameContext, Player, QuestionPack } from '../game/types.ts'
import { buildConferenceSnapshot, timerRemainingMs } from './buildSnapshot.ts'
import { createPackPipeHub, type PackPipeLinkState } from './packPipe.ts'
import { CHUNK_BYTES, createPackTransferMaster, type PackTransferMaster } from './packTransfer.ts'
import type { PackPhase } from './packProgress.ts'
import {
  LOBBY_IDLE_INTERVAL_MS,
  LOBBY_SILENCE_BEFORE_SPEECH_MS,
  LOBBY_SILENCE_POLL_MS,
  LOBBY_SPEECH_MIN_INTERVAL_MS,
  requestLobbySpeech,
  packLobbySummary,
} from './lobbySpeech.ts'
import {
  type ConferenceMessageRing,
  type ConferenceHistoryMessage,
  type ConferenceMessage,
  type ConferenceSnapshot,
} from './messages.ts'
import { paceAfterAck, type TransferPace } from './packProgress.ts'
import { ConferenceRoster } from './roster.ts'
import type { ConferenceTransport } from './transport.ts'
import { PING_INTERVAL_MS, PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from './presence.ts'
import { appendRemoteDebug, clearRemoteDebug, getTrace, subscribeTrace } from '../debug/trace.ts'
import { messageRingEntries } from './messageRing.ts'
import { commentaryContext } from '../game/commentary.ts'
import { emptyMessageRing } from './messageRing.ts'
import { ConferenceStatePublisher } from './stateProtocol.ts'
import { conversationLineFromTrace } from './traceConversation.ts'

type GameActor = Actor<typeof gameMachine>

export type MasterSessionOptions = {
  transport: ConferenceTransport
  client: GameVoice
  actor: GameActor
  masterClientId: string
  masterName: string
  pack: QuestionPack
  packBytes: Uint8Array
  packHash: string
  authorityToken: string
  onRoster: () => void
  messageRing?: ConferenceMessageRing
  onHistory?: (history: ConferenceMessageRing) => void
  /** Игроки сохранённой партии. Если переданы, лобби не объявляется и не рассылается. */
  resumePlayers?: readonly Player[]
  /** Речь людей в комнате (без «Ведущей»): лобби ждёт тишину перед репликой. */
  isRoomSpeaking?: () => boolean
  /**
   * Раздача пакета по прямому WebRTC data channel (Jitsi только сигнализация).
   * Broadcast-транспорт оставляет куски на общем канале.
   */
  usePackPipe?: boolean
}

export class MasterSession {
  private appealReplies = new Map<string, Extract<ConferenceMessage, { type: 'appealReply' }>>()
  private transport: ConferenceTransport
  private client: GameVoice
  private actor: GameActor
  private roster: ConferenceRoster
  private pack: QuestionPack
  private packBytes: Uint8Array
  private packHash: string
  private unsub: () => void
  private packTransfer: PackTransferMaster
  private verified = new Set<string>()
  private gameStarted = false
  private gameStartedAt = 0
  private lobbyOpenedSpeech = false
  private spokenLobbySignature = ''
  private lastLobbySpeechAt = 0
  private lobbySpeechTimer = 0
  private lobbyQuietSince = 0
  private lobbyNeedsOpenedSpeech = false
  private heartbeatTimer = 0
  private presenceTimer = 0
  private pingTimer = 0
  private pingSeq = 0
  private onRosterCb: () => void
  private initialHistory: ConferenceMessageRing
  private onHistory: (history: ConferenceMessageRing) => void
  private isRoomSpeaking: () => boolean
  private machineSub: { unsubscribe: () => void } | null = null
  private masterClientId: string
  private packRequested = new Set<string>()
  private authorityToken: string
  private clientAuth = new Map<string, string>()
  private clientSender = new Map<string, string>()
  private senderClient = new Map<string, string>()
  /** Оценка скорости/ETA по packAck, отдельно для каждого клиента. */
  private transferPace = new Map<string, TransferPace>()
  private packPipe: ReturnType<typeof createPackPipeHub> | null = null
  private usePackPipe = false
  /** clientId → таймер fallback на Jitsi, если data channel не открылся за PACK_PIPE_FALLBACK_MS. */
  private pipeFallbackTimers = new Map<string, number>()
  private pipeOpened = new Set<string>()
  private disposedFallback = false
  private statePublisher: ConferenceStatePublisher | null = null
  private traceCursor = 0
  private traceUnsub: () => void

  constructor(options: MasterSessionOptions) {
    clearRemoteDebug()
    this.masterClientId = options.masterClientId
    this.transport = options.transport
    this.client = options.client
    this.actor = options.actor
    this.pack = options.pack
    this.packBytes = options.packBytes
    this.packHash = options.packHash
    this.authorityToken = options.authorityToken
    this.onRosterCb = options.onRoster
    this.initialHistory = options.messageRing ?? emptyMessageRing()
    this.onHistory = options.onHistory ?? (() => {})
    this.isRoomSpeaking = options.isRoomSpeaking ?? (() => false)
    this.roster = new ConferenceRoster(options.masterClientId, options.masterName)
    this.verified.add(options.masterClientId)
    if (options.resumePlayers?.length) {
      this.roster.restorePlayers(options.resumePlayers)
      this.gameStarted = true
      this.lobbyOpenedSpeech = true
    }

    this.usePackPipe = options.usePackPipe === true
    if (this.usePackPipe) {
      this.packPipe = createPackPipeHub({
        authorityToken: this.authorityToken,
        sendSignal: (message) => this.transport.send(message),
        onOpen: (clientId) => {
          this.pipeOpened.add(clientId)
          if (this.packTransfer.isBridge(clientId)) return
          this.roster.updateProgress(clientId, { packPhase: 'downloading' })
          if (this.packRequested.has(clientId)) this.packTransfer.pumpClient(clientId)
          this.onRosterCb()
        },
        onInbound: (clientId, inbound) => {
          if (inbound.kind === 'ack') this.applyPackAck(clientId, inbound.message.hash, inbound.message.nextIndex)
        },
        onState: (clientId, state) => {
          // A new channel must retransmit chunks whose ACK was lost with the old one.
          // Keep the request and receiver cache; its next ACK skips the received prefix.
          if (state === 'closed' || state === 'failed') this.packTransfer.resetClient(clientId)
          // connecting mid-transfer не затирает «Загрузка N%» (sticky в roster);
          // failed/closed → «Нет соединения · повтор…».
          this.roster.updateProgress(clientId, { packPhase: pipeStateToPhase(state) })
          this.onRosterCb()
        },
      })
    }

    this.packTransfer = createPackTransferMaster({
      transport: this.transport,
      hash: this.packHash,
      bytes: this.packBytes,
      name: this.pack.name,
      summary: packLobbySummary(this.pack),
      authorityToken: this.authorityToken,
      targetClientIds: () =>
        this.roster
          .allIncludingHidden()
          .filter((entry) => !entry.isMaster)
          .map((entry) => entry.clientId),
      pipe: this.packPipe
        ? {
            ready: (clientId) => this.packPipe!.ready(clientId),
            canSend: (clientId) => this.packPipe!.canSend(clientId),
            sendOffer: (clientId, message) => this.packPipe!.sendOffer(clientId, message),
            sendChunk: (clientId, hash, index, total, data) =>
              this.packPipe!.sendChunk(clientId, hash, index, total, data),
          }
        : undefined,
    })

    this.unsub = this.transport.subscribe((message, senderId) => this.onMessage(message, senderId))
    this.heartbeatTimer = window.setInterval(() => {
      this.roster.heartbeat(this.masterClientId)
    }, PRESENCE_HEARTBEAT_MS)
    // RTT каждому клиенту: один широковещательный ping, ответ — pong с тем же sentAt.
    this.pingTimer = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS)
    this.presenceTimer = window.setInterval(() => {
      const now = Date.now()
      this.onRosterCb()
      if (this.gameStarted) {
        this.handoffOfflineChooser(now)
        this.broadcastGameSnapshot()
      }
      else this.broadcastLobbySnapshot()
      this.maybeLobbySpeech()
    }, 1000)

    if (!this.gameStarted) {
      this.broadcastFullStatus()
      this.maybeOpenLobbySpeech()
    }
    this.traceCursor = getTrace().at(-1)?.id ?? 0
    this.traceUnsub = subscribeTrace(() => {
      const entries = getTrace().filter((entry) => entry.id > this.traceCursor)
      this.traceCursor = entries.at(-1)?.id ?? this.traceCursor
      for (const entry of entries) {
        const line = conversationLineFromTrace(entry)
        if (line && this.statePublisher) this.broadcastMessage({ kind: 'conversation', ...line })
      }
    })
  }

  attachMachine(): void {
    if (this.machineSub) return
    this.machineSub = this.actor.subscribe(() => {
      if (!this.gameStarted) return
      this.broadcastGameSnapshot()
    })
  }

  startGame(sendStart: (players: Player[]) => void): void {
    this.clearLobbySpeechTimer()
    const masterEntry = this.roster.get(this.masterClientId)
    const players: Player[] = [
      {
        id: 1,
        name: masterEntry?.name ?? 'Мастер',
        score: 0,
        clientId: this.masterClientId,
      },
    ]
    for (const entry of this.roster.list()) {
      if (entry.isMaster || !entry.hashOk || !entry.ready) continue
      const id = this.roster.assignPlayerId(entry.clientId)
      if (id === null) continue
      players.push({ id, name: entry.name, score: 0, clientId: entry.clientId })
      this.verified.add(entry.clientId)
    }
    this.gameStarted = true
    this.gameStartedAt = Date.now()
    this.attachMachine()
    sendStart(players)
    this.broadcastGameSnapshot()
  }

  /** Запускает CONTINUE_GAME уже как активную конференцию, без промежуточного lobby snapshot. */
  resumeGame(sendResume: () => void): void {
    this.clearLobbySpeechTimer()
    this.gameStarted = true
    this.gameStartedAt = Date.now()
    sendResume()
    this.attachMachine()
    this.onRosterCb()
    this.broadcastFullStatus()
  }

  rosterList() {
    return this.roster.list()
  }

  rosterAll() {
    return this.roster.allIncludingHidden()
  }

  endpointIdForClient(clientId: string): string | null {
    return this.clientSender.get(clientId) ?? null
  }

  masterOfflineBanner(now = Date.now()): boolean {
    const master = this.roster.list(now).find((entry) => entry.isMaster)
    if (!master) return true
    return now - master.lastSeen > PRESENCE_STALE_MS
  }

  sendChat(name: string, text: string): void {
    const clean = text.trim()
    if (!clean) return
    this.broadcastMessage({ kind: 'chat', name, text: clean, at: new Date().toISOString() })
  }

  dispose(): void {
    window.clearInterval(this.heartbeatTimer)
    window.clearInterval(this.presenceTimer)
    window.clearInterval(this.pingTimer)
    this.clearLobbySpeechTimer()
    this.machineSub?.unsubscribe()
    this.traceUnsub()
    this.unsub()
    this.packPipe?.dispose()
    this.disposedFallback = true
    for (const timer of this.pipeFallbackTimers.values()) window.clearTimeout(timer)
    this.pipeFallbackTimers.clear()
    this.packTransfer.dispose()
  }

  private armPipeFallback(clientId: string): void {
    if (this.pipeFallbackTimers.has(clientId) || this.packTransfer.isBridge(clientId)) return
    this.pipeOpened.delete(clientId)
    const timer = window.setTimeout(() => {
      if (this.disposedFallback) return
      // Канал так и не открылся (ни одного куска по WebRTC) — шлём пакет по Jitsi.
      if (this.pipeOpened.has(clientId) || this.verified.has(clientId)) return
      this.packTransfer.useBridge(clientId)
      this.roster.updateProgress(clientId, { packPhase: 'downloading' })
      this.onRosterCb()
    }, PACK_PIPE_FALLBACK_MS)
    this.pipeFallbackTimers.set(clientId, timer)
  }

  private clearPipeFallback(clientId: string): void {
    const timer = this.pipeFallbackTimers.get(clientId)
    if (timer !== undefined) window.clearTimeout(timer)
    this.pipeFallbackTimers.delete(clientId)
    this.pipeOpened.delete(clientId)
  }

  private applyPackAck(clientId: string, hash: string, nextIndex: number): void {
    if (hash !== this.packHash) return
    // Готовый кеш не требует окна кусков или повторного offer.
    if (this.verified.has(clientId) && nextIndex >= Math.max(1, Math.ceil(this.packBytes.length / CHUNK_BYTES))) return
    this.packRequested.add(clientId)
    this.packPipe?.ensure(clientId)
    this.packTransfer.handleAck(clientId, nextIndex)
    const { pace, view } = paceAfterAck(
      this.transferPace.get(clientId),
      nextIndex,
      this.packBytes.byteLength,
    )
    if (pace) this.transferPace.set(clientId, pace)
    else this.transferPace.delete(clientId)
    this.roster.updateProgress(clientId, {
      ...view,
      packPhase: nextIndex > 0 ? 'downloading' : 'connecting',
    })
    this.onRosterCb()
  }

  private sendPing(): void {
    if (this.disposedFallback) return
    this.pingSeq += 1
    this.transport.send({ type: 'ping', authorityToken: this.authorityToken, seq: this.pingSeq, sentAt: Date.now() })
  }

  private onMessage(message: ConferenceMessage, senderId: string): void {
    if (message.type === 'hello') {
      const previousEndpoint = this.clientSender.get(message.clientId)
      if (!this.bindClient(message.clientId, message.authToken, senderId)) return
      this.roster.upsertHello(message.clientId, message.name)
      if (message.clientId === this.masterClientId) return
      if (previousEndpoint && previousEndpoint !== senderId) {
        // После reload сохраняются clientId и секрет, но в новой странице ещё
        // нет открытого пакета. Она сама сверит кеш по глобальному хешу.
        this.verified.delete(message.clientId)
        this.transferPace.delete(message.clientId)
        this.roster.updateProgress(message.clientId, {
          percent: 0, hashOk: false, ready: false,
          downloadBps: null, etaSeconds: null, packPhase: 'connecting',
        })
        this.packTransfer.resetClient(message.clientId)
        this.packRequested.delete(message.clientId)
        this.packPipe?.reset(message.clientId)
        this.clearPipeFallback(message.clientId)
      }
      if (this.gameStarted && message.clientId) {
        void this.addMidGamePlayer(message.clientId, message.name)
      }
      if (this.packPipe) {
        // Повторный hello (heartbeat) не сбрасывает percent/фазу — только поднимает peer при нужде.
        // Новому гостю upsertHello уже ставит packPhase: connecting.
        this.packPipe.ensure(message.clientId)
        this.armPipeFallback(message.clientId)
      }
      if (this.packRequested.has(message.clientId)) {
        this.packTransfer.pumpClient(message.clientId)
      }
      this.onRosterCb()
      this.broadcastCurrentSnapshot()
      this.maybeLobbySpeech()
      return
    }
    if (message.type === 'packPipeAnswer') {
      if (!this.clientMatches(message.clientId, message.authToken, senderId)) return
      this.packPipe?.handleSignal(message, message.clientId)
      return
    }
    if (message.type === 'packPipeIce') {
      if (!message.clientId || !message.authToken) return
      if (!this.clientMatches(message.clientId, message.authToken, senderId)) return
      this.packPipe?.handleSignal(message, message.clientId)
      return
    }
    if (!('clientId' in message) || !('authToken' in message)) return
    if (!this.clientMatches(message.clientId, message.authToken, senderId)) return
    if (message.type === 'pong') {
      const rtt = Date.now() - message.sentAt
      if (message.seq > this.pingSeq || rtt < 0 || rtt > 60_000) return
      this.roster.setPing(message.clientId, rtt)
      return
    }
    if (message.type === 'statusRequest') {
      this.broadcastFullStatus()
      return
    }
    if (message.type === 'packAck') {
      this.applyPackAck(message.clientId, message.hash, message.nextIndex)
      return
    }
    if (message.type === 'packStatus') {
      if (message.hash !== this.packHash) return
      this.verified.delete(message.clientId)
      this.roster.updateProgress(message.clientId, {
        percent: message.percent, packPhase: message.packPhase, hashOk: false, ready: false,
        downloadBps: null, etaSeconds: null,
      })
      this.onRosterCb()
      this.broadcastCurrentSnapshot()
      return
    }
    if (message.type === 'packVerified') {
      if (message.hash !== this.packHash) return
      this.transferPace.delete(message.clientId)
      this.markHashOk(message.clientId, 100)
      this.broadcastCurrentSnapshot()
      this.maybeLobbySpeech()
      return
    }
    if (message.type === 'ready') {
      if (!this.verified.has(message.clientId) || !this.roster.get(message.clientId)?.hashOk) return
      this.roster.updateProgress(message.clientId, { ready: true, hashOk: true, percent: 100 })
      if (this.gameStarted) void this.addMidGamePlayer(message.clientId, this.roster.get(message.clientId)?.name ?? '')
      this.onRosterCb()
      this.broadcastCurrentSnapshot()
      this.maybeLobbySpeech()
      return
    }
    if (message.type === 'appeal') {
      const key = `${message.clientId}:${message.requestId}`
      const cached = this.appealReplies.get(key)
      if (cached) { this.transport.send(cached); this.broadcastCurrentSnapshot(); return }
      const snap = this.actor.getSnapshot()
      const player = snap.context.players.find((p) => p.id === message.playerId && p.clientId === message.clientId)
      let reason = !this.gameStarted || !this.verified.has(message.clientId) ? 'Пакет ещё не сверен' : !player ? 'Чужой игрок' :
        appealRequestError(snap.context, statePath(snap.value), message)
      if (!reason) {
        this.actor.send({ ...message, type: 'APPEAL_REQUESTED' })
        const appeal = this.actor.getSnapshot().context.appeal
        if (appeal?.activePlayerId !== message.playerId && !appeal?.queue.includes(message.playerId)) reason = 'Заявка уже устарела'
      }
      const reply: Extract<ConferenceMessage, { type: 'appealReply' }> = { type: 'appealReply', authorityToken: this.authorityToken,
        targetClientId: message.clientId, requestId: message.requestId, accepted: !reason, reason: reason ?? '' }
      this.appealReplies.set(key, reply)
      if (this.appealReplies.size > 500) this.appealReplies.delete(this.appealReplies.keys().next().value!)
      this.transport.send(reply)
      this.broadcastCurrentSnapshot()
      return
    }
    if (message.type === 'buzz') {
      if (!this.gameStarted || !this.verified.has(message.clientId)) return
      const entry = this.roster.get(message.clientId)
      if (!entry?.playerId) return
      this.actor.send({ type: 'BUZZER_PRESSED', playerId: entry.playerId })
      return
    }
    if (message.type === 'pick') {
      if (!this.gameStarted || !this.verified.has(message.clientId)) return
      const snap = this.actor.getSnapshot()
      const path = statePath(snap.value)
      if (!pickOpen(path, snap.context)) return
      if (snap.context.chooserId !== this.roster.get(message.clientId)?.playerId) return
      this.actor.send({ type: 'QUESTION_SELECTED', themeId: message.themeId, value: message.value })
      return
    }
    if (message.type === 'chat') {
      const clean = message.text.trim()
      const name = this.roster.get(message.clientId)?.name
      if (!clean || !name) return
      this.sendChat(name, clean)
      return
    }
    if (message.type === 'debugLog') {
      const name = this.roster.get(message.clientId)?.name
      if (!name) return
      appendRemoteDebug(message.clientId, name, message.entries)
    }
  }

  markHashOk(clientId: string, percent: number): void {
    // Повторный offer после heartbeat снова присылает packVerified. Уже готового
    // игрока нельзя на мгновение возвращать в ready=false: это дёргало и UI, и речь.
    this.roster.updateProgress(clientId, { hashOk: true, percent })
    this.verified.add(clientId)
    this.onRosterCb()
  }

  private broadcastLobbySnapshot(): void {
    this.publishSnapshot(this.buildSnapshot('lobby'))
  }

  private broadcastCurrentSnapshot(): void {
    if (this.gameStarted) this.broadcastGameSnapshot()
    else this.broadcastLobbySnapshot()
  }

  broadcastGameSnapshot(): void {
    this.publishSnapshot(this.buildSnapshot(statePath(this.actor.getSnapshot().value)))
  }

  private publishSnapshot(snapshot: ConferenceSnapshot): void {
    if (!this.statePublisher) {
      this.statePublisher = new ConferenceStatePublisher(snapshot, this.authorityToken)
      this.transport.send(this.statePublisher.full())
    } else {
      this.transport.send(this.statePublisher.update(snapshot))
    }
  }

  private broadcastFullStatus(): void {
    const snapshot = this.buildSnapshot(this.gameStarted ? statePath(this.actor.getSnapshot().value) : 'lobby')
    if (!this.statePublisher) this.statePublisher = new ConferenceStatePublisher(snapshot, this.authorityToken)
    else this.statePublisher.update(snapshot)
    this.transport.send(this.statePublisher.full())
  }

  private broadcastMessage(line: ConferenceHistoryMessage): void {
    if (!this.statePublisher) this.broadcastFullStatus()
    this.transport.send(this.statePublisher!.appendMessage(line))
    this.onHistory(this.statePublisher!.history())
  }

  private buildSnapshot(phase: string): ConferenceSnapshot {
    const context = this.gameStarted
      ? this.actor.getSnapshot().context
      : lobbyContext(this.pack, this.roster.get(this.masterClientId)?.name ?? 'Мастер')
    const now = Date.now()
    return buildConferenceSnapshot({
      phase,
      pack: { hash: this.packHash, size: this.packBytes.byteLength, name: this.pack.name, summary: packLobbySummary(this.pack) },
      context,
      roster: this.roster.allIncludingHidden(now),
      messageRing: this.statePublisher?.history() ?? this.initialHistory,
      timerRemainingMs: this.gameStarted ? timerRemainingMs(context, now) : null,
      falseStartIds: this.gameStarted
        ? Object.entries(this.actor.getSnapshot().context.falseStarts)
            .filter(([, stamp]) => stamp !== null)
            .map(([id]) => Number(id))
        : [],
    })
  }

  private maybeOpenLobbySpeech(): void {
    if (this.lobbyOpenedSpeech) return
    this.lobbyOpenedSpeech = true
    this.lobbyNeedsOpenedSpeech = true
    this.spokenLobbySignature = this.lobbySignature()
    // Реплика после короткой тишины комнаты — не врезаемся в разговор.
    this.scheduleLobbySpeech(0)
  }

  private maybeLobbySpeech(): void {
    if (!this.lobbyOpenedSpeech || this.gameStarted) return
    const signature = this.lobbySignature()
    if (signature === this.spokenLobbySignature) return
    const waitMs = LOBBY_SPEECH_MIN_INTERVAL_MS - (Date.now() - this.lastLobbySpeechAt)
    if (waitMs <= 0) {
      this.speakLobbyTurn()
      return
    }
    this.scheduleLobbySpeech(waitMs)
  }

  private scheduleLobbySpeech(delayMs: number): void {
    this.clearLobbySpeechTimer()
    this.lobbySpeechTimer = window.setTimeout(() => {
      this.lobbySpeechTimer = 0
      this.speakLobbyTurn()
    }, Math.max(0, delayMs))
  }

  /** Ждёт ~5 с тишины людей, прежде чем ведущая заговорит в лобби. */
  private waitLobbySilence(): boolean {
    if (this.isRoomSpeaking()) {
      this.lobbyQuietSince = 0
      this.scheduleLobbySpeech(LOBBY_SILENCE_POLL_MS)
      return false
    }
    const now = Date.now()
    if (this.lobbyQuietSince === 0) this.lobbyQuietSince = now
    const left = LOBBY_SILENCE_BEFORE_SPEECH_MS - (now - this.lobbyQuietSince)
    if (left > 0) {
      this.scheduleLobbySpeech(Math.min(left, LOBBY_SILENCE_POLL_MS))
      return false
    }
    return true
  }

  private speakLobbyTurn(): void {
    if (!this.lobbyOpenedSpeech || this.gameStarted) return
    if (!this.waitLobbySilence()) return
    const signature = this.lobbySignature()
    const changed = signature !== this.spokenLobbySignature
    const kind = this.lobbyNeedsOpenedSpeech ? 'opened' : changed ? 'update' : 'idle'
    this.lobbyNeedsOpenedSpeech = false
    this.spokenLobbySignature = signature
    this.lastLobbySpeechAt = Date.now()
    this.lobbyQuietSince = 0
    requestLobbySpeech(this.client, {
      kind,
      packName: this.pack.name,
      packSummary: packLobbySummary(this.pack),
      roster: this.roster.list(),
      publicContext: commentaryContext(null,
        messageRingEntries(this.statePublisher?.history() ?? this.initialHistory).map(({ message }) => message)),
    })
    this.scheduleLobbySpeech(LOBBY_IDLE_INTERVAL_MS)
  }

  private lobbySignature(): string {
    return this.roster
      .list()
      .map((entry) => {
        const stage = entry.stale ? 'stale' : entry.ready ? 'ready' : entry.hashOk ? 'verified' : 'loading'
        return `${entry.clientId}:${entry.name}:${stage}`
      })
      .join('|')
  }

  private clearLobbySpeechTimer(): void {
    window.clearTimeout(this.lobbySpeechTimer)
    this.lobbySpeechTimer = 0
  }

  addMidGamePlayer(clientId: string, name: string): Player | null {
    if (!this.gameStarted) return null
    const entry = this.roster.upsertHello(clientId, name)
    if (!entry.hashOk) return null
    const id = this.roster.assignPlayerId(clientId)
    if (id === null) return null
    const player: Player = { id, name: entry.name, score: 0, clientId }
    this.actor.send({ type: 'ADD_PLAYER', player })
    this.verified.add(clientId)
    return player
  }

  private handoffOfflineChooser(now: number): void {
    const snapshot = this.actor.getSnapshot()
    if (!statePath(snapshot.value).startsWith('choosing')) return
    const players = snapshot.context.players
    const chooserIndex = players.findIndex((player) => player.id === snapshot.context.chooserId)
    const chooser = players[chooserIndex]
    if (!chooser?.clientId || chooser.clientId === this.masterClientId) return

    const roster = this.roster.allIncludingHidden(now)
    const chooserPresence = roster.find((entry) => entry.clientId === chooser.clientId)
    if (chooserPresence && !chooserPresence.stale && !chooserPresence.hidden) return
    // После продолжения отсутствующего игрока нет в roster до первого hello.
    // Даём ему тот же десятисекундный порог, что и уже видимому участнику.
    if (!chooserPresence && now - this.gameStartedAt < PRESENCE_STALE_MS) return

    const onlinePlayerIds = new Set(
      roster
        .filter((entry) => entry.playerId !== null && entry.hashOk && (entry.isMaster || (!entry.stale && !entry.hidden)))
        .map((entry) => entry.playerId),
    )
    for (let offset = 1; offset < players.length; offset += 1) {
      const replacement = players[(chooserIndex + offset) % players.length]
      if (!replacement || !onlinePlayerIds.has(replacement.id)) continue
      this.actor.send({
        type: 'CHOOSER_OFFLINE',
        fromPlayerId: chooser.id,
        toPlayerId: replacement.id,
      })
      return
    }
  }

  private bindClient(clientId: string, authToken: string, senderId: string): boolean {
    if (!senderId || clientId === this.masterClientId) return false
    const token = this.clientAuth.get(clientId)
    if (token && token !== authToken) return false
    const otherClient = this.senderClient.get(senderId)
    if (otherClient && otherClient !== clientId) return false
    const oldSender = this.clientSender.get(clientId)
    if (oldSender && oldSender !== senderId) this.senderClient.delete(oldSender)
    this.clientAuth.set(clientId, authToken)
    this.clientSender.set(clientId, senderId)
    this.senderClient.set(senderId, clientId)
    return true
  }

  private clientMatches(clientId: string, authToken: string, senderId: string): boolean {
    return (
      this.clientAuth.get(clientId) === authToken &&
      this.clientSender.get(clientId) === senderId &&
      this.senderClient.get(senderId) === clientId
    )
  }
}

/** Сколько ждать WebRTC data channel до перехода на старую передачу кусками через Jitsi. */
export const PACK_PIPE_FALLBACK_MS = 30_000

function pipeStateToPhase(state: PackPipeLinkState): PackPhase {
  if (state === 'open') return 'downloading'
  if (state === 'failed') return 'failed'
  if (state === 'closed') return 'failed'
  return 'connecting'
}

function lobbyContext(pack: QuestionPack, masterName: string): GameContext {
  return {
    players: [{ id: 1, name: masterName, score: 0 }],
    packName: pack.name,
    rounds: pack.rounds,
    roundIndex: pack.rounds[0]?.index ?? 0,
    warnings: pack.warnings,
    questions: pack.questions,
    playedIds: [],
    missedIds: [],
    finalists: [],
    finalCursor: 0,
    bets: [],
    betMisses: 0,
    chooserId: 1,
    activeQuestionId: null,
    activePlayerId: null,
    activeStake: null,
    attemptId: 0,
    clarifications: 0,
    spokeWithoutButton: false,
    talkedDuringRead: false,
    sayFalseStart: false,
    heard: '',
    wrongHeard: [],
    sayCloseGuess: false,
    judgmentReason: '',
    judgmentStatus: null,
    announceKind: null,
    clarifyReason: '',
    phaseStartedAt: null,
    phaseDurationMs: null,
    earlyLeftMs: null,
    earlyStartedAt: null,
    pauseStartedAt: null,
    resumePath: '',
    resumeStatus: '',
    statusLine: 'Ждём игроков',
    error: null,
    falseStarts: {},
  }
}

export type { SnapshotFrom }

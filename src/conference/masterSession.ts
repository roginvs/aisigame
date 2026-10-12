import type { Actor, SnapshotFrom } from 'xstate'
import type { GameVoice } from '../realtime/client.ts'
import { gameMachine } from '../game/machine.ts'
import { statePath } from '../game/machine.ts'
import type { GameContext, Player, QuestionPack } from '../game/types.ts'
import { buildConferenceSnapshot, timerRemainingMs } from './buildSnapshot.ts'
import { createPackPipeHub, type PackPipeLinkState } from './packPipe.ts'
import { createPackTransferMaster, type PackTransferMaster } from './packTransfer.ts'
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
  CONFERENCE_HISTORY_LIMIT,
  type ConferenceChatLine,
  type ConferenceMessage,
  type ConferenceSnapshot,
} from './messages.ts'
import { paceAfterAck, type TransferPace } from './packProgress.ts'
import { ConferenceRoster } from './roster.ts'
import type { ConferenceTransport } from './transport.ts'
import { PRESENCE_HEARTBEAT_MS, PRESENCE_STALE_MS } from './presence.ts'
import { appendRemoteDebug, clearRemoteDebug } from '../debug/trace.ts'

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
  getChat: () => ConferenceChatLine[]
  setChat: (chat: ConferenceChatLine[]) => void
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
  private onRosterCb: () => void
  private getChat: () => ConferenceChatLine[]
  private setChat: (chat: ConferenceChatLine[]) => void
  private isRoomSpeaking: () => boolean
  private machineSub: { unsubscribe: () => void } | null = null
  private masterClientId: string
  private packOfferSent = false
  private authorityToken: string
  private clientAuth = new Map<string, string>()
  private clientSender = new Map<string, string>()
  private senderClient = new Map<string, string>()
  /** Оценка скорости/ETA по packAck, отдельно для каждого клиента. */
  private transferPace = new Map<string, TransferPace>()
  private packPipe: ReturnType<typeof createPackPipeHub> | null = null
  private usePackPipe = false

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
    this.getChat = options.getChat
    this.setChat = options.setChat
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
          this.roster.updateProgress(clientId, { packPhase: 'downloading' })
          this.packTransfer.pumpClient(clientId)
          this.onRosterCb()
        },
        onInbound: (clientId, inbound) => {
          if (inbound.kind === 'ack') this.applyPackAck(clientId, inbound.message.hash, inbound.message.nextIndex)
        },
        onState: (clientId, state) => {
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
      this.maybeOpenLobbySpeech()
      this.broadcastLobbySnapshot()
    }
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
    this.broadcastGameSnapshot()
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
    const chat = [...this.getChat(), { name, text: clean, at: new Date().toISOString() }].slice(
      -CONFERENCE_HISTORY_LIMIT,
    )
    this.setChat(chat)
    if (this.gameStarted) this.broadcastGameSnapshot()
    else this.broadcastLobbySnapshot()
  }

  dispose(): void {
    window.clearInterval(this.heartbeatTimer)
    window.clearInterval(this.presenceTimer)
    this.clearLobbySpeechTimer()
    this.machineSub?.unsubscribe()
    this.unsub()
    this.packPipe?.dispose()
    this.packTransfer.dispose()
  }

  private applyPackAck(clientId: string, hash: string, nextIndex: number): void {
    if (hash !== this.packHash) return
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

  private onMessage(message: ConferenceMessage, senderId: string): void {
    if (message.type === 'hello') {
      if (!this.bindClient(message.clientId, message.authToken, senderId)) return
      this.roster.upsertHello(message.clientId, message.name)
      if (message.clientId === this.masterClientId) return
      if (this.gameStarted && message.clientId) {
        void this.addMidGamePlayer(message.clientId, message.name)
      }
      if (this.packPipe) {
        // Повторный hello (heartbeat) не сбрасывает percent/фазу — только поднимает peer при нужде.
        // Новому гостю upsertHello уже ставит packPhase: connecting.
        this.packPipe.ensure(message.clientId)
        this.packOfferSent = true
      } else if (!this.packOfferSent) {
        this.packOfferSent = true
        this.packTransfer.start()
      } else {
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
    if (message.type === 'packAck') {
      this.applyPackAck(message.clientId, message.hash, message.nextIndex)
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
      if (path !== 'choosing.listening') return
      if (snap.context.chooserId !== this.roster.get(message.clientId)?.playerId) return
      this.actor.send({ type: 'QUESTION_SELECTED', themeId: message.themeId, value: message.value })
      return
    }
    if (message.type === 'chat') {
      const clean = message.text.trim()
      const name = this.roster.get(message.clientId)?.name
      if (!clean || !name) return
      const chat = [...this.getChat(), { name, text: clean, at: new Date().toISOString() }].slice(
        -CONFERENCE_HISTORY_LIMIT,
      )
      this.setChat(chat)
      if (this.gameStarted) this.broadcastGameSnapshot()
      else this.broadcastLobbySnapshot()
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
    const snap = this.buildSnapshot('lobby')
    this.transport.send({ type: 'snapshot', authorityToken: this.authorityToken, ...snap })
  }

  private broadcastCurrentSnapshot(): void {
    if (this.gameStarted) this.broadcastGameSnapshot()
    else this.broadcastLobbySnapshot()
  }

  broadcastGameSnapshot(): void {
    const snap = this.buildSnapshot(statePath(this.actor.getSnapshot().value))
    this.transport.send({ type: 'snapshot', authorityToken: this.authorityToken, ...snap })
  }

  private buildSnapshot(phase: string): ConferenceSnapshot {
    const context = this.gameStarted
      ? this.actor.getSnapshot().context
      : lobbyContext(this.pack, this.roster.get(this.masterClientId)?.name ?? 'Мастер')
    const now = Date.now()
    return buildConferenceSnapshot({
      phase,
      context,
      roster: this.roster.allIncludingHidden(now),
      chat: this.getChat(),
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

  /** Ждёт ~2.5 с тишины людей, прежде чем ведущая заговорит в лобби. */
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

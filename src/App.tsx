import { useCallback, useEffect, useRef, useState } from 'react'
import { setIdleScale } from './game/idle.ts'
import { setAppealScale } from './game/appeals.ts'
import { useMachine } from '@xstate/react'
import { gameSoundRoute, gameSoundStream, markGameSoundsBroken, playAuctionDing, playCatMeow, playTimeoutBeep, setGameSoundRoute, unlockAudio } from './audio/beep.ts'
import { debugLogGame, joinDebugLogFor, noteSession, pushErrorLine, pushSystemLine, pushTrace, startDebugLogFor, wipeDebugLog } from './debug/trace.ts'
import { startPerfWatch } from './debug/perfWatch.ts'
import { gameSoundsErrorText, gameSoundsRestoredText } from './conference/media.ts'
import { buildInviteUrl, parseInvite } from './conference/invite.ts'
import { JoinerSession } from './conference/joinerSession.ts'
import { MasterSession } from './conference/masterSession.ts'
import {
  readClientId,
  readJoinAuthToken,
  readJoinClientId,
  readMasterAuthorityToken,
  readMasterRoomId,
  readConferenceName,
  readJitsiUrl,
  readStartMatchMode,
  writeConferenceName,
  writeJitsiUrl,
  writeMasterRoomId,
  writeStartMatchMode,
  type MatchMode,
} from './conference/prefs.ts'
import { contextFromSnapshot } from './conference/snapshotView.ts'
import { jitsiHostFromBase, stripInviteParams } from './conference/stripInvite.ts'
import { focusedModelParticipantId } from './conference/audioMix.ts'
import type { ConferenceHandle, ConferenceTile } from './conference/media.ts'
import { createConferenceTransport } from './conference/transportFactory.ts'
import { putPack, getPack } from './conference/packDb.ts'
import { ownPackId, packCatalog } from './game/catalog.ts'
import { messageRingEntries } from './conference/messageRing.ts'
import { attachController, specialListenerId, type GameControllerActions } from './game/controller.ts'
import { defaultPlayerNames, playersFromNames } from './game/players.ts'
import { appealRequestError } from './game/appeals.ts'
import { gameMachine, statePath } from './game/machine.ts'
import {
  clearSavedGame,
  confirmNewGame,
  decideResumeFile,
  packCanResume,
  persistConferenceLobby,
  persistConferenceHistory,
  persistMatch,
  readMatchMode,
  readSavedGame,
  resumeNeedsFile,
  resumePackTitle,
  sha256Hex,
  type SavedGame,
  hearTurnOnlyOf,
} from './game/savedGame.ts'
import { loadSiq, revokePackMedia } from './game/siq.ts'
import { preferredPackId, readStartPrefs, writeStartPrefs } from './game/startPrefs.ts'
import type { PlayerId, QuestionPack } from './game/types.ts'
import type { LinkStatus } from './realtime/client.ts'
import { MockRealtimeClient } from './realtime/mockClient.ts'
import {
  hrefAfterModelSwitch,
  markModelSwitch,
  readProviderKey,
  readVoiceModelId,
  takeModelSwitchNotice,
  voiceById,
  writeProviderKey,
  writeVoiceModelId,
} from './realtime/models.ts'
import { audioJudgmentCapable, judgmentModeFromUrl, writeJudgmentMode, type JudgmentInputMode } from './realtime/judgmentRequest.ts'
import { createVoice } from './realtime/voice.ts'
import { emptyMessageRing, readMessageRing } from './conference/messageRing.ts'
import type { ConferenceJitsiPair, ConferenceMessageRing, ConferenceSnapshot } from './conference/messages.ts'
import type { PackPhase } from './conference/packProgress.ts'
import type { RosterEntry } from './conference/roster.ts'
import { GameScreen } from './ui/GameScreen.tsx'
import { JoinConfirmScreen } from './ui/JoinConfirmScreen.tsx'
import { StartScreen } from './ui/StartScreen.tsx'
import type { GameVoice } from './realtime/client.ts'
import { mutedAnswerReminderMs, mutedMicStableMs } from './options.ts'
import { conferenceSinkCreatedText, subscribeConferenceSinkCreated } from './conference/conferenceAudio.ts'
import { jitsiIdOfClient } from './conference/jitsiIds.ts'

const initialLink: LinkStatus = { connection: 'idle', mic: 'idle', host: 'idle' }
const pageParams = new URLSearchParams(window.location.search)
const queryMock = pageParams.get('mock') === '1'
const queryBroadcast = pageParams.get('transport') === 'broadcast'

function packSummary(pack: QuestionPack | null, loading: boolean, packId: string): string {
  if (loading) return ''
  if (!pack) return packId === ownPackId ? 'Свой файл не прочитан' : ''
  const rounds = pack.rounds.length
  const questions = pack.questions.length
  return `${pack.name}: ${rounds} ${roundsLabel(rounds)}, ${questions} ${questionsLabel(questions)}`
}

function roundsLabel(count: number): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'раунд'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'раунда'
  return 'раундов'
}

function questionsLabel(count: number): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'вопрос'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'вопроса'
  return 'вопросов'
}

export default function App() {
  const [snapshot, send, actor] = useMachine(gameMachine)
  const [modelId, setModelId] = useState(() => (queryMock ? 'mock' : readVoiceModelId()))
  const [judgmentMode, setJudgmentMode] = useState<JudgmentInputMode>(() => judgmentModeFromUrl(window.location.href, modelId, localStorage))
  const judgmentModeRef = useRef(judgmentMode)
  function changeAudioJudgment(enabled: boolean): void {
    const mode = enabled ? 'audio' : 'text'
    judgmentModeRef.current = mode
    setJudgmentMode(mode)
    writeJudgmentMode(mode, localStorage)
    const url = new URL(window.location.href)
    url.searchParams.delete('judge')
    window.history.replaceState(window.history.state, '', url)
  }
  const [apiKey, setApiKey] = useState(() => readProviderKey('openai'))
  const [xaiKey, setXaiKey] = useState(() => readProviderKey('xai'))
  const [googleKey, setGoogleKey] = useState(() => readProviderKey('google'))
  const [showKey, setShowKey] = useState(false)
  const [link, setLink] = useState<LinkStatus>(initialLink)
  const catalogIds = packCatalog.map((item) => item.id)
  const [packId, setPackId] = useState(() => preferredPackId(readStartPrefs().packId, catalogIds, packCatalog[0]?.id ?? ''))
  const [pack, setPack] = useState<QuestionPack | null>(null)
  const [packError, setPackError] = useState<string | null>(null)
  const [loadingPack, setLoadingPack] = useState(true)
  const [savedGame, setSavedGame] = useState<SavedGame | null>(() => readSavedGame())
  const [playerNames, setPlayerNames] = useState(() => readStartPrefs().names || defaultPlayerNames)
  const [matchMode, setMatchMode] = useState<MatchMode>(() => readStartMatchMode())
  const [conferenceName, setConferenceName] = useState(() => readConferenceName())
  const [jitsiUrl, setJitsiUrl] = useState(() => readJitsiUrl())
  const inviteParams = parseInvite(window.location.search)
  const [inviteGate, setInviteGate] = useState<'pending' | 'joined' | 'declined'>(() =>
    inviteParams ? 'pending' : 'declined',
  )
  const [conferenceRole, setConferenceRole] = useState<'master' | 'joiner' | null>(null)
  const [conferenceRoomId, setConferenceRoomId] = useState<string | null>(null)
  const [conferenceLobby, setConferenceLobby] = useState(false)
  /** Мастер: вне выбора/ответа модель глуха; на ходе — только этот игрок. В снимке партии. */
  const [hearTurnOnly, setHearTurnOnly] = useState(() => hearTurnOnlyOf(readSavedGame()))
  const hearTurnOnlyRef = useRef(hearTurnOnly)
  /** Последний разосланный мастером снимок: экран мастера рисуется из него, как у гостей. */
  const [masterSnapshot, setMasterSnapshot] = useState<ConferenceSnapshot | null>(null)
  const masterSnapshotRef = useRef<ConferenceSnapshot | null>(null)
  const masterSessionRef = useRef<MasterSession | null>(null)
  const joinerSessionRef = useRef<JoinerSession | null>(null)
  // Кончились заготовленные <audio>: мастер пишет строку в чат сам, игрок шлёт мастеру — у всех одна строка.
  useEffect(() => {
    // Наблюдение за главным потоком (longtask): следующий дамп покажет, что грузит страницу.
    startPerfWatch()
  }, [])
  useEffect(() => subscribeConferenceSinkCreated(({ owner }) => {
    const joiner = joinerSessionRef.current
    if (joiner) joiner.sendAudioSinkNote(owner)
    else if (masterSessionRef.current) pushSystemLine(conferenceSinkCreatedText(conferenceName.trim() || 'Мастер', owner))
  }), [conferenceName])

  useEffect(() => {
    hearTurnOnlyRef.current = hearTurnOnly
    masterSessionRef.current?.setHearTurnOnly(hearTurnOnly)
  }, [hearTurnOnly])
  const [masterRoster, setMasterRoster] = useState<RosterEntry[]>([])
  const [masterRosterAll, setMasterRosterAll] = useState<RosterEntry[]>([])
  const [masterHistory, setMasterHistory] = useState<ConferenceMessageRing>(() => readMessageRing(readSavedGame()) ?? emptyMessageRing())
  const masterHistoryRef = useRef(masterHistory)
  const [joinerSnapshot, setJoinerSnapshot] = useState<ConferenceSnapshot | null>(null)
  const [joinerLobby, setJoinerLobby] = useState({
    waitingMaster: true,
    masterOffline: false,
    hashOk: false,
    readySent: false,
    percent: 0,
    packName: '',
    rosterNames: [] as string[],
    packPhase: 'waiting' as PackPhase,
  })
  const [joinerPack, setJoinerPack] = useState<QuestionPack | null>(null)
  const [conferenceError, setConferenceError] = useState<string | null>(null)
  const [ownFileName, setOwnFileName] = useState('')
  const [ownFileHash, setOwnFileHash] = useState('')
  const [modelSwitched] = useState(() => takeModelSwitchNotice())
  const [pendingContinue, setPendingContinue] = useState(false)
  const [diskResume, setDiskResume] = useState<SavedGame | null>(null)
  const [readingResume, setReadingResume] = useState(false)
  const [resumeFileFallback, setResumeFileFallback] = useState(false)
  const suppressSave = useRef(false)
  const loadedPackId = useRef<string | null>(null)
  const skipCatalogLoad = useRef(false)
  const resumeTicket = useRef(0)
  const cachedResumePackId = useRef<string | null>(null)
  const resumeConferenceOptions = useRef<{ masterName?: string; jitsiBase?: string } | null>(null)
  const packBytesRef = useRef<Uint8Array | null>(null)
  const packHashRef = useRef('')
  const [loadedPackHash, setLoadedPackHash] = useState('')
  const voiceClientRef = useRef<GameVoice | null>(null)
  const controllerActionsRef = useRef<GameControllerActions | null>(null)
  const voiceConnectedRef = useRef(false)
  const conferenceLobbyRef = useRef(false)
  const transportDisposeRef = useRef<(() => void) | null>(null)
  const conferenceHandleRef = useRef<ConferenceHandle | null>(null)
  const tilesUnsubRef = useRef<(() => void) | null>(null)
  const hostSpeakingUnsubRef = useRef<(() => void) | null>(null)
  const speechActivityUnsubRef = useRef<(() => void) | null>(null)
  const tearingDownConferenceRef = useRef(false)
  const [conferenceTiles, setConferenceTiles] = useState<ConferenceTile[]>([])
  const [conferenceHostSpeaking, setConferenceHostSpeaking] = useState(false)
  const conferenceTilesRef = useRef<ConferenceTile[]>([])
  const warnedMicAttemptRef = useRef('')
  const modelMeter = useCallback(() => conferenceHandleRef.current?.modelMeter?.() ?? null, [])
  const localMicStream = useCallback(() => conferenceHandleRef.current?.localMicStream() ?? null, [])
  const bindConferenceVideo = useCallback((participantId: string, element: HTMLVideoElement | null) => {
    conferenceHandleRef.current?.bindVideo(participantId, element)
  }, [])
  const [mediaBusy, setMediaBusy] = useState(false)
  const [joiningStatus, setJoiningStatus] = useState<string | null>(null)
  const [masterClientId] = useState(readClientId)
  const joinerFlipPackRef = useRef<(() => void) | null>(null)

  const model = voiceById(modelId)
  const needsKey = model.provider !== 'mock'
  const activeKey =
    model.provider === 'xai' ? xaiKey : model.provider === 'google' ? googleKey : model.provider === 'openai' ? apiKey : ''
  const keyRef = useRef(needsKey ? activeKey : 'mock')
  /* oxlint-disable react/set-state-in-effect, react/immutability, react-hooks/exhaustive-deps --
     Эти эффекты координируют асинхронную загрузку пакета и одноразовое восстановление
     из localStorage; перенос setters в render создаст реальные повторные старты. */
  useEffect(() => {
    keyRef.current = needsKey ? activeKey : 'mock'
  }, [needsKey, activeKey])

  useEffect(() => {
    if (packId === ownPackId) return
    if (cachedResumePackId.current === packId) {
      cachedResumePackId.current = null
      return
    }
    skipCatalogLoad.current = false
    const item = packCatalog.find((entry) => entry.id === packId)
    if (!item) return
    let cancelled = false
    loadedPackId.current = null
    setLoadingPack(true)
    setPackError(null)
    fetch(item.href)
      .then(async (response) => {
        if (!response.ok) throw new Error('Не удалось загрузить пакет')
        const buffer = await response.arrayBuffer()
        const bytes = new Uint8Array(buffer.slice(0))
        const hash = await sha256Hex(bytes)
        return { buffer, bytes, hash }
      })
      .then(({ buffer, bytes, hash }) => loadSiq(buffer).then((parsed) => ({ parsed, bytes, hash })))
      .then(({ parsed, bytes, hash }) => {
        if (cancelled || skipCatalogLoad.current) {
          revokePackMedia(parsed)
          return
        }
        loadedPackId.current = packId
        packBytesRef.current = bytes
        packHashRef.current = hash
        setLoadedPackHash(hash)
        setPack((current) => {
          revokePackMedia(current)
          return parsed
        })
        setPackError(parsed.questions.length > 0 ? null : 'В пакете нет вопросов')
      })
      .catch((error: unknown) => {
        if (cancelled || skipCatalogLoad.current) return
        loadedPackId.current = null
        setPack(null)
        setPackError(error instanceof Error ? error.message : 'Пакет не прочитался')
      })
      .finally(() => {
        if (!cancelled) setLoadingPack(false)
      })
    return () => {
      cancelled = true
    }
  }, [packId])

  useEffect(() => {
    const client = createVoice(modelId)
    voiceClientRef.current = client
    if (client instanceof MockRealtimeClient) {
      window.__aisigame = {
        hearAudio: (audioText, asrText, durationMs) => client.hearAudio(audioText, asrText, durationMs),
        hear: (text, durationMs) => client.hear(text, durationMs),
        hearLive: (text, stepMs) => { client.hearLive(text, stepMs) },
        hearSlow: (text, hearMs, thinkMs) => { client.hearSlow(text, hearMs, thinkMs) },
        setSpeechMs: (ms) => client.setSpeechMs(ms),
        setIdleScale: (scale) => setIdleScale(scale),
        setAppealScale: (scale) => setAppealScale(scale),
        flipPackByte: () => joinerFlipPackRef.current?.(),
        playGameSound: (kind) => {
          if (kind === 'beep') playTimeoutBeep()
          else void (kind === 'cat' ? playCatMeow() : playAuctionDing())
          return gameSoundRoute()
        },
      }
    }
    const stop = attachController({
      actor,
      client,
      getApiKey: () => keyRef.current,
      getJudgmentMode: () => judgmentModeRef.current,
      getPublicHistory: () => masterSessionRef.current
        ? messageRingEntries(masterHistoryRef.current).map(({ message }) => message)
        : null,
      setLink,
      keepVoiceSession: () => conferenceLobbyRef.current,
      voiceAlreadyConnected: () => voiceConnectedRef.current,
      playSpecialSound: (kind) => { void (kind === 'cat' ? playCatMeow() : playAuctionDing()) },
      onActions: (actions) => {
        controllerActionsRef.current = actions
      },
    })
    return () => {
      delete window.__aisigame
      stop()
    }
  }, [actor, modelId])

  const path = statePath(snapshot.value)
  const phase = path.split('.')[0] ?? path
  const inGame =
    conferenceRole !== null ||
    (phase !== 'startMenu' && phase !== 'connecting' && phase !== 'failed')
  const packFile =
    packId === ownPackId
      ? ownFileName
      : (packCatalog.find((item) => item.id === packId)?.href.split('/').pop() ?? `${packId}.siq`)
  const packHash = packId === ownPackId ? ownFileHash : loadedPackHash
  const answerer = snapshot.context.players.find(
    (player) => player.id === snapshot.context.activePlayerId,
  )
  const answererParticipantId =
    conferenceRole === 'master' && answerer?.clientId
      ? jitsiIdOfClient(masterSnapshot?.jitsiIds, answerer.clientId)
      : null
  // Финальная ставка, а в коте/аукционе — тот, чьё слово сейчас решает.
  const specialListener = specialListenerId(path, snapshot.context)
  const bettor = snapshot.context.players.find(
    (player) => player.id === (specialListener ?? snapshot.context.finalists[snapshot.context.finalCursor]),
  )
  const bettorParticipantId =
    conferenceRole === 'master' && bettor?.clientId
      ? jitsiIdOfClient(masterSnapshot?.jitsiIds, bettor.clientId)
      : null
  const answererTile = answererParticipantId
    ? conferenceTiles.find((tile) => tile.id === answererParticipantId)
    : undefined
  const answererId = answerer?.id ?? null
  const answererName = answerer?.name ?? ''
  const answererMicLive = answererTile?.micLive
  const chooser = snapshot.context.players.find((player) => player.id === snapshot.context.chooserId)
  const chooserParticipantId =
    conferenceRole === 'master' && chooser?.clientId
      ? jitsiIdOfClient(masterSnapshot?.jitsiIds, chooser.clientId)
      : null
  const chooserTile = chooserParticipantId
    ? conferenceTiles.find((tile) => tile.id === chooserParticipantId)
    : undefined
  const chooserMicLive = chooserTile?.micLive
  const chooserId = chooser?.id ?? null
  const answerAttemptKey = answerer
    ? `${snapshot.context.activeQuestionId ?? ''}:${snapshot.context.attemptId}:${answerer.id}`
    : ''

  useEffect(() => {
    conferenceTilesRef.current = conferenceTiles
  }, [conferenceTiles])

  useEffect(() => {
    if (conferenceRole !== 'master') return
    const handle = conferenceHandleRef.current
    if (!handle) return
    handle.setModelHearOnly(
      focusedModelParticipantId(path, chooserParticipantId, answererParticipantId, hearTurnOnly, bettorParticipantId),
    )
  }, [answererParticipantId, bettorParticipantId, chooserParticipantId, conferenceRole, hearTurnOnly, path])

  useEffect(() => {
    if (
      conferenceRole !== 'master' ||
      path !== 'answering.waiting' ||
      answererId === null ||
      !answererParticipantId ||
      answererMicLive !== false ||
      link.host === 'speaking' ||
      warnedMicAttemptRef.current === answerAttemptKey
    ) {
      return
    }
    const timer = window.setTimeout(() => {
      const current = actor.getSnapshot()
      if (
        statePath(current.value) !== 'answering.waiting' ||
        current.context.activePlayerId !== answererId ||
        current.context.attemptId !== snapshot.context.attemptId
      ) {
        return
      }
      const liveTile = conferenceTilesRef.current.find((tile) => tile.id === answererParticipantId)
      if (!liveTile || liveTile.micLive) return
      const actions = controllerActionsRef.current
      if (!actions) return
      warnedMicAttemptRef.current = answerAttemptKey
      actions.remindMutedAnswerer(answererName)
    }, mutedAnswerReminderMs)
    return () => window.clearTimeout(timer)
  }, [
    actor,
    answerAttemptKey,
    answererId,
    answererMicLive,
    answererName,
    answererParticipantId,
    conferenceRole,
    link.host,
    path,
    snapshot.context.attemptId,
  ])

  // Микрофон выбирающего: «выключен» передаём контроллеру, только если он выключен mutedMicStableMs подряд
  // (мигание дорожки при переподключении не в счёт); «включён» — сразу. Напоминание говорит обычный
  // 20-секундный цикл выбора, не чаще mutedChooserMaxReminders раз за ход.
  useEffect(() => {
    const actions = controllerActionsRef.current
    if (conferenceRole !== 'master' || chooserId === null || !chooserParticipantId || chooserMicLive !== false) {
      actions?.setChooserMicOff(false)
      return
    }
    const timer = window.setTimeout(() => {
      const liveTile = conferenceTilesRef.current.find((tile) => tile.id === chooserParticipantId)
      if (liveTile && !liveTile.micLive) controllerActionsRef.current?.setChooserMicOff(true)
    }, mutedMicStableMs)
    return () => window.clearTimeout(timer)
  }, [chooserId, chooserMicLive, chooserParticipantId, conferenceRole])

  useEffect(() => {
    if (suppressSave.current) {
      if (path === 'startMenu') {
        clearSavedGame()
        setSavedGame(null)
        suppressSave.current = false
      }
      return
    }
    setSavedGame(
      persistMatch({
        packId,
        packFile,
        packHash,
        path,
        context: snapshot.context,
        hearTurnOnly,
        conference:
          conferenceRole === 'master' && conferenceRoomId
            ? {
                mode: 'conference',
                conferenceLobby,
                jitsiUrl,
                roomId: conferenceRoomId,
                messageRing: masterHistory,
              }
            : conferenceRole === 'master'
              ? { mode: 'conference', conferenceLobby, jitsiUrl, messageRing: masterHistory }
              : { mode: 'table', conferenceLobby: false },
      }),
    )
  }, [
    snapshot,
    packId,
    packFile,
    packHash,
    path,
    conferenceRole,
    conferenceRoomId,
    conferenceLobby,
    jitsiUrl,
    masterHistory,
    hearTurnOnly,
  ])

  useEffect(() => {
    if (!pendingContinue) return
    const saved = readSavedGame()
    const catalogIds = packCatalog.map((item) => item.id)
    if (!saved || resumeNeedsFile(saved, ownPackId) || !packCanResume(saved, catalogIds, ownPackId)) {
      setPendingContinue(false)
      return
    }
    if (packId !== saved.packId || loadedPackId.current !== saved.packId || loadingPack) return
    if (!pack || pack.questions.length === 0) {
      setPendingContinue(false)
      return
    }
    setPendingContinue(false)
    unlockAudio()
    if (readMatchMode(saved) === 'conference') {
      if (!saved.roomId) {
        setConferenceError('В сохранённой конференции нет номера комнаты')
        return
      }
      const overrides = resumeConferenceOptions.current
      resumeConferenceOptions.current = null
      void enterMasterLobby(saved.roomId, {
        saved,
        jitsiBase: overrides?.jitsiBase ?? saved.jitsiUrl,
        masterName: overrides?.masterName,
      })
      return
    }
    send({ type: 'CONTINUE_GAME', pack, saved })
  }, [pendingContinue, packId, loadingPack, pack, send])

  useEffect(() => {
    if (!diskResume) return
    if (packId !== diskResume.packId || loadedPackId.current !== diskResume.packId) return
    if (!pack || pack.questions.length === 0) return
    const saved = readSavedGame()
    if (!saved || saved.packId !== diskResume.packId) {
      setDiskResume(null)
      return
    }
    setDiskResume(null)
    unlockAudio()
    if (readMatchMode(saved) === 'conference') {
      if (!saved.roomId) {
        setConferenceError('В сохранённой конференции нет номера комнаты')
        return
      }
      const overrides = resumeConferenceOptions.current
      resumeConferenceOptions.current = null
      void enterMasterLobby(saved.roomId, {
        saved,
        jitsiBase: overrides?.jitsiBase ?? saved.jitsiUrl,
        masterName: overrides?.masterName,
      })
      return
    }
    send({ type: 'CONTINUE_GAME', pack, saved })
  }, [diskResume, packId, pack, send])
  /* oxlint-enable react/set-state-in-effect, react/immutability, react-hooks/exhaustive-deps */

  function rememberKey(value: string) {
    if (model.provider === 'mock') return
    const provider = model.provider
    if (provider === 'xai') setXaiKey(value)
    else if (provider === 'google') setGoogleKey(value)
    else setApiKey(value)
    writeProviderKey(provider, value)
  }

  function chooseModel(id: string) {
    setModelId(id)
    if (!queryMock || id !== 'mock') writeVoiceModelId(id)
  }

  function switchModel(id: string) {
    const next = voiceById(id).id
    if (next === modelId) return
    writeVoiceModelId(next)
    persistMatch({ packId, packFile, packHash, path, context: snapshot.context, hearTurnOnly })
    markModelSwitch()
    window.location.replace(hrefAfterModelSwitch(window.location.href))
  }

  function choosePack(id: string) {
    setPackId(id)
    writeStartPrefs({ names: playerNames, packId: id }, catalogIds)
  }

  function editNames(value: string) {
    setPlayerNames(value)
    writeStartPrefs({ names: value, packId }, catalogIds)
  }

  async function chooseFile(file: File) {
    setOwnFileName(file.name)
    setOwnFileHash('')
    setPackId(ownPackId)
    setLoadingPack(true)
    setPackError(null)
    try {
      const bytes = await file.arrayBuffer()
      const hash = await sha256Hex(bytes.slice(0))
      packBytesRef.current = new Uint8Array(bytes.slice(0))
      packHashRef.current = hash
      setLoadedPackHash(hash)
      const parsed = await loadSiq(bytes)
      const named = { ...parsed, name: parsed.name || file.name }
      loadedPackId.current = ownPackId
      setOwnFileHash(hash)
      setPack((current) => {
        revokePackMedia(current)
        return named
      })
      setPackError(named.questions.length > 0 ? null : 'В пакете нет вопросов')
    } catch (error: unknown) {
      loadedPackId.current = null
      setOwnFileHash('')
      setPack(null)
      setPackError(error instanceof Error ? error.message : 'Пакет не прочитался')
    } finally {
      setLoadingPack(false)
    }
  }

  const inviteUrl =
    conferenceRoomId && conferenceRole === 'master'
      ? buildInviteUrl({
          origin: window.location.origin,
          base: import.meta.env.BASE_URL,
          roomId: conferenceRoomId,
          jitsiBase: jitsiUrl,
          transport: queryBroadcast ? 'broadcast' : undefined,
        })
      : ''

  const copyInvite = useCallback(async (): Promise<boolean> => {
    if (!inviteUrl) return false
    try {
      await navigator.clipboard.writeText(inviteUrl)
      return true
    } catch {
      window.prompt('Ссылка для игроков:', inviteUrl)
      return false
    }
  }, [inviteUrl])

  function teardownConference(): void {
    if (tearingDownConferenceRef.current) return
    tearingDownConferenceRef.current = true
    const masterSession = masterSessionRef.current
    const joinerSession = joinerSessionRef.current
    const unsubscribeTiles = tilesUnsubRef.current
    const unsubscribeHostSpeaking = hostSpeakingUnsubRef.current
    const unsubscribeSpeechActivity = speechActivityUnsubRef.current
    const disposeTransport = transportDisposeRef.current
    masterSessionRef.current = null
    setMasterSnapshot(null)
    masterSnapshotRef.current = null
    joinerSessionRef.current = null
    tilesUnsubRef.current = null
    hostSpeakingUnsubRef.current = null
    speechActivityUnsubRef.current = null
    transportDisposeRef.current = null
    conferenceHandleRef.current = null
    conferenceLobbyRef.current = false
    // После конференции ведущая снова играет локально (одиночная игра).
    voiceClientRef.current?.setLocalPlayback(true)
    try {
      masterSession?.dispose()
      joinerSession?.dispose()
      unsubscribeTiles?.()
      unsubscribeHostSpeaking?.()
      unsubscribeSpeechActivity?.()
      disposeTransport?.()
      setGameSoundRoute('local')
      voiceClientRef.current?.stopSession()
      voiceConnectedRef.current = false
      setConferenceTiles([])
      setConferenceHostSpeaking(false)
      setMasterRoster([])
      setMasterRosterAll([])
      setMediaBusy(false)
      setJoiningStatus(null)
      setConferenceRole(null)
      setConferenceRoomId(null)
      setConferenceLobby(false)
      setJoinerSnapshot(null)
      setJoinerPack(null)
      masterHistoryRef.current = emptyMessageRing()
      setMasterHistory(masterHistoryRef.current)
    } finally {
      tearingDownConferenceRef.current = false
    }
  }

  /** Без локального запасного пути: молчим и один раз на сбой пишем ошибку в «Разговор». */
  function gameSoundsLost(reason: string): void {
    if (!conferenceHandleRef.current || !markGameSoundsBroken()) return
    pushTrace('note', 'Звуки игры не проигрываются', { reason })
    pushErrorLine(gameSoundsErrorText)
  }

  /** Повтор удался: снова в поток «Звуков игры» и короткая строка, только если был сбой. */
  function gameSoundsRestored(): void {
    if (gameSoundRoute() !== 'broken') return
    gameSoundStream()
    pushTrace('note', 'Звуки игры восстановлены')
    pushSystemLine(gameSoundsRestoredText)
  }

  function conferenceConnectionFailed(message: string): void {
    setConferenceError(message)
    if (conferenceHandleRef.current) {
      teardownConference()
      send({ type: 'RESET_GAME' })
    }
  }

  function attachConferenceHandle(handle: ConferenceHandle): void {
    conferenceHandleRef.current = handle
    transportDisposeRef.current = () => handle.dispose()
    tilesUnsubRef.current?.()
    tilesUnsubRef.current = handle.subscribeTiles(setConferenceTiles)
    hostSpeakingUnsubRef.current?.()
    hostSpeakingUnsubRef.current = handle.subscribeHostSpeaking(setConferenceHostSpeaking)
    speechActivityUnsubRef.current?.()
    speechActivityUnsubRef.current = handle.subscribeSpeechActivity((participantId, end) => {
      // Реплика ≥1 с по уровню: если это человек, ждущий кнопки, контроллер напомнит про кнопку.
      // Конец реплики, которую модель не заметила, — запасной commit в буфер (fa584db п. 1).
      const pairs: readonly ConferenceJitsiPair[] = masterSnapshotRef.current?.jitsiIds ?? []
      const found = pairs.find(([jitsiId]) => jitsiId === participantId)
      const clientId = found ? found[1] : null
      if (!clientId) return
      const entry = masterSessionRef.current?.rosterList().find((item) => item.clientId === clientId)
      if (!entry || entry.playerId === null) return
      if (end) controllerActionsRef.current?.answerSilentCommit(entry.playerId, end.durationMs)
      else controllerActionsRef.current?.speechWithoutBuzzer(entry.playerId)
    })
  }

  async function toggleConferenceMic(): Promise<void> {
    const handle = conferenceHandleRef.current
    if (!handle || mediaBusy) return
    unlockAudio()
    setMediaBusy(true)
    try {
      const next = !handle.micLive()
      await handle.setMicLive(next)
      const voice = voiceClientRef.current
      if (voice) {
        voice.setInputStream(handle.modelInputStream())
      }
    } catch (error: unknown) {
      setConferenceError(error instanceof Error ? error.message : 'Микрофон недоступен')
    } finally {
      setMediaBusy(false)
    }
  }

  async function toggleConferenceCamera(): Promise<void> {
    const handle = conferenceHandleRef.current
    if (!handle || mediaBusy) return
    unlockAudio()
    setMediaBusy(true)
    try {
      await handle.setCameraOn(!handle.cameraOn())
    } catch (error: unknown) {
      setConferenceError(error instanceof Error ? error.message : 'Камера недоступна')
    } finally {
      setMediaBusy(false)
    }
  }

  async function nextConferenceCamera(): Promise<void> {
    const handle = conferenceHandleRef.current
    if (!handle || mediaBusy || !handle.cameraOn()) return
    unlockAudio()
    setMediaBusy(true)
    try {
      await handle.cycleCamera()
    } catch (error: unknown) {
      setConferenceError(error instanceof Error ? error.message : 'Следующая камера недоступна')
    } finally {
      setMediaBusy(false)
    }
  }

  async function connectVoice(options?: { captureMic?: boolean }): Promise<void> {
    const client = voiceClientRef.current
    if (!client || voiceConnectedRef.current) return
    const apiKey = keyRef.current.trim()
    if (!apiKey) throw new Error('Введите ключ')
    await client.connect(apiKey, options)
    voiceConnectedRef.current = true
  }

  async function enterMasterLobby(
    roomId: string,
    resume?: { saved: SavedGame; jitsiBase?: string; masterName?: string },
  ): Promise<void> {
    if (!pack || !packBytesRef.current) return
    const roomJitsi = resume?.jitsiBase?.trim() || jitsiUrl
    const roomMasterName = resume?.masterName?.trim() || conferenceName.trim() || 'Мастер'
    setConferenceError(null)
    setJoiningStatus('Готовим комнату…')
    unlockAudio()
    writeConferenceName(roomMasterName)
    writeJitsiUrl(roomJitsi)
    setConferenceName(roomMasterName)
    setJitsiUrl(roomJitsi)
    const raw = packBytesRef.current
    const hash =
      packHashRef.current ||
      (await sha256Hex(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer))
    packHashRef.current = hash
    await putPack(hash, packBytesRef.current)
    // BroadcastChannel — только явный локальный тестовый режим. Выбранная
    // голосовая модель не должна менять сетевой транспорт приглашения.
    const useBroadcast = queryBroadcast || inviteParams?.transport === 'broadcast'
    try {
      setJoiningStatus(useBroadcast ? 'Открываем комнату…' : 'Подключаемся к Jitsi…')
      const handle = await createConferenceTransport({
        roomId,
        useBroadcast,
        jitsiBase: roomJitsi,
        displayName: roomMasterName,
        publishHost: true,
        onError: conferenceConnectionFailed,
        onSoundsLost: gameSoundsLost,
        onSoundsRestored: gameSoundsRestored,
      })
      attachConferenceHandle(handle)
      if (!useBroadcast && handle.publishSoundsStream) {
        // Эффекты игры — через скрытого участника «Звуки игры»: у всех тот же путь и громкость, что у ведущей.
        handle.publishSoundsStream(gameSoundStream()).catch((error: unknown) => {
          gameSoundsLost(error instanceof Error ? error.message : String(error))
        })
      }
      setJoiningStatus('Подключаем ведущую…')
      await connectVoice({ captureMic: false })
      voiceClientRef.current?.setInputStream(handle.modelInputStream())
      let firstHostOutput = true
      let resolveHostOutput: (() => void) | null = null
      let rejectHostOutput: ((error: Error) => void) | null = null
      const hostOutputReady = new Promise<void>((resolve, reject) => {
        resolveHostOutput = resolve
        rejectHostOutput = reject
      })
      voiceClientRef.current?.attachHostOutput((stream) => {
        const publish = conferenceHandleRef.current?.publishHostStream(stream)
        if (!publish) return
        void publish.then(
          () => {
            // Jitsi: ведущая уже в комнате — мастер слушает её оттуда, как все; локально не играем.
            if (!useBroadcast) voiceClientRef.current?.setLocalPlayback(false)
            if (!firstHostOutput) return
            firstHostOutput = false
            resolveHostOutput?.()
          },
          (error: unknown) => {
            const failure = error instanceof Error ? error : new Error('Не удалось передать голос ведущей в комнату')
            setConferenceError(failure.message)
            if (!firstHostOutput) return
            firstHostOutput = false
            rejectHostOutput?.(failure)
          },
        )
      })
      if (!useBroadcast) {
        const timeout = new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('Jitsi не открыл аудиодорожку ведущей')), 15_000)
        })
        await Promise.race([hostOutputReady, timeout])
      }
      const restoringLobby = resume?.saved.conferenceLobby === true
      const restoringGame = Boolean(resume) && !restoringLobby
      conferenceLobbyRef.current = !restoringGame
      setConferenceRole('master')
      setConferenceRoomId(roomId)
      noteSession({ role: 'мастер', gameId: roomId, name: roomMasterName, resumed: Boolean(resume) })
      setConferenceLobby(!restoringGame)
      writeMasterRoomId(roomId)
      const history = resume ? readMessageRing(resume.saved) ?? emptyMessageRing() : emptyMessageRing()
      masterHistoryRef.current = history
      setMasterHistory(history)
      const session = new MasterSession({
        transport: handle.transport,
        client: voiceClientRef.current!,
        actor,
        masterClientId,
        masterName: roomMasterName,
        pack,
        packBytes: packBytesRef.current,
        packHash: hash,
        authorityToken: readMasterAuthorityToken(),
        onRoster: () => {
          const active = masterSessionRef.current
          if (!active) return
          const roster = active.rosterList()
          setMasterRoster(roster)
          setMasterRosterAll(active.rosterAll())
        },
        messageRing: history,
        onHistory: (next) => {
          masterHistoryRef.current = next
          setMasterHistory(next)
          const persisted = persistConferenceHistory(roomId, next)
          if (persisted) setSavedGame(persisted)
        },
        onChatLine: (name, text) => controllerActionsRef.current?.chatAnswer(name, text),
        isRoomSpeaking: () => conferenceHandleRef.current?.anyoneSpeaking() ?? false,
        resumePlayers: restoringGame ? resume?.saved.players : undefined,
        usePackPipe: !useBroadcast,
        onSnapshot: (snapshot) => {
          masterSnapshotRef.current = snapshot
          setMasterSnapshot(snapshot)
        },
        // Кто есть кто в Jitsi — в снимок всем (пары и служебные id), не по именам.
        conferenceIds: () => ({ self: handle.localParticipantId(), ...handle.serviceIds() }),
      })
      handle.subscribeServiceIds(() => masterSessionRef.current?.refreshConferenceIds())
      masterSessionRef.current = session
      session.setHearTurnOnly(hearTurnOnlyRef.current)
      const initialRoster = session.rosterList()
      setMasterRoster(initialRoster)
      setMasterRosterAll(session.rosterAll())
      if (restoringGame && resume) {
        session.resumeGame(() => send({ type: 'CONTINUE_GAME', pack, saved: resume.saved }))
      } else {
        setSavedGame(
          persistConferenceLobby({
            packId,
            packFile,
            packHash: hash,
            pack,
            master: { id: 1, name: roomMasterName, score: 0, clientId: masterClientId },
            jitsiUrl: roomJitsi,
            roomId,
            messageRing: masterHistoryRef.current,
            hearTurnOnly,
          }),
        )
      }
      setJoiningStatus(null)
    } catch (error: unknown) {
      setConferenceError(error instanceof Error ? error.message : 'Конференция не открылась')
      setJoiningStatus(null)
      teardownConference()
    }
  }

  async function start() {
    if (!pack || pack.questions.length === 0) return
    if (matchMode === 'conference' && joiningStatus) return
    if (!confirmNewGame(readSavedGame(), (message) => window.confirm(message))) return
    const gameId = crypto.randomUUID()
    void startDebugLogFor(gameId)
    if (matchMode === 'conference') {
      await enterMasterLobby(gameId)
      return
    }
    noteSession({ role: 'стол', gameId, name: playerNames })
    unlockAudio()
    send({ type: 'START_GAME', pack, players: playersFromNames(playerNames) })
  }

  function startLobbyMatch(): void {
    const session = masterSessionRef.current
    if (!session || !pack) return
    const roster = session.rosterList()
    const blocked = roster.filter((entry) => !entry.isMaster && (!entry.ready || !entry.hashOk))
    if (blocked.length > 0) {
      const ok = window.confirm('Не все игроки готовы или не сверили пакет. Начать всё равно?')
      if (!ok) return
    }
    conferenceLobbyRef.current = false
    setConferenceLobby(false)
    session.startGame((players) => {
      unlockAudio()
      send({ type: 'START_GAME', pack, players })
    })
  }

  async function joinConferenceRoom(name: string, asMaster: boolean): Promise<void> {
    if (!inviteParams || joiningStatus) return
    setConferenceError(null)
    setJoiningStatus('Входим…')
    unlockAudio()
    writeConferenceName(name)
    const roomId = inviteParams.roomId
    const baseJitsi = inviteParams.jitsiBase
    writeJitsiUrl(baseJitsi)
    setJitsiUrl(baseJitsi)
    if (asMaster) {
      const saved = readSavedGame()
      setInviteGate('joined')
      if (!saved || readMatchMode(saved) !== 'conference' || saved.roomId !== roomId) return
      setConferenceName(name)
      if (saved.jitsiUrl) setJitsiUrl(saved.jitsiUrl)
      await continueSavedGame(saved, { masterName: name, jitsiBase: baseJitsi })
      return
    }
    const useBroadcast = inviteParams.transport === 'broadcast'
    try {
      setJoiningStatus(useBroadcast ? 'Открываем комнату…' : 'Подключаемся к Jitsi…')
      const handle = await createConferenceTransport({
        roomId,
        useBroadcast,
        jitsiBase: baseJitsi,
        displayName: name,
        onError: conferenceConnectionFailed,
      })
      attachConferenceHandle(handle)
      // Jitsi: эффекты придут от участника «Звуки игры» мастера; локально не дублируем.
      if (!useBroadcast) setGameSoundRoute('remote')
      setConferenceRole('joiner')
      setConferenceRoomId(roomId)
      const wiped = joinDebugLogFor(roomId)
      noteSession({ role: 'игрок', gameId: roomId, name, resumed: !wiped })
      const joiner = new JoinerSession({
        transport: handle.transport,
        clientId: readJoinClientId(),
        authToken: readJoinAuthToken(),
        name,
        usePackPipe: !useBroadcast,
        callbacks: {
          onSnapshot: (snap) => {
            // «Ведущую»/«Звуки игры» игрок узнаёт по id из снимка мастера (не по имени).
            handle.setServiceIds({ host: snap.hostJitsiId, sounds: snap.soundsJitsiId })
            setJoinerSnapshot(snap)
            if (snap.phase !== 'lobby') setConferenceLobby(false)
          },
          onLobby: (state) => setJoinerLobby(state),
          onPackReady: async (bytes, hash) => {
            const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            const parsed = await loadSiq(slice as ArrayBuffer)
            setJoinerPack(parsed)
            packBytesRef.current = bytes
            packHashRef.current = hash
            setLoadedPackHash(hash)
          },
          onError: (message) => setConferenceError(message),
          onFatalError: conferenceConnectionFailed,
        },
      })
      if (sessionStorage.getItem('aisigame.tamperPack') === '1') joiner.setTamperPack(true)
      joinerSessionRef.current = joiner
      joinerFlipPackRef.current = () => {
        sessionStorage.setItem('aisigame.tamperPack', '1')
        joiner.setTamperPack(true)
      }
      setInviteGate('joined')
      setJoiningStatus(null)
    } catch (error: unknown) {
      setConferenceError(error instanceof Error ? error.message : 'Не удалось войти')
      setJoiningStatus(null)
      teardownConference()
    }
  }

  async function continueSavedGame(
    saved: SavedGame,
    conference?: { masterName?: string; jitsiBase?: string },
  ): Promise<void> {
    resumeConferenceOptions.current = conference ?? null
    setHearTurnOnly(hearTurnOnlyOf(saved))
    if (readMatchMode(saved) === 'conference' && saved.packHash) {
      const cached = await getPack(saved.packHash)
      if (cached) {
        try {
          const buffer = cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength)
          const parsed = await loadSiq(buffer as ArrayBuffer)
          if (parsed.questions.length === 0) throw new Error('В пакете нет вопросов')
          skipCatalogLoad.current = true
          cachedResumePackId.current = saved.packId
          loadedPackId.current = saved.packId
          packBytesRef.current = cached
          packHashRef.current = saved.packHash
          setLoadedPackHash(saved.packHash)
          if (saved.packId === ownPackId) {
            setOwnFileName(saved.packFile)
            setOwnFileHash(saved.packHash)
          }
          setPack((current) => {
            revokePackMedia(current)
            return { ...parsed, name: parsed.name || saved.packName }
          })
          setPackId(saved.packId)
          setResumeFileFallback(false)
          setDiskResume(saved)
          return
        } catch (error: unknown) {
          setConferenceError(error instanceof Error ? error.message : 'Сохранённый пакет не прочитался')
        }
      }
      if (resumeNeedsFile(saved, ownPackId)) {
        setResumeFileFallback(true)
        setConferenceError('Сохранённого пакета нет в этом браузере. Выберите исходный файл ещё раз.')
        return
      }
    }
    setPendingContinue(true)
    if (packId !== saved.packId) setPackId(saved.packId)
  }

  function continueGame() {
    const saved = readSavedGame()
    const catalogIds = packCatalog.map((item) => item.id)
    if (!saved || !packCanResume(saved, catalogIds, ownPackId)) return
    unlockAudio()
    if (readMatchMode(saved) !== 'conference') noteSession({ role: 'стол', gameId: debugLogGame(), name: saved.players.map((player) => player.name).join(', '), resumed: true })
    void continueSavedGame(saved)
  }

  async function resumeFromFile(file: File) {
    unlockAudio()
    const saved = readSavedGame()
    if (!saved || !resumeNeedsFile(saved, ownPackId)) return
    const ticket = ++resumeTicket.current
    setReadingResume(true)
    setPackError(null)
    try {
      const bytes = await file.arrayBuffer()
      if (ticket !== resumeTicket.current) return
      const chosenHash = await sha256Hex(bytes.slice(0))
      if (ticket !== resumeTicket.current) return
      const decision = decideResumeFile({
        savedHash: saved.packHash,
        chosenHash,
        fileName: saved.packFile,
      })
      if (!decision.ok) {
        window.alert(decision.message)
        return
      }
      const parsed = await loadSiq(bytes)
      if (ticket !== resumeTicket.current) {
        revokePackMedia(parsed)
        return
      }
      if (parsed.questions.length === 0) {
        revokePackMedia(parsed)
        setPackError('В пакете нет вопросов')
        return
      }
      const named = { ...parsed, name: parsed.name || file.name }
      skipCatalogLoad.current = true
      loadedPackId.current = ownPackId
      setOwnFileHash(chosenHash)
      setOwnFileName(file.name)
      setPack((current) => {
        revokePackMedia(current)
        return named
      })
      setPackId(ownPackId)
      setDiskResume(saved)
    } catch (error: unknown) {
      if (ticket !== resumeTicket.current) return
      setPackError(error instanceof Error ? error.message : 'Пакет не прочитался')
    } finally {
      if (ticket === resumeTicket.current) setReadingResume(false)
    }
  }

  function exitToMenu() {
    suppressSave.current = true
    clearSavedGame()
    void wipeDebugLog()
    setSavedGame(null)
    setHearTurnOnly(false)
    teardownConference()
    send({ type: 'RESET_GAME' })
  }

  function leaveConferenceToMenu(): void {
    teardownConference()
    send({ type: 'RESET_GAME' })
  }

  if (inviteParams && inviteGate === 'pending') {
    return (
      <JoinConfirmScreen
        jitsiHost={jitsiHostFromBase(inviteParams.jitsiBase)}
        busy={Boolean(joiningStatus)}
        status={joiningStatus}
        error={conferenceError}
        onJoin={(name) => {
          const saved = readSavedGame()
          const asMaster =
            saved?.mode === 'conference' &&
            saved.roomId === inviteParams.roomId &&
            readMasterRoomId() === inviteParams.roomId
          void joinConferenceRoom(name, asMaster)
        }}
        onDecline={() => {
          window.history.replaceState({}, '', stripInviteParams(window.location.href))
          setInviteGate('declined')
        }}
      />
    )
  }

  if (!inGame) {
    return (
      <StartScreen
        apiKey={needsKey ? activeKey : ''}
        showKey={showKey}
        link={link}
        error={conferenceError ?? packError ?? snapshot.context.error}
        busy={phase === 'connecting' || pendingContinue || Boolean(joiningStatus)}
        busyStatus={joiningStatus}
        canContinue={packCanResume(
          savedGame,
          packCatalog.map((item) => item.id),
          ownPackId,
        )}
        resumeFromDisk={resumeNeedsFile(savedGame, ownPackId) && (readMatchMode(savedGame) !== 'conference' || resumeFileFallback)}
        resumePackName={resumePackTitle(savedGame, ownPackId)}
        resumeMode={savedGame ? readMatchMode(savedGame) : null}
        readingResume={readingResume}
        loadingPack={loadingPack}
        packId={packId}
        packReady={pack !== null && pack.questions.length > 0}
        needsKey={needsKey}
        modelId={modelId}
        onModel={chooseModel}
        packSummary={packSummary(pack, loadingPack, packId)}
        packWarnings={pack?.warnings ?? []}
        playerNames={playerNames}
        onPlayerNames={editNames}
        onApiKey={rememberKey}
        onToggleKey={() => setShowKey((value) => !value)}
        onClearKey={() => rememberKey('')}
        onPack={choosePack}
        onFile={(file) => void chooseFile(file)}
        onStart={start}
        onContinue={continueGame}
        onResumeFile={(file) => void resumeFromFile(file)}
        modelSwitched={modelSwitched}
        matchMode={matchMode}
        onMatchMode={(mode) => {
          setMatchMode(mode)
          writeStartMatchMode(mode)
        }}
        conferenceName={conferenceName}
        onConferenceName={(value) => {
          setConferenceName(value)
          writeConferenceName(value)
        }}
        jitsiUrl={jitsiUrl}
        onJitsiUrl={(value) => {
          setJitsiUrl(value)
          writeJitsiUrl(value)
        }}
      />
    )
  }

  const joinerRoster: RosterEntry[] = (joinerSnapshot?.presence ?? [])
    .filter((entry) => !entry.hidden)
    .map((entry) => {
      const isSelf = entry.clientId === (conferenceRole === 'joiner' ? readJoinClientId() : '')
      return {
        clientId: entry.clientId,
        name: entry.name,
        playerId: entry.playerId,
        percent: isSelf ? joinerLobby.percent : entry.percent,
        downloadBps: entry.downloadBps ?? null,
        etaSeconds: entry.etaSeconds ?? null,
        packPhase: (isSelf
          ? joinerLobby.packPhase
          : entry.packPhase ?? (entry.hashOk ? (entry.ready ? 'ready' : 'verified') : 'downloading')) as RosterEntry['packPhase'],
        ready: entry.ready,
        hashOk: isSelf ? joinerLobby.hashOk : entry.hashOk,
        // Последний снимок замирает без мастера: локальный masterOffline серит карточку.
        stale: entry.stale || (joinerLobby.masterOffline && entry.isMaster),
        hidden: entry.hidden,
        isMaster: entry.isMaster,
        pingMs: entry.pingMs ?? null,
        lastSeen: 0,
      }
    })
  const hiddenConferenceClientIds = new Set(
    (conferenceRole === 'master'
      ? masterRosterAll
      : joinerSnapshot?.presence ?? []
    )
      .filter((entry) => entry.hidden)
      .map((entry) => entry.clientId),
  )
  const joinerViewContext =
    joinerSnapshot && joinerPack
      ? contextFromSnapshot(joinerSnapshot, joinerPack)
      : conferenceRole === 'joiner' && joinerPack
        ? contextFromSnapshot(
            joinerSnapshot ?? {
              phase: 'lobby',
              pack: null,
              players: [{ id: 1, name: conferenceName || 'Игрок', score: 0, clientId: masterClientId }],
              presence: [],
              jitsiIds: [],
              hostJitsiId: null,
              soundsJitsiId: null,
              roundIndex: joinerPack.rounds[0]?.index ?? 0,
              playedIds: [],
              missedIds: [],
              finalists: [],
              finalCursor: 0,
              activeQuestionId: null,
              chooserId: 1,
              answererId: null,
              falseStartIds: [],
              falseStarts: {},
              bets: {},
              betMisses: 0,
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
              statusLine: 'Ждём игроков',
              phaseDurationMs: null,
              timerRemainingMs: null,
              ...emptyMessageRing(),
            },
            joinerPack,
          )
        : null
  // Мастер и гость рисуют экран из одного снимка: у мастера — из того, что он разослал.
  // Экран мастера — тот же путь, что у гостей (снимок, якорь по моменту получения; у мастера задержка ≈0).
  const masterViewContext = conferenceRole === 'master' && masterSnapshot && pack ? contextFromSnapshot(masterSnapshot, pack) : null
  const viewSnapshot = conferenceRole === 'master' ? (masterViewContext ? masterSnapshot : null) : joinerSnapshot
  const viewContext = conferenceRole === 'master' ? masterViewContext : joinerViewContext
  const joinerSelfId = conferenceRole === 'joiner' ? readJoinClientId() : masterClientId
  const joinerGameStarted = Boolean(joinerSnapshot && joinerSnapshot.phase !== 'lobby')
  const joinerPackReady = Boolean(joinerPack) && joinerLobby.hashOk
  const joinerAwaitingPack = conferenceRole === 'joiner' && joinerGameStarted && !joinerPackReady
  const joinerSelfPresence = joinerRoster.find((entry) => entry.clientId === joinerSelfId)

  return (
    <GameScreen
      snapshot={snapshot}
      link={link}
      onAppeal={async (request) => {
        if (conferenceRole === 'joiner') return joinerSessionRef.current?.sendAppeal(request) ?? { accepted: false, reason: 'Нет связи с мастером' }
        const current = actor.getSnapshot()
        if (conferenceRole === 'master' && current.context.players.find((p) => p.id === request.playerId)?.clientId !== masterClientId) {
          return { accepted: false, reason: 'Чужой игрок' }
        }
        const reason = appealRequestError(current.context, statePath(current.value), request)
        if (reason) return { accepted: false, reason }
        send({ type: 'APPEAL_REQUESTED', ...request })
        const appeal = actor.getSnapshot().context.appeal
        const accepted = appeal?.activePlayerId === request.playerId || Boolean(appeal?.queue.includes(request.playerId))
        return { accepted, reason: accepted ? '' : 'Заявка уже устарела' }
      }}
      onSpecialPick={(pick, playerId) => {
        if (conferenceRole === 'joiner') {
          const session = joinerSessionRef.current
          if (!session) return
          if (pick.target === 'player') session.sendSpecialPick({ target: 'player', playerId: pick.playerId })
          else if (pick.target === 'stake') session.sendSpecialPick({ target: 'stake', amount: pick.amount })
          else session.sendSpecialPick({ target: 'auction', choice: pick.option.kind === 'stake' ? pick.option.amount : pick.option.kind })
          return
        }
        if (pick.target === 'player') send({ type: 'CAT_RECIPIENT', playerId: pick.playerId })
        else if (pick.target === 'stake') send({ type: 'CAT_STAKE', playerId, amount: pick.amount })
        else send({ type: 'AUCTION_BID', playerId, option: pick.option })
      }}
      onBuzz={(playerId: PlayerId) => {
        if (conferenceRole === 'joiner') {
          joinerSessionRef.current?.sendBuzz()
          return
        }
        if (conferenceRole === 'master') {
          const player = actor.getSnapshot().context.players.find((item) => item.id === playerId)
          if (player?.clientId !== masterClientId) return
        }
        send({ type: 'BUZZER_PRESSED', playerId })
      }}
      onPick={(themeId, value) => {
        if (conferenceRole === 'joiner') {
          joinerSessionRef.current?.sendPick(themeId, value)
          return
        }
        if (conferenceRole === 'master') {
          const current = actor.getSnapshot().context
          const chooser = current.players.find((player) => player.id === current.chooserId)
          if (chooser?.clientId !== masterClientId) return
        }
        send({ type: 'QUESTION_SELECTED', themeId, value })
      }}
      onPause={() => {
        // Пауза — «поболтать»: включают и снимают все. Игрок шлёт toggle,
        // мастер решает по своему состоянию. Микрофон конференции не трогаем:
        // люди разговаривают, модельный вход закрыто контроллером (setMicEnabled(false) на 'paused').
        if (conferenceRole === 'joiner') {
          joinerSessionRef.current?.sendPauseToggle()
          return
        }
        if (path === 'paused') {
          send({ type: 'RESUME' })
        } else {
          send({ type: 'PAUSE', path })
        }
      }}
      onStop={() => send({ type: 'STOP' })}
      onReset={exitToMenu}
      onNextRound={() => send({ type: 'NEXT_ROUND' })}
      onAnswerMediaEnded={conferenceRole === 'joiner' ? undefined : () => send({ type: 'ANSWER_MEDIA_ENDED' })}
      modelMeter={conferenceRole === 'master' ? modelMeter : undefined}
      modelId={modelId}
      onModel={switchModel}
      audioJudgment={judgmentMode === 'audio'}
      audioJudgmentSupported={modelId === 'mock' || audioJudgmentCapable(modelId)}
      onAudioJudgmentChange={conferenceRole !== 'joiner' ? changeAudioJudgment : undefined}
      conference={
        conferenceRole
          ? {
              layout: true,
              lobby:
                conferenceRole === 'master'
                  ? conferenceLobby
                  : !joinerGameStarted,
              awaitingPack: joinerAwaitingPack,
              packProgress: joinerAwaitingPack
                ? {
                    percent: joinerLobby.percent,
                    hashOk: joinerLobby.hashOk,
                    ready: joinerLobby.readySent,
                    downloadBps: joinerSelfPresence?.downloadBps ?? null,
                    etaSeconds: joinerSelfPresence?.etaSeconds ?? null,
                    packPhase: joinerLobby.packPhase,
                  }
                : undefined,
              packName:
                conferenceRole === 'joiner'
                  ? joinerLobby.packName || joinerPack?.name || undefined
                  : pack?.name,
              roster: conferenceRole === 'master' ? masterRoster : joinerRoster,
              isMaster: conferenceRole === 'master',
              masterOffline:
                conferenceRole === 'master'
                  ? false
                  : joinerLobby.masterOffline,
              waitingMaster: conferenceRole === 'joiner' && joinerLobby.waitingMaster,
              onLobbyStart: conferenceRole === 'master' ? startLobbyMatch : undefined,
              onReady: () => joinerSessionRef.current?.sendReady(),
              readyDisabled: !joinerLobby.hashOk || joinerLobby.readySent,
              inviteUrl,
              onCopyInvite: conferenceRole === 'master' ? copyInvite : undefined,
              selfClientId: joinerSelfId,
              remoteSnapshot: viewSnapshot,
              remoteContext: viewContext,
              remotePath: viewSnapshot?.phase ?? path,
              tiles: conferenceTiles,
              localMicStream,
              hostSpeaking: conferenceHostSpeaking,
              mediaBusy,
              mediaError: conferenceError,
              onToggleMic: () => void toggleConferenceMic(),
              onToggleCamera: () => void toggleConferenceCamera(),
              onNextCamera: () => void nextConferenceCamera(),
              bindVideo: bindConferenceVideo,
              onSendChat: (text) => {
                if (conferenceRole === 'joiner') joinerSessionRef.current?.sendChat(text)
                else masterSessionRef.current?.sendChat(conferenceName || 'Мастер', text)
              },
              messageRing: conferenceRole === 'master' ? masterHistory : joinerSnapshot ?? emptyMessageRing(),
              onConferenceExit: conferenceRole === 'joiner' ? leaveConferenceToMenu : exitToMenu,
              hiddenClientIds: hiddenConferenceClientIds,
              // Переключатель мастера — его собственный; гостю то же значение приходит снимком.
              hearTurnOnly: conferenceRole === 'master' ? hearTurnOnly : joinerSnapshot?.hearTurnOnly,
              onHearTurnOnlyChange: conferenceRole === 'master' ? setHearTurnOnly : undefined,
              // Пауза в лобби: у мастера — состояние его машины, у гостя — флаг из снимка.
              lobbyPaused:
                conferenceRole === 'master'
                  ? conferenceLobby && path === 'paused'
                  : joinerSnapshot?.lobbyPaused === true,
            }
          : undefined
      }
    />
  )
}

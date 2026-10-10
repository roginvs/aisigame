import { useEffect, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { unlockAudio } from './audio/beep.ts'
import { ownPackId, packCatalog } from './game/catalog.ts'
import { attachController } from './game/controller.ts'
import { defaultPlayerNames, playersFromNames } from './game/players.ts'
import { gameMachine, statePath } from './game/machine.ts'
import {
  clearSavedGame,
  decideResumeFile,
  packCanResume,
  persistMatch,
  readSavedGame,
  resumeFileName,
  resumeNeedsFile,
  resumePackTitle,
  sha256Hex,
  type SavedGame,
} from './game/savedGame.ts'
import { loadSiq, revokePackMedia } from './game/siq.ts'
import { preferredPackId, readStartPrefs, writeStartPrefs } from './game/startPrefs.ts'
import type { PlayerId, QuestionPack } from './game/types.ts'
import type { LinkStatus } from './realtime/client.ts'
import { MockRealtimeClient } from './realtime/mockClient.ts'
import { readProviderKey, readVoiceModelId, voiceById, writeProviderKey, writeVoiceModelId } from './realtime/models.ts'
import { createVoice } from './realtime/voice.ts'
import { GameScreen } from './ui/GameScreen.tsx'
import { StartScreen } from './ui/StartScreen.tsx'

const initialLink: LinkStatus = { connection: 'idle', mic: 'idle', host: 'idle' }
const queryMock = new URLSearchParams(window.location.search).get('mock') === '1'

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
  const [apiKey, setApiKey] = useState(() => readProviderKey('openai'))
  const [xaiKey, setXaiKey] = useState(() => readProviderKey('xai'))
  const [googleKey, setGoogleKey] = useState(() => readProviderKey('google'))
  const [showKey, setShowKey] = useState(false)
  const [link, setLink] = useState<LinkStatus>(initialLink)
  const catalogIds = packCatalog.map((item) => item.id)
  const [packId, setPackId] = useState(() => preferredPackId(readStartPrefs().packId, catalogIds, packCatalog[0].id))
  const [pack, setPack] = useState<QuestionPack | null>(null)
  const [packError, setPackError] = useState<string | null>(null)
  const [loadingPack, setLoadingPack] = useState(true)
  const [savedGame, setSavedGame] = useState<SavedGame | null>(() => readSavedGame())
  const [playerNames, setPlayerNames] = useState(() => readStartPrefs().names || defaultPlayerNames)
  const [ownFileName, setOwnFileName] = useState('')
  const [ownFileHash, setOwnFileHash] = useState('')
  const [pendingContinue, setPendingContinue] = useState(false)
  const [diskResume, setDiskResume] = useState<SavedGame | null>(null)
  const [readingResume, setReadingResume] = useState(false)
  const suppressSave = useRef(false)
  const loadedPackId = useRef<string | null>(null)
  const skipCatalogLoad = useRef(false)
  const resumeTicket = useRef(0)
  const model = voiceById(modelId)
  const needsKey = model.provider !== 'mock'
  const activeKey =
    model.provider === 'xai' ? xaiKey : model.provider === 'google' ? googleKey : model.provider === 'openai' ? apiKey : ''
  const keyRef = useRef(needsKey ? activeKey : 'mock')
  useEffect(() => {
    keyRef.current = needsKey ? activeKey : 'mock'
  }, [needsKey, activeKey])

  useEffect(() => {
    if (packId === ownPackId) return
    skipCatalogLoad.current = false
    const item = packCatalog.find((entry) => entry.id === packId)
    if (!item) return
    let cancelled = false
    loadedPackId.current = null
    setLoadingPack(true)
    setPackError(null)
    fetch(item.href)
      .then((response) => {
        if (!response.ok) throw new Error('Не удалось загрузить пакет')
        return response.arrayBuffer()
      })
      .then((buffer) => loadSiq(buffer))
      .then((parsed) => {
        if (cancelled || skipCatalogLoad.current) {
          revokePackMedia(parsed)
          return
        }
        loadedPackId.current = packId
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
    if (client instanceof MockRealtimeClient) {
      window.__aisigame = {
        hear: (text, durationMs) => client.hear(text, durationMs),
        setSpeechMs: (ms) => client.setSpeechMs(ms),
      }
    }
    const stop = attachController({
      actor,
      client,
      getApiKey: () => keyRef.current,
      setLink,
    })
    return () => {
      delete window.__aisigame
      stop()
    }
  }, [actor, modelId])

  const path = statePath(snapshot.value)
  const phase = path.split('.')[0] ?? path
  const inGame = phase !== 'startMenu' && phase !== 'connecting' && phase !== 'failed'
  const packFile =
    packId === ownPackId
      ? ownFileName
      : (packCatalog.find((item) => item.id === packId)?.href.split('/').pop() ?? `${packId}.siq`)
  const packHash = packId === ownPackId ? ownFileHash : ''

  useEffect(() => {
    if (suppressSave.current) {
      if (path === 'startMenu') {
        clearSavedGame()
        setSavedGame(null)
        suppressSave.current = false
      }
      return
    }
    setSavedGame(persistMatch({ packId, packFile, packHash, path, context: snapshot.context }))
  }, [snapshot, packId, packFile, packHash, path])

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
    send({ type: 'CONTINUE_GAME', pack, saved })
  }, [pendingContinue, packId, loadingPack, pack, send])

  useEffect(() => {
    if (!diskResume) return
    if (packId !== ownPackId || loadedPackId.current !== ownPackId) return
    if (!pack || pack.questions.length === 0) return
    const saved = readSavedGame()
    if (!saved || !resumeNeedsFile(saved, ownPackId)) {
      setDiskResume(null)
      return
    }
    setDiskResume(null)
    unlockAudio()
    send({ type: 'CONTINUE_GAME', pack, saved })
  }, [diskResume, packId, pack, send])

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

  function start() {
    if (!pack || pack.questions.length === 0) return
    unlockAudio()
    send({ type: 'START_GAME', pack, players: playersFromNames(playerNames) })
  }

  function continueGame() {
    const saved = readSavedGame()
    const catalogIds = packCatalog.map((item) => item.id)
    if (!saved || resumeNeedsFile(saved, ownPackId) || !packCanResume(saved, catalogIds, ownPackId)) return
    unlockAudio()
    setPendingContinue(true)
    if (packId !== saved.packId) setPackId(saved.packId)
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
    setSavedGame(null)
    send({ type: 'RESET_GAME' })
  }

  if (!inGame) {
    return (
      <StartScreen
        apiKey={needsKey ? activeKey : ''}
        showKey={showKey}
        link={link}
        error={packError ?? snapshot.context.error}
        busy={phase === 'connecting' || pendingContinue}
        canContinue={packCanResume(
          savedGame,
          packCatalog.map((item) => item.id),
          ownPackId,
        )}
        resumeFromDisk={resumeNeedsFile(savedGame, ownPackId)}
        resumePackName={resumePackTitle(savedGame, ownPackId)}
        resumeFileName={resumeFileName(savedGame, ownPackId)}
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
      />
    )
  }

  return (
    <GameScreen
      snapshot={snapshot}
      link={link}
      onBuzz={(playerId: PlayerId) => send({ type: 'BUZZER_PRESSED', playerId })}
      onPick={(themeId, value) => send({ type: 'QUESTION_SELECTED', themeId, value })}
      onPause={() => {
        if (path === 'paused') send({ type: 'RESUME' })
        else send({ type: 'PAUSE', path })
      }}
      onStop={() => send({ type: 'STOP' })}
      onReset={exitToMenu}
      onNextRound={() => send({ type: 'NEXT_ROUND' })}
      modelLabel={model.label}
    />
  )
}

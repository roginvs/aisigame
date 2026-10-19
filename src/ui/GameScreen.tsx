import { timerFlashKey } from './flash.ts'
import { auctionDingSound, catMeowSound, preloadPublicSound } from '../audio/beep.ts'
import { specialListenerId } from '../game/controller.ts'
import { SpecialPanel, type SpecialPick } from './SpecialPanel.tsx'
import { specialPanelPath } from './specialPanelPath.ts'
import { FinalEntry, FinalRevealStrip } from './FinalEntry.tsx'
import { finalEntryPath, finalRevealPath } from './finalPhase.ts'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import type { SnapshotFrom } from 'xstate'
import { appealButton } from '../game/appeals.ts'
import { AppealConfirm } from './AppealConfirm.tsx'
import { buttonsLive, earlyPickOpen, falseStartCooling, falseStartOpen, gameMachine, statePath } from '../game/machine.ts'
import { falseStartMs } from '../options.ts'
import { currentRound, nextInCell, questionById, roundPrices, roundThemes } from '../game/pack.ts'
import { choiceIsAnswer } from '../game/choices.ts'
import { answerIsPublic, stageMedia, answerMediaVisible } from '../game/reveal.ts'
import type { LinkStatus } from '../realtime/client.ts'
import { voiceById, voiceModels } from '../realtime/models.ts'
import { billedTokens, formatTokens, getUsageSnapshot, subscribeUsage, type UsageTotals } from '../realtime/usage.ts'
import type { AppealRequest, GameContext, PlayerId } from '../game/types.ts'
import type { ConferenceMessageRing, ConferenceSnapshot } from '../conference/messages.ts'
import type { RosterEntry } from '../conference/roster.ts'
import { downloadDebugDump, formatDebugSize } from '../debug/trace.ts'
import type { ConferenceTile } from '../conference/media.ts'
import { ConferenceLobbyStatus } from './ConferenceLobbyStatus.tsx'
import { ConferenceMediaControls } from './ConferenceVideoStrip.tsx'
import { ConferencePlayersRow } from './ConferencePlayersRow.tsx'
import { pauseColumns } from './pauseColumns.ts'
import { AirStatus } from './airStatus.tsx'
import { buzzerLabel } from './buzzerLabel.ts'
import { nudgeActive, nudgeLevelOverride } from './buzzNudge.ts'
import { useBuzzNudge } from './useBuzzNudge.ts'
import { useFitQuestionText } from './questionFit.ts'
import { buzzKeyLabel, isKeyboardPlayer, playerFromBuzzKey } from './buzzKeys.ts'
import { ConversationChat } from './DebugChat.tsx'
import { packProgressLabel } from '../conference/packProgress.ts'
import { canBuzzPlayer, canPickCell, conferenceSoloListenHint, conferenceTurnTitle } from './conferenceTurn.ts'
import { PackAwaitPanel, type PackAwaitProgress } from './PackAwaitPanel.tsx'
import { HostPresence } from './HostPresence.tsx'
import { getHostEar, subscribeHostEar } from '../game/hostEar.ts'
import { tapClick, tapPointerDown } from './tapPress.ts'
import { InviteDialog } from './InviteDialog.tsx'
import { QuestionClip, QuestionMedia } from './QuestionMedia.tsx'
import { questionClipPlaying } from './questionClip.ts'
import { remainingFraction, remainingSeconds } from './timerFraction.ts'
import { ModelInputMeter } from './ModelInputMeter.tsx'

const ignoreConferenceVideoBinding = () => {}

function ModelName(props: { modelId: string; onModel: (id: string) => void }) {
  const { modelId, onModel } = props
  const [open, setOpen] = useState(false)
  const selectRef = useRef<HTMLSelectElement>(null)
  const label = voiceById(modelId).label

  useEffect(() => {
    if (!open) return
    let timer = 0
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && selectRef.current?.contains(target)) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setOpen(false), 0)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  function openList() {
    flushSync(() => setOpen(true))
    const node = selectRef.current
    node?.focus()
    try {
      node?.showPicker()
    } catch {
      // Список уже на экране: браузер откроет его следующим нажатием.
    }
  }

  if (open) {
    return (
      <select
        ref={selectRef}
        className="model-switch"
        aria-label="Модель"
        value={modelId}
        onChange={(event) => {
          const next = event.target.value
          setOpen(false)
          if (next !== modelId) onModel(next)
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setOpen(false)
        }}
      >
        {voiceModels.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
    )
  }

  return (
    <button type="button" className="model-name" title="Сменить модель" onClick={openList}>
      {label}
      <span className="model-caret" aria-hidden="true" />
    </button>
  )
}

function usageHint(totals: UsageTotals): string {
  return `По завершённым ответам: текст ${totals.textIn} (кэш ${totals.cachedTextIn}), аудио ${totals.audioIn} (кэш ${totals.cachedAudioIn}), выход текст ${totals.textOut}, аудио ${totals.audioOut}. Транскрипция отдельно не входит.`
}

export function GameScreen(props: {
  snapshot: SnapshotFrom<typeof gameMachine>
  link: LinkStatus
  /** Мастер конференции: отвод того, что реально слышит модель. */
  modelMeter?: () => AnalyserNode | null
  onAppeal?: (request: AppealRequest) => Promise<{ accepted: boolean; reason: string }>
  onBuzz: (playerId: PlayerId) => void
  /** Кот/аукцион: кнопка «кому отдать», ставка или торг. */
  onSpecialPick?: (pick: SpecialPick, playerId: PlayerId) => void
  onPick: (themeId: string, value: number) => void
  /** Финал: скрытая ставка и скрытый ответ, печатают на табло. */
  onFinalStake?: (playerId: PlayerId, amount: number) => void
  onFinalAnswer?: (playerId: PlayerId, text: string) => void
  onPause: () => void
  onStop: () => void
  onReset: () => void
  onNextRound: () => void
  /** Звук/ролик ответа доиграл (только у того, кто ведёт машину). */
  onAnswerMediaEnded?: () => void
  modelId: string
  onModel: (id: string) => void
  audioJudgment?: boolean
  audioJudgmentSupported?: boolean
  onAudioJudgmentChange?: (value: boolean) => void
  conference?: {
    layout: boolean
    lobby: boolean
    /** Партия в снимке уже идёт, а пакет у этого клиента ещё не готов. */
    awaitingPack?: boolean
    packProgress?: PackAwaitProgress
    packName?: string
    roster: RosterEntry[]
    isMaster: boolean
    masterOffline: boolean
    waitingMaster: boolean
    onLobbyStart?: () => void
    onReady?: () => void
    readyDisabled: boolean
    inviteUrl?: string
    onCopyInvite?: () => Promise<boolean>
    selfClientId?: string
    remoteSnapshot?: ConferenceSnapshot | null
    remoteContext?: GameContext | null
    remotePath?: string
    tiles?: ConferenceTile[]
    hostSpeaking?: boolean
    mediaBusy?: boolean
    onToggleMic?: () => void
    onToggleCamera?: () => void
    onNextCamera?: () => void
    bindVideo?: (participantId: string, element: HTMLVideoElement | null) => void
    mediaError?: string | null
    onSendChat?: (text: string) => void
    messageRing?: ConferenceMessageRing
    onConferenceExit?: () => void
    hiddenClientIds?: ReadonlySet<string>
    /** Собственная дорожка микрофона, опубликованная в Jitsi: локальная подсказка «жми кнопку». */
    localMicStream?: () => MediaStream | null
    /** Только мастер: галка «Меньше слышать» (вне хода — глухо). */
    hearTurnOnly?: boolean
    onHearTurnOnlyChange?: (value: boolean) => void
    /** Пауза в лобби: у машины контроллера в снимке фаза «lobby», флаг идёт отдельным полем. */
    lobbyPaused?: boolean
  }
}) {
  const { snapshot, link, onBuzz, onPick, onPause, onReset, onNextRound, modelId, onModel, conference, onAnswerMediaEnded } = props
  const liveSnapshot = conference?.remoteContext
    ? { ...snapshot, context: conference.remoteContext, value: conference.remotePath ?? snapshot.value }
    : snapshot
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const copyResetRef = useRef(0)
  const [inviteOpen, setInviteOpen] = useState(false)
  const path = conference?.remotePath ?? statePath(liveSnapshot.value)
  const context = liveSnapshot.context
  const [sendingAppeals, setSendingAppeals] = useState<Record<number, string>>({})
  const sendingRef = useRef(new Set<number>())
  const [appealError, setAppealError] = useState('')
  const onAppeal = props.onAppeal
  const modelMeter = props.modelMeter
  const inLobby = Boolean(conference?.lobby)
  // The start form / lobby leave the page scrolled to their bottom buttons; on a scrolling (narrow)
  // page that hid the board above the fold, especially in phone landscape. Start the match at the top.
  useEffect(() => {
    if (!inLobby) window.scrollTo({ top: 0 })
  }, [inLobby])
  useEffect(() => {
    if (!appealError) return
    const timer = window.setTimeout(() => setAppealError(''), 4_000)
    return () => window.clearTimeout(timer)
  }, [appealError])
  const appealStates = Object.fromEntries(context.players.map((p) => {
    const state = appealButton(context, path, p.id)
    return [p.id, state?.enabled && sendingAppeals[p.id] ? { label: 'Отправляется…', enabled: false } : state]
  }))
  const [confirmRequest, setConfirmRequest] = useState<{ playerId: PlayerId; windowId: number } | null>(null)
  const setConfirmAppeal = useCallback((playerId: PlayerId | null) => {
    setConfirmRequest(playerId === null || !context.appeal ? null : { playerId, windowId: context.appeal.windowId })
  }, [context.appeal])
  const sendAppeal = useCallback((playerId: PlayerId) => {
    const state = appealButton(context, path, playerId)
    if (!state?.enabled || sendingRef.current.has(playerId) || !onAppeal || !context.appeal) return
    const request: AppealRequest = { questionId: context.appeal.questionId, windowId: context.appeal.windowId, playerId, requestId: crypto.randomUUID() }
    sendingRef.current.add(playerId)
    setSendingAppeals((previous) => ({ ...previous, [playerId]: request.requestId }))
    setAppealError('')
    void onAppeal(request).then((reply) => {
      if (!reply.accepted) setAppealError(reply.reason)
    }).catch(() => setAppealError('Не удалось отправить апелляцию')).finally(() => {
      sendingRef.current.delete(playerId)
      setSendingAppeals((previous) => { const next = { ...previous }; delete next[playerId]; return next })
    })
  }, [context, path, onAppeal])
  const onPlayerAction = useCallback((playerId: PlayerId) => {
    const player = context.players.find((p) => p.id === playerId)
    if (!player || !canBuzzPlayer(Boolean(conference?.layout), conference?.selfClientId, player)) return
    const state = appealButton(context, path, playerId)
    if (!state) { onBuzz(playerId); return }
    if (!state.enabled || sendingRef.current.has(playerId) || !onAppeal || !context.appeal) return
    // После объявления ответа переответа нет: игрок только подтверждает, что ответил верно.
    if (context.appeal.stage === 'closed') { setConfirmAppeal(playerId); return }
    sendAppeal(playerId)
  }, [context, path, conference?.layout, conference?.selfClientId, onAppeal, onBuzz, sendAppeal, setConfirmAppeal])
  // Подтверждение живёт только в своём окне апелляции.
  const confirmAppeal = confirmRequest && confirmRequest.windowId === context.appeal?.windowId ? confirmRequest.playerId : null
  const confirmState = confirmAppeal === null ? null : appealButton(context, path, confirmAppeal)
  const confirmingId = confirmAppeal !== null && confirmState?.enabled ? confirmAppeal : null
  const confirmYes = () => { if (confirmingId === null) return; setConfirmAppeal(null); sendAppeal(confirmingId) }
  const confirmNo = () => setConfirmAppeal(null)

  async function copyDebug() {
    const result = await downloadDebugDump({ path, context })
    setCopyFeedback(result.ok ? `Скачано ${formatDebugSize(result.bytes)}` : 'Не скачалось')
    window.clearTimeout(copyResetRef.current)
    copyResetRef.current = window.setTimeout(() => setCopyFeedback(null), 2_000)
  }
  useEffect(() => () => window.clearTimeout(copyResetRef.current), [])
  const question = questionById(context.questions, context.activeQuestionId)
  const timerKey = timerFlashKey(path, context.activeQuestionId, context.attemptId)
  const round = currentRound(context, context.roundIndex)
  const prices = roundPrices(context.questions, context.roundIndex)
  const boardThemes = roundThemes(context.questions, context.roundIndex)
  const finalRound = round?.kind === 'final'
  const paused = path === 'paused' || (inLobby && conference?.lobbyPaused === true)
  const stopped = path === 'stopped'
  // Пауза — «поболтать»: главный экран сжимается до надписи, карточки и видео занимают остальное.
  const finishedNow = path === 'finished'
  const [now, setNow] = useState(() => Date.now())
  const penaltyClock = paused && context.pauseStartedAt !== null ? context.pauseStartedAt : now
  const penaltyLive = Object.values(context.falseStarts).some((stamp) => falseStartCooling(stamp, penaltyClock))
  useEffect(() => {
    if (!penaltyLive || paused) return
    const timer = window.setInterval(() => setNow(Date.now()), 50)
    return () => window.clearInterval(timer)
  }, [paused, penaltyLive])
  const [beepCue, setBeepCue] = useState('')
  useEffect(() => {
    let count = 0
    const onBeep = () => {
      count += 1
      setBeepCue(`Короткий сигнал ${count}`)
    }
    window.addEventListener('aisigame-beep', onBeep)
    return () => window.removeEventListener('aisigame-beep', onBeep)
  }, [])
  const usage = useSyncExternalStore(subscribeUsage, getUsageSnapshot, getUsageSnapshot)
  const localEar = useSyncExternalStore(subscribeHostEar, getHostEar, getHostEar)
  useEffect(() => {
    void preloadPublicSound(catMeowSound)
    void preloadPublicSound(auctionDingSound)
  }, [])
  // Мяу/динь играет контроллер (playSpecialSound) на входе в объявление: экран только рисует.
  const buttonsOpen = buttonsLive(path)
  const earlyLive = path === 'reading.armed'
  const canFalseStart = falseStartOpen(path, finalRound)
  // Локальная подсказка «жми кнопку»: только свой игрок, только из полученного состояния и своего микрофона.
  const nudgeSelf = conference?.layout ? context.players.find((player) => canBuzzPlayer(true, conference.selfClientId, player)) : undefined
  const nudgeOn = nudgeActive({
    path,
    finalRound,
    hasSelf: Boolean(nudgeSelf),
    missed: nudgeSelf ? context.missedIds.includes(nudgeSelf.id) : false,
    answering: nudgeSelf ? context.activePlayerId === nudgeSelf.id : false,
    cooling: nudgeSelf ? falseStartCooling(context.falseStarts[nudgeSelf.id], penaltyClock) : false,
    micLive: Boolean((conference?.tiles ?? []).find((tile) => tile.isLocal)?.micLive) || nudgeLevelOverride() !== null,
  })
  const nudgeAt = useBuzzNudge(conference?.localMicStream, nudgeOn)
  const canPick = canPickCell(
    path,
    Boolean(conference?.layout),
    conference?.selfClientId,
    context.chooserId,
    context.players,
    context,
  )
  const hasMatchData = Boolean(!conference?.layout || conference.isMaster || conference.remoteContext)
  const turnTitle = conference?.awaitingPack
    ? null
    : conferenceTurnTitle(path, Boolean(conference?.layout), context)
  const listenFocusName = (() => {
    const root = path.split('.')[0] ?? path
    if (root === 'choosing') {
      return context.players.find((player) => player.id === context.chooserId)?.name ?? null
    }
    if (root === 'answering' || root === 'appealCue') {
      return context.players.find((player) => player.id === context.activePlayerId)?.name ?? null
    }
    if ((root === 'cat' || root === 'auction') && context.special) {
      const id = specialListenerId(path, context)
      return context.players.find((player) => player.id === id)?.name ?? null
    }
    if (root === 'finalBets') {
      return context.players.find((player) => player.id === context.finalists[context.finalCursor])?.name ?? null
    }
    return null
  })()
  const soloListenHint = conference?.awaitingPack
    ? null
    : conferenceSoloListenHint(path, Boolean(conference?.layout), {
        hearTurnOnly: Boolean(conference?.hearTurnOnly),
        focusName: listenFocusName,
      })
  const flashing = path === 'flashing' || (paused && context.resumePath === 'flashing')
  // During a closed-question appeal the board stays visible but not pickable.
  const appealBoard = context.appeal?.stage === 'closed' && (context.appeal.activePlayerId != null || !path.startsWith('announcing'))
  // После закрытой ячейки табло сразу на экране: выбирающий может перебить комментарий.
  const earlyBoard = earlyPickOpen(path, context)
  const showQuestion = Boolean(question) && !flashing && !conference?.awaitingPack && !appealBoard && !earlyBoard
  const showTimer = context.phaseStartedAt !== null && context.phaseDurationMs !== null
  const answerRevealed =
    path.startsWith('announcing') ||
    path === 'finished' ||
    (paused &&
      (context.resumePath.startsWith('announcing') || context.resumePath === 'finished'))
  const showAnswer = Boolean(
    question &&
      answerRevealed &&
      answerIsPublic(context.announceKind, context.playedIds.includes(question.id)),
  )
  const questionMedia = question?.media
  const answerMedia = question?.answerMedia
  // Медиа ответа — при любом исходе с закрытой ячейкой, и после верного (эталон текстом тогда не пишем).
  const showAnswerMedia = Boolean(
    question && answerRevealed && answerMediaVisible(context.announceKind, context.playedIds.includes(question.id)),
  )
  const staged = stageMedia(questionMedia ?? [], answerMedia ?? [], showAnswerMedia)
  const held = paused || stopped
  const questionLive = questionClipPlaying({
    path,
    missedCount: context.missedIds.length,
    held,
    finalRound,
  })
  /** Звук и ролик ответа — после речи ведущей, пока `announcing.holding`. */
  const answerLive =
    showAnswerMedia &&
    !held &&
    (path === 'announcing.holding' || (paused && context.resumePath === 'announcing.holding'))
  const quietQuestion = showAnswerMedia
    ? new Set(
        (questionMedia ?? [])
          .filter((item) => (item.kind === 'audio' || item.kind === 'video') && item.url)
          .map((item) => item.url),
      )
    : undefined
  const visiblePlayers = context.players.filter(
    (player) => !player.clientId || !conference?.hiddenClientIds?.has(player.clientId),
  )

  useEffect(() => {
    if (conference?.layout) {
      const self = context.players.find((player) => canBuzzPlayer(true, conference.selfClientId, player))
      if (!self || conference.lobby) return
      const selfPlayerId = self.id
      function onKeyDown(event: KeyboardEvent) {
        if (event.code !== 'Space' || event.repeat) return
        const target = event.target
        if (target instanceof HTMLElement && target.closest('input, textarea, select, .model-name, [contenteditable="true"]')) return
        event.preventDefault()
        onPlayerAction(selfPlayerId)
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, .model-name, [contenteditable="true"]')) return
      const playerId = playerFromBuzzKey(event.code, {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      })
      if (!playerId) return
      event.preventDefault()
      onPlayerAction(playerId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onPlayerAction, conference?.layout, conference?.lobby, conference?.selfClientId, context.players])

  const mainClass = [
    'table',
    conference?.layout ? 'conference-layout' : '',
    conference && !conference.isMaster ? 'joiner-view' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <main className={mainClass}>
      <p className="visually-hidden" role="status" aria-live="assertive">
        {beepCue}
      </p>
      <header className="topbar">
        <div>
          <p className="eyebrow model-line">
            <span>
              {conference?.awaitingPack
                ? [conference.packName || context.packName, 'Загрузка'].filter(Boolean).join(' · ')
                : conference?.lobby
                  ? [context.packName || conference.packName, 'Лобби'].filter(Boolean).join(' · ')
                  : [context.packName, round?.name].filter(Boolean).join(' · ') || 'Раунд'}
            </span>
            {conference && !conference.isMaster ? null : (
              <>
                {' · '}
                <ModelName modelId={modelId} onModel={onModel} />
              </>
            )}
            {/* Только мастер: выход микшера (тот же узел, что уходит в модель). Игрокам не показываем. */}
            {(!conference || conference.isMaster) && modelMeter ? (
              <>
                {' '}
                <ModelInputMeter getAnalyser={modelMeter} />
              </>
            ) : null}
          </p>
          <h1>Своя игра</h1>
        </div>
        <div className="pills">
          {conference && !conference.isMaster ? null : (
            <>
              <span className="cost" title={usageHint(usage.totals)}>
                {formatTokens(billedTokens(usage.totals))}
              </span>
              <AirStatus link={link} />
            </>
          )}
          {/* Пауза — «поболтать»: включают и снимают все. */}
          <button type="button" className={paused ? 'ghost pause-on' : 'ghost'} onClick={onPause} disabled={stopped} aria-label={paused ? 'Дальше' : 'Пауза'} title={paused ? 'Дальше' : 'Пауза'}>
            <span aria-hidden="true">{paused ? '▶' : '⏸'}</span>
            <span className="btn-label" aria-hidden="true">{paused ? 'Дальше' : 'Пауза'}</span>
          </button>
          {conference?.layout && (paused || finishedNow) ? (
            /* Пауза: колонка разговора с кнопками mic/cam скрыта — управление переносится в шапку. */
            <div className="pills header-media" aria-label="Микрофон и камера">
              <ConferenceMediaControls
                micLive={Boolean((conference.tiles ?? []).find((tile) => tile.isLocal)?.micLive)}
                cameraOn={Boolean((conference.tiles ?? []).find((tile) => tile.isLocal)?.cameraOn)}
                mediaBusy={conference.mediaBusy}
                onToggleMic={() => conference.onToggleMic?.()}
                onToggleCamera={() => conference.onToggleCamera?.()}
                onNextCamera={() => conference.onNextCamera?.()}
              />
            </div>
          ) : null}
          {conference?.onCopyInvite ? (
            <button
              type="button"
              className="ghost invite-link"
              aria-haspopup="dialog"
              aria-label="Ссылка для игры"
              title="Ссылка для игры"
              onClick={() => setInviteOpen(true)}
            >
              <span aria-hidden="true">🔗</span>
              <span className="btn-label" aria-hidden="true">Ссылка для игры</span>
            </button>
          ) : null}
          <button
            type="button"
            className="ghost"
            aria-label="Выход"
            title="Выход"
            onClick={() => {
              if (window.confirm('Выйти из игры?')) {
                (conference?.onConferenceExit ?? onReset)()
              }
            }}
          >
            <span aria-hidden="true">🚪</span>
            <span className="btn-label" aria-hidden="true">Выход</span>
          </button>
          <button
            type="button"
            className="ghost debug-copy"
            aria-label={copyFeedback ?? 'Скачать дебаг'}
            title={copyFeedback ?? 'Скачать дебаг'}
            onClick={() => void copyDebug()}
          >
            <span aria-hidden="true">🔧</span>
            <span className="debug-copy-label btn-label" aria-hidden="true">
              <span className={copyFeedback ? 'debug-copy-hidden' : undefined}>Скачать дебаг</span>
              <span className={copyFeedback ? undefined : 'debug-copy-hidden'}>
                {copyFeedback ?? 'Скачано ~0 КБ'}
              </span>
              <span className="debug-copy-reserve">Скачано ~999 МБ</span>
            </span>
          </button>
          {conference && !conference.isMaster ? null : (
            <button
              type="button"
              className="ghost"
              title="Для проверки: закончить раунд с тем же счётом"
              aria-label="Пропустить раунд"
              onClick={onNextRound}
              disabled={!snapshot.can({ type: 'NEXT_ROUND' })}
            >
              <span aria-hidden="true">⏭</span>
              <span className="btn-label" aria-hidden="true">Пропустить раунд</span>
            </button>
          )}
        </div>
      </header>

      <section className={paused || finishedNow ? 'layout is-paused' : 'layout'}>
        <div className={paused || finishedNow ? 'play is-paused' : 'play'}>
        <div className="stage">
        {paused || finishedNow ? (
          <div className={paused ? 'stage-pause' : 'stage-pause is-finished'}>
            <span aria-hidden="true">{paused ? 'Пауза' : 'Игра окончена'}</span>
            <span className="visually-hidden">{paused ? 'Пауза' : 'Игра окончена'}</span>
          </div>
        ) : (
        <>
        {conference?.masterOffline && !conference.waitingMaster ? (
          <p className="error banner">Мастер-игрок отключился</p>
        ) : null}
        {conference?.awaitingPack && conference.packProgress ? (
          <PackAwaitPanel progress={conference.packProgress} packName={conference.packName} />
        ) : finalEntryPath(path, context) ? (
          <FinalEntry
            context={context}
            kind={path === 'finalBets.collecting' || (path === 'paused' && context.resumePath === 'finalBets.collecting') ? 'stake' : 'answer'}
            canAct={(playerId) => {
              const player = context.players.find((item) => item.id === playerId)
              return Boolean(player && props.onFinalStake && props.onFinalAnswer && canBuzzPlayer(Boolean(conference?.layout), conference?.selfClientId, player))
            }}
            onSubmit={(playerId, value) => {
              if (typeof value === 'number') props.onFinalStake?.(playerId, value)
              else props.onFinalAnswer?.(playerId, value)
            }}
            timer={showTimer && context.phaseStartedAt !== null && context.phaseDurationMs !== null
              ? <Countdown key={timerKey} startedAt={context.phaseStartedAt} durationMs={context.phaseDurationMs} />
              : null}
          />
        ) : specialPanelPath(path, context) ? (
          <SpecialPanel
            context={context}
            path={path}
            canAct={(playerId) => {
              const player = context.players.find((item) => item.id === playerId)
              return Boolean(player && props.onSpecialPick && canBuzzPlayer(Boolean(conference?.layout), conference?.selfClientId, player))
            }}
            onPick={(pick) => {
              const special = context.special
              if (!special) return
              props.onSpecialPick?.(pick, pick.target === 'player' ? special.giverId : (special.recipientId ?? special.giverId))
            }}
            timer={showTimer && context.phaseStartedAt !== null && context.phaseDurationMs !== null
              ? <Countdown key={timerKey} startedAt={context.phaseStartedAt} durationMs={context.phaseDurationMs} />
              : null}
          />
        ) : showQuestion && question ? (
          <article className={question.choices?.length ? 'question has-choices' : 'question'}>
            <p className="eyebrow">
              {question.themeName} · {question.value}
            </p>
            <QuestionText text={question.text} />
            {finalRevealPath(path) ? <FinalRevealStrip context={context} /> : null}
            {question.choices?.length ? (
              <ul className="choices" aria-label="Варианты ответа">
                {question.choices.map((choice) => (
                  <li
                    key={choice.label}
                    className={showAnswer && choiceIsAnswer(choice, question.answers) ? 'is-right' : undefined}
                  >
                    <span className="choice-label">{choice.label}</span>
                    <span className="choice-body">
                      {choice.text ? <span>{choice.text}</span> : null}
                      {choice.media.map((item) => {
                        if (!item.url) return <span key={item.name}>Файл не найден: {item.name}</span>
                        if (item.kind === 'image') return <img key={item.url} src={item.url} alt="Иллюстрация варианта" />
                        return (
                          <QuestionClip
                            key={item.url}
                            kind={item.kind}
                            url={item.url}
                            live={questionLive && !showAnswer}
                            label={item.kind === 'audio' ? 'Звук варианта' : 'Ролик варианта'}
                          />
                        )
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <QuestionMedia
              media={staged.slot}
              play={showAnswerMedia ? answerLive : questionLive}
              quiet={quietQuestion}
              onAnswerEnded={onAnswerMediaEnded}
              answerUrls={new Set(staged.answerVisual.map((item) => item.url))}
            />
            {showTimer && context.phaseStartedAt !== null && context.phaseDurationMs !== null ? (
              <Countdown key={timerKey} startedAt={context.phaseStartedAt} durationMs={context.phaseDurationMs} />
            ) : null}
            {showAnswerMedia ? <QuestionMedia media={staged.answerAudio} play={answerLive} answer onAnswerEnded={onAnswerMediaEnded} /> : null}
          </article>
        ) : conference?.lobby ? (
          <ConferenceLobbyStatus
            waitingMaster={conference.waitingMaster}
            masterOffline={conference.masterOffline}
            banner={false}
          />
        ) : (
        <div className="board" role="grid" aria-label="Игровое поле">
          {finalRound ? (
            <div className="final-themes">
              {boardThemes.map((theme) => {
                const cell = nextInCell(context.questions, context.roundIndex, theme.id, null, context.playedIds)
                const played = !cell
                return (
                  <button
                    key={theme.id}
                    type="button"
                    className={cellClass(cell?.id === context.activeQuestionId, played, flashing)}
                    disabled={!canPick || played || !cell}
                    aria-label={played ? `${theme.name}, сыграно` : theme.name}
                    onClick={() => cell && onPick(theme.id, 0)}
                  >
                    {theme.name}
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              <div
                className="theme-row"
                style={{ gridTemplateColumns: `var(--theme-column-width, 120px) repeat(${prices.length}, minmax(0, 1fr))` }}
              >
                <div className="corner" />
                {prices.map((value) => (
                  <div key={value} className="head">
                    {value}
                  </div>
                ))}
              </div>
              {boardThemes.map((theme) => (
                <div
                  key={theme.id}
                  className="theme-row"
                  style={{ gridTemplateColumns: `var(--theme-column-width, 120px) repeat(${prices.length}, minmax(0, 1fr))` }}
                >
                  <div className="theme-name">{theme.name}</div>
                  {prices.map((value) => {
                    const cell = nextInCell(
                      context.questions,
                      context.roundIndex,
                      theme.id,
                      value,
                      context.playedIds,
                    )
                    const played = !cell
                    const current = cell?.id === context.activeQuestionId
                    return (
                      <button
                        key={value}
                        type="button"
                        className={cellClass(current, played, flashing)}
                        disabled={!canPick || played || !cell}
                        aria-label={played ? `${theme.name}, ${value}, сыграно` : `${theme.name}, ${value}`}
                        onClick={() => cell && onPick(theme.id, value)}
                      >
                        {played ? '—' : value}
                      </button>
                    )
                  })}
                </div>
              ))}
            </>
          )}
        </div>
        )}
        </>
        )}
        </div>

      {appealError ? <p role="status" className="status-line">{appealError}</p> : null}
      {conference?.layout ? (
        <ConferencePlayersRow
          mode={conference.lobby || conference.awaitingPack ? 'lobby' : 'match'}
          tiles={conference.tiles ?? []}
          bindVideo={conference.bindVideo ?? ignoreConferenceVideoBinding}
          selfClientId={conference.selfClientId}
          jitsiIds={conference.remoteSnapshot?.jitsiIds}
          roster={conference.roster}
          players={visiblePlayers}
          hasMatchData={hasMatchData}
          path={path}
          activePlayerId={context.activePlayerId}
          chooserId={context.chooserId}
          missedIds={context.missedIds}
          falseStarts={context.falseStarts}
          penaltyClock={penaltyClock}
          paused={paused}
          buttonsOpen={buttonsOpen}
          canFalseStart={canFalseStart}
          earlyLive={earlyLive}
          appealStates={appealStates}
          confirmingId={confirmingId}
          onConfirmYes={confirmYes}
          onConfirmNo={confirmNo}
          onBuzz={onPlayerAction}
          nudgePlayerId={nudgeAt ? nudgeSelf?.id ?? null : null}
          layout
        />
      ) : (
        <section
          className="players"
          style={paused || finishedNow ? ({ '--pause-cols': String(pauseColumns(visiblePlayers.length)) } as CSSProperties) : undefined}
        >
          {visiblePlayers.map((player) => {
            const playerId = player.id
            const active = context.activePlayerId === playerId
            const missed = context.missedIds.includes(playerId)
            const appealState = appealStates[playerId]
            const chooses = path.startsWith('choosing') && context.chooserId === playerId
            const flareAt = context.falseStarts[playerId]
            const cooling = falseStartCooling(flareAt, penaltyClock)
            const key = isKeyboardPlayer(playerId) ? buzzKeyLabel[playerId] : ''
            return (
              <div
                key={playerId}
                className={['player', active ? 'active' : ''].filter(Boolean).join(' ')}
                role="group"
                aria-label={`${player.name}: ${player.score}`}
              >
                <div className="player-meta">
                  <strong>{player.name}</strong>
                  <span>{player.score}</span>
                </div>
                {confirmingId === playerId ? <AppealConfirm onYes={confirmYes} onNo={confirmNo} /> : (
                <button
                  type="button"
                  key={cooling ? 'penalty' : 'ready'}
                  className={['buzzer', chooses ? 'chooser' : '', cooling ? 'false-start' : '']
                    .filter(Boolean)
                    .join(' ')}
                  style={
                    cooling
                      ? {
                          animationDuration: `${falseStartMs}ms`,
                          animationPlayState: paused ? 'paused' : 'running',
                        }
                      : undefined
                  }
                  disabled={appealState ? !appealState.enabled : cooling || ((missed || !buttonsOpen) && !canFalseStart)}
                  onPointerDown={(event) => tapPointerDown(event, () => onPlayerAction(playerId))}
                    onClick={(event) => tapClick(event, () => onPlayerAction(playerId))}
                >
                  {buzzerLabel({ appealLabel: appealState?.label, cooling, normal: chooses ? 'выбирайте вопрос' : missed ? 'Уже отвечал' : player.name })}
                  {earlyLive ? <span className="visually-hidden">, вопрос ещё читается</span> : null}
                </button>
                )}
                <p className="key-hint">{key ? (earlyLive ? `${key} · уже можно` : key) : ''}</p>
              </div>
            )
          })}
        </section>
      )}
        </div>
        <aside className="talk">
          <HostPresence
            path={path}
            link={conference?.remoteSnapshot?.hostLink ? { ...link, ...conference.remoteSnapshot.hostLink } : link}
            ear={conference?.remoteSnapshot ? conference.remoteSnapshot.hostEar ?? 'idle' : localEar}
            title={turnTitle}
            titleHint={soloListenHint}
            lobbyInvite={Boolean(conference?.lobby)}
            status={
              conference?.masterOffline && !conference.waitingMaster
                ? ''
                : conference?.awaitingPack && conference.packProgress
                  ? packProgressLabel(conference.packProgress)
                  : conference?.lobby
                    ? conference.waitingMaster
                      ? 'Ждём мастер-игрока'
                      : 'Ждём начала игры'
                    : context.statusLine
            }
            error={
              conference?.masterOffline && !conference.waitingMaster
                ? 'Мастер-игрок отключился'
                : (conference?.mediaError ?? context.error)
            }
            conferenceSpeaking={conference?.hostSpeaking}
            audioJudgment={props.audioJudgment}
            audioJudgmentSupported={props.audioJudgmentSupported}
            onAudioJudgmentChange={props.onAudioJudgmentChange}
            hearTurnOnly={conference?.hearTurnOnly}
            onHearTurnOnlyChange={conference?.isMaster ? conference.onHearTurnOnlyChange : undefined}
          />
          <ConversationChat
            messageRing={conference?.messageRing ?? conference?.remoteSnapshot ?? undefined}
            liveSpeech={conference?.remoteSnapshot ? conference.remoteSnapshot.liveSpeech ?? null : undefined}
            players={context.players}
            onSendChat={conference?.onSendChat}
            aboveComposer={
              conference?.layout ? (
                <>
                  {conference.lobby && !conference.awaitingPack && conference.isMaster && conference.onLobbyStart ? (
                    <button type="button" className="primary chat-lobby-start" onClick={conference.onLobbyStart}>
                      Начать игру
                    </button>
                  ) : null}
                  {conference.lobby && !conference.awaitingPack && !conference.isMaster && conference.onReady ? (
                    <button
                      type="button"
                      className="primary chat-lobby-start"
                      disabled={conference.readyDisabled}
                      onClick={conference.onReady}
                    >
                      Я в игре
                    </button>
                  ) : null}
                  <ConferenceMediaControls
                    micLive={Boolean((conference.tiles ?? []).find((tile) => tile.isLocal)?.micLive)}
                    cameraOn={Boolean((conference.tiles ?? []).find((tile) => tile.isLocal)?.cameraOn)}
                    mediaBusy={conference.mediaBusy}
                    onToggleMic={() => conference.onToggleMic?.()}
                    onToggleCamera={() => conference.onToggleCamera?.()}
                    onNextCamera={() => conference.onNextCamera?.()}
                  />
                </>
              ) : null
            }
          />
        </aside>
      </section>
      {inviteOpen && conference?.inviteUrl && conference.onCopyInvite ? (
        <InviteDialog
          url={conference.inviteUrl}
          onCopy={conference.onCopyInvite}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}
    </main>
  )
}

function cellClass(current: boolean, played: boolean, flashing: boolean): string {
  if (current && flashing) return 'cell current flash'
  if (current) return 'cell current'
  if (played) return 'cell played'
  return 'cell'
}

function Countdown(props: { startedAt: number; durationMs: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let frame = 0
    const tick = () => {
      setNow(Date.now())
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [props.startedAt, props.durationMs])
  const fraction = remainingFraction(props.startedAt, props.durationMs, now)
  const secondsLeft = remainingSeconds(props.startedAt, props.durationMs, now)
  return (
    <div
      className="timer-bar"
      role="meter"
      aria-label="Оставшееся время"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.ceil(props.durationMs / 1000))}
      aria-valuenow={secondsLeft}
    >
      <span className="timer-fill" style={{ transform: `scaleX(${fraction})` }} />
      <span className="visually-hidden">Осталось {secondsLeft} с</span>
    </div>
  )
}

/** Текст вопроса: шрифт подгоняется, чтобы текст был виден целиком (см. `questionFit.ts`). */
function QuestionText({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useFitQuestionText(ref, text)
  return <h2 ref={ref}>{text}</h2>
}

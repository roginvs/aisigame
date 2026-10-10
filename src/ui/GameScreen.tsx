import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SnapshotFrom } from 'xstate'
import { buttonsLive, falseStartCooling, falseStartOpen, gameMachine, statePath } from '../game/machine.ts'
import { falseStartMs } from '../options.ts'
import { currentRound, nextInCell, questionById, roundPrices, roundThemes } from '../game/pack.ts'
import { choiceIsAnswer } from '../game/choices.ts'
import { answerIsPublic, stageMedia } from '../game/reveal.ts'
import type { LinkStatus } from '../realtime/client.ts'
import { billedTokens, formatTokens, getUsageSnapshot, subscribeUsage, type UsageTotals } from '../realtime/usage.ts'
import type { PlayerId } from '../game/types.ts'
import { copyDebugDump } from '../debug/trace.ts'
import { AirStatus } from './airStatus.tsx'
import { buzzKeyLabel, isKeyboardPlayer, playerFromBuzzKey } from './buzzKeys.ts'
import { ConversationChat } from './DebugChat.tsx'
import { HostPresence } from './HostPresence.tsx'
import { QuestionClip, QuestionMedia } from './QuestionMedia.tsx'
import { questionClipPlaying } from './questionClip.ts'
import { remainingFraction, remainingSeconds } from './timerFraction.ts'

function usageHint(totals: UsageTotals): string {
  return `По завершённым ответам: текст ${totals.textIn} (кэш ${totals.cachedTextIn}), аудио ${totals.audioIn} (кэш ${totals.cachedAudioIn}), выход текст ${totals.textOut}, аудио ${totals.audioOut}. Транскрипция отдельно не входит.`
}

export function GameScreen(props: {
  snapshot: SnapshotFrom<typeof gameMachine>
  link: LinkStatus
  onBuzz: (playerId: PlayerId) => void
  onPick: (themeId: string, value: number) => void
  onPause: () => void
  onStop: () => void
  onReset: () => void
  onNextRound: () => void
  modelLabel: string
}) {
  const { snapshot, link, onBuzz, onPick, onPause, onReset, onNextRound, modelLabel } = props
  const [copyLabel, setCopyLabel] = useState('Скопировать дебаг')
  const path = statePath(snapshot.value)
  const context = snapshot.context
  async function copyDebug() {
    const ok = await copyDebugDump({ path, context })
    setCopyLabel(ok ? 'Скопировано' : 'Не скопировалось')
    window.setTimeout(() => setCopyLabel('Скопировать дебаг'), 1600)
  }
  const question = questionById(context.questions, context.activeQuestionId)
  const round = currentRound(context, context.roundIndex)
  const prices = roundPrices(context.questions, context.roundIndex)
  const boardThemes = roundThemes(context.questions, context.roundIndex)
  const finalRound = round?.kind === 'final'
  const paused = path === 'paused'
  const stopped = path === 'stopped'
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
  const usage = useSyncExternalStore(subscribeUsage, getUsageSnapshot)
  const buttonsOpen = buttonsLive(path)
  const earlyLive = path === 'reading.armed'
  const canFalseStart = falseStartOpen(path, finalRound)
  const canPick = path === 'choosing.listening'
  const flashing = path === 'flashing' || (paused && context.resumePath === 'flashing')
  const showQuestion = Boolean(question) && !flashing
  const showTimer = context.phaseStartedAt !== null && context.phaseDurationMs !== null
  const answerRevealed =
    path === 'announcing' ||
    path === 'finished' ||
    (paused && (context.resumePath === 'announcing' || context.resumePath === 'finished'))
  const showAnswer = Boolean(
    question &&
      answerRevealed &&
      answerIsPublic(context.announceKind, context.playedIds.includes(question.id)),
  )
  const questionMedia = question?.media
  const answerMedia = question?.answerMedia
  const staged = useMemo(
    () => stageMedia(questionMedia ?? [], answerMedia ?? [], showAnswer),
    [questionMedia, answerMedia, showAnswer],
  )
  const held = paused || stopped
  const questionLive = questionClipPlaying({
    path,
    missedCount: context.missedIds.length,
    held,
    finalRound,
  })
  const answerLive = showAnswer && !held
  const quietQuestion = showAnswer
    ? new Set(
        (questionMedia ?? [])
          .filter((item) => (item.kind === 'audio' || item.kind === 'video') && item.url)
          .map((item) => item.url),
      )
    : undefined

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return
      const playerId = playerFromBuzzKey(event.code, {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      })
      if (!playerId) return
      event.preventDefault()
      onBuzz(playerId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBuzz])

  return (
    <main className="table">
      <p className="visually-hidden" role="status" aria-live="assertive">
        {beepCue}
      </p>
      <header className="topbar">
        <div>
          <p className="eyebrow">{[context.packName, round?.name, modelLabel].filter(Boolean).join(' · ') || 'Раунд'}</p>
          <h1>Своя игра</h1>
        </div>
        <div className="pills">
          <span className="cost" title={usageHint(usage.totals)}>
            {formatTokens(billedTokens(usage.totals))}
          </span>
          <AirStatus link={link} />
          <button type="button" className={paused ? 'ghost pause-on' : 'ghost'} onClick={onPause} disabled={stopped}>
            {paused ? '▶ Дальше' : '⏸ Пауза'}
          </button>
          <button type="button" className="ghost" onClick={onReset}>
            🚪 Выход
          </button>
          <button type="button" className="ghost" onClick={() => void copyDebug()}>
            🔧 {copyLabel}
          </button>
          <button
            type="button"
            className="ghost"
            title="Для проверки: закончить раунд с тем же счётом"
            onClick={onNextRound}
            disabled={!snapshot.can({ type: 'NEXT_ROUND' })}
          >
            ⏭ Пропустить раунд
          </button>
        </div>
      </header>

      <section className="layout">
        <div className="play">
        <div className="stage">
        {showQuestion && question ? (
          <article className="question">
            <p className="eyebrow">
              {question.themeName} · {question.value}
            </p>
            <h2>{question.text}</h2>
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
              play={showAnswer ? answerLive : questionLive}
              quiet={quietQuestion}
              answerUrls={new Set(staged.answerVisual.map((item) => item.url))}
            />
            {context.activePlayerId ? <p className="answerer">Отвечает игрок {context.activePlayerId}</p> : null}
            {showTimer && context.phaseStartedAt !== null && context.phaseDurationMs !== null ? (
              <Countdown startedAt={context.phaseStartedAt} durationMs={context.phaseDurationMs} />
            ) : null}
            {context.heard ? <p>Разобрала: {context.heard}</p> : null}
            {showAnswer ? (
              <>
                <p className="etalon">Правильный ответ: {question.answers.join(', ')}</p>
                <QuestionMedia media={staged.answerAudio} play={answerLive} answer />
              </>
            ) : null}
          </article>
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
              <div className="theme-row" style={{ gridTemplateColumns: `120px repeat(${prices.length}, minmax(0, 1fr))` }}>
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
                  style={{ gridTemplateColumns: `120px repeat(${prices.length}, minmax(0, 1fr))` }}
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
        </div>

      <section className="players">
        {context.players.map((player) => {
          const playerId = player.id
          const active = context.activePlayerId === playerId
          const missed = context.missedIds.includes(playerId)
          const chooses = path.startsWith('choosing') && context.chooserId === playerId
          const flareAt = context.falseStarts[playerId]
          const cooling = falseStartCooling(flareAt, penaltyClock)
          const key = isKeyboardPlayer(playerId) ? buzzKeyLabel[playerId] : ''
          return (
            <div key={playerId} className={active ? 'player active' : 'player'} role="group" aria-label={`${player.name}: ${player.score}`}>
              <div className="player-meta">
                <strong>{player.name}</strong>
                <span>{player.score}</span>
              </div>
              <button
                type="button"
                key={cooling ? 'penalty' : 'ready'}
                className={['buzzer', chooses ? 'chooser' : '', cooling ? 'false-start' : ''].filter(Boolean).join(' ')}
                style={
                  cooling
                    ? { animationDuration: `${falseStartMs}ms`, animationPlayState: paused ? 'paused' : 'running' }
                    : undefined
                }
                disabled={cooling || ((missed || !buttonsOpen) && !canFalseStart)}
                onClick={() => onBuzz(playerId)}
              >
                {chooses ? 'выбирайте вопрос' : missed ? 'Уже отвечал' : player.name}
                {earlyLive ? <span className="visually-hidden">, вопрос ещё читается</span> : null}
              </button>
              <p className="key-hint">{key ? (earlyLive ? `${key} · уже можно` : key) : ''}</p>
            </div>
          )
        })}
      </section>
        </div>
        <aside className="talk">
          <HostPresence path={path} link={link} status={context.statusLine} error={context.error} />
          <ConversationChat />
        </aside>
      </section>
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

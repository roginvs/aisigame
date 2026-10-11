import type { Actor, SnapshotFrom } from 'xstate'
import { playTimeoutBeep } from '../audio/beep.ts'
import { gameConfig } from '../config.ts'
import { noteLink, pushJudgeLine, pushPlayerLine, pushTrace } from '../debug/trace.ts'
import type { GameVoice, LinkStatus, ToolCall } from '../realtime/client.ts'
import { verbatimSpeech, withPlayNote } from '../realtime/speechMatch.ts'
import { parseBet } from './bet.ts'
import { questionSpeech, spokenChoiceForms } from './choices.ts'
import { matchSpokenCell, selectionChatText } from './choiceMatch.ts'
import { answerListeningPrompt, echoesAnswerPrompt } from './answerPrompt.ts'
import { choicePrompt, echoesChoicePrompt } from './choicePrompt.ts'
import { blurtGate, choiceGate, repeatsQuestion } from './heard.ts'
import { judgmentChatText, settleJudgment } from './judgment.ts'
import { currentRound, findQuestion, questionById, roundThemes } from './pack.ts'
import { answerIsPublic, chatAnswerNote } from './reveal.ts'
import { gameMachine, isReadingPath, phoneticRetryReason, statePath } from './machine.ts'
import { falseStartLine, playerName } from './players.ts'
import { spokenAnswerCue } from './spokenAnswer.ts'
import type { AnnounceKind, GameContext, JudgmentStatus, SpeechPurpose } from './types.ts'

type GameActor = Actor<typeof gameMachine>

export type GameControllerActions = {
  remindMutedAnswerer: (playerName: string) => void
}

const judgmentStatuses: JudgmentStatus[] = [
  'correct',
  'incorrect',
  'needs_clarification',
  'unintelligible',
  'ambiguous',
]

export function attachController(options: {
  actor: GameActor
  client: GameVoice
  getApiKey: () => string
  setLink: (update: (current: LinkStatus) => LinkStatus) => void
  /** Конференция: лобби на startMenu — сессию голоса не рвём. */
  keepVoiceSession?: () => boolean
  /** Конференция: модель уже подключена до START_GAME. */
  voiceAlreadyConnected?: () => boolean
  /** Дополнительные реплики конференции, которые не меняют состояние партии. */
  onActions?: (actions: GameControllerActions | null) => void
}): () => void {
  const { actor, client, getApiKey, setLink, keepVoiceSession, voiceAlreadyConnected, onActions } = options
  let previousPath = statePath(actor.getSnapshot().value)
  let connectToken = 0
  let speechTurn = 0
  let toolTurn = 0
  let choiceToken = 0
  let choiceHeard = ''
  let answerItemId: string | null = null
  let answerTranscript = ''
  let answerConfidence: number | null = null
  let judgeToken = 0
  let buzzerEarAt = 0
  let overRead = false
  const held: Array<() => void> = []
  let announceWait: { token: number; timer: ReturnType<typeof setTimeout>; say: () => void } | null = null
  let announceToken = 0
  let buzzerWarning: number | null = null

  function clearBuzzerWarning(): void {
    if (buzzerWarning === null) return
    window.clearTimeout(buzzerWarning)
    buzzerWarning = null
  }

  function armBuzzerWarning(durationMs: number): void {
    clearBuzzerWarning()
    const delay = buzzerWarningDelay(durationMs)
    if (delay === null) return
    buzzerWarning = window.setTimeout(() => {
      buzzerWarning = null
      if (!buzzerChimeLive(statePath(actor.getSnapshot().value))) return
      playTimeoutBeep()
    }, delay)
  }

  function dropAnnounceWait(): void {
    if (!announceWait) return
    clearTimeout(announceWait.timer)
    announceWait = null
  }

  function holdAnnounceWait(): void {
    const waiting = announceWait
    dropAnnounceWait()
    if (!waiting) return
    held.push(() => {
      if (statePath(actor.getSnapshot().value) === 'announcing') waiting.say()
    })
  }

  function scheduleAnnounce(say: () => void): void {
    dropAnnounceWait()
    playTimeoutBeep()
    const token = ++announceToken
    const timer = setTimeout(() => {
      if (announceWait?.token !== token) return
      announceWait = null
      const path = statePath(actor.getSnapshot().value)
      if (path === 'paused') {
        held.push(() => {
          if (statePath(actor.getSnapshot().value) === 'announcing') say()
        })
        return
      }
      if (path !== 'announcing') return
      say()
    }, gameConfig.timeoutBeepMs)
    announceWait = { token, timer, say }
  }

  client.onLink = (patch) => {
    noteLink(patch)
    setLink((current) => ({ ...current, ...patch }))
  }
  client.onFailure = (message) => {
    const path = statePath(actor.getSnapshot().value)
    if (path === 'startMenu' || path === 'failed' || path === 'connecting' || path === 'stopped') return
    actor.send({ type: 'CONNECTION_LOST', message })
  }
  client.onAudioFinished = ({ purpose, turn }) => {
    if (turn !== speechTurn || !isSpeechPurpose(purpose)) return
    const finish = () => {
      if (statePath(actor.getSnapshot().value) === 'stopped') return
      actor.send({ type: 'HOST_AUDIO_FINISHED', purpose })
    }
    if (statePath(actor.getSnapshot().value) === 'paused') {
      held.push(finish)
      return
    }
    finish()
  }
  client.onSpeechStarted = () => {
    const path = statePath(actor.getSnapshot().value)
    if (path === 'stopped' || path === 'paused') return
    if (isReadingPath(path) || path === 'falseStartCue') {
      overRead = true
      return
    }
    if (path === 'choosing.clarifying') {
      client.interruptSpeech()
      actor.send({ type: 'PLAYER_SPEECH_STARTED' })
      return
    }
    if (path === 'answering.waiting' || path === 'answering.hearing') {
      actor.send({ type: 'PLAYER_SPEECH_STARTED' })
    }
  }
  client.onSpeechStopped = ({ durationMs, itemId }) => {
    const path = statePath(actor.getSnapshot().value)
    if (path === 'stopped' || path === 'paused') return
    const startedOverRead = overRead
    overRead = false
    if ((startedOverRead || isReadingPath(path) || path === 'falseStartCue') && !path.startsWith('answering')) {
      void considerTalkover(durationMs, itemId)
      return
    }
    if (path === 'finalBets.hearing') {
      actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
      void considerBet(itemId)
      return
    }
    if (path === 'answering.waiting' || path === 'answering.hearing') {
      answerItemId = itemId
      actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
      return
    }
    if (path === 'choosing.clarifying') {
      client.interruptSpeech()
      actor.send({ type: 'PLAYER_SPEECH_STARTED' })
    }
    if (statePath(actor.getSnapshot().value) === 'choosing.listening') void considerChoice(durationMs, itemId)
    if (statePath(actor.getSnapshot().value).startsWith('buzzing')) void considerBlurt(durationMs, itemId)
  }
  client.onToolCall = (call, purpose) => {
    const path = statePath(actor.getSnapshot().value)
    if (path === 'stopped') return
    if (path === 'paused') {
      held.push(() => {
        if (purpose === 'select') handleSelection(call)
        if (purpose === 'judge') handleJudgment(call)
      })
      return
    }
    if (purpose === 'select') handleSelection(call)
    if (purpose === 'judge') handleJudgment(call)
  }

  let previousRound = actor.getSnapshot().context.roundIndex
  const subscription = actor.subscribe((snapshot) => {
    const path = statePath(snapshot.value)
    const round = snapshot.context.roundIndex
    if (path === previousPath && round === previousRound) return
    const from = previousPath
    const fromRound = previousRound
    previousPath = path
    previousRound = round
    pushTrace('state', path, machineView(snapshot.context))
    enter(path, snapshot, from, fromRound)
  })

  function enter(
    path: string,
    snapshot: SnapshotFrom<typeof gameMachine>,
    from: string,
    fromRound: number,
  ): void {
    const context = snapshot.context
    if (path === 'startMenu' || path === 'failed' || path === 'stopped') {
      dropAnnounceWait()
      clearBuzzerWarning()
      held.length = 0
      if (!(path === 'startMenu' && keepVoiceSession?.())) {
        connectToken += 1
        client.stopSession()
      }
      return
    }
    if (path === 'paused') {
      holdAnnounceWait()
      clearBuzzerWarning()
      client.setMicEnabled(false)
      client.setOutputMuted(true)
      return
    }
    if (from === 'paused') {
      client.setOutputMuted(false)
      if (buzzerChimeLive(path)) armBuzzerWarning(context.phaseDurationMs ?? gameConfig.buzzerMs)
      const skipped =
        (path === 'bridging' && context.roundIndex !== fromRound) ||
        (path === 'finished' && context.resumePath !== 'finished')
      if (!skipped) {
        const pending = held.splice(0)
        if (pending.length) {
          for (const job of pending) job()
          return
        }
        client.setMicEnabled(micOpen(path))
        return
      }
      held.length = 0
    }
    if (path !== 'announcing') dropAnnounceWait()
    if (path === 'connecting') {
      const token = ++connectToken
      const apiKey = getApiKey().trim()
      if (!apiKey) {
        actor.send({ type: 'CONNECTION_FAILED', message: 'Введите ключ' })
        return
      }
      if (voiceAlreadyConnected?.()) {
        actor.send({ type: 'CONNECTED' })
        return
      }
      void client.connect(apiKey).then(
        () => {
          if (token !== connectToken) return
          actor.send({ type: 'CONNECTED' })
        },
        (error: unknown) => {
          if (token !== connectToken) return
          const message = error instanceof Error ? error.message : 'Не удалось подключиться'
          actor.send({ type: 'CONNECTION_FAILED', message })
        },
      )
      return
    }
    if (path === 'welcoming') speak('welcome', welcomeInstructions(context))
    if (path === 'bridging') speak('bridge', bridgeInstructions(context))
    if (path === 'chooserHandoff') {
      const line = context.clarifyReason
      speak('chooserHandoff', verbatimSpeech(line), line)
    }
    if (path === 'choosing.listening') {
      client.setSpeechSpeed(gameConfig.speechSpeed)
      client.setTranscriptionPrompt(listeningPrompt(context))
      client.setMicEnabled(true)
    }
    if (path === 'choosing.resolving') {
      client.setMicEnabled(false)
      requestSelection(context)
    }
    if (path === 'choosing.clarifying') {
      client.setTranscriptionPrompt(listeningPrompt(context))
      speakWhileListening('clarify', clarifyInstructions(context))
    }
    if (path === 'flashing') client.setMicEnabled(false)
    if (path === 'reading.sealed') {
      const question = questionById(context.questions, context.activeQuestionId)
      const text = question ? questionSpeech(question) : ''
      speak('read', readInstructions(text), text)
      client.setTranscriptionPrompt('Пока ведущая читает вопрос, в комнате могут говорить. Это не ответ и не выбор ячейки.')
      client.setMicEnabled(true)
    }
    if (path === 'reading.armed') {
      client.setMicEnabled(true)
      armBuzzerWarning(context.phaseDurationMs ?? gameConfig.buzzerMs)
    }
    if (path === 'falseStartCue') speak('falseStart', falseStartInstructions(context))
    if ((from.startsWith('reading') || from === 'falseStartCue') && path.startsWith('answering')) client.interruptSpeech()
    if (path === 'buzzing.open') {
      openBuzzerEar()
      if (from !== 'paused' && from !== 'reading.armed') armBuzzerWarning(context.phaseDurationMs ?? gameConfig.buzzerMs)
    }
    if (path !== 'paused' && !buzzerChimeLive(path)) clearBuzzerWarning()
    if (path === 'answering.waiting' || path === 'answering.hearing') {
      client.setTranscriptionPrompt(answerListeningPrompt(questionById(context.questions, context.activeQuestionId)?.answers ?? []))
    }
    if (path === 'answering.waiting') client.setMicEnabled(true)
    if (path === 'judging') {
      client.setMicEnabled(false)
      void requestJudgment(context)
    }
    if (path === 'finalBets.asking') speak('bet', betInstructions(context))
    if (path === 'finalBets.hearing') {
      client.setTranscriptionPrompt('Игрок называет ставку числом или говорит ва-банк.')
      client.setMicEnabled(true)
    }
    if (path === 'turnCue') speak('turn', turnInstructions(context))
    if (path === 'announcing') {
      const say = () => {
        const exact = verbatimAnnouncement(context)
        speak('announce', announceInstructions(context), exact ?? undefined, true, answerChatNote(context))
      }
      if (context.announceKind === 'silence') scheduleAnnounce(say)
      else {
        dropAnnounceWait()
        say()
      }
    }
    if (path === 'finished') speak('finished', finishedInstructions(context))
  }

  function openBuzzerEar(): void {
    buzzerEarAt = Date.now()
    client.setTranscriptionPrompt('Человек говорит, пока нужно нажать кнопку. Это ещё не ответ на вопрос.')
    client.setMicEnabled(true)
  }

  function speakWhileListening(purpose: SpeechPurpose, instructions: string, expect?: string): void {
    speechTurn += 1
    client.requestSpeech(purpose, speechTurn, instructions, expect, Boolean(expect))
    client.setMicEnabled(true)
  }

  function speak(
    purpose: SpeechPurpose,
    instructions: string,
    expect?: string,
    isolated = false,
    chatNote?: (spoken: string) => string,
  ): void {
    speechTurn += 1
    client.setMicEnabled(false)
    client.requestSpeech(purpose, speechTurn, instructions, expect, isolated, chatNote)
  }

  function requestSelection(context: GameContext): void {
    toolTurn += 1
    client.requestTool('select', toolTurn, 'selectQuestion', selectionInstructions(context, choiceHeard), true)
  }

  async function considerChoice(durationMs: number, itemId: string | null): Promise<void> {
    const token = ++choiceToken
    const heard = await client.waitForTranscript(itemId, 2200)
    if (token !== choiceToken) return
    if (statePath(actor.getSnapshot().value) !== 'choosing.listening') return
    if (echoesChoicePrompt(heard.text, listeningPrompt(actor.getSnapshot().context))) {
      pushTrace('note', 'распознавание повторило подсказку тем, это не выбор')
      return
    }
    if (!heard.arrived) pushPlayerLine('речь не распознана')
    const round = currentRound(actor.getSnapshot().context, actor.getSnapshot().context.roundIndex)
    const gate = choiceGate(heard.text, durationMs, round?.kind === 'final' ? 2 : 4)
    const shown = heard.text || 'речь не распознана'
    if (gate === 'ignore') {
      pushTrace('note', `короткий звук ${durationMs} мс, ячейку не открываю: ${shown}`)
      return
    }
    if (gate === 'ask-again') {
      pushTrace('note', `реплика не похожа на выбор: ${shown}`)
      actor.send({
        type: 'QUESTION_UNCLEAR',
        reason: 'Не расслышала тему и стоимость. Повторите, пожалуйста.',
      })
      return
    }
    const snapshot = actor.getSnapshot()
    const kind = round?.kind === 'final' ? 'final' : 'normal'
    const local = matchSpokenCell(heard.text, openChoiceCells(snapshot.context), kind)
    choiceHeard = heard.text
    if (local) {
      const price = kind === 'final' ? '' : ` ${local.value}`
      pushTrace('note', `ячейка по словам: ${local.themeName}${price}`)
      actor.send({ type: 'QUESTION_SELECTED', themeId: local.themeId, value: local.value })
      return
    }
    actor.send({ type: 'PLAYER_SPEECH_FINISHED' })
  }

  async function considerBlurt(durationMs: number, itemId: string | null): Promise<void> {
    const startedAt = Date.now() - durationMs
    if (startedAt < buzzerEarAt) return
    const token = ++choiceToken
    const heard = await client.waitForTranscript(itemId, 2200)
    if (token !== choiceToken) return
    if (statePath(actor.getSnapshot().value) !== 'buzzing.open') return
    if (blurtGate(heard.text, durationMs) === 'ignore') {
      pushTrace('note', `короткий звук ${durationMs} мс, кнопку не трогаю`)
      return
    }
    if (!heard.arrived) pushPlayerLine('речь не распознана')
    pushTrace('note', `фраза без кнопки: ${heard.text || 'речь не распознана'}`)
    actor.send({ type: 'UNBUTTONED_TALK' })
  }

  async function considerTalkover(durationMs: number, itemId: string | null): Promise<void> {
    const token = ++choiceToken
    const heard = await client.waitForTranscript(itemId, 2200)
    if (token !== choiceToken) return
    const path = statePath(actor.getSnapshot().value)
    const relevant =
      isReadingPath(path) ||
      path === 'falseStartCue' ||
      path.startsWith('buzzing') ||
      path.startsWith('answering') ||
      path === 'announcing'
    if (!relevant) return
    if (blurtGate(heard.text, durationMs) === 'ignore') {
      pushTrace('note', `короткий звук ${durationMs} мс, чтение не прерываю`)
      return
    }
    const question = questionById(actor.getSnapshot().context.questions, actor.getSnapshot().context.activeQuestionId)
    if (question && repeatsQuestion(heard.text, questionSpeech(question))) {
      pushTrace('note', 'речь совпала с текстом вопроса, чтение не прерываю')
      return
    }
    pushTrace('note', `перебили чтение: ${heard.text || 'речь не распознана'}`)
    actor.send({ type: 'TALKED_OVER' })
  }

  async function considerBet(itemId: string | null): Promise<void> {
    const token = ++choiceToken
    const heard = await client.waitForTranscript(itemId, 2200)
    if (token !== choiceToken) return
    const snapshot = actor.getSnapshot()
    if (statePath(snapshot.value) !== 'finalBets.resolving') return
    if (!heard.arrived) pushPlayerLine('речь не распознана')
    const playerId = snapshot.context.finalists[snapshot.context.finalCursor]
    const score = snapshot.context.players.find((player) => player.id === playerId)?.score ?? 0
    const amount = parseBet(heard.text, score)
    if (!playerId || amount === null) {
      actor.send({ type: 'BET_UNCLEAR' })
      return
    }
    actor.send({ type: 'BET_PLACED', playerId, amount })
  }

  async function requestJudgment(context: GameContext): Promise<void> {
    const token = ++judgeToken
    const heard = await client.waitForTranscript(answerItemId, 2200)
    if (token !== judgeToken) return
    if (statePath(actor.getSnapshot().value) !== 'judging') return
    const live = actor.getSnapshot().context
    const answerPrompt = answerListeningPrompt(questionById(live.questions, live.activeQuestionId)?.answers ?? [])
    if (echoesAnswerPrompt(heard.text, answerPrompt)) {
      pushTrace('note', 'распознавание повторило подсказку ответа, это не ответ')
      actor.send({ type: 'ANSWER_ECHO' })
      return
    }
    answerTranscript = heard.text
    answerConfidence = heard.confidence
    if (!heard.arrived) pushPlayerLine('речь не распознана')
    toolTurn += 1
    client.requestTool(
      'judge',
      toolTurn,
      'submitAnswerJudgment',
      judgmentInstructions(context, answerTranscript),
      true,
    )
  }

  function handleSelection(call: ToolCall | null): void {
    const path = statePath(actor.getSnapshot().value)
    if (!path.startsWith('choosing')) {
      if (call) client.sendToolOutput(call.callId, { accepted: false, reason: 'Выбор уже не актуален' })
      return
    }
    const args = asRecord(call?.arguments)
    const themeId = typeof args.themeId === 'string' ? args.themeId : ''
    const value = typeof args.value === 'number' ? args.value : Number(args.value) || 0
    const confident = args.confident === true
    const snapshotNow = actor.getSnapshot()
    const kind = currentRound(snapshotNow.context, snapshotNow.context.roundIndex)?.kind ?? 'normal'
    const transcript = choiceHeard.trim()
    const played = snapshotNow.context.playedIds
    const local = matchSpokenCell(transcript, openChoiceCells(snapshotNow.context), kind)
    const knownQuestion = findQuestion(
      snapshotNow.context.questions,
      snapshotNow.context.roundIndex,
      themeId,
      value,
      kind,
    )
    const modelQuestion = findQuestion(
      snapshotNow.context.questions,
      snapshotNow.context.roundIndex,
      themeId,
      value,
      kind,
      played,
    )
    const modelOk = Boolean(modelQuestion && confident && !played.includes(modelQuestion.id))
    const picked = local
      ? findQuestion(
          snapshotNow.context.questions,
          snapshotNow.context.roundIndex,
          local.themeId,
          local.value,
          kind,
          played,
        )
      : modelOk
        ? modelQuestion
        : undefined
    const cellLabel = picked
      ? `${picked.themeName}${kind === 'final' ? '' : ` ${picked.value}`}`
      : `${themeId || '—'} ${value || ''}`.trim()
    pushJudgeLine(selectionChatText(transcript, Boolean(picked), cellLabel))
    if (!call || !picked) {
      const reason =
        confident && knownQuestion
          ? 'Этот вопрос недоступен. Назовите другую тему и стоимость.'
          : 'Я не уверена, какую ячейку вы назвали. Повторите тему и стоимость.'
      if (call) client.sendToolOutput(call.callId, { accepted: false, reason })
      actor.send({ type: 'QUESTION_UNCLEAR', reason })
      return
    }
    client.sendToolOutput(call.callId, {
      accepted: true,
      theme: picked.themeName,
      value: picked.value,
    })
    actor.send({ type: 'QUESTION_SELECTED', themeId: picked.themeId, value: picked.value })
  }

  function handleJudgment(call: ToolCall | null): void {
    const snapshot = actor.getSnapshot()
    if (statePath(snapshot.value) !== 'judging') {
      if (call) client.sendToolOutput(call.callId, { accepted: false, reason: 'Попытка уже закрыта' })
      return
    }
    const context = snapshot.context
    const playerId = context.activePlayerId
    const questionId = context.activeQuestionId
    if (!playerId || !questionId) return
    const args = asRecord(call?.arguments)
    const reported = judgmentStatuses.find((item) => item === args.status) ?? 'ambiguous'
    const heard = typeof args.heard === 'string' ? args.heard : ''
    const reason =
      typeof args.reason === 'string' && args.reason
        ? args.reason
        : 'Оценка пришла без пояснения'
    const question = questionById(context.questions, questionId)
    const settled = settleJudgment({
      activeQuestionId: questionId,
      activePlayerId: playerId,
      attemptId: context.attemptId,
      questionText: question ? questionSpeech(question) : '',
      answers: question?.answers ?? [],
      reportedQuestionId: typeof args.questionId === 'string' ? args.questionId : '',
      reportedPlayerId: Number(args.playerId),
      reportedAttemptId: Number(args.attemptId),
      status: reported,
      heard,
      transcript: answerTranscript,
      confidence: answerConfidence,
      reason,
    })
    const judgment =
      settled.status === 'near_miss' && context.clarifications >= gameConfig.maxClarifications
        ? { ...settled, status: 'incorrect' as const, reason: phoneticRetryReason }
        : settled
    if (call) client.sendToolOutput(call.callId, { accepted: true, status: judgment.status })
    pushJudgeLine(judgmentChatText(judgment.status, judgment.heard))
    actor.send({ type: 'ANSWER_JUDGED', judgment })
  }

  onActions?.({
    remindMutedAnswerer(playerName) {
      if (statePath(actor.getSnapshot().value) !== 'answering.waiting') return
      const line = `${playerName}, микрофон-то выключен.`
      speakWhileListening('micWarning', verbatimSpeech(line), line)
    },
  })

  return () => {
    onActions?.(null)
    connectToken += 1
    subscription.unsubscribe()
    client.stopSession()
  }
}

function machineView(context: GameContext) {
  const question = questionById(context.questions, context.activeQuestionId)
  return {
    statusLine: context.statusLine,
    round: currentRound(context, context.roundIndex)?.name ?? '',
    stake: context.activeStake,
    players: context.players,
    activeQuestionId: context.activeQuestionId,
    question: question
      ? {
          theme: question.themeName,
          value: question.value,
          text: question.text,
          answers: question.answers,
          choices: (question.choices ?? []).map((choice) =>
            choice.text ? `${choice.label}. ${choice.text}` : choice.label,
          ),
          media: (question.media ?? []).map((item) => `${item.kind}:${item.name}`),
          answerMedia: (question.answerMedia ?? []).map((item) => `${item.kind}:${item.name}`),
        }
      : null,
    activePlayerId: context.activePlayerId,
    chooserId: context.chooserId,
    attemptId: context.attemptId,
    clarifications: context.clarifications,
    spokeWithoutButton: context.spokeWithoutButton,
    talkedDuringRead: context.talkedDuringRead,
    heard: context.heard,
    wrongHeard: context.wrongHeard,
    sayCloseGuess: context.sayCloseGuess,
    judgmentStatus: context.judgmentStatus,
    judgmentReason: context.judgmentReason,
    announceKind: context.announceKind,
    playedIds: context.playedIds,
    missedIds: context.missedIds,
    error: context.error,
    resumePath: context.resumePath,
  }
}

function buzzerChimeLive(path: string): boolean {
  return path.startsWith('buzzing') || path === 'reading.armed'
}

function micOpen(path: string): boolean {
  return (
    path === 'choosing.listening' ||
    path === 'choosing.clarifying' ||
    path === 'buzzing.open' ||
    path === 'reading.sealed' ||
    path === 'reading.armed' ||
    path === 'answering.waiting' ||
    path === 'answering.hearing' ||
    path === 'finalBets.hearing'
  )
}

function isSpeechPurpose(purpose: string): purpose is SpeechPurpose {
  return (
    purpose === 'welcome' ||
    purpose === 'read' ||
    purpose === 'announce' ||
    purpose === 'clarify' ||
    purpose === 'finished' ||
    purpose === 'bridge' ||
    purpose === 'bet' ||
    purpose === 'turn' ||
    purpose === 'chooserHandoff' ||
    purpose === 'micWarning' ||
    purpose === 'falseStart'
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function availableLines(context: GameContext): string {
  const lines: string[] = []
  for (const question of context.questions) {
    if (question.roundIndex !== context.roundIndex || context.playedIds.includes(question.id)) continue
    lines.push(`${question.themeId} — ${question.themeName} — ${question.value}`)
  }
  return lines.join('\n')
}

function listeningPrompt(context: GameContext): string {
  const round = currentRound(context, context.roundIndex)
  const cells = context.questions
    .filter((question) => question.roundIndex === context.roundIndex && !context.playedIds.includes(question.id))
    .map((question) => ({ theme: question.themeName, value: question.value }))
  return choicePrompt(round?.kind === 'final' ? 'final' : 'normal', cells)
}

function openChoiceCells(context: GameContext) {
  return context.questions
    .filter((question) => question.roundIndex === context.roundIndex && !context.playedIds.includes(question.id))
    .map((question) => ({ themeId: question.themeId, themeName: question.themeName, value: question.value }))
}

/** Звук смеха. В слова реплики не входит. */
const giggleNote =
  'Один короткий звук «хи-хи». Это звук, не слово в предложении. Не произноси «смешок», «с лёгким смешком», «хихикаем», «тёплая фраза», «в скобках» и не читай ремарку в скобках.'

/** Ошибка без смеха. В слова реплики не входит. */
const dryNote = 'Ровно и коротко, без смеха. Не произноси «сухая фраза» и не читай ремарку в скобках.'

function sayLine(parts: string[]): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

export function welcomeInstructions(context: GameContext): string {
  const round = currentRound(context, context.roundIndex)
  const chooser = playerName(context.players, context.chooserId) || 'игрока'
  const spoken = `
Одной короткой фразой поздоровайся и сразу позови выбрать вопрос.
Сейчас вопрос выбирает ${chooser}. Можно обратиться по имени.
Пакет «${context.packName}», сейчас «${round?.name ?? 'раунд'}».
Темы не называй: они на табло.
Цены вопросов не называй и не перечисляй: они тоже на табло.
Больше ничего не добавляй. Не задавай вопрос викторины и не называй ответы.
`.trim()
  return withPlayNote(spoken, giggleNote)
}

export function bridgeInstructions(context: GameContext): string {
  const round = currentRound(context, context.roundIndex)
  const scores = context.players.map((player) => `${player.name} — ${player.score}`).join(', ')
  const chooser = playerName(context.players, context.chooserId) || 'игрока'
  const scoreLine = `Сначала коротко назови счёт каждого: ${scores}.`
  if (round?.kind === 'final') {
    return `${scoreLine} Затем одной фразой объяви финал и попроси выбрать одну тему. Можно обратиться по имени к тому, кто выбирает: ${chooser}. Названия тем не перечисляй.`
  }
  return `${scoreLine} Затем одной фразой объяви раунд «${round?.name ?? 'следующий'}» и попроси выбрать вопрос. Можно обратиться по имени к тому, кто выбирает: ${chooser}. Темы и номиналы не перечисляй.`
}

function betInstructions(context: GameContext): string {
  const playerId = context.finalists[context.finalCursor]
  const player = context.players.find((item) => item.id === playerId)
  return `Одной фразой попроси ${player?.name ?? 'игрока'} назвать ставку от 1 до ${player?.score ?? 0}. Не называй вопрос и не спрашивай остальных.`
}

function turnInstructions(context: GameContext): string {
  const player = context.players.find((item) => item.id === context.activePlayerId)
  return `Одной короткой фразой скажи, что отвечает ${player?.name ?? 'игрок'}. Вопрос заново не читай и ответ не подсказывай.`
}

function selectionInstructions(context: GameContext, heard: string): string {
  const round = currentRound(context, context.roundIndex)
  if (round?.kind === 'final') {
    const themes = roundThemes(context.questions, context.roundIndex)
      .map((theme) => `${theme.id} — ${theme.name}`)
      .join('\n')
    return `
Игроки выбирают тему финала. Распознанный текст: «${heard || 'пусто'}».
Темы:
${themes}
Вызови selectQuestion. value всегда 0.
confident=true только если названа одна тема из списка.
Кашель и шум: confident=false. Не угадывай. heard — дословно, что сказано.
Если в названии темы стоят точки или многоточие, это та же тема, сказанная без точек.
`.trim()
  }
  return `
Оцени только последнюю реплику. Распознанный текст: «${heard || 'пусто'}».
Это может быть шум, кашель или обрывок. Не считай, что ячейку уже назвали.
Доступны только эти вопросы:
${availableLines(context)}
Вызови selectQuestion. themeId — id или название темы из списка, value — номинал.
confident=true только если в реплике ясно есть и тема, и номинал.
Кашель, междометие или номинал без темы: confident=false, value=0.
Если в реплике ясно названы и тема, и номинал, confident=true и value равен этому номиналу. Ноль ставь только когда стоимости в реплике нет.
Не угадывай ячейку. heard — дословно, что сказал игрок.
Если в названии темы стоят точки или многоточие, это та же тема, сказанная без точек.
Не зачитывай вопрос и не говори ответ.
`.trim()
}

function clarifyInstructions(context: GameContext): string {
  const chooser = playerName(context.players, context.chooserId) || 'игрока'
  return `
Одной короткой фразой попроси выбрать вопрос ещё раз.
Можно обратиться по имени к тому, кто выбирает: ${chooser}.
Причина: ${context.clarifyReason || 'выбор неясен'}.
Темы и номиналы не перечисляй.
Не открывай вопрос сама и не называй ответ.
`.trim()
}

function readInstructions(text: string): string {
  return verbatimSpeech(text)
}

function judgmentInstructions(context: GameContext, heard: string): string {
  const question = questionById(context.questions, context.activeQuestionId)
  return `
Оцени только реплику ниже. Других вопросов и реплик нет.
Реплика игрока: «${heard || 'речь не распознана'}»
questionId: ${context.activeQuestionId ?? ''}
playerId: ${context.activePlayerId ?? ''}
attemptId: ${context.attemptId}
Вопрос: ${question ? questionSpeech(question) : ''}
Эталон, с которым нужно сравнить смысл: ${(question?.answers ?? []).join('; ')}${question?.choices?.length ? '\nБуква варианта и текст этого варианта — один и тот же ответ. Текст другого варианта — неправильный ответ.' : ''}
Верни те же questionId, playerId и attemptId.
correct — смысл реплики совпал с эталоном этого вопроса, даже другими словами. Повтор самого эталона — то же имя, та же фраза или та же буква — тоже correct. Не требуй объяснять код, загадку или условие вопроса, если эталон уже назван. Слово эталона, сказанное по слогам или с паузами внутри («пы ле со сел» при «пылесосел»), — это то же слово: correct, не needs_clarification и не другой ответ.
Если эталон — число и пояснение, как «0. На берёзе нет яблок», реплика верна, когда игрок даёт это число или ту же мысль другими словами («нисколько», «ноль», «яблок нет», «на берёзе яблоки не растут»), без требования повторить устройство пояснения из пакета и без incorrect только потому, что игрок объяснил загадку, а не назвал цифру.
incorrect — смысл другой или реплика отвечает на другой вопрос. Совсем другое слово, даже короткое, — тоже incorrect, даже если оно тоже имя.
unintelligible — реплику не разобрать.
ambiguous — нельзя уверенно решить.
needs_clarification — реплика созвучна эталону и могла быть тем же ответом, который распознавание исказило. Это не correct и не incorrect. Один звук или одна буква не туда: «Читов» при «Титов» или при «Герман Титов». То же имя, но другая запись: «Твэнсдей» или «Венсдей» при «Уэнсдэй». Короткая фраза, которую расслышали одним похожим словом: «Новоселов» при «Ногу свело».
heard — короткая запись реплики выше.
reason — одна фраза, почему выбран статус. Не называй другое произведение и другой ответ.
`.trim()
}

function answerStillHidden(context: GameContext): boolean {
  const id = context.activeQuestionId
  return Boolean(id && !context.playedIds.includes(id))
}

function answerChatNote(context: GameContext): (spoken: string) => string {
  const question = questionById(context.questions, context.activeQuestionId)
  const id = context.activeQuestionId
  const cellClosed = Boolean(id && context.playedIds.includes(id))
  const kind = context.announceKind
  const answers = question?.answers ?? []
  return (spoken) => chatAnswerNote({ kind, cellClosed, answers, spoken })
}

function mayName(name: string): string {
  return name ? `Можно назвать игрока по имени: ${name}.` : ''
}

export function falseStartInstructions(context: GameContext): string {
  const names = context.players
    .filter((player) => context.falseStarts[player.id] !== undefined)
    .map((player) => player.name)
  const line = falseStartLine(names)
  return `Одной короткой фразой скажи только: «${line}». Правильный ответ не называй. Вопрос не читай.`
}

/** Через сколько мс пищать на окне кнопки. Только полные десять секунд, за две до конца. */
export function buzzerWarningDelay(durationMs: number): number | null {
  if (durationMs !== gameConfig.buzzerMs) return null
  const delay = durationMs - gameConfig.buzzerWarningMs
  return delay > 0 ? delay : null
}

function closeGuessApplies(context: GameContext): boolean {
  return context.sayCloseGuess && context.wrongHeard.some((item) => item.trim())
}

function closeGuessPreface(heard: readonly string[]): string {
  const lines = heard.map((item) => item.trim()).filter(Boolean)
  if (!lines.length) return ''
  const quoted = lines.map((item) => `«${item}»`).join('; ')
  return [
    `Попытки после кнопки, коротко: ${quoted}.`,
    'Если одна явно называет то же, что эталон, только соседним заголовком — часть цикла вместо всего произведения, узкое название той же истории, персонаж вместо произведения — начни ровно с одной короткой фразы, что это было близко, словами игрока.',
    'Новое название не придумывай: верное имя только из эталона, следом.',
    'Несколько попыток не перечисляй: хватит одной, самой близкой.',
    'Созвучие и совсем другой ответ не упоминай: тогда этой фразы нет.',
  ].join(' ')
}

function withCloseGuess(cue: string, context: GameContext): string {
  if (!closeGuessApplies(context)) return cue
  const next = cue.replace(/^Сначала /, 'Затем, или сразу если фразы про близость нет, ')
  return `${closeGuessPreface(context.wrongHeard)} ${next}`
}

/** Дословная реплика, когда ответ один: модель не должна пересказывать задание. */
export function verbatimAnnouncement(context: GameContext): string | null {
  const kind = context.announceKind
  if (kind !== 'nobody' && kind !== 'unclear') return null
  if (kind === 'nobody' && closeGuessApplies(context)) return null
  if (kind === 'unclear' && answerStillHidden(context)) return null
  const question = questionById(context.questions, context.activeQuestionId)
  const forms = spokenChoiceForms(question?.answers ?? [], question?.choices ?? [])
  if (forms.length !== 1) return null
  const answer = forms[0] ?? ''
  if (!answer) return null
  if (kind === 'nobody' && (context.spokeWithoutButton || context.talkedDuringRead)) {
    return `${answer}. Ответ называют только после кнопки.`
  }
  return answer
}

export function announceInstructions(context: GameContext): string {
  const question = questionById(context.questions, context.activeQuestionId)
  const player = context.players.find((item) => item.id === context.activePlayerId)
  const named = mayName(player?.name ?? '')
  const kind: AnnounceKind | null = context.announceKind
  const finalRound = currentRound(context, context.roundIndex)?.kind === 'final'
  const finalNote = finalRound ? 'Не предлагай выбирать следующий вопрос.' : ''
  const cue = spokenAnswerCue(question?.answers ?? [], question?.choices ?? [])
  const hidden = answerStillHidden(context)
  const publish = answerIsPublic(kind, !hidden)
  const delta = context.activeStake ?? question?.value ?? 0
  const plus = delta > 0 ? `Сразу назови очки: плюс ${delta}.` : ''
  const minus = delta > 0 ? `Сразу назови очки: минус ${delta}.` : ''
  if (kind === 'correct' && hidden) {
    return withPlayNote(
      sayLine([
        'Одна короткая фраза: верно, или синоним вроде «правильно», «отлично».',
        plus,
        named,
        'Правильный ответ не произноси.',
        finalNote,
      ]),
      giggleNote,
    )
  }
  if (kind === 'correct') {
    return withPlayNote(
      sayLine([
        'Одна короткая фраза: верно, или синоним вроде «правильно», «отлично».',
        plus,
        named,
        'Можно добавить «дальше».',
        'Правильный ответ не произноси. Не повторяй вопрос.',
        finalNote,
      ]),
      giggleNote,
    )
  }
  if (kind === 'incorrect' && !publish) {
    return withPlayNote(
      sayLine([
        'Одна короткая фраза: неверно, или синоним вроде «нет», «мимо».',
        minus,
        named,
        'Правильный ответ не называй и не намекай. Не зови нажимать кнопку.',
        finalNote,
      ]),
      dryNote,
    )
  }
  if (kind === 'incorrect') {
    const rest = [named, minus, finalNote].filter(Boolean).join(' ')
    return `${withCloseGuess(cue, context)} Только после этого коротко скажи, что неверно.${rest ? ` ${rest}` : ''}`
  }
  if (kind === 'silence' && !publish) {
    return `Одна короткая фраза: игрок не ответил. ${minus} ${named} Правильный ответ не называй. Не зови нажимать кнопку. ${finalNote}`.replace(/\s+/g, ' ').trim()
  }
  if (kind === 'silence') {
    const rest = [named, minus, finalNote].filter(Boolean).join(' ')
    return `${withCloseGuess(cue, context)} Только после этого коротко скажи, что время на ответ вышло.${rest ? ` ${rest}` : ''}`
  }
  if (kind === 'repeat') {
    return 'Одной короткой фразой скажи только: «Повторите, пожалуйста». Правильный ответ не называй и не намекай. Не говори, верно это или нет, и не зови нажимать кнопку.'
  }
  if (kind === 'nobody') {
    const exact = verbatimAnnouncement(context)
    if (exact) return exact
    const remind = context.spokeWithoutButton || context.talkedDuringRead
    const close = closeGuessApplies(context)
    const forbid = 'Не говори, что кнопку не нажали, и не предлагай выбирать следующий. Не пересказывай задание.'
    const extra = [
      finalRound ? 'Не предлагай выбирать следующий вопрос.' : '',
      remind
        ? 'Затем одной короткой фразой скажи, что ответ называют только после кнопки.'
        : close
          ? 'После ответа больше ничего не добавляй.'
          : 'Больше ничего не добавляй.',
      forbid,
    ]
      .filter(Boolean)
      .join(' ')
    return `${withCloseGuess(cue, context)} ${extra} Не произноси названия тем и цены.`
  }
  if (kind === 'unclear' && publish) {
    const exact = verbatimAnnouncement(context)
    if (exact) return exact
    return `${cue} Затем одной короткой фразой скажи, что ответ не засчитан и очки не изменились, и предложи выбрать следующий вопрос. Темы и номиналы не перечисляй. ${finalNote}`.trim()
  }
  if (context.judgmentStatus === 'needs_clarification') {
    return `Одной фразой скажи, что ответ близок, но сейчас очки не меняются. Предложи выбрать следующий вопрос. Темы и номиналы не перечисляй. ${finalNote}`
  }
  return `Одной фразой скажи, что ответ не удалось засчитать и очки не изменились. Затем предложи выбрать следующий вопрос. Темы и номиналы не перечисляй. ${finalNote}`
}

export function finishedInstructions(context: GameContext): string {
  const scores = context.players.map((player) => `${player.name} — ${player.score}`).join(', ')
  const best = Math.max(...context.players.map((player) => player.score))
  const leaders = context.players.filter((player) => player.score === best)
  const outcome =
    leaders.length === 1
      ? `Победил ${leaders[0]?.name ?? 'игрок'} со счётом ${best}.`
      : `Ничья: ${leaders.map((player) => player.name).join(' и ')}, по ${best}.`
  return withPlayNote(`Подведи итог двумя короткими фразами. Счёт: ${scores}. ${outcome}`, giggleNote)
}

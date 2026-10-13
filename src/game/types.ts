/** Порядковый номер игрока с 1. Клавиатура есть только у 1, 2 и 3. */
export type PlayerId = number

export type JudgmentStatus =
  | 'correct'
  | 'incorrect'
  | 'needs_clarification'
  | 'unintelligible'
  | 'ambiguous'
  | 'near_miss'

export type SpeechPurpose =
  | 'welcome'
  | 'read'
  | 'announce'
  | 'clarify'
  | 'finished'
  | 'bridge'
  | 'bet'
  | 'turn'
  | 'chooserHandoff'
  | 'micWarning'
  | 'falseStart'
  | 'appeal'

export type RoundKind = 'normal' | 'final'

export type RoundInfo = {
  index: number
  name: string
  kind: RoundKind
}

export type QuestionPack = {
  name: string
  rounds: RoundInfo[]
  questions: Question[]
  warnings: string[]
}

export type Bet = {
  playerId: PlayerId
  amount: number
}

export type AnnounceKind = 'correct' | 'incorrect' | 'silence' | 'nobody' | 'unclear' | 'repeat'

export type MediaKind = 'image' | 'audio' | 'video'

export type QuestionMedia = {
  kind: MediaKind
  name: string
  url: string
}

/** Вариант из answerOptions: буква и текст или картинка. */
export type QuestionChoice = {
  label: string
  text: string
  media: QuestionMedia[]
}

export type Question = {
  id: string
  roundIndex: number
  themeId: string
  themeName: string
  value: number
  text: string
  answers: string[]
  media?: QuestionMedia[]
  answerMedia?: QuestionMedia[]
  choices?: QuestionChoice[]
}

export type Player = {
  id: PlayerId
  name: string
  score: number
  /** Онлайн-участник конференции. В режиме за столом не задаётся. */
  clientId?: string
}

export type AnswerJudgment = {
  questionId: string
  playerId: PlayerId
  attemptId: number
  status: JudgmentStatus
  heard: string
  reason: string
}

export type OutcomeLedger = Record<string, Record<string, { amount: number; attemptId: number; correct?: boolean }>>

export type AppealContext = {
  questionId: string
  windowId: number
  stage: 'open' | 'closed'
  queue: PlayerId[]
  acceptedRequestIds?: string[]
  activePlayerId: PlayerId | null
  lastPlayerId: PlayerId | null
  chooserId: PlayerId
  /** Только окно заявок, не таймер ответа; пауза хранит остаток. */
  remainingMs: number
  startedAt: number | null
}

export type AppealRequest = {
  questionId: string
  playerId: PlayerId
  windowId: number
  requestId: string
}

export type AppealFields = {
  outcomes?: OutcomeLedger
  appeal?: AppealContext | null
  appealSerial?: number
}

export type SavedMatch = AppealFields & {
  players: Player[]
  roundIndex: number
  playedIds: string[]
  missedIds: PlayerId[]
  chooserId: PlayerId
  finalists: PlayerId[]
  bets: Bet[]
  finalCursor: number
  betMisses: number
  activeQuestionId: string | null
  activePlayerId: PlayerId | null
  activeStake: number | null
  attemptId: number
  clarifications: number
  heard: string
  wrongHeard: string[]
  sayCloseGuess: boolean
  announceKind: AnnounceKind | null
  judgmentStatus: JudgmentStatus | null
  phase: string
}

export type GameEvent =
  | ({ type: 'APPEAL_REQUESTED' } & AppealRequest)
  | { type: 'START_GAME'; pack: QuestionPack; players?: Player[] }
  | { type: 'CONTINUE_GAME'; pack: QuestionPack; saved: SavedMatch }
  | { type: 'BET_PLACED'; playerId: PlayerId; amount: number }
  | { type: 'BET_UNCLEAR' }
  | { type: 'CONNECTED' }
  | { type: 'CONNECTION_FAILED'; message: string }
  | { type: 'CONNECTION_LOST'; message: string }
  | { type: 'HOST_AUDIO_FINISHED'; purpose: SpeechPurpose }
  | { type: 'PLAYER_SPEECH_STARTED' }
  | { type: 'PLAYER_SPEECH_FINISHED' }
  | { type: 'QUESTION_SELECTED'; themeId: string; value: number }
  | { type: 'QUESTION_UNCLEAR'; reason: string }
  | { type: 'SELECTION_FAILED'; message: string }
  | { type: 'BUZZER_PRESSED'; playerId: PlayerId }
  | { type: 'UNBUTTONED_TALK' }
  | { type: 'TALKED_OVER' }
  | { type: 'ANSWER_JUDGED'; judgment: AnswerJudgment }
  | { type: 'ANSWER_ECHO' }
  | { type: 'CHOOSER_OFFLINE'; fromPlayerId: PlayerId; toPlayerId: PlayerId }
  | { type: 'PAUSE'; path: string }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'NEXT_ROUND' }
  | { type: 'RESET_GAME' }
  | { type: 'ADD_PLAYER'; player: Player }

export type GameContext = AppealFields & {
  players: Player[]
  packName: string
  rounds: RoundInfo[]
  roundIndex: number
  warnings: string[]
  questions: Question[]
  playedIds: string[]
  missedIds: PlayerId[]
  finalists: PlayerId[]
  finalCursor: number
  bets: Bet[]
  betMisses: number
  activeStake: number | null
  activeQuestionId: string | null
  activePlayerId: PlayerId | null
  chooserId: PlayerId
  attemptId: number
  /** Сколько раз на этой кнопке уже просили повторить созвучие. Новое нажатие сбрасывает. */
  clarifications: number
  /** В текущем окне кнопки кто-то сказал фразу, не нажав кнопку. */
  spokeWithoutButton: boolean
  /** Пока ведущая читала вопрос, в комнате была фраза. Чтение из-за неё не останавливается. */
  talkedDuringRead: boolean
  /** После этого чтения сказать короткую реплику про фальстарт, и только потом открыть 10 секунд. */
  sayFalseStart: boolean
  /** Неверные реплики после кнопки на этом вопросе. Речь без кнопки и созвучие сюда не пишутся. */
  wrongHeard: string[]
  /** На объявлении уже открытого ответа одна короткая фраза, что попытка была близкой. Монетка. */
  sayCloseGuess: boolean
  heard: string
  judgmentReason: string
  judgmentStatus: JudgmentStatus | null
  announceKind: AnnounceKind | null
  clarifyReason: string
  error: string | null
  resumePath: string
  resumeStatus: string
  statusLine: string
  phaseStartedAt: number | null
  phaseDurationMs: number | null
  /** Остаток до ранней кнопки на чтении. Пауза хранит его, полоска таймера его не показывает. */
  earlyLeftMs: number | null
  earlyStartedAt: number | null
  /** Момент паузы. Пока игра стоит, штраф фальстарта от этой метки не тикает. */
  pauseStartedAt: number | null
  /** Время фальстарта игрока на этом вопросе. Вспышка и запрет кнопки длятся falseStartMs от этой метки. */
  falseStarts: Partial<Record<PlayerId, number>>
}

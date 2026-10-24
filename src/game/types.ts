import type { IdleClock, IdleOutcome, TalkState } from './idle.ts'
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
  | 'buzzCall'
  | 'strike'
  | 'finalIntro'
  | 'finalTyped'
  | 'stake'
  | 'score'
  | 'noBuzzer'
  | 'falseStart'
  | 'appeal'
  | 'lateCredit'
  | 'roundSummary'
  | 'cat'
  | 'catClarify'
  | 'catStake'
  | 'catStakeClarify'
  | 'auction'
  | 'auctionAsk'
  | 'auctionClarify'
  | 'auctionWon'
  | 'specialAway'
  | 'idleNudge'
  | 'idleAuto'

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

/** Цена кота из `type/param cost` (по SIGame). */
export type CatPrice =
  | { kind: 'fixed'; value: number }
  | { kind: 'range'; min: number; max: number; step: number }
  | { kind: 'roundMinMax' }

export type CatInfo = {
  source: 'cat' | 'bagcat'
  /** Пусто → тема ячейки. */
  theme: string
  price: CatPrice
  knows: 'before' | 'after' | 'never'
  /** Разобранные парсером варианты ставки (одна — фиксированная цена). */
  options: number[]
}

export type AuctionOption =
  | { kind: 'pass' }
  | { kind: 'stake'; amount: number }
  | { kind: 'allIn'; amount: number }

/** Состояние кота или аукциона на текущей ячейке. */
export type SpecialState = {
  kind: 'cat' | 'auction'
  questionId: string
  /** Кот: кто отдаёт. Аукцион: кто открыл торги (выбравший). */
  giverId: PlayerId
  /** Кот: получатель. Аукцион: кого сейчас спрашиваем. */
  recipientId: PlayerId | null
  /** Кот: варианты ставки (одна — фиксированная). */
  stakeOptions: number[]
  stake: number | null
  nominal: number
  order: PlayerId[]
  passed: PlayerId[]
  leaderId: PlayerId | null
  bid: number | null
  allIn: boolean
  options: AuctionOption[]
  /** Аукцион открыт автоставкой (деньги ≤ номинала или открывший отключился): объявление идёт, заявки при нём не слушаем. */
  autoStake?: boolean
  log: string[]
  /** Что не разобрали в последней реплике — для переспроса. */
  unclear: string
  /** Кто отключился и откуда ушли в ожидание. */
  awayPlayerId: PlayerId | null
  awayFrom: 'staking' | 'bidding' | 'answering' | null
  awayNextChooser: PlayerId | null
}

export type Bet = {
  playerId: PlayerId
  amount: number
}

export type AnnounceKind = 'correct' | 'incorrect' | 'silence' | 'nobody' | 'unclear' | 'repeat' | 'away'

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
  cat?: CatInfo
  auction?: { source: 'auction' | 'stake' }
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

export type OutcomeLedger = Record<string, Record<string, { amount: number; attemptId: number; correct?: boolean; /** Result this attempt replaced. */ previous?: number; /** Ставка кота/аукциона: апелляция меняет счёт на неё, а не на номинал. */ stake?: number }>>

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
  /** Last question of a round: host summary during the window. */
  summary?: 'pending' | 'done'
  /** Window expired while the summary is still being spoken; no new appeals. */
  timeUp?: boolean
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
  /** Не используется: промах ставки и так становится нулём. Поле остаётся, чтобы старые сохранения читались. */
  betMisses: number
  /** Финал: чей ход вычёркивания темы. Нет в старых снимках — восстановится как выбирающий раунда. */
  finalStriker?: PlayerId
  /** Финал: вычеркнутые темы. Нет в старых снимках — круг начнётся заново. */
  struckThemes?: string[]
  /** Финал: скрытые напечатанные ответы (текст ≤ 200). Нет в старых снимках. */
  typedAnswers?: Partial<Record<PlayerId, string>>
  /** Финал: чьи ответы уже раскрыты ведущей. Нет в старых снимках. */
  revealedIds?: PlayerId[]
  /** Финал: чьи ставки уже названы. Нет в старых снимках. */
  stakeShownIds?: PlayerId[]
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
  special?: SpecialState | null
}

export type GameEvent =
  | {
      type: 'STRIKE_THEME'
      playerId: PlayerId
      themeId: string
    }
  | { type: 'FINAL_STAKE'; playerId: PlayerId; amount: number }
  | { type: 'FINAL_TYPED'; playerId: PlayerId; text: string }
  | ({ type: 'APPEAL_REQUESTED' } & AppealRequest)
  | { type: 'START_GAME'; pack: QuestionPack; players?: Player[] }
  | { type: 'CONTINUE_GAME'; pack: QuestionPack; saved: SavedMatch }
  | { type: 'BET_PLACED'; playerId: PlayerId; amount: number }
  | { type: 'BET_UNCLEAR' }
  | { type: 'CONNECTED' }
  | { type: 'CONNECTION_FAILED'; message: string }
  | { type: 'CONNECTION_LOST'; message: string }
  | { type: 'HOST_AUDIO_FINISHED'; purpose: SpeechPurpose }
  | { type: 'IDLE_SPEECH'; active: boolean }
  | { type: 'HOST_TALKING'; active: boolean }
  | { type: 'PLAYER_SPEECH_STARTED' }
  | { type: 'PLAYER_SPEECH_FINISHED' }
  | { type: 'QUESTION_SELECTED'; themeId: string; value: number }
  | { type: 'QUESTION_UNCLEAR'; reason: string }
  | { type: 'SELECTION_FAILED'; message: string }
  | { type: 'BUZZER_PRESSED'; playerId: PlayerId }
  | { type: 'UNBUTTONED_TALK' }
  | { type: 'TALKED_OVER' }
  | { type: 'ANSWER_JUDGED'; judgment: AnswerJudgment }
  /** Поздняя расшифровка совпала с эталоном: вернуть игроку плюс за этот вопрос, чужой зачёт не трогать. */
  | { type: 'LATE_TRANSCRIPT_CREDIT'; questionId: string; playerId: PlayerId }
  | { type: 'ANSWER_ECHO' }
  /** Ответ из нескольких реплик: игрок замолчал, оценки готовы — решение в judging. */
  | { type: 'ANSWER_SETTLED' }
  /** Ни в одной реплике нет разборчивого ответа (шум, мычание, «щас») — как молчание. */
  | { type: 'ANSWER_NONE' }
  /** Решающая реплика осталась без оценки модели (таймаут) — как «оценка не пришла». */
  | { type: 'ANSWER_JUDGE_FAILED' }
  | { type: 'CHOOSER_OFFLINE'; fromPlayerId: PlayerId; toPlayerId: PlayerId }
  | { type: 'PAUSE'; path: string }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'NEXT_ROUND' }
  | { type: 'ANSWER_MEDIA_ENDED' }
  | { type: 'RESET_GAME' }
  | { type: 'ADD_PLAYER'; player: Player }
  | { type: 'CAT_RECIPIENT'; playerId: PlayerId }
  | { type: 'CAT_PICK_UNCLEAR'; reason: string }
  | { type: 'CAT_STAKE'; playerId: PlayerId; amount: number }
  | { type: 'CAT_STAKE_UNCLEAR'; reason: string }
  | { type: 'AUCTION_BID'; playerId: PlayerId; option: AuctionOption }
  | { type: 'AUCTION_UNCLEAR'; reason: string }
  | { type: 'SPECIAL_PLAYER_OFFLINE'; playerId: PlayerId; nextChooserId: PlayerId | null }
  | { type: 'SPECIAL_PLAYER_BACK'; playerId: PlayerId }

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
  /** Не используется: промах ставки и так становится нулём. Поле остаётся, чтобы старые сохранения читались. */
  betMisses: number
  /** Кто вычеркнул темы в финале: идёт по кругу от выбирающего раунда, до одной открытой темы. */
  finalStriker?: PlayerId
  /** Темы финала, которые игроки вычеркнули по очереди. */
  struckThemes?: string[]
  /** Скрытые напечатанные ответы финала (по playerId); видны на табло только после разбора. */
  typedAnswers?: Partial<Record<PlayerId, string>>
  /** Финал: кто уже напечатал ответ (обо всех, суммы и текст не раскрываются до разбора). */
  typedIds?: PlayerId[]
  /** Финал: уже раскрытые ставки (только для stakeShownIds). */
  stakes?: Partial<Record<PlayerId, number>>
  /** Ответы финала, уже раскрытые на табло (порядок = порядок разбора). */
  revealedIds?: PlayerId[]
  /** Ставки финала, уже названные на табло ведущей, и их вердикты: id в порядке разбора. */
  stakeShownIds?: PlayerId[]
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
  /** Когда начали объявлять исход (с этого момента видна картинка ответа). */
  answerShownAt?: number | null
  /** Звук/ролик ответа доиграл (или его нет): дальше держим только до минимума. */
  answerClipEnded?: boolean
  /** Момент паузы. Пока игра стоит, штраф фальстарта от этой метки не тикает. */
  pauseStartedAt: number | null
  /** Время фальстарта игрока на этом вопросе. Вспышка и запрет кнопки длятся falseStartMs от этой метки. */
  falseStarts: Partial<Record<PlayerId, number>>
  /** Кот в мешке или аукцион на текущей ячейке. */
  special?: SpecialState | null
  /** Отсчёт тишины игрока (выбор, кот, ставка, аукцион). */
  idle?: IdleClock | null
  /** Счётчик реплик-напоминаний: контроллер говорит на каждое увеличение. */
  idleNudges?: number
  /** Последнее автодействие по молчанию — для реплики ведущей. */
  idleOutcome?: IdleOutcome | null
  /** Кто сейчас говорит: ведущая / игрок. Пока говорят, отсчёт тишины стоит. */
  talk?: TalkState
}

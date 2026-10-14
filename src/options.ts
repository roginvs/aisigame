/** Длительности партии. Пока обычные константы: позже их заберёт экран настроек. */
export const matchTimings = {
  buzzerMs: 13_000,
  /** Окно кнопки после чужой ошибки или молчания, если ответить ещё могут другие. */
  stealBuzzerMs: 5_000,
  answerMs: 10_000,
  /** В конференции столько ждём перед подсказкой о выключенном микрофоне. */
  mutedAnswerReminderMs: 3_000,
  /** Пока выбирают вопрос, ту же подсказку повторяем с этим интервалом. */
  mutedChooserRepeatMs: 5_000,
  clarifyMs: 10_000,
  judgeMs: 20_000,
  cellFlashMs: 1080,
  /**
   * Раннее окно до живой кнопки: от `earlyBuzzerMinMs` до `earlyBuzzerMaxMs`.
   * Длительность считает `earlyBuzzerMsFor` по длине фразы вопроса и небольшому разбросу.
   * `earlyBuzzerMs` — запасной срок, если текста ещё нет.
   */
  earlyBuzzerMinMs: 3_000,
  earlyBuzzerMaxMs: 8_000,
  earlyBuzzerMs: 5_000,
  /** Примерный темп чтения ведущей: символов в секунду для оценки окна. */
  earlyBuzzerCharsPerSec: 12,
  /** Случайный разброс вокруг оценки (±), всё ещё внутри min…max. */
  earlyBuzzerJitterMs: 700,
  /** Штраф фальстарта: кнопка вспыхивает и гаснет, и всё это время этот игрок нажать не может. */
  falseStartMs: 2_500,
  hostAudioFallbackMs: 8_000,
  hostAudioHardLimitMs: 30_000,
  /** За сколько до конца первого окна кнопки (`buzzerMs`) звучит предупреждение. Кнопку ещё можно нажать. */
  buzzerWarningMs: 2_000,
  /** Сколько звучит сам короткий сигнал. Когда он начинается — отдельно, `buzzerWarningMs`. */
  buzzerBeepMs: 1_000,
  /** Пауза перед речью, когда сигнал звучит уже после закрытия окна ответа. */
  timeoutBeepMs: 1_000,
  /** Кот в мешке: пауза на «мяу» перед первой фразой ведущей. */
  catMeowMs: 1_100,
  /** Аукцион: пауза на «динь-динь-динь» перед первой фразой. */
  auctionDingMs: 1_300,
  /** Сколько ждём отключившегося получателя кота / участника торгов. */
  catAwayWaitMs: 15_000,
} as const

export const {
  buzzerMs,
  stealBuzzerMs,
  answerMs,
  mutedAnswerReminderMs,
  mutedChooserRepeatMs,
  clarifyMs,
  judgeMs,
  cellFlashMs,
  earlyBuzzerMinMs,
  earlyBuzzerMaxMs,
  earlyBuzzerMs,
  earlyBuzzerCharsPerSec,
  earlyBuzzerJitterMs,
  falseStartMs,
  hostAudioFallbackMs,
  hostAudioHardLimitMs,
  buzzerWarningMs,
  buzzerBeepMs,
  timeoutBeepMs,
  catMeowMs,
  auctionDingMs,
  catAwayWaitMs,
} = matchTimings

/**
 * Молчание игрока в слушающих состояниях без своего таймера. Пороги — накопленное время тишины
 * (речь игрока сбрасывает, речь ведущей и разбор останавливают). Все пороги, кроме последнего, —
 * реплика ведущей; последний — автоматическое действие.
 */
/** Пауза выбора вопроса между напоминаниями ведущей (тишина или нераспознанная реплика). */
export const choosingReminderMs = 20_000

export const idleSteps = {
  /**
   * Выбор вопроса: каждые choosingReminderMs — напоминание (темы и номиналы или предложение ячейки);
   * при нескольких игроках после двух напоминаний ход переходит следующему, с одним — напоминания идут дальше.
   */
  choosing: [choosingReminderMs, choosingReminderMs * 2, choosingReminderMs * 3],
  /** Кот: спросить, кому отдаёт; затем отдать случайному. */
  catPick: [15_000, 30_000],
  /** Ставка за кота: спросить минимум/максимум; затем взять минимум. */
  catStake: [10_000, 20_000],
  /** Аукцион: спросить ставку; затем молчание — пас. */
  auction: [10_000, 20_000],
} as const

/** Native audio judging budgets; the game's judgeMs is unchanged. */
export const audioJudgmentTimings = { readyMs: 1500, responseMs: 12_000 } as const

/** Аукцион: множители номинала на открытии торгов. */
export const auctionOpenMultipliers = [1, 2, 3, 4] as const
/** Аукцион: на сколько номиналов можно перекупить. */
export const auctionRaiseSteps = [1, 2, 3] as const
/** Запасные цены раунда, когда в пакете их нет совсем. */
export const defaultRoundPrices = { min: 100, max: 500 } as const
/** Запасной номинал вопроса, когда в пакете нет ни одной цены. */
export const defaultQuestionPrice = 100


/** Сколько последних сообщений журнала идёт ведущей как публичный контекст. */
export const commentaryHistoryMessages = 10

/**
 * Мягкий потолок свободной реплики (`max_output_tokens`): ~3–4 предложения аудио
 * с запасом. Не для дословного чтения вопроса и не для вызова функций.
 */
export const freeReplyMaxOutputTokens = 800

/**
 * Медиа ответа (картинка, звук, ролик) — при любом исходе с закрытой ячейкой, и после верного ответа тоже.
 * Видны всё объявление и пока играет звук/ролик, но не меньше min и не больше max с момента показа
 * (длинный клип обрезается на max).
 */
export const answerMediaMinMs = 3000
export const answerMediaMaxMs = 10_000

/** Паузы перед повторным подключением участника «Звуки игры» (мс): 1 с, 2 с, 5 с, потом каждые 10 с. */
export const gameSoundsRetryDelaysMs = [1000, 2000, 5000, 10_000] as const

/** Гость: полоска таймера не переякоривается, если новый расчёт старта отличается не больше чем на столько (сетевой джиттер). */
export const TIMER_RESYNC_THRESHOLD_MS = 300

/**
 * Ожидание расшифровки реплики: длинные реплики сервис распознавания отдаёт дольше
 * (в живой игре 2,3–7 с после конца речи). База + доля длительности, не больше потолка.
 */
export const transcriptWait = { baseMs: 2_500, perSpeechMs: 0.3, maxMs: 6_000 } as const

/** Сколько ещё ждём опоздавшую расшифровку выбора после переспроса. */
export const lateTranscriptMs = 8_000

export function transcriptWaitMs(durationMs: number): number {
  const spoken = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  return Math.min(transcriptWait.maxMs, Math.round(transcriptWait.baseMs + transcriptWait.perSpeechMs * spoken))
}

/** Сколько ждём расшифровку, чтобы подтвердить эталон, услышанный аудиооценкой. */
export const audioEtalonTranscriptMs = 1_500

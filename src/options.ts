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
  /**
   * После объявления ответа пакета, если у ячейки есть звук или ролик ответа:
   * столько ещё держим табло, чтобы клип успел прозвучать.
   */
  answerMediaHoldMs: 4_000,
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
  answerMediaHoldMs,
  catMeowMs,
  auctionDingMs,
  catAwayWaitMs,
} = matchTimings

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

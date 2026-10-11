/** Длительности партии. Пока обычные константы: позже их заберёт экран настроек. */
export const matchTimings = {
  buzzerMs: 10_000,
  /** Окно кнопки после чужой ошибки или молчания, если ответить ещё могут другие. */
  stealBuzzerMs: 5_000,
  answerMs: 10_000,
  /** В конференции столько ждём перед подсказкой отвечающему о выключенном микрофоне. */
  mutedAnswerReminderMs: 3_000,
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
  /** За сколько до конца десятисекундного окна кнопки звучит предупреждение. Кнопку ещё можно нажать. */
  buzzerWarningMs: 2_000,
  /** Сколько звучит сам короткий сигнал. Когда он начинается — отдельно, `buzzerWarningMs`. */
  buzzerBeepMs: 1_000,
  /** Пауза перед речью, когда сигнал звучит уже после закрытия окна ответа. */
  timeoutBeepMs: 1_000,
} as const

export const {
  buzzerMs,
  stealBuzzerMs,
  answerMs,
  mutedAnswerReminderMs,
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
} = matchTimings

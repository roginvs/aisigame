/** Длительности партии. Пока обычные константы: позже их заберёт экран настроек. */
export const matchTimings = {
  buzzerMs: 10_000,
  /** Окно кнопки после чужой ошибки или молчания, если ответить ещё могут другие. */
  stealBuzzerMs: 5_000,
  answerMs: 10_000,
  clarifyMs: 10_000,
  judgeMs: 20_000,
  cellFlashMs: 1080,
  /** С начала чтения обычного вопроса и до этого срока нажатие — фальстарт. Потом кнопки, статус и полоска десяти секунд уже живые, даже если она ещё читает. Нажатие обрывает звук. Не в финале. */
  earlyBuzzerMs: 5_000,
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
  clarifyMs,
  judgeMs,
  cellFlashMs,
  earlyBuzzerMs,
  falseStartMs,
  hostAudioFallbackMs,
  hostAudioHardLimitMs,
  buzzerWarningMs,
  buzzerBeepMs,
  timeoutBeepMs,
} = matchTimings

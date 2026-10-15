/** Длительности партии. Пока обычные константы: позже их заберёт экран настроек. */
export const matchTimings = {
  buzzerMs: 13_000,
  /** Окно кнопки после чужой ошибки или молчания, если ответить ещё могут другие. */
  stealBuzzerMs: 5_000,
  answerMs: 10_000,
  /** В конференции столько ждём перед подсказкой о выключенном микрофоне. */
  mutedAnswerReminderMs: 3_000,
  /** Пока выбирают вопрос, ту же подсказку повторяем с этим интервалом. */
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


/** Микрофон считается выключенным, только если он выключен столько подряд (мигание дорожки не в счёт). */
export const mutedMicStableMs = 2_500

/** Сколько раз за ход выбирающего обычное напоминание говорит про выключенный микрофон. */
export const mutedChooserMaxReminders = 2

/** Диагностика окна «модель слушает одного» (выбор/ответ/ставка): шаг замера уровней микса. */
export const hearWindowSampleMs = 250

/**
 * «Немой клон»: Jitsi видит речь участника (уровень ≥ SPEAKING_LEVEL), а наш клон в миксе
 * модели при этом почти ноль. Столько замеров подряд — пишем в trace и пересоздаём клон (раз за окно).
 */
export const silentCloneSamples = 6
/** Пик клона (0..1) ниже этого — «тишина» для детектора немого клона. */
export const silentClonePeak = 0.003

/** Как часто мастер обновляет уровни «что слышит модель» (после микшера) для своего индикатора. */
export const modelLevelsUpdateMs = 75

/**
 * Темп речи ведущей после приветствия: OpenAI/Grok `session.audio.output.speed` (0.25–1.5).
 * У Gemini Live параметра нет — там просьба о темпе в systemInstruction (`geminiTempoRule`).
 */
export const hostSpeechSpeed = 1.2
export const geminiTempoRule = 'Говори в бодром темпе, чуть быстрее обычного; слова дословных фраз не меняй и не пропускай.'

/**
 * Номиналы в подсказке распознаванию при выборе ячейки. Выключено: подсказка — только
 * названия открытых тем. Длинный каталог «тема 10, 20, 30…» распознавание на шуме
 * выдавало целиком вместо речи (дамп 15 октября 2026: 1,3 с шума → весь каталог).
 * Цены — обычные числительные, их слышно и без подсказки.
 */
export const asrChoicePromptPrices = false

/**
 * Переспрос выбора, кота, аукциона и передача хода: столько мс речи подряд, чтобы оборвать
 * ведущую, не дожидаясь расшифровки. Короче — ждём расшифровку (~1–2 с после конца речи) и
 * обрываем, только если это речь. Голый VAD больше не обрывает: шум 1,3 с (дамп 15.10.2026)
 * оборвал переспрос. Ответ после «Вася, отвечайте» сюда не относится — там 600 мс (`LOBBY_BARGE_IN_MIN_MS`).
 */
export const bargeInSustainMs = 1500

/**
 * Выбор ячейки из нескольких реплик: если ни одна реплика хода не дала ячейку, ведущая молчит
 * столько мс тишины и только потом переспрашивает (игрок часто договаривает: «шутки… за триста»).
 */
export const choiceClarifyAfterMs = 3000

/** Сколько ждать ответ модели selectQuestion по одной реплике, потом реплика считается «без ячейки». */
export const choiceResolveTimeoutMs = 8000

/**
 * Локальная подсказка «жми кнопку» (только на этом экране, в сеть и контроллер не уходит).
 * Уровень — RMS собственной опубликованной в Jitsi дорожки микрофона (после эхоподавления/AGC).
 * - `rms` 0,02 (≈ −34 dBFS): тихий фон комнаты и вентилятор после шумодава — 0,002–0,01,
 *   обычная речь в гарнитуру/ноутбук — 0,03–0,15. Ниже порога — «тишина».
 * - `sustainMs` 600: речь — это слог за слогом дольше полсекунды; стук, щелчок, кашель — 50–300 мс.
 * - `gapMs` 200: паузы между слогами короче — счёт «звука подряд» не сбрасывают.
 * - `flashMs` 450 × `flashes` 3 = 1,35 с вспышки; `cooldownMs` 5000 — не чаще раза в 5 с.
 * - `sampleMs` 50 — как часто читаем уровень.
 */
export const buzzNudge = {
  rms: 0.02,
  sustainMs: 600,
  gapMs: 200,
  flashMs: 450,
  flashes: 3,
  cooldownMs: 5000,
  sampleMs: 50,
} as const

/** Метрики экрана в дебаг-логе (`src/debug/displayMetrics.ts`, docs/DEBUG.md «[экран]»). */
export const displayMetricsLog = {
  /** Пауза после последнего resize/поворота/смены DPR перед записью: одна строка на серию. */
  debounceMs: 800,
  /** Повтор той же записи: мастер хранит лишь хвост лога игрока, стартовая строка может вытесниться. */
  repeatMs: 5 * 60_000,
}

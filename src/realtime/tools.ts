export const selectQuestionTool = {
  type: 'function',
  name: 'selectQuestion',
  description:
    'Передаёт игре тему и номинал, только если они ясно прозвучали. Шум, кашель и обрывок — это не выбор: confident=false и value=0.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      themeId: {
        type: 'string',
        description: 'Id или название темы из переданного списка.',
      },
      value: {
        type: 'integer',
        description: 'Номинал из списка. 0, если это финал или стоимость неясна.',
      },
      confident: {
        type: 'boolean',
        description:
          'true только если ясно названы и тема, и номинал. В финале достаточно одной темы, value всегда 0. Иначе false, без угадывания.',
      },
      heard: {
        type: 'string',
        description: 'Дословно, что сказал игрок. Если это шум или кашель, так и напиши.',
      },
    },
    required: ['themeId', 'value', 'confident', 'heard'],
  },
} as const

export const submitAnswerJudgmentTool = {
  type: 'function',
  name: 'submitAnswerJudgment',
  description:
    'Возвращает игре смысловую оценку ответа. Не меняет счёт. Считай ответ верным, если он удовлетворяет условиям вопроса: совпадает с эталоном по смыслу или является другим фактически верным ответом вне неполного списка эталонов. Если альтернативу нельзя уверенно подтвердить, верни ambiguous. Повтор самого эталона — тоже верный ответ: не требуй объяснять вопрос. Созвучную реплику, которую распознавание могло исказить, помечай needs_clarification, не incorrect.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      questionId: { type: 'string' },
      // The machine validates the active player; games can have more than three seats.
      playerId: { type: 'integer' },
      attemptId: { type: 'integer' },
      status: {
        type: 'string',
        enum: ['correct', 'incorrect', 'needs_clarification', 'unintelligible', 'ambiguous'],
      },
      heard: { type: 'string', description: 'Что именно сказал игрок, коротко.' },
      reason: { type: 'string', description: 'Почему выставлен этот статус, одна фраза.' },
    },
    required: ['questionId', 'playerId', 'attemptId', 'status', 'heard', 'reason'],
  },
} as const

/** Кот в мешке: кому отдаёт выбравший. Только если локальный разбор не нашёл ровно одного игрока. */
export const selectCatRecipientTool = {
  type: 'function',
  name: 'selectCatRecipient',
  description: 'Определяет, какому игроку из списка кандидатов выбравший отдаёт кота в мешке. Если имя не прозвучало или подходит нескольким — confident=false и playerId=0.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      playerId: { type: 'integer', description: 'id игрока из списка кандидатов, 0 если неясно.' },
      confident: { type: 'boolean', description: 'true только если ясно назван ровно один кандидат.' },
      heard: { type: 'string', description: 'Дословно, что сказал игрок.' },
    },
    required: ['playerId', 'confident', 'heard'],
  },
} as const

/** Ставка кота или аукциона: только один из вариантов на экране. */
export const resolveSpecialBidTool = {
  type: 'function',
  name: 'resolveSpecialBid',
  description: 'Сопоставляет реплику игрока с одним из вариантов ставки на экране (кот в мешке или аукцион). Если вариант неясен — confident=false и choice="unclear".',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      choice: { type: 'string', enum: ['amount', 'pass', 'allIn', 'unclear'], description: 'amount — названа сумма из вариантов; pass — пас; allIn — ва-банк; unclear — неясно.' },
      amount: { type: 'integer', description: 'Сумма из списка вариантов при choice=amount, иначе 0.' },
      confident: { type: 'boolean' },
      heard: { type: 'string', description: 'Дословно, что сказал игрок.' },
    },
    required: ['choice', 'amount', 'confident', 'heard'],
  },
} as const

export const sessionTools = [selectQuestionTool, submitAnswerJudgmentTool, selectCatRecipientTool, resolveSpecialBidTool]

/** Назначение tool-вызова по имени: так controller узнаёт, кому ответ. */
export const toolPurposes: Record<string, string> = {
  selectQuestion: 'select',
  submitAnswerJudgment: 'judge',
  selectCatRecipient: 'catPick',
  resolveSpecialBid: 'specialBid',
}

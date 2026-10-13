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
      playerId: { type: 'integer', enum: [1, 2, 3] },
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

export const sessionTools = [selectQuestionTool, submitAnswerJudgmentTool]

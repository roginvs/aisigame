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
        description: 'id темы из переданного списка — именно id, не название.',
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
        description: 'Дословно, что сказал игрок — по звуку реплики. Если речи нет, пустая строка.',
      },
      speech: {
        type: 'string',
        enum: ['choice', 'other', 'noise'],
        description:
          'По звуку реплики: choice — игрок называет ячейку или соглашается на предложение; other — человеческая речь, но не выбор; noise — человеческой речи нет (шум, кашель, стук, тишина). Расшифровка распознавателя на шуме бывает выдумана (например, повторяет список тем) — верь звуку, а не ей.',
      },
    },
    required: ['themeId', 'value', 'confident', 'heard', 'speech'],
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
      status: {
        type: 'string',
        enum: ['correct', 'incorrect', 'needs_clarification', 'unintelligible', 'ambiguous'],
      },
      heard: { type: 'string', description: 'Что именно сказал игрок, коротко.' },
      reason: { type: 'string', description: 'Почему выставлен этот статус, одна фраза.' },
      speech: {
        type: 'string',
        enum: ['answer', 'stall', 'noise'],
        description:
          'Что в этой реплике: answer — разборчивая попытка ответа (верная или нет); stall — речь без ответа: заминка, «щас-щас», «эээ», «дайте подумать», смех, мычание; noise — человеческой речи нет: шум, кашель, стук, тишина, эхо ведущей. Речь, похожая на попытку ответа, но неразборчивая — answer со status unintelligible. Засчитывается строго последний разборчивый ответ из всех реплик игрока, stall и noise после него пропускаются.',
      },
      guessing: {
        type: 'boolean',
        description:
          'true только при почти полной уверенности, что игрок нарочно перебирает несколько разных ответов наугад, надеясь попасть («Пушкин… Лермонтов… Тютчев»). Исправление одного ответа на другой, уточнение, заминки, повтор того же ответа — не перебор: false. Сомневаешься — false.',
      },
    },
    required: ['status', 'heard', 'reason', 'speech', 'guessing'],
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

/** Ставка кота: минимум или максимум. */
export const pickCatStakeTool = {
  type: 'function',
  name: 'pickCatStake',
  description: 'Какую ставку за кота в мешке выбрал игрок: минимум или максимум. Если неясно — option="unclear".',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      option: { type: 'string', enum: ['min', 'max', 'unclear'] },
      heard: { type: 'string', description: 'Дословно, что сказал игрок.' },
    },
    required: ['option', 'heard'],
  },
} as const

/** Аукцион: один из вариантов на экране; конкретный список подставляется в схему на каждый запрос. */
export const auctionBidTool = {
  type: 'function',
  name: 'auctionBid',
  description: 'Какой вариант ставки на экране назвал игрок в аукционе. Если неясно — choice="unclear".',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      choice: { type: 'string', enum: ['amount', 'pass', 'allIn', 'unclear'], description: 'amount — сумма из вариантов; pass — пас; allIn — ва-банк; unclear — неясно.' },
      amount: { type: 'integer', description: 'Сумма из вариантов при choice=amount, иначе 0.' },
      heard: { type: 'string', description: 'Дословно, что сказал игрок.' },
    },
    required: ['choice', 'amount', 'heard'],
  },
} as const

type ToolSchema = { name: string; parameters: { properties: Record<string, object> } }

function narrow<T extends ToolSchema>(tool: T, patch: Record<string, object>): T {
  const properties = { ...tool.parameters.properties }
  for (const [key, extra] of Object.entries(patch)) properties[key] = { ...properties[key], ...extra }
  return { ...tool, parameters: { ...tool.parameters, properties } }
}

/** selectQuestion только с id открытых тем и их номиналами. */
export function selectQuestionToolFor(themeIds: string[], values: number[]): typeof selectQuestionTool {
  return narrow(selectQuestionTool, {
    themeId: { enum: [...new Set(themeIds)] },
    value: { enum: [...new Set([0, ...values])] },
  })
}

/** auctionBid только с вариантами на экране. */
export function auctionBidToolFor(options: Array<{ kind: 'pass' | 'stake' | 'allIn'; amount?: number }>): typeof auctionBidTool {
  const kinds = new Set<string>(options.map((option) => (option.kind === 'stake' ? 'amount' : option.kind)))
  const amounts = options.filter((option) => option.kind === 'stake').map((option) => option.amount ?? 0)
  return narrow(auctionBidTool, {
    choice: { enum: [...['amount', 'pass', 'allIn'].filter((kind) => kinds.has(kind)), 'unclear'] },
    amount: { enum: [...new Set([0, ...amounts])] },
  })
}

export const sessionTools = [selectQuestionTool, submitAnswerJudgmentTool, selectCatRecipientTool, pickCatStakeTool, auctionBidTool]

/** Назначение tool-вызова по имени: так controller узнаёт, кому ответ. */
export const toolPurposes: Record<string, string> = {
  selectQuestion: 'select',
  submitAnswerJudgment: 'judge',
  selectCatRecipient: 'catPick',
  pickCatStake: 'specialBid',
  auctionBid: 'specialBid',
}

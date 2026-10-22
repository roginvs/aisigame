import { describe, expect, it } from 'vitest'
import { judgmentChatText, nearHomophone, quotesForeignTitle, sameEtalon, sameZeroAnswer, settleJudgment, sharesAnswer } from './judgment.ts'

const seasons = {
  activeQuestionId: 'r0-t1-200-1',
  activePlayerId: 2 as const,
  attemptId: 2,
  questionText: 'Кто написал «Времена года»?',
  answers: ['Антонио Вивальди', 'Вивальди'],
}

describe('settleJudgment', () => {
  const roman = {
    activeQuestionId: 'r0-t0-100-0', activePlayerId: 1, attemptId: 1,
    reportedQuestionId: 'r0-t0-100-0', reportedPlayerId: 1, reportedAttemptId: 1,
    questionText: 'Как звали первого римского императора?', answers: ['Октавиан Август', 'Август'],
    status: 'correct' as const, transcript: 'Per di manocchio.', heard: 'Первый диманокль.',
    reason: 'Игрок назвал Октавиана Августа, что является верным ответом на вопрос о первом римском императоре.',
  }

  it('не засчитывает подменённую реплику из живого дампа Qwen 22 октября', () => {
    expect(settleJudgment(roman)).toMatchObject({ status: 'ambiguous', heard: 'Per di manocchio.' })
  })

  it.each(['Август', '', 'Октавиан Август'])('не принимает выдуманное heard=%j вместо исходного текста', (heard) => {
    expect(settleJudgment({ ...roman, heard }).status).toBe('ambiguous')
  })

  it('не засчитывает вердикт текстового судьи без исходного текста', () => {
    expect(settleJudgment({ ...roman, transcript: '', heard: 'Август' }).status).toBe('unintelligible')
  })

  it('не позволяет судье выбросить исправление игрока и оценить только первый вариант', () => {
    expect(settleJudgment({ ...roman, transcript: 'Август, нет, Цезарь', heard: 'Август' }).status).toBe('ambiguous')
  })

  it('сравнивает текст на любом языке и сохраняет знаки чисел', () => {
    const input = { ...roman, answers: ['другой эталон'] }
    expect(settleJudgment({ ...input, transcript: '你好', heard: '再见' }).status).toBe('ambiguous')
    expect(settleJudgment({ ...input, transcript: '-1', heard: '1' }).status).toBe('ambiguous')
    expect(settleJudgment({ ...input, transcript: 'Straße', heard: 'Straße!' }).status).toBe('correct')
  })

  it('разрешает косметические различия записи и смысловой ответ вне эталонов', () => {
    expect(settleJudgment({ ...roman, transcript: '  Гай   Октавий. ', heard: 'гай октавий!' }).status).toBe('correct')
  })

  it('accepts a valid alternative title not listed in package answers', () => {
    const result = settleJudgment({
      ...seasons, activeQuestionId: 'book', reportedQuestionId: 'book',
      reportedPlayerId: 2, reportedAttemptId: 2,
      questionText: 'Назовите роман Булгакова', answers: ['Мастер и Маргарита'],
      status: 'correct', heard: 'Белая гвардия', transcript: 'Белая гвардия',
      reason: '«Белая гвардия» — тоже роман Булгакова и удовлетворяет вопросу.',
    })
    expect(result.status).toBe('correct')
  })

  it('не засчитывает Бетховена за «Времена года», если модель оценила другой вопрос', () => {
    const settled = settleJudgment({
      ...seasons,
      reportedQuestionId: 'r0-t1-200-2',
      reportedPlayerId: 2,
      reportedAttemptId: 2,
      status: 'correct',
      heard: 'Бетховен',
      transcript: 'Бетховен',
      reason: 'Смысл совпал: «Лунную сонату» написал Людвиг ван Бетховен.',
    })
    expect(settled.status).toBe('incorrect')
    expect(settled.questionId).toBe('r0-t1-200-1')
    expect(settled.playerId).toBe(2)
    expect(settled.attemptId).toBe(2)
  })

  it('отменяет верный статус, если пояснение цитирует чужое произведение', () => {
    const settled = settleJudgment({
      ...seasons,
      reportedQuestionId: 'r0-t1-200-1',
      reportedPlayerId: 2,
      reportedAttemptId: 2,
      status: 'correct',
      heard: 'Бетховен',
      transcript: 'Бетховен',
      reason: 'Смысл совпал: «Лунную сонату» написал Людвиг ван Бетховен.',
    })
    expect(settled.status).toBe('incorrect')
  })

  it('оставляет баян верным, хотя с аккордеоном нет общих букв', () => {
    const settled = settleJudgment({
      activeQuestionId: 'r0-t1-300-2',
      activePlayerId: 2,
      attemptId: 1,
      questionText: 'Как называется кнопочный духовой инструмент с мехами?',
      answers: ['аккордеон', 'баян'],
      reportedQuestionId: 'r0-t1-300-2',
      reportedPlayerId: 2,
      reportedAttemptId: 1,
      status: 'correct',
      heard: 'Баян',
      transcript: 'Баян',
      reason: 'Смысл совпал: кнопочный инструмент с мехами — баян.',
    })
    expect(settled.status).toBe('correct')
  })

  it('при чужом id всё же засчитывает реплику, если она совпала с эталоном', () => {
    const settled = settleJudgment({
      activeQuestionId: 'r0-t0-100-0',
      activePlayerId: 1,
      attemptId: 1,
      questionText: 'В какое море впадает Волга?',
      answers: ['Каспийское море', 'Каспийское'],
      reportedQuestionId: 'другой',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'incorrect',
      heard: 'Каспий',
      transcript: 'Каспий',
      reason: 'не то море',
    })
    expect(settled.status).toBe('correct')
    expect(sharesAnswer('Каспий', ['Каспийское море'])).toBe(true)
    expect(quotesForeignTitle('«Лунную сонату»', 'Кто написал «Времена года»?', ['Вивальди'])).toBe(true)
  })

  it('засчитывает пересказ загадки про яблоки на берёзе, хотя модель сказала incorrect', () => {
    const settled = settleJudgment({
      activeQuestionId: 'birch',
      activePlayerId: 1,
      attemptId: 1,
      questionText: 'На березе росло 90 яблок. Подул сильный ветер, и 10 яблок упало. Сколько осталось?',
      answers: ['0. На берёзе нет яблок'],
      reportedQuestionId: 'birch',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'incorrect',
      heard: 'Нисколько на берёзе яблоки не растут.',
      transcript: 'Нисколько на берёзе яблоки не растут.',
      reason:
        'Реплика утверждает, что на березе яблоки не растут, поэтому она не совпадает с эталоном про падение яблок с уже существующего дерева.',
    })
    expect(settled.status).toBe('correct')
    expect(settled.reason).toBe('Реплика другими словами говорит то же, что эталон: ничего не осталось.')
  })

  it('засчитывает пояснение загадки и ноль, но не другое число и не чужой рассказ', () => {
    const answers = ['0. На берёзе нет яблок']
    expect(sameZeroAnswer('На берёзе яблоки не растут.', answers)).toBe(true)
    expect(sameZeroAnswer('Ноль.', answers)).toBe(true)
    expect(sameZeroAnswer('Яблок нет.', answers)).toBe(true)
    expect(sameZeroAnswer('Десять.', answers)).toBe(false)
    expect(sameZeroAnswer('Восемьдесят.', answers)).toBe(false)
    expect(sameZeroAnswer('Яблоки.', answers)).toBe(false)
    expect(sameZeroAnswer('Ноль яблок упало.', answers)).toBe(false)
    expect(sameZeroAnswer('Не знаю.', answers)).toBe(false)
    expect(sameZeroAnswer('Нисколько', ['Антонио Вивальди', 'Вивальди'])).toBe(false)
  })

  it('по-прежнему снимает верный статус, если пояснение цитирует чужое произведение', () => {
    const settled = settleJudgment({
      activeQuestionId: 'birch',
      activePlayerId: 1,
      attemptId: 1,
      questionText: 'На березе росло 90 яблок. Подул сильный ветер, и 10 яблок упало. Сколько осталось?',
      answers: ['0. На берёзе нет яблок'],
      reportedQuestionId: 'birch',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'correct',
      heard: 'Ноль',
      transcript: 'Ноль',
      reason: 'Смысл совпал: «Лунную сонату» написал Людвиг ван Бетховен.',
    })
    expect(settled.status).toBe('incorrect')
  })

  it('просит повторить «Читов» при эталоне «Герман Титов» и не засчитывает его', () => {
    const base = {
      activeQuestionId: 'cosmonaut',
      activePlayerId: 1 as const,
      attemptId: 1,
      questionText: 'Кто второй космонавт?',
      answers: ['Герман Титов'],
      reportedQuestionId: 'cosmonaut',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
    }
    const wrong = settleJudgment({
      ...base,
      status: 'incorrect',
      heard: 'Читов',
      transcript: 'Читов',
      reason: 'фамилия не совпала',
    })
    expect(wrong.status).toBe('near_miss')
    expect(wrong.status).not.toBe('correct')
    expect(wrong.status).not.toBe('incorrect')
    const accepted = settleJudgment({
      ...base,
      status: 'correct',
      heard: 'Читов',
      transcript: 'Читов',
      reason: 'похоже на фамилию',
    })
    expect(accepted.status).toBe('near_miss')
    expect(nearHomophone('Читов', ['Герман Титов'])).toBe(true)
  })

  it('оставляет «Титов» верным при эталоне «Герман Титов»', () => {
    const settled = settleJudgment({
      activeQuestionId: 'cosmonaut',
      activePlayerId: 1,
      attemptId: 1,
      questionText: 'Кто второй космонавт?',
      answers: ['Герман Титов'],
      reportedQuestionId: 'cosmonaut',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'correct',
      heard: 'Титов',
      transcript: 'Титов',
      reason: 'названа фамилия',
    })
    expect(settled.status).toBe('correct')
    expect(nearHomophone('Титов', ['Герман Титов'])).toBe(false)
  })

  it('оставляет совсем другой ответ неверным', () => {
    const betelgeuse = settleJudgment({
      activeQuestionId: 'star',
      activePlayerId: 2,
      attemptId: 1,
      questionText: 'Какая звезда ближайшая?',
      answers: ['Солнце'],
      reportedQuestionId: 'star',
      reportedPlayerId: 2,
      reportedAttemptId: 1,
      status: 'incorrect',
      heard: 'Бетельгейзе',
      transcript: 'Бетельгейзе',
      reason: 'другая звезда',
    })
    expect(betelgeuse.status).toBe('incorrect')
    const rude = settleJudgment({
      activeQuestionId: 'coach',
      activePlayerId: 2,
      attemptId: 1,
      questionText: 'Кто тренер?',
      answers: ['Черчесов'],
      reportedQuestionId: 'coach',
      reportedPlayerId: 2,
      reportedAttemptId: 1,
      status: 'incorrect',
      heard: 'жопа',
      transcript: 'жопа',
      reason: 'не то',
    })
    expect(rude.status).toBe('incorrect')
    expect(nearHomophone('жопа', ['Черчесов'])).toBe(false)
    expect(nearHomophone('кот', ['Титов'])).toBe(false)
    expect(nearHomophone('да', ['Герман Титов'])).toBe(false)
  })

  it('не трогает неразборчивый ответ и падеж, который модель уже засчитала', () => {
    const muffled = settleJudgment({
      activeQuestionId: 'cosmonaut',
      activePlayerId: 1,
      attemptId: 1,
      questionText: 'Кто второй космонавт?',
      answers: ['Герман Титов'],
      reportedQuestionId: 'cosmonaut',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'unintelligible',
      heard: 'Читов',
      transcript: 'Читов',
      reason: 'не разобрать',
    })
    expect(muffled.status).toBe('unintelligible')
    const city = settleJudgment({
      activeQuestionId: 'capital',
      activePlayerId: 1,
      attemptId: 1,
      questionText: 'Столица?',
      answers: ['Москва'],
      reportedQuestionId: 'capital',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'correct',
      heard: 'Москве',
      transcript: 'Москве',
      reason: 'тот же город',
    })
    expect(city.status).toBe('correct')
  })

  it('просит повторить «Твэнсдей» при «Уэнсдэй» и «Новоселов» при «Ногу свело»', () => {
    const wednesday = {
      activeQuestionId: 'r1-t0-800-3',
      activePlayerId: 1 as const,
      attemptId: 14,
      questionText: 'Школа, Танцы, Вещь',
      answers: ['Уэнсдэй'],
      reportedQuestionId: 'r1-t0-800-3',
      reportedPlayerId: 1,
      reportedAttemptId: 14,
      heard: 'Это это Твэнсдей.',
      transcript: 'Это это Твэнсдей.',
      reason: 'имя отличается',
    }
    expect(settleJudgment({ ...wednesday, status: 'incorrect' }).status).toBe('near_miss')
    expect(settleJudgment({ ...wednesday, status: 'needs_clarification' }).status).toBe('near_miss')
    expect(settleJudgment({ ...wednesday, status: 'correct' }).status).toBe('correct')
    expect(settleJudgment({ ...wednesday, status: 'unintelligible' }).status).toBe('unintelligible')
    const foot = settleJudgment({
      activeQuestionId: 'r2-t0-900-2',
      activePlayerId: 1,
      attemptId: 16,
      questionText: 'Посмотрите на картинку.',
      answers: ['Ногу свело!'],
      reportedQuestionId: 'r2-t0-900-2',
      reportedPlayerId: 1,
      reportedAttemptId: 16,
      status: 'incorrect',
      heard: 'Новоселов',
      transcript: 'Новоселов',
      reason: 'похоже на имя',
    })
    expect(foot.status).toBe('near_miss')
    expect(nearHomophone('Твэнсдей', ['Уэнсдэй'])).toBe(true)
    expect(nearHomophone('Венсдей', ['Уэнсдэй'])).toBe(true)
    expect(nearHomophone('Новоселов', ['Ногу свело!'])).toBe(true)
    expect(nearHomophone('Матрица', ['Сабрина'])).toBe(false)
    expect(nearHomophone('Апельсин', ['Спаниель'])).toBe(false)
    expect(nearHomophone('Бетельгейзе', ['Солнце'])).toBe(false)
    expect(nearHomophone('Крокодил', ['Брокколи'])).toBe(false)
  })

  it('при низкой уверенности переспрашивает похожую реплику и не трогает чужую', () => {
    const phone = {
      activeQuestionId: 'phone',
      activePlayerId: 1 as const,
      attemptId: 1,
      questionText: 'Что это?',
      answers: ['Телефон'],
      reportedQuestionId: 'phone',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'incorrect' as const,
      heard: 'Телескоп',
      transcript: 'Телескоп',
      reason: 'другое слово',
    }
    expect(settleJudgment({ ...phone, confidence: 0.2 }).status).toBe('near_miss')
    expect(settleJudgment({ ...phone, confidence: 0.9 }).status).toBe('incorrect')
    expect(settleJudgment({ ...phone, confidence: null }).status).toBe('incorrect')
    const star = settleJudgment({
      activeQuestionId: 'star',
      activePlayerId: 2,
      attemptId: 1,
      questionText: 'Какая звезда ближайшая?',
      answers: ['Солнце'],
      reportedQuestionId: 'star',
      reportedPlayerId: 2,
      reportedAttemptId: 1,
      status: 'incorrect',
      heard: 'Бетельгейзе',
      transcript: 'Бетельгейзе',
      confidence: 0.1,
      reason: 'другая звезда',
    })
    expect(star.status).toBe('incorrect')
    const broccoli = settleJudgment({
      ...phone,
      answers: ['Крокодил'],
      heard: 'Брокколи',
      transcript: 'Брокколи',
      confidence: 0.1,
    })
    expect(broccoli.status).toBe('incorrect')
  })
})

describe('совпадение с эталоном', () => {
  const coded = {
    activeQuestionId: 'r2-t2-900-2',
    activePlayerId: 3 as const,
    attemptId: 1,
    questionText: 'if Annushka.spilled_oil:\n    Berlioz.head.detach()\n    Woland.start_show()',
    answers: ['Мастер и Маргарита'],
    reportedQuestionId: 'r2-t2-900-2',
    reportedPlayerId: 3,
    reportedAttemptId: 1,
    reason:
      'Ответ не выражает смысл эталона к вопросу о запуске действий после пролива масла, это просто название без связи с условиями и логикой реплики.',
  }

  it('засчитывает «Мастер и Маргарита», хотя модель сказала incorrect', () => {
    const settled = settleJudgment({
      ...coded,
      status: 'incorrect',
      heard: 'Мастер и Маргарита.',
      transcript: 'Мастер и Маргарита.',
    })
    expect(settled.status).toBe('correct')
    expect(settled.reason).toBe('Реплика совпала с эталоном.')
    expect(settled.heard).toBe('Мастер и Маргарита.')
    const chat = judgmentChatText(settled.status, settled.heard)
    expect(chat).toBe('Статус: correct\nУслышала: Мастер и Маргарита.')
    expect(chat).not.toContain(settled.reason)
  })

  it('считает кавычки и пробелы обычной пунктуацией и не смотрит на поле heard модели, если есть расшифровка', () => {
    expect(
      settleJudgment({
        ...coded,
        status: 'needs_clarification',
        heard: 'что-то другое',
        transcript: '«Мастер и Маргарита»',
      }).status,
    ).toBe('correct')
    expect(
      settleJudgment({
        ...coded,
        status: 'ambiguous',
        heard: '"Мастер и Маргарита"',
        transcript: '',
      }).status,
    ).toBe('ambiguous')
    expect(sameEtalon('  МАСТЕР   и   Маргарита!  ', ['Мастер и Маргарита'])).toBe(true)
    const otherBook = settleJudgment({
      ...coded,
      status: 'incorrect',
      heard: 'Мастер и Маргарита.',
      transcript: 'Война и мир.',
    })
    expect(otherBook.status).toBe('incorrect')
    expect(otherBook.heard).toBe('Война и мир.')
  })

  it('не принимает кусок эталона и длинную фразу, где название только упомянуто', () => {
    const piece = settleJudgment({
      ...coded,
      status: 'incorrect',
      heard: 'Мастер',
      transcript: 'Мастер',
      reason: 'не всё название',
    })
    expect(piece.status).toBe('incorrect')
    const sentence = settleJudgment({
      ...coded,
      status: 'incorrect',
      heard: 'Я читал Мастер и Маргарита в школе, но это не ответ.',
      transcript: 'Я читал Мастер и Маргарита в школе, но это не ответ.',
      reason: 'название внутри фразы',
    })
    expect(sentence.status).toBe('incorrect')
    expect(sameEtalon('Я читал Мастер и Маргарита в школе.', ['Мастер и Маргарита'])).toBe(false)
  })

  it('считает «Ногу свело?» тем же эталоном, а «Новоселов» оставляет созвучием', () => {
    const foot = {
      activeQuestionId: 'r2-t0-900-2',
      activePlayerId: 1 as const,
      attemptId: 16,
      questionText: 'Посмотрите на картинку.',
      answers: ['Ногу свело!'],
      reportedQuestionId: 'r2-t0-900-2',
      reportedPlayerId: 1,
      reportedAttemptId: 16,
      reason: 'похоже на имя',
    }
    const said = settleJudgment({
      ...foot,
      status: 'incorrect',
      heard: 'Ногу свело?',
      transcript: 'Ногу свело?',
      confidence: 0.1,
    })
    expect(said.status).toBe('correct')
    expect(said.reason).toBe('Реплика совпала с эталоном.')
    const near = settleJudgment({
      ...foot,
      status: 'incorrect',
      heard: 'Новоселов',
      transcript: 'Новоселов',
    })
    expect(near.status).toBe('near_miss')
    expect(near.status).not.toBe('correct')
    expect(sameEtalon('Новоселов', ['Ногу свело!'])).toBe(false)
  })

  it('засчитывает любой эталон целиком, в том числе форму в скобках, и букву варианта', () => {
    const band = settleJudgment({
      activeQuestionId: 'band',
      activePlayerId: 2,
      attemptId: 1,
      questionText: 'Какая группа?',
      answers: ['The Animals (Звери)', 'группа «Звери»'],
      reportedQuestionId: 'band',
      reportedPlayerId: 2,
      reportedAttemptId: 1,
      status: 'incorrect',
      heard: 'Звери',
      transcript: 'Звери',
      reason: 'не объяснил, какая группа',
    })
    expect(band.status).toBe('correct')
    expect(sameEtalon('The Animals', ['The Animals (Звери)'])).toBe(true)
    expect(sameEtalon('группа Звери', ['группа «Звери»'])).toBe(true)
    expect(sameEtalon('группа', ['The Animals (Звери)', 'группа «Звери»'])).toBe(false)
    expect(sameEtalon('мне нравятся Звери, но это не то', ['The Animals (Звери)'])).toBe(false)
    const choice = {
      activeQuestionId: 'choice',
      activePlayerId: 1 as const,
      attemptId: 1,
      questionText: 'Какой вариант?',
      answers: ['D', 'Звёздные войны'],
      reportedQuestionId: 'choice',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
    }
    const letter = settleJudgment({
      ...choice,
      status: 'needs_clarification',
      heard: 'D.',
      transcript: 'D.',
      reason: 'только буква',
    })
    expect(letter.status).toBe('correct')
    expect(sameEtalon('Звёздные войны', ['D', 'Звёздные войны'])).toBe(true)
    const wrongLetter = settleJudgment({
      ...choice,
      status: 'incorrect',
      heard: 'C',
      transcript: 'C',
      reason: 'другая буква',
    })
    expect(wrongLetter.status).toBe('incorrect')
    const surname = settleJudgment({
      activeQuestionId: 'cosmonaut',
      activePlayerId: 1,
      attemptId: 1,
      questionText: 'Кто второй космонавт?',
      answers: ['Герман Титов'],
      reportedQuestionId: 'cosmonaut',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      status: 'incorrect',
      heard: 'Титов',
      transcript: 'Титов',
      reason: 'только фамилия',
    })
    expect(surname.status).toBe('incorrect')
  })

  it('не переводит послоговый эталон в уточнение', () => {
    const coined = {
      activeQuestionId: 'slag',
      activePlayerId: 1 as const,
      attemptId: 1,
      questionText: 'Стороны заключили договор купли-продажи.',
      answers: ['Пылесосел'],
      reportedQuestionId: 'slag',
      reportedPlayerId: 1,
      reportedAttemptId: 1,
      reason: 'распознавание разрезало слово',
    }
    const split = settleJudgment({
      ...coined,
      status: 'needs_clarification',
      heard: 'пы ле со сел',
      transcript: 'пы ле со сел',
    })
    expect(split.status).toBe('correct')
    expect(split.status).not.toBe('needs_clarification')
    expect(split.status).not.toBe('near_miss')
    const halves = settleJudgment({
      ...coined,
      status: 'incorrect',
      heard: 'пыле сосел',
      transcript: 'пыле сосел',
    })
    expect(halves.status).toBe('correct')
    const said = settleJudgment({
      ...coined,
      status: 'correct',
      heard: 'пы ле со сел',
      transcript: 'пы ле со сел',
    })
    expect(said.status).toBe('correct')
    const chitov = settleJudgment({
      ...coined,
      answers: ['Герман Титов'],
      status: 'incorrect',
      heard: 'Читов',
      transcript: 'Читов',
    })
    expect(chitov.status).toBe('near_miss')
    const rings = settleJudgment({
      ...coined,
      answers: ['Властелин колец'],
      status: 'incorrect',
      heard: 'Братство кольца',
      transcript: 'Братство кольца',
    })
    expect(rings.status).toBe('incorrect')
  })
})

describe('judgmentChatText', () => {
  it('не пишет в чат эталон и пояснение, где назван правильный ответ', () => {
    const text = judgmentChatText('incorrect', 'Оранжевое.')
    expect(text).toBe('Статус: incorrect\nУслышала: Оранжевое.')
    expect(text).not.toContain('красный')
    expect(text).not.toContain('Эталон')
    expect(text).not.toContain('Почему')
  })
})

describe('audio-authoritative settlement', () => {
  const input = { ...seasons, reportedQuestionId: seasons.activeQuestionId, reportedPlayerId: 2, reportedAttemptId: 2,
    source: 'audio' as const, status: 'correct' as const, heard: 'Вивальди', transcript: 'Бетховен', reason: 'Верно' }
  it('uses heard even when ASR confidently heard something else', () => {
    expect(settleJudgment(input)).toMatchObject({ status: 'correct', heard: 'Вивальди' })
  })
  it('never compares foreign audio ids with the local etalon', () => {
    expect(settleJudgment({ ...input, reportedAttemptId: 8, transcript: 'Вивальди' })).toMatchObject({ status: 'unintelligible', heard: '' })
  })
  it.each(['ambiguous', 'unintelligible'] as const)('does not turn uncertain audio into correct from etalon text (%s)', (status) => {
    expect(settleJudgment({ ...input, status, heard: 'Вивальди', transcript: 'Вивальди' }).status).toBe(status)
  })
  it('cannot use a lucky ASR as the missing audio heard', () => {
    expect(settleJudgment({ ...input, heard: '', transcript: 'Вивальди' }).status).toBe('unintelligible')
  })
})

import { exactAnswer } from './judgment.ts'

describe('точное совпадение с эталоном', () => {
  it('регистр, ё, пробелы и знаки не важны; другое слово — не совпадение', () => {
    expect(exactAnswer('Spotify', ['Spotify'])).toBe(true)
    expect(exactAnswer('spotify.', ['Spotify'])).toBe(true)
    expect(exactAnswer('Ёжик', ['ежик'])).toBe(true)
    expect(exactAnswer('Spotify Music', ['Spotify'])).toBe(false)
    expect(exactAnswer('', ['Spotify'])).toBe(false)
  })
})

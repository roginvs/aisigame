import { expect, test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

test('ключи моделей помнятся по отдельности', async ({ page }) => {
  await page.goto('/')
  const order = await page.locator('.card .field span').allTextContents()
  expect(order.slice(0, 4)).toEqual(['Пакет вопросов', 'Имена игроков', 'Модель', 'Ключ OpenAI'])
  await expect(page.getByLabel('Имена игроков')).toHaveValue('Игрок 1; Игрок 2; Игрок 3;')
  await page.getByLabel('Модель').selectOption('grok-voice-think-fast-2.0')
  await page.getByLabel('Ключ xAI').fill('xai-test-key')
  await page.getByLabel('Модель').selectOption('gpt-realtime-2.1')
  await expect(page.getByLabel('Ключ OpenAI')).toHaveValue('')
  await page.getByLabel('Ключ OpenAI').fill('sk-test-openai')
  await page.getByLabel('Модель').selectOption('gemini-3.8-live')
  await page.getByLabel('Ключ Google').fill('google-test-key')
  await page.getByLabel('Модель').selectOption('grok-voice-latest')
  await expect(page.getByLabel('Ключ xAI')).toHaveValue('xai-test-key')
  await page.reload()
  await expect(page.getByLabel('Модель')).toHaveValue('grok-voice-latest')
  await expect(page.getByLabel('Ключ xAI')).toHaveValue('xai-test-key')
  await page.getByLabel('Модель').selectOption('mock')
  await expect(page.getByText('Заглушка ведущей')).toBeVisible()
  await expect(page.getByLabel('Ключ OpenAI')).toHaveCount(0)
  await page.getByLabel('Модель').selectOption('gpt-realtime-2.1-mini')
  await expect(page.getByLabel('Ключ OpenAI')).toHaveValue('sk-test-openai')
  await page.getByLabel('Модель').selectOption('gemini-3.8-live-extended-thinking')
  await expect(page.getByLabel('Ключ Google')).toHaveValue('google-test-key')
})

test('верный ответ голосом', async ({ page }) => {
  await startDemo(page)
  await expect(page.locator('[data-air="link"]')).toHaveCount(1)
  await expect(page.locator('[data-air="mic"], [data-air="host"]')).toHaveCount(0)
  await hear(page, 'Текст 100')
  await expect(page.getByRole('heading', { name: 'Как звали первого римского императора?' })).toBeVisible()
  await buzz(page, 'Игрок 1')
  await hear(page, 'Август')
  await expect(page.getByText('Верно.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Разговор' }).getByText(/Правильный ответ:/).first()).toBeVisible()
  // Эталон, «Разобрала» и «Отвечает …» — только в «Разговоре», не на карточке вопроса.
  await expect(page.locator('.question', { hasText: /Правильный ответ|Разобрала|Отвечает/ })).toHaveCount(0)
  await board(page)
  await expect(page.getByRole('grid', { name: 'Игровое поле' })).not.toContainText('Правильный ответ')
  await expect(page.getByRole('button', { name: 'Текст, 100, сыграно' })).toBeDisabled()
})

test('неверный ответ не закрывает ячейку, пока могут ответить другие', async ({ page }) => {
  await startDemo(page)
  await pick(page, 'Текст, 100')
  await expect(page.getByRole('heading', { name: 'Как звали первого римского императора?' })).toBeVisible()
  await buzz(page, 'Игрок 1')
  await hear(page, 'Наполеон')
  await expect(page.getByText('Неверно.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Игрок 1: -100' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Апелляция' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Игрок 2', exact: true })).toBeEnabled()
  await expect(page.getByRole('article')).not.toContainText('Правильный ответ')
})

test('никто не нажал: сигнал и ответ пакета, счёт прежний', async ({ page }) => {
  await startDemo(page)
  await pick(page, 'Космос, 100')
  await expect(page.getByRole('heading', { name: 'Кто был вторым человеком в космосе?' })).toBeVisible()
  await expect(page.getByRole('meter', { name: 'Оставшееся время' })).toBeVisible()
  await expect
    .poll(
      async () => {
        const beep = (await page.locator('p[role="status"]').textContent()) ?? ''
        const stillReading = await page.getByRole('heading', { name: 'Кто был вторым человеком в космосе?' }).isVisible()
        return beep.includes('Короткий сигнал') && stillReading
      },
      { timeout: 12_000 },
    )
    .toBe(true)
  // The answer shows in «Разговор» (host bubble and the «Правильный ответ: …» note); strict getByText would see two matches.
  await expect(page.getByText('Герман Титов').first()).toBeVisible({ timeout: 8_000 })
  await expect(page.getByRole('button', { name: 'Космос, 100, сыграно' })).toBeDisabled()
  await expect(page.getByRole('group', { name: 'Игрок 1: 0' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Игрок 2: 0' })).toBeVisible()
})

test('кнопка без ответа списывает номинал', async ({ page }) => {
  await startDemo(page)
  await pick(page, 'Текст, 100')
  await buzz(page, 'Игрок 1')
  await expect(page.getByRole('complementary', { name: 'Разговор' }).locator('.bubble.from-system', { hasText: 'Отвечает Игрок 1' }).first()).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Разговор' }).getByText('Ничего не услышала, минус.')).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('group', { name: 'Игрок 1: -100' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Апелляция' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Игрок 2', exact: true })).toBeEnabled()
})

test('на длинном вопросе полоска идёт, пока ведущая ещё читает', async ({ page }) => {
  await startDemo(page)
  await pick(page, 'Текст, 200')
  const early = page.getByRole('button', { name: /Игрок 1.*вопрос ещё читается/ })
  await expect(early).toBeEnabled({ timeout: 12_000 })
  await expect(page.getByRole('meter', { name: 'Оставшееся время' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Какой газ человек вдыхает/ })).toBeVisible()
  await early.click()
  await hear(page, 'кислород')
  await expect(page.getByText('Верно.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Игрок 1: 200' })).toBeVisible()
})

test('созвучие просит повторить', async ({ page }) => {
  await startDemo(page)
  await pick(page, 'Космос, 100')
  await buzz(page, 'Игрок 1')
  await hear(page, 'Читов')
  await expect(page.getByRole('status').filter({ hasText: 'Повторите, пожалуйста' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Игрок 1: 0' })).toBeVisible()
  await expect(page.getByRole('article')).not.toContainText('Правильный ответ')
})

test('просьбу повторить ответ можно перебить: слушаем сразу', async ({ page }) => {
  await startDemo(page)
  await pick(page, 'Космос, 100')
  await buzz(page, 'Игрок 1')
  await page.evaluate(() => (window as unknown as { __aisigame: { setSpeechMs: (ms: number) => void } }).__aisigame.setSpeechMs(15_000))
  await hear(page, 'Читов')
  await expect(page.getByRole('status').filter({ hasText: 'Повторите, пожалуйста' })).toBeVisible()
  // Ведущая ещё говорит (15 с), игрок отвечает поверх неё.
  await page.evaluate(() => (window as unknown as { __aisigame: { hearSlow: (t: string, h: number, k: number) => void } }).__aisigame.hearSlow('Герман Титов', 1500, 200))
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible({ timeout: 8_000 })
})

test('картинка, звук, ролик, выбор, вопрос без текста, стопка и показ ответа', async ({ page }) => {
  await startDemo(page)
  await pick(page, 'Выбор, 100')
  await expect(page.getByRole('list', { name: 'Варианты ответа' })).toContainText('Звёздные войны')
  await buzz(page, 'Игрок 1')
  await hear(page, 'Звёздные войны')
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()

  await page.getByRole('button', { name: 'Пропустить раунд' }).click()
  await expect(page.getByText('Демо · Наглядно')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()

  await pick(page, 'Картинка, 100')
  await expect(page.getByRole('img', { name: 'Иллюстрация к вопросу' })).toBeVisible()
  await buzz(page, 'Игрок 2')
  await hear(page, 'красный')
  await expect(page.getByRole('group', { name: 'Игрок 2: 100' })).toBeVisible()
  await board(page)

  await pick(page, 'Музыка, 100')
  await expect(page.getByRole('group', { name: 'Звук вопроса' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Уровень звука' })).toBeVisible()
  await buzz(page, 'Игрок 3')
  await hear(page, 'три')
  await expect(page.getByRole('group', { name: 'Игрок 3: 100' })).toBeVisible()
  await board(page)

  await pick(page, 'Ролик, 100')
  await expect(page.getByRole('group', { name: 'Ролик вопроса' })).toBeVisible()
  await buzz(page, 'Игрок 1')
  await hear(page, 'квадрат')
  await expect(page.getByRole('group', { name: 'Игрок 1: 200' })).toBeVisible()
  await board(page)

  await pick(page, 'Без слов, 100')
  await expect(page.getByRole('heading', { name: 'Посмотрите на картинку.' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Иллюстрация к вопросу' })).toBeVisible()
  await buzz(page, 'Игрок 2')
  await hear(page, 'красный')
  await board(page)

  await pick(page, 'Стопка, 100')
  await expect(page.getByRole('heading', { name: 'Первый вопрос стопки?' })).toBeVisible()
  await buzz(page, 'Игрок 3')
  await hear(page, 'первый')
  await board(page)
  await expect(page.getByRole('button', { name: 'Стопка, 100', exact: true })).toBeEnabled()
  await pick(page, 'Стопка, 100')
  await expect(page.getByRole('heading', { name: 'Второй вопрос стопки?' })).toBeVisible()
  await buzz(page, 'Игрок 1')
  await hear(page, 'второй')
  await board(page)
  await expect(page.getByRole('button', { name: 'Стопка, 100, сыграно' })).toBeDisabled()

  await pick(page, 'Показ, 100')
  await expect(page.getByRole('heading', { name: 'Что ставят на документ, чтобы заверить его?' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Иллюстрация к ответу' })).toHaveCount(0)
  await buzz(page, 'Игрок 1')
  await hear(page, 'мимо')
  await buzz(page, 'Игрок 2')
  await hear(page, 'мимо')
  await page.evaluate(() => {
    ;(window as unknown as { __aisigame?: { setSpeechMs: (ms: number) => void } }).__aisigame?.setSpeechMs(2000)
  })
  await buzz(page, 'Игрок 3')
  await hear(page, 'мимо')
  await expect(page.getByRole('article')).not.toContainText('Правильный ответ')
  await expect(page.getByRole('complementary', { name: 'Разговор' }).getByText(/Правильный ответ:/).first()).toBeVisible()
  await expect(page.getByRole('img', { name: 'Иллюстрация к ответу' })).toBeVisible()
})

async function startDemo(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
}

async function board(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
}

async function pick(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
}

async function buzz(page: Page, player: string): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`^${player}(?:\\s*,\\s*вопрос ещё читается)?$`) })
  await expect(page.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible()
  await expect(button).toBeEnabled()
  await button.click()
}

async function hear(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    const controls = (window as unknown as { __aisigame?: { hear: (text: string, durationMs?: number) => void } })
      .__aisigame
    if (!controls) throw new Error('нет заглушки ведущей')
    controls.hear(line, 1400)
  }, text)
}

test('демо-хук звуков игры: без Jitsi эффекты играют локально', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Модель').selectOption('mock')
  await expect.poll(() => page.evaluate(() => window.__aisigame?.playGameSound?.('beep'))).toBe('local')
  await expect.poll(() => page.evaluate(() => window.__aisigame?.playGameSound?.('cat'))).toBe('local')
})

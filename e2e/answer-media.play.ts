import { expect, test, type Page } from '@playwright/test'

const image = { name: 'Иллюстрация к ответу' }

test('картинка ответа видна после верного ответа, пока ведущая объявляет', async ({ page }) => {
  await startDemo(page)
  await setSpeechMs(page, 1500)
  await page.getByRole('button', { name: 'Показ, 100', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Что ставят на документ, чтобы заверить его?' })).toBeVisible()
  await expect(page.getByRole('img', image)).toHaveCount(0)
  await buzz(page, 'Игрок 1')
  await hear(page, 'печать')
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
  await expect(page.getByRole('img', image)).toBeVisible()
  await expectLoaded(page)
  // Не мелькает: держится и после конца речи (удержание answerMediaHoldMs).
  await page.waitForTimeout(2500)
  await expect(page.getByRole('img', image)).toBeVisible()
})

test('картинка ответа видна, когда никто не нажал', async ({ page }) => {
  await startDemo(page)
  await page.getByRole('button', { name: 'Показ, 100', exact: true }).click()
  await expect(page.getByRole('img', image)).toBeVisible({ timeout: 30_000 })
  await expectLoaded(page)
  await expect(page.getByRole('article')).not.toContainText('Правильный ответ')
  await expect(page.getByRole('complementary', { name: 'Разговор' }).getByText(/Правильный ответ:/).first()).toBeVisible()
})

test('конференция: картинка ответа у мастера и у игрока', async ({ browser }) => {
  const context = await browser.newContext()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const master = await context.newPage()
  const joiner = await context.newPage()
  await master.goto('/?mock=1&transport=broadcast')
  await master.getByLabel('Модель').selectOption('mock')
  await master.getByRole('radio', { name: 'Конференция' }).check()
  await master.getByLabel('Пакет вопросов').selectOption('demo')
  await master.getByLabel('Ваше имя').fill('Мастер')
  await master.getByRole('button', { name: 'Начать игру' }).click()
  const invite = localInviteUrl(await copyInvite(master), master.url())
  await joiner.goto(`${invite}&mock=1`)
  await joiner.getByLabel('Ваше имя').fill('Гость')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
  await joiner.getByRole('button', { name: 'Я в игре' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await expect(joiner.getByRole('status').filter({ hasText: 'Гость выбирает вопрос' })).toBeVisible({ timeout: 30_000 })
  await master.getByRole('button', { name: /Пропустить раунд/ }).click()
  // Во втором раунде при двух игроках круг выбирающего возвращается к мастеру.
  await expect(master.getByRole('button', { name: 'Показ, 100' })).toBeEnabled({ timeout: 30_000 })
  await expect(joiner.getByRole('button', { name: 'Показ, 100' })).toBeDisabled()
  await setSpeechMs(master, 1500)
  await master.getByRole('button', { name: 'Показ, 100' }).click()
  await expect(joiner.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible({ timeout: 20_000 })
  await joiner.getByRole('group', { name: /Гость:/ }).getByRole('button', { name: 'Жмите' }).click()
  await hear(master, 'печать')
  await expect(master.getByRole('img', image)).toBeVisible({ timeout: 20_000 })
  await expect(joiner.getByRole('img', image)).toBeVisible({ timeout: 10_000 })
  await context.close()
})

async function startDemo(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
  // «Показ» — во втором раунде демо-пакета.
  await page.getByRole('button', { name: /Пропустить раунд/ }).click()
  await expect(page.getByRole('button', { name: 'Показ, 100', exact: true })).toBeEnabled({ timeout: 20_000 })
}

async function setSpeechMs(page: Page, ms: number): Promise<void> {
  await page.evaluate((value) => window.__aisigame?.setSpeechMs(value), ms)
}

async function buzz(page: Page, player: string): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible()
  await page.getByRole('button', { name: new RegExp(`^${player}(?:\\s*,\\s*вопрос ещё читается)?$`) }).click()
}

async function hear(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => window.__aisigame?.hear(line, 1400), text)
}

async function copyInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Ссылка для игры' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ссылка для игры' })
  await dialog.getByRole('button', { name: 'Скопировать ссылку' }).click()
  const invite = await page.evaluate(async () => navigator.clipboard.readText())
  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  return invite
}

function localInviteUrl(invite: string, masterUrl: string): string {
  const url = new URL(invite)
  const master = new URL(masterUrl)
  url.protocol = master.protocol
  url.host = master.host
  return url.href
}

/** Картинка не «битая»: браузер её декодировал. */
async function expectLoaded(page: Page): Promise<void> {
  await expect.poll(() => page.getByRole('img', image).evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

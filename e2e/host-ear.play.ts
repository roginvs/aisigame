import { expect, test } from '@playwright/test'

test('плашка ведущей: «Слышу…» → «Поняла, думаю…» у мастера и у joiner', async ({ browser }) => {
  const context = await browser.newContext()
  const master = await context.newPage()
  const joiner = await context.newPage()
  await master.goto('/?mock=1&transport=broadcast')
  await master.getByLabel('Модель').selectOption('mock')
  await master.getByRole('radio', { name: 'Конференция' }).check()
  await master.getByLabel('Пакет вопросов').selectOption('demo')
  await master.getByLabel('Ваше имя').fill('Мастер')
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await master.getByRole('button', { name: 'Ссылка для игры' }).click()
  const invite = await master.getByLabel('Ссылка для игроков').inputValue()
  await master.getByRole('button', { name: 'Закрыть' }).click()
  const url = new URL(invite)
  const base = new URL(master.url())
  url.protocol = base.protocol
  url.host = base.host
  url.searchParams.set('mock', '1')
  url.searchParams.set('transport', 'broadcast')
  await joiner.goto(url.toString())
  await joiner.getByLabel('Ваше имя').fill('Гость')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
  // В лобби ухо не показываем: там нет хода, который его погасит.
  await master.evaluate(() => window.__aisigame?.hearSlow?.('привет', 400, 200))
  await master.waitForTimeout(200)
  await expect(master.getByTestId('host-ear')).toHaveCount(0)
  await master.waitForTimeout(800)
  await joiner.getByRole('button', { name: 'Я готов' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await expect(joiner.getByRole('status').filter({ hasText: 'Гость выбирает вопрос' })).toBeVisible({ timeout: 30_000 })

  // Мик открыт, речи нет — статичный зелёный кружок у мастера и гостя.
  for (const page of [master, joiner]) await expect(page.getByTestId('host-ear')).toHaveAttribute('data-ear', 'listening')
  await master.evaluate(() => window.__aisigame?.hearSlow?.('Текст сто', 3000, 1500))
  for (const page of [master, joiner]) {
    await expect(page.getByTestId('host-ear')).toHaveAttribute('data-ear', 'hearing')
    await expect(page.locator('.host strong')).toHaveText('Слышу…')
  }
  for (const page of [master, joiner]) {
    await expect(page.getByTestId('host-ear')).toHaveAttribute('data-ear', 'processing')
    await expect(page.locator('.host strong')).toHaveText('Поняла, думаю…')
  }
  for (const page of [master, joiner]) {
    // После разбора — снова статичный кружок «слушаю» или без значка (говорит ведущая).
    await expect(page.locator('[data-ear="hearing"], [data-ear="processing"]')).toHaveCount(0, { timeout: 10_000 })
  }
  await context.close()
})

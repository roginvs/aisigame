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

  await master.evaluate(() => window.__aisigame?.hearSlow?.('раз два три', 3000, 1500))
  for (const page of [master, joiner]) {
    await expect(page.getByTestId('host-ear')).toHaveAttribute('data-ear', 'hearing')
    await expect(page.locator('.host strong')).toHaveText('Слышу…')
  }
  for (const page of [master, joiner]) {
    await expect(page.getByTestId('host-ear')).toHaveAttribute('data-ear', 'processing')
    await expect(page.locator('.host strong')).toHaveText('Поняла, думаю…')
  }
  for (const page of [master, joiner]) {
    await expect(page.getByTestId('host-ear')).toHaveCount(0, { timeout: 10_000 })
  }
  await context.close()
})

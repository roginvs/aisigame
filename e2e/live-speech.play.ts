import { expect, test } from '@playwright/test'

test('речь игрока растёт в чате черновиком у мастера и у joiner, потом заменяется итогом', async ({ browser }) => {
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
  await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })

  const phrase = 'раз два три четыре пять шесть'
  await master.evaluate((text) => window.__aisigame?.hearLive?.(text, 400), phrase)
  for (const page of [master, joiner]) {
    const live = page.getByTestId('live-speech')
    await expect(live).toContainText('раз два')
    await expect(live).toHaveClass(/bubble-live/)
  }
  await expect(joiner.getByTestId('live-speech')).toContainText('четыре')
  for (const page of [master, joiner]) {
    await expect(page.getByTestId('live-speech')).toHaveCount(0)
    await expect(page.locator('.chat-log .bubble.from-player:not(.bubble-live)', { hasText: phrase })).toHaveCount(1)
  }
  await context.close()
})

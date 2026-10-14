import { expect, test } from '@playwright/test'

test('гость посреди партии виден сразу: плитка, статус загрузки, «ещё не играет»', async ({ browser }) => {
  const context = await browser.newContext()
  const master = await context.newPage()
  const first = await context.newPage()
  const late = await context.newPage()
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

  await first.goto(url.toString())
  await first.getByLabel('Ваше имя').fill('Аня')
  await first.getByRole('button', { name: 'Подключиться' }).click()
  await expect(first.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
  await first.getByRole('button', { name: 'Я готов' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await expect(first.getByRole('status').filter({ hasText: 'Аня выбирает вопрос' })).toBeVisible({ timeout: 30_000 })

  // Поздний гость с «битым» пакетом: сверка не пройдёт — моделирует долгую загрузку.
  await late.goto(url.toString())
  await late.getByLabel('Ваше имя').fill('Боря')
  await late.evaluate(async () => {
    sessionStorage.setItem('aisigame.tamperPack', '1')
    // Кеш пакета общий для вкладок: без него поздний гость реально качает и сверяет.
    await new Promise((resolve) => { const request = indexedDB.deleteDatabase('aisigame.packs'); request.onsuccess = request.onerror = request.onblocked = () => resolve(null) })
  })
  await late.getByRole('button', { name: 'Подключиться' }).click()

  for (const page of [master, first]) {
    const tile = page.getByRole('group', { name: 'Боря, ещё не играет' })
    await expect(tile).toBeVisible({ timeout: 15_000 })
    await expect(tile).toContainText('ещё не играет')
    await expect(tile.getByRole('progressbar')).toBeVisible()
  }
  // Игроком партии он не стал: кнопки ответа у него нет.
  await expect(master.getByRole('group', { name: /^Боря: / })).toHaveCount(0)
  await context.close()
})

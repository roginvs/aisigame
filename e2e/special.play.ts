import { expect, test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

test('кот в мешке: отдать кнопкой, ставка кнопкой, верный ответ', async ({ page }) => {
  await startSpecialRound(page)
  await page.getByRole('button', { name: 'Сюрприз, 200', exact: true }).click()
  const panel = page.getByRole('article', { name: 'Кот в мешке' })
  await expect(panel.getByRole('img', { name: 'Кот в мешке' })).toBeVisible()
  await expect(panel).not.toContainText('Животные')
  const give = panel.getByRole('group', { name: 'Кому отдать' })
  await expect(give.getByRole('button')).toHaveCount(2)
  const recipient = (await give.getByRole('button').first().textContent()) ?? ''
  await give.getByRole('button').first().click()
  await expect(panel).toContainText('Животные')
  await panel.getByRole('button', { name: 'Максимум 300' }).click()
  await expect(page.getByRole('heading', { name: 'Какое животное самое быстрое на суше?' })).toBeVisible()
  // Кнопок перехвата нет: отвечает только получатель.
  await answer(page, 'гепард')
  await expect(page.getByText('Верно.')).toBeVisible()
  await expect(page.getByRole('group', { name: `${recipient}: 300` })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Сюрприз, 200, сыграно' })).toBeDisabled()
})

test('кот в мешке голосом: имя получателя и ставка', async ({ page }) => {
  await startSpecialRound(page)
  await hear(page, 'Сюрприз 300')
  const panel = page.getByRole('article', { name: 'Кот в мешке' })
  await expect(panel).toContainText('Города')
  await expect(panel.getByRole('group', { name: 'Кому отдать' })).toBeVisible()
  const giverLine = (await panel.locator('.special-status').textContent()) ?? ''
  const target = giverLine.startsWith('Игрок 1') ? 'Игрок 2' : 'Игрок 1'
  await expect(panel).toHaveAttribute('data-listening', 'true')
  await hear(page, `отдаю игроку ${target.slice(-1)}`)
  await expect(panel.getByRole('group', { name: 'Ставка' })).toBeVisible()
  await expect(panel).toHaveAttribute('data-listening', 'true')
  await hear(page, 'минимум')
  await expect(page.getByRole('heading', { name: 'Какой город называют Северной столицей России?' })).toBeVisible()
  await answer(page, 'не знаю')
  await expect(page.getByRole('group', { name: `${target}: -100` })).toBeVisible()
})

test('аукцион: единственный при деньгах ставит номинал, ответ голосом', async ({ page }) => {
  await startSpecialRound(page)
  await page.getByRole('button', { name: 'Торги, 200', exact: true }).click()
  const panel = page.getByRole('article', { name: 'Аукцион' })
  await expect(panel.getByRole('img', { name: 'Аукцион' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Какой город — столица Австралии?' })).toBeVisible()
  await answer(page, 'Канберра')
  await expect(page.getByText('Верно.')).toBeVisible()
  await expect(page.getByRole('group', { name: /: 200$/ })).toBeVisible()
})

test('аукцион: торг кнопками, перекуп и пас', async ({ page }) => {
  await startSpecialRound(page)
  // Сначала у двух игроков появляются деньги.
  await page.getByRole('button', { name: 'Сюрприз, 100', exact: true }).click()
  await buzzAndHear(page, 'Игрок 1', 'восемь')
  await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
  await page.getByRole('button', { name: 'Сюрприз, 200', exact: true }).click()
  const cat = page.getByRole('article', { name: 'Кот в мешке' })
  await cat.getByRole('button', { name: 'Игрок 2' }).click()
  await cat.getByRole('button', { name: 'Максимум 300' }).click()
  await answer(page, 'гепард')
  await expect(page.getByRole('group', { name: 'Игрок 2: 300' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
  await page.getByRole('button', { name: 'Сюрприз, 300', exact: true }).click()
  const bag = page.getByRole('article', { name: 'Кот в мешке' })
  await bag.getByRole('button', { name: 'Игрок 1' }).click()
  await bag.getByRole('button', { name: 'Максимум 300' }).click()
  await answer(page, 'Петербург')
  await expect(page.getByRole('group', { name: 'Игрок 1: 400' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()

  // Игрок 1 выбирает и открывает аукцион, у Игрока 2 есть чем перекупить.
  await page.getByRole('button', { name: 'Торги, 200', exact: true }).click()
  const panel = page.getByRole('article', { name: 'Аукцион' })
  const bids = panel.getByRole('group', { name: 'Ставка аукциона' })
  await expect(panel).toContainText('Игрок 1 делает ставку')
  await bids.getByRole('button', { name: '200', exact: true }).click()
  await expect(panel).toContainText('Игрок 2 решает, перекупать ли')
  await bids.getByRole('button', { name: 'Ва-банк 300' }).click()
  await expect(panel).toContainText('Игрок 1 решает, перекупать ли')
  await expect(bids.getByRole('button')).toHaveText(['Пас', 'Ва-банк 400'])
  // Голос слушаем после вопроса ведущей.
  await expect(panel).toHaveAttribute('data-listening', 'true')
  await hear(page, 'пас')
  await expect(page.getByRole('heading', { name: 'Какой город — столица Австралии?' })).toBeVisible()
  await answer(page, 'Сидней')
  await expect(page.getByRole('group', { name: 'Игрок 2: 0' })).toBeVisible()
})

test('кот: запасной разбор моделью (имя и ставка), минус ставки и апелляция на ставку', async ({ page }) => {
  await startSpecialRound(page, 'Анна; Борис; Вера;')
  await page.getByRole('button', { name: 'Сюрприз, 200', exact: true }).click()
  const panel = page.getByRole('article', { name: 'Кот в мешке' })
  await expect(panel).toHaveAttribute('data-listening', 'true')
  const giverLine = (await panel.locator('.special-status').textContent()) ?? ''
  const [target, nick] = giverLine.startsWith('Анна') ? ['Вера', 'Верунчик'] : ['Анна', 'Анюта']
  // Ласкательное имя локально не узнаётся — решает модель (здесь заглушка), только из кандидатов.
  await hear(page, `пусть будет ${nick}`)
  await expect(panel.getByRole('group', { name: 'Ставка' })).toBeVisible()
  await expect(panel).toHaveAttribute('data-listening', 'true')
  await hear(page, 'давайте по-крупному')
  await expect(page.getByRole('heading', { name: 'Какое животное самое быстрое на суше?' })).toBeVisible()
  await answer(page, 'не знаю')
  const group = page.getByRole('group', { name: `${target}: -300` })
  await expect(group).toBeVisible()
  await group.getByRole('button', { name: 'Апелляция' }).click()
  await page.getByRole('button', { name: 'Да, я ответил правильно' }).click()
  await expect(page.getByRole('group', { name: `${target}: 300` })).toBeVisible()
})

async function startSpecialRound(page: Page, names?: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Модель').selectOption('mock')
  if (names) await page.getByLabel('Имена игроков').fill(names)
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('button', { name: 'Пропустить раунд' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
  }
  await expect(page.getByRole('button', { name: 'Сюрприз, 200', exact: true })).toBeVisible()
}

async function buzzAndHear(page: Page, player: string, text: string): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`^${player}(?:\\s*,\\s*вопрос ещё читается)?$`) })
  await expect(page.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible()
  await button.click()
  await hear(page, text)
}

async function answer(page: Page, text: string): Promise<void> {
  // Отвечает только получатель: ждём, пока дочитан вопрос и пошло время ответа.
  await expect(page.getByRole('article').getByRole('meter', { name: 'Оставшееся время' })).toBeVisible()
  await hear(page, text)
}

async function hear(page: Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    const controls = (window as unknown as { __aisigame?: { hear: (text: string, durationMs?: number) => void } }).__aisigame
    if (!controls) throw new Error('нет заглушки ведущей')
    controls.hear(line, 1400)
  }, text)
}

test('конференция: гость отдаёт кота кнопкой, получатель ставит, аукцион кнопкой гостя', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext()
  const master = await context.newPage()
  const guests = [await context.newPage(), await context.newPage()]
  const names = ['Мастер', 'Гость', 'Гостья']
  try {
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await master.getByRole('button', { name: 'Ссылка для игры' }).click()
    const dialog = master.getByRole('dialog', { name: 'Ссылка для игры' })
    const invite = new URL(await dialog.getByLabel('Ссылка для игроков').inputValue())
    invite.host = new URL(master.url()).host
    invite.protocol = new URL(master.url()).protocol
    invite.searchParams.set('mock', '1')
    await dialog.getByRole('button', { name: 'Закрыть' }).click()
    for (const [index, guest] of guests.entries()) {
      await guest.goto(invite.href)
      await guest.getByLabel('Ваше имя').fill(names[index + 1]!)
      await guest.getByRole('button', { name: 'Подключиться' }).click()
      await expect(guest.getByRole('button', { name: 'Я готов' })).toBeEnabled()
      await guest.getByRole('button', { name: 'Я готов' }).click()
    }
    await master.getByRole('button', { name: 'Начать игру' }).click()
    for (let index = 0; index < 2; index += 1) {
      await expect(master.getByRole('button', { name: 'Пропустить раунд' })).toBeEnabled()
      await master.getByRole('button', { name: 'Пропустить раунд' }).click()
    }
    const pages = [master, ...guests]
    const status = master.getByRole('status').filter({ hasText: 'выбирает вопрос' })
    await expect(status).toBeVisible()
    await expect(master.getByRole('button', { name: 'Сюрприз, 200' })).toBeVisible()
    const chooserName = ((await status.textContent()) ?? '').match(/(Мастер|Гостья|Гость) выбирает/)?.[1] ?? ''
    const giver = pages[names.indexOf(chooserName)]!
    await giver.getByRole('button', { name: 'Сюрприз, 200', exact: true }).click()
    // Получатель — гость, который не выбирал.
    const recipientName = chooserName === 'Гость' ? 'Гостья' : 'Гость'
    const recipient = pages[names.indexOf(recipientName)]!
    for (const page of pages) await expect(page.getByRole('article', { name: 'Кот в мешке' }).getByRole('img', { name: 'Кот в мешке' })).toBeVisible()
    for (const page of pages.filter((item) => item !== giver)) {
      await expect(page.getByRole('group', { name: 'Кому отдать' })).toHaveCount(0)
    }
    await giver.getByRole('group', { name: 'Кому отдать' }).getByRole('button', { name: recipientName }).click()
    const stake = recipient.getByRole('group', { name: 'Ставка' })
    await expect(stake).toBeVisible()
    for (const page of pages.filter((item) => item !== recipient)) {
      await expect(page.getByRole('article', { name: 'Кот в мешке' })).toContainText('Животные')
      await expect(page.getByRole('group', { name: 'Ставка' })).toHaveCount(0)
    }
    await stake.getByRole('button', { name: 'Максимум 300' }).click()
    await expect(master.getByRole('heading', { name: 'Какое животное самое быстрое на суше?' })).toBeVisible()
    await expect(master.getByRole('article').getByRole('meter', { name: 'Оставшееся время' })).toBeVisible()
    await hear(master, 'гепард')
    for (const page of pages) await expect(page.getByRole('group', { name: `${recipientName}: 300` })).toBeVisible()

    // Получатель теперь выбирает: аукцион, ставка кнопкой с экрана гостя.
    await recipient.getByRole('button', { name: 'Торги, 200', exact: true }).click()
    const bids = recipient.getByRole('group', { name: 'Ставка аукциона' })
    await expect(bids.getByRole('button')).toHaveText(['200', 'Ва-банк 300'])
    await expect(master.getByRole('group', { name: 'Ставка аукциона' })).toHaveCount(0)
    await bids.getByRole('button', { name: 'Ва-банк 300' }).click()
    await expect(master.getByRole('heading', { name: 'Какой город — столица Австралии?' })).toBeVisible()
    await expect(master.getByRole('article').getByRole('meter', { name: 'Оставшееся время' })).toBeVisible()
    await hear(master, 'Канберра')
    for (const page of pages) await expect(page.getByRole('group', { name: `${recipientName}: 600` })).toBeVisible()
  } finally {
    await context.close()
  }
})

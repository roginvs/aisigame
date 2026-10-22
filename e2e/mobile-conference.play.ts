import { expect, test, type Page } from '@playwright/test'

test('joiner на телефоне скроллит страницу и дотягивается до чата без бокового скролла', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
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

  await joiner.goto(localInviteUrl(invite, master.url()))
  await joiner.getByLabel('Ваше имя').fill('Гость')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
  await expect(master.getByText('Пакет сверен', { exact: false })).toBeVisible()
  await expect(master.getByText('Сверка…', { exact: true })).toHaveCount(0)
  await expect(joiner.locator('[data-air]')).toHaveCount(0)
  await expect(joiner.getByText('Введите ключ и начните игру', { exact: true })).toHaveCount(0)

  await expectNoPageSideScroll(joiner)
  await expectPageCanScrollVertically(joiner)

  const compose = joiner.getByPlaceholder('Сообщение в чат…')
  const send = joiner.getByRole('button', { name: 'Отправить' })
  const ready = joiner.getByRole('button', { name: 'Я в игре' })
  const mic = joiner.getByRole('button', { name: 'Включить микрофон' })
  await expect(joiner.getByRole('region', { name: 'Участники' })).toBeVisible()
  await ready.scrollIntoViewIfNeeded()
  await expect(ready).toBeVisible()
  await mic.scrollIntoViewIfNeeded()
  await expect(mic).toBeVisible()
  await compose.scrollIntoViewIfNeeded()
  await expect(compose).toBeVisible()
  await expect(send).toBeVisible()
  const composeBox = await compose.boundingBox()
  expect(composeBox).not.toBeNull()
  if (composeBox) {
    expect(composeBox.y + composeBox.height).toBeGreaterThan(0)
    expect(composeBox.y).toBeLessThan(844)
  }

  await joiner.getByRole('button', { name: 'Включить камеру' }).click()
  // «Следующая камера» только при >1 videoinput — в headless часто одна/ноль.
  const nextCam = joiner.getByRole('button', { name: 'Следующая камера' })
  if (await nextCam.count()) {
    await expect(nextCam).toBeVisible()
    await nextCam.click()
  }

  await joiner.getByRole('button', { name: 'Я в игре' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await expect(joiner.getByRole('status').filter({ hasText: 'Гость выбирает вопрос' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(joiner.getByRole('status').filter({ hasText: 'Не говорите' })).toHaveCount(0)

  const self = joiner.getByRole('group', { name: /Гость: 0/ })
  await expect(self).toBeVisible()
  await self.scrollIntoViewIfNeeded()
  const selfBox = await self.boundingBox()
  expect(selfBox).not.toBeNull()
  if (selfBox) {
    expect(selfBox.x).toBeGreaterThanOrEqual(0)
    expect(selfBox.x + selfBox.width).toBeLessThanOrEqual(390)
  }
  await expectNoPageSideScroll(joiner)

  await context.close()
})

test('на планшете страница тоже скроллится и кнопки чата доступны', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } })
  const page = await context.newPage()
  await page.goto('/?mock=1&transport=broadcast')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByRole('radio', { name: 'Конференция' }).check()
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByLabel('Ваше имя').fill('Мастер')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  // У формы старта своя кнопка «Начать игру»: её видимость ничего не говорит о лобби.
  // Ждём признаки именно лобби мастера: форма ушла, есть «Ссылка для игры» и
  // «Начать игру» уже внутри стола.
  await expect(page.getByLabel('Пакет вопросов')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ссылка для игры' })).toBeVisible()
  await expect(page.locator('main.table').getByRole('button', { name: 'Начать игру' })).toBeVisible()
  await expectPageCanScrollVertically(page)
  await page.getByPlaceholder('Сообщение в чат…').scrollIntoViewIfNeeded()
  await expect(page.getByPlaceholder('Сообщение в чат…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Включить микрофон' })).toBeVisible()
  await expectNoPageSideScroll(page)
  await context.close()
})

async function expectNoPageSideScroll(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1)
}

async function expectPageCanScrollVertically(page: Page): Promise<void> {
  await expect(page.locator('main.table')).toHaveCount(1)
  const sizes = await page.evaluate(() => ({
    client: document.documentElement.clientHeight,
    scroll: document.documentElement.scrollHeight,
    overflowY: getComputedStyle(document.querySelector('main.table')!).overflowY,
  }))
  // Контент выше окна или хотя бы страница не locked (overflow не hidden у main).
  expect(sizes.overflowY === 'visible' || sizes.overflowY === 'auto' || sizes.scroll > sizes.client).toBe(true)
}

function localInviteUrl(invite: string, masterUrl: string): string {
  const url = new URL(invite)
  const master = new URL(masterUrl)
  url.protocol = master.protocol
  url.host = master.host
  url.searchParams.set('mock', '1')
  url.searchParams.set('transport', 'broadcast')
  return url.href
}

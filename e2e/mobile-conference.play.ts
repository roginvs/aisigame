import { expect, test, type Page } from '@playwright/test'

test('joiner на телефоне не обрезан и управляется без горизонтального скролла страницы', async ({ browser }) => {
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

  await joiner.goto(localInviteUrl(invite))
  await joiner.getByLabel('Ваше имя').fill('Гость')
  await joiner.getByRole('button', { name: 'Подключиться' }).click()
  await expect(joiner.getByRole('button', { name: 'Я готов' })).toBeEnabled({ timeout: 60_000 })
  await expect(master.getByText('Пакет сверен', { exact: false })).toBeVisible()
  await expect(master.getByText('Сверка…', { exact: true })).toHaveCount(0)
  await expect(joiner.locator('[data-air]')).toHaveCount(0)
  await expect(joiner.getByText('Введите ключ и начните игру', { exact: true })).toHaveCount(0)

  await expectNoPageSideScroll(joiner)
  await expect(joiner.locator('[data-air]')).toHaveCount(0)
  await expect(joiner.getByText('Введите ключ и начните игру', { exact: true })).toHaveCount(0)
  await expect(joiner.getByPlaceholder('Сообщение в чат…')).toBeVisible()
  await expect(joiner.getByRole('button', { name: 'Отправить' })).toBeVisible()
  await expect(joiner.locator('.video-strip')).toBeVisible()
  await joiner.getByRole('button', { name: 'Включить камеру' }).click()
  await expect(joiner.getByRole('button', { name: 'Следующая камера' })).toBeVisible()
  await joiner.getByRole('button', { name: 'Следующая камера' }).click()

  await joiner.getByRole('button', { name: 'Я готов' }).click()
  await master.getByRole('button', { name: 'Начать игру' }).click()
  await expect(joiner.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible({
    timeout: 30_000,
  })

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

async function expectNoPageSideScroll(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1)
}

function localInviteUrl(invite: string): string {
  const url = new URL(invite)
  url.protocol = 'http:'
  url.host = '127.0.0.1:5173'
  url.searchParams.set('mock', '1')
  url.searchParams.set('transport', 'broadcast')
  return url.href
}

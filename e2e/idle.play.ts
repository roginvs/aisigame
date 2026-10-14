import { expect, test } from '@playwright/test'

test('молчание на выборе: ведущая зовёт, торопит и передаёт ход следующему', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.getByLabel('Модель').selectOption('mock')
  // Ускорение действует с ближайшего входа в слушающее состояние — включаем до старта.
  await page.evaluate(() => window.__aisigame?.setIdleScale?.(0.05))
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
  const log = page.getByRole('complementary', { name: 'Разговор' })
  await expect(log.getByText('Ждём ваш выбор.')).toHaveCount(2, { timeout: 10_000 })
  await expect(log.getByText(/Время вышло\. Выбирает Игрок \d\./)).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => window.__aisigame?.setIdleScale?.(1))
})

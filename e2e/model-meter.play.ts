import { expect, test } from '@playwright/test'

test('мастер конференции видит индикатор того, что слышит модель;', async ({ page }) => {
  await page.goto('/?mock=1&transport=broadcast')
  await page.evaluate(() => localStorage.removeItem('aisigame.game'))
  await page.reload()
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByRole('radio', { name: 'Конференция' }).check()
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByLabel('Ваше имя').fill('Мастер')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  const meter = page.getByTestId('model-meter')
  await expect(meter).toBeVisible()
  await expect(meter).toHaveAttribute('width', '320')
  await expect(meter).toHaveAttribute('height', '20')
  if (process.env.MODEL_METER_SHOT) {
    await page.locator('header.topbar').screenshot({ path: process.env.MODEL_METER_SHOT })
  }
})

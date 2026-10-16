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
  const legend = page.getByTestId('model-meter-legend')
  await expect(legend).toBeHidden()
  await meter.hover()
  await expect(legend).toBeVisible()
  await expect(legend).toContainText('ушёл в модель')
  await expect(legend).toContainText('вход модели закрыт')
  for (const group of ['hostStart', 'vadStart', 'response', 'reading', 'buzzing', 'answering', 'choosing', 'special', 'appeal', 'phase', 'buzzer', 'hostEnd', 'vadStop', 'responseEnd', 'transcript', 'mixer', 'cancel']) {
    await expect(legend.locator(`[data-group="${group}"] .sw`)).toHaveCount(1)
  }
  if (process.env.MODEL_METER_HOVER_SHOT) await page.screenshot({ path: process.env.MODEL_METER_HOVER_SHOT, clip: { x: 0, y: 0, width: 900, height: 420 } })
  if (process.env.MODEL_METER_SHOT) {
    await page.locator('header.topbar').screenshot({ path: process.env.MODEL_METER_SHOT })
  }
})

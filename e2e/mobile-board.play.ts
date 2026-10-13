import { devices, expect, test } from '@playwright/test'

// The board used to collapse to 0 px on phones: `.stage > .board { flex: 1 1 0 }` inside an auto-height stage.
const phones = {
  'iPhone 13': devices['iPhone 13'],
  'iPhone 13 landscape': devices['iPhone 13 landscape'],
  'Pixel 7': devices['Pixel 7'],
  'Pixel 7 landscape': devices['Pixel 7 landscape'],
}

for (const [name, device] of Object.entries(phones)) {
  const { defaultBrowserType: _browser, ...options } = device
  test.describe(name, () => {
    test.use(options)
    test(`табло видно и нажимается на телефоне (${name})`, async ({ page }) => {
      await page.goto('/?mock=1')
      await page.getByLabel('Модель').selectOption('mock')
      await page.getByLabel('Пакет вопросов').selectOption('demo')
      await page.getByRole('button', { name: 'Начать игру' }).click()
      const board = page.getByRole('grid', { name: 'Игровое поле' })
      await expect(board).toBeVisible()
      const box = (await board.boundingBox())!
      expect(box.height).toBeGreaterThan(150)
      const cell = page.getByRole('button', { name: 'Текст, 100', exact: true })
      await expect(cell).toBeEnabled()
      const cellBox = (await cell.boundingBox())!
      expect(cellBox.height).toBeGreaterThan(30)
      await cell.click()
      await expect(page.getByRole('heading', { name: 'Как звали первого римского императора?' })).toBeVisible()
    })
  })
}

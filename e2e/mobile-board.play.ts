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

async function startDemo(page: import('@playwright/test').Page) {
  await page.goto('/?mock=1')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('grid', { name: 'Игровое поле' })).toBeVisible()
}

test.describe('планшет 820×1180', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })
  test('сразу после старта табло полного размера, без клика', async ({ page }) => {
    await startDemo(page)
    const board = (await page.getByRole('grid', { name: 'Игровое поле' }).boundingBox())!
    expect(board.height).toBeGreaterThan(400)
    const cell = (await page.getByRole('button', { name: 'Текст, 100', exact: true }).boundingBox())!
    expect(cell.height).toBeGreaterThan(60)
  })
})

test.describe('телефон 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('три карточки игроков помещаются без горизонтального скролла', async ({ page }) => {
    await startDemo(page)
    const row = page.locator('.players')
    const [scroll, client] = await row.evaluate((el) => [el.scrollWidth, el.clientWidth])
    expect(scroll).toBeLessThanOrEqual(client + 1)
    const third = (await page.getByRole('group', { name: /^Игрок 3:/ }).boundingBox())!
    expect(third.x + third.width).toBeLessThanOrEqual(390)
  })
})

test.describe('телефон ландшафт 844×390', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })
  test('нижний ряд табло на экране', async ({ page }) => {
    await startDemo(page)
    const board = (await page.getByRole('grid', { name: 'Игровое поле' }).boundingBox())!
    expect(board.y).toBeGreaterThanOrEqual(0)
    expect(board.y + board.height).toBeLessThanOrEqual(390)
  })
})

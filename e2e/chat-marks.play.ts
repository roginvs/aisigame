import { expect as baseExpect, test, type Page } from '@playwright/test'

const expect = baseExpect.configure({ timeout: 15_000 })

async function hear(page: Page, text: string, ms = 900): Promise<void> {
  await page.evaluate(([line, duration]) => (window as unknown as { __aisigame: { hear: (t: string, d: number) => void } }).__aisigame.hear(line as string, duration as number), [text, ms])
}

test('чат: пометки реплик выбора и ответа (не выбор, выбрано, заминка, засчитано)', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
  const chat = page.getByRole('complementary', { name: 'Разговор' })
  await hear(page, 'ну давайте посмотрим что там', 1500)
  await expect(chat.locator('.chat-mark[data-mark="other"]')).toHaveText('не выбор')
  await hear(page, 'Космос сто')
  await expect(chat.locator('.chat-mark[data-mark="picked"]')).toContainText('✓ выбрано')
  await chat.screenshot({ path: process.env.CHAT_MARKS_DIR ? `${process.env.CHAT_MARKS_DIR}/chat-marks-choosing.png` : test.info().outputPath('chat-marks-choosing.png') })

  await expect(page.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible()
  await page.getByRole('button', { name: /^Игрок 1(?:\s*,\s*вопрос ещё читается)?$/ }).click()
  await hear(page, 'хе-хе', 600)
  await page.waitForTimeout(800)
  await hear(page, 'щас-щас, отвечу')
  await page.waitForTimeout(800)
  await hear(page, 'Титов')
  await expect(chat.locator('.chat-mark[data-mark="counted"]')).toHaveText('✓ засчитано')
  await expect(chat.locator('.chat-mark[data-mark="stall"]')).toHaveCount(2)
  await chat.screenshot({ path: process.env.CHAT_MARKS_DIR ? `${process.env.CHAT_MARKS_DIR}/chat-marks.png` : test.info().outputPath('chat-marks.png') })
})

import { expect, test } from '@playwright/test'

test('экран вопроса без скроллбаров и с нормальными репликами', async ({ page }) => {
  const logs: string[] = []
  page.on('console', (message) => logs.push(message.text()))
  await page.goto('/?mock=1')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.locator('.talk .status-line')).toHaveCount(0)
  await expect(page.locator('.eyebrow').first()).toContainText('Мок для тестов')
  await expect(page.getByRole('button', { name: 'Остановить' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Выход' })).toBeVisible()
  await expect(page.locator('.talk .host')).not.toContainText('Ведущая слушает')
  await expect(page.locator('.tech-column')).toHaveCount(0)
  await expect(page.locator('.tech-edge')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/layout-board.png' })

  await page.getByRole('button', { name: 'Пропустить раунд' }).click()
  await expect(page.locator('.talk .host .host-line')).toHaveText('назовите тему и стоимость')
  await hear(page, 'Картинка 100')
  await expect(page.getByRole('heading', { name: 'Какого цвета круг на картинке?' })).toBeVisible()
  await expect(page.getByText('Жмите кнопку')).toBeVisible()

  await hear(page, 'Аранжировать')
  await expect(page.locator('.bubble.from-host', { hasText: 'Какого цвета круг' })).toBeVisible()
  await page.getByRole('button', { name: 'Игрок 2', exact: true }).click()
  await expect(page.locator('.answerer')).toHaveText('Отвечает игрок 2')
  // Состояние ответа ограничено таймером: сохраняем геометрию до серии
  // последующих проверок, а не ждём тот же transient-элемент в самом конце.
  const answererBox = await page.locator('.answerer').boundingBox()

  await page.screenshot({ path: 'test-results/layout-question.png' })

  const questionBox = await page.locator('.question').boundingBox()
  const hostBox = await page.locator('.talk .host').boundingBox()
  const chatBox = await page.locator('.talk .chat-column').boundingBox()
  expect(questionBox && hostBox && chatBox).toBeTruthy()
  if (!questionBox || !hostBox || !chatBox) return
  expect(hostBox.y + hostBox.height).toBeLessThanOrEqual(chatBox.y + 4)
  expect(hostBox.x).toBeGreaterThan(questionBox.x + questionBox.width - 8)
  expect(chatBox.width).toBeGreaterThan(320)
  const fontSize = await page.locator('.question h2').evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))
  expect(fontSize).toBeGreaterThanOrEqual(28)

  const host = page.locator('.bubble.from-host', { hasText: 'Какого цвета круг' })
  const shape = await host.evaluate((element) => {
    const column = element.closest('.chat-scroll')
    const style = getComputedStyle(element)
    return {
      display: style.display,
      columns: style.gridTemplateColumns,
      bubble: element.clientWidth,
      column: column?.clientWidth ?? 0,
      sideways: element.scrollWidth - element.clientWidth,
    }
  })
  expect(shape.display).toBe('block')
  expect(shape.columns).toBe('none')
  expect(shape.bubble).toBeGreaterThan(180)
  expect(shape.column - shape.bubble).toBeLessThan(40)
  expect(shape.sideways).toBeLessThanOrEqual(1)

  for (const selector of ['.question', '.chat-scroll']) {
    const bars = await page.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => ({
        gutter: node.offsetWidth - node.clientWidth,
        sideways: node.scrollWidth - node.clientWidth,
        tall: node.scrollHeight - node.clientHeight,
      })),
    )
    for (const bar of bars) {
      expect(bar.gutter).toBe(0)
      expect(bar.sideways).toBeLessThanOrEqual(1)
      if (selector === '.question') expect(bar.tall).toBeLessThanOrEqual(2)
    }
  }

  const image = page.locator('.question-media img')
  await expect(image).toBeVisible()
  const imageBox = await image.boundingBox()
  expect(questionBox).not.toBeNull()
  expect(imageBox).not.toBeNull()
  expect(answererBox).not.toBeNull()
  if (!questionBox || !imageBox || !answererBox) return
  expect(imageBox.y).toBeGreaterThanOrEqual(questionBox.y - 1)
  expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(questionBox.y + questionBox.height + 2)
  expect(answererBox.y + answererBox.height).toBeLessThanOrEqual(questionBox.y + questionBox.height + 2)
  const imageFit = await image.evaluate((node) => {
    const media = node.closest('.question-media')
    const style = getComputedStyle(node)
    return {
      objectFit: style.objectFit,
      mediaHeight: media instanceof HTMLElement ? media.clientHeight : 0,
      mediaWidth: media instanceof HTMLElement ? media.clientWidth : 0,
    }
  })
  expect(imageFit.objectFit).toBe('contain')
  expect(imageFit.mediaHeight).toBeGreaterThan(80)
  expect(imageBox.height).toBeGreaterThan(40)
  expect(imageBox.height).toBeLessThanOrEqual(imageFit.mediaHeight + 2)
  expect(imageBox.width).toBeLessThanOrEqual(imageFit.mediaWidth + 2)

  await expect(page.locator('.tech-column')).toHaveCount(0)
  const copyDebug = page.locator('.debug-copy')
  await expect(copyDebug).toHaveAccessibleName('Скопировать дебаг')
  await expect(copyDebug).toBeVisible()
  const copyWidth = (await copyDebug.boundingBox())?.width
  await copyDebug.click()
  await expect(copyDebug).toHaveAccessibleName(/Скопировано ~[\d,]+ (КБ|МБ)/)
  expect((await copyDebug.boundingBox())?.width).toBe(copyWidth)
  await expect(copyDebug).toHaveAccessibleName('Скопировать дебаг', { timeout: 3_000 })
  expect((await copyDebug.boundingBox())?.width).toBe(copyWidth)
  await expect(page.getByRole('button', { name: 'Пропустить раунд' })).toBeVisible()
  expect(logs.some((line) => line.includes('[aisigame'))).toBe(true)
  await expect(page.locator('.cost')).toHaveText(/^\d+$/)
  await expect(page.locator('.topbar')).not.toContainText('$')
})

async function hear(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.evaluate((line) => {
    const controls = (window as unknown as { __aisigame?: { hear: (text: string, durationMs?: number) => void } })
      .__aisigame
    if (!controls) throw new Error('нет заглушки ведущей')
    controls.hear(line, 1400)
  }, text)
}

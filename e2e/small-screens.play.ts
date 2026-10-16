import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'

/**
 * Вопрос с вариантами, кот в мешке и аукцион на маленьких экранах: всё содержимое карточки
 * (текст, варианты, кнопки) видно целиком и доступно (не обрезано, не перекрыто).
 * `SMALL_SHOT_PREFIX=/workspace/small-after` — скриншоты в /workspace/small-after-*.png.
 */
type Size = { name: string; width: number; height: number; dpr: number; mobile?: boolean }
const sizes: Size[] = [
  { name: '1280x720', width: 1280, height: 609, dpr: 1 },
  { name: '1536x864-zoom125', width: 1229, height: 600, dpr: 1.25 },
  { name: 'short-window-1400x500', width: 1400, height: 500, dpr: 1 },
  { name: '1366x768-zoom125', width: 1093, height: 525, dpr: 1.25 },
  { name: 'tablet-landscape', width: 1080, height: 810, dpr: 2, mobile: true },
  { name: 'phone-portrait', width: 390, height: 664, dpr: 3, mobile: true },
  { name: 'phone-landscape', width: 844, height: 340, dpr: 3, mobile: true },
]

const opt = (label: string, text: string) => `<param name="${label}" type="content"><item>${text}</item></param>`
async function choicePack(): Promise<string> {
  const text = 'Перед вами четыре утверждения о великих географических открытиях пятнадцатого и шестнадцатого веков. Внимательно прочитайте каждое из них и выберите то единственное, которое полностью соответствует исторической правде.'
  const xml = `<?xml version="1.0" encoding="utf-8"?><package name="Варианты"><rounds><round name="Раунд"><themes><theme name="Выбор"><questions><question price="100"><params><param name="question" type="content"><item>${text}</item></param><param name="answerType">select</param><param name="answerOptions" type="group">${
    opt('A', 'Христофор Колумб в 1492 году достиг берегов Индии, обогнув Африку с юга')}${
    opt('B', 'Васко да Гама первым из европейцев пересёк Тихий океан с востока на запад')}${
    opt('C', 'Экспедиция Магеллана завершила первое кругосветное плавание в 1522 году')}${
    opt('D', 'Бартоломеу Диаш открыл Америку, следуя к островам пряностей на западе')}</param></params><right><answer>C</answer></right></question></questions></theme></themes></round></rounds></package>`
  const zip = new JSZip()
  zip.file('content.xml', xml)
  const out = path.join(import.meta.dirname, '../test-results/choice-questions.siq')
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }))
  return out
}

async function hear(page: Page, text: string) {
  await page.evaluate((line) => (window as unknown as { __aisigame: { hear: (t: string, ms: number) => void } }).__aisigame.hear(line, 1400), text)
}

async function open(browser: Browser, size: Size) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dpr, isMobile: size.mobile, hasTouch: size.mobile })
  return { context, page: await context.newPage() }
}

async function shot(page: Page, name: string) {
  const prefix = process.env.SMALL_SHOT_PREFIX ?? 'test-results/small'
  await page.screenshot({ path: `${prefix}-${name}.png` })
}

/** Каждый элемент после прокрутки к нему действительно на экране и не перекрыт/не обрезан. */
async function expectReachable(items: Locator) {
  const count = await items.count()
  expect(count).toBeGreaterThan(0)
  for (let i = 0; i < count; i += 1) {
    const item = items.nth(i)
    await item.scrollIntoViewIfNeeded()
    const ok = await item.evaluate((el) => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return 'нулевой размер'
      if (r.top < -1 || r.bottom > innerHeight + 1 || r.left < -1 || r.right > innerWidth + 1) return `вне экрана ${JSON.stringify(r)}`
      // Обрезка предком с overflow, который сам не листается.
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
        const ar = a.getBoundingClientRect()
        if (r.bottom > ar.bottom + 1 || r.top < ar.top - 1 || r.right > ar.right + 1) return `обрезан .${a.className}`
      }
      for (const [x, y] of [[r.left + r.width / 2, r.top + Math.min(r.height / 2, 8)], [r.left + 4, r.bottom - 3]] as const) {
        const hit = document.elementFromPoint(x, y)
        if (hit && hit !== el && !el.contains(hit)) return `перекрыт .${(hit as HTMLElement).className}`
      }
      return 'ok'
    })
    expect(ok, `${await item.evaluate((el) => el.textContent?.slice(0, 40))}`).toBe('ok')
  }
}

async function startSpecialRound(page: Page) {
  await page.goto('/')
  await page.getByLabel('Модель').selectOption('mock')
  await page.getByLabel('Пакет вопросов').selectOption('demo')
  await page.getByRole('button', { name: 'Начать игру' }).click()
  for (let index = 0; index < 2; index += 1) {
    await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
    await page.getByRole('button', { name: 'Пропустить раунд' }).click()
  }
  await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
}

async function answerNow(page: Page, text: string) {
  await expect(page.getByRole('article').getByRole('meter', { name: 'Оставшееся время' })).toBeVisible()
  await hear(page, text)
}

for (const size of sizes) {
  test(`варианты ответа видны целиком: ${size.name}`, async ({ browser }) => {
    const { context, page } = await open(browser, size)
    try {
      await page.goto('/?mock=1')
      await page.locator('.start-col input[type=file]').first().setInputFiles(await choicePack())
      await expect(page.locator('.status-line').first()).toContainText(/Варианты|вопрос/)
      await page.getByRole('button', { name: 'Начать игру' }).click()
      await expect(page.locator('.talk .host .host-line')).toBeVisible()
      await hear(page, 'Выбор 100')
      await expect(page.locator('.choices li')).toHaveCount(4)
      await page.waitForTimeout(300)
      await shot(page, `choices-${size.name}`)
      await expectReachable(page.locator('.question h2, .choices li'))
    } finally { await context.close() }
  })

  test(`кот в мешке: кнопки «кому отдать» и ставки доступны: ${size.name}`, async ({ browser }) => {
    const { context, page } = await open(browser, size)
    try {
      await startSpecialRound(page)
      await page.getByRole('button', { name: 'Сюрприз, 200', exact: true }).click()
      const panel = page.getByRole('article', { name: 'Кот в мешке' })
      const give = panel.getByRole('group', { name: 'Кому отдать' })
      await expect(give.getByRole('button')).toHaveCount(2)
      await page.waitForTimeout(300)
      await shot(page, `cat-give-${size.name}`)
      await expectReachable(give.getByRole('button'))
      await give.getByRole('button').first().click()
      const stake = panel.getByRole('group', { name: 'Ставка' })
      await expect(stake).toBeVisible()
      await page.waitForTimeout(300)
      await shot(page, `cat-stake-${size.name}`)
      await expectReachable(stake.getByRole('button'))
    } finally { await context.close() }
  })

  test(`аукцион: кнопки ставки доступны: ${size.name}`, async ({ browser }) => {
    const { context, page } = await open(browser, size)
    try {
      await startSpecialRound(page)
      // Деньги у двух игроков, чтобы дошло до торга.
      await page.getByRole('button', { name: 'Сюрприз, 100', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Жмите кнопку' })).toBeVisible()
      await page.getByRole('button', { name: /^Игрок 1(?:\s*,\s*вопрос ещё читается)?$/ }).click()
      await hear(page, 'восемь')
      await expect(page.getByRole('group', { name: 'Игрок 1: 100' })).toBeVisible()
      await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
      await page.getByRole('button', { name: 'Сюрприз, 200', exact: true }).click()
      const cat = page.getByRole('article', { name: 'Кот в мешке' })
      await cat.getByRole('button', { name: 'Игрок 2' }).click()
      await cat.getByRole('button', { name: 'Максимум 300' }).click()
      await answerNow(page, 'гепард')
      await expect(page.getByRole('group', { name: 'Игрок 2: 300' })).toBeVisible()
      await expect(page.getByRole('status').filter({ hasText: 'назовите тему и стоимость' })).toBeVisible()
      await page.getByRole('button', { name: 'Торги, 200', exact: true }).click()
      const panel = page.getByRole('article', { name: 'Аукцион' })
      const bids = panel.getByRole('group', { name: 'Ставка аукциона' })
      await expect(panel).toContainText('делает ставку')
      await page.waitForTimeout(300)
      await shot(page, `auction-${size.name}`)
      await expectReachable(bids.getByRole('button'))
    } finally { await context.close() }
  })
}

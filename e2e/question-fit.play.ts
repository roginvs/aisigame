import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Регрессия жалобы «вопрос не видно, на другом мониторе видно»: на коротком широком экране
 * (ноутбук 1280×720, 1536×864 с зумом 125 %, 1920×1080 с зумом 150 %) карточка вопроса фиксированной
 * высоты обрезала длинный текст снизу. Теперь текст всегда виден целиком (шрифт подгоняется,
 * в крайнем случае текст листается). Скриншоты: test-results/question-fit-*.png
 * (`SCREENSHOT_DIR=/workspace` — в /workspace/layout-after-*.png).
 */
const long = 'В этом очень длинном вопросе автор пакета подробно описывает историю: в начале девятнадцатого века один изобретатель, работая в маленькой мастерской на окраине города, несколько лет пытался построить машину, которая могла бы передавать сообщения на большие расстояния без гонцов и почтовых лошадей. Друзья смеялись над ним, а кредиторы забирали инструменты, но он не сдавался и в конце концов показал своё изобретение комиссии. Назовите это изобретение, которое потом изменило связь во всём мире.'
const withImage = 'Посмотрите на картинку внимательно. На ней изображена простая геометрическая фигура, которую дети рисуют одной из первых, а математики используют, чтобы объяснить число пи. Какого цвета эта фигура на картинке, если смотреть при обычном дневном освещении?'
const huge = Array.from({ length: 4 }, () => long).join(' ')

async function buildPack(): Promise<string> {
  const q = (price: number, body: string, answer: string) =>
    `<question price="${price}"><params><param name="question" type="content">${body}</param></params><right><answer>${answer}</answer></right></question>`
  const xml = `<?xml version="1.0" encoding="utf-8"?><package name="Длинные"><rounds><round name="Раунд"><themes><theme name="Длинный"><questions>${
    q(100, `<item>${long}</item>`, 'телеграф')}${
    q(200, `<item type="image" isRef="true">long/circle.svg</item><item>${withImage}</item>`, 'красный')}${
    q(300, `<item>${huge}</item>`, 'телеграф')}</questions></theme></themes></round></rounds></package>`
  const zip = new JSZip()
  zip.file('content.xml', xml)
  zip.file('long/circle.svg', await readFile(path.join(import.meta.dirname, '../packs/demo/circle.svg')))
  const out = path.join(import.meta.dirname, '../test-results/long-questions.siq')
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }))
  return out
}

type Size = { name: string; width: number; height: number; dpr: number; mobile?: boolean }
/** Окно браузера в CSS-пикселях (экран минус панели браузера/ОС), DPR = масштаб ОС × зум. */
const sizes: Size[] = [
  { name: '1280x720', width: 1280, height: 609, dpr: 1 },
  { name: '1366x768', width: 1366, height: 657, dpr: 1 },
  { name: '1536x864-zoom125', width: 1229, height: 600, dpr: 1.25 },
  { name: '1920x1080-zoom150', width: 1280, height: 640, dpr: 1.5 },
  { name: '1440x900', width: 1440, height: 789, dpr: 1 },
  { name: '1920x1080', width: 1920, height: 969, dpr: 1 },
  { name: 'short-window-1400x500', width: 1400, height: 500, dpr: 1 },
  { name: '1366x768-zoom125', width: 1093, height: 525, dpr: 1.25 },
  { name: 'tablet-landscape', width: 1080, height: 810, dpr: 2, mobile: true },
  { name: 'phone-portrait', width: 390, height: 664, dpr: 3, mobile: true },
  { name: 'phone-landscape', width: 844, height: 340, dpr: 3, mobile: true },
]

async function hear(page: Page, text: string) {
  await page.evaluate((line) => (window as unknown as { __aisigame: { hear: (t: string, ms: number) => void } }).__aisigame.hear(line, 1400), text)
}

async function expectQuestionReadable(page: Page, shot: string) {
  const h2 = page.locator('.question h2')
  await expect(h2).toBeVisible()
  await page.waitForTimeout(300)
  const m = await h2.evaluate((el) => {
    const card = el.closest('.question')!.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const doc = document.scrollingElement!
    return {
      overflow: el.scrollHeight - el.clientHeight,
      scrolls: getComputedStyle(el).overflowY === 'auto',
      font: Number.parseFloat(getComputedStyle(el).fontSize),
      insideCard: r.top >= card.top - 1 && r.bottom <= card.bottom + 1 && r.right <= card.right + 1,
      // Нижний край текста достижим прокруткой страницы.
      reachable: r.bottom + doc.scrollTop <= doc.scrollHeight + 1,
    }
  })
  await page.screenshot({ path: `${process.env.SCREENSHOT_DIR ? `${process.env.SCREENSHOT_DIR}/layout-after-` : 'test-results/question-fit-'}${shot}.png` })
  expect(m.font).toBeGreaterThanOrEqual(18)
  expect(m.insideCard).toBe(true)
  expect(m.reachable).toBe(true)
  // Либо весь текст в своём блоке, либо блок листается (только для очень длинного текста).
  if (m.overflow > 1) expect(m.scrolls).toBe(true)
  return m
}

async function soloMaster(browser: Browser, size: Size, pack: string) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dpr, isMobile: size.mobile, hasTouch: size.mobile })
  const page = await context.newPage()
  await page.goto('/?mock=1')
  await page.locator('.start-col input[type=file]').first().setInputFiles(pack)
  await expect(page.locator('.status-line').first()).toContainText(/Длинные|вопрос/)
  await page.getByRole('button', { name: 'Начать игру' }).click()
  await expect(page.locator('.talk .host .host-line')).toBeVisible()
  return { context, page }
}

for (const size of sizes) {
  test(`текст вопроса виден целиком: ${size.name}`, async ({ browser }) => {
    const pack = await buildPack()
    const { context, page } = await soloMaster(browser, size, pack)
    try {
      await hear(page, 'Длинный 100')
      await expect(page.locator('.question h2')).toContainText('изменило связь')
      const text = await expectQuestionReadable(page, `${size.name}-long`)
      expect(text.overflow).toBeLessThanOrEqual(1) // обычный длинный вопрос влезает без прокрутки
    } finally {
      await context.close()
    }
  })
}

for (const size of sizes.filter((item) => ['1280x720', '1536x864-zoom125', 'short-window-1400x500', 'phone-portrait', 'phone-landscape'].includes(item.name))) {
  test(`вопрос с картинкой: текст целиком и картинка не схлопнута: ${size.name}`, async ({ browser }) => {
    const { context, page } = await soloMaster(browser, size, await buildPack())
    try {
      await hear(page, 'Длинный 200')
      await expect(page.locator('.question h2')).toContainText('дневном освещении')
      await expectQuestionReadable(page, `${size.name}-image`)
      const media = await page.locator('.question-media img').boundingBox()
      // Окно 1400×500 — крайний случай: карточке достаётся ~170px, картинка мелкая, но видна.
      expect(media?.height ?? 0).toBeGreaterThan(size.height <= 500 ? 40 : 60)
    } finally {
      await context.close()
    }
  })
}

test('огромный текст вопроса: минимальный шрифт и прокрутка внутри карточки (1280x720)', async ({ browser }) => {
  const { context, page } = await soloMaster(browser, sizes[0]!, await buildPack())
  try {
    await hear(page, 'Длинный 300')
    await expect(page.locator('.question h2')).toContainText('изменило связь')
    const m = await expectQuestionReadable(page, 'huge-1280x720')
    expect(m.scrolls).toBe(true)
    expect(m.font).toBe(18)
  } finally {
    await context.close()
  }
})

for (const [name, width, height, dpr] of [['1536x864-zoom125', 1229, 600, 1.25], ['1280x720', 1280, 609, 1]] as const) test(`гость в конференции: длинный вопрос виден целиком, камеры — превью только на время длинного вопроса (${name})`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr })
  try {
    const { master, guest } = await joinConference(context)
    // Табло: обычные камеры.
    await expect(guest.getByRole('button', { name: 'Текст, 200', exact: true })).toBeVisible()
    expect(await frameHeight(guest)).toBeGreaterThan(height * 0.2)
    await guest.getByRole('button', { name: 'Текст, 200', exact: true }).click()
    await expect(guest.locator('.question h2')).toContainText('несколько секунд', { timeout: 15_000 })
    const m = await expectQuestionReadable(guest, `guest-${name}`)
    expect(m.overflow).toBeLessThanOrEqual(1)
    // Подогнанный шрифт не крупнее questionFit.fittedMaxFontPx (24), кадр камеры — превью ≤ 15 % высоты.
    expect(m.font).toBeLessThanOrEqual(24)
    expect(await frameHeight(guest)).toBeGreaterThan(40)
    expect(await frameHeight(guest)).toBeLessThanOrEqual(height * 0.15 + 8) // + рамка и поля карточки
    if (process.env.CAMS_DIR && name === '1536x864-zoom125') await guest.screenshot({ path: `${process.env.CAMS_DIR}/cams-long.png` })
    await expect(master.locator('.question h2')).toContainText('несколько секунд')
    await expectQuestionReadable(master, `conference-master-${name}`)
  } finally {
    await context.close()
  }
})

async function joinConference(context: import('@playwright/test').BrowserContext) {
  const master = await context.newPage(), guest = await context.newPage()
    await master.goto('/?mock=1&transport=broadcast')
    await master.getByLabel('Модель').selectOption('mock')
    await master.getByRole('radio', { name: 'Конференция' }).check()
    await master.getByLabel('Пакет вопросов').selectOption('demo')
    await master.getByLabel('Ваше имя').fill('Мастер')
    await master.getByRole('button', { name: 'Начать игру' }).click()
    await master.getByRole('button', { name: 'Ссылка для игры' }).click()
    const dialog = master.getByRole('dialog', { name: 'Ссылка для игры' })
    const invite = new URL(await dialog.getByLabel('Ссылка для игроков').inputValue())
    invite.host = new URL(master.url()).host; invite.protocol = new URL(master.url()).protocol
    invite.searchParams.set('mock', '1')
    await dialog.getByRole('button', { name: 'Закрыть' }).click()
    await guest.goto(invite.href)
    await guest.getByLabel('Ваше имя').fill('Гость')
    await guest.getByRole('button', { name: 'Подключиться' }).click()
    await expect(guest.getByRole('button', { name: 'Я в игре' })).toBeEnabled({ timeout: 60_000 })
    await guest.getByRole('button', { name: 'Я в игре' }).click()
    await master.getByRole('button', { name: 'Начать игру' }).click()
  return { master, guest }
}

async function frameHeight(page: Page): Promise<number> {
  return (await page.locator('.conference-player .video-frame').first().boundingBox())?.height ?? 0
}

test('гость в конференции: короткий вопрос — камеры обычные (1536x864 зум 125 %)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1229, height: 600 }, deviceScaleFactor: 1.25 })
  try {
    const { guest } = await joinConference(context)
    await guest.getByRole('button', { name: 'Текст, 100', exact: true }).click()
    await expect(guest.locator('.question h2')).toContainText('римского императора', { timeout: 15_000 })
    const m = await expectQuestionReadable(guest, 'guest-short-1536x864-zoom125')
    expect(m.font).toBeGreaterThan(24) // влез при обычном размере — шрифт не подгонялся
    expect(await frameHeight(guest)).toBeGreaterThan(600 * 0.2)
    await expect(guest.locator('.conference-layout.cams-compact')).toHaveCount(0)
    if (process.env.CAMS_DIR) await guest.screenshot({ path: `${process.env.CAMS_DIR}/cams-short.png` })
  } finally {
    await context.close()
  }
})

// Профайлер мастера во время живой конференции: настраиваем ту же комнату,
// стартуем партию, ловим окно с высоким CPU и снимаем JS-профиль.
import { chromium } from '@playwright/test'
import { execSync } from 'node:child_process'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173'
const SAMPLE_S = Number(process.env.SAMPLE_S ?? 6)
const PLAYERS = Number(process.env.PLAYERS ?? 3)
const ROUNDS = Number(process.env.ROUNDS ?? 4)

function rendererPids() {
  const out = execSync(`ps -eo pid,cmd | grep -- '--type=renderer' | grep ms-playwright | grep -v grep`).toString().trim().split('\n')
  return out.map((line) => Number(line.trim().split(/ +/)[0])).filter((n) => Number.isFinite(n))
}

async function threadSample(pid) {
  const snap = {}
  for (const tid of execSync(`ls /proc/${pid}/task`).toString().trim().split('\n')) {
    try {
      const stat = execSync(`cat /proc/${pid}/task/${tid}/stat`).toString()
      const comm = stat.slice(stat.indexOf('(') + 1, stat.indexOf(')'))
      const after = stat.slice(stat.indexOf(')') + 2)
      const parts = after.split(' ')
      // parts: [state, ppid, ..., utime(11), stime(12)]
      snap[tid] = { comm: comm.slice(0, 22), u: Number(parts[11]) + Number(parts[12]) }
    } catch { /* поток умер */ }
  }
  return snap
}

function threadDelta(a, b, seconds) {
  const rows = []
  for (const [tid, info] of Object.entries(a)) {
    const nb = b[tid]
    if (!nb) continue
    const p = ((nb.u - info.u) / 100) / seconds * 100
    if (p > 0.3) rows.push({ tid, comm: info.comm ?? '?', pct: p })
  }
  return rows.sort((x, y) => y.pct - x.pct)
}

async function cpuFraction(pid, seconds) {
  const s0 = await threadSample(pid)
  await new Promise((r) => setTimeout(r, seconds * 1000))
  const s1 = await threadSample(pid)
  const rows = threadDelta(s0, s1, seconds)
  return { total: rows.reduce((sum, r) => sum + r.pct, 0), rows, s1 }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.grantPermissions(['microphone', 'camera', 'clipboard-read', 'clipboard-write'])
const page = await ctx.newPage()
await page.goto(`${BASE}/?mock=1`)
await page.getByLabel('Модель').selectOption('mock')
await page.getByRole('radio', { name: 'Конференция' }).check()
await page.getByLabel('Пакет вопросов').selectOption('demo')
await page.getByLabel('Ваше имя').fill('Мастер')
await page.getByRole('button', { name: 'Начать игру' }).click()
await page.getByRole('button', { name: 'Ссылка для игры' }).click({ timeout: 30_000 })
let invite = ''
try {
  const publicLink = page.getByLabel('Ссылка для игроков')
  await publicLink.waitFor({ timeout: 10_000 })
  invite = await publicLink.inputValue()
} catch { /* ниже ругнёмся */ }
await page.getByRole('button', { name: 'Закрыть' }).click().catch(() => {})
if (!invite.includes('join=')) {
  console.log('НЕ ПОЛУЧИЛОСЬ взять ссылку: ' + invite)
  await browser.close()
  process.exit(2)
}
const inviteLocal = new URL(invite)
inviteLocal.protocol = new URL(BASE).protocol
inviteLocal.host = new URL(BASE).host
console.log('инвайт:', inviteLocal.href)

for (let i = 0; i < PLAYERS; i += 1) {
  const jctx = await browser.newContext({ viewport: { width: 640, height: 480 } })
  await jctx.grantPermissions(['microphone', 'camera'])
  const jpage = await jctx.newPage()
  await jpage.goto(inviteLocal.href)
  await jpage.getByLabel('Ваше имя').fill(`Игрок${i + 1}`)
  await jpage.getByRole('button', { name: 'Подключиться' }).click()
  await jpage.getByRole('button', { name: 'Я готов' }).click({ timeout: 60_000 })
  console.log(`Игрок${i + 1} готов`)
}
await page.waitForTimeout(6000)

// Точная привязка мастера: включим CDP Target перед стартом. Проще: после старта партии
// возьмём пиды рендереров, появившиеся ПОСЛЕ первого мастера... мастер открылся раньше всех.
// Вместо эвристик: меряем все пиды; горячий мастер-пид определяем перебором.
// Практично: мастер запускался первым → его pid — наименьший из текущих.
const pidsAll = rendererPids().sort((a, b) => a - b)
const masterPid = pidsAll[0]
if (!masterPid) {
  console.log('НЕ НАЙДЕНЫ рендереры Playwright Chromium: ps не видит --type=renderer')
  await browser.close()
  process.exit(3)
}
console.log('мастер pid (самый ранний рендерер):', masterPid)

let { total, rows } = await cpuFraction(masterPid, SAMPLE_S)
console.log(`лабби мастер: ${total.toFixed(0)}% ядра`, JSON.stringify(rows.slice(0, 4)))

// Старт партии.
await page.getByRole('button', { name: 'Начать игру' }).click()
await page.getByRole('status').filter({ hasText: /назовите тему и стоимость|выбирайте вопрос/ }).first().waitFor({ timeout: 30_000 }).catch(() => {})

// Пока идёт доигрывание с мок-подсказками, снимаем метрики и профили.
const busy = []
for (let i = 0; i < ROUNDS; i += 1) {
  const r = await cpuFraction(masterPid, SAMPLE_S)
  console.log(`замер ${i + 1}: мастер ${r.total.toFixed(0)}% ядра`)
  busy.push(r)
}

// Находим самый горячий замер и снимаем CPU-профиль прямо в этом состоянии.
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.start')
const t0 = Date.now()
await new Promise((r) => setTimeout(r, SAMPLE_S * 1000))
const profile = (await cdp.send('Profiler.stop')).profile
const dt = (Date.now() - t0) / 1000

// self-время по узлам.
const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
for (const node of profile.nodes) self.set(node.id, 0)
if (profile.samples) {
  const interval = (profile.endTime - profile.startTime) / profile.samples.length / 1000
  const counts = new Map()
  for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1)
  const totals = new Map()
  const selfCount = new Map()
  for (const [id, count] of counts) {
    selfCount.set(id, (selfCount.get(id) ?? 0) + count)
    let cur = id
    while (cur !== undefined) {
      totals.set(cur, (totals.get(cur) ?? 0) + count)
      cur = nodes.get(cur)?.parent
    }
  }
  const ms = (count) => count * interval
  console.log(`\n=== ПРОФИЛЬ мастера (${dt.toFixed(1)}с окно) — самостоятельное (self) время ===`)
  const sorted = [...selfCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  for (const [id, count] of sorted) {
    const node = nodes.get(id)
    const cf = node?.callFrame
    console.log(`${ms(count).toFixed(0).padStart(5)}ms self  ${(ms(count) / dt * 100).toFixed(1).padStart(5)}%  ${(cf.functionName || cf.url.split('/').pop() || '?')}:${cf.lineNumber}`)
  }
}
await browser.close()
console.log('\nprofile done')

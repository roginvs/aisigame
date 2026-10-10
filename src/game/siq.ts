import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'
import { withChoiceTexts } from './choices.ts'
import type { MediaKind, Question, QuestionChoice, QuestionMedia, QuestionPack, RoundKind } from './types.ts'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  isArray: (name) => ['round', 'theme', 'question', 'param', 'item', 'answer', 'atom'].includes(name),
})

const specials = new Set(['cat', 'auction', 'bag', 'sponsored', 'secret', 'stake', 'marker'])

export function parseContentXml(xml: string): QuestionPack {
  const doc = parser.parse(xml) as { package?: Record<string, unknown> }
  const packageNode = doc.package
  if (!packageNode) throw new Error('В файле нет пакета SIGame')
  const name = attr(packageNode, 'name') || 'Пакет'
  const questions: Question[] = []
  const warnings: string[] = []
  const rounds: QuestionPack['rounds'] = []

  asArray(child(packageNode, 'rounds', 'round')).forEach((round, roundIndex) => {
    const roundName = attr(round, 'name') || `Раунд ${roundIndex + 1}`
    const kind: RoundKind = attr(round, 'type') === 'final' ? 'final' : 'normal'
    let keptThemes = 0
    asArray(child(round, 'themes', 'theme')).forEach((theme, themeIndex) => {
      const themeName = attr(theme, 'name') || `Тема ${themeIndex + 1}`
      const themeId = `r${roundIndex}-t${themeIndex}`
      let kept = 0
      asArray(child(theme, 'questions', 'question')).forEach((question, questionIndex) => {
        const price = Number(attr(question, 'price') || '0')
        const where = `${roundName}, ${themeName}, ${price}`
        const special = questionKind(question)
        if (specials.has(special)) {
          warnings.push(`${where}: пропущен спецвопрос «${special}»`)
          return
        }
        const body = readBody(question)
        const text = body.text || fallbackText(body.media)
        const choices = readChoices(question)
        const answers = withChoiceTexts(readAnswers(question), choices)
        if (!text) {
          warnings.push(`${where}: нет текста вопроса`)
          return
        }
        if (!answers.length) {
          warnings.push(`${where}: нет ответа`)
          return
        }
        questions.push({
          id: `${themeId}-${price}-${questionIndex}`,
          roundIndex,
          themeId,
          themeName,
          value: Number.isFinite(price) ? price : 0,
          text,
          answers,
          media: body.media,
          answerMedia: body.answerMedia,
          ...(choices.length ? { choices } : {}),
        })
        kept += 1
      })
      if (kept) keptThemes += 1
    })
    if (keptThemes) rounds.push({ index: roundIndex, name: roundName, kind })
  })

  return { name, rounds, questions, warnings }
}

export async function loadSiq(data: ArrayBuffer): Promise<QuestionPack> {
  const head = new TextDecoder().decode(data.slice(0, 120)).trimStart()
  if (head.startsWith('<')) return parseContentXml(new TextDecoder().decode(data))
  try {
    const zip = await JSZip.loadAsync(data)
    const file = zip.file(/content\.xml$/i)[0]
    if (!file) throw new Error('В пакете нет content.xml')
    return attachMedia(parseContentXml(await file.async('string')), zip)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('В ')) throw error
    throw new Error('Не удалось открыть файл. Нужен пакет .siq игры SIGame.')
  }
}

function questionKind(question: Record<string, unknown>): string {
  const named = attr(question, 'type') || attr(question, 'typeName')
  if (named) return named.toLowerCase()
  const child = question.typeName ?? question.type
  if (typeof child === 'string') return child.toLowerCase()
  if (child && typeof child === 'object') return attr(child as Record<string, unknown>, 'name').toLowerCase()
  return ''
}

function readBody(question: Record<string, unknown>): { text: string; media: QuestionMedia[]; answerMedia: QuestionMedia[] } {
  const fromParams = readParam(question, 'question')
  const reveal = readParam(question, 'answer')
  const body = fromParams.text || fromParams.media.length || fromParams.answerMedia.length
    ? fromParams
    : joinParts(asList(record(question.scenario)?.atom))
  return {
    ...body,
    answerMedia: [...body.answerMedia, ...reveal.media, ...reveal.answerMedia],
  }
}

function readChoices(question: Record<string, unknown>): QuestionChoice[] {
  const params = record(question.params)
  const group = asArray(params?.param).find((param) => attr(param, 'name') === 'answerOptions')
  if (!group) return []
  const choices: QuestionChoice[] = []
  for (const option of asArray(group.param)) {
    const label = attr(option, 'name')
    if (!label) continue
    const body = joinParts([...asList(option.item), ...asList(option.atom)])
    if (!body.text && !body.media.length) continue
    choices.push({ label, text: body.text, media: body.media })
  }
  return choices
}

function readAnswers(question: Record<string, unknown>): string[] {
  const right = record(question.right)
  const answers = asList(right?.answer)
    .map(partText)
    .map((item) => item.trim())
    .filter(Boolean)
  if (answers.length) return answers
  const fromParam = readParam(question, 'answer')
  return fromParam.text ? [fromParam.text] : []
}

function readParam(question: Record<string, unknown>, name: string): { text: string; media: QuestionMedia[]; answerMedia: QuestionMedia[] } {
  const params = record(question.params)
  const found = asArray(params?.param).find((param) => attr(param, 'name') === name)
  if (!found) return { text: '', media: [], answerMedia: [] }
  return joinParts([...asList(found.item), ...asList(found.atom)])
}

function joinParts(parts: unknown[]): { text: string; media: QuestionMedia[]; answerMedia: QuestionMedia[] } {
  const marker = parts.findIndex((part) => partKind(part) === 'marker')
  const head = marker === -1 ? parts : parts.slice(0, marker)
  const tail = marker === -1 ? [] : parts.slice(marker + 1)
  return { ...collectParts(head), answerMedia: collectParts(tail).media }
}

function collectParts(parts: unknown[]): { text: string; media: QuestionMedia[] } {
  const texts: string[] = []
  const media: QuestionMedia[] = []
  for (const part of parts) {
    const kind = mediaKind(partKind(part))
    if (kind) {
      const name = mediaRef(partText(part))
      if (name) media.push({ kind, name, url: '' })
      continue
    }
    const text = partText(part).trim()
    if (text) texts.push(text)
  }
  return { text: texts.join(' '), media }
}

function mediaRef(name: string): string {
  return name.trim().replace(/^@+/, '')
}

function mediaKind(kind: string): MediaKind | null {
  if (kind === 'voice') return 'audio'
  if (kind === 'image' || kind === 'audio' || kind === 'video') return kind
  return null
}

function fallbackText(media: QuestionMedia[]): string {
  const kinds = new Set(media.map((item) => item.kind))
  if (kinds.has('video')) return 'Посмотрите фрагмент.'
  if (kinds.has('audio')) return 'Послушайте фрагмент.'
  if (kinds.has('image')) return 'Посмотрите на картинку.'
  return ''
}

export function revokePackMedia(pack: QuestionPack | null): void {
  if (!pack || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  for (const question of pack.questions) {
    for (const item of [...(question.media ?? []), ...(question.answerMedia ?? [])]) {
      if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
    }
  }
}

async function attachMedia(pack: QuestionPack, zip: JSZip): Promise<QuestionPack> {
  const warnings = [...pack.warnings]
  const questions: Question[] = []
  for (const question of pack.questions) {
    const media = await attachList(question.media ?? [], zip, warnings, question)
    const answerMedia = await attachList(question.answerMedia ?? [], zip, warnings, question)
    const choices: QuestionChoice[] = []
    for (const choice of question.choices ?? []) {
      choices.push({ ...choice, media: await attachList(choice.media, zip, warnings, question) })
    }
    questions.push({ ...question, media, answerMedia, ...(choices.length ? { choices } : {}) })
  }
  return { ...pack, questions, warnings }
}

async function attachList(
  items: QuestionMedia[],
  zip: JSZip,
  warnings: string[],
  question: Question,
): Promise<QuestionMedia[]> {
  const media: QuestionMedia[] = []
  for (const item of items) {
    const entry = zipEntry(zip, item.name)
    if (!entry) {
      warnings.push(`${question.themeName}, ${question.value}: не найден файл «${item.name}»`)
      continue
    }
    const bytes = new Uint8Array(await entry.async('uint8array'))
    const blob = new Blob([bytes], { type: mediaMime(item.name, item.kind) })
    media.push({ ...item, url: URL.createObjectURL(blob) })
  }
  return media
}

function zipEntry(zip: JSZip, name: string): JSZip.JSZipObject | null {
  const wanted = normalizePath(mediaRef(name))
  const base = wanted.split('/').pop() ?? wanted
  const files = Object.values(zip.files).filter((file) => !file.dir)
  const ranked = files.map((file) => ({ file, names: pathForms(file.name) }))
  return (
    ranked.find((item) => item.names.some((path) => path === wanted || path.endsWith(`/${wanted}`)))?.file ??
    ranked.find((item) => item.names.some((path) => path.split('/').pop() === base))?.file ??
    null
  )
}

function pathForms(name: string): string[] {
  const plain = normalizePath(name)
  try {
    const decoded = normalizePath(decodeURIComponent(name))
    return decoded === plain ? [plain] : [plain, decoded]
  } catch {
    return [plain]
  }
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.?\//, '').toLowerCase()
}

function mediaMime(name: string, kind: MediaKind): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
  }
  if (known[ext]) return known[ext]
  if (kind === 'image') return 'application/octet-stream'
  if (kind === 'audio') return 'audio/wav'
  return 'video/mp4'
}

function partKind(part: unknown): string {
  if (!part || typeof part !== 'object') return ''
  return attr(part as Record<string, unknown>, 'type').toLowerCase()
}

function partText(part: unknown): string {
  if (typeof part === 'string' || typeof part === 'number') return String(part)
  if (!part || typeof part !== 'object') return ''
  const recordPart = part as Record<string, unknown>
  const text = recordPart['#text']
  if (typeof text === 'string' || typeof text === 'number') return String(text)
  return ''
}

function child(node: Record<string, unknown>, group: string, item: string): unknown {
  const nested = record(node[group])
  return nested?.[item]
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function asArray(value: unknown): Record<string, unknown>[] {
  return asList(value).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function attr(node: Record<string, unknown>, name: string): string {
  const value = node[`@_${name}`]
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

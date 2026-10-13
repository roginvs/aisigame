import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { questionSpeech } from './choices.ts'
import { loadSiq, parseContentXml } from './siq.ts'

const v5 = `<?xml version="1.0" encoding="utf-8"?>
<package name="Проверка">
  <rounds>
    <round name="Первый раунд">
      <themes>
        <theme name="Реки">
          <questions>
            <question price="100">
              <params>
                <param name="question" type="content"><item>Куда впадает Волга?</item></param>
              </params>
              <right><answer>Каспийское море</answer><answer>в Каспийское море</answer></right>
            </question>
            <question price="200" type="cat">
              <params><param name="question" type="content"><item>Кот</item></param></params>
              <right><answer>кот</answer></right>
            </question>
            <question price="300">
              <params>
                <param name="question" type="content">
                  <item type="image" isRef="true">pic.png</item>
                </param>
              </params>
              <right><answer>картинка</answer></right>
            </question>
          </questions>
        </theme>
      </themes>
    </round>
    <round name="Финал" type="final">
      <themes>
        <theme name="Столицы">
          <questions>
            <question price="0">
              <scenario><atom>Столица Франции?</atom></scenario>
              <right><answer>Париж</answer></right>
            </question>
          </questions>
        </theme>
      </themes>
    </round>
  </rounds>
</package>`

describe('parseContentXml', () => {
  it('keeps text, picture and the final, and skips a cat', () => {
    const pack = parseContentXml(v5)
    expect(pack.name).toBe('Проверка')
    expect(pack.rounds.map((round) => round.kind)).toEqual(['normal', 'final'])
    expect(pack.questions.map((question) => question.text)).toEqual([
      'Куда впадает Волга?',
      'Посмотрите на картинку.',
      'Столица Франции?',
    ])
    expect(pack.questions[0]?.answers).toEqual(['Каспийское море', 'в Каспийское море'])
    expect(pack.questions[0]?.value).toBe(100)
    expect(pack.questions[1]?.media).toEqual([{ kind: 'image', name: 'pic.png', url: '' }])
    expect(pack.warnings).toHaveLength(1)
  })

  it('reads a classic package: @file, voice, and the reveal after the marker', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<package name="Старый">
  <rounds><round name="Раунд"><themes><theme name="Звук">
    <questions>
      <question price="100">
        <scenario>
          <atom type="voice">@после.mp3</atom>
          <atom type="marker"></atom>
          <atom type="image">@после.png</atom>
        </scenario>
        <right><answer>сигнал</answer></right>
      </question>
    </questions>
  </theme></themes></round></rounds>
</package>`
    const zip = new JSZip()
    zip.file('content.xml', xml)
    zip.file('Audio/%D0%BF%D0%BE%D1%81%D0%BB%D0%B5.mp3', new Uint8Array([1, 2, 3]))
    zip.file('Images/%D0%BF%D0%BE%D1%81%D0%BB%D0%B5.png', new Uint8Array([4, 5]))
    const pack = await loadSiq(await zip.generateAsync({ type: 'arraybuffer' }))
    expect(pack.warnings).toEqual([])
    expect(pack.questions[0]?.text).toBe('Послушайте фрагмент.')
    expect(pack.questions[0]?.media?.map((item) => [item.kind, item.name])).toEqual([['audio', 'после.mp3']])
    expect(pack.questions[0]?.answerMedia?.map((item) => [item.kind, item.name])).toEqual([['image', 'после.png']])
    expect(pack.questions[0]?.media?.[0]?.url.startsWith('blob:')).toBe(true)
    expect(pack.questions[0]?.answerMedia?.[0]?.url.startsWith('blob:')).toBe(true)
  })

  it('keeps the picture from the answer field until the answer is shown', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<package name="Пятый">
  <rounds><round name="Раунд"><themes><theme name="Кадр">
    <questions>
      <question price="100">
        <params>
          <param name="question" type="content"><item>Кто это?</item><item type="image" isRef="True">face.png</item></param>
          <param name="answer" type="content"><item type="image" isRef="True">name.png</item></param>
        </params>
        <right><answer>Аня</answer></right>
      </question>
    </questions>
  </theme></themes></round></rounds>
</package>`
    const pack = parseContentXml(xml)
    expect(pack.questions[0]?.text).toBe('Кто это?')
    expect(pack.questions[0]?.media).toEqual([{ kind: 'image', name: 'face.png', url: '' }])
    expect(pack.questions[0]?.answerMedia).toEqual([{ kind: 'image', name: 'name.png', url: '' }])
    expect(pack.questions[0]?.answers).toEqual(['Аня'])
  })

  it('keeps select options and accepts both the letter and its text', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<package name="Выбор">
  <rounds><round name="Раунд"><themes><theme name="Что было раньше?">
    <questions>
      <question price="200">
        <info><comments>Годы здесь не для табло.</comments></info>
        <params>
          <param name="question" type="content"><item>Что появилось раньше?</item></param>
          <param name="answerType">select</param>
          <param name="answerOptions" type="group">
            <param name="A" type="content"><item waitForFinish="False">Индиана Джонс</item></param>
            <param name="B" type="content"><item waitForFinish="False">Назад в будущее</item></param>
            <param name="C" type="content"><item type="image" isRef="True">term.png</item></param>
            <param name="D" type="content"><item waitForFinish="False">Звёздные войны</item></param>
          </param>
        </params>
        <right><answer>D</answer></right>
      </question>
    </questions>
  </theme></themes></round></rounds>
</package>`
    const pack = parseContentXml(xml)
    const question = pack.questions[0]
    expect(question?.text).toBe('Что появилось раньше?')
    expect(question?.answers).toEqual(['D', 'Звёздные войны'])
    expect(question?.choices).toEqual([
      { label: 'A', text: 'Индиана Джонс', media: [] },
      { label: 'B', text: 'Назад в будущее', media: [] },
      { label: 'C', text: '', media: [{ kind: 'image', name: 'term.png', url: '' }] },
      { label: 'D', text: 'Звёздные войны', media: [] },
    ])
    expect(questionSpeech(question!)).toBe(
      'Что появилось раньше?\nA. Индиана Джонс\nB. Назад в будущее\nC.\nD. Звёздные войны',
    )
    expect(pack.warnings).toEqual([])
    expect(JSON.stringify(question)).not.toContain('Годы здесь')
  })

  it('skips a fifth-version stake, the auction under its new name', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<package name="Ставка">
  <rounds><round name="Раунд"><themes><theme name="Песни">
    <questions>
      <question price="100">
        <params><param name="question" type="content"><item>Обычный вопрос</item></param></params>
        <right><answer>да</answer></right>
      </question>
      <question price="200" type="stake">
        <params><param name="question" type="content"><item>Вопрос со ставкой</item></param></params>
        <right><answer>нет</answer></right>
      </question>
    </questions>
  </theme></themes></round></rounds>
</package>`
    const pack = parseContentXml(xml)
    expect(pack.questions.map((question) => question.text)).toEqual(['Обычный вопрос'])
    expect(pack.warnings).toEqual(['Раунд, Песни, 200: пропущен спецвопрос «stake»'])
  })

  it('reads the same package from a zip and warns about a missing picture', async () => {
    const zip = new JSZip()
    zip.file('content.xml', v5)
    const buffer = await zip.generateAsync({ type: 'arraybuffer' })
    const pack = await loadSiq(buffer)
    expect(pack.questions).toHaveLength(3)
    expect(pack.warnings.some((warning) => warning.includes('pic.png'))).toBe(true)
    expect(pack.questions[1]?.media).toEqual([])
  })

  it('keeps one bundled demo with the supported question variants', () => {
    const dir = path.resolve(import.meta.dirname, '../../packs')
    const names = readdirSync(dir).filter((name) => name.endsWith('.xml'))
    expect(names).toEqual(['demo.xml'])
    const demo = parseContentXml(readFileSync(path.join(dir, 'demo.xml'), 'utf8'))
    expect(demo.rounds.map((round) => round.name)).toEqual(['Разминка', 'Наглядно'])
    expect(demo.questions).toHaveLength(11)
    expect(demo.questions.flatMap((question) => question.media ?? []).map((media) => media.kind))
      .toEqual(['image', 'audio', 'video', 'image'])
    expect(demo.questions.find((question) => question.themeName === 'Выбор')?.choices).toHaveLength(4)
    expect(demo.questions.find((question) => question.themeName === 'Показ')?.answerMedia?.[0]?.kind).toBe('image')
    expect(demo.questions.filter((question) => question.themeName === 'Стопка')).toHaveLength(2)
    expect(demo.warnings).toEqual([])
  })

  it('loads the shipped demo archive with embedded media', async () => {
    const buffer = readFileSync(path.resolve(import.meta.dirname, '../../public/packs/builtin/demo.siq'))
    const pack = await loadSiq(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    expect(pack.warnings).toEqual([])
    const media = pack.questions.flatMap((question) => [...(question.media ?? []), ...(question.answerMedia ?? [])])
    expect(media.map((item) => item.kind)).toEqual(['image', 'audio', 'video', 'image', 'image'])
    expect(media.every((item) => item.url.startsWith('blob:'))).toBe(true)
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../packs')
const xml = readFileSync(path.join(root, 'demo.xml'), 'utf8')
const refs = [...xml.matchAll(/isRef="true">([^<]+)</g)].map((match) => (match[1] ?? "").trim())

describe('медиа демо-пакета', () => {
  it('каждая ссылка пакета указывает на существующий файл', () => {
    const files = new Set(readdirSync(path.join(root, 'demo')).map((name) => `demo/${name}`))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(files, ref).toContain(ref)
  })

  it('SVG — валидный XML без управляющих символов (иначе браузер покажет битую картинку)', () => {
    for (const name of readdirSync(path.join(root, 'demo')).filter((file) => file.endsWith('.svg'))) {
      const text = readFileSync(path.join(root, 'demo', name), 'utf8')
      // eslint-disable-next-line no-control-regex
      expect(text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/), name).toBeNull()
      expect(text, name).toContain('xmlns="http://www.w3.org/2000/svg"')
    }
  })
})

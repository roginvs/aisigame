import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'packs')
const target = path.join(root, 'public', 'packs', 'builtin')
await mkdir(target, { recursive: true })

const names = (await readdir(source)).filter((name) => name.endsWith('.xml'))
for (const name of names) {
  const xml = await readFile(path.join(source, name))
  const zip = new JSZip()
  zip.file('content.xml', xml)
  const stem = name.replace(/\.xml$/, '')
  await addFolder(zip, path.join(source, stem), stem)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const out = path.join(target, name.replace(/\.xml$/, '.siq'))
  await writeFile(out, buffer)
  console.log(out)
}

async function addFolder(zip, dir, prefix) {
  try {
    if (!(await stat(dir)).isDirectory()) return
  } catch {
    return
  }
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = `${prefix}/${entry.name}`
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await addFolder(zip, full, rel)
    else zip.file(rel, await readFile(full))
  }
}

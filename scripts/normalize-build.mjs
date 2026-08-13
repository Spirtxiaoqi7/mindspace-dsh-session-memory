import { readFile, writeFile } from 'node:fs/promises'

const target = new URL('../lib/client.js', import.meta.url)
const source = await readFile(target, 'utf8')
const normalized = source.replace(/[ \t]+$/gm, '').replaceAll('\r\n', '\n')
if (normalized !== source) await writeFile(target, normalized)

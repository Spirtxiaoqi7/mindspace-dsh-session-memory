import { readFile, writeFile } from 'node:fs/promises'

const files = ['src/generated/typert.host.js', 'src/generated/remote.js']
const from = '@deepseek-ai/dsh-session-memory-governance'
const to = 'mindspace-dsh-session-memory'

for (const file of files) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  const next = source.replaceAll(from, to)
  if (next !== source) await writeFile(new URL(`../${file}`, import.meta.url), next)
}

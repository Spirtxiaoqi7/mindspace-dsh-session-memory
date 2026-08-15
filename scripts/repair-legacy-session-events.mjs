import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)
const customTypes = new Set([
  'session-memory/change',
  'session-memory/extraction-request',
  'session-memory/extraction-result',
])
const checksumOptions = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function framesOf(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== 0xFD2FB528) {
      throw new Error(`invalid or incomplete Zstandard frame at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved Zstandard header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (offset > buffer.length) throw new Error(`incomplete Zstandard header at byte ${start}`)
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`incomplete Zstandard block at byte ${start}`)
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (header & 1) !== 0
      const type = (header >>> 1) & 3
      const size = header >>> 3
      if (type === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      offset += type === 1 ? 1 : size
      if (offset > buffer.length) throw new Error(`incomplete Zstandard payload at byte ${start}`)
      if (last) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error(`incomplete Zstandard checksum at byte ${start}`)
    frames.push({ start, end: offset })
  }
  return frames
}

function markLines(text) {
  let changed = 0
  const ending = text.endsWith('\n') ? '\n' : ''
  const lines = text.replace(/\n$/, '').split('\n')
  const output = lines.map((line) => {
    const value = JSON.parse(line)
    if (!customTypes.has(value.type) || value.ignorable === true) return line
    value.ignorable = true
    changed += 1
    return JSON.stringify(value)
  })
  return { changed, text: output.join('\n') + ending }
}

async function repair(file) {
  const source = await readFile(file)
  const frames = framesOf(source)
  const output = []
  let changed = 0
  for (const frame of frames) {
    const encoded = source.subarray(frame.start, frame.end)
    const plain = await decompress(encoded)
    const marked = markLines(plain.toString('utf8'))
    changed += marked.changed
    output.push(marked.changed === 0 ? encoded : await compress(marked.text, checksumOptions))
  }
  if (changed === 0) return { changed: 0 }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.pre-memory-envelope-fix-${stamp}.bak`
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  await copyFile(file, backup)
  await writeFile(temporary, Buffer.concat(output), { flag: 'wx' })
  await rename(temporary, file)
  return { changed, backup }
}

const file = process.argv[2]
if (!file) throw new Error('usage: node scripts/repair-legacy-session-events.mjs <session.jsonl.zstd>')
await stat(file)
await mkdir(dirname(file), { recursive: true })
const result = await repair(file)
console.log(JSON.stringify({ file, ...result }, null, 2))

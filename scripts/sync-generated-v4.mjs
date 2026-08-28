import { readFile, writeFile } from 'node:fs/promises'

const files = ['src/generated/remote.js', 'src/generated/typert.host.js']
const markerStart = 'const _deepseek_ai_dsh_session_memory_governance_sessionMemory_get_result$schema ='
const markerEnd = 'const _mindspace_dsh_session_memory_sessionMemory_compactionPolicy$schema ='
const schemas = String.raw`const _sessionMemoryPerson$schema = z.object({
  'id': z.string().readonly(), 'name': z.string().readonly(), 'information': z.string().readonly(),
  'preference': z.string().readonly(), 'relationship': z.string().readonly(),
  'source': z.union([z.literal("user"), z.literal("extracted")]).readonly(),
  'evidenceSeqs': z.array(z.number()).readonly(), 'updatedAt': z.number().readonly(),
}).readonly()
const _sessionMemoryItem$schema = z.object({
  'id': z.string().readonly(), 'category': z.string().readonly(), 'text': z.string().readonly(),
  'source': z.union([z.literal("user"), z.literal("extracted")]).readonly(),
  'evidenceSeqs': z.array(z.number()).readonly(),
}).readonly()
const _sessionMemoryDocument$schema = z.object({
  'version': z.literal(4).readonly(), 'revision': z.number().readonly(),
  'people': z.array(_sessionMemoryPerson$schema).readonly(),
  'assistantRequirements': z.array(_sessionMemoryItem$schema).readonly(),
  'memories': z.array(_sessionMemoryItem$schema).readonly(), 'updatedAt': z.number().readonly(),
}).readonly()
const _sessionMemoryActivity$schema = z.object({
  'id': z.string().readonly(), 'sourceSeqs': z.array(z.number()).readonly(),
  'operation': z.union([z.literal("append"), z.literal("merge"), z.literal("replace"), z.literal("skip")]).readonly(),
  'section': z.union([z.literal("people"), z.literal("assistantRequirements"), z.literal("memories")]).readonly(),
  'before': z.union([z.literal(null), z.string()]).readonly(), 'after': z.union([z.literal(null), z.string()]).readonly(),
  'reason': z.string().readonly(), 'at': z.number().readonly(),
}).readonly()
const _deepseek_ai_dsh_session_memory_governance_sessionMemory_get_result$schema = z.object({
  'document': _sessionMemoryDocument$schema, 'memoryActivity': z.array(_sessionMemoryActivity$schema).readonly(),
})
const _deepseek_ai_dsh_session_memory_governance_sessionMemory_replace_parameter_0$schema = z.intersection(z.string(), z.unknown())
const _deepseek_ai_dsh_session_memory_governance_sessionMemory_replace_parameter_1$schema = z.object({
  'expectedRevision': z.number().readonly(), 'people': z.array(_sessionMemoryPerson$schema).readonly(),
  'assistantRequirements': z.array(_sessionMemoryItem$schema).readonly(), 'memories': z.array(_sessionMemoryItem$schema).readonly(),
})
const _deepseek_ai_dsh_session_memory_governance_sessionMemory_replace_result$schema = z.union([z.object({
  'ok': z.literal(true).readonly(), 'value': z.object({
    'document': _sessionMemoryDocument$schema, 'memoryActivity': z.array(_sessionMemoryActivity$schema).readonly(),
  }).readonly(),
}), z.object({
  'ok': z.literal(false).readonly(), 'error': z.object({
    'code': z.union([z.literal("stale-revision"), z.literal("invalid-document"), z.literal("text-too-large")]).readonly(),
    'message': z.string().readonly(),
  }).readonly(),
})])

`

for (const file of files) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  const existingHelpers = source.indexOf('const _sessionMemoryPerson$schema =')
  const start = existingHelpers >= 0 ? existingHelpers : source.indexOf(markerStart)
  const end = source.indexOf(markerEnd)
  if (start < 0 || end <= start) throw new Error(`Cannot locate generated schema block in ${file}`)
  let next = source.slice(0, start) + schemas + source.slice(end)
  if (file.endsWith('typert.host.js')) {
    const modelStart = next.indexOf('\n  model: {')
    if (modelStart >= 0) next = `${next.slice(0, modelStart)}\n}\n`
  }
  await writeFile(new URL(`../${file}`, import.meta.url), next)
}

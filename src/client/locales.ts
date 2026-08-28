export const zh = {
  nav: '个性化', title: '记忆中心', intro: 'Memory 将会话中的人物、要求与记忆分开整理。每个会话彼此隔离，可随时检查和修改。',
  session: '会话', people: '人物信息', peopleHint: '最多五个人物。人物一对应当前发言者，但不代表世界里只有这一个人。', personName: '个体名称', personInformation: '个体信息', addPerson: '新增人物',
  preferences: '人物偏好', preferencesHint: '每个人物对应一段偏好，最多 300 字；与上方人物顺序和身份严格对齐。',
  instructions: '对 AI 的要求', instructionsHint: '只记录明确对 AI 提出的必须、应该、不要、禁止和稳定互动规则。',
  relationships: '人物之间关系', relationshipsHint: '分别描述每个人物与当前 AI 的关系及背景；关系可随互动变化。',
  memories: '记忆', memoriesHint: '可随时写入的普通记忆，不再限定为扮演预设；最多三组。',
  save: '保存', reload: '重新载入', loading: '正在读取记忆…', empty: '暂无会话', remove: '删除', saved: '已保存', stale: '记忆已在其他位置变化，请重新载入。',
  group: '归纳组', addGroup: '新增归纳组', groupLimit: '已满三组', mergeFirst: '请先把新信息融合进现有归纳组', categoryPlaceholder: '分类名称', structuredPlaceholder: '用简洁、结构化的语句归纳同类信息…',
  activity: '最近记忆整理', activityHint: '查看 AI 对记忆做了什么，以及每次合并或覆盖的依据。', noActivity: '当前还没有记忆整理记录。',
  activityAppend: '新增', activityMerge: '合并', activityReplace: '覆盖', activitySkip: '跳过', before: '整理前', after: '整理后', reason: '原因',
}
export const en: typeof zh = {
  nav: 'Personalization', title: 'Memory Center', intro: 'Memory separates people, AI requirements, and ordinary memories. Each session remains isolated and editable.',
  session: 'Session', people: 'People', peopleHint: 'Up to five people. Person one is the current speaker, but does not represent the whole world.', personName: 'Person name', personInformation: 'Person information', addPerson: 'Add person',
  preferences: 'Person preferences', preferencesHint: 'One preference text per person, aligned with the people above and limited to 300 characters.',
  instructions: 'Instructions for AI', instructionsHint: 'Only explicit must, should, do-not, prohibition, and stable interaction rules.',
  relationships: 'Relationships', relationshipsHint: 'Each field describes that person’s relationship and background with the current AI.',
  memories: 'Memories', memoriesHint: 'Ordinary editable memories rather than roleplay-only presets; up to three groups.',
  save: 'Save', reload: 'Reload', loading: 'Loading memory…', empty: 'No sessions', remove: 'Remove', saved: 'Saved', stale: 'Memory changed elsewhere. Reload it.',
  group: 'Group', addGroup: 'Add group', groupLimit: 'Three groups reached', mergeFirst: 'Merge new information into an existing group first', categoryPlaceholder: 'Category name', structuredPlaceholder: 'Consolidate related information in concise, structured language…',
  activity: 'Recent memory changes', activityHint: 'See what the AI changed and why.', noActivity: 'No memory activity yet.',
  activityAppend: 'Added', activityMerge: 'Merged', activityReplace: 'Replaced', activitySkip: 'Skipped', before: 'Before', after: 'After', reason: 'Reason',
}
export type SessionMemoryKey = keyof typeof zh

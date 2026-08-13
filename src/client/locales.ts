export const zh = {
  nav: '个性化', title: '记忆中心', intro: 'AI 会在对话中持续归纳；每个会话的画像、偏好、关系与使命彼此隔离。你可以随时检查和修改。',
  session: '会话', profile: '用户个人信息', profileHint: '明确事实与 AI 观察分开保存，合计约 300 字；推测不会覆盖你明确说过的信息。',
  confirmedProfile: '已确认信息', inferredProfile: 'AI 观察', profilePlaceholder: '例如：25 岁男性，现居上海；从事软件开发，熟悉 TypeScript…', inferredPlaceholder: '例如：重视效率和实际验证；更习惯直接、明确的沟通…',
  preferences: '用户偏好', preferencesHint: '按生活、技术、内容等主题归纳；最多三组，但每组可容纳多项信息。',
  instructions: '对 AI 的要求', instructionsHint: '同类规则会自动融合，冲突时以用户最新的明确要求为准。',
  relationship: '关系与窗口使命', roleplayPreset: '扮演预设', roleplayHint: '预设仅对当前选中会话生效；关闭后保留内容但不注入模型。',
  roleplayPlaceholder: '例如：角色背景、语气、互动边界与剧情约定…', enabled: '已启用', disabled: '已关闭', clearPreset: '清空预设', clearRelationship: '清空关系设置',
  role: '关系身份', mission: '窗口使命', guidance: '身份补充说明', save: '保存', reload: '重新载入', loading: '正在读取记忆…', empty: '暂无会话', remove: '删除', saved: '已保存', stale: '记忆已在其他位置变化，请重新载入。',
  group: '归纳组', addGroup: '新增归纳组', groupLimit: '已满三组', mergeFirst: '请先把新信息融合进现有归纳组', categoryPlaceholder: '分类名称，例如「技术与工具」', structuredPlaceholder: '用简洁、结构化的语句归纳同类信息…',
  activity: '最近记忆整理', activityHint: '查看 AI 对记忆做了什么，以及每次合并或覆盖的依据。', noActivity: '当前还没有记忆整理记录。开始对话后，写入与覆盖过程会显示在这里。',
  activityAppend: '新增', activityMerge: '合并', activityReplace: '覆盖', activitySkip: '跳过', before: '整理前', after: '整理后', reason: '原因',
}
export const en: typeof zh = {
  nav: 'Personalization', title: 'Memory Center', intro: 'AI continuously consolidates memory while each session keeps its own profile, preferences, relationship, and purpose. You can inspect and edit them at any time.',
  session: 'Session', profile: 'User profile', profileHint: 'Confirmed facts and AI observations are kept separate, with about 300 characters total. Inferences never override explicit facts.',
  confirmedProfile: 'Confirmed information', inferredProfile: 'AI observations', profilePlaceholder: 'For example: 25-year-old man living in Shanghai; software developer familiar with TypeScript…', inferredPlaceholder: 'For example: values efficiency and concrete verification; prefers direct communication…',
  preferences: 'User preferences', preferencesHint: 'Consolidated by themes such as lifestyle, technology, and content. Up to three groups, each holding multiple details.',
  instructions: 'Instructions for AI', instructionsHint: 'Similar rules are merged. When they conflict, the user’s latest explicit instruction wins.',
  relationship: 'Relationship and window purpose', roleplayPreset: 'Roleplay preset', roleplayHint: 'This preset applies only to the selected session. Disabling it keeps the text but removes it from the model prompt.',
  roleplayPlaceholder: 'Character background, voice, interaction boundaries, and story rules…', enabled: 'Enabled', disabled: 'Disabled', clearPreset: 'Clear preset', clearRelationship: 'Clear relationship',
  role: 'Relationship role', mission: 'Window purpose', guidance: 'Additional identity guidance', save: 'Save', reload: 'Reload', loading: 'Loading memory…', empty: 'No sessions', remove: 'Remove', saved: 'Saved', stale: 'Memory changed elsewhere. Reload it.',
  group: 'Group', addGroup: 'Add group', groupLimit: 'Three groups reached', mergeFirst: 'Merge the new information into an existing group first', categoryPlaceholder: 'Category name, e.g. Technology & tools', structuredPlaceholder: 'Consolidate related information in concise, structured language…',
  activity: 'Recent memory changes', activityHint: 'See what the AI changed and why each merge or replacement was made.', noActivity: 'No memory activity yet. Writes and replacements will appear here as the conversation continues.',
  activityAppend: 'Added', activityMerge: 'Merged', activityReplace: 'Replaced', activitySkip: 'Skipped', before: 'Before', after: 'After', reason: 'Reason',
}
export type SessionMemoryKey = keyof typeof zh

export const zh = {
  nav: '个性化', title: '记忆中心', intro: 'Memory 按明确规则整理，并在写入前先读取现有内容。每个会话彼此隔离，你可以随时检查和修改。',
  session: '会话', profile: '用户个人信息', profileHint: '这里只保存与用户本人有关的信息；已确认与待确认分开，二者都可修改，合计约 300 字。',
  confirmedProfile: '已确认信息', pendingProfile: '正在确认的信息', profilePlaceholder: '例如：25 岁，现居上海；从事软件开发，熟悉 TypeScript…', pendingPlaceholder: '例如：可能正在转向硬件开发，仍需后续确认…',
  preferences: '用户偏好', preferencesHint: '记录实际喜欢、讨厌、关注的主题、活动、工具和习惯；不把偏好误写成对 AI 的命令。',
  instructions: '对 AI 的要求', instructionsHint: '只记录明确对 AI 提出的必须、应该、不要、禁止和稳定互动规则。',
  relationship: '当前关系状态', relationshipHint: '这是可变化、可减弱、可结束或清空的当前描述，不是 AI 的永久身份、使命或义务。', roleplayPreset: '扮演预设', roleplayHint: '仅保存用户明确设定的 VIP 扮演内容；普通互动不会自动扩写此处。关闭后保留内容但不注入模型。',
  roleplayPlaceholder: '例如：角色背景、语气、互动边界与剧情约定…', enabled: '已启用', disabled: '已关闭', clearPreset: '清空预设', clearRelationship: '清空关系设置',
  relationshipStatus: '当前状态', relationshipContext: '状态依据与背景', save: '保存', reload: '重新载入', loading: '正在读取记忆…', empty: '暂无会话', remove: '删除', saved: '已保存', stale: '记忆已在其他位置变化，请重新载入。',
  group: '归纳组', addGroup: '新增归纳组', groupLimit: '已满三组', mergeFirst: '请先把新信息融合进现有归纳组', categoryPlaceholder: '分类名称，例如「技术与工具」', structuredPlaceholder: '用简洁、结构化的语句归纳同类信息…',
  activity: '最近记忆整理', activityHint: '查看 AI 对记忆做了什么，以及每次合并或覆盖的依据。', noActivity: '当前还没有记忆整理记录。开始对话后，写入与覆盖过程会显示在这里。',
  activityAppend: '新增', activityMerge: '合并', activityReplace: '覆盖', activitySkip: '跳过', before: '整理前', after: '整理后', reason: '原因',
}
export const en: typeof zh = {
  nav: 'Personalization', title: 'Memory Center', intro: 'Memory follows explicit rules and reads existing state before each write. Sessions stay isolated and editable.',
  session: 'Session', profile: 'User profile', profileHint: 'Only user-related information belongs here. Confirmed and pending information are separate and both remain editable.',
  confirmedProfile: 'Confirmed information', pendingProfile: 'Pending confirmation', profilePlaceholder: 'For example: 25 years old, lives in Shanghai; software developer familiar with TypeScript…', pendingPlaceholder: 'For example: may be moving toward hardware development; still needs confirmation…',
  preferences: 'User preferences', preferencesHint: 'Consolidated by themes such as lifestyle, technology, and content. Up to three groups, each holding multiple details.',
  instructions: 'Instructions for AI', instructionsHint: 'Similar rules are merged. When they conflict, the user’s latest explicit instruction wins.',
  relationship: 'Current relationship state', relationshipHint: 'A revisable current description that can strengthen, weaken, end, or be cleared. It is never a permanent identity, mission, or obligation.', roleplayPreset: 'Roleplay preset', roleplayHint: 'Only explicit user-authored VIP roleplay belongs here. Ordinary interaction never expands it automatically.',
  roleplayPlaceholder: 'Character background, voice, interaction boundaries, and story rules…', enabled: 'Enabled', disabled: 'Disabled', clearPreset: 'Clear preset', clearRelationship: 'Clear relationship',
  relationshipStatus: 'Current state', relationshipContext: 'Evidence and context', save: 'Save', reload: 'Reload', loading: 'Loading memory…', empty: 'No sessions', remove: 'Remove', saved: 'Saved', stale: 'Memory changed elsewhere. Reload it.',
  group: 'Group', addGroup: 'Add group', groupLimit: 'Three groups reached', mergeFirst: 'Merge the new information into an existing group first', categoryPlaceholder: 'Category name, e.g. Technology & tools', structuredPlaceholder: 'Consolidate related information in concise, structured language…',
  activity: 'Recent memory changes', activityHint: 'See what the AI changed and why each merge or replacement was made.', noActivity: 'No memory activity yet. Writes and replacements will appear here as the conversation continues.',
  activityAppend: 'Added', activityMerge: 'Merged', activityReplace: 'Replaced', activitySkip: 'Skipped', before: 'Before', after: 'After', reason: 'Reason',
}
export type SessionMemoryKey = keyof typeof zh

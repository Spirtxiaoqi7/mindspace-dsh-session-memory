export const zh = {
  nav: '个性化', title: '记忆中心', intro: '每个会话拥有独立的记忆、关系身份与窗口使命。修改只影响所选会话。',
  session: '会话', summary: 'DeepSeek 结构化压缩', summaryHint: '默认直接显示 DSH 压缩摘要；编辑后使用你的覆盖版本。',
  currentSummary: '当前 DSH 压缩摘要', noSummary: '当前会话尚未生成 DSH 压缩摘要。', summaryOverride: '用户覆盖（可选）', summaryOverridePlaceholder: '留空则继续使用 DSH 压缩摘要',
  preferences: '用户偏好', facts: '用户个人信息', instructions: '对 AI 的要求', relationship: '关系与窗口使命',
  roleplayPreset: '扮演预设', roleplayHint: '预设仅对当前选中会话生效；关闭后保留内容但不注入模型。',
  roleplayPlaceholder: '例如：角色背景、语气、互动边界与剧情约定…', enabled: '已启用', disabled: '已关闭', clearPreset: '清空预设',
  role: '关系身份', mission: '窗口使命', guidance: '身份补充说明', save: '保存', reload: '重新载入', loading: '正在读取记忆…', empty: '暂无会话', add: '添加一条', remove: '删除', saved: '已保存', stale: '记忆已在其他位置变化，请重新载入。',
}
export const en: typeof zh = {
  nav: 'Personalization', title: 'Memory Center', intro: 'Each session has isolated memory, relationship identity, and purpose. Changes affect only the selected session.',
  session: 'Session', summary: 'DeepSeek structured compaction', summaryHint: 'Shows the DSH compaction summary by default; editing creates your override.',
  currentSummary: 'Current DSH compaction summary', noSummary: 'This session does not have a DSH compaction summary yet.', summaryOverride: 'User override (optional)', summaryOverridePlaceholder: 'Leave blank to keep using the DSH compaction summary',
  preferences: 'User preferences', facts: 'User facts', instructions: 'Instructions for AI', relationship: 'Relationship and window purpose',
  roleplayPreset: 'Roleplay preset', roleplayHint: 'This preset applies only to the selected session. Disabling it keeps the text but removes it from the model prompt.',
  roleplayPlaceholder: 'Character background, voice, interaction boundaries, and story rules…', enabled: 'Enabled', disabled: 'Disabled', clearPreset: 'Clear preset',
  role: 'Relationship role', mission: 'Window mission', guidance: 'Additional identity guidance', save: 'Save', reload: 'Reload', loading: 'Loading memory…', empty: 'No sessions', add: 'Add item', remove: 'Remove', saved: 'Saved', stale: 'Memory changed elsewhere. Reload it.',
}
export type SessionMemoryKey = keyof typeof zh

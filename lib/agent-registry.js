const CLAUDE_MODEL_OPTIONS = [
  { value: 'opus', label: 'Opus', desc: '最强大，1M 上下文' },
  { value: 'sonnet', label: 'Sonnet', desc: '平衡性能，1M 上下文' },
  { value: 'haiku', label: 'Haiku', desc: '最快速，适合简单任务' },
];

const CODEX_BASE_MODEL_OPTIONS = [
  { value: 'gpt-5.4', label: 'GPT-5.4', desc: '当前主力 Codex 模型' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', desc: '偏工程执行场景' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', desc: '兼容旧路由与旧配置' },
  { value: 'gpt-5.2', label: 'GPT-5.2', desc: '通用 OpenAI 兼容模型' },
];

const CODEX_THINKING_OPTIONS = [
  { value: '', label: '默认思考', desc: '不附加 thinking 强度' },
  { value: 'medium', label: 'medium', desc: '中等 thinking' },
  { value: 'high', label: 'high', desc: '更强 thinking' },
  { value: 'xhigh', label: 'xhigh', desc: '最强 thinking' },
];

const AGENT_DEFINITIONS = [
  {
    id: 'claude',
    label: 'Claude',
    avatar: '/claude.png',
    default: true,
    runtimeSessionField: 'claudeSessionId',
    defaults: {
      initialModel: 'opus',
      defaultSessionModel: { source: 'model-map', key: 'opus' },
      localTaskCwd: { source: 'home' },
    },
    modelControl: {
      kind: 'preset',
      title: '选择模型',
      options: CLAUDE_MODEL_OPTIONS,
    },
    import: {
      enabled: true,
      requestType: 'list_agent_import_sessions',
      actionType: 'import_agent_session',
      payloadFields: ['sessionId', 'projectDir'],
      listStyle: 'grouped',
      buttonLabel: '导入本地 Claude 会话',
      modalTitle: '导入本地 Claude 会话',
      contextTitle: '从 Claude 原生历史导入',
      contextCopy: '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。',
      loadingText: '正在加载 Claude 本地历史…',
      emptyText: '未找到本地 Claude 会话',
      reimportConfirm: '已导入过此会话，重新导入将覆盖已有内容。确认继续？',
      importConfirm: '由于 cc-web 与本地 CLI 的逻辑不同，导入会话需要解析后方可展示，导入后将覆盖已有内容。确认继续？',
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    avatar: '/codex.png',
    default: false,
    runtimeSessionField: 'codexThreadId',
    defaults: {
      initialModel: '',
      defaultSessionModel: { source: 'literal', value: 'gpt-5.4' },
      localTaskCwd: { source: 'none' },
    },
    modelControl: {
      kind: 'reasoning',
      title: '选择 Codex 模型',
      secondaryTitle: '选择 Thinking 强度',
      baseOptions: CODEX_BASE_MODEL_OPTIONS,
      thinkingOptions: CODEX_THINKING_OPTIONS,
    },
    import: {
      enabled: true,
      requestType: 'list_agent_import_sessions',
      actionType: 'import_agent_session',
      payloadFields: ['threadId', 'rolloutPath'],
      listStyle: 'flat',
      buttonLabel: '导入本地 Codex 会话',
      modalTitle: '导入本地 Codex 会话',
      contextTitle: '从 Codex rollout 历史导入',
      contextCopy: '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。',
      loadingText: '正在加载 Codex 本地历史…',
      emptyText: '未找到本地 Codex 会话',
      reimportConfirm: '已导入过此 Codex 会话，重新导入将覆盖已有内容。确认继续？',
      importConfirm: '将解析本地 Codex rollout 历史并导入当前 Web 视图。确认继续？',
    },
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    avatar: '',
    default: false,
    runtimeSessionField: 'codebuddySessionId',
    defaults: {
      initialModel: '',
      defaultSessionModel: null,
      localTaskCwd: { source: 'none' },
    },
    modelControl: {
      kind: 'dynamic',
      title: '选择 CodeBuddy 模型',
      loadingText: '正在加载 CodeBuddy 模型…',
      emptyText: '未获取到 CodeBuddy 可用模型',
      emptyLabel: '选择模型',
      sourceLabel: 'CodeBuddy CLI',
    },
    import: null,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    avatar: '',
    default: false,
    runtimeSessionField: 'kimiSessionId',
    defaults: {
      initialModel: '',
      defaultSessionModel: { source: 'kimi-config-default' },
      localTaskCwd: { source: 'none' },
    },
    modelControl: {
      kind: 'dynamic',
      title: '选择 Kimi 模型',
      loadingText: '正在加载 Kimi 模型…',
      emptyText: '未获取到 Kimi 可用模型',
      emptyLabel: '选择模型',
      sourceLabel: 'Kimi 配置',
    },
    import: null,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    avatar: '',
    default: false,
    runtimeSessionField: 'opencodeSessionId',
    defaults: {
      initialModel: '',
      defaultSessionModel: null,
      localTaskCwd: { source: 'none' },
    },
    modelControl: {
      kind: 'dynamic',
      title: '选择 OpenCode 模型',
      loadingText: '正在加载 OpenCode 模型…',
      emptyText: '未获取到 OpenCode 可用模型',
      emptyLabel: '选择模型',
      sourceLabel: 'OpenCode CLI',
    },
    import: {
      enabled: true,
      requestType: 'list_agent_import_sessions',
      actionType: 'import_agent_session',
      payloadFields: ['sessionId'],
      listStyle: 'flat',
      buttonLabel: '导入本地 OpenCode 会话',
      modalTitle: '导入本地 OpenCode 会话',
      contextTitle: '从 OpenCode 本地历史导入',
      contextCopy: '读取本地 OpenCode 会话历史，恢复用户消息、助手输出、推理过程与工具调用。',
      loadingText: '正在加载 OpenCode 本地历史…',
      emptyText: '未找到本地 OpenCode 会话',
      reimportConfirm: '已导入过此 OpenCode 会话，重新导入将覆盖已有内容。确认继续？',
      importConfirm: '将解析本地 OpenCode 会话历史并导入当前 Web 视图。确认继续？',
    },
  },
];

const DEFAULT_AGENT = AGENT_DEFINITIONS.find((agent) => agent.default)?.id || AGENT_DEFINITIONS[0]?.id || 'claude';
const AGENT_MAP = new Map(AGENT_DEFINITIONS.map((agent) => [agent.id, agent]));

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasAgent(agent) {
  return AGENT_MAP.has(String(agent || ''));
}

function normalizeAgent(agent) {
  const normalized = String(agent || '').trim();
  return hasAgent(normalized) ? normalized : DEFAULT_AGENT;
}

function getAgentConfig(agent) {
  return AGENT_MAP.get(normalizeAgent(agent)) || AGENT_MAP.get(DEFAULT_AGENT);
}

function getAgentIds() {
  return AGENT_DEFINITIONS.map((agent) => agent.id);
}

function getRuntimeSessionField(agent) {
  return getAgentConfig(agent).runtimeSessionField;
}

function getPublicAgentCatalog() {
  return AGENT_DEFINITIONS.map((agent) => deepClone({
    id: agent.id,
    label: agent.label,
    avatar: agent.avatar,
    default: !!agent.default,
    defaults: {
      initialModel: agent.defaults?.initialModel || '',
    },
    modelControl: agent.modelControl || null,
    import: agent.import || null,
  }));
}

module.exports = {
  DEFAULT_AGENT,
  CODEX_BASE_MODEL_OPTIONS,
  CODEX_THINKING_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  getAgentConfig,
  getAgentIds,
  getPublicAgentCatalog,
  getRuntimeSessionField,
  hasAgent,
  normalizeAgent,
};

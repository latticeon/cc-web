// === CC-Web Frontend ===
(function () {
  'use strict';

  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const RENDER_DEBOUNCE = 100;
  const MAX_RENDERED_MESSAGES = 80;
  const LOCAL_HISTORY_CHUNK_SIZE = 24;
  const INITIAL_PROJECT_SESSION_COUNT = 5;
  const PROJECT_SESSION_LOAD_MORE_COUNT = 10;
  const GIT_STATUS_POLL_INTERVAL = 2000;
  const gitWorkspaceView = window.CcGitWorkspaceView;
  const {
    finalizeActiveToolCalls,
    normalizeElapsedDuration,
    formatElapsedDuration,
    createGenerationPoller,
    calculateScrollIndicator,
    getNextDisplayLimit,
  } = window.CcChatStreamState;
  const splitLayoutView = window.CcSplitLayout;

  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: '清除当前会话' },
    { cmd: '/model', desc: '查看/切换模型' },
    { cmd: '/mode', desc: '查看/切换权限模式' },
    { cmd: '/cost', desc: '查看会话费用' },
    { cmd: '/compact', desc: '压缩上下文' },
    { cmd: '/init', desc: '生成/更新 Agent 指南文件' },
    { cmd: '/github', desc: 'GitHub 操作（读取开发者配置后执行）' },
    { cmd: '/ssh', desc: 'SSH 远程操作（读取开发者配置后执行）' },
    { cmd: '/help', desc: '显示帮助' },
  ];

  const MODE_LABELS = {
    default: '默认',
    plan: 'Plan',
    yolo: 'YOLO',
  };

  const FALLBACK_AGENT_CATALOG = [
    {
      id: 'claude',
      label: 'Claude',
      avatar: '/claude.png',
      default: true,
      defaults: { initialModel: 'opus' },
      modelControl: {
        kind: 'preset',
        title: '选择模型',
        options: [
          { value: 'opus', label: 'Opus', desc: '最强大，1M 上下文' },
          { value: 'sonnet', label: 'Sonnet', desc: '平衡性能，1M 上下文' },
          { value: 'haiku', label: 'Haiku', desc: '最快速，适合简单任务' },
        ],
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
      defaults: { initialModel: '' },
      modelControl: {
        kind: 'reasoning',
        title: '选择 Codex 模型',
        secondaryTitle: '选择 Thinking 强度',
        baseOptions: [
          { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', desc: 'GPT-5.6 Sol 模型' },
          { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', desc: 'GPT-5.6 Terra 模型' },
          { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', desc: 'GPT-5.6 Luna 模型' },
          { value: 'gpt-5.5', label: 'GPT-5.5', desc: 'GPT-5.5 模型' },
          { value: 'gpt-5.4', label: 'GPT-5.4', desc: 'GPT-5.4 模型' },
        ],
        thinkingOptions: [
          { value: 'low', label: '低', desc: '低强度 thinking' },
          { value: 'medium', label: '中', desc: '中等 thinking' },
          { value: 'high', label: '高', desc: '高强度 thinking' },
          { value: 'xhigh', label: '最强', desc: '最强 thinking' },
        ],
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
      defaults: { initialModel: '' },
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
      defaults: { initialModel: '' },
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
      defaults: { initialModel: '' },
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

  function normalizeAgentCatalog(rawCatalog) {
    const source = Array.isArray(rawCatalog) && rawCatalog.length > 0 ? rawCatalog : FALLBACK_AGENT_CATALOG;
    const seen = new Set();
    const normalized = source
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const id = String(item.id || '').trim();
        const label = String(item.label || '').trim();
        if (!id || !label || seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          label,
          avatar: String(item.avatar || ''),
          default: !!item.default,
          defaults: {
            initialModel: String(item.defaults?.initialModel || ''),
          },
          modelControl: item.modelControl ? JSON.parse(JSON.stringify(item.modelControl)) : null,
          import: item.import ? JSON.parse(JSON.stringify(item.import)) : null,
        };
      })
      .filter(Boolean);
    return normalized.length > 0 ? normalized : JSON.parse(JSON.stringify(FALLBACK_AGENT_CATALOG));
  }

  const AGENT_CATALOG = normalizeAgentCatalog(window.CC_AGENT_CATALOG);
  const AGENT_MAP = Object.fromEntries(AGENT_CATALOG.map((agent) => [agent.id, agent]));
  const AGENT_LABELS = Object.fromEntries(AGENT_CATALOG.map((agent) => [agent.id, agent.label]));
  const DEFAULT_AGENT = AGENT_CATALOG.find((agent) => agent.default)?.id || AGENT_CATALOG[0]?.id || 'claude';
  const SESSION_CACHE_LIMIT = 4;
  const SESSION_CACHE_MAX_WEIGHT = 1_500_000;
  const SIDEBAR_SWIPE_TRIGGER = 72;
  const SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT = 42;
  const PROJECT_COLLAPSE_KEY = 'cc-web-collapsed-projects';
  const UNGROUPED_PROJECT_KEY = '__cc-web-ungrouped-project__';

  function loadCollapsedProjectKeys() {
    try {
      const raw = localStorage.getItem(PROJECT_COLLAPSE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  function saveCollapsedProjectKeys(keys) {
    try { localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify(Array.from(keys))); } catch {}
  }

  function getAgentDefinition(agent) {
    return AGENT_MAP[normalizeAgent(agent)] || AGENT_MAP[DEFAULT_AGENT] || AGENT_CATALOG[0];
  }

  function getAgentModelControl(agent) {
    return getAgentDefinition(agent)?.modelControl || null;
  }

  function getAgentImportSpec(agent) {
    const spec = getAgentDefinition(agent)?.import || null;
    return spec?.enabled ? spec : null;
  }

  function getImportableAgents() {
    return AGENT_CATALOG.filter((agent) => getAgentImportSpec(agent.id));
  }

  const MODE_PICKER_OPTIONS = [
    { value: 'yolo', label: 'YOLO', desc: '跳过所有权限检查' },
    { value: 'plan', label: 'Plan', desc: '执行前需确认计划' },
    { value: 'default', label: '默认', desc: '标准权限审批' },
  ];

  const THEME_OPTIONS = [
    {
      value: 'washi',
      label: 'Washi Warm',
      desc: '暖纸色与朱砂点缀，保留当前熟悉的 CC-Web 气质。',
      swatches: ['#faf6f0', '#f2ebe2', '#c0553a', '#5d8a54'],
    },
    {
      value: 'coolvibe',
      label: 'CoolVibe Light',
      desc: '保留 CoolVibe 的青色科技感，但改成更干净的浅色工作台。',
      swatches: ['#f7fbfc', '#eef7f9', '#0891b2', '#ffffff'],
    },
    {
      value: 'editorial',
      label: 'Editorial Sand',
      desc: '更明亮的留白和更克制的棕色强调，像编辑台一样安静。',
      swatches: ['#f6f1e8', '#efe8dc', '#8b5e3c', '#2f4b45'],
    },
    {
      value: 'midnight',
      label: 'Midnight Dark',
      desc: '深灰工作台搭配青绿强调，适合夜间长时间使用。',
      swatches: ['#141715', '#1d211f', '#4fa88c', '#edf2ee'],
    },
  ];

  const FONT_OPTIONS = [
    {
      value: 'system',
      label: '系统默认',
      desc: '跟随当前系统的界面字体。',
      preview: 'Aa 字',
    },
    {
      value: 'mono',
      label: 'Chivo Mono',
      desc: '清晰规整的等宽字体。',
      preview: 'Aa 01',
    },
    {
      value: 'modern',
      label: '现代无衬线',
      desc: '紧凑清爽的现代界面字体。',
      preview: 'Aa 字',
    },
  ];

  // --- State ---
  let ws = null;
  let authToken = localStorage.getItem('cc-web-token');
  let currentSessionId = null;
  let sessions = [];
  let projects = [];
  let sessionCache = new Map();
  let agentModelOptionsCache = new Map();
  let pendingAgentModelRequests = new Map();
  let agentModelRequestSeq = 0;
  let isGenerating = false;
  let generationKind = 'response';
  let currentContextTokens = 0;
  let generationUsageResolved = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pendingText = '';
  let renderTimer = null;
  let generationStartedAt = 0;
  let generationElapsedTimer = null;
  let activeToolCalls = new Map();
  let cmdMenuIndex = -1;
  let currentMode = 'yolo';
  let currentAgent = AGENT_LABELS[localStorage.getItem('cc-web-agent')] ? localStorage.getItem('cc-web-agent') : DEFAULT_AGENT;
  let currentModel = getAgentDefinition(currentAgent)?.defaults?.initialModel || '';
  let currentTheme = (document.documentElement.dataset.theme || localStorage.getItem('cc-web-theme') || 'washi');
  let currentFont = (document.documentElement.dataset.font || localStorage.getItem('cc-web-font') || 'system');
  let codexConfigCache = null;
  let aiConfigCache = null;
  let codebuddyConfigCache = null;
  let loadedHistorySessionId = null;
  let historyLoadState = { sessionId: null, loading: false, hasMore: false };
  let renderedMessageStart = 0;
  let localHistoryLoading = false;
  let activeSessionLoad = null;
  let sidebarSwipe = null;
  let pendingAttachments = [];
  let uploadingAttachments = [];
  let loginPasswordValue = ''; // store login password for force-change flow
  let currentCwd = null;
  let currentSessionRunning = false;
  let currentSessionMessages = [];
  let currentSessionUsage = null;
  let currentCodebuddyProfile = '';
  let activeClickTip = null;
  let autoStickToBottom = true;
  let messageLocatorUpdateQueued = false;
  let messageLocatorHistoryPrepended = false;
  let pendingScrollMessageIndex = null;
  let activeLocatorTouchMarker = null;
  let skipDeleteConfirm = localStorage.getItem('cc-web-skip-delete-confirm') === '1';
  let pendingInitialSessionLoad = false;
  let kimiConfigCache = null;
  let isSessionMultiSelectMode = false;
  let selectedSessionIds = new Set();
  let collapsedProjectKeys = new Set(loadCollapsedProjectKeys());
  const projectSessionDisplayLimits = new Map();
  let gitPanelOpen = false;
  let workspaceTab = 'changes';
  let currentWorkspacePath = '';
  let fileViewerSourceTab = 'files';
  let gitHistoryRequestSeq = 0;
  let gitHistoryObserver = null;
  let gitHistoryState = {
    sessionId: null,
    commits: [],
    nextOffset: 0,
    hasMore: true,
    loading: false,
    available: null,
    error: '',
    requestId: '',
  };

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
  const rememberPw = $('#remember-pw');
  const app = $('#app');
  const sessionLoadingOverlay = $('#session-loading-overlay');
  const sessionLoadingLabel = $('#session-loading-label');
  const sidebar = $('#sidebar');
  const sidebarResizer = $('#sidebar-resizer');
  const sidebarOverlay = $('#sidebar-overlay');
  const menuBtn = $('#menu-btn');
  const chatMain = document.querySelector('.chat-main');
  const newChatBtn = $('#new-chat-btn');
  const newProjectBtn = $('#new-project-btn');
  const importChatBtn = $('#import-chat-btn');
  const newChatDropdown = $('#new-chat-dropdown');
  const sessionMultiSelectBtn = $('#session-multiselect-btn');
  const sessionSelectAllBtn = $('#session-select-all-btn');
  const sessionInvertSelectBtn = $('#session-invert-select-btn');
  const sessionClearBtn = $('#session-clear-btn');
  const sessionList = $('#session-list');
  const chatTitle = $('#chat-title');
  const modelPickerBtn = $('#model-picker-btn');
  const thinkingPickerBtn = $('#thinking-picker-btn');
  const chatRuntimeState = $('#chat-runtime-state');
  const chatCodebuddyProfile = $('#chat-codebuddy-profile');
  const chatHeaderMeta = $('#chat-header-meta');
  const chatContextRow = $('#chat-context-row');
  const chatContextLabel = $('#chat-context-label');
  const chatContextText = $('#chat-context-text');
  const chatContextProgressBar = $('#chat-context-progress-bar');
  const costDisplay = $('#cost-display');
  const gitChangesBtn = $('#git-changes-btn');
  const gitChangesCount = $('#git-changes-count');
  const gitPanel = $('#git-panel');
  const gitPanelOverlay = $('#git-panel-overlay');
  const gitPanelResizer = $('#git-panel-resizer');
  const gitPanelBody = $('#git-panel-body');
  const gitPanelTitle = $('#git-panel-title');
  const gitBranch = $('#git-branch');
  const gitRefreshBtn = $('#git-refresh-btn');
  const gitCloseBtn = $('#git-close-btn');
  const workspaceTabs = Array.from(document.querySelectorAll('[data-workspace-tab]'));
  const attachmentTray = $('#attachment-tray');
  const imageUploadInput = $('#image-upload-input');
  const attachBtn = $('#attach-btn');
  const messagesDiv = $('#messages');
  const messagesWrap = messagesDiv.closest('.messages-wrap');
  const msgInput = $('#msg-input');
  const inputWrapper = msgInput.closest('.input-wrapper');
  const sendBtn = $('#send-btn');
  const abortBtn = $('#abort-btn');
  const cmdMenu = $('#cmd-menu');
  const modeSelect = $('#mode-select');
  const splitLayout = splitLayoutView.createSplitLayout({ app, sidebarResizer, rightResizer: gitPanelResizer });
  const desktopLayoutQuery = window.matchMedia('(min-width: 769px)');

  function requestGitStatus(options = {}) {
    if (!currentSessionId) {
      renderGitStatus({ available: false, files: [] });
      return;
    }
    if (options.showLoading !== false) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">正在读取变更...</div>';
    }
    send({ type: 'get_git_status', sessionId: currentSessionId });
  }

  const gitStatusPoller = createGenerationPoller(
    () => requestGitStatus({ showLoading: false }),
    GIT_STATUS_POLL_INTERVAL,
  );

  function startGitStatusPolling() {
    requestGitStatus({ showLoading: false });
    gitStatusPoller.start();
  }

  function stopGitStatusPolling(refresh = false) {
    const wasRunning = gitStatusPoller.isRunning();
    gitStatusPoller.stop();
    if (refresh && wasRunning) requestGitStatus({ showLoading: false });
  }

  function requestWorkspaceFiles(relativePath = currentWorkspacePath) {
    if (!currentSessionId) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">打开一个项目会话后浏览文件</div>';
      return;
    }
    gitPanelBody.innerHTML = '<div class="git-panel-empty">正在读取文件...</div>';
    send({ type: 'list_workspace_files', sessionId: currentSessionId, path: relativePath || '' });
  }

  function requestWorkspaceFile(filePath) {
    fileViewerSourceTab = workspaceTab;
    gitPanelBody.innerHTML = '<div class="git-panel-empty">正在读取文件...</div>';
    send({ type: 'read_workspace_file', sessionId: currentSessionId, path: filePath });
  }

  function requestWorkspaceDiff(file) {
    if (!currentSessionId || !file?.path) return;
    fileViewerSourceTab = 'changes';
    gitPanelBody.innerHTML = '<div class="git-panel-empty">正在读取差异...</div>';
    send({
      type: 'read_workspace_diff',
      sessionId: currentSessionId,
      path: file.path,
      originalPath: file.originalPath || '',
      status: file.status || 'modified',
    });
  }

  function resetGitHistoryState() {
    if (gitHistoryObserver) gitHistoryObserver.disconnect();
    gitHistoryObserver = null;
    gitHistoryState = {
      sessionId: currentSessionId,
      commits: [],
      nextOffset: 0,
      hasMore: true,
      loading: false,
      available: null,
      error: '',
      requestId: '',
    };
  }

  function requestGitHistory(reset = false) {
    if (!currentSessionId) {
      resetGitHistoryState();
      gitPanelBody.innerHTML = '<div class="git-panel-empty">打开一个项目会话后查看提交记录</div>';
      return;
    }
    if (reset || gitHistoryState.sessionId !== currentSessionId) {
      resetGitHistoryState();
      gitBranch.textContent = '';
    }
    if (gitHistoryState.loading || !gitHistoryState.hasMore) return;

    gitHistoryState.loading = true;
    gitHistoryState.requestId = `git-history-${++gitHistoryRequestSeq}`;
    renderGitHistory();
    send({
      type: 'get_git_history',
      sessionId: currentSessionId,
      offset: gitHistoryState.nextOffset,
      limit: 30,
      requestId: gitHistoryState.requestId,
    });
  }

  function formatFileSize(size) {
    if (!Number.isFinite(size)) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function setWorkspaceTab(tab) {
    workspaceTab = ['changes', 'files', 'history'].includes(tab) ? tab : 'changes';
    if (gitHistoryObserver) gitHistoryObserver.disconnect();
    gitHistoryObserver = null;
    workspaceTabs.forEach((button) => {
      const active = button.dataset.workspaceTab === workspaceTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    if (gitPanelTitle) {
      gitPanelTitle.textContent = workspaceTab === 'files'
        ? '工作区文件'
        : (workspaceTab === 'history' ? '提交记录' : 'Git 变更');
    }
    if (workspaceTab === 'files') requestWorkspaceFiles();
    else if (workspaceTab === 'history') requestGitHistory(true);
    else requestGitStatus();
  }

  function renderGitHistory() {
    if (gitHistoryObserver) gitHistoryObserver.disconnect();
    gitHistoryObserver = null;
    const previousScrollTop = gitPanelBody.scrollTop;
    gitPanelBody.innerHTML = '';

    if (!currentSessionId) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">打开一个项目会话后查看提交记录</div>';
      return;
    }
    if (gitHistoryState.available === false) {
      gitPanelBody.innerHTML = `<div class="git-panel-empty">${escapeHtml(gitHistoryState.error || '当前工作目录不是 Git 仓库，或暂时无法读取')}</div>`;
      return;
    }
    if (gitHistoryState.commits.length === 0 && gitHistoryState.loading) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">正在读取提交记录...</div>';
      return;
    }
    if (gitHistoryState.commits.length === 0) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">当前仓库还没有提交记录</div>';
      return;
    }

    const list = gitWorkspaceView.createHistoryList(document, gitHistoryState.commits, timeAgo);
    gitPanelBody.appendChild(list);
    gitPanelBody.scrollTop = previousScrollTop;

    if (!gitHistoryState.hasMore) return;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'git-history-more';
    more.disabled = gitHistoryState.loading;
    more.textContent = gitHistoryState.loading ? '正在加载...' : '加载更多';
    more.addEventListener('click', () => requestGitHistory(false));
    gitPanelBody.appendChild(more);

    if (!gitHistoryState.loading && typeof IntersectionObserver === 'function') {
      gitHistoryObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestGitHistory(false);
      }, { root: gitPanelBody, rootMargin: '160px 0px' });
      gitHistoryObserver.observe(more);
    }
  }

  function applyGitHistory(payload) {
    if (payload?.sessionId !== currentSessionId) return;
    if (payload.requestId !== gitHistoryState.requestId) return;
    gitHistoryState.loading = false;
    gitHistoryState.available = payload.available !== false;
    gitHistoryState.error = payload.error || '';
    if (payload.available !== false) {
      gitHistoryState.commits.push(...(Array.isArray(payload.commits) ? payload.commits : []));
      gitHistoryState.nextOffset = Number.isFinite(payload.nextOffset)
        ? payload.nextOffset
        : gitHistoryState.commits.length;
      gitHistoryState.hasMore = !!payload.hasMore;
      if (payload.branch) gitBranch.textContent = payload.branch;
    } else {
      gitHistoryState.hasMore = false;
    }
    if (workspaceTab === 'history') renderGitHistory();
  }

  function renderGitStatus(status) {
    const files = Array.isArray(status?.files) ? status.files : [];
    updateGitStatusHeader(status);
    gitPanelBody.innerHTML = '';

    if (!currentSessionId) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">打开一个项目会话后查看变更</div>';
      return;
    }
    if (!status?.available) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">当前工作目录不是 Git 仓库，或暂时无法读取</div>';
      return;
    }
    if (files.length === 0) {
      gitPanelBody.innerHTML = '<div class="git-panel-empty">工作区没有未提交的变更</div>';
      return;
    }

    const labels = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' };
    const list = document.createElement('div');
    list.className = 'git-change-list';
    files.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'git-change-item';
      item.title = `${file.code || ''} ${file.path || ''}`.trim();
      const badge = document.createElement('span');
      badge.className = `git-change-status ${file.status || 'modified'}`;
      badge.textContent = labels[file.status] || 'M';
      const pathNode = document.createElement('span');
      pathNode.className = 'git-change-path';
      const normalizedPath = String(file.path || '').replace(/\\/g, '/');
      const slashIndex = normalizedPath.lastIndexOf('/');
      if (slashIndex >= 0) {
        const dir = document.createElement('span');
        dir.className = 'git-change-dir';
        dir.textContent = normalizedPath.slice(0, slashIndex + 1);
        pathNode.appendChild(dir);
      }
      pathNode.append(document.createTextNode(normalizedPath.slice(slashIndex + 1)));
      item.append(badge, pathNode);
      const lines = document.createElement('span');
      lines.className = 'git-change-lines';
      if (Number.isFinite(file.additions) && file.additions > 0) {
        const additions = document.createElement('span');
        additions.className = 'git-change-additions';
        additions.textContent = `+${file.additions}`;
        lines.appendChild(additions);
      }
      if (Number.isFinite(file.deletions) && file.deletions > 0) {
        const deletions = document.createElement('span');
        deletions.className = 'git-change-deletions';
        deletions.textContent = `-${file.deletions}`;
        lines.appendChild(deletions);
      }
      item.appendChild(lines);
      item.addEventListener('click', () => requestWorkspaceDiff(file));
      list.appendChild(item);
    });
    gitPanelBody.appendChild(list);
  }

  function updateGitStatusHeader(status) {
    const files = Array.isArray(status?.files) ? status.files : [];
    gitChangesCount.textContent = String(files.length);
    gitChangesCount.hidden = files.length === 0;
    gitBranch.textContent = status?.branch || '';
  }

  function renderWorkspaceFiles(payload) {
    currentWorkspacePath = payload?.path || '';
    gitPanelBody.innerHTML = '';
    if (!payload?.available) {
      gitPanelBody.innerHTML = `<div class="git-panel-empty">${escapeHtml(payload?.error || '无法读取当前目录')}</div>`;
      return;
    }
    const toolbar = document.createElement('div');
    toolbar.className = 'workspace-browser-toolbar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'workspace-back-btn';
    back.title = '返回上级目录';
    back.textContent = '‹';
    back.disabled = !currentWorkspacePath;
    back.addEventListener('click', () => {
      const parts = currentWorkspacePath.split('/').filter(Boolean);
      parts.pop();
      requestWorkspaceFiles(parts.join('/'));
    });
    const pathLabel = document.createElement('span');
    pathLabel.className = 'workspace-path';
    pathLabel.textContent = currentWorkspacePath || '项目根目录';
    toolbar.append(back, pathLabel);
    gitPanelBody.appendChild(toolbar);

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (entries.length === 0) {
      gitPanelBody.insertAdjacentHTML('beforeend', '<div class="git-panel-empty">此文件夹为空</div>');
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'workspace-entry';
      row.title = entry.path;
      const icon = document.createElement('span');
      icon.className = 'workspace-entry-icon';
      icon.textContent = entry.directory ? '▸' : '·';
      const name = document.createElement('span');
      name.className = 'workspace-entry-name';
      name.textContent = entry.name;
      const size = document.createElement('span');
      size.className = 'workspace-entry-size';
      size.textContent = entry.directory ? '' : formatFileSize(entry.size);
      row.append(icon, name, size);
      row.addEventListener('click', () => {
        if (entry.directory) requestWorkspaceFiles(entry.path);
        else requestWorkspaceFile(entry.path);
      });
      gitPanelBody.appendChild(row);
    });
  }

  function renderWorkspaceFile(payload) {
    gitPanelBody.innerHTML = '';
    if (!payload?.available) {
      gitPanelBody.innerHTML = `<div class="git-panel-empty">${escapeHtml(payload?.error || '无法预览此文件')}</div>`;
      return;
    }
    const viewer = document.createElement('div');
    viewer.className = 'workspace-file-viewer';
    const toolbar = document.createElement('div');
    toolbar.className = 'workspace-browser-toolbar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'workspace-back-btn';
    back.title = '返回文件列表';
    back.textContent = '‹';
    back.addEventListener('click', () => {
      if (fileViewerSourceTab === 'changes') requestGitStatus();
      else requestWorkspaceFiles(currentWorkspacePath);
    });
    const pathLabel = document.createElement('span');
    pathLabel.className = 'workspace-path';
    pathLabel.textContent = payload.path;
    toolbar.append(back, pathLabel);
    const content = document.createElement('pre');
    content.className = 'workspace-file-content';
    content.textContent = payload.content || '';
    viewer.append(toolbar, content);
    gitPanelBody.appendChild(viewer);
  }

  function renderWorkspaceDiff(payload) {
    gitPanelBody.innerHTML = '';
    if (!payload?.available) {
      gitPanelBody.innerHTML = `<div class="git-panel-empty">${escapeHtml(payload?.error || '无法预览文件差异')}</div>`;
      return;
    }

    const viewer = document.createElement('div');
    viewer.className = 'workspace-file-viewer';
    const toolbar = document.createElement('div');
    toolbar.className = 'workspace-browser-toolbar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'workspace-back-btn';
    back.title = '返回 Git 变更';
    back.textContent = '‹';
    back.addEventListener('click', requestGitStatus);
    const pathLabel = document.createElement('span');
    pathLabel.className = 'workspace-path';
    pathLabel.textContent = payload.path || '';
    toolbar.append(back, pathLabel);
    viewer.appendChild(toolbar);

    const diffText = String(payload.diff || '');
    if (!diffText.trim()) {
      const empty = document.createElement('div');
      empty.className = 'git-panel-empty';
      empty.textContent = '此文件没有可展示的文本差异';
      viewer.appendChild(empty);
      gitPanelBody.appendChild(viewer);
      return;
    }

    viewer.appendChild(gitWorkspaceView.createDiffContent(document, diffText));
    gitPanelBody.appendChild(viewer);
  }

  function setGitPanelOpen(open, options = {}) {
    gitPanelOpen = !!open;
    gitPanel.hidden = !gitPanelOpen;
    gitPanelOverlay.hidden = !gitPanelOpen || desktopLayoutQuery.matches;
    splitLayout.setRightPanelOpen(gitPanelOpen);
    if (options.remember !== false) splitLayout.rememberRightPanelOpen(gitPanelOpen);
    gitChangesBtn.classList.toggle('active', gitPanelOpen);
    gitChangesBtn.setAttribute('aria-expanded', String(gitPanelOpen));
    if (gitPanelOpen) setWorkspaceTab(workspaceTab);
    else if (gitHistoryObserver) gitHistoryObserver.disconnect();
  }

  function restoreGitPanelOpenState() {
    setGitPanelOpen(splitLayout.getRememberedRightPanelOpen(true), { remember: false });
  }

  // --- Viewport height fix for mobile browsers ---
  function setVH() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  }
  setVH();
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 100));

  function buildWelcomeMarkup(agent) {
    const label = getAgentDefinition(agent)?.label || getAgentDefinition(DEFAULT_AGENT)?.label || 'Agent';
    return `<div class="welcome-msg"><div class="welcome-icon">✿</div><h3>欢迎使用 CC-Web</h3><p>开始与 ${label} 对话</p></div>`;
  }

  function normalizeAgent(agent) {
    return AGENT_MAP[String(agent || '').trim()] ? String(agent || '').trim() : DEFAULT_AGENT;
  }

  function getAgentAvatarHtml(agent) {
    const spec = getAgentDefinition(agent);
    if (spec?.avatar) {
      return `<img src="${escapeHtml(spec.avatar)}" width="24" height="24" style="display:block;" alt="${escapeHtml(spec.label || 'Agent')}">`;
    }
    return escapeHtml((spec?.label || 'A').slice(0, 1).toUpperCase());
  }

  function normalizeTheme(theme) {
    return THEME_OPTIONS.some((item) => item.value === theme) ? theme : 'washi';
  }

  function getThemeOption(theme) {
    return THEME_OPTIONS.find((item) => item.value === normalizeTheme(theme)) || THEME_OPTIONS[0];
  }

  function refreshThemeSummaries() {
    const label = getThemeOption(currentTheme).label;
    document.querySelectorAll('[data-theme-summary]').forEach((node) => {
      node.textContent = label;
    });
  }

  function applyTheme(theme) {
    currentTheme = normalizeTheme(theme);
    document.documentElement.dataset.theme = currentTheme;
    localStorage.setItem('cc-web-theme', currentTheme);
    refreshThemeSummaries();
  }

  function normalizeFont(font) {
    return FONT_OPTIONS.some((item) => item.value === font) ? font : 'system';
  }

  function getFontOption(font) {
    return FONT_OPTIONS.find((item) => item.value === normalizeFont(font)) || FONT_OPTIONS[0];
  }

  function refreshFontSummaries() {
    const label = getFontOption(currentFont).label;
    document.querySelectorAll('[data-font-summary]').forEach((node) => {
      node.textContent = label;
    });
  }

  function applyFont(font) {
    currentFont = normalizeFont(font);
    document.documentElement.dataset.font = currentFont;
    localStorage.setItem('cc-web-font', currentFont);
    refreshFontSummaries();
  }

  function buildThemePickerHtml(options = {}) {
    const { showSectionTitle = true } = options;
    return `
      ${showSectionTitle ? '<div class="settings-section-title">界面主题</div>' : ''}
      <div class="theme-grid">
        ${THEME_OPTIONS.map((theme) => `
          <button class="theme-card${theme.value === currentTheme ? ' active' : ''}" type="button" data-theme-value="${theme.value}">
            <div class="theme-card-preview">
              ${theme.swatches.map((color) => `<span class="theme-card-swatch" style="background:${color}"></span>`).join('')}
            </div>
            <div class="theme-card-title">${escapeHtml(theme.label)}</div>
            <div class="theme-card-desc">${escapeHtml(theme.desc)}</div>
          </button>
        `).join('')}
      </div>
    `;
  }

  function mountThemePicker(panel) {
    panel.querySelectorAll('[data-theme-value]').forEach((button) => {
      button.addEventListener('click', () => {
        applyTheme(button.dataset.themeValue);
        panel.querySelectorAll('[data-theme-value]').forEach((item) => {
          item.classList.toggle('active', item.dataset.themeValue === currentTheme);
        });
      });
    });
  }

  function buildFontPickerHtml() {
    return `
      <div class="font-grid">
        ${FONT_OPTIONS.map((font) => `
          <button class="font-card${font.value === currentFont ? ' active' : ''}" type="button" data-font-value="${font.value}">
            <span class="font-card-preview" data-font-preview="${font.value}">${escapeHtml(font.preview)}</span>
            <span class="font-card-copy">
              <span class="font-card-title">${escapeHtml(font.label)}</span>
              <span class="font-card-desc">${escapeHtml(font.desc)}</span>
            </span>
          </button>
        `).join('')}
      </div>
    `;
  }

  function mountFontPicker(panel) {
    panel.querySelectorAll('[data-font-value]').forEach((button) => {
      button.addEventListener('click', () => {
        applyFont(button.dataset.fontValue);
        panel.querySelectorAll('[data-font-value]').forEach((item) => {
          item.classList.toggle('active', item.dataset.fontValue === currentFont);
        });
      });
    });
  }

  function buildAppearanceEntryHtml() {
    return `
      <div class="settings-section-title">外观</div>
      <button class="settings-nav-card" type="button" data-open-theme-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">界面主题</span>
          <span class="settings-nav-card-meta">当前：<span data-theme-summary>${escapeHtml(getThemeOption(currentTheme).label)}</span></span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
      <button class="settings-nav-card" type="button" data-open-font-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">界面字体</span>
          <span class="settings-nav-card-meta">当前：<span data-font-summary>${escapeHtml(getFontOption(currentFont).label)}</span></span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function buildNotifyEntryHtml(config) {
    const provider = config?.provider || 'off';
    const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
    const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
    const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
    return `
      <div class="settings-section-title">通知</div>
      <button class="settings-nav-card" type="button" data-open-notify-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">通知设置</span>
          <span class="settings-nav-card-meta" data-notify-summary>${escapeHtml(meta)}</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function openNotifySubpage() {
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Notification</div>
          <h3>通知设置</h3>
        </div>
      </div>
      <div class="settings-field">
        <label>通知方式</label>
        <select class="settings-select" id="notify-provider">
          ${PROVIDER_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div id="notify-fields"></div>
      <div id="notify-summary-area"></div>
      <div class="settings-actions">
        <button class="btn-test" id="notify-test-btn">测试</button>
        <button class="btn-save" id="notify-save-btn">保存</button>
      </div>
      <div class="settings-status" id="notify-status"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const providerSelect = panel.querySelector('#notify-provider');
    const fieldsDiv = panel.querySelector('#notify-fields');
    const summaryArea = panel.querySelector('#notify-summary-area');
    const statusDiv = panel.querySelector('#notify-status');
    const testBtn = panel.querySelector('#notify-test-btn');
    const saveBtn = panel.querySelector('#notify-save-btn');

    let currentNotifyConfig = null;

    function renderFields(provider) {
      renderNotifyFields(fieldsDiv, currentNotifyConfig, provider);
      if (summaryArea) {
        summaryArea.innerHTML = buildSummarySettingsHtml(currentNotifyConfig);
        bindSummarySettingsEvents(panel);
      }
    }

    function collectConfig() {
      return collectNotifyConfigFromPanel(panel, currentNotifyConfig, providerSelect.value);
    }

    function showStatus(msg, type) {
      statusDiv.textContent = msg;
      statusDiv.className = 'settings-status ' + (type || '');
    }

    function refreshParentSummary(config) {
      const provider = config?.provider || 'off';
      const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
      const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
      const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
      document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
    }

    const savedOnNotifyConfig = _onNotifyConfig;
    _onNotifyConfig = (config) => {
      currentNotifyConfig = config;
      providerSelect.value = config.provider || 'off';
      renderFields(config.provider || 'off');
      if (savedOnNotifyConfig) savedOnNotifyConfig(config);
    };

    const savedOnNotifyTestResult = _onNotifyTestResult;
    _onNotifyTestResult = (msg) => {
      showStatus(msg.message, msg.success ? 'success' : 'error');
      if (savedOnNotifyTestResult) savedOnNotifyTestResult(msg);
    };

    providerSelect.addEventListener('change', () => renderFields(providerSelect.value));

    testBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      showStatus('正在发送测试消息...', '');
      send({ type: 'test_notify' });
    });

    saveBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      refreshParentSummary(config);
      showStatus('已保存', 'success');
    });

    const closeSubpage = () => {
      _onNotifyConfig = savedOnNotifyConfig;
      _onNotifyTestResult = savedOnNotifyTestResult;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubpage(); });
  }

  function openDevSettingsSubpage() {
    send({ type: 'get_dev_config' });
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.id = 'dev-settings-subpage';
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <div class="settings-header">
        <h3>开发者设置</h3>
        <button class="settings-close" id="dev-close">&times;</button>
      </div>
      <div class="settings-section-title">GitHub</div>
      <div class="settings-field">
        <label>Token</label>
        <input type="text" id="dev-github-token" placeholder="ghp_..." value="">
      </div>
      <div id="dev-github-repos"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-repo-add" style="padding:4px 12px">+ 添加仓库</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">SSH 主机</div>
      <div id="dev-ssh-hosts"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-host-add" style="padding:4px 12px">+ 添加主机</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-actions">
        <button class="btn-save" id="dev-save-btn">保存开发者配置</button>
      </div>
      <div class="settings-status" id="dev-status"></div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const closeBtn = panel.querySelector('#dev-close');
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    let editingRepos = [];
    let editingHosts = [];

    function renderRepos() {
      const container = panel.querySelector('#dev-github-repos');
      if (editingRepos.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无仓库</div>';
        return;
      }
      container.innerHTML = editingRepos.map((repo, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(repo.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-repo-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-repo-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(repo.url || '')} · ${escapeHtml(repo.branch || 'main')}${repo.notes ? ' · ' + escapeHtml(repo.notes) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-repo-edit]').forEach(btn => {
        btn.addEventListener('click', () => openRepoEditModal(parseInt(btn.dataset.repoEdit)));
      });
      container.querySelectorAll('[data-repo-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.repoDel);
          editingRepos.splice(idx, 1);
          renderRepos();
        });
      });
    }

    function openRepoEditModal(index = -1) {
      const existing = index >= 0 ? editingRepos[index] : null;
      const draft = existing || { id: '', name: '', url: '', branch: 'main', notes: '' };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑仓库' : '添加仓库'}</h3>
          <button class="settings-close" id="repo-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="repo-name" placeholder="cc-web" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>URL</label><input type="text" id="repo-url" placeholder="https://github.com/user/repo" value="${escapeHtml(draft.url)}"></div>
        <div class="settings-field"><label>分支</label><input type="text" id="repo-branch" placeholder="main" value="${escapeHtml(draft.branch || 'main')}"></div>
        <div class="settings-field"><label>备注</label><input type="text" id="repo-notes" placeholder="说明" value="${escapeHtml(draft.notes || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="repo-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#repo-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#repo-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#repo-name').value.trim();
        const url = modal.querySelector('#repo-url').value.trim();
        if (!name || !url) { alert('请填写名称和 URL'); return; }
        const data = {
          id: draft.id || '',
          name,
          url,
          branch: modal.querySelector('#repo-branch').value.trim() || 'main',
          notes: modal.querySelector('#repo-notes').value.trim(),
        };
        if (existing) {
          editingRepos[index] = data;
        } else {
          editingRepos.push(data);
        }
        closeModal();
        renderRepos();
      });
    }

    function renderHosts() {
      const container = panel.querySelector('#dev-ssh-hosts');
      if (editingHosts.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无 SSH 主机</div>';
        return;
      }
      container.innerHTML = editingHosts.map((host, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(host.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-host-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-host-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22} · ${(host.authType || 'key') === 'password' ? '密码认证' : '密钥认证'}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-host-edit]').forEach(btn => {
        btn.addEventListener('click', () => openHostEditModal(parseInt(btn.dataset.hostEdit)));
      });
      container.querySelectorAll('[data-host-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.hostDel);
          editingHosts.splice(idx, 1);
          renderHosts();
        });
      });
    }

    function openHostEditModal(index = -1) {
      const existing = index >= 0 ? editingHosts[index] : null;
      const draft = existing || { id: '', name: '', host: '', port: 22, user: '', authType: 'key', identityFile: '', password: '', description: '' };
      const isKey = (draft.authType || 'key') === 'key';
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑主机' : '添加主机'}</h3>
          <button class="settings-close" id="host-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="host-name" placeholder="主机01" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>地址</label><input type="text" id="host-host" placeholder="192.168.1.100" value="${escapeHtml(draft.host)}"></div>
        <div class="settings-field"><label>端口</label><input type="number" id="host-port" placeholder="22" value="${draft.port || 22}"></div>
        <div class="settings-field"><label>用户</label><input type="text" id="host-user" placeholder="root" value="${escapeHtml(draft.user)}"></div>
        <div class="settings-field">
          <label>认证方式</label>
          <div style="display:flex;gap:12px">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="key" ${isKey ? 'checked' : ''}> 密钥</label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="password" ${!isKey ? 'checked' : ''}> 密码</label>
          </div>
        </div>
        <div id="host-auth-key-field" class="settings-field" style="${isKey ? '' : 'display:none'}">
          <label>密钥路径</label><input type="text" id="host-identity" placeholder="~/.ssh/id_ed25519" value="${escapeHtml(draft.identityFile)}">
        </div>
        <div id="host-auth-pw-field" class="settings-field" style="${!isKey ? '' : 'display:none'}">
          <label>密码</label><input type="password" id="host-password" placeholder="SSH 登录密码" value="${escapeHtml(draft.password || '')}">
        </div>
        <div class="settings-field"><label>说明</label><input type="text" id="host-desc" placeholder="测试服务器" value="${escapeHtml(draft.description || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="host-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);

      // Toggle auth fields
      const keyField = modal.querySelector('#host-auth-key-field');
      const pwField = modal.querySelector('#host-auth-pw-field');
      modal.querySelectorAll('input[name="host-auth-type"]').forEach(radio => {
        radio.addEventListener('change', () => {
          const isKeyMode = radio.value === 'key' && radio.checked;
          keyField.style.display = isKeyMode ? '' : 'none';
          pwField.style.display = isKeyMode ? 'none' : '';
        });
      });

      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#host-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#host-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#host-name').value.trim();
        const host = modal.querySelector('#host-host').value.trim();
        if (!name || !host) { alert('请填写名称和地址'); return; }
        const authType = modal.querySelector('input[name="host-auth-type"]:checked')?.value || 'key';
        const data = {
          id: draft.id || '',
          name,
          host,
          port: parseInt(modal.querySelector('#host-port').value) || 22,
          user: modal.querySelector('#host-user').value.trim(),
          authType,
          identityFile: authType === 'key' ? modal.querySelector('#host-identity').value.trim() : '',
          password: authType === 'password' ? modal.querySelector('#host-password').value : '',
          description: modal.querySelector('#host-desc').value.trim(),
        };
        if (existing) {
          editingHosts[index] = data;
        } else {
          editingHosts.push(data);
        }
        closeModal();
        renderHosts();
      });
    }

    panel.querySelector('#dev-repo-add').addEventListener('click', () => openRepoEditModal());
    panel.querySelector('#dev-host-add').addEventListener('click', () => openHostEditModal());

    panel.querySelector('#dev-save-btn').addEventListener('click', () => {
      const token = panel.querySelector('#dev-github-token').value.trim();
      send({
        type: 'save_dev_config',
        config: {
          github: { token, repos: editingRepos },
          ssh: { hosts: editingHosts },
        },
      });
      panel.querySelector('#dev-status').textContent = '已保存';
      panel.querySelector('#dev-status').className = 'settings-status success';
    });

    _onDevConfig = (config) => {
      panel.querySelector('#dev-github-token').value = config.github?.token || '';
      editingRepos = (config.github?.repos || []).map(r => ({ ...r }));
      editingHosts = (config.ssh?.hosts || []).map(h => ({ ...h }));
      renderRepos();
      renderHosts();
    };
  }

  function openThemeSubpage() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Appearance</div>
          <h3>界面主题</h3>
        </div>
        <button class="settings-close" type="button" title="关闭">&times;</button>
      </div>
      ${buildThemePickerHtml({ showSectionTitle: false })}
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    mountThemePicker(panel);
    refreshThemeSummaries();

    const closeSubpage = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    panel.querySelector('.settings-close').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSubpage();
    });
  }

  function getAgentSessionStorageKey(agent) {
    return `cc-web-session-${normalizeAgent(agent)}`;
  }

  function getAgentModeStorageKey(agent) {
    return `cc-web-mode-${normalizeAgent(agent)}`;
  }

  function getLastSessionForAgent(agent) {
    return localStorage.getItem(getAgentSessionStorageKey(agent));
  }

  function setLastSessionForAgent(agent, sessionId) {
    localStorage.setItem(getAgentSessionStorageKey(agent), sessionId);
    localStorage.setItem('cc-web-session', sessionId);
  }

  function getSessionMeta(sessionId) {
    return sessions.find((s) => s.id === sessionId) || null;
  }

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function cloneMessages(messages) {
    return Array.isArray(messages) ? deepClone(messages) : [];
  }

  function estimateSessionMessageWeight(message) {
    const content = typeof message?.content === 'string' ? message.content.length : JSON.stringify(message?.content || '').length;
    const toolCalls = Array.isArray(message?.toolCalls) ? JSON.stringify(message.toolCalls).length : 0;
    const steps = Array.isArray(message?.steps) ? JSON.stringify(message.steps).length : 0;
    return content + toolCalls + steps + 64;
  }

  function estimateSessionSnapshotWeight(snapshot) {
    const base = JSON.stringify({
      title: snapshot.title || '',
      mode: snapshot.mode || '',
      model: snapshot.model || '',
      agent: snapshot.agent || '',
      cwd: snapshot.cwd || '',
      updated: snapshot.updated || '',
    }).length;
    return base + (snapshot.messages || []).reduce((sum, message) => sum + estimateSessionMessageWeight(message), 0);
  }

  function normalizeSessionSnapshot(payload, options = {}) {
    return {
      sessionId: payload.sessionId,
      messages: cloneMessages(payload.messages || []),
      title: payload.title || '新会话',
      mode: payload.mode || 'yolo',
      model: payload.model || '',
      aiProviderId: payload.aiProviderId || '',
      aiModelId: payload.aiModelId || '',
      reasoningEffort: payload.reasoningEffort || '',
      agent: normalizeAgent(payload.agent),
      hasUnread: !!payload.hasUnread,
      cwd: payload.cwd || null,
      projectId: payload.projectId || null,
      totalCost: typeof payload.totalCost === 'number' ? payload.totalCost : 0,
      totalUsage: payload.totalUsage ? deepClone(payload.totalUsage) : null,
      updated: payload.updated || null,
      isRunning: !!payload.isRunning,
      codebuddyProfile: payload.codebuddyProfile || '',
      historyPending: !!payload.historyPending,
      complete: options.complete !== undefined ? !!options.complete : !payload.historyPending,
    };
  }

  function touchSessionCache(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (entry) entry.lastUsed = Date.now();
  }

  function invalidateSessionCache(sessionId) {
    if (!sessionId) return;
    sessionCache.delete(sessionId);
  }

  function pruneSessionCache() {
    let totalWeight = 0;
    for (const entry of sessionCache.values()) totalWeight += entry.weight || 0;
    while (sessionCache.size > SESSION_CACHE_LIMIT || totalWeight > SESSION_CACHE_MAX_WEIGHT) {
      let oldestId = null;
      let oldestTs = Infinity;
      for (const [sessionId, entry] of sessionCache) {
        if ((entry.lastUsed || 0) < oldestTs) {
          oldestTs = entry.lastUsed || 0;
          oldestId = sessionId;
        }
      }
      if (!oldestId) break;
      totalWeight -= sessionCache.get(oldestId)?.weight || 0;
      sessionCache.delete(oldestId);
    }
  }

  function cacheSessionSnapshot(snapshot) {
    if (!snapshot?.sessionId || !snapshot.complete) return;
    const cachedSnapshot = deepClone(snapshot);
    const weight = estimateSessionSnapshotWeight(cachedSnapshot);
    if (weight > SESSION_CACHE_MAX_WEIGHT) {
      invalidateSessionCache(cachedSnapshot.sessionId);
      return;
    }
    const meta = getSessionMeta(cachedSnapshot.sessionId);
    sessionCache.set(cachedSnapshot.sessionId, {
      snapshot: cachedSnapshot,
      version: cachedSnapshot.updated || null,
      meta: meta ? deepClone(meta) : null,
      weight,
      lastUsed: Date.now(),
    });
    pruneSessionCache();
  }

  function updateCachedSession(sessionId, updater) {
    const entry = sessionCache.get(sessionId);
    if (!entry) return;
    const nextSnapshot = deepClone(entry.snapshot);
    updater(nextSnapshot);
    entry.snapshot = nextSnapshot;
    entry.weight = estimateSessionSnapshotWeight(nextSnapshot);
    entry.lastUsed = Date.now();
    if (nextSnapshot.updated) entry.version = nextSnapshot.updated;
    pruneSessionCache();
  }

  function reconcileSessionCacheWithSessions() {
    const knownIds = new Set(sessions.map((session) => session.id));
    for (const [sessionId, entry] of sessionCache) {
      if (!knownIds.has(sessionId)) {
        sessionCache.delete(sessionId);
        continue;
      }
      const meta = getSessionMeta(sessionId);
      entry.meta = meta ? deepClone(meta) : null;
    }
  }

  function getSessionCacheDisposition(sessionId) {
    const entry = sessionCache.get(sessionId);
    const meta = getSessionMeta(sessionId);
    if (!entry?.snapshot?.complete || !meta) return 'miss';
    if (entry.version === (meta.updated || null) && !meta.hasUnread && !meta.isRunning) {
      return 'strong';
    }
    return 'weak';
  }

  function buildCachedSessionSnapshot(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (!entry?.snapshot) return null;
    const snapshot = deepClone(entry.snapshot);
    const meta = getSessionMeta(sessionId) || entry.meta;
    if (meta) {
      snapshot.title = meta.title || snapshot.title;
      snapshot.agent = normalizeAgent(meta.agent || snapshot.agent);
      snapshot.hasUnread = !!meta.hasUnread;
      snapshot.updated = meta.updated || snapshot.updated;
      snapshot.isRunning = !!meta.isRunning;
    }
    return snapshot;
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  }

  function syncAttachmentActions() {
    const uploading = uploadingAttachments.length > 0;
    if (attachBtn) attachBtn.disabled = uploading;
  }

  function replaceFileExtension(filename, ext) {
    const base = String(filename || 'image').replace(/\.[^/.]+$/, '');
    return `${base}${ext}`;
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('读取图片失败'));
      };
      img.src = url;
    });
  }

  async function compressImageFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/i.test(file.type || '')) return file;
    const img = await loadImageFromFile(file);
    const maxDimension = 2000;
    const maxOriginalBytes = 2 * 1024 * 1024;
    const largestSide = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (file.size <= maxOriginalBytes && largestSide <= maxDimension) {
      return file;
    }

    const scale = Math.min(1, maxDimension / largestSide);
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    const targetType = 'image/webp';
    const qualities = [0.9, 0.84, 0.78, 0.72];
    let bestBlob = null;
    for (const quality of qualities) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, targetType, quality));
      if (!blob) continue;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= Math.max(maxOriginalBytes, file.size * 0.72)) break;
    }
    if (!bestBlob || bestBlob.size >= file.size) return file;
    return new File([bestBlob], replaceFileExtension(file.name || 'image', '.webp'), {
      type: bestBlob.type,
      lastModified: Date.now(),
    });
  }

  async function deleteUploadedAttachment(id) {
    if (!id) return;
    try {
      await ensureAuthenticatedWs();
      await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    } catch {}
  }

  function ensureAuthenticatedWs() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === 1 && authToken) {
        resolve(authToken);
        return;
      }
      const savedPassword = localStorage.getItem('cc-web-pw');
      if (!savedPassword) {
        reject(new Error('登录状态已失效，请刷新页面后重新登录再上传图片。'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('登录状态恢复超时，请刷新页面后重试。'));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        document.removeEventListener('cc-web-auth-restored', onRestored);
        document.removeEventListener('cc-web-auth-failed', onFailed);
      };
      const onRestored = () => {
        cleanup();
        resolve(authToken);
      };
      const onFailed = () => {
        cleanup();
        reject(new Error('登录状态已失效，请刷新页面后重新登录再上传图片。'));
      };
      document.addEventListener('cc-web-auth-restored', onRestored);
      document.addEventListener('cc-web-auth-failed', onFailed);

      if (!ws || ws.readyState > 1) {
        connect();
      } else if (ws.readyState === 1) {
        send({ type: 'auth', password: savedPassword });
      }
    });
  }

  function renderAttachmentLabels(attachments, options = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const labels = attachments.map((attachment) => {
      const stateSuffix = attachment.storageState === 'expired' ? '（已过期）' : '';
      const name = escapeHtml(attachment.filename || 'image');
      return `<span class="msg-attachment-label">图片: ${name}${stateSuffix}</span>`;
    }).join('');
    return `<div class="msg-attachments${options.compact ? ' compact' : ''}">${labels}</div>`;
  }

  function renderPendingAttachments() {
    if (!attachmentTray) return;
    if (!pendingAttachments.length && !uploadingAttachments.length) {
      attachmentTray.hidden = true;
      attachmentTray.innerHTML = '';
      syncAttachmentActions();
      return;
    }
    attachmentTray.hidden = false;
    const uploadingHtml = uploadingAttachments.map((attachment) => `
      <div class="attachment-chip uploading">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">上传中 · ${formatFileSize(attachment.size)}</span>
        </div>
      </div>
    `).join('');
    const readyHtml = pendingAttachments.map((attachment, index) => `
      <div class="attachment-chip" data-index="${index}">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">${formatFileSize(attachment.size)} · 将随下一条消息发送</span>
        </div>
        <button class="attachment-chip-remove" type="button" data-index="${index}" title="移除">✕</button>
      </div>
    `).join('');
    const noteHtml = [
      uploadingAttachments.length > 0
        ? '<div class="attachment-tray-note">图片上传中，此时发送不会包含尚未完成的图片。</div>'
        : '',
    ].join('');
    attachmentTray.innerHTML = `${uploadingHtml}${readyHtml}${noteHtml}`;
    attachmentTray.querySelectorAll('.attachment-chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = Number(btn.dataset.index);
        const [removed] = pendingAttachments.splice(index, 1);
        renderPendingAttachments();
        deleteUploadedAttachment(removed?.id);
      });
    });
    syncAttachmentActions();
  }

  async function uploadImageFile(file) {
    await ensureAuthenticatedWs();
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'image'),
    };
    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers,
      body: file,
    });
    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }
    if (response.status === 401) {
      throw new Error('登录状态已失效，请刷新页面后重新登录再上传图片。');
    }
    if (response.status === 413) {
      throw new Error('图片大小超过当前上传限制，请压缩到 10MB 以内后重试。');
    }
    if (!response.ok || !data?.ok) {
      throw new Error(data?.message || `上传失败 (${response.status})`);
    }
    return data.attachment;
  }

  async function handleSelectedImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && /^image\//.test(file.type || ''));
    if (!files.length) return;
    if (pendingAttachments.length + files.length > 4) {
      appendError('单条消息最多附带 4 张图片。');
      return;
    }
    const batch = files.map((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      filename: file.name || 'image',
      size: file.size || 0,
    }));
    uploadingAttachments.push(...batch);
    renderPendingAttachments();
    try {
      const results = await Promise.allSettled(files.map(async (file) => {
        const optimized = await compressImageFile(file);
        return uploadImageFile(optimized);
      }));
      const errors = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          pendingAttachments.push(result.value);
        } else {
          errors.push(result.reason?.message || '图片上传失败');
        }
      }
      if (errors.length > 0) {
        appendError(errors[0]);
      }
    } catch (err) {
      appendError(err.message || '图片上传失败');
    } finally {
      uploadingAttachments = uploadingAttachments.filter((item) => !batch.some((entry) => entry.id === item.id));
      renderPendingAttachments();
      if (imageUploadInput) imageUploadInput.value = '';
    }
  }

  function getVisibleSessions() {
    return sessions;
  }

  function syncSelectedSessionsWithVisible() {
    const visibleIds = new Set(getVisibleSessions().map((session) => session.id));
    selectedSessionIds = new Set(Array.from(selectedSessionIds).filter((id) => visibleIds.has(id)));
    if (isSessionMultiSelectMode && visibleIds.size === 0) {
      isSessionMultiSelectMode = false;
      selectedSessionIds.clear();
    }
  }

  function setSessionMultiSelectMode(enabled) {
    const nextEnabled = !!enabled && getVisibleSessions().length > 0;
    isSessionMultiSelectMode = nextEnabled;
    if (!nextEnabled) {
      selectedSessionIds.clear();
    } else {
      syncSelectedSessionsWithVisible();
    }
    updateSessionBulkActionBar();
    renderSessionList();
  }

  function updateSessionBulkActionBar() {
    if (!sessionMultiSelectBtn || !sessionClearBtn || !sessionSelectAllBtn || !sessionInvertSelectBtn) return;
    const visibleCount = getVisibleSessions().length;
    const selectedCount = selectedSessionIds.size;
    const allSelected = visibleCount > 0 && selectedCount === visibleCount;
    sessionMultiSelectBtn.classList.toggle('active', isSessionMultiSelectMode);
    sessionMultiSelectBtn.textContent = isSessionMultiSelectMode ? '取消多选' : '多选';
    sessionMultiSelectBtn.disabled = visibleCount === 0;
    sessionClearBtn.classList.toggle('danger', visibleCount > 0);
    if (isSessionMultiSelectMode) {
      sessionSelectAllBtn.hidden = false;
      sessionInvertSelectBtn.hidden = false;
      sessionSelectAllBtn.disabled = visibleCount === 0 || allSelected;
      sessionInvertSelectBtn.disabled = visibleCount === 0;
      sessionClearBtn.textContent = selectedCount > 0 ? `删除已选(${selectedCount})` : '删除已选';
      sessionClearBtn.disabled = selectedCount === 0;
    } else {
      sessionSelectAllBtn.hidden = true;
      sessionInvertSelectBtn.hidden = true;
      sessionSelectAllBtn.disabled = true;
      sessionInvertSelectBtn.disabled = true;
      sessionClearBtn.textContent = '清空';
      sessionClearBtn.disabled = visibleCount === 0;
    }
  }

  function selectAllVisibleSessions() {
    selectedSessionIds = new Set(getVisibleSessions().map((session) => session.id));
    updateSessionBulkActionBar();
    renderSessionList();
  }

  function invertVisibleSessionSelection() {
    const nextSelected = new Set();
    getVisibleSessions().forEach((session) => {
      if (!selectedSessionIds.has(session.id)) {
        nextSelected.add(session.id);
      }
    });
    selectedSessionIds = nextSelected;
    updateSessionBulkActionBar();
    renderSessionList();
  }

  function renderSessionAgentBadge(agent) {
    const normalized = normalizeAgent(agent);
    const label = getAgentDefinition(normalized)?.label || 'Agent';
    return `<span class="session-agent-badge agent-${escapeHtml(normalized)}">${escapeHtml(label)}</span>`;
  }

  function getPathLeaf(pathValue) {
    const raw = String(pathValue || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/[\\/]+$/, '');
    if (!normalized) return raw;
    const parts = normalized.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }

  function getProjectLocationKey(project) {
    const taskMode = project?.taskMode === 'remote' ? 'remote' : 'local';
    if (taskMode === 'remote') {
      const hostId = String(project?.sshHostId || '').trim();
      if (!hostId) return '';
      return `remote:${hostId}:${String(project?.remoteCwd || '').trim()}`;
    }
    const cwd = String(project?.cwd || '').trim().replace(/[\\/]+$/, '');
    if (!cwd) return '';
    const comparable = /^[a-zA-Z]:[\\/]/.test(cwd) ? cwd.toLowerCase() : cwd;
    return `local:${comparable}`;
  }

  function getProjectMeta(project) {
    const taskMode = project?.taskMode === 'remote' ? 'remote' : 'local';
    const cwd = taskMode === 'local' ? String(project?.cwd || '').trim() : '';
    const remoteCwd = taskMode === 'remote' ? String(project?.remoteCwd || '').trim() : '';
    const projectId = String(project?.id || '').trim();
    const title = taskMode === 'remote'
      ? `${project?.sshHostId || '远程主机'}${remoteCwd ? ` · ${remoteCwd}` : ' · SSH 默认目录'}`
      : cwd;
    return {
      key: `project:${projectId}`,
      projectId,
      title: title || '未设置项目位置',
      label: String(project?.name || '').trim() || getPathLeaf(remoteCwd || cwd) || '未命名项目',
      cwd,
      taskMode,
      sshHostId: String(project?.sshHostId || ''),
      remoteCwd,
      updated: project?.updated || project?.created || null,
    };
  }

  function getSessionProjectMeta(session) {
    const hasProjectId = Object.prototype.hasOwnProperty.call(session || {}, 'projectId');
    const projectId = String(session?.projectId || '').trim();
    if (projectId) {
      const project = projects.find((item) => item.id === projectId);
      if (project) return getProjectMeta(project);
    }
    if (hasProjectId) {
      return {
        key: UNGROUPED_PROJECT_KEY,
        projectId: null,
        title: '未绑定项目',
        label: '未绑定项目',
        cwd: '',
        taskMode: 'local',
        sshHostId: '',
        remoteCwd: '',
      };
    }

    const legacyProject = projects.find((project) => getProjectLocationKey(project) === getProjectLocationKey(session));
    if (legacyProject) return getProjectMeta(legacyProject);

    const remoteCwd = String(session?.remoteCwd || '').trim();
    if (remoteCwd) {
      return {
        key: `legacy:remote:${String(session?.sshHostId || '')}:${remoteCwd}`,
        projectId: null,
        title: remoteCwd,
        label: getPathLeaf(remoteCwd) || remoteCwd,
        cwd: remoteCwd,
        taskMode: 'remote',
        sshHostId: String(session?.sshHostId || ''),
        remoteCwd,
      };
    }
    const cwd = String(session?.cwd || '').trim();
    if (cwd) {
      return {
        key: `legacy:local:${cwd}`,
        projectId: null,
        title: cwd,
        label: getPathLeaf(cwd) || cwd,
        cwd,
        taskMode: 'local',
        sshHostId: '',
        remoteCwd: '',
      };
    }
    return {
      key: UNGROUPED_PROJECT_KEY,
      projectId: null,
      title: '未绑定项目地址',
      label: '未绑定项目',
      cwd: '',
      taskMode: 'local',
      sshHostId: '',
      remoteCwd: '',
    };
  }

  function groupSessionsByProject(list) {
    const groups = new Map();
    projects.forEach((project) => {
      const meta = getProjectMeta(project);
      groups.set(meta.key, { ...meta, sessions: [] });
    });
    for (const session of list) {
      const project = getSessionProjectMeta(session);
      if (!groups.has(project.key)) {
        groups.set(project.key, { ...project, sessions: [] });
      }
      groups.get(project.key).sessions.push(session);
    }
    return Array.from(groups.values()).sort((a, b) => {
      const aUpdated = Math.max(new Date(a.updated || 0).getTime() || 0, ...a.sessions.map((session) => new Date(session.updated || 0).getTime() || 0));
      const bUpdated = Math.max(new Date(b.updated || 0).getTime() || 0, ...b.sessions.map((session) => new Date(session.updated || 0).getTime() || 0));
      return bUpdated - aUpdated;
    });
  }

  function toggleProjectGroup(key) {
    if (collapsedProjectKeys.has(key)) collapsedProjectKeys.delete(key);
    else collapsedProjectKeys.add(key);
    saveCollapsedProjectKeys(collapsedProjectKeys);
    renderSessionList();
  }

  function showMoreProjectSessions(projectKey, totalCount) {
    const currentLimit = projectSessionDisplayLimits.get(projectKey) || INITIAL_PROJECT_SESSION_COUNT;
    projectSessionDisplayLimits.set(
      projectKey,
      getNextDisplayLimit(currentLimit, totalCount, PROJECT_SESSION_LOAD_MORE_COUNT),
    );
    renderSessionList();
  }

  function clearProjectSessions(project) {
    const projectSessions = Array.isArray(project?.sessions) ? project.sessions : [];
    if (projectSessions.length === 0) return;
    deleteSessionsBatch(projectSessions, {
      message: `确认清空项目“${project.label}”中的 ${projectSessions.length} 个对话？只会删除对话，不会删除项目目录。`,
      confirmLabel: '确认清空',
    });
  }

  function showCurrentProjectNewSessionModal() {
    const currentSession = currentSessionId ? getSessionMeta(currentSessionId) : null;
    if (!currentSession) {
      showToast('请先打开一个项目，或选择“新项目”');
      return;
    }
    const project = getSessionProjectMeta(currentSession);
    if (project.key === UNGROUPED_PROJECT_KEY) {
      showToast('当前对话未绑定项目，请选择“新项目”');
      return;
    }
    showProjectNewSessionModal(project);
  }

  function showProjectNewSessionModal(project) {
    if (!project || project.key === UNGROUPED_PROJECT_KEY || (!project.cwd && !project.remoteCwd)) {
      appendError('这个分组没有项目地址，不能直接新建项目会话。');
      return;
    }
    const agentOrder = ['codex', 'opencode', 'codebuddy', 'kimi', 'claude'];
    const orderedAgents = AGENT_CATALOG.slice().sort((a, b) => {
      const aIndex = agentOrder.indexOf(a.id);
      const bIndex = agentOrder.indexOf(b.id);
      return (aIndex < 0 ? agentOrder.length : aIndex) - (bIndex < 0 ? agentOrder.length : bIndex);
    });
    const labelForAgent = (agentId) => agentId === 'claude'
      ? 'Claude Code'
      : (getAgentDefinition(agentId)?.label || 'Agent');
    let selectedAgent = normalizeAgent(currentAgent);
    let selectedCodebuddyProfile = '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'project-new-session-overlay';
    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">在项目中新建会话</span>
          <button class="modal-close-btn" id="pns-close-btn">✕</button>
        </div>
        <div class="modal-body">
          <div class="agent-context-card" style="margin-bottom:12px">
            <div class="agent-context-kicker">${project.taskMode === 'remote' ? '远程项目' : '本地项目'}</div>
            <div class="agent-context-title">${escapeHtml(project.label)}</div>
            <div class="agent-context-copy">${escapeHtml(project.title)}</div>
          </div>
          <div>
            <div class="modal-field-label" style="margin-bottom:6px">选择 Agent</div>
            <div class="ns-agent-grid" id="pns-agent-grid">
              ${orderedAgents.map((agent) => {
                const label = labelForAgent(agent.id);
                return `
                  <button
                    type="button"
                    class="ns-agent-card${agent.id === selectedAgent ? ' active' : ''}"
                    data-pns-agent="${escapeHtml(agent.id)}"
                    aria-pressed="${agent.id === selectedAgent ? 'true' : 'false'}"
                  >
                    <span class="ns-agent-card-kicker">Agent</span>
                    <span class="ns-agent-card-label">${escapeHtml(label)}</span>
                    <span class="ns-agent-card-desc">用于当前项目的新会话</span>
                  </button>
                `;
              }).join('')}
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn-secondary" id="pns-cancel-btn">取消</button>
          <button class="modal-btn-primary" id="pns-create-btn">创建</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function syncSelectedCodebuddyProfile() {
      if (selectedAgent !== 'codebuddy') {
        selectedCodebuddyProfile = '';
        return;
      }
      if ((codebuddyConfigCache?.mode || 'local') !== 'custom') {
        selectedCodebuddyProfile = '';
        return;
      }
      selectedCodebuddyProfile = String(codebuddyConfigCache?.activeProfile || '').trim();
    }

    function refreshAgentCards() {
      overlay.querySelectorAll('[data-pns-agent]').forEach((button) => {
        const active = normalizeAgent(button.dataset.pnsAgent) === selectedAgent;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    syncSelectedCodebuddyProfile();
    overlay.querySelectorAll('[data-pns-agent]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedAgent = normalizeAgent(button.dataset.pnsAgent);
        syncSelectedCodebuddyProfile();
        refreshAgentCards();
      });
    });

    const close = () => overlay.remove();
    overlay.querySelector('#pns-close-btn').addEventListener('click', close);
    overlay.querySelector('#pns-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#pns-create-btn').addEventListener('click', () => {
      close();
      if (project.taskMode === 'remote') {
        send({
          type: 'new_session',
          agent: selectedAgent,
          mode: localStorage.getItem(getAgentModeStorageKey(selectedAgent)) || 'yolo',
          taskMode: 'remote',
          projectId: project.projectId || null,
          sshHostId: project.sshHostId,
          remoteCwd: project.remoteCwd,
          codebuddyProfile: selectedAgent === 'codebuddy' ? selectedCodebuddyProfile : '',
        });
      } else {
        saveRecentCwd(project.cwd);
        send({
          type: 'new_session',
          cwd: project.cwd,
          projectId: project.projectId || null,
          agent: selectedAgent,
          mode: localStorage.getItem(getAgentModeStorageKey(selectedAgent)) || 'yolo',
          taskMode: 'local',
          codebuddyProfile: selectedAgent === 'codebuddy' ? selectedCodebuddyProfile : '',
        });
      }
    });
  }

  function updateChatHeaderMeta() {
    const showCodebuddyProfile = currentAgent === 'codebuddy' && !!currentCodebuddyProfile;
    if (chatCodebuddyProfile) {
      chatCodebuddyProfile.textContent = showCodebuddyProfile ? currentCodebuddyProfile : '';
      chatCodebuddyProfile.title = showCodebuddyProfile ? `CodeBuddy Profile: ${currentCodebuddyProfile}` : '';
      chatCodebuddyProfile.hidden = !showCodebuddyProfile;
    }
    if (chatHeaderMeta) chatHeaderMeta.hidden = !showCodebuddyProfile;
    if (chatRuntimeState) chatRuntimeState.hidden = !currentSessionRunning;
  }

  function setCurrentSessionRunningState(isRunning) {
    const running = !!isRunning;
    currentSessionRunning = running;
    if (chatRuntimeState) {
      chatRuntimeState.hidden = !running;
      chatRuntimeState.textContent = running ? '运行中' : '';
    }
    updateChatHeaderMeta();
  }

  function getCurrentCodexModelState() {
    const modelControl = getAgentModelControl(currentAgent);
    const parsed = _splitCodexThinkingModel(currentModel || '');
    const fallback = modelControl?.baseOptions?.[0]?.value || 'gpt-5.4';
    return {
      base: _isCodexModelAtLeast52(parsed.base) ? parsed.base : fallback,
      level: parsed.level || 'medium',
    };
  }

  function getCodexBaseModelLabel(baseModel) {
    const modelControl = getAgentModelControl(currentAgent);
    const base = String(baseModel || '').trim();
    if (!base) return 'Codex 模型';
    const preset = (modelControl?.baseOptions || []).find((opt) => opt.value === base);
    return preset?.label || base;
  }

  function getThinkingLevelLabel(level) {
    const normalized = String(level || '').trim().toLowerCase();
    const option = (getAgentModelControl(currentAgent)?.thinkingOptions || []).find((item) => item.value === normalized);
    return option?.label || normalized || '中';
  }

  function normalizeTokenCount(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
  }

  function formatTokenCount(value) {
    const num = normalizeTokenCount(value);
    if (num >= 1_000_000) {
      const compact = (num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1).replace(/\.0$/, '');
      return `${compact}M`;
    }
    if (num >= 1_000) {
      const compact = (num / 1_000).toFixed(num >= 10_000 ? 0 : 1).replace(/\.0$/, '');
      return `${compact}k`;
    }
    return `${num}`;
  }

  function getCacheRate(usage) {
    const inputTokens = normalizeTokenCount(usage?.inputTokens);
    const cachedInputTokens = normalizeTokenCount(usage?.cachedInputTokens);
    if (!inputTokens) return 0;
    return Math.min((cachedInputTokens / inputTokens) * 100, 100);
  }

  function formatTokenUsageDisplay(usage) {
    const inputTokens = normalizeTokenCount(usage?.inputTokens);
    const cachedInputTokens = normalizeTokenCount(usage?.cachedInputTokens);
    const outputTokens = normalizeTokenCount(usage?.outputTokens);
    if (!inputTokens && !cachedInputTokens && !outputTokens) return '';
    const summary = getTurnSummary(currentSessionMessages);
    const sections = [];
    if (summary.turns > 0) sections.push(`${summary.turns} 轮 · ${summary.steps} 步`);
    if (summary.llmDurationMs > 0 || summary.toolDurationMs > 0) {
      sections.push(`LLM ${formatStatsDuration(summary.llmDurationMs)} · 工具调用 ${formatStatsDuration(summary.toolDurationMs)}`);
    }
    if (summary.firstTokenCount > 0 || summary.tokenRate > 0) {
      const parts = [];
      if (summary.firstTokenCount > 0) parts.push(`首 token 平均 ${formatStatsDuration(summary.firstTokenTotalMs / summary.firstTokenCount)}`);
      if (summary.tokenRate > 0) parts.push(`${formatTokenRate(summary.tokenRate)} tok/s`);
      sections.push(parts.join(' · '));
    }
    sections.push(`缓存命中 ${formatCacheRate(usage)}%`);
    sections.push(`输入 ${formatStatsTokenCount(inputTokens)} tok · 输出 ${formatStatsTokenCount(outputTokens)} tok`);
    return sections.join(' | ');
  }

  function setTokenUsageDisplay(usage) {
    currentSessionUsage = usage ? deepClone(usage) : null;
    const text = formatTokenUsageDisplay(usage);
    costDisplay.textContent = text;
    costDisplay.hidden = !text;
    costDisplay.removeAttribute('title');
    costDisplay.removeAttribute('aria-label');
  }

  function formatStatsTokenCount(value) {
    const num = normalizeTokenCount(value);
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
    return `${num}`;
  }

  function formatStatsDuration(value) {
    const seconds = Math.max(0, Number(value) || 0) / 1000;
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1).replace(/\.0$/, '')}s`;
  }

  function formatTokenRate(value) {
    const rate = Math.max(0, Number(value) || 0);
    return rate.toFixed(rate >= 10 ? 0 : 1).replace(/\.0$/, '');
  }

  function formatCacheRate(usage) {
    return getCacheRate(usage).toFixed(1).replace(/\.0$/, '');
  }

  function getTurnSummary(messages) {
    const summary = { turns: 0, steps: 0, llmDurationMs: 0, toolDurationMs: 0, firstTokenTotalMs: 0, firstTokenCount: 0, outputTokens: 0, tokenRate: 0 };
    for (const message of messages || []) {
      if (message?.role !== 'assistant') continue;
      summary.turns += 1;
      summary.steps += getAssistantMessageSteps(message).length;
      const stats = message.turnStats;
      if (!stats || typeof stats !== 'object') continue;
      summary.llmDurationMs += Math.max(0, Number(stats.llmDurationMs) || 0);
      summary.toolDurationMs += Math.max(0, Number(stats.toolDurationMs) || 0);
      summary.outputTokens += normalizeTokenCount(stats.outputTokens);
      if (Number.isFinite(Number(stats.firstTokenMs))) {
        summary.firstTokenTotalMs += Math.max(0, Number(stats.firstTokenMs));
        summary.firstTokenCount += 1;
      }
    }
    if (summary.llmDurationMs > 0 && summary.outputTokens > 0) {
      summary.tokenRate = summary.outputTokens * 1000 / summary.llmDurationMs;
    }
    return summary;
  }

  function refreshTokenUsageDisplay() {
    setTokenUsageDisplay(currentSessionUsage);
  }

  function extractTextFromContentNode(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(extractTextFromContentNode).join('\n');
    if (!content || typeof content !== 'object') return '';
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return content.content.map(extractTextFromContentNode).join('\n');
    return '';
  }

  function estimateMessageContextTokens(message) {
    if (!message || typeof message !== 'object') return 0;
    if (message.role === 'system') return 0;
    let chars = 0;
    const hasCanonicalSteps = message.role === 'assistant' && Array.isArray(message.steps) && message.steps.length > 0;
    if (!hasCanonicalSteps) chars += extractTextFromContentNode(message.content).length;
    if (hasCanonicalSteps) {
      for (const step of message.steps) {
        if (!step || typeof step !== 'object') continue;
        chars += extractTextFromContentNode(step.content).length;
        if (step.result !== undefined) chars += JSON.stringify(step.result).length;
        if (step.input !== undefined) chars += JSON.stringify(step.input).length;
      }
    }
    if (!hasCanonicalSteps && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        if (!toolCall || typeof toolCall !== 'object') continue;
        chars += JSON.stringify(toolCall).length;
      }
    }
    if (Array.isArray(message.attachments)) {
      chars += message.attachments.length * 120;
    }
    if (message.role === 'assistant') chars += 80;
    if (message.role === 'user') chars += 48;
    return Math.max(1, Math.ceil(chars / 4));
  }

  function estimateMessagesContextTokens(messages) {
    return (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + estimateMessageContextTokens(message), 0);
  }

  function estimateActiveDraftContextTokens() {
    if (!isGenerating) return 0;
    let chars = String(pendingText || '').length;
    for (const toolCall of activeToolCalls.values()) {
      try {
        chars += JSON.stringify(toolCall || {}).length;
      } catch {
        chars += 0;
      }
    }
    return chars > 0 ? Math.ceil(chars / 4) : 0;
  }

  function getActiveKimiProfile() {
    const config = kimiConfigCache;
    if (!config || config.mode !== 'custom') return null;
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const active = String(config.activeProfile || '').trim();
    return profiles.find((profile) => profile && profile.name === active) || null;
  }

  function resolveCustomKimiModelContext(modelName) {
    const profile = getActiveKimiProfile();
    if (!profile) return 0;
    const models = Array.isArray(profile.models) ? profile.models : [];
    const match = models.find((item) => item && (item.name === modelName || item.model === modelName));
    return normalizeTokenCount(match?.maxContextSize);
  }

  function resolveDynamicModelContext(agent, modelName) {
    const normalizedAgent = normalizeAgent(agent);
    const value = String(modelName || '').trim();
    if (!value) return 0;

    if (normalizedAgent === 'kimi') {
      const customContext = resolveCustomKimiModelContext(value);
      if (customContext > 0) return customContext;
    }

    const models = agentModelOptionsCache.get(normalizedAgent);
    if (!Array.isArray(models)) return 0;
    const match = models.find((item) => {
      if (!item) return false;
      if (typeof item === 'string') return item === value;
      return item.id === value || item.model === value || item.value === value || item.name === value;
    });
    return normalizeTokenCount(match?.maxContextSize || match?.max_context_size);
  }

  function resolveClaudeContextLimit(modelName) {
    const value = String(modelName || '').trim().toLowerCase();
    if (!value) return 0;
    if (value === 'opus' || value === 'sonnet') return 1_000_000;
    if (value.includes('[1m]')) return 1_000_000;
    if (value.includes('opus') || value.includes('sonnet')) return 1_000_000;
    if (value === 'haiku' || value.includes('haiku')) return 262144;
    return 0;
  }

  function resolveCodexContextLimit(modelName) {
    const value = String(modelName || '').trim();
    if (!value) return 0;
    const base = _splitCodexThinkingModel(value).base || value;
    const profiles = Array.isArray(codexConfigCache?.profiles) ? codexConfigCache.profiles : [];
    const localContext = profiles
      .map((profile) => normalizeTokenCount(profile?.maxContextSize))
      .find((limit) => limit > 0);
    if (localContext > 0) return localContext;
    if (/^gpt-5\./i.test(base)) return 262144;
    return 0;
  }

  function resolveKimiContextLimit(modelName) {
    const dynamic = resolveDynamicModelContext('kimi', modelName);
    if (dynamic > 0) return dynamic;
    return 0;
  }

  function resolveCurrentContextLimit() {
    const modelName = String(currentModel || '').trim();
    if (!modelName) return 0;
    if (currentAgent === 'claude') return resolveClaudeContextLimit(modelName);
    if (currentAgent === 'codex') return resolveCodexContextLimit(modelName);
    if (currentAgent === 'kimi') return resolveKimiContextLimit(modelName);
    if (currentAgent === 'codebuddy' || currentAgent === 'opencode') {
      return resolveDynamicModelContext(currentAgent, modelName);
    }
    return 0;
  }

  function updateContextUsageDisplay() {
    if (!chatContextRow || !chatContextText || !chatContextProgressBar || !chatContextLabel) return;
    const fallbackTokens = estimateMessagesContextTokens(currentSessionMessages);
    let estimatedTokens = currentContextTokens > 0 ? currentContextTokens : fallbackTokens;
    if (isGenerating && !generationUsageResolved) {
      const lastMessage = currentSessionMessages[currentSessionMessages.length - 1];
      const pendingUserTokens = lastMessage?.role === 'user' ? estimateMessageContextTokens(lastMessage) : 0;
      estimatedTokens += pendingUserTokens + estimateActiveDraftContextTokens();
    }
    const contextLimit = resolveCurrentContextLimit();

    if (!currentSessionId || (!estimatedTokens && !contextLimit)) {
      chatContextRow.hidden = true;
      chatContextText.textContent = '';
      chatContextRow.removeAttribute('data-tip-title');
      chatContextRow.removeAttribute('data-tip-body');
      chatContextRow.style.setProperty('--context-progress', '0%');
      chatContextRow.classList.remove('is-warn', 'is-danger');
      updateChatHeaderMeta();
      return;
    }

    chatContextRow.hidden = false;
    chatContextLabel.textContent = '上下文占用估算';

    if (contextLimit > 0) {
      const ratio = Math.min(estimatedTokens / contextLimit, 1);
      const percent = Math.min(ratio * 100, 100);
      chatContextText.textContent = `${formatTokenCount(estimatedTokens)} / ${formatTokenCount(contextLimit)} tokens (${percent.toFixed(percent >= 10 ? 0 : 1)}%)`;
      chatContextRow.title = `上下文占用估算: ${chatContextText.textContent}`;
      chatContextRow.setAttribute('aria-label', chatContextRow.title);
      chatContextRow.dataset.tipTitle = '上下文占用估算';
      chatContextRow.dataset.tipBody = `当前估算：${formatTokenCount(estimatedTokens)} tokens\n最大上下文：${formatTokenCount(contextLimit)} tokens\n占用比例：${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
      chatContextRow.style.setProperty('--context-progress', `${percent}%`);
      chatContextRow.classList.toggle('is-warn', ratio >= 0.7 && ratio < 0.9);
      chatContextRow.classList.toggle('is-danger', ratio >= 0.9);
      updateChatHeaderMeta();
      return;
    }

    chatContextText.textContent = `${formatTokenCount(estimatedTokens)} tokens`;
    chatContextRow.title = `上下文占用估算: ${chatContextText.textContent}`;
    chatContextRow.setAttribute('aria-label', chatContextRow.title);
    chatContextRow.dataset.tipTitle = '上下文占用估算';
    chatContextRow.dataset.tipBody = `当前估算：${formatTokenCount(estimatedTokens)} tokens\n当前模型未获取到最大上下文，暂不显示百分比。`;
    chatContextRow.style.setProperty('--context-progress', '0%');
    chatContextRow.classList.remove('is-warn', 'is-danger');
    updateChatHeaderMeta();
  }

  function normalizeDynamicModelOption(model, modelControl, fallbackDesc) {
    const sourceLabel = modelControl?.sourceLabel || '可用模型';
    if (model && typeof model === 'object' && !Array.isArray(model)) {
      const value = String(model.id || model.model || model.value || '').trim();
      if (!value) return null;
      const label = String(model.label || model.name || value).trim() || value;
      const credits = String(model.credits || '').trim();
      const parts = [];
      if (label !== value) parts.push(value);
      if (credits) parts.push(credits);
      return {
        value,
        label,
        desc: parts.join(' · ') || fallbackDesc || sourceLabel,
      };
    }

    const value = String(model || '').trim();
    if (!value) return null;
    return {
      value,
      label: value,
      desc: fallbackDesc || sourceLabel,
    };
  }

  function buildDynamicModelOptions(agent, modelControl, remoteModels) {
    const items = [];
    const itemMap = new Map();
    const normalizedAgent = normalizeAgent(agent);

    function upsertOption(model, fallbackDesc, preferMeta = false) {
      const next = normalizeDynamicModelOption(model, modelControl, fallbackDesc);
      if (!next) return;

      const existing = itemMap.get(next.value);
      if (existing) {
        if (preferMeta) {
          if (next.label) existing.label = next.label;
          if (next.desc) existing.desc = next.desc;
        }
        return;
      }

      const entry = {
        value: next.value,
        label: next.label,
        desc: next.desc,
        group: '',
      };
      if (normalizedAgent === 'opencode') {
        const separatorIndex = entry.value.indexOf('/');
        if (separatorIndex > 0 && separatorIndex < entry.value.length - 1) {
          entry.group = entry.value.slice(0, separatorIndex);
          if (entry.label === entry.value) entry.label = entry.value.slice(separatorIndex + 1);
        } else {
          entry.group = '其他';
        }
      }
      items.push(entry);
      itemMap.set(entry.value, entry);
    }

    upsertOption(currentModel, '当前会话模型');

    sessions
      .filter((session) => normalizeAgent(session.agent) === normalizedAgent)
      .slice()
      .sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime())
      .forEach((session) => {
        upsertOption(session.model, session.id === currentSessionId ? '当前会话已保存模型' : '最近会话');
      });

    (remoteModels || []).forEach((model) => {
      upsertOption(model, modelControl?.sourceLabel || '可用模型', true);
    });

    if (normalizedAgent === 'opencode') {
      items.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
    }
    return items;
  }

  function requestAgentModels(agent) {
    const normalizedAgent = normalizeAgent(agent);
    const requestId = `agent-models-${normalizedAgent}-${Date.now()}-${++agentModelRequestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingAgentModelRequests.has(requestId)) return;
        pendingAgentModelRequests.delete(requestId);
        resolve({
          agent: normalizedAgent,
          requestId,
          success: false,
          models: [],
          message: '加载模型列表超时，请重试',
        });
      }, 50000);

      pendingAgentModelRequests.set(requestId, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      send({ type: 'list_agent_models', agent: normalizedAgent, requestId });
    });
  }

  async function showDynamicModelPicker() {
    const requestedAgent = normalizeAgent(currentAgent);
    const requestedSessionId = currentSessionId;
    const modelControl = getAgentModelControl(requestedAgent);
    if (modelControl?.kind !== 'dynamic' || !requestedSessionId) return;

    hideOptionPicker();

    let models = agentModelOptionsCache.get(requestedAgent);
    if (!Array.isArray(models) || models.length === 0) {
      modelPickerBtn.disabled = true;
      modelPickerBtn.textContent = '加载中...';
      const result = await requestAgentModels(requestedAgent);
      updateModelControls();
      if (requestedAgent !== currentAgent || requestedSessionId !== currentSessionId) return;
      if (!result?.success) {
        showToast(result?.message || '加载模型列表失败');
        return;
      }
      models = Array.isArray(result.models) ? result.models : [];
      agentModelOptionsCache.set(requestedAgent, models);
    }

    const options = buildDynamicModelOptions(requestedAgent, modelControl, models);
    if (options.length === 0) {
      showToast(modelControl.emptyText || '未获取到可选模型');
      return;
    }

    showOptionPicker(modelControl.title || '选择模型', options, currentModel, (value) => {
      send({ type: 'message', text: `/model ${value}`, sessionId: requestedSessionId, mode: currentMode, agent: requestedAgent });
    });
  }

  function openFontSubpage() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Typography</div>
          <h3>界面字体</h3>
        </div>
        <button class="settings-close" type="button" title="关闭">&times;</button>
      </div>
      ${buildFontPickerHtml()}
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    mountFontPicker(panel);
    refreshFontSummaries();

    const closeSubpage = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    panel.querySelector('.settings-close').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSubpage();
    });
  }

  function formatModelDisplayName(modelName, agent = currentAgent) {
    let value = String(modelName || '').trim().replace(/^\*{1,2}|\*{1,2}$/g, '');
    if (normalizeAgent(agent) === 'opencode') {
      const separatorIndex = value.indexOf('/');
      if (separatorIndex >= 0 && separatorIndex < value.length - 1) {
        value = value.slice(separatorIndex + 1);
      }
    }
    return value;
  }

  function updateModelControls() {
    if (!modelPickerBtn || !thinkingPickerBtn) return;
    const hasSession = !!currentSessionId;
    const agentSpec = getAgentDefinition(currentAgent);
    const modelControl = agentSpec?.modelControl || null;

    if (currentAgent === 'claude' || currentAgent === 'codex') {
      const separator = String(currentModel || '').indexOf('/');
      const providerId = separator > 0 ? currentModel.slice(0, separator) : '';
      const modelId = separator > 0 ? currentModel.slice(separator + 1) : currentModel;
      const provider = (aiConfigCache?.providers || []).find((item) => item.id === providerId && item.agent === currentAgent);
      const model = provider?.models?.find((item) => item.id === modelId);
      modelPickerBtn.hidden = false;
      modelPickerBtn.disabled = !hasSession;
      modelPickerBtn.textContent = model ? `${provider.name} · ${model.label || model.id}` : (currentModel || '选择模型');
      modelPickerBtn.title = hasSession ? `当前模型: ${currentModel || '未选择'}` : '请先打开或创建一个会话';
      if (currentAgent === 'codex') {
        const effort = getSessionMeta(currentSessionId)?.reasoningEffort || 'medium';
        thinkingPickerBtn.hidden = false;
        thinkingPickerBtn.disabled = !hasSession;
        thinkingPickerBtn.textContent = effort;
      } else {
        thinkingPickerBtn.hidden = true;
        thinkingPickerBtn.disabled = true;
      }
      updateContextUsageDisplay();
      return;
    }

    if (!modelControl) {
      modelPickerBtn.hidden = true;
      modelPickerBtn.disabled = true;
      thinkingPickerBtn.hidden = true;
      thinkingPickerBtn.disabled = true;
      updateContextUsageDisplay();
      return;
    }

    if (modelControl?.kind === 'reasoning') {
      const codexState = getCurrentCodexModelState();
      modelPickerBtn.hidden = false;
      modelPickerBtn.disabled = !hasSession;
      modelPickerBtn.textContent = getCodexBaseModelLabel(codexState.base);
      modelPickerBtn.title = hasSession
        ? `当前 ${agentSpec.label} 模型: ${codexState.base}`
        : `请先打开或创建一个 ${agentSpec.label} 会话`;

      thinkingPickerBtn.hidden = false;
      thinkingPickerBtn.disabled = !hasSession;
      thinkingPickerBtn.textContent = getThinkingLevelLabel(codexState.level);
      thinkingPickerBtn.title = hasSession
        ? `当前 Thinking 强度: ${codexState.level || '默认'}`
        : `请先打开或创建一个 ${agentSpec.label} 会话`;
      updateContextUsageDisplay();
      return;
    }

    if (modelControl?.kind === 'dynamic') {
      const fullModelName = String(currentModel || '').trim();
      const currentLabel = formatModelDisplayName(fullModelName, currentAgent) || modelControl.emptyLabel || '选择模型';
      modelPickerBtn.hidden = false;
      modelPickerBtn.disabled = !hasSession;
      modelPickerBtn.textContent = currentLabel;
      modelPickerBtn.title = hasSession
        ? `当前 ${agentSpec?.label || 'Agent'} 模型: ${fullModelName || '配置默认模型'}`
        : `请先打开或创建一个 ${agentSpec?.label || 'Agent'} 会话`;
      thinkingPickerBtn.hidden = true;
      thinkingPickerBtn.disabled = true;
      updateContextUsageDisplay();
      return;
    }

    const primaryLabel = (modelControl?.options || []).find((opt) => opt.value === currentModel)?.label
      || currentModel
      || '模型';
    modelPickerBtn.hidden = false;
    modelPickerBtn.disabled = !hasSession;
    modelPickerBtn.textContent = primaryLabel;
    modelPickerBtn.title = hasSession
      ? `当前 ${agentSpec?.label || 'Agent'} 模型: ${primaryLabel}`
      : `请先打开或创建一个 ${agentSpec?.label || 'Agent'} 会话`;
    thinkingPickerBtn.hidden = true;
    thinkingPickerBtn.disabled = true;
    updateContextUsageDisplay();
  }

  function renderImportSessionMenu() {
    if (!newChatDropdown) return 0;
    const importableAgents = getImportableAgents();
    newChatDropdown.innerHTML = importableAgents.map((agent) => {
      const spec = getAgentImportSpec(agent.id);
      const label = spec?.buttonLabel || `导入本地 ${agent.label} 会话`;
      return `<button type="button" data-import-agent="${escapeHtml(agent.id)}">${escapeHtml(label)}</button>`;
    }).join('');
    return importableAgents.length;
  }

  function updateAgentScopedUI() {
    const importableCount = renderImportSessionMenu();
    if (!importableCount && newChatDropdown && !newChatDropdown.hidden) newChatDropdown.hidden = true;
    if (importChatBtn) importChatBtn.hidden = importableCount === 0;
    updateModelControls();
  }

  function setCurrentAgent(agent) {
    currentAgent = normalizeAgent(agent);
    localStorage.setItem('cc-web-agent', currentAgent);
    currentMode = localStorage.getItem(getAgentModeStorageKey(currentAgent)) || 'yolo';
    modeSelect.value = currentMode;
    updateAgentScopedUI();
  }

  function resetChatView(agent) {
    stopGenerationElapsedTimer();
    stopGitStatusPolling();
    setCurrentAgent(agent);
    currentCodebuddyProfile = '';
    currentSessionId = null;
    currentContextTokens = 0;
    generationUsageResolved = false;
    loadedHistorySessionId = null;
    historyLoadState = { sessionId: null, loading: false, hasMore: false };
    renderedMessageStart = 0;
    localHistoryLoading = false;
    messageLocatorHistoryPrepended = false;
    clearSessionLoading();
    setCurrentSessionRunningState(false);
    currentCwd = null;
    currentWorkspacePath = '';
    currentSessionMessages = [];
    currentSessionUsage = null;
    currentModel = getAgentDefinition(currentAgent)?.defaults?.initialModel || '';
    isGenerating = false;
    pendingText = '';
    pendingAttachments = [];
    uploadingAttachments = [];
    activeToolCalls.clear();
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    chatTitle.textContent = '新会话';
    updateChatHeaderMeta();
    renderGitStatus({ available: false, files: [] });
    messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
    setStatsDisplay(null);
    updateContextUsageDisplay();
    renderPendingAttachments();
    highlightActiveSession();
    updateModelControls();
    scheduleMessageLocatorUpdate();
  }

  function applySessionSnapshot(snapshot, options = {}) {
    if (!snapshot) return;
    const preserveStreaming = !!(options.preserveStreaming && isGenerating && snapshot.sessionId === currentSessionId && snapshot.isRunning);
    if (isGenerating && !preserveStreaming) {
      stopGenerationElapsedTimer();
      stopGitStatusPolling();
      isGenerating = false;
      sendBtn.hidden = false;
      abortBtn.hidden = true;
      pendingText = '';
      activeToolCalls.clear();
    }
    currentSessionId = snapshot.sessionId;
    loadedHistorySessionId = snapshot.sessionId;
    if (snapshot.complete) {
      historyLoadState = { sessionId: snapshot.sessionId, loading: false, hasMore: false };
      messagesDiv.querySelector('.history-loader')?.remove();
    }
    setLastSessionForAgent(snapshot.agent, currentSessionId);
    chatTitle.textContent = snapshot.title || '新会话';
    setCurrentAgent(snapshot.agent);
    currentCodebuddyProfile = snapshot.codebuddyProfile || '';
    setCurrentSessionRunningState(snapshot.isRunning);
    setStatsDisplay(snapshot);
    currentContextTokens = normalizeTokenCount(snapshot.totalUsage?.contextTokens);
    generationUsageResolved = false;
    currentSessionMessages = cloneMessages(snapshot.messages || []);
    currentSessionUsage = snapshot.totalUsage ? deepClone(snapshot.totalUsage) : null;
    refreshTokenUsageDisplay();
    currentCwd = snapshot.cwd || null;
    currentWorkspacePath = '';
    updateChatHeaderMeta();
    if (gitPanelOpen) setWorkspaceTab(workspaceTab);
    if (snapshot.mode && MODE_LABELS[snapshot.mode]) {
      currentMode = snapshot.mode;
      modeSelect.value = currentMode;
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
    }
    currentModel = snapshot.model || '';
    updateModelControls();
    if (!preserveStreaming) {
      renderMessages(snapshot.messages || [], { immediate: !!options.immediate });
    }
    updateContextUsageDisplay();
    highlightActiveSession();
    renderSessionList();
    if (!options.skipCloseSidebar) closeSidebar();
    if (snapshot.hasUnread && !options.suppressUnreadToast) {
      showToast('后台任务已完成', snapshot.sessionId);
    }
  }

  function syncViewForAgent(agent, options = {}) {
    const targetAgent = normalizeAgent(agent);
    const { preserveCurrent = true, loadLast = true } = options;
    setCurrentAgent(targetAgent);
    renderSessionList();

    const currentMeta = currentSessionId ? getSessionMeta(currentSessionId) : null;
    if (preserveCurrent && currentMeta && normalizeAgent(currentMeta.agent) === targetAgent) {
      highlightActiveSession();
      return;
    }

    if (currentSessionId && (!currentMeta || normalizeAgent(currentMeta.agent) !== targetAgent)) {
      send({ type: 'detach_view' });
    }

    resetChatView(targetAgent);

    if (!loadLast) return;
    const lastSessionId = getLastSessionForAgent(targetAgent);
    const lastMeta = lastSessionId ? getSessionMeta(lastSessionId) : null;
    if (lastMeta && normalizeAgent(lastMeta.agent) === targetAgent) {
      openSession(lastSessionId);
    }
  }

  function getSessionLoadLabel(sessionId) {
    const meta = sessionId ? getSessionMeta(sessionId) : null;
    const title = meta?.title ? `“${meta.title}”` : '所选会话';
    return `正在载入 ${title} 的完整消息记录…`;
  }

  function setSessionLoading(sessionId, options = {}) {
    const loading = !!sessionId;
    const blocking = options.blocking !== false;
    activeSessionLoad = loading ? { sessionId, blocking, snapshot: null } : null;
    const showOverlay = !!(loading && blocking);
    document.body.classList.toggle('session-loading-active', showOverlay);
    sessionLoadingOverlay.hidden = !showOverlay;
    sessionLoadingOverlay.setAttribute('aria-hidden', showOverlay ? 'false' : 'true');
    sessionLoadingLabel.textContent = loading ? (options.label || getSessionLoadLabel(sessionId)) : '正在整理消息与上下文…';
    msgInput.disabled = showOverlay;
    modeSelect.disabled = showOverlay;
    sendBtn.disabled = showOverlay;
    abortBtn.disabled = showOverlay;
    if (showOverlay && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function clearSessionLoading(sessionId) {
    if (sessionId && activeSessionLoad && activeSessionLoad.sessionId !== sessionId) return;
    setSessionLoading(null, { blocking: false });
  }

  function releaseSessionLoadingOverlay(sessionId) {
    if (!activeSessionLoad || activeSessionLoad.sessionId !== sessionId) return;
    activeSessionLoad.blocking = false;
    document.body.classList.remove('session-loading-active');
    sessionLoadingOverlay.hidden = true;
    sessionLoadingOverlay.setAttribute('aria-hidden', 'true');
    msgInput.disabled = false;
    modeSelect.disabled = false;
    sendBtn.disabled = false;
    abortBtn.disabled = false;
  }

  function isBlockingSessionLoad(sessionId) {
    return !!(activeSessionLoad &&
      activeSessionLoad.blocking &&
      (!sessionId || activeSessionLoad.sessionId === sessionId));
  }

  function finishSessionSwitch(sessionId) {
    if (isBlockingSessionLoad(sessionId)) {
      scrollToBottom();
      requestAnimationFrame(() => clearSessionLoading(sessionId));
      return;
    }
    clearSessionLoading(sessionId);
  }

  function finalizeLoadedSession(sessionId) {
    historyLoadState = { sessionId, loading: false, hasMore: false };
    if (activeSessionLoad?.sessionId === sessionId && activeSessionLoad.snapshot) {
      activeSessionLoad.snapshot.complete = true;
      cacheSessionSnapshot(activeSessionLoad.snapshot);
    }
    renderHistoryLoader();
    retryPendingMessageScroll();
    finishSessionSwitch(sessionId);
  }

  function renderHistoryLoader() {
    let loader = messagesDiv.querySelector('.history-loader');
    const hasMore = historyLoadState.hasMore || renderedMessageStart > 0;
    if (!hasMore) {
      loader?.remove();
      return;
    }
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'history-loader';
      messagesDiv.insertBefore(loader, messagesDiv.firstChild);
    }
    loader.textContent = historyLoadState.loading || localHistoryLoading
      ? '正在加载更早的消息…'
      : '向上滚动加载更早的消息';
  }

  function requestMoreHistory() {
    if (!currentSessionId || loadedHistorySessionId !== currentSessionId) return;
    if (!historyLoadState.hasMore || historyLoadState.loading) return;
    historyLoadState.loading = true;
    renderHistoryLoader();
    send({ type: 'load_session_history', sessionId: currentSessionId });
  }

  function maybeLoadMoreHistory() {
    if ((!historyLoadState.hasMore || historyLoadState.loading) && renderedMessageStart <= 0) return;
    if (messagesDiv.scrollTop <= 120 || messagesDiv.scrollHeight <= messagesDiv.clientHeight + 120) {
      if (renderedMessageStart > 0) loadEarlierRenderedMessages();
      else if (historyLoadState.hasMore) requestMoreHistory();
    }
  }

  function bufferEarlierHistoryMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const prependCount = messages.length;
    currentSessionMessages = cloneMessages(messages).concat(currentSessionMessages);
    refreshTokenUsageDisplay();
    renderedMessageStart += prependCount;
    messagesDiv.querySelectorAll('.msg[data-message-index]').forEach((node) => {
      const index = Number(node.dataset.messageIndex);
      if (Number.isInteger(index)) node.dataset.messageIndex = String(index + prependCount);
    });
    messageLocatorHistoryPrepended = true;
    updateContextUsageDisplay();
    renderHistoryLoader();
    scheduleMessageLocatorUpdate();
  }

  function syncRenderedMessageIndexes(options = {}) {
    const force = options.force === true;
    const nodes = Array.from(messagesDiv.querySelectorAll('.msg'));
    nodes.forEach((node, offset) => {
      if (node.id === 'streaming-msg') {
        node.dataset.messageIndex = String(renderedMessageStart + offset);
        return;
      }
      if (force || !node.dataset.messageIndex) {
        node.dataset.messageIndex = String(renderedMessageStart + offset);
      }
    });
  }

  function trimRenderedMessages() {
    const nodes = Array.from(messagesDiv.querySelectorAll('.msg'));
    const maxNodes = MAX_RENDERED_MESSAGES + (document.getElementById('streaming-msg') ? 1 : 0);
    while (nodes.length > maxNodes) {
      const node = nodes.shift();
      if (!node || node.id === 'streaming-msg') break;
      node.remove();
      renderedMessageStart += 1;
    }
    syncRenderedMessageIndexes({ force: true });
    renderHistoryLoader();
    scheduleMessageLocatorUpdate();
  }

  function loadEarlierRenderedMessages() {
    if (renderedMessageStart <= 0 || localHistoryLoading) return;
    localHistoryLoading = true;
    renderHistoryLoader();
    requestAnimationFrame(() => {
      const end = renderedMessageStart;
      const start = Math.max(0, end - LOCAL_HISTORY_CHUNK_SIZE);
      const frag = document.createDocumentFragment();
      for (let index = start; index < end; index += 1) {
        frag.appendChild(buildMsgElement(currentSessionMessages[index], {
          allowResend: index === currentSessionMessages.length - 1,
          messageIndex: index,
        }));
      }
      const previousHeight = messagesDiv.scrollHeight;
      const previousScrollTop = messagesDiv.scrollTop;
      const loader = messagesDiv.querySelector('.history-loader');
      messagesDiv.insertBefore(frag, loader?.nextSibling || messagesDiv.firstChild);
      renderedMessageStart = start;
      localHistoryLoading = false;
      messagesDiv.scrollTop = previousScrollTop + (messagesDiv.scrollHeight - previousHeight);
      renderHistoryLoader();
      syncLastUserResendAction();
      updateScrollbar();
      scheduleMessageLocatorUpdate();
      retryPendingMessageScroll();
    });
  }

  function beginSessionSwitch(sessionId, options = {}) {
    if (!sessionId) return;
    const blocking = options.blocking !== false;
    const force = options.force === true;
    if (!force && activeSessionLoad?.sessionId === sessionId) return;
    if (!force && sessionId === currentSessionId && !activeSessionLoad) return;
    renderEpoch++;
    loadedHistorySessionId = null;
    historyLoadState = { sessionId: null, loading: false, hasMore: false };
    renderedMessageStart = 0;
    localHistoryLoading = false;
    messageLocatorHistoryPrepended = false;
    setSessionLoading(sessionId, { blocking, label: options.label });
    send({ type: 'load_session', sessionId });
  }

  function showCachedSession(sessionId) {
    const snapshot = buildCachedSessionSnapshot(sessionId);
    if (!snapshot) return false;
    if (currentSessionId && currentSessionId !== sessionId) {
      send({ type: 'detach_view' });
    }
    clearSessionLoading();
    touchSessionCache(sessionId);
    applySessionSnapshot(snapshot, { immediate: true, suppressUnreadToast: true });
    return true;
  }

  function openSession(sessionId, options = {}) {
    if (!sessionId) return;
    if (options.forceSync) {
      beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: true, label: options.label });
      return;
    }
    if (!options.force && sessionId === currentSessionId && !activeSessionLoad) return;

    const disposition = getSessionCacheDisposition(sessionId);
    if (disposition === 'strong') {
      showCachedSession(sessionId);
      return;
    }
    if (disposition === 'weak' && showCachedSession(sessionId)) {
      beginSessionSwitch(sessionId, { blocking: false, force: true, label: options.label });
      return;
    }
    beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: options.force === true, label: options.label });
  }

  function setStatsDisplay(msg) {
    if (msg && msg.totalUsage) {
      const usage = msg.totalUsage;
      if ((usage.inputTokens || 0) > 0 || (usage.outputTokens || 0) > 0) {
        setTokenUsageDisplay(usage);
        updateContextUsageDisplay();
        return;
      }
    }
    costDisplay.textContent = '';
    costDisplay.hidden = true;
    updateContextUsageDisplay();
  }

	  function _splitCodexThinkingModel(model) {
	    const raw = String(model || '').trim();
	    if (!raw) return { base: '', level: '' };
	    const m = raw.match(/^(.*)\(([^()]+)\)\s*$/);
	    if (!m) return { base: raw, level: '' };
	    return { base: (m[1] || '').trim(), level: (m[2] || '').trim().toLowerCase() };
	  }

	  function _isCodexModelAtLeast52(model) {
	    const { base } = _splitCodexThinkingModel(model);
	    // Accept only GPT-5.2+ (hide/remove older and other families from picker).
	    const m = String(base || '').trim().match(/^gpt-5\.(\d+)(?:-.+)?$/i);
	    if (!m) return false;
	    const minor = Number(m[1] || 0);
	    return Number.isFinite(minor) && minor >= 2;
	  }

	  function getCodexBaseModelOptions() {
	    const modelControl = getAgentModelControl(currentAgent);
	    const seen = new Set();
	    const options = [];

	    function addOption(value, label, desc) {
	      const v = (value || '').trim();
	      if (!v || seen.has(v)) return;
	      seen.add(v);
	      options.push({ value: v, label: label || v, desc: desc || 'Codex 模型' });
	    }

	    function addBaseOption(value, label, desc) {
	      if (!_isCodexModelAtLeast52(value)) return;
	      const { base } = _splitCodexThinkingModel(value);
	      addOption(base, label || base, desc);
	    }

	    (modelControl?.baseOptions || []).forEach((opt) => addBaseOption(opt.value, opt.label, opt.desc));
	    addBaseOption(currentModel, currentModel, '当前会话模型');
	    sessions
	      .filter((s) => normalizeAgent(s.agent) === currentAgent && s.id === currentSessionId)
	      .forEach((s) => addBaseOption(s.model, s.model, '当前会话已保存模型'));

	    return options;
	  }

  // --- marked config ---
  const PREVIEW_LANGS = new Set(['html', 'svg']);
  const _previewCodeMap = new Map();
  let _previewCodeId = 0;

  const renderer = new marked.Renderer();
  renderer.code = function (code, language) {
    const lang = (language || 'plaintext').toLowerCase();
    let highlighted;
    try {
      if (hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch {
      highlighted = escapeHtml(code);
    }
    const canPreview = PREVIEW_LANGS.has(lang);
    const previewBtn = canPreview
      ? `<button class="code-preview-btn" onclick="ccTogglePreview(this)">Preview</button>`
      : '';
    const previewPane = canPreview
      ? `<div class="code-preview-pane"><iframe class="code-preview-iframe" sandbox="allow-scripts" loading="lazy"></iframe></div>`
      : '';
    const cid = canPreview ? (++_previewCodeId) : 0;
    if (canPreview) _previewCodeMap.set(cid, code);
    return `<div class="code-block-wrapper${canPreview ? ' has-preview' : ''}"${canPreview ? ` data-cid="${cid}"` : ''}>
      <div class="code-block-header">
        <span>${escapeHtml(lang)}</span>
        <div class="code-block-actions">${previewBtn}<button class="code-copy-btn" onclick="ccCopyCode(this)">Copy</button></div>
      </div>
      ${previewPane}<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
    </div>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  window.ccCopyCode = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
    const code = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : wrapper.querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  };

  window.ccTogglePreview = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const inPreview = wrapper.classList.contains('preview-mode');
    if (inPreview) {
      wrapper.classList.remove('preview-mode');
      btn.textContent = 'Preview';
    } else {
      const iframe = wrapper.querySelector('.code-preview-iframe');
      if (iframe && !iframe.dataset.loaded) {
        const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
        iframe.srcdoc = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : '';
        iframe.dataset.loaded = '1';
      }
      wrapper.classList.add('preview-mode');
      btn.textContent = 'Source';
    }
  };

  // --- WebSocket ---
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectAttempts = 0;
      if (authToken) send({ type: 'auth', token: authToken });
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      stopGitStatusPolling();
      clearSessionLoading();
      for (const [requestId, resolve] of pendingAgentModelRequests) {
        pendingAgentModelRequests.delete(requestId);
        resolve({
          success: false,
          models: [],
          message: '连接已断开，请稍后重试',
        });
      }
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // --- Server Message Handler ---
  function handleServerMessage(msg) {
    const isCurrentStreamMessage = () => !msg.sessionId || msg.sessionId === currentSessionId;
    switch (msg.type) {
      case 'auth_result':
        if (msg.success) {
          authToken = msg.token;
          localStorage.setItem('cc-web-token', msg.token);
          document.dispatchEvent(new CustomEvent('cc-web-auth-restored'));
          loginOverlay.hidden = true;
          app.hidden = false;
          restoreGitPanelOpenState();
          send({ type: 'get_codex_config' });
          send({ type: 'get_ai_config' });
          // Check if must change password
          if (msg.mustChangePassword) {
            showForceChangePassword();
          } else {
            pendingInitialSessionLoad = true;
          }
        } else {
          authToken = null;
          localStorage.removeItem('cc-web-token');
          document.dispatchEvent(new CustomEvent('cc-web-auth-failed'));
          loginOverlay.hidden = false;
          app.hidden = true;
          if (msg.banned) {
            loginError.textContent = '该 IP 已被永久封禁';
            loginError.hidden = false;
            loginPassword.disabled = true;
            loginForm.querySelector('button[type="submit"]').disabled = true;
          } else {
            loginError.textContent = '密码错误';
            loginError.hidden = false;
          }
        }
        break;

      case 'session_list':
        sessions = msg.sessions || [];
        projects = Array.isArray(msg.projects) ? msg.projects : [];
        reconcileSessionCacheWithSessions();
        renderSessionList();
        if (currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (pendingInitialSessionLoad) {
          pendingInitialSessionLoad = false;
          syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
        } else if (currentSessionId && !getSessionMeta(currentSessionId)) {
          resetChatView(currentAgent);
        }
        break;

      case 'session_info':
        historyLoadState = {
          sessionId: msg.sessionId,
          loading: false,
          hasMore: !!msg.historyPending,
        };
        const snapshot = normalizeSessionSnapshot(msg);
        if (activeSessionLoad?.sessionId === msg.sessionId) {
          activeSessionLoad.snapshot = snapshot;
        }
        applySessionSnapshot(snapshot, {
          immediate: isBlockingSessionLoad(msg.sessionId),
          suppressUnreadToast: false,
          preserveStreaming: msg.sessionId === currentSessionId && msg.isRunning,
        });
        if (!msg.historyPending) {
          if (activeSessionLoad?.sessionId === msg.sessionId) {
            finalizeLoadedSession(msg.sessionId);
          } else {
            cacheSessionSnapshot(snapshot);
            finishSessionSwitch(msg.sessionId);
          }
        } else {
          releaseSessionLoadingOverlay(msg.sessionId);
          renderHistoryLoader();
          requestAnimationFrame(requestMoreHistory);
        }
        break;

      case 'session_history_chunk':
        if (msg.sessionId === currentSessionId && loadedHistorySessionId === msg.sessionId) {
          historyLoadState.loading = false;
          historyLoadState.hasMore = Number(msg.remaining) > 0;
          if (activeSessionLoad?.sessionId === msg.sessionId && activeSessionLoad.snapshot) {
            activeSessionLoad.snapshot.messages = cloneMessages(msg.messages || []).concat(activeSessionLoad.snapshot.messages);
          }
          bufferEarlierHistoryMessages(msg.messages || []);
          if (!msg.remaining) {
            finalizeLoadedSession(msg.sessionId);
          } else {
            renderHistoryLoader();
            requestAnimationFrame(requestMoreHistory);
          }
        }
        break;

      case 'session_renamed':
        sessions = sessions.map((session) => session.id === msg.sessionId ? { ...session, title: msg.title } : session);
        updateCachedSession(msg.sessionId, (snapshot) => { snapshot.title = msg.title; });
        if (msg.sessionId === currentSessionId) {
          chatTitle.textContent = msg.title;
        }
        renderSessionList();
        break;

      case 'text_delta':
        if (!isCurrentStreamMessage()) break;
        if (!isGenerating) startGenerating();
        if (normalizeAgent(currentAgent) === 'codex') {
          finalizeActiveToolCalls(activeToolCalls, updateToolCall);
        }
        pendingText += msg.text;
        scheduleRender();
        break;

      case 'tool_start':
        if (!isCurrentStreamMessage()) break;
        if (!isGenerating) startGenerating();
        activeToolCalls.set(msg.toolUseId, { id: msg.toolUseId, name: msg.name, input: msg.input, kind: msg.kind || null, meta: msg.meta || null, done: false });
        appendToolCall(msg.toolUseId, msg.name, msg.input, false, msg.kind || null, msg.meta || null);
        break;

      case 'tool_end':
        if (!isCurrentStreamMessage()) break;
        if (activeToolCalls.has(msg.toolUseId)) {
          activeToolCalls.get(msg.toolUseId).done = true;
          if (msg.kind) activeToolCalls.get(msg.toolUseId).kind = msg.kind;
          if (msg.meta) activeToolCalls.get(msg.toolUseId).meta = msg.meta;
          activeToolCalls.get(msg.toolUseId).result = msg.result;
        }
        updateToolCall(msg.toolUseId, msg.result);
        showStreamingThinkingIndicator();
        break;

      case 'generation_state':
        if (msg.sessionId && msg.sessionId !== currentSessionId) break;
        if (msg.state === 'compacting') {
          startGenerating(msg.startedAt, 'compacting');
        }
        break;

      case 'cost':
        if (!isCurrentStreamMessage()) break;
        if (currentSessionId) {
          updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalCost = msg.costUsd; });
        }
        break;

      case 'usage':
        if (!isCurrentStreamMessage()) break;
        if (msg.totalUsage) {
          setTokenUsageDisplay(msg.totalUsage);
          currentContextTokens = normalizeTokenCount(msg.totalUsage.contextTokens);
          generationUsageResolved = currentContextTokens > 0;
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalUsage = deepClone(msg.totalUsage); });
          }
          updateContextUsageDisplay();
        }
        break;

      case 'done':
        if (!isCurrentStreamMessage()) break;
        finishGenerating(msg.sessionId, msg.durationMs, msg.turnStats);
        break;

      case 'git_status':
        if (!msg.sessionId || msg.sessionId === currentSessionId) {
          if (workspaceTab === 'changes') renderGitStatus(msg);
          else updateGitStatusHeader(msg);
        }
        break;

      case 'git_history':
        applyGitHistory(msg);
        break;

      case 'workspace_files':
        if (msg.sessionId === currentSessionId && workspaceTab === 'files') renderWorkspaceFiles(msg);
        break;

      case 'workspace_file':
        if (msg.sessionId === currentSessionId && workspaceTab === 'files') renderWorkspaceFile(msg);
        break;

      case 'workspace_diff':
        if (msg.sessionId === currentSessionId && workspaceTab === 'changes') renderWorkspaceDiff(msg);
        break;

      case 'system_message':
        if (msg.sessionId && msg.sessionId !== currentSessionId) break;
        appendSystemMessage(msg.message);
        break;

      case 'mode_changed':
        if (msg.sessionId && msg.sessionId !== currentSessionId) break;
        if (msg.mode && MODE_LABELS[msg.mode]) {
          currentMode = msg.mode;
          modeSelect.value = currentMode;
          localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.mode = msg.mode; });
          }
        }
        break;

      case 'model_changed':
        if (msg.sessionId && msg.sessionId !== currentSessionId) break;
        if (msg.model) {
          currentModel = msg.model;
          const targetSessionId = msg.sessionId || currentSessionId;
          sessions = sessions.map((session) =>
            session.id === targetSessionId ? { ...session, model: msg.model, aiProviderId: msg.aiProviderId || session.aiProviderId, aiModelId: msg.aiModelId || session.aiModelId, reasoningEffort: msg.reasoningEffort || session.reasoningEffort } : session
          );
          for (const [sessionId, entry] of sessionCache) {
            if (sessionId !== targetSessionId) continue;
            updateCachedSession(sessionId, (snapshot) => { snapshot.model = msg.model; });
          }
        }
        if (msg.sessionId === currentSessionId) {
          updateCachedSession(currentSessionId, (snapshot) => {
            if (msg.aiProviderId) snapshot.aiProviderId = msg.aiProviderId;
            if (msg.aiModelId) snapshot.aiModelId = msg.aiModelId;
            if (msg.reasoningEffort) snapshot.reasoningEffort = msg.reasoningEffort;
          });
        }
        updateModelControls();
        break;

      case 'resume_generating':
        if (msg.sessionId && msg.sessionId !== currentSessionId) break;
        // Server has an active process for this session — resume streaming
        setCurrentSessionRunningState(true);
        const resumeKind = msg.kind === 'compacting' ? 'compacting' : 'response';
        if (!isGenerating || !document.getElementById('streaming-msg')) {
          startGenerating(msg.startedAt, resumeKind);
        } else {
          generationKind = resumeKind;
          sendBtn.hidden = true;
          abortBtn.hidden = false;
          activeToolCalls.clear();
          startGenerationElapsedTimer(msg.startedAt);
          startGitStatusPolling();
        }
        const streamBubble = document.querySelector('#streaming-msg .msg-bubble');
        const resumeSteps = Array.isArray(msg.steps) && msg.steps.length > 0
          ? msg.steps
          : buildLegacyAssistantSteps(msg.text || '', msg.toolCalls || []);
        if (streamBubble) {
          renderAssistantStepsIntoBubble(streamBubble, resumeSteps, [], { complete: false, running: true });
        }
        const toolSteps = resumeSteps.filter((step) => step && step.type === 'tool_call');
        toolSteps.forEach((tc) => {
          activeToolCalls.set(tc.id, {
            id: tc.id,
            name: tc.name,
            input: tc.input,
            result: tc.result,
            kind: tc.kind || null,
            meta: tc.meta || null,
            done: tc.done,
          });
        });
        const lastStep = resumeSteps[resumeSteps.length - 1];
        pendingText = lastStep?.type === 'text' ? (lastStep.content || '') : '';
        if (resumeSteps.length === 0) flushRender();
        toolSteps.forEach((tc) => {
          if (tc.done && tc.result) {
            updateToolCall(tc.id, tc.result);
          }
        });
        break;

      case 'error':
        if (msg.sessionId && msg.sessionId !== currentSessionId) break;
        appendError(msg.message);
        clearSessionLoading();
        if (!isGenerating && currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (isGenerating) finishGenerating();
        break;

      case 'notify_config':
        if (typeof _onNotifyConfig === 'function') _onNotifyConfig(msg.config);
        // Update summary in parent settings panel if visible
        if (msg.config) {
          const provider = msg.config.provider || 'off';
          const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
          const summaryOn = msg.config.summary?.enabled ? '摘要已启用' : '摘要关闭';
          const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
          document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
        }
        break;

      case 'notify_test_result':
        if (typeof _onNotifyTestResult === 'function') _onNotifyTestResult(msg);
        break;

      case 'model_config':
        if (typeof _onModelConfig === 'function') _onModelConfig(msg.config);
        updateContextUsageDisplay();
        break;

      case 'ai_config':
        aiConfigCache = msg.config || null;
        if (typeof _onAiConfig === 'function') _onAiConfig(aiConfigCache);
        updateModelControls();
        break;

      case 'codex_config':
        codexConfigCache = msg.config || null;
        if (typeof _onCodexConfig === 'function') _onCodexConfig(msg.config);
        updateContextUsageDisplay();
        break;

      case 'codebuddy_config':
        codebuddyConfigCache = msg.config || null;
        if (typeof _onCodebuddyConfig === 'function') _onCodebuddyConfig(msg.config);
        updateContextUsageDisplay();
        break;

      case 'kimi_config':
        kimiConfigCache = msg.config || null;
        if (typeof _onKimiConfig === 'function') _onKimiConfig(msg.config);
        updateContextUsageDisplay();
        break;

      case 'cli_install_status':
        if (typeof _onCliInstallStatus === 'function') _onCliInstallStatus(msg.status || {});
        break;

      case 'claude_local_config':
        if (typeof _onClaudeLocalConfig === 'function') _onClaudeLocalConfig(msg);
        break;

      case 'codex_local_config':
        if (typeof _onCodexLocalConfig === 'function') _onCodexLocalConfig(msg);
        break;

      case 'kimi_local_config':
        if (typeof _onKimiLocalConfig === 'function') _onKimiLocalConfig(msg);
        break;

      case 'dev_config':
        if (typeof _onDevConfig === 'function') _onDevConfig(msg.config);
        break;

      case 'fetch_models_result':
        if (typeof _onFetchModelsResult === 'function') _onFetchModelsResult(msg);
        break;

      case 'agent_models_result':
        if (msg.requestId && pendingAgentModelRequests.has(msg.requestId)) {
          const resolve = pendingAgentModelRequests.get(msg.requestId);
          pendingAgentModelRequests.delete(msg.requestId);
          resolve(msg);
        }
        if (msg.agent && Array.isArray(msg.models)) {
          agentModelOptionsCache.set(normalizeAgent(msg.agent), msg.models);
          updateContextUsageDisplay();
        }
        break;

      case 'background_done':
        // A background task completed (browser was disconnected or viewing another session)
        showToast(`「${msg.title}」任务完成`, msg.sessionId);
        showBrowserNotification(msg.title);
        if (msg.sessionId === currentSessionId) {
          stopGitStatusPolling();
          requestGitStatus({ showLoading: false });
          // Reload current session to show completed response
          openSession(msg.sessionId, { forceSync: true, blocking: false });
        } else {
          send({ type: 'list_sessions' });
        }
        break;

      case 'password_changed':
        handlePasswordChanged(msg);
        break;

      case 'agent_import_sessions':
        if (typeof _onAgentImportSessions === 'function') {
          _onAgentImportSessions({ agent: msg.agent, data: msg.data });
        }
        break;

      case 'native_sessions':
        if (typeof _onAgentImportSessions === 'function') {
          _onAgentImportSessions({ agent: 'claude', data: msg.groups || [] });
        }
        break;

      case 'codex_sessions':
        if (typeof _onAgentImportSessions === 'function') {
          _onAgentImportSessions({ agent: 'codex', data: msg.sessions || [] });
        }
        break;

      case 'cwd_suggestions':
        if (typeof _onCwdSuggestions === 'function') _onCwdSuggestions(msg);
        break;

      case 'directory_browser':
        if (typeof _onDirectoryBrowser === 'function') _onDirectoryBrowser(msg);
        break;

      case 'update_info':
        if (typeof window._ccOnUpdateInfo === 'function') window._ccOnUpdateInfo(msg);
        break;
    }
  }

  // --- Generating State ---
  function getGenerationElapsedMs() {
    return generationStartedAt > 0 ? Math.max(0, Date.now() - generationStartedAt) : null;
  }

  function refreshGenerationElapsedTime() {
    const bubble = document.querySelector('#streaming-msg .msg-bubble');
    if (!bubble) return;
    updateAssistantBubbleLayout(bubble, {
      complete: false,
      running: true,
      elapsedMs: getGenerationElapsedMs(),
    });
  }

  function stopGenerationElapsedTimer() {
    if (generationElapsedTimer) clearInterval(generationElapsedTimer);
    generationElapsedTimer = null;
    generationStartedAt = 0;
  }

  function startGenerationElapsedTimer(startedAt) {
    if (generationElapsedTimer) clearInterval(generationElapsedTimer);
    const normalizedStartedAt = Number(startedAt);
    generationStartedAt = Number.isFinite(normalizedStartedAt) && normalizedStartedAt > 0
      ? normalizedStartedAt
      : Date.now();
    refreshGenerationElapsedTime();
    generationElapsedTimer = setInterval(refreshGenerationElapsedTime, 1000);
  }

  function startGenerating(startedAt, kind = 'response') {
    isGenerating = true;
    generationKind = kind === 'compacting' ? 'compacting' : 'response';
    generationUsageResolved = false;
    setCurrentSessionRunningState(true);
    pendingText = '';
    activeToolCalls.clear();
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    abortBtn.disabled = false;
    abortBtn.title = '停止';
    // 不禁用输入框，允许用户继续输入（但无法发送）

    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const msgEl = createMsgElement('assistant', '');
    msgEl.id = 'streaming-msg';
    const bubble = msgEl.querySelector('.msg-bubble');
    renderAssistantStepsIntoBubble(bubble, [], [], { complete: false, running: true });
    messagesDiv.appendChild(msgEl);
    syncRenderedMessageIndexes();
    scheduleMessageLocatorUpdate();
    startGenerationElapsedTimer(startedAt);
    startGitStatusPolling();
    showStreamingThinkingIndicator();
    updateContextUsageDisplay();
    syncLastUserResendAction();
  }

  function finishGenerating(sessionId, durationMs, turnStats = null) {
    const completedDurationMs = normalizeElapsedDuration(durationMs) ?? getGenerationElapsedMs();
    stopGenerationElapsedTimer();
    stopGitStatusPolling(true);
    isGenerating = false;
    generationKind = 'response';
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    abortBtn.disabled = false;
    abortBtn.title = '停止';
    setCurrentSessionRunningState(false);

    if (pendingText) flushRender();
    finalizeActiveToolCalls(activeToolCalls, updateToolCall);
    const completedSteps = buildLegacyAssistantSteps(
      pendingText,
      Array.from(activeToolCalls.values()).map((tool) => deepClone(tool)),
    );
    const hasAssistantOutput = !!(pendingText.trim() || activeToolCalls.size > 0);

    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      removeTrailingEmptyAssistantTextStep(streamEl);
      updateAssistantBubbleLayout(streamEl.querySelector('.msg-bubble'), {
        complete: true,
        running: false,
        elapsedMs: completedDurationMs,
      });
      appendAssistantFileChanges(streamEl, completedSteps);
      if (hasAssistantOutput) streamEl.removeAttribute('id');
      else streamEl.remove();
    }

    if (sessionId) currentSessionId = sessionId;
    if (hasAssistantOutput) {
      currentSessionMessages.push({
        role: 'assistant',
        content: pendingText,
        steps: completedSteps,
        durationMs: completedDurationMs,
        turnStats: turnStats && typeof turnStats === 'object' ? deepClone(turnStats) : null,
      });
      syncRenderedMessageIndexes();
    }
    trimRenderedMessages();
    updateContextUsageDisplay();
    pendingText = '';
    activeToolCalls.clear();
    refreshTokenUsageDisplay();
    syncLastUserResendAction();
    scheduleMessageLocatorUpdate();
  }

  // --- Rendering ---
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushRender();
    }, RENDER_DEBOUNCE);
  }

  function flushRender() {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const textStep = ensureStreamingTextStep(streamEl);
    if (!textStep) return;
    setAssistantTextStepContent(textStep, pendingText);
    updateAssistantBubbleLayout(streamEl.querySelector('.msg-bubble'), { complete: false, running: true });
    updateContextUsageDisplay();
    scrollToBottomIfNeeded();
    scheduleMessageLocatorUpdate();
  }

  function renderMarkdown(text) {
    if (!text) {
      const label = generationKind === 'compacting' ? '正在压缩上下文' : '正在思考';
      return `<div class="typing-indicator" data-text="${label}" role="status">${label}</div>`;
    }
    try { return marked.parse(text); }
    catch { return escapeHtml(text); }
  }

  function buildLegacyAssistantSteps(content, toolCalls = []) {
    const steps = [];
    if (Array.isArray(toolCalls)) {
      toolCalls.forEach((tool) => {
        if (!tool || typeof tool !== 'object') return;
        steps.push({ type: 'tool_call', ...deepClone(tool) });
      });
    }
    if (typeof content === 'string' && content.trim()) {
      steps.push({ type: 'text', content });
    }
    return steps;
  }

  function getAssistantMessageSteps(message) {
    if (Array.isArray(message?.steps) && message.steps.length > 0) {
      return deepClone(message.steps);
    }
    return buildLegacyAssistantSteps(message?.content || '', message?.toolCalls || []);
  }

  function getMessagePreviewText(message) {
    if (!message || typeof message !== 'object') return '';
    if (message.role === 'assistant') {
      const steps = getAssistantMessageSteps(message);
      const text = steps
        .filter((step) => step?.type === 'text' && step.content)
        .map((step) => step.content)
        .join('\n')
        .trim();
      if (text) return text;
      const tool = steps.find((step) => step && step.type !== 'text');
      if (tool) return toolTitle(tool);
    }
    return String(message.content || '').trim();
  }

  function formatMessageLocatorTip(message, index) {
    const roleLabel = message?.role === 'user' ? '用户' : (message?.role === 'assistant' ? '助手' : '系统');
    const preview = getMessagePreviewText(message).replace(/\s+/g, ' ').trim();
    return `${index + 1}. ${roleLabel}${preview ? `：${preview.slice(0, 120)}` : ''}`;
  }

  function getMessageNodeByIndex(index) {
    return messagesDiv.querySelector(`.msg[data-message-index="${index}"]`);
  }

  function retryPendingMessageScroll() {
    if (pendingScrollMessageIndex === null) return;
    const node = getMessageNodeByIndex(pendingScrollMessageIndex);
    if (!node) {
      if (pendingScrollMessageIndex < renderedMessageStart && !localHistoryLoading) {
        requestAnimationFrame(loadEarlierRenderedMessages);
      }
      return;
    }
    const index = pendingScrollMessageIndex;
    pendingScrollMessageIndex = null;
    scrollMessageIntoView(index);
  }

  function scrollMessageIntoView(index) {
    const node = getMessageNodeByIndex(index);
    if (!node) {
      if (index < renderedMessageStart) {
        pendingScrollMessageIndex = index;
        messagesDiv.scrollTop = 0;
        maybeLoadMoreHistory();
      }
      return;
    }
    const top = node.offsetTop - 12;
    messagesDiv.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    node.classList.add('msg-locator-target');
    setTimeout(() => node.classList.remove('msg-locator-target'), 1100);
  }

  function ensureMessageLocatorTip() {
    if (!messagesWrap) return null;
    let tip = messagesWrap.querySelector('#message-locator-floating-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'message-locator-floating-tip';
      tip.className = 'message-locator-floating-tip';
      messagesWrap.appendChild(tip);
    }
    return tip;
  }

  function hideMessageLocatorTip() {
    const tip = messagesWrap?.querySelector('#message-locator-floating-tip');
    if (!tip) return;
    tip.classList.remove('visible');
    tip.textContent = '';
  }

  function showMessageLocatorTip(marker, text) {
    const tip = ensureMessageLocatorTip();
    if (!tip || !marker) return;
    tip.textContent = text;
    const wrapRect = messagesWrap.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const tipHeight = tip.offsetHeight || 42;
    const rawTop = markerRect.top - wrapRect.top + (markerRect.height / 2);
    const top = Math.max(12 + tipHeight / 2, Math.min(wrapRect.height - 12 - tipHeight / 2, rawTop));
    tip.style.top = `${top}px`;
    tip.classList.add('visible');
  }

  function setActiveLocatorTouchMarker(marker) {
    if (!marker || marker === activeLocatorTouchMarker) return;
    if (activeLocatorTouchMarker) activeLocatorTouchMarker.classList.remove('touch-preview');
    activeLocatorTouchMarker = marker;
    marker.classList.add('touch-preview');
    showMessageLocatorTip(marker, marker.dataset.tipText || marker.getAttribute('aria-label') || '');
  }

  function getLocatorMarkerFromTouch(touch) {
    if (!touch) return null;
    const locator = messagesWrap?.querySelector('#message-locator');
    if (!locator) return null;
    const markers = Array.from(locator.querySelectorAll('.message-locator-marker'));
    if (markers.length === 0) return null;
    const x = touch.clientX;
    const y = touch.clientY;
    const direct = document.elementFromPoint(x, y)?.closest?.('.message-locator-marker');
    if (direct && locator.contains(direct)) return direct;

    const locatorRect = locator.getBoundingClientRect();
    if (x < locatorRect.left - 24 || x > locatorRect.right + 24 || y < locatorRect.top - 24 || y > locatorRect.bottom + 24) {
      return null;
    }
    let best = null;
    let bestDistance = Infinity;
    markers.forEach((marker) => {
      const rect = marker.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const distance = Math.abs(centerY - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = marker;
      }
    });
    return best;
  }

  function finishLocatorTouch(shouldJump) {
    const marker = activeLocatorTouchMarker;
    activeLocatorTouchMarker = null;
    if (!marker) return;
    marker.classList.remove('touch-preview');
    hideMessageLocatorTip();
    if (!shouldJump) return;
    const index = Number(marker.dataset.messageIndex);
    if (Number.isInteger(index)) scrollMessageIntoView(index);
  }

  function updateMessageLocatorScrollbar(locator) {
    const scrollbar = messagesWrap?.querySelector('#message-locator-scrollbar');
    const thumb = scrollbar?.querySelector('.message-locator-scrollbar-thumb');
    if (!locator || !scrollbar || !thumb) return;

    const trackHeight = Math.max(0, locator.clientHeight - 8);
    const indicator = calculateScrollIndicator(
      locator.scrollTop,
      locator.scrollHeight,
      locator.clientHeight,
      trackHeight,
    );
    if (!indicator) {
      scrollbar.hidden = true;
      return;
    }

    scrollbar.hidden = false;
    const wrapRect = messagesWrap.getBoundingClientRect();
    const locatorRect = locator.getBoundingClientRect();
    scrollbar.style.top = `${locatorRect.top - wrapRect.top + 4}px`;
    scrollbar.style.height = `${trackHeight}px`;
    thumb.style.height = `${indicator.thumbHeight}px`;
    thumb.style.transform = `translateY(${indicator.thumbTop}px)`;
  }

  function ensureMessageLocator() {
    if (!messagesWrap) return null;
    let locator = messagesWrap.querySelector('#message-locator');
    if (!locator) {
      locator = document.createElement('div');
      locator.id = 'message-locator';
      locator.className = 'message-locator';
      locator.setAttribute('aria-label', '消息定位条');
      const scrollbar = document.createElement('div');
      scrollbar.id = 'message-locator-scrollbar';
      scrollbar.className = 'message-locator-scrollbar';
      scrollbar.setAttribute('aria-hidden', 'true');
      scrollbar.hidden = true;
      const thumb = document.createElement('div');
      thumb.className = 'message-locator-scrollbar-thumb';
      scrollbar.appendChild(thumb);
      messagesWrap.append(locator, scrollbar);
      locator.addEventListener('scroll', () => updateMessageLocatorScrollbar(locator), { passive: true });
      new ResizeObserver(() => updateMessageLocatorScrollbar(locator)).observe(locator);
      locator.addEventListener('touchstart', (e) => {
        const marker = getLocatorMarkerFromTouch(e.touches?.[0]);
        if (!marker) return;
        setActiveLocatorTouchMarker(marker);
        e.preventDefault();
      }, { passive: false });
      locator.addEventListener('touchmove', (e) => {
        const marker = getLocatorMarkerFromTouch(e.touches?.[0]);
        if (marker) setActiveLocatorTouchMarker(marker);
        e.preventDefault();
      }, { passive: false });
      locator.addEventListener('touchend', (e) => {
        finishLocatorTouch(true);
        e.preventDefault();
      }, { passive: false });
      locator.addEventListener('touchcancel', () => finishLocatorTouch(false), { passive: true });
    }
    return locator;
  }

  function updateMessageLocator() {
    messageLocatorUpdateQueued = false;
    const locator = ensureMessageLocator();
    if (!locator) return;
    const locatorMessages = currentSessionMessages.slice();
    if (document.getElementById('streaming-msg')) {
      locatorMessages.push({
        role: 'assistant',
        content: pendingText || (generationKind === 'compacting' ? '正在压缩上下文' : '正在思考'),
      });
    }
    const messageCount = locatorMessages.length;
    const previousScrollHeight = locator.scrollHeight;
    const previousScrollTop = locator.scrollTop;
    const wasAtBottom = previousScrollHeight <= locator.clientHeight + 1
      || previousScrollHeight - locator.clientHeight - previousScrollTop <= 4;
    const preservePrependedPosition = messageLocatorHistoryPrepended;
    messageLocatorHistoryPrepended = false;
    if (messageCount === 0) {
      locator.replaceChildren();
      locator.hidden = true;
      updateMessageLocatorScrollbar(locator);
      return;
    }

    locator.hidden = false;
    hideMessageLocatorTip();
    const frag = document.createDocumentFragment();
    const rendered = new Set(Array.from(messagesDiv.querySelectorAll('.msg[data-message-index]')).map((node) => Number(node.dataset.messageIndex)));
    locatorMessages.forEach((message, index) => {
      const isRendered = rendered.has(index);
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = `message-locator-marker ${message?.role === 'user' ? 'user' : 'assistant'}`;
      if (!isRendered) marker.classList.add('pending');
      marker.dataset.messageIndex = String(index);
      const tipText = formatMessageLocatorTip(message, index);
      marker.dataset.tipText = tipText;
      marker.setAttribute('aria-label', tipText);
      marker.addEventListener('click', () => scrollMessageIntoView(index));
      marker.addEventListener('mouseenter', () => showMessageLocatorTip(marker, tipText));
      marker.addEventListener('mouseleave', hideMessageLocatorTip);
      marker.addEventListener('focus', () => showMessageLocatorTip(marker, tipText));
      marker.addEventListener('blur', hideMessageLocatorTip);
      frag.appendChild(marker);
    });
    locator.replaceChildren(frag);
    requestAnimationFrame(() => {
      if (preservePrependedPosition) {
        locator.scrollTop = previousScrollTop + Math.max(0, locator.scrollHeight - previousScrollHeight);
      } else if (wasAtBottom) {
        locator.scrollTop = locator.scrollHeight;
      } else {
        locator.scrollTop = Math.min(previousScrollTop, locator.scrollHeight - locator.clientHeight);
      }
      updateMessageLocatorScrollbar(locator);
    });
  }

  function scheduleMessageLocatorUpdate() {
    if (messageLocatorUpdateQueued) return;
    messageLocatorUpdateQueued = true;
    requestAnimationFrame(updateMessageLocator);
  }

  function isRenderableAssistantTextStep(step) {
    return !!(step?.type === 'text' && String(step.content || '').trim());
  }

  function getRenderableAssistantSteps(steps) {
    return (Array.isArray(steps) ? steps : []).filter((step) => {
      if (!step || typeof step !== 'object') return false;
      if (step.type === 'text') return isRenderableAssistantTextStep(step);
      return true;
    });
  }

  function splitAssistantDisplaySteps(steps) {
    const items = getRenderableAssistantSteps(steps);
    if (items.length === 0) return { processSteps: [], finalStep: null };
    const last = items[items.length - 1];
    if (isRenderableAssistantTextStep(last)) {
      return {
        processSteps: items.slice(0, -1),
        finalStep: last,
      };
    }
    return {
      processSteps: items,
      finalStep: null,
    };
  }

  function ensureAssistantOutputRoot(bubble) {
    let root = bubble.querySelector('.assistant-output');
    if (!root) {
      root = document.createElement('div');
      root.className = 'assistant-output';
      bubble.appendChild(root);
    }
    return root;
  }

  function normalizeAssistantOutputOrder(root) {
    if (!root) return;
    const processDetails = root.querySelector('.assistant-process');
    const finalDiv = root.querySelector('.assistant-final');
    if (processDetails && root.firstElementChild !== processDetails) {
      root.insertBefore(processDetails, root.firstChild);
    }
    if (finalDiv && processDetails && finalDiv.previousElementSibling !== processDetails) {
      root.insertBefore(finalDiv, processDetails.nextElementSibling);
    }
  }

  function ensureAssistantFinalContainer(bubble) {
    const root = ensureAssistantOutputRoot(bubble);
    let finalDiv = root.querySelector('.assistant-final');
    if (!finalDiv) {
      finalDiv = document.createElement('div');
      finalDiv.className = 'assistant-final';
      root.appendChild(finalDiv);
    }
    normalizeAssistantOutputOrder(root);
    return finalDiv;
  }

  function ensureAssistantProcessContainer(bubble) {
    const root = ensureAssistantOutputRoot(bubble);
    let details = root.querySelector('.assistant-process');
    if (!details) {
      details = document.createElement('details');
      details.className = 'assistant-process';

      const summary = document.createElement('summary');
      summary.className = 'assistant-process-summary';

      const main = document.createElement('span');
      main.className = 'assistant-process-summary-main';

      const label = document.createElement('span');
      label.className = 'assistant-process-label';
      main.appendChild(label);

      const meta = document.createElement('span');
      meta.className = 'assistant-process-meta';
      main.appendChild(meta);

      const state = document.createElement('span');
      state.className = 'assistant-process-state';

      summary.appendChild(main);
      summary.appendChild(state);

      const body = document.createElement('div');
      body.className = 'assistant-process-body';

      const stepsDiv = document.createElement('div');
      stepsDiv.className = 'assistant-process-steps assistant-steps';
      body.appendChild(stepsDiv);

      details.appendChild(summary);
      details.appendChild(body);
      root.appendChild(details);
    }

    normalizeAssistantOutputOrder(root);

    return {
      details,
      label: details.querySelector('.assistant-process-label'),
      meta: details.querySelector('.assistant-process-meta'),
      state: details.querySelector('.assistant-process-state'),
      stepsDiv: details.querySelector('.assistant-process-steps'),
    };
  }

  function createAssistantTextStepElement(text = '') {
    const step = document.createElement('div');
    step.className = 'assistant-step assistant-step-text';
    step.dataset.stepType = 'text';
    const textDiv = document.createElement('div');
    textDiv.className = 'msg-text';
    textDiv.innerHTML = renderMarkdown(text);
    step.appendChild(textDiv);
    return step;
  }

  function setAssistantTextStepContent(step, text) {
    const textDiv = step.querySelector('.msg-text');
    if (textDiv) textDiv.innerHTML = renderMarkdown(text);
  }

  function createAssistantToolStepElement(tool) {
    const step = document.createElement('div');
    step.className = 'assistant-step assistant-step-tool';
    step.dataset.stepType = 'tool';
    step.appendChild(createToolCallElement(tool.id || `tool-${Math.random().toString(36).slice(2)}`, tool, !!tool.done));
    return step;
  }

  function appendAssistantStepElement(container, step) {
    if (!container || !step || typeof step !== 'object') return;
    if (step.type === 'text') {
      if (!isRenderableAssistantTextStep(step)) return;
      container.appendChild(createAssistantTextStepElement(step.content));
      return;
    }
    container.appendChild(createAssistantToolStepElement(step));
  }

  function getAssistantFinalTextStep(bubble) {
    const finalDiv = bubble ? bubble.querySelector('.assistant-final') : null;
    const last = finalDiv ? finalDiv.lastElementChild : null;
    if (last && last.dataset.stepType === 'text') return last;
    return null;
  }

  function assistantTextStepHasMeaningfulText(step) {
    const textDiv = step?.querySelector('.msg-text');
    return !!(textDiv && !textDiv.querySelector('.typing-indicator') && textDiv.textContent.trim());
  }

  function assistantTextStepHasDisplayContent(step) {
    const textDiv = step?.querySelector('.msg-text');
    return !!(textDiv && (textDiv.textContent.trim() || textDiv.querySelector('.typing-indicator')));
  }

  function promoteProcessTextStepsToFinalIfNeeded(bubble, options = {}) {
    if (!bubble) return;
    const complete = options.complete === true;
    const running = options.running === true && !complete;
    if (running) return;

    const finalDiv = options.finalDiv || ensureAssistantFinalContainer(bubble);
    const process = options.process || ensureAssistantProcessContainer(bubble);
    const hasFinal = Array.from(finalDiv.children).some((child) => assistantTextStepHasDisplayContent(child));
    if (hasFinal) return;

    const textSteps = Array.from(process.stepsDiv.children).filter((child) =>
      child?.dataset?.stepType === 'text' && assistantTextStepHasMeaningfulText(child)
    );
    if (textSteps.length === 0) return;

    textSteps.forEach((step) => finalDiv.appendChild(step));
  }

  function updateAssistantBubbleLayout(bubble, options = {}) {
    if (!bubble) return;
    const finalDiv = ensureAssistantFinalContainer(bubble);
    const process = ensureAssistantProcessContainer(bubble);
    const complete = options.complete === true;
    const running = options.running === true && !complete;
    const elapsedMs = normalizeElapsedDuration(options.elapsedMs)
      ?? (running ? getGenerationElapsedMs() : null);

    promoteProcessTextStepsToFinalIfNeeded(bubble, { complete, running, finalDiv, process });

    const processCount = process.stepsDiv ? process.stepsDiv.childElementCount : 0;
    const hasProcess = processCount > 0;
    const hasFinal = Array.from(finalDiv.children).some((child) => assistantTextStepHasDisplayContent(child));

    finalDiv.hidden = !hasFinal;
    process.details.hidden = !hasProcess;
    process.details.dataset.state = running ? 'running' : 'done';

    if (hasProcess) {
      if (process.label) {
        process.label.textContent = running
          ? (generationKind === 'compacting' ? '压缩上下文' : '处理中')
          : (hasFinal ? '查看过程' : '过程');
      }
      if (process.meta) {
        process.meta.textContent = elapsedMs === null
          ? `${processCount} 步`
          : `${processCount} 步 · 已运行：${formatElapsedDuration(elapsedMs)}`;
      }
      if (process.state) {
        process.state.textContent = running
          ? (generationKind === 'compacting' ? '压缩中' : '运行中')
          : '已完成';
      }
      process.details.open = running || !hasFinal;
    } else {
      process.details.removeAttribute('open');
    }

    const root = bubble.querySelector('.assistant-output');
    if (root) {
      normalizeAssistantOutputOrder(root);
      root.classList.toggle('assistant-output--process-only', hasProcess && !hasFinal);
    }
  }

  function removeTrailingEmptyAssistantTextStep(streamEl) {
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    const last = getAssistantFinalTextStep(bubble);
    if (!last || assistantTextStepHasMeaningfulText(last)) return;
    last.remove();
    updateAssistantBubbleLayout(bubble, { complete: false, running: true });
  }

  function moveStreamingFinalTextToProcess(streamEl) {
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    const last = getAssistantFinalTextStep(bubble);
    if (!last) return;
    if (!assistantTextStepHasMeaningfulText(last)) {
      last.remove();
      updateAssistantBubbleLayout(bubble, { complete: false, running: true });
      return;
    }
    const process = ensureAssistantProcessContainer(bubble);
    process.stepsDiv.appendChild(last);
    updateAssistantBubbleLayout(bubble, { complete: false, running: true });
  }

  function ensureStreamingTextStep(streamEl) {
    if (!streamEl) return null;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return null;
    const finalDiv = ensureAssistantFinalContainer(bubble);
    const last = finalDiv.lastElementChild;
    if (last && last.dataset.stepType === 'text') return last;
    const step = createAssistantTextStepElement('');
    finalDiv.appendChild(step);
    updateAssistantBubbleLayout(bubble, { complete: false, running: true });
    return step;
  }

  function showStreamingThinkingIndicator() {
    if (!isGenerating) return;
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    ensureStreamingTextStep(streamEl);
    scrollToBottomIfNeeded();
    scheduleMessageLocatorUpdate();
  }

  function renderAssistantStepsIntoBubble(bubble, steps, attachments = [], options = {}) {
    if (!bubble) return;
    bubble.innerHTML = '';
    const finalDiv = ensureAssistantFinalContainer(bubble);
    const process = ensureAssistantProcessContainer(bubble);
    const { processSteps, finalStep } = splitAssistantDisplaySteps(steps);

    process.stepsDiv.innerHTML = '';
    processSteps.forEach((step) => appendAssistantStepElement(process.stepsDiv, step));

    finalDiv.innerHTML = '';
    if (finalStep) {
      appendAssistantStepElement(finalDiv, finalStep);
    }

    updateAssistantBubbleLayout(bubble, options);
    if (attachments.length > 0) {
      bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
    }
  }

  function cloneResendAttachments(attachments) {
    return Array.isArray(attachments) ? attachments.map((attachment) => ({ ...attachment })) : [];
  }

  function syncLastUserResendAction() {
    const messageNodes = Array.from(messagesDiv.children).filter((node) => node.classList && node.classList.contains('msg'));
    messageNodes.forEach((node) => {
      const btn = node.querySelector('.msg-resend-btn');
      if (!btn) return;
      btn.hidden = true;
      btn.disabled = true;
    });
    const lastMessage = messageNodes[messageNodes.length - 1];
    if (!lastMessage || !lastMessage.classList.contains('user')) return;
    const lastBtn = lastMessage.querySelector('.msg-resend-btn');
    if (!lastBtn) return;
    lastBtn.hidden = false;
    lastBtn.disabled = isGenerating || !currentSessionId;
  }

  function resendUserMessage(payload) {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const attachments = cloneResendAttachments(payload?.attachments || []);
    if ((!text.trim() && attachments.length === 0) || !currentSessionId || isGenerating) return;

    hideCmdMenu();
    hideOptionPicker();
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const nextPayload = { text, attachments: cloneResendAttachments(attachments) };
    messagesDiv.appendChild(createMsgElement('user', text, attachments, { resendPayload: nextPayload }));
    currentSessionMessages.push({ role: 'user', content: text, attachments: cloneResendAttachments(attachments) });
    trimRenderedMessages();
    updateContextUsageDisplay();
    syncLastUserResendAction();
    syncRenderedMessageIndexes();
    scheduleMessageLocatorUpdate();
    scrollToBottom();

    send({ type: 'message', text, attachments, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    startGenerating();
  }

  function createMsgElement(role, content, attachments = [], options = {}) {
    const { resendPayload = null } = options;
    const div = document.createElement('div');
    div.className = `msg ${role}${role === 'assistant' ? ' agent-' + currentAgent : ''}`;

    if (role === 'system') {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = content;
      div.appendChild(bubble);
      return div;
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (role === 'user') {
      avatar.textContent = 'U';
    } else {
      avatar.innerHTML = getAgentAvatarHtml(currentAgent);
    }

    const main = document.createElement('div');
    main.className = 'msg-main';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'user') {
      if (content) {
        const textNode = document.createElement('div');
        textNode.className = 'msg-text';
        textNode.style.whiteSpace = 'pre-wrap';
        textNode.textContent = content;
        bubble.appendChild(textNode);
      }
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    } else {
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    }

    main.appendChild(bubble);
    if (role === 'user' && resendPayload) {
      div._resendPayload = deepClone(resendPayload);
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const resendBtn = document.createElement('button');
      resendBtn.type = 'button';
      resendBtn.className = 'msg-resend-btn';
      resendBtn.textContent = '重新发送';
      resendBtn.hidden = true;
      resendBtn.disabled = true;
      resendBtn.addEventListener('click', () => resendUserMessage(div._resendPayload));
      actions.appendChild(resendBtn);
      main.appendChild(actions);
    }

    div.appendChild(avatar);
    div.appendChild(main);
    return div;
  }

  let renderEpoch = 0;

  function toolKind(tool) {
    return tool?.kind || tool?.meta?.kind || '';
  }

  function toolTitle(tool) {
    if (tool?.meta?.title) return tool.meta.title;
    return tool?.name || 'Tool';
  }

  function toolSubtitle(tool) {
    if (tool?.meta?.subtitle) return tool.meta.subtitle;
    if (toolKind(tool) === 'command_execution') {
      return tool?.input?.command || '';
    }
    return '';
  }

  function stringifyToolValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toolStateLabel(tool, done) {
    if (!done) return 'Running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number') {
      return tool.meta.exitCode === 0 ? '' : `Exit ${tool.meta.exitCode}`;
    }
    return 'Done';
  }

  function toolStateClass(tool, done) {
    if (!done) return 'running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number' && tool.meta.exitCode !== 0) {
      return 'error';
    }
    return 'done';
  }

  function applyToolSummary(summary, tool, done) {
    summary.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = `tool-call-icon ${done ? 'done' : 'running'}`;

    const main = document.createElement('span');
    main.className = 'tool-call-summary-main';
    const label = document.createElement('span');
    label.className = 'tool-call-label';
    label.textContent = toolTitle(tool);
    main.appendChild(label);

    const subtitleText = toolSubtitle(tool);
    if (subtitleText) {
      const subtitle = document.createElement('span');
      subtitle.className = 'tool-call-subtitle';
      subtitle.textContent = subtitleText;
      main.appendChild(subtitle);
    }

    const stateLabel = toolStateLabel(tool, done);

    summary.appendChild(icon);
    summary.appendChild(main);
    if (stateLabel) {
      const state = document.createElement('span');
      state.className = `tool-call-state ${toolStateClass(tool, done)}`;
      state.textContent = stateLabel;
      summary.appendChild(state);
    }
  }

  function buildStructuredToolSection(labelText, bodyText) {
    const section = document.createElement('div');
    section.className = 'tool-call-section';
    const label = document.createElement('div');
    label.className = 'tool-call-section-label';
    label.textContent = labelText;
    const pre = document.createElement('pre');
    pre.className = 'tool-call-code';
    pre.textContent = bodyText;
    section.appendChild(label);
    section.appendChild(pre);
    return section;
  }

  function buildFileChangeList(changes) {
    const list = document.createElement('div');
    list.className = 'file-change-list';
    (Array.isArray(changes) ? changes : []).forEach((change) => {
      const row = document.createElement('div');
      row.className = 'file-change-row';
      row.title = change.path || '';

      const action = document.createElement('span');
      action.className = 'file-change-action';
      action.textContent = change.kind === 'create' ? '已新增' : (change.kind === 'delete' ? '已删除' : '已编辑');

      const name = document.createElement('span');
      name.className = 'file-change-name';
      name.textContent = String(change.path || '').split(/[\\/]/).filter(Boolean).pop() || change.path || '未知文件';

      const stats = document.createElement('span');
      stats.className = 'file-change-stats';
      if (Number.isFinite(change.additions)) {
        const additions = document.createElement('span');
        additions.className = 'file-change-additions';
        additions.textContent = `+${change.additions}`;
        stats.appendChild(additions);
      }
      if (Number.isFinite(change.deletions)) {
        const deletions = document.createElement('span');
        deletions.className = 'file-change-deletions';
        deletions.textContent = `-${change.deletions}`;
        stats.appendChild(deletions);
      }

      row.appendChild(action);
      row.appendChild(name);
      row.appendChild(stats);
      list.appendChild(row);
    });
    return list;
  }

  function buildAssistantFileChanges(changes) {
    const initialVisibleCount = 3;
    const section = document.createElement('section');
    section.className = 'assistant-file-changes';

    const header = document.createElement('header');
    header.className = 'assistant-file-changes-header';
    const icon = document.createElement('span');
    icon.className = 'assistant-file-changes-icon';
    icon.textContent = '⊞';
    icon.setAttribute('aria-hidden', 'true');
    const summary = document.createElement('div');
    summary.className = 'assistant-file-changes-summary';
    const title = document.createElement('div');
    title.className = 'assistant-file-changes-title';
    title.textContent = `已编辑 ${changes.length} 个文件`;
    const totals = document.createElement('div');
    totals.className = 'assistant-file-changes-totals';
    const additions = changes.reduce((sum, change) => sum + (Number.isFinite(change.additions) ? change.additions : 0), 0);
    const deletions = changes.reduce((sum, change) => sum + (Number.isFinite(change.deletions) ? change.deletions : 0), 0);
    if (additions > 0) {
      const value = document.createElement('span');
      value.className = 'file-change-additions';
      value.textContent = `+${additions}`;
      totals.appendChild(value);
    }
    if (deletions > 0) {
      const value = document.createElement('span');
      value.className = 'file-change-deletions';
      value.textContent = `-${deletions}`;
      totals.appendChild(value);
    }
    summary.append(title, totals);
    header.append(icon, summary);

    const list = document.createElement('div');
    list.className = 'assistant-file-change-list';
    const rows = changes.map((change, index) => {
      const row = document.createElement('div');
      row.className = 'assistant-file-change-row';
      row.title = change.path || '';
      row.hidden = index >= initialVisibleCount;
      const filePath = document.createElement('span');
      filePath.className = 'assistant-file-change-path';
      const displayPath = gitWorkspaceView.splitFileDisplayPath(change.path || '未知文件');
      if (displayPath.directory) {
        const directory = document.createElement('span');
        directory.className = 'assistant-file-change-directory';
        directory.textContent = displayPath.directory;
        filePath.appendChild(directory);
      }
      const filename = document.createElement('strong');
      filename.className = 'assistant-file-change-filename';
      filename.textContent = displayPath.filename;
      filePath.appendChild(filename);
      const stats = document.createElement('span');
      stats.className = 'file-change-stats';
      if (Number.isFinite(change.additions)) {
        const value = document.createElement('span');
        value.className = 'file-change-additions';
        value.textContent = `+${change.additions}`;
        stats.appendChild(value);
      }
      if (Number.isFinite(change.deletions)) {
        const value = document.createElement('span');
        value.className = 'file-change-deletions';
        value.textContent = `-${change.deletions}`;
        stats.appendChild(value);
      }
      row.append(filePath, stats);
      list.appendChild(row);
      return row;
    });

    section.append(header, list);
    if (changes.length > initialVisibleCount) {
      const hiddenCount = changes.length - initialVisibleCount;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'assistant-file-changes-toggle';
      const label = document.createElement('span');
      const chevron = document.createElement('span');
      chevron.className = 'assistant-file-changes-chevron';
      chevron.textContent = '⌄';
      let expanded = false;
      const updateExpandedState = () => {
        rows.forEach((row, index) => { row.hidden = !expanded && index >= initialVisibleCount; });
        label.textContent = expanded ? '收起文件' : `再显示 ${hiddenCount} 个文件`;
        toggle.classList.toggle('expanded', expanded);
        toggle.setAttribute('aria-expanded', String(expanded));
      };
      toggle.append(label, chevron);
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        updateExpandedState();
      });
      updateExpandedState();
      section.appendChild(toggle);
    }
    return section;
  }

  function appendAssistantFileChanges(messageEl, steps) {
    if (!messageEl) return;
    messageEl.querySelector('.assistant-file-changes')?.remove();
    const changes = gitWorkspaceView.collectAssistantFileChanges(steps, currentCwd || '');
    if (changes.length === 0) return;
    const main = messageEl.querySelector('.msg-main');
    if (!main) return;

    main.appendChild(buildAssistantFileChanges(changes));
  }

	  function buildMsgElement(m, options = {}) {
	    const { allowResend = false, messageIndex = null } = options;
	    const resendPayload = allowResend && m.role === 'user'
	      ? { text: m.content || '', attachments: cloneResendAttachments(m.attachments || []) }
	      : null;
	    const el = createMsgElement(
	      m.role,
	      m.role === 'assistant' ? '' : m.content,
	      m.role === 'assistant' ? [] : (m.attachments || []),
	      { resendPayload }
	    );
	    if (Number.isInteger(messageIndex)) el.dataset.messageIndex = String(messageIndex);
	    if (m.role === 'assistant') {
	      const bubble = el.querySelector('.msg-bubble');
	      const steps = getAssistantMessageSteps(m);
	      renderAssistantStepsIntoBubble(bubble, steps, m.attachments || [], {
	        complete: true,
	        running: false,
	        elapsedMs: m.durationMs,
	      });
	      appendAssistantFileChanges(el, steps);
	    }
	    return el;
	  }

  function renderMessages(messages, options = {}) {
    currentSessionMessages = cloneMessages(messages || []);
    renderedMessageStart = 0;
    localHistoryLoading = false;
    autoStickToBottom = true;
    renderEpoch++;
    const epoch = renderEpoch;
    messagesDiv.innerHTML = '';
    if (messages.length === 0) {
      messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
      syncLastUserResendAction();
      updateContextUsageDisplay();
      scheduleMessageLocatorUpdate();
      return;
    }
    if (options.immediate) {
      const frag = document.createDocumentFragment();
      messages.forEach((message, index) => frag.appendChild(buildMsgElement(message, { allowResend: index === messages.length - 1, messageIndex: index })));
      messagesDiv.appendChild(frag);
      trimRenderedMessages();
      syncLastUserResendAction();
      updateContextUsageDisplay();
      scrollToBottom();
      scheduleMessageLocatorUpdate();
      return;
    }
    // Batch render: last 10 first, then next 20, then the rest
    const batches = [];
    const len = messages.length;
    if (len <= 10) {
      batches.push([0, len]);
    } else if (len <= 30) {
      batches.push([len - 10, len]);
      batches.push([0, len - 10]);
    } else {
      batches.push([len - 10, len]);
      batches.push([len - 30, len - 10]);
      batches.push([0, len - 30]);
    }

    // Render first batch immediately
    const frag0 = document.createDocumentFragment();
    for (let i = batches[0][0]; i < batches[0][1]; i++) frag0.appendChild(buildMsgElement(messages[i], { allowResend: i === len - 1, messageIndex: i }));
    messagesDiv.appendChild(frag0);
    renderedMessageStart = batches[0][0];
    syncLastUserResendAction();
    updateContextUsageDisplay();
    scrollToBottom();
    scheduleMessageLocatorUpdate();

    // Render remaining batches asynchronously, prepending each
    // Use scrollHeight delta to keep current view position stable after prepend
    let delay = 0;
    for (let b = 1; b < batches.length; b++) {
      const [start, end] = batches[b];
      delay += 16;
      setTimeout(() => {
        if (renderEpoch !== epoch) return; // session switched, abort stale render
        const prevHeight = messagesDiv.scrollHeight;
        const prevScrollTop = messagesDiv.scrollTop;
        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) frag.appendChild(buildMsgElement(messages[i], { allowResend: i === len - 1, messageIndex: i }));
        messagesDiv.insertBefore(frag, messagesDiv.firstChild);
        renderedMessageStart = Math.min(renderedMessageStart, start);
        // Compensate scrollTop so visible area stays unchanged
        messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
        syncLastUserResendAction();
        updateScrollbar();
        scheduleMessageLocatorUpdate();
      }, delay);
    }
  }

  function normalizeAskUserInput(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    return input;
  }

  function extractAskUserQuestions(input) {
    const parsed = normalizeAskUserInput(input);
    if (!parsed || !Array.isArray(parsed.questions)) return [];
    return parsed.questions;
  }

  function appendAskOptionToInput(question, option) {
    const header = (question?.header || '').trim() || '问题';
    const line = `【${header}】${option?.label || ''}`;
    const current = msgInput.value.trim();
    msgInput.value = current ? `${current}\n${line}` : line;
    autoResize();
    msgInput.focus();
  }

  function createAskUserQuestionView(questions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ask-user-question';

    questions.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'ask-question-card';

      const header = document.createElement('div');
      header.className = 'ask-question-header';
      header.textContent = `${idx + 1}. ${q.header || '问题'}`;
      card.appendChild(header);

      const body = document.createElement('div');
      body.className = 'ask-question-text';
      body.textContent = q.question || '';
      card.appendChild(body);

      if (Array.isArray(q.options) && q.options.length > 0) {
        const hasDesc = q.options.some(o => o.description);

        // 左右分栏容器
        const layout = document.createElement('div');
        layout.className = 'ask-options-layout' + (hasDesc ? ' has-preview' : '');

        const opts = document.createElement('div');
        opts.className = 'ask-question-options';

        // 右侧预览区（仅在有 description 时创建）
        const preview = hasDesc ? document.createElement('div') : null;
        if (preview) {
          preview.className = 'ask-option-preview';
          // 默认显示第一项
          preview.textContent = q.options[0].description || '';
        }

        // 当前选中项（移动端 tap-to-preview 状态）
        let selectedOpt = null;
        let selectedBtn = null;

        q.options.forEach((opt, i) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'ask-option-item';

          const title = document.createElement('div');
          title.className = 'ask-option-label';
          title.textContent = `${i + 1}. ${opt.label || ''}`;
          item.appendChild(title);

          // 桌面：hover 切换预览
          if (preview) {
            item.addEventListener('mouseenter', () => {
              preview.textContent = opt.description || '';
            });
          }

          item.addEventListener('click', (e) => {
            const isTouch = item.dataset.touchActivated === '1';
            item.dataset.touchActivated = '';

            if (isTouch) {
              // 移动端：第一次 tap = 选中预览，不发送
              if (selectedBtn !== item) {
                if (selectedBtn) selectedBtn.classList.remove('ask-option-selected');
                selectedBtn = item;
                selectedOpt = opt;
                item.classList.add('ask-option-selected');
                if (preview) preview.textContent = opt.description || '';
                return;
              }
              // 第二次 tap 同一项 = 发送
            }

            // 桌面直接发送
            appendAskOptionToInput(q, opt);
          });

          item.addEventListener('touchstart', () => {
            item.dataset.touchActivated = '1';
          }, { passive: true });

          opts.appendChild(item);
        });

        layout.appendChild(opts);
        if (preview) {
          layout.appendChild(preview);
          // 预览区最小高度 = 左侧选项列表总高度（渲染后同步）
          requestAnimationFrame(() => {
            preview.style.minHeight = opts.offsetHeight + 'px';
          });
        }

        // 移动端确认按钮
        if (hasDesc) {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'ask-confirm-btn';
          confirmBtn.textContent = '确认选择';
          confirmBtn.addEventListener('click', () => {
            if (selectedOpt) {
              appendAskOptionToInput(q, selectedOpt);
            } else if (q.options.length > 0) {
              appendAskOptionToInput(q, q.options[0]);
            }
          });
          layout.appendChild(confirmBtn);
        }

        card.appendChild(layout);
      }

      wrapper.appendChild(card);
    });

    return wrapper;
  }

  function buildToolContentElement(name, input) {
    const tool = typeof name === 'object' && name !== null ? name : { name, input };
    const effectiveName = tool.name || name;
    const effectiveInput = tool.input !== undefined ? tool.input : input;
    const effectiveResult = tool.result;
    const kind = toolKind(tool);
    if (effectiveName === 'AskUserQuestion') {
      const questions = extractAskUserQuestions(effectiveInput);
      if (questions.length > 0) {
        return createAskUserQuestionView(questions);
      }
    }

    if (kind === 'command_execution') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tool-call-content command';
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      const commandText = effectiveInput?.command || tool?.meta?.subtitle || '';
      if (commandText) stack.appendChild(buildStructuredToolSection('Command', commandText));
      if (effectiveResult) {
        stack.appendChild(buildStructuredToolSection('Output', stringifyToolValue(effectiveResult)));
      } else if (!tool.done) {
        const empty = document.createElement('div');
        empty.className = 'tool-call-empty';
        empty.textContent = '等待命令输出…';
        stack.appendChild(empty);
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    if (kind === 'reasoning') {
      const content = document.createElement('div');
      content.className = 'tool-call-content reasoning';
      const text = stringifyToolValue(effectiveResult || effectiveInput);
      content.innerHTML = text ? renderMarkdown(text) : '<div class="tool-call-empty">暂无推理内容</div>';
      return content;
    }

    if (kind === 'file_change' || kind === 'mcp_tool_call') {
      const wrapper = document.createElement('div');
      wrapper.className = `tool-call-content ${kind === 'file_change' ? 'file-change' : ''}`.trim();
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      if (kind === 'file_change' && Array.isArray(tool?.meta?.changes) && tool.meta.changes.length > 0) {
        stack.appendChild(buildFileChangeList(tool.meta.changes));
        wrapper.appendChild(stack);
        return wrapper;
      }
      if (tool?.meta?.subtitle) {
        stack.appendChild(buildStructuredToolSection(kind === 'file_change' ? 'Target' : 'Tool', tool.meta.subtitle));
      }
      const payloadText = stringifyToolValue(effectiveResult || effectiveInput);
      if (payloadText) {
        stack.appendChild(buildStructuredToolSection('Payload', payloadText));
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    const inputStr = stringifyToolValue(effectiveResult || effectiveInput);
    const content = document.createElement('div');
    content.className = 'tool-call-content';
    content.textContent = inputStr;
    return content;
  }

  function createToolCallElement(toolUseId, tool, done) {
    const details = document.createElement('details');
    details.className = 'tool-call';
    details.id = `tool-${toolUseId}`;
    details.dataset.toolName = tool.name || '';
    if (toolKind(tool)) {
      details.dataset.toolKind = toolKind(tool);
      details.classList.add(`codex-${toolKind(tool).replace(/_/g, '-')}`);
    }
    // Default expansion policy:
    // - Always open AskUserQuestion (it is an actionable UI).
    // - For non coding-agent sessions, auto-open in-flight command execution so users can watch output.
    // - For Codex/Kimi/OpenCode sessions, keep everything collapsed by default (less noise), including in-flight commands.
    const agent = normalizeAgent(currentAgent);
    const kind = toolKind(tool);
    const keepCollapsed = agent === 'codex' || agent === 'kimi' || agent === 'opencode';
    if (tool.name === 'AskUserQuestion') {
      details.open = true;
    } else if (kind === 'file_change') {
      details.open = true;
    } else if (!keepCollapsed && !done && kind === 'command_execution') {
      details.open = true;
    }

    const summary = document.createElement('summary');
    applyToolSummary(summary, tool, done);
    details.appendChild(summary);
    details.appendChild(buildToolContentElement({ ...tool, done }));
    return details;
  }

  function appendToolCall(toolUseId, name, input, done, kind = null, meta = null) {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    if (pendingText) {
      flushRender();
      pendingText = '';
    } else {
      removeTrailingEmptyAssistantTextStep(streamEl);
    }
    moveStreamingFinalTextToProcess(streamEl);
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    const stepsDiv = ensureAssistantProcessContainer(bubble).stepsDiv;
    const tool = { id: toolUseId, name, input, kind, meta, done };
    stepsDiv.appendChild(createAssistantToolStepElement(tool));
    updateAssistantBubbleLayout(bubble, { complete: false, running: true });
    scrollToBottomIfNeeded();
    scheduleMessageLocatorUpdate();
  }

  function updateToolCall(toolUseId, result) {
    const el = document.getElementById(`tool-${toolUseId}`);
    if (!el) return;
    const tool = activeToolCalls.get(toolUseId) || {
      id: toolUseId,
      name: el.dataset.toolName || '',
      kind: el.dataset.toolKind || null,
      done: true,
    };
    tool.done = true;
    if (result !== undefined) tool.result = result;
    const summary = el.querySelector('summary');
    if (summary) applyToolSummary(summary, tool, true);
    if (tool.name === 'AskUserQuestion') return;
    const nextContent = buildToolContentElement(tool);
    const content = el.querySelector('.tool-call-content');
    if (content) content.replaceWith(nextContent);
  }

  function getDeleteConfirmMessage(agent) {
    const normalized = normalizeAgent(agent);
    if (normalized === 'codex') {
      return '删除本会话将同步删除本地 Codex rollout 历史与线程记录，不可恢复。确认删除？';
    }
    if (normalized === 'kimi') {
      return '删除本会话只会移除 cc-web 中的 Kimi 会话记录，不会清理 ~/.kimi 下的原生会话。确认删除？';
    }
    if (normalized === 'opencode') {
      return '删除本会话将同步删除本地 OpenCode 会话记录，不可恢复。确认删除？';
    }
    return '删除本会话将同步删除本地 Claude 中的会话历史，不可恢复。确认删除？';
  }

  function showDangerConfirm(message, onConfirm, options = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '10002';
    const confirmLabel = options.confirmLabel || '确认删除';
    const skipLabel = options.skipLabel || '确认且不再提示';
    const enableSkip = options.enableSkip !== false;

    const box = document.createElement('div');
    box.className = 'settings-panel';
    box.innerHTML = `
      <div style="font-size:0.9em;color:var(--text-primary);margin-bottom:20px;line-height:1.7">${escapeHtml(message)}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="del-confirm-ok" style="width:100%;padding:10px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:0.95em;font-weight:600;cursor:pointer;font-family:inherit">${escapeHtml(confirmLabel)}</button>
        ${enableSkip ? `<button id="del-confirm-skip" style="width:100%;padding:9px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:0.85em;cursor:pointer;font-family:inherit">${escapeHtml(skipLabel)}</button>` : ''}
        <button id="del-confirm-cancel" style="width:100%;padding:9px;border:none;border-radius:10px;background:transparent;color:var(--text-muted);font-size:0.85em;cursor:pointer;font-family:inherit">取消</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => document.body.removeChild(overlay);
    box.querySelector('#del-confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
    if (enableSkip) {
      box.querySelector('#del-confirm-skip').addEventListener('click', () => {
        skipDeleteConfirm = true;
        localStorage.setItem('cc-web-skip-delete-confirm', '1');
        close();
        onConfirm();
      });
    }
    box.querySelector('#del-confirm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  function showDeleteConfirm(agent, onConfirm) {
    showDangerConfirm(getDeleteConfirmMessage(agent), onConfirm);
  }

  function performSessionDelete(session) {
    if (!session?.id) return;
    if (getLastSessionForAgent(currentAgent) === session.id) {
      localStorage.removeItem(getAgentSessionStorageKey(currentAgent));
    }
    selectedSessionIds.delete(session.id);
    invalidateSessionCache(session.id);
    send({ type: 'delete_session', sessionId: session.id });
    if (session.id === currentSessionId) {
      resetChatView(currentAgent);
    }
    updateSessionBulkActionBar();
  }

  function requestDeleteSession(session, options = {}) {
    if (!session?.id) return;
    if (skipDeleteConfirm || options.skipConfirm) {
      performSessionDelete(session);
    } else {
      showDeleteConfirm(session.agent, () => performSessionDelete(session));
    }
  }

  function deleteSessionsBatch(targetSessions, options = {}) {
    const items = Array.from(targetSessions || []).filter((session) => session?.id);
    if (!items.length) return;
    const runDelete = () => {
      items.forEach((session) => requestDeleteSession(session, { skipConfirm: true }));
      if (options.exitMultiSelect !== false) {
        setSessionMultiSelectMode(false);
      } else {
        renderSessionList();
      }
    };
    if (skipDeleteConfirm || options.skipConfirm) {
      runDelete();
      return;
    }
    const message = options.message || `确认删除选中的 ${items.length} 个会话？此操作不可恢复。`;
    showDangerConfirm(message, runDelete, {
      confirmLabel: options.confirmLabel || '确认删除',
      enableSkip: false,
    });
  }

  function appendSystemMessage(message) {
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    messagesDiv.appendChild(createMsgElement('system', message));
    currentSessionMessages.push({ role: 'system', content: message });
    trimRenderedMessages();
    updateContextUsageDisplay();
    syncLastUserResendAction();
    syncRenderedMessageIndexes();
    scheduleMessageLocatorUpdate();
    scrollToBottom();
  }

  function appendError(message) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="msg-bubble" style="border-color:var(--danger);color:var(--danger)">⚠ ${escapeHtml(message)}</div>`;
    messagesDiv.appendChild(div);
    currentSessionMessages.push({ role: 'system', content: `⚠ ${message}` });
    trimRenderedMessages();
    updateContextUsageDisplay();
    syncLastUserResendAction();
    syncRenderedMessageIndexes();
    scheduleMessageLocatorUpdate();
    scrollToBottom();
  }

  function isNearMessageBottom(threshold = 48) {
    return messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight <= threshold;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
      autoStickToBottom = true;
      updateScrollbar();
      scheduleMessageLocatorUpdate();
    });
  }

  function scrollToBottomIfNeeded() {
    if (!autoStickToBottom) {
      updateScrollbar();
      return;
    }
    scrollToBottom();
  }

  // --- Custom Scrollbar ---
  const scrollbarEl = document.getElementById('custom-scrollbar');
  const thumbEl = document.getElementById('custom-scrollbar-thumb');

  function updateScrollbar() {
    if (!scrollbarEl || !thumbEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesDiv;
    if (scrollHeight <= clientHeight) {
      thumbEl.style.display = 'none';
      return;
    }
    thumbEl.style.display = '';
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * (trackH - thumbH);
    thumbEl.style.height = thumbH + 'px';
    thumbEl.style.top = thumbTop + 'px';
  }

  messagesDiv.addEventListener('scroll', () => {
    autoStickToBottom = isNearMessageBottom();
    updateScrollbar();
    scheduleMessageLocatorUpdate();
    maybeLoadMoreHistory();
    // 移动端：滚动时短暂显示滑块，停止后淡出
    scrollbarEl.classList.add('scrolling');
    clearTimeout(scrollbarEl._hideTimer);
    scrollbarEl._hideTimer = setTimeout(() => {
      if (!isDragging) scrollbarEl.classList.remove('scrolling');
    }, 1200);
  }, { passive: true });
  new ResizeObserver(updateScrollbar).observe(messagesDiv);

  // Drag logic
  let dragStartY = 0, dragStartScrollTop = 0, isDragging = false;

  function onDragStart(e) {
    isDragging = true;
    dragStartY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    dragStartScrollTop = messagesDiv.scrollTop;
    thumbEl.classList.add('dragging');
    scrollbarEl.classList.add('active');
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const dy = clientY - dragStartY;
    const { scrollHeight, clientHeight } = messagesDiv;
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const ratio = (scrollHeight - clientHeight) / (trackH - thumbH);
    messagesDiv.scrollTop = dragStartScrollTop + dy * ratio;
    e.preventDefault();
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    thumbEl.classList.remove('dragging');
    scrollbarEl.classList.remove('active');
  }

  thumbEl.addEventListener('mousedown', onDragStart);
  thumbEl.addEventListener('touchstart', onDragStart, { passive: false });
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchend', onDragEnd);

  updateScrollbar();


  function createSessionItemElement(s) {
    const agentBadge = renderSessionAgentBadge(s.agent);
    const item = document.createElement('div');
    const isSelected = selectedSessionIds.has(s.id);
    item.className = `session-item${s.id === currentSessionId ? ' active' : ''}${isSessionMultiSelectMode ? ' selecting' : ''}${isSelected ? ' selected' : ''}`;
    item.dataset.id = s.id;
    item.innerHTML = `
      ${isSessionMultiSelectMode ? `
        <label class="session-item-selector" title="选择会话">
          <input class="session-item-checkbox" type="checkbox" ${isSelected ? 'checked' : ''}>
        </label>
      ` : ''}
      <div class="session-item-main">
        <div class="session-item-title-row">
          ${agentBadge}
          <span class="session-item-title">${escapeHtml(s.title || 'Untitled')}</span>
          ${s.isRunning ? '<span class="session-item-status">运行中</span>' : ''}
        </div>
      </div>
      ${s.hasUnread ? '<span class="session-unread-dot"></span>' : ''}
      <span class="session-item-time">${timeAgo(s.updated)}</span>
      <div class="session-item-actions">
        <button class="session-item-btn edit" title="重命名">✎</button>
        <button class="session-item-btn delete" title="删除">×</button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      const target = e.target;
      if (isSessionMultiSelectMode) {
        if (target.classList.contains('edit') || target.classList.contains('delete')) {
          e.stopPropagation();
          return;
        }
        const nextSelected = !selectedSessionIds.has(s.id);
        if (nextSelected) selectedSessionIds.add(s.id);
        else selectedSessionIds.delete(s.id);
        renderSessionList();
        return;
      }
      if (target.classList.contains('delete')) {
        e.stopPropagation();
        requestDeleteSession(s);
        return;
      }
      if (target.classList.contains('edit')) {
        e.stopPropagation();
        startEditSessionTitle(item, s);
        return;
      }
      openSession(s.id);
    });

    return item;
  }

  function renderProjectGroup(group) {
    const collapsed = collapsedProjectKeys.has(group.key);
    const groupEl = document.createElement('section');
    groupEl.className = `session-project${collapsed ? ' collapsed' : ''}`;
    groupEl.dataset.projectKey = group.key;

    const header = document.createElement('div');
    header.className = 'session-project-header';
    header.innerHTML = `
      <button class="session-project-toggle" type="button" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? '展开项目' : '收起项目'}">
        <span class="session-project-folder" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
            ${collapsed ? '' : '<path d="M3 10h18"></path>'}
          </svg>
        </span>
        <span class="session-project-main">
          <span class="session-project-name">${escapeHtml(group.label)}</span>
          <span class="session-project-path">${escapeHtml(group.title)}</span>
        </span>
        <span class="session-project-count">${group.sessions.length}</span>
      </button>
      <div class="session-project-actions">
        <button class="session-project-action-btn session-project-new-btn" type="button" title="在此项目中新建对话" aria-label="在此项目中新建对话" ${group.key === UNGROUPED_PROJECT_KEY ? 'disabled' : ''}>+</button>
        <button class="session-project-action-btn session-project-clear-btn" type="button" title="清空此项目的对话" aria-label="清空此项目的对话" ${group.sessions.length === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5M14 11v5"></path>
          </svg>
        </button>
      </div>
    `;
    header.querySelector('.session-project-toggle').addEventListener('click', () => toggleProjectGroup(group.key));
    header.querySelector('.session-project-new-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      showProjectNewSessionModal(group);
    });
    header.querySelector('.session-project-clear-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      clearProjectSessions(group);
    });
    groupEl.appendChild(header);

    if (!collapsed) {
      const body = document.createElement('div');
      body.className = 'session-project-body';
      if (group.sessions.length === 0) {
        body.innerHTML = '<div class="session-project-empty">暂无对话</div>';
      }
      const displayLimit = projectSessionDisplayLimits.get(group.key) || INITIAL_PROJECT_SESSION_COUNT;
      group.sessions.slice(0, displayLimit).forEach((session) => body.appendChild(createSessionItemElement(session)));
      if (displayLimit < group.sessions.length) {
        const showMoreButton = document.createElement('button');
        showMoreButton.type = 'button';
        showMoreButton.className = 'session-project-show-more';
        showMoreButton.textContent = '显示更多';
        showMoreButton.title = `还有 ${group.sessions.length - displayLimit} 个对话`;
        showMoreButton.addEventListener('click', () => showMoreProjectSessions(group.key, group.sessions.length));
        body.appendChild(showMoreButton);
      }
      groupEl.appendChild(body);
    }
    return groupEl;
  }

  function renderSessionList() {
    sessionList.innerHTML = '';
    const visibleSessions = getVisibleSessions();
    syncSelectedSessionsWithVisible();
    updateSessionBulkActionBar();
    if (visibleSessions.length === 0 && projects.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = '暂无项目或对话，点击“新项目”或“新对话”开始。';
      sessionList.appendChild(empty);
      return;
    }

    const groups = groupSessionsByProject(visibleSessions);
    const currentProjectKeys = new Set(groups.map((group) => group.key));
    for (const projectKey of projectSessionDisplayLimits.keys()) {
      if (!currentProjectKeys.has(projectKey)) projectSessionDisplayLimits.delete(projectKey);
    }
    groups.forEach((group) => sessionList.appendChild(renderProjectGroup(group)));
  }

  function startEditSessionTitle(itemEl, session) {
    const titleEl = itemEl.querySelector('.session-item-title');
    const currentTitle = session.title || '';
    const input = document.createElement('input');
    input.className = 'session-item-edit-input';
    input.value = currentTitle;
    input.maxLength = 100;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Hide actions during edit
    const actions = itemEl.querySelector('.session-item-actions');
    const time = itemEl.querySelector('.session-item-time');
    if (actions) actions.style.display = 'none';
    if (time) time.style.display = 'none';

    function save() {
      const newTitle = input.value.trim() || currentTitle;
      if (newTitle !== currentTitle) {
        send({ type: 'rename_session', sessionId: session.id, title: newTitle });
      }
      // Restore
      const span = document.createElement('span');
      span.className = 'session-item-title';
      span.textContent = newTitle;
      input.replaceWith(span);
      if (actions) actions.style.display = '';
      if (time) time.style.display = '';
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });
  }

  function highlightActiveSession() {
    document.querySelectorAll('.session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === currentSessionId);
    });
  }

  // --- Header title editing (contenteditable) ---
  chatTitle.addEventListener('click', () => {
    if (!currentSessionId || chatTitle.contentEditable === 'true') return;
    const originalText = chatTitle.textContent;
    chatTitle.contentEditable = 'true';
    chatTitle.style.background = '#fff';
    chatTitle.style.outline = '1px solid var(--accent)';
    chatTitle.style.borderRadius = '6px';
    chatTitle.style.padding = '2px 8px';
    chatTitle.style.minWidth = '96px';
    chatTitle.style.whiteSpace = 'normal';
    chatTitle.style.overflow = 'visible';
    chatTitle.style.textOverflow = 'clip';
    chatTitle.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(chatTitle);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function finish(save) {
      chatTitle.contentEditable = 'false';
      chatTitle.style.background = '';
      chatTitle.style.outline = '';
      chatTitle.style.borderRadius = '';
      chatTitle.style.padding = '';
      chatTitle.style.minWidth = '';
      chatTitle.style.whiteSpace = '';
      chatTitle.style.overflow = '';
      chatTitle.style.textOverflow = '';
      const newTitle = chatTitle.textContent.trim() || originalText;
      chatTitle.textContent = newTitle;
      if (save && newTitle !== originalText && currentSessionId) {
        send({ type: 'rename_session', sessionId: currentSessionId, title: newTitle });
      }
    }

    chatTitle.addEventListener('blur', () => finish(true), { once: true });
    chatTitle.addEventListener('keydown', function handler(e) {
      if (e.key === 'Enter') { e.preventDefault(); chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
      if (e.key === 'Escape') { chatTitle.textContent = originalText; chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
    });
  });

  // --- Sidebar ---
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.hidden = false;
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.hidden = true;
  }

  function canOpenSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (sidebar.classList.contains('open')) return false;
    if (sessionLoadingOverlay && !sessionLoadingOverlay.hidden) return false;
    if (!chatMain || !target || !chatMain.contains(target)) return false;
    if (!app.hidden && target && target.closest('input, textarea, select, button, .modal-panel, .settings-panel, .option-picker, .cmd-menu')) {
      return false;
    }
    return true;
  }

  function canCloseSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (!sidebar.classList.contains('open')) return false;
    if (!target) return false;
    return sidebar.contains(target) || target === sidebarOverlay;
  }

  function handleSidebarSwipeStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (canCloseSidebarBySwipe(e.target)) {
      sidebarSwipe = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: true,
        mode: 'close',
      };
      return;
    }
    if (!canOpenSidebarBySwipe(e.target)) {
      sidebarSwipe = null;
      return;
    }
    sidebarSwipe = {
      startX: touch.clientX,
      startY: touch.clientY,
      active: true,
      mode: 'open',
    };
  }

  function handleSidebarSwipeMove(e) {
    if (!sidebarSwipe?.active || !e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - sidebarSwipe.startX;
    const deltaY = touch.clientY - sidebarSwipe.startY;
    if (Math.abs(deltaY) > SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT && Math.abs(deltaY) > Math.abs(deltaX)) {
      sidebarSwipe = null;
      return;
    }
    const horizontalIntent = sidebarSwipe.mode === 'open' ? deltaX > 12 : deltaX < -12;
    if (horizontalIntent && Math.abs(deltaY) < SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT) {
      e.preventDefault();
    }
  }

  function handleSidebarSwipeEnd(e) {
    if (!sidebarSwipe?.active) return;
    const touch = e.changedTouches && e.changedTouches[0];
    const endX = touch ? touch.clientX : sidebarSwipe.startX;
    const endY = touch ? touch.clientY : sidebarSwipe.startY;
    const deltaX = endX - sidebarSwipe.startX;
    const deltaY = endY - sidebarSwipe.startY;
    const shouldOpen = sidebarSwipe.mode === 'open' &&
      deltaX >= SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    const shouldClose = sidebarSwipe.mode === 'close' &&
      deltaX <= -SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    sidebarSwipe = null;
    if (shouldOpen) {
      openSidebar();
    } else if (shouldClose) {
      closeSidebar();
    }
  }

  // --- Slash Command Menu ---
  function showCmdMenu(filter) {
    const filtered = SLASH_COMMANDS.filter(c =>
      c.cmd.startsWith(filter) || c.desc.includes(filter.slice(1))
    );
    // Exact match first (fixes /mode vs /model ambiguity)
    filtered.sort((a, b) => (b.cmd === filter ? 1 : 0) - (a.cmd === filter ? 1 : 0));
    if (filtered.length === 0) {
      hideCmdMenu();
      return;
    }
    cmdMenuIndex = 0;
    cmdMenu.innerHTML = filtered.map((c, i) =>
      `<div class="cmd-item${i === 0 ? ' active' : ''}" data-cmd="${c.cmd}">
        <span class="cmd-item-cmd">${c.cmd}</span>
        <span class="cmd-item-desc">${c.desc}</span>
      </div>`
    ).join('');
    cmdMenu.hidden = false;

    // Click handlers
    cmdMenu.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', () => {
        const cmd = el.dataset.cmd;
        if (cmd === '/model') {
          hideCmdMenu();
          msgInput.value = '';
          showModelPicker();
          return;
        }
        if (cmd === '/mode') {
          hideCmdMenu();
          msgInput.value = '';
          showModePicker();
          return;
        }
        msgInput.value = cmd + ' ';
        hideCmdMenu();
        msgInput.focus();
      });
    });
  }

  function hideCmdMenu() {
    cmdMenu.hidden = true;
    cmdMenuIndex = -1;
  }

  function navigateCmdMenu(direction) {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (items.length === 0) return;
    items[cmdMenuIndex]?.classList.remove('active');
    cmdMenuIndex = (cmdMenuIndex + direction + items.length) % items.length;
    items[cmdMenuIndex]?.classList.add('active');
  }

  function selectCmdMenuItem() {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (cmdMenuIndex >= 0 && items[cmdMenuIndex]) {
      const cmd = items[cmdMenuIndex].dataset.cmd;
      if (cmd === '/model') {
        hideCmdMenu();
        msgInput.value = '';
        showModelPicker();
        return;
      }
      if (cmd === '/mode') {
        hideCmdMenu();
        msgInput.value = '';
        showModePicker();
        return;
      }
      msgInput.value = cmd + ' ';
      hideCmdMenu();
      msgInput.focus();
    }
  }

  // --- Option Picker (generic) ---
  function showOptionPicker(title, options, currentValue, onSelect) {
    hideOptionPicker();

    const overlay = document.createElement('div');
    overlay.className = 'option-picker-overlay';
    overlay.id = 'option-picker-overlay';

    const picker = document.createElement('div');
    picker.className = 'option-picker';
    picker.id = 'option-picker';

    const renderOption = (opt) => `
      <div class="option-picker-item${opt.value === currentValue ? ' active' : ''}" data-value="${escapeHtml(opt.value)}">
        <div class="option-picker-item-info">
          <div class="option-picker-item-label">${escapeHtml(opt.label)}</div>
          <div class="option-picker-item-desc">${escapeHtml(opt.desc)}</div>
        </div>
        ${opt.value === currentValue ? '<span class="option-picker-item-check">✓</span>' : ''}
      </div>`;
    const groups = new Map();
    options.forEach((option) => {
      const group = String(option.group || '');
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(option);
    });
    const hasGroups = Array.from(groups.keys()).some(Boolean);
    const optionMarkup = hasGroups
      ? Array.from(groups.entries()).map(([group, groupOptions]) => `
          <section class="option-picker-group">
            <div class="option-picker-group-title">${escapeHtml(group || '其他')}</div>
            ${groupOptions.map(renderOption).join('')}
          </section>`).join('')
      : options.map(renderOption).join('');

    picker.innerHTML = `
      <div class="option-picker-title">${escapeHtml(title)}</div>
      <div class="option-picker-list">
        ${optionMarkup}
      </div>
    `;
    overlay.appendChild(picker);
    document.body.appendChild(overlay);

    picker.querySelectorAll('.option-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        // Close current picker first so onSelect can safely open a nested picker.
        const v = el.dataset.value;
        hideOptionPicker();
        onSelect(v);
      });
    });

    overlay.addEventListener('click', _pickerOutsideClick);
    document.addEventListener('keydown', _pickerEscape);
  }

  function hideOptionPicker() {
    const overlay = document.getElementById('option-picker-overlay');
    const picker = document.getElementById('option-picker');
    if (overlay) overlay.removeEventListener('click', _pickerOutsideClick);
    if (overlay) overlay.remove();
    if (picker) picker.remove();
    document.removeEventListener('keydown', _pickerEscape);
  }

  function _pickerOutsideClick(e) {
    const picker = document.getElementById('option-picker');
    if (picker && e.target && e.target.id === 'option-picker-overlay' && !picker.contains(e.target)) {
      hideOptionPicker();
    }
  }

  function _pickerEscape(e) {
    if (e.key === 'Escape') {
      hideOptionPicker();
    }
  }

  function hideClickTip() {
    if (activeClickTip?.el) activeClickTip.el.remove();
    document.removeEventListener('click', handleClickTipOutside, true);
    document.removeEventListener('keydown', handleClickTipEscape);
    activeClickTip = null;
  }

  function handleClickTipOutside(e) {
    if (!activeClickTip) return;
    if (activeClickTip.anchor?.contains(e.target) || activeClickTip.el?.contains(e.target)) return;
    hideClickTip();
  }

  function handleClickTipEscape(e) {
    if (e.key === 'Escape') hideClickTip();
  }

  function positionClickTip(tip, arrow, anchor) {
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    const gap = 10;
    const tipRect = tip.getBoundingClientRect();
    const availableBelow = window.innerHeight - rect.bottom - margin;
    const availableAbove = rect.top - margin;
    const showAbove = availableBelow < tipRect.height + gap && availableAbove > availableBelow;
    const preferredTop = showAbove
      ? rect.top - tipRect.height - gap
      : rect.bottom + gap;
    const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - tipRect.height - margin));
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    tip.classList.toggle('is-above', showAbove);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    const arrowLeft = rect.left + rect.width / 2 - left - 5;
    arrow.style.left = `${Math.round(Math.max(10, Math.min(arrowLeft, tipRect.width - 20)))}px`;
  }

  function showClickTip(anchor, { title = '', body = '' } = {}) {
    if (!anchor || (!title && !body)) return;
    const sameAnchor = activeClickTip?.anchor === anchor;
    hideClickTip();
    if (sameAnchor) return;

    const tip = document.createElement('div');
    tip.className = 'click-tip';
    tip.setAttribute('role', 'dialog');
    const arrow = document.createElement('span');
    arrow.className = 'click-tip-arrow';
    tip.appendChild(arrow);
    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'click-tip-title';
      titleEl.textContent = title;
      tip.appendChild(titleEl);
    }
    if (body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'click-tip-body';
      bodyEl.textContent = body;
      tip.appendChild(bodyEl);
    }
    document.body.appendChild(tip);
    activeClickTip = { anchor, el: tip };
    positionClickTip(tip, arrow, anchor);
    document.addEventListener('click', handleClickTipOutside, true);
    document.addEventListener('keydown', handleClickTipEscape);
  }

	  function showModelPicker() {
	    const modelControl = getAgentModelControl(currentAgent);
	    if (!modelControl) return;
	    if (modelControl.kind === 'dynamic') {
	      showDynamicModelPicker();
	      return;
	    }
	    if (modelControl.kind === 'reasoning') {
	      showCodexCombinedPicker();
	      return;
	    }
	    showOptionPicker(modelControl.title || '选择模型', modelControl.options || [], currentModel, (value) => {
	      send({ type: 'message', text: `/model ${value}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    });
  }

	  function showModePicker() {
    showOptionPicker('选择权限模式', MODE_PICKER_OPTIONS, currentMode, (value) => {
      currentMode = value;
      modeSelect.value = currentMode;
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
      if (currentSessionId) {
        send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
      }
    });
  }

  // --- Send Message ---
  function sendMessage() {
    const text = msgInput.value.trim();
    if ((!text && pendingAttachments.length === 0) || isGenerating || isBlockingSessionLoad()) return;
    hideCmdMenu();
    hideOptionPicker();

    // Slash commands: don't show as user bubble
    if (text.startsWith('/')) {
      if (pendingAttachments.length > 0) {
        appendError('命令消息暂不支持附带图片，请先移除图片或发送普通消息。');
        return;
      }
      // /model without argument → show interactive picker
      if (text === '/model' || text === '/model ') {
        showModelPicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      // /mode without argument → show interactive picker
      if (text === '/mode' || text === '/mode ') {
        showModePicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      send({ type: 'message', text, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
      msgInput.value = '';
      autoResize();
      return;
    }

    // Regular message
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const attachments = pendingAttachments.map((attachment) => ({ ...attachment }));
    messagesDiv.appendChild(createMsgElement('user', text, attachments, {
      resendPayload: { text, attachments: cloneResendAttachments(attachments) },
    }));
    currentSessionMessages.push({ role: 'user', content: text, attachments: cloneResendAttachments(attachments) });
    trimRenderedMessages();
    updateContextUsageDisplay();
    syncLastUserResendAction();
    syncRenderedMessageIndexes();
    scheduleMessageLocatorUpdate();
    scrollToBottom();

    send({ type: 'message', text, attachments, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    msgInput.value = '';
    pendingAttachments = [];
    renderPendingAttachments();
    autoResize();
    startGenerating();
  }

  function autoResize() {
    msgInput.style.height = 'auto';
    const max = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--input-max-height')) || 200;
    msgInput.style.height = Math.min(msgInput.scrollHeight, max) + 'px';
  }

  // --- Event Listeners ---
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = loginPassword.value;
    if (!pw) return;
    loginError.hidden = true;
    loginPasswordValue = pw;
    // Remember password
    if (rememberPw.checked) {
      localStorage.setItem('cc-web-pw', pw);
    } else {
      localStorage.removeItem('cc-web-pw');
    }
    send({ type: 'auth', password: pw });
    // Request notification permission on first user interaction
    requestNotificationPermission();
  });

  menuBtn.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });

  sidebarOverlay.addEventListener('click', closeSidebar);
  document.addEventListener('touchstart', handleSidebarSwipeStart, { passive: true });
  document.addEventListener('touchmove', handleSidebarSwipeMove, { passive: false });
  document.addEventListener('touchend', handleSidebarSwipeEnd, { passive: true });
  document.addEventListener('touchcancel', () => { sidebarSwipe = null; }, { passive: true });

  if (modelPickerBtn) {
    modelPickerBtn.addEventListener('click', () => {
      if (!currentSessionId) return;
      if (currentAgent === 'claude' || currentAgent === 'codex') {
        showAiSelectionPicker();
        return;
      }
      if (getAgentModelControl(currentAgent)?.kind === 'reasoning') {
        showCodexCombinedPicker();
        return;
      }
      showModelPicker();
    });
  }

  if (thinkingPickerBtn) {
    thinkingPickerBtn.addEventListener('click', () => {
      if (!currentSessionId || currentAgent !== 'codex') return;
      showAiSelectionPicker();
    });
  }

  function showAiSelectionPicker() {
    if (!currentSessionId || !aiConfigCache) {
      send({ type: 'get_ai_config' });
      showToast('正在加载 AI 配置，请稍后重试');
      return;
    }
    const providers = (aiConfigCache.providers || []).filter((provider) => provider.agent === currentAgent);
    const choices = providers.flatMap((provider) => (provider.models || []).map((model) => ({
      value: `${provider.id}/${model.id}`,
      label: `${provider.name} · ${model.label || model.id}`,
      desc: model.id,
    })));
    if (choices.length === 0) return showToast('当前 Agent 尚未配置模型');
    const current = currentModel || choices[0].value;
    const level = currentSessionId ? (getSessionMeta(currentSessionId)?.reasoningEffort || 'medium') : 'medium';
    if (currentAgent !== 'codex') {
      showOptionPicker('选择提供方与模型', choices, current, (value) => {
        const split = value.indexOf('/');
        send({ type: 'set_ai_selection', sessionId: currentSessionId, agent: currentAgent, providerId: value.slice(0, split), modelId: value.slice(split + 1) });
      });
      return;
    }
    hideOptionPicker();
    const overlay = document.createElement('div');
    overlay.className = 'option-picker-overlay';
    const picker = document.createElement('div');
    picker.className = 'option-picker option-picker-combined';
    let selected = choices.some((item) => item.value === current) ? current : choices[0].value;
    let selectedLevel = ['low', 'medium', 'high', 'xhigh'].includes(level) ? level : 'medium';
    picker.innerHTML = `<header class="option-picker-header"><div><div class="option-picker-title">提供方、模型与思考强度</div><div class="option-picker-subtitle">当前会话可直接切换，下一轮请求生效</div></div><button class="option-picker-close" type="button" aria-label="关闭">×</button></header><div class="option-picker-config-body"><section class="option-picker-config-section"><div class="option-picker-section-title">模型</div><div class="option-picker-model-grid">${choices.map((item) => `<button class="option-picker-choice${item.value === selected ? ' active' : ''}" type="button" data-ai-model="${escapeHtml(item.value)}"><span class="option-picker-choice-label">${escapeHtml(item.label)}</span><span class="option-picker-choice-desc">${escapeHtml(item.desc)}</span><span class="option-picker-choice-mark">✓</span></button>`).join('')}</div></section><section class="option-picker-config-section"><div class="option-picker-section-title">Thinking</div><div class="option-picker-effort-grid">${['low', 'medium', 'high', 'xhigh'].map((item) => `<button class="option-picker-effort${item === selectedLevel ? ' active' : ''}" type="button" data-ai-effort="${item}"><span>${item}</span></button>`).join('')}</div></section></div><footer class="option-picker-footer"><button class="option-picker-cancel" type="button">取消</button><button class="option-picker-confirm" type="button">应用</button></footer>`;
    overlay.appendChild(picker);
    document.body.appendChild(overlay);
    picker.querySelectorAll('[data-ai-model]').forEach((button) => button.addEventListener('click', () => { selected = button.dataset.aiModel; picker.querySelectorAll('[data-ai-model]').forEach((item) => item.classList.toggle('active', item === button)); }));
    picker.querySelectorAll('[data-ai-effort]').forEach((button) => button.addEventListener('click', () => { selectedLevel = button.dataset.aiEffort; picker.querySelectorAll('[data-ai-effort]').forEach((item) => item.classList.toggle('active', item === button)); }));
    const close = () => { overlay.remove(); document.removeEventListener('keydown', _pickerEscape); };
    picker.querySelector('.option-picker-close').addEventListener('click', close);
    picker.querySelector('.option-picker-cancel').addEventListener('click', close);
    picker.querySelector('.option-picker-confirm').addEventListener('click', () => { const split = selected.indexOf('/'); close(); send({ type: 'set_ai_selection', sessionId: currentSessionId, agent: currentAgent, providerId: selected.slice(0, split), modelId: selected.slice(split + 1), reasoningEffort: selectedLevel }); });
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  }

  function showCodexCombinedPicker() {
    const modelControl = getAgentModelControl(currentAgent);
    if (modelControl?.kind !== 'reasoning' || !currentSessionId) return;
    hideOptionPicker();

    const current = getCurrentCodexModelState();
    const baseOptions = getCodexBaseModelOptions();
    const thinkingOptions = modelControl.thinkingOptions || [];
    let selectedBase = current.base;
    let selectedLevel = current.level;

    const overlay = document.createElement('div');
    overlay.className = 'option-picker-overlay';
    overlay.id = 'option-picker-overlay';
    const picker = document.createElement('div');
    picker.className = 'option-picker option-picker-combined';
    picker.id = 'option-picker';
    picker.innerHTML = `
      <header class="option-picker-header">
        <div>
          <div class="option-picker-title">模型与思考强度</div>
          <div class="option-picker-subtitle">为当前会话选择模型配置</div>
        </div>
        <button class="option-picker-close" type="button" aria-label="关闭">×</button>
      </header>
      <div class="option-picker-config-body">
        <section class="option-picker-config-section">
          <div class="option-picker-section-title">模型</div>
          <div class="option-picker-model-grid">
            ${baseOptions.map((option) => `
              <button class="option-picker-choice${option.value === selectedBase ? ' active' : ''}" type="button" data-model-value="${escapeHtml(option.value)}">
                <span class="option-picker-choice-label">${escapeHtml(option.label)}</span>
                <span class="option-picker-choice-desc">${escapeHtml(option.desc || '')}</span>
                <span class="option-picker-choice-mark">✓</span>
              </button>`).join('')}
          </div>
        </section>
        <section class="option-picker-config-section">
          <div class="option-picker-section-title">思考强度</div>
          <div class="option-picker-effort-grid">
            ${thinkingOptions.map((option) => `
              <button class="option-picker-effort${option.value === selectedLevel ? ' active' : ''}" type="button" data-thinking-value="${escapeHtml(option.value)}">
                <span>${escapeHtml(option.label)}</span>
                <small>${escapeHtml(option.desc || '')}</small>
              </button>`).join('')}
          </div>
        </section>
      </div>
      <footer class="option-picker-footer">
        <button class="option-picker-cancel" type="button">取消</button>
        <button class="option-picker-confirm" type="button">应用</button>
      </footer>`;
    overlay.appendChild(picker);
    document.body.appendChild(overlay);

    picker.querySelectorAll('[data-model-value]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedBase = button.dataset.modelValue;
        picker.querySelectorAll('[data-model-value]').forEach((item) => item.classList.toggle('active', item === button));
      });
    });
    picker.querySelectorAll('[data-thinking-value]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedLevel = button.dataset.thinkingValue;
        picker.querySelectorAll('[data-thinking-value]').forEach((item) => item.classList.toggle('active', item === button));
      });
    });
    picker.querySelector('.option-picker-close').addEventListener('click', hideOptionPicker);
    picker.querySelector('.option-picker-cancel').addEventListener('click', hideOptionPicker);
    picker.querySelector('.option-picker-confirm').addEventListener('click', () => {
      const full = selectedLevel ? `${selectedBase}(${selectedLevel})` : selectedBase;
      hideOptionPicker();
      send({ type: 'message', text: `/model ${full}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    });
    overlay.addEventListener('click', _pickerOutsideClick);
    document.addEventListener('keydown', _pickerEscape);
  }

  if (chatContextRow) {
    chatContextRow.addEventListener('click', (e) => {
      if (chatContextRow.hidden) return;
      e.stopPropagation();
      showClickTip(chatContextRow, {
        title: chatContextRow.dataset.tipTitle || '上下文占用估算',
        body: chatContextRow.dataset.tipBody || chatContextText?.textContent || '',
      });
    });
  }

  newChatBtn.addEventListener('click', () => showNewSessionModal());
  newProjectBtn.addEventListener('click', () => showNewSessionModal({ projectOnly: true }));
  importChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (importChatBtn.hidden) return;
    newChatDropdown.hidden = !newChatDropdown.hidden;
  });
  newChatDropdown.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-import-agent]');
    if (!btn) return;
    newChatDropdown.hidden = true;
    showImportSessionModalForAgent(btn.dataset.importAgent);
  });
  document.addEventListener('click', (e) => {
    if (!newChatDropdown.hidden &&
        !newChatDropdown.contains(e.target) &&
        e.target !== importChatBtn) {
      newChatDropdown.hidden = true;
    }
  });
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => {
    abortBtn.disabled = true;
    abortBtn.title = '正在停止';
    send({ type: 'abort' });
  });
  gitChangesBtn.addEventListener('click', () => setGitPanelOpen(!gitPanelOpen));
  gitPanelOverlay.addEventListener('click', () => setGitPanelOpen(false));
  gitCloseBtn.addEventListener('click', () => setGitPanelOpen(false));
  gitRefreshBtn.addEventListener('click', () => {
    if (workspaceTab === 'files') requestWorkspaceFiles();
    else if (workspaceTab === 'history') requestGitHistory(true);
    else requestGitStatus();
  });
  workspaceTabs.forEach((button) => {
    button.addEventListener('click', () => setWorkspaceTab(button.dataset.workspaceTab));
  });
  desktopLayoutQuery.addEventListener('change', () => {
    if (!app.hidden) restoreGitPanelOpenState();
  });
  if (attachBtn && imageUploadInput) {
    attachBtn.addEventListener('click', () => imageUploadInput.click());
    imageUploadInput.addEventListener('change', () => {
      handleSelectedImageFiles(imageUploadInput.files);
    });
  }
  if (inputWrapper) {
    inputWrapper.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      inputWrapper.classList.add('drag-active');
    });
    inputWrapper.addEventListener('dragleave', (e) => {
      if (e.target === inputWrapper) inputWrapper.classList.remove('drag-active');
    });
    inputWrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      inputWrapper.classList.remove('drag-active');
      handleSelectedImageFiles(e.dataTransfer?.files);
    });
  }

  // Mode selector
  modeSelect.value = currentMode;
  modeSelect.addEventListener('change', () => {
    currentMode = modeSelect.value;
    localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
    if (currentSessionId) {
      send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
    }
    if (currentMode === 'default') {
      appendSystemMessage('⚠ 由于项目设计与 CLI 原生逻辑不同，默认模式的授权申请功能暂未实现，建议搭配 Plan 或 YOLO 模式使用。');
    }
  });

  if (sessionMultiSelectBtn) {
    sessionMultiSelectBtn.addEventListener('click', () => {
      setSessionMultiSelectMode(!isSessionMultiSelectMode);
    });
  }

  if (sessionSelectAllBtn) {
    sessionSelectAllBtn.addEventListener('click', () => {
      if (!isSessionMultiSelectMode) return;
      selectAllVisibleSessions();
    });
  }

  if (sessionInvertSelectBtn) {
    sessionInvertSelectBtn.addEventListener('click', () => {
      if (!isSessionMultiSelectMode) return;
      invertVisibleSessionSelection();
    });
  }

  if (sessionClearBtn) {
    sessionClearBtn.addEventListener('click', () => {
      const visibleSessions = getVisibleSessions();
      if (isSessionMultiSelectMode) {
        const selectedSessions = visibleSessions.filter((session) => selectedSessionIds.has(session.id));
        deleteSessionsBatch(selectedSessions, {
          message: `确认删除选中的 ${selectedSessions.length} 个会话？此操作不可恢复。`,
        });
        return;
      }
      deleteSessionsBatch(visibleSessions, {
        message: `确认清空当前列表中的 ${visibleSessions.length} 个会话？此操作不可恢复。`,
        confirmLabel: '确认清空',
      });
    });
  }

  msgInput.addEventListener('input', () => {
    autoResize();
    const val = msgInput.value;
    // Show slash command menu
    if (val.startsWith('/') && !val.includes('\n')) {
      showCmdMenu(val);
    } else {
      hideCmdMenu();
    }
  });

  msgInput.addEventListener('keydown', (e) => {
    // Command menu navigation
    if (!cmdMenu.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateCmdMenu(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateCmdMenu(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); selectCmdMenuItem(); return; }
      if (e.key === 'Escape') { hideCmdMenu(); return; }
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    if (!cmdMenu.hidden && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      selectCmdMenuItem();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  msgInput.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file' && /^image\//.test(item.type || ''))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      handleSelectedImageFiles(files);
    }
  });

  // Close cmd menu on outside click
  document.addEventListener('click', (e) => {
    if (!cmdMenu.contains(e.target) && e.target !== msgInput) {
      hideCmdMenu();
    }
  });

  // --- Toast Notification ---
  function showToast(text, sessionId) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = text;
    if (sessionId) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        openSession(sessionId);
        toast.remove();
      });
    }
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // --- Browser Notification (via Service Worker for mobile) ---
  function showBrowserNotification(title) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('CC-Web', {
          body: `「${title}」任务完成`,
          tag: 'cc-web-task',
          renotify: true,
        });
      }).catch(() => {});
    }
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // --- Settings Panel ---
  let _onNotifyConfig = null;
  let _onNotifyTestResult = null;
  let _onModelConfig = null;
  let _onAiConfig = null;
  let _onCodexConfig = null;
  let _onCodebuddyConfig = null;
  let _onKimiConfig = null;
  let _onCliInstallStatus = null;
  let _onFetchModelsResult = null;
  let _onAgentImportSessions = null;
  let _onClaudeLocalConfig = null;
  let _onCodexLocalConfig = null;
  let _onKimiLocalConfig = null;
  let _onDevConfig = null;

  const settingsBtn = $('#settings-btn');

  const PROVIDER_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: 'pushplus', label: 'PushPlus' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'serverchan', label: 'Server酱' },
    { value: 'feishu', label: '飞书机器人' },
    { value: 'qqbot', label: 'QQ（Qmsg）' },
  ];

  const KIMI_PROVIDER_OPTIONS = [
    { value: 'kimi', label: 'kimi' },
    { value: 'openai_responses', label: 'openai_responses' },
    { value: 'openai_legacy', label: 'openai_legacy' },
    { value: 'anthropic', label: 'anthropic' },
    { value: 'gemini', label: 'gemini' },
    { value: 'vertexai', label: 'vertexai' },
  ];

  const KIMI_CAPABILITY_OPTIONS = [
    { value: 'thinking', label: 'thinking' },
    { value: 'always_thinking', label: 'always_thinking' },
    { value: 'image_in', label: 'image_in' },
    { value: 'video_in', label: 'video_in' },
  ];

  function buildNotifyFieldsHtml(config, provider) {
    if (provider === 'pushplus') {
      return `
        <div class="settings-field">
          <label>Token</label>
          <input type="text" id="notify-pushplus-token" placeholder="PushPlus Token" value="${escapeHtml(config?.pushplus?.token || '')}">
        </div>
      `;
    }
    if (provider === 'telegram') {
      return `
        <div class="settings-field">
          <label>Bot Token</label>
          <input type="text" id="notify-tg-bottoken" placeholder="123456:ABC-DEF..." value="${escapeHtml(config?.telegram?.botToken || '')}">
        </div>
        <div class="settings-field">
          <label>Chat ID</label>
          <input type="text" id="notify-tg-chatid" placeholder="Chat ID" value="${escapeHtml(config?.telegram?.chatId || '')}">
        </div>
      `;
    }
    if (provider === 'serverchan') {
      return `
        <div class="settings-field">
          <label>SendKey</label>
          <input type="text" id="notify-sc-sendkey" placeholder="Server酱 SendKey" value="${escapeHtml(config?.serverchan?.sendKey || '')}">
        </div>
      `;
    }
    if (provider === 'feishu') {
      return `
        <div class="settings-field">
          <label>Webhook 地址</label>
          <input type="text" id="notify-feishu-webhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" value="${escapeHtml(config?.feishu?.webhook || '')}">
        </div>
      `;
    }
    if (provider === 'qqbot') {
      return `
        <div class="settings-field">
          <label>Qmsg Key</label>
          <input type="text" id="notify-qmsg-key" placeholder="Qmsg 推送 Key" value="${escapeHtml(config?.qqbot?.qmsgKey || '')}">
        </div>
      `;
    }
    return '';
  }

  function buildAgentContextCard(agent, title, copy) {
    const label = getAgentDefinition(agent)?.label || getAgentDefinition(DEFAULT_AGENT)?.label || 'Agent';
    return `
      <div class="agent-context-card">
        <div class="agent-context-kicker">${escapeHtml(label)}</div>
        ${title ? `<div class="agent-context-title">${escapeHtml(title)}</div>` : ''}
        ${copy ? `<div class="agent-context-copy">${escapeHtml(copy)}</div>` : ''}
      </div>
    `;
  }

  function renderNotifyFields(fieldsDiv, config, provider) {
    fieldsDiv.innerHTML = buildNotifyFieldsHtml(config, provider);
  }

  function collectNotifyConfigFromPanel(panel, currentConfig, provider) {
    const pp = panel.querySelector('#notify-pushplus-token');
    const tgBot = panel.querySelector('#notify-tg-bottoken');
    const tgChat = panel.querySelector('#notify-tg-chatid');
    const sc = panel.querySelector('#notify-sc-sendkey');
    const feishuWh = panel.querySelector('#notify-feishu-webhook');
    const qmsgKey = panel.querySelector('#notify-qmsg-key');
    // Summary config
    const summaryEnabled = panel.querySelector('#notify-summary-enabled');
    const summaryTrigger = panel.querySelector('#notify-summary-trigger');
    const summarySource = panel.querySelector('#notify-summary-source');
    const summaryApiBase = panel.querySelector('#notify-summary-apibase');
    const summaryApiKey = panel.querySelector('#notify-summary-apikey');
    const summaryModel = panel.querySelector('#notify-summary-model');
    const cs = currentConfig?.summary || {};
    return {
      provider,
      pushplus: { token: pp ? pp.value.trim() : (currentConfig?.pushplus?.token || '') },
      telegram: {
        botToken: tgBot ? tgBot.value.trim() : (currentConfig?.telegram?.botToken || ''),
        chatId: tgChat ? tgChat.value.trim() : (currentConfig?.telegram?.chatId || ''),
      },
      serverchan: { sendKey: sc ? sc.value.trim() : (currentConfig?.serverchan?.sendKey || '') },
      feishu: { webhook: feishuWh ? feishuWh.value.trim() : (currentConfig?.feishu?.webhook || '') },
      qqbot: { qmsgKey: qmsgKey ? qmsgKey.value.trim() : (currentConfig?.qqbot?.qmsgKey || '') },
      summary: {
        enabled: summaryEnabled ? summaryEnabled.checked : !!cs.enabled,
        trigger: summaryTrigger ? summaryTrigger.value : (cs.trigger || 'background'),
        apiSource: summarySource ? summarySource.value : (cs.apiSource || 'claude'),
        apiBase: summaryApiBase ? summaryApiBase.value.trim() : (cs.apiBase || ''),
        apiKey: summaryApiKey ? summaryApiKey.value.trim() : (cs.apiKey || ''),
        model: summaryModel ? summaryModel.value.trim() : (cs.model || ''),
      },
    };
  }

  function buildSummarySettingsHtml(config) {
    const s = config?.summary || {};
    const enabled = !!s.enabled;
    const trigger = s.trigger || 'background';
    const src = s.apiSource || 'claude';
    const customVisible = src === 'custom' ? '' : 'display:none';
    return `
      <div class="settings-divider"></div>
      <div class="settings-section-title">通知摘要</div>
      <div class="settings-field" style="flex-direction:row;align-items:center;gap:10px">
        <label style="margin:0;flex:1">启用 AI 摘要</label>
        <input type="checkbox" id="notify-summary-enabled" ${enabled ? 'checked' : ''} style="width:auto;margin:0">
      </div>
      <div id="notify-summary-options" style="${enabled ? '' : 'display:none'}">
        <div class="settings-field">
          <label>推送时机</label>
          <select class="settings-select" id="notify-summary-trigger">
            <option value="background" ${trigger === 'background' ? 'selected' : ''}>仅后台任务</option>
            <option value="always" ${trigger === 'always' ? 'selected' : ''}>所有任务</option>
          </select>
        </div>
        <div class="settings-field">
          <label>摘要 API 来源</label>
          <select class="settings-select" id="notify-summary-source">
            <option value="claude" ${src === 'claude' ? 'selected' : ''}>Claude 活跃模板</option>
            <option value="codex" ${src === 'codex' ? 'selected' : ''}>Codex 活跃 Profile</option>
            <option value="custom" ${src === 'custom' ? 'selected' : ''}>独立配置</option>
          </select>
        </div>
        <div id="notify-summary-custom" style="${customVisible}">
          <div class="settings-field">
            <label>API Base URL</label>
            <input type="text" id="notify-summary-apibase" placeholder="https://api.example.com" value="${escapeHtml(s.apiBase || '')}">
          </div>
          <div class="settings-field">
            <label>API Key</label>
            <input type="text" id="notify-summary-apikey" placeholder="sk-..." value="${escapeHtml(s.apiKey || '')}">
          </div>
          <div class="settings-field">
            <label>模型</label>
            <input type="text" id="notify-summary-model" placeholder="claude-opus-4-6" value="${escapeHtml(s.model || '')}">
          </div>
        </div>
      </div>
    `;
  }

  function bindSummarySettingsEvents(panel) {
    const enabledCb = panel.querySelector('#notify-summary-enabled');
    const optionsDiv = panel.querySelector('#notify-summary-options');
    const sourceSelect = panel.querySelector('#notify-summary-source');
    const customDiv = panel.querySelector('#notify-summary-custom');
    if (!enabledCb || !optionsDiv || !sourceSelect || !customDiv) return;
    enabledCb.addEventListener('change', () => {
      optionsDiv.style.display = enabledCb.checked ? '' : 'none';
    });
    sourceSelect.addEventListener('change', () => {
      customDiv.style.display = sourceSelect.value === 'custom' ? '' : 'none';
    });
  }

  function openPasswordModal() {
    const pwOverlay = document.createElement('div');
    pwOverlay.className = 'settings-overlay';
    pwOverlay.style.zIndex = '10001';
    const pwModal = document.createElement('div');
    pwModal.className = 'settings-panel';
    pwModal.style.maxWidth = '400px';
    pwModal.innerHTML = `
      <div class="settings-header">
        <h3>修改密码</h3>
        <button class="settings-close" id="pw-modal-close">&times;</button>
      </div>
      <div class="settings-field">
        <label>当前密码</label>
        <input type="password" id="pw-modal-current" placeholder="当前密码" autocomplete="current-password">
      </div>
      <div class="settings-field">
        <label>新密码</label>
        <input type="password" id="pw-modal-new" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="pw-modal-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
      </div>
      <div class="settings-field">
        <label>确认新密码</label>
        <input type="password" id="pw-modal-confirm" placeholder="确认新密码" autocomplete="new-password">
      </div>
      <div class="settings-actions">
        <button class="btn-save" id="pw-modal-submit" disabled>修改密码</button>
      </div>
      <div class="settings-status" id="pw-modal-status"></div>
    `;
    pwOverlay.appendChild(pwModal);
    document.body.appendChild(pwOverlay);

    const currentPwIn = pwModal.querySelector('#pw-modal-current');
    const newPwIn = pwModal.querySelector('#pw-modal-new');
    const confirmPwIn = pwModal.querySelector('#pw-modal-confirm');
    const hint = pwModal.querySelector('#pw-modal-hint');
    const submitBtn = pwModal.querySelector('#pw-modal-submit');
    const status = pwModal.querySelector('#pw-modal-status');

    function checkPw() {
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      const currentPw = currentPwIn.value;
      if (!newPw) {
        hint.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hint.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(newPw);
      if (!result.valid) {
        hint.textContent = result.message;
        hint.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hint.textContent = '密码强度符合要求';
      hint.className = 'password-hint success';
      submitBtn.disabled = !currentPw || !confirmPw || confirmPw !== newPw;
    }

    currentPwIn.addEventListener('input', checkPw);
    newPwIn.addEventListener('input', checkPw);
    confirmPwIn.addEventListener('input', checkPw);

    const closePwModal = () => { document.body.removeChild(pwOverlay); };
    pwModal.querySelector('#pw-modal-close').addEventListener('click', closePwModal);
    pwOverlay.addEventListener('click', (e) => { if (e.target === pwOverlay) closePwModal(); });

    submitBtn.addEventListener('click', () => {
      const currentPw = currentPwIn.value;
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      if (newPw !== confirmPw) {
        status.textContent = '两次密码不一致';
        status.className = 'settings-status error';
        return;
      }
      submitBtn.disabled = true;
      status.textContent = '正在修改...';
      status.className = 'settings-status';
      _onPasswordChanged = (result) => {
        if (result.success) {
          status.textContent = result.message || '密码修改成功';
          status.className = 'settings-status success';
          setTimeout(closePwModal, 1200);
        } else {
          status.textContent = result.message || '修改失败';
          status.className = 'settings-status error';
          submitBtn.disabled = false;
        }
      };
      send({ type: 'change_password', currentPassword: currentPw, newPassword: newPw });
    });

    currentPwIn.focus();
  }

  function showSettingsPanel() {
    send({ type: 'get_ai_config' });
    send({ type: 'get_model_config' });
    send({ type: 'get_codex_config' });
    send({ type: 'get_codebuddy_config' });
    send({ type: 'get_kimi_config' });
    send({ type: 'get_notify_config' });
    send({ type: 'get_cli_install_status' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-main-panel';

    panel.innerHTML = `
      <div class="settings-header">
        <h3>⚙ 设置</h3>
        <button class="settings-close" title="关闭">&times;</button>
      </div>

      <div class="settings-tabs" role="tablist" aria-label="设置分类">
        <button class="settings-tab active" type="button" role="tab" aria-selected="true" aria-controls="settings-tab-cli" data-settings-tab="cli">CLI 状态</button>
        <button class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="settings-tab-ai" data-settings-tab="ai">AI 配置</button>
        <button class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="settings-tab-appearance" data-settings-tab="appearance">外观</button>
        <button class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="settings-tab-notify" data-settings-tab="notify">通知</button>
        <button class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="settings-tab-developer" data-settings-tab="developer">开发者</button>
        <button class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="settings-tab-system" data-settings-tab="system">系统</button>
      </div>

      <div class="settings-tab-panels">
        <section class="settings-tab-panel active" id="settings-tab-cli" role="tabpanel" data-settings-panel="cli">
          <div class="settings-section-title">CLI 安装状态</div>
          <div id="cli-install-status-area"></div>
        </section>

        <section class="settings-tab-panel" id="settings-tab-ai" role="tabpanel" data-settings-panel="ai" hidden>
          <div class="settings-section-title">模型</div>
          <div class="settings-inline-note">填入各提供方的 API 密钥即可使用其模型。内置本机配置无需新增，点击编辑可查看或调整。</div>
          <div id="ai-unified-config-area"></div>
          <div class="settings-actions"><button class="btn-save" id="ai-unified-save-btn">保存全部配置</button><span class="settings-status" id="ai-unified-status"></span></div>
          <div class="settings-divider"></div>
          <div class="legacy-ai-config" hidden>
          <div class="settings-section-title">Claude API 配置</div>
          <div id="claude-config-area"></div>
          <div class="settings-actions">
            <button class="btn-save" id="model-save-btn">保存 Claude 配置</button>
          </div>
          <div class="settings-status" id="model-status"></div>

          <div class="settings-divider"></div>

          <div class="settings-section-title">Codex API 配置</div>
          <div id="codex-config-area"></div>
          <div class="settings-actions">
            <button class="btn-save" id="codex-save-btn">保存 Codex 配置</button>
          </div>
          <div class="settings-status" id="codex-status"></div>
          </div>

          <div class="settings-divider"></div>

          <div class="settings-section-title">CodeBuddy CLI 配置</div>
          <div id="codebuddy-config-area"></div>

          <div class="settings-divider"></div>

          <div class="settings-section-title">Kimi CLI 配置</div>
          <div id="kimi-config-area"></div>
          <div class="settings-actions">
            <button class="btn-save" id="kimi-save-btn">保存 Kimi 配置</button>
          </div>
          <div class="settings-status" id="kimi-status"></div>
        </section>

        <section class="settings-tab-panel" id="settings-tab-appearance" role="tabpanel" data-settings-panel="appearance" hidden>
          ${buildAppearanceEntryHtml()}
        </section>

        <section class="settings-tab-panel" id="settings-tab-notify" role="tabpanel" data-settings-panel="notify" hidden>
          ${buildNotifyEntryHtml(null)}
        </section>

        <section class="settings-tab-panel" id="settings-tab-developer" role="tabpanel" data-settings-panel="developer" hidden>
          <div class="settings-section-title">开发者</div>
          <button class="settings-nav-card" type="button" data-open-dev-page>
            <span class="settings-nav-card-main">
              <span class="settings-nav-card-title">开发者设置</span>
              <span class="settings-nav-card-meta">GitHub / SSH 配置</span>
            </span>
            <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
          </button>
        </section>

        <section class="settings-tab-panel" id="settings-tab-system" role="tabpanel" data-settings-panel="system" hidden>
          <div class="settings-section-title">系统</div>
          <div class="settings-actions" style="margin-top:0;flex-wrap:wrap;gap:10px">
            <button class="btn-test" id="pw-open-modal-btn" style="padding:6px 16px">修改密码</button>
            <button class="btn-test" id="check-update-btn" style="padding:6px 16px">检查更新</button>
          </div>
          <div class="settings-status" id="update-status" style="margin-top:8px"></div>
        </section>
      </div>

    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const aiUnifiedArea = panel.querySelector('#ai-unified-config-area');
    const aiUnifiedStatus = panel.querySelector('#ai-unified-status');
    const aiUnifiedSaveBtn = panel.querySelector('#ai-unified-save-btn');
    let aiEditingConfig = aiConfigCache ? deepClone(aiConfigCache) : null;
    let aiEditingProviderIndex = -1;
    const defaultAiProvider = () => ({
      id: `provider-${Date.now()}`,
      name: '新提供方',
      agent: 'claude',
      kind: 'remote',
      baseUrl: '',
      apiKey: '',
      models: [],
    });

    function aiProviderStatus(provider) {
      if (provider.kind === 'local') return { label: '本机配置', className: 'local' };
      if (provider.apiKey && provider.baseUrl) return { label: '已配置', className: 'ready' };
      return { label: '未完成', className: 'muted' };
    }

    function renderAiProviderList(config) {
      const providers = config.providers || [];
      if (providers.length === 0) {
        return '<div class="ai-provider-empty">还没有提供方，先添加一个自定义提供方。</div>';
      }
      return `<div class="ai-provider-list">${providers.map((provider, index) => {
        const status = aiProviderStatus(provider);
        const isBuiltin = provider.kind === 'local';
        return `<div class="ai-provider-row${index === aiEditingProviderIndex ? ' is-editing' : ''}">
          <div class="ai-provider-row-main">
            <div class="ai-provider-row-title">${escapeHtml(provider.name || provider.id)} <span class="ai-provider-dot ${status.className}" aria-hidden="true"></span></div>
            <div class="ai-provider-row-meta"><span class="ai-provider-badge">${isBuiltin ? '内置' : '自定义'}</span><span>${provider.agent === 'claude' ? 'Claude' : 'Codex'}</span><span>${(provider.models || []).length} 个模型</span><span class="ai-provider-status ${status.className}">${status.label}</span></div>
          </div>
          <div class="ai-provider-row-actions"><button type="button" class="btn-test" data-ai-edit="${index}">编辑</button>${isBuiltin ? '' : '<button type="button" class="ai-provider-delete" data-ai-delete="' + index + '">删除</button>'}</div>
        </div>`;
      }).join('')}</div>`;
    }

    function renderAiProviderEditor(config) {
      const index = aiEditingProviderIndex;
      const provider = config.providers?.[index];
      if (!provider) return '';
      const defaultModelId = config.defaults?.[provider.agent]?.providerId === provider.id
        ? config.defaults[provider.agent].modelId
        : '';
      const protocol = provider.agent === 'claude' ? 'anthropic-messages' : 'openai-responses';
      return `<div class="ai-provider-editor" data-ai-editor="${index}">
        <div class="ai-provider-editor-header"><strong>${escapeHtml(provider.name || '编辑提供方')}</strong><button type="button" class="settings-close ai-editor-close" aria-label="关闭编辑">×</button></div>
        <div class="ai-provider-editor-body">
          <div class="settings-field"><label>显示名称</label><input data-ai-field="name" value="${escapeHtml(provider.name || '')}" placeholder="例如 DeepSeek"></div>
          <div class="settings-field"><label>接入类型</label><select data-ai-field="agent"><option value="claude"${provider.agent === 'claude' ? ' selected' : ''}>Claude</option><option value="codex"${provider.agent === 'codex' ? ' selected' : ''}>Codex</option></select></div>
          <div class="settings-field"><label>API 密钥</label><input type="password" data-ai-field="apiKey" value="${escapeHtml(provider.apiKey || '')}" placeholder="已配置的密钥可直接保留"></div>
          <details class="ai-provider-advanced" open><summary>自定义设置</summary><div class="settings-field"><label>API 地址</label><input data-ai-field="baseUrl" value="${escapeHtml(provider.baseUrl || '')}" placeholder="https://api.example.com/v1"></div><div class="settings-field"><label>API 协议</label><select data-ai-field="protocol"><option value="${protocol}" selected>${provider.agent === 'claude' ? 'Anthropic Messages' : 'OpenAI Responses'}</option></select></div></details>
          <div class="ai-model-directory"><div class="ai-model-directory-head"><div><strong>模型目录</strong><span>配置可供会话选择的模型</span></div><button type="button" class="btn-test" data-ai-add-model>添加模型</button></div><div class="ai-model-table-head"><span>模型 ID</span><span>显示名称</span><span>默认</span><span></span></div><div data-ai-model-rows>${(provider.models || []).map((model, modelIndex) => `<div class="ai-model-row" data-ai-model-index="${modelIndex}"><input data-ai-model-field="id" value="${escapeHtml(model.id || '')}" placeholder="例如 gpt-5.4"><input data-ai-model-field="label" value="${escapeHtml(model.label || model.id || '')}" placeholder="显示名称"><label class="ai-default-model"><input type="radio" name="ai-default-model" data-ai-default-model="${escapeHtml(model.id || '')}"${model.id === defaultModelId ? ' checked' : ''}><span>默认</span></label><button type="button" class="ai-model-remove" data-ai-remove-model="${modelIndex}" aria-label="删除模型">×</button></div>`).join('')}</div></div>
        </div>
        <div class="ai-provider-editor-actions"><button type="button" class="btn-test ai-editor-cancel">取消</button><button type="button" class="btn-save ai-editor-save">保存提供方</button></div>
      </div>`;
    }

    function renderAiUnifiedConfig() {
      if (!aiEditingConfig) aiEditingConfig = { version: 1, virtualApiKey: '', providers: [], defaults: {} };
      const config = aiEditingConfig || { providers: [], defaults: {} };
      aiUnifiedArea.innerHTML = `<div class="ai-provider-list-wrap">${renderAiProviderList(config)}<div class="ai-provider-add-actions"><button type="button" class="ai-provider-add" data-ai-add="remote">＋ 添加自定义提供方</button></div></div>${renderAiProviderEditor(config)}`;
      aiUnifiedArea.querySelectorAll('[data-ai-edit]').forEach((button) => button.addEventListener('click', () => { aiEditingProviderIndex = Number(button.dataset.aiEdit); renderAiUnifiedConfig(); }));
      aiUnifiedArea.querySelectorAll('[data-ai-delete]').forEach((button) => button.addEventListener('click', () => { const index = Number(button.dataset.aiDelete); if (!confirm(`确认删除「${aiEditingConfig.providers[index]?.name || ''}」？`)) return; aiEditingConfig.providers.splice(index, 1); aiEditingProviderIndex = -1; renderAiUnifiedConfig(); }));
      aiUnifiedArea.querySelectorAll('[data-ai-add]').forEach((button) => button.addEventListener('click', () => { aiEditingConfig.providers.push(defaultAiProvider()); aiEditingProviderIndex = aiEditingConfig.providers.length - 1; renderAiUnifiedConfig(); }));
      const editor = aiUnifiedArea.querySelector('[data-ai-editor]');
      if (!editor) return;
      const syncEditorProvider = () => {
        const provider = aiEditingConfig.providers[aiEditingProviderIndex];
        if (!provider) return;
        provider.name = editor.querySelector('[data-ai-field="name"]').value.trim();
        provider.agent = editor.querySelector('[data-ai-field="agent"]').value;
        provider.apiKey = editor.querySelector('[data-ai-field="apiKey"]').value.trim();
        provider.baseUrl = editor.querySelector('[data-ai-field="baseUrl"]').value.trim();
        provider.models = Array.from(editor.querySelectorAll('[data-ai-model-index]')).map((row) => ({ id: row.querySelector('[data-ai-model-field="id"]').value.trim(), label: row.querySelector('[data-ai-model-field="label"]').value.trim() })).filter((model) => model.id);
        const checked = editor.querySelector('[data-ai-default-model]:checked');
        const defaultModelId = checked?.closest('[data-ai-model-index]')?.querySelector('[data-ai-model-field="id"]')?.value.trim() || provider.models[0]?.id || '';
        if (provider.id && defaultModelId) aiEditingConfig.defaults[provider.agent] = { providerId: provider.id, modelId: defaultModelId, ...(provider.agent === 'codex' ? { reasoningEffort: aiEditingConfig.defaults.codex?.reasoningEffort || 'medium' } : {}) };
      };
      editor.querySelector('[data-ai-field="agent"]').addEventListener('change', () => { syncEditorProvider(); renderAiUnifiedConfig(); });
      editor.querySelector('[data-ai-add-model]').addEventListener('click', () => { syncEditorProvider(); aiEditingConfig.providers[aiEditingProviderIndex].models.push({ id: '', label: '' }); renderAiUnifiedConfig(); });
      editor.querySelectorAll('[data-ai-remove-model]').forEach((button) => button.addEventListener('click', () => { syncEditorProvider(); aiEditingConfig.providers[aiEditingProviderIndex].models.splice(Number(button.dataset.aiRemoveModel), 1); renderAiUnifiedConfig(); }));
      editor.querySelector('.ai-editor-close').addEventListener('click', () => { aiEditingProviderIndex = -1; renderAiUnifiedConfig(); });
      editor.querySelector('.ai-editor-cancel').addEventListener('click', () => { aiEditingProviderIndex = -1; renderAiUnifiedConfig(); });
      editor.querySelector('.ai-editor-save').addEventListener('click', () => { syncEditorProvider(); persistAiConfig(); aiEditingProviderIndex = -1; renderAiUnifiedConfig(); });
    }
    function readAiUnifiedConfig() {
      if (aiEditingProviderIndex >= 0) {
        const editor = aiUnifiedArea.querySelector('[data-ai-editor]');
        if (editor) {
          const provider = aiEditingConfig.providers[aiEditingProviderIndex];
          provider.name = editor.querySelector('[data-ai-field="name"]').value.trim();
          provider.agent = editor.querySelector('[data-ai-field="agent"]').value;
          provider.apiKey = editor.querySelector('[data-ai-field="apiKey"]').value.trim();
          provider.baseUrl = editor.querySelector('[data-ai-field="baseUrl"]').value.trim();
          provider.models = Array.from(editor.querySelectorAll('[data-ai-model-index]')).map((row) => ({ id: row.querySelector('[data-ai-model-field="id"]').value.trim(), label: row.querySelector('[data-ai-model-field="label"]').value.trim() })).filter((model) => model.id);
          const checked = editor.querySelector('[data-ai-default-model]:checked');
          const defaultModelId = checked?.closest('[data-ai-model-index]')?.querySelector('[data-ai-model-field="id"]')?.value.trim();
          if (defaultModelId) aiEditingConfig.defaults[provider.agent] = { providerId: provider.id, modelId: defaultModelId, ...(provider.agent === 'codex' ? { reasoningEffort: aiEditingConfig.defaults.codex?.reasoningEffort || 'medium' } : {}) };
        }
      }
      return { version: 1, virtualApiKey: aiEditingConfig?.virtualApiKey || '', providers: aiEditingConfig?.providers || [], defaults: aiEditingConfig?.defaults || {} };
    }
    function persistAiConfig() {
      send({ type: 'save_ai_config', config: readAiUnifiedConfig() });
      aiUnifiedStatus.textContent = '已保存';
      aiUnifiedStatus.className = 'settings-status success';
    }
    _onAiConfig = (config) => { aiEditingConfig = deepClone(config || { providers: [], defaults: {} }); renderAiUnifiedConfig(); };
    aiUnifiedSaveBtn.addEventListener('click', persistAiConfig);
    renderAiUnifiedConfig();
    const settingsTabs = panel.querySelectorAll('[data-settings-tab]');
    const settingsTabPanels = panel.querySelectorAll('[data-settings-panel]');
    const activateSettingsTab = (tabName) => {
      settingsTabs.forEach((tab) => {
        const active = tab.dataset.settingsTab === tabName;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      settingsTabPanels.forEach((tabPanel) => {
        const active = tabPanel.dataset.settingsPanel === tabName;
        tabPanel.classList.toggle('active', active);
        tabPanel.hidden = !active;
      });
    };
    settingsTabs.forEach((tab) => {
      tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const tabs = Array.from(settingsTabs);
        const currentIndex = tabs.indexOf(tab);
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const nextTab = tabs[(currentIndex + offset + tabs.length) % tabs.length];
        activateSettingsTab(nextTab.dataset.settingsTab);
        nextTab.focus();
      });
    });
    activateSettingsTab('cli');
    const cliInstallStatusArea = panel.querySelector('#cli-install-status-area');
    const themePageBtn = panel.querySelector('[data-open-theme-page]');
    if (themePageBtn) themePageBtn.addEventListener('click', openThemeSubpage);
    const fontPageBtn = panel.querySelector('[data-open-font-page]');
    if (fontPageBtn) fontPageBtn.addEventListener('click', openFontSubpage);
    const notifyPageBtn2 = panel.querySelector('[data-open-notify-page]');
    if (notifyPageBtn2) notifyPageBtn2.addEventListener('click', openNotifySubpage);
    const devPageBtn = panel.querySelector('[data-open-dev-page]');
    if (devPageBtn) devPageBtn.addEventListener('click', openDevSettingsSubpage);

    function renderCliInstallStatus(status = {}) {
      const agents = [
        { key: 'kimi', label: 'Kimi' },
        { key: 'claude', label: 'Claude' },
        { key: 'codex', label: 'Codex' },
        { key: 'codebuddy', label: 'CodeBuddy' },
        { key: 'opencode', label: 'OpenCode' },
      ];
      cliInstallStatusArea.innerHTML = `
        <div class="settings-cli-list">
          ${agents.map((agent) => {
            const item = status?.[agent.key] || {};
            const installed = !!item.installed;
            const version = item.version || '';
            return `
              <div class="settings-cli-card${installed ? ' is-installed' : ''}">
                <div class="settings-cli-card-head">
                  <span class="settings-cli-name">${escapeHtml(agent.label)}</span>
                  <span class="settings-cli-badge ${installed ? 'success' : 'muted'}">${installed ? '已安装' : '未安装'}</span>
                </div>
                <div class="settings-cli-meta">${installed ? escapeHtml(version || '已安装') : '未检测到可用命令'}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    _onCliInstallStatus = (status) => {
      renderCliInstallStatus(status || {});
    };

    renderCliInstallStatus();

    // === CodeBuddy Config UI ===
    const codebuddyConfigArea = panel.querySelector('#codebuddy-config-area');
    const codebuddyStatus = document.createElement('div');
    codebuddyStatus.className = 'settings-status';
    codebuddyConfigArea.insertAdjacentElement('afterend', codebuddyStatus);
    const codebuddyActions = document.createElement('div');
    codebuddyActions.className = 'settings-actions';
    codebuddyActions.innerHTML = '<button class="btn-save" id="codebuddy-save-btn">保存 CodeBuddy 配置</button>';
    codebuddyStatus.insertAdjacentElement('beforebegin', codebuddyActions);
    const codebuddySaveBtn = codebuddyActions.querySelector('#codebuddy-save-btn');
    let currentCodebuddyConfig = null;
    let codebuddyEditingProfiles = [];
    let codebuddyActiveProfile = '';

    function showCodebuddyStatus(msg, type) {
      codebuddyStatus.textContent = msg;
      codebuddyStatus.className = 'settings-status ' + (type || '');
    }

    function renderCodebuddyConfigArea() {
      const isLocal = codebuddyActiveProfile === '';
      const profileOptions = codebuddyEditingProfiles.map((profile) =>
        `<option value="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</option>`
      ).join('');

      if (isLocal) {
        codebuddyConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活 Profile</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="codebuddy-profile-select" style="flex:1">
                <option value="__local__" selected>本地登录态</option>
                ${profileOptions}
                <option value="__new__">+ 新建 Profile</option>
              </select>
              <button class="btn-test" id="codebuddy-info-btn" style="padding:4px 10px">说明</button>
            </div>
          </div>
          <div class="settings-inline-note">
            直接复用本机 <code>codebuddy</code> / <code>cbc</code> CLI 当前登录态。切到自定义 Profile 后，仅为新建会话注入对应凭据，不改写本机 <code>.codebuddy</code>。
          </div>
        `;
        panel.querySelector('#codebuddy-profile-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            openCodebuddyProfileModal();
          } else if (e.target.value === '__local__') {
            codebuddyActiveProfile = '';
            renderCodebuddyConfigArea();
          } else {
            codebuddyActiveProfile = e.target.value;
            renderCodebuddyConfigArea();
          }
        });
        panel.querySelector('#codebuddy-info-btn').addEventListener('click', showCodebuddyLocalInfoModal);
        return;
      }

      const currentProfile = codebuddyEditingProfiles.find((profile) => profile.name === codebuddyActiveProfile);
      const summary = [];
      if (currentProfile?.authToken) summary.push('Auth Token 已设置');
      if (currentProfile?.apiKey) summary.push('API Key 已设置');
      codebuddyConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活 Profile</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="codebuddy-profile-select" style="flex:1">
              <option value="__local__">本地登录态</option>
              ${profileOptions}
              <option value="__new__">+ 新建 Profile</option>
            </select>
            <button class="btn-test" id="codebuddy-profile-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="codebuddy-profile-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">
          当前 Profile：<strong>${escapeHtml(currentProfile?.name || '未选择')}</strong>${summary.length ? ` · ${escapeHtml(summary.join(' / '))}` : ' · 未填写凭据'}
        </div>
      `;
      panel.querySelector('#codebuddy-profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openCodebuddyProfileModal();
        } else if (e.target.value === '__local__') {
          codebuddyActiveProfile = '';
          renderCodebuddyConfigArea();
        } else {
          codebuddyActiveProfile = e.target.value;
          renderCodebuddyConfigArea();
        }
      });
      panel.querySelector('#codebuddy-profile-edit').addEventListener('click', () => openCodebuddyProfileModal(codebuddyActiveProfile));
      panel.querySelector('#codebuddy-profile-del').addEventListener('click', () => {
        if (!codebuddyActiveProfile) return;
        if (!confirm(`确认删除 CodeBuddy Profile「${codebuddyActiveProfile}」?`)) return;
        codebuddyEditingProfiles = codebuddyEditingProfiles.filter((profile) => profile.name !== codebuddyActiveProfile);
        codebuddyActiveProfile = codebuddyEditingProfiles[0]?.name || '';
        renderCodebuddyConfigArea();
      });
    }

    renderCodebuddyConfigArea();

    function openCodebuddyProfileModal(profileName = '') {
      const current = profileName
        ? codebuddyEditingProfiles.find((profile) => profile.name === profileName)
        : null;
      const draft = current
        ? { ...current, _originalName: current.name }
        : { name: '', authToken: '', apiKey: '', _originalName: '' };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${profileName ? '编辑' : '新建'} CodeBuddy Profile</h3>
          <button class="settings-close" id="codebuddy-profile-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>Profile 名称</label>
          <input type="text" id="codebuddy-profile-name" value="${escapeHtml(draft.name)}" placeholder="例如：主账号">
        </div>
        <div class="settings-field">
          <label>Auth Token</label>
          <input type="text" id="codebuddy-profile-auth-token" value="${escapeHtml(draft.authToken || '')}" placeholder="CODEBUDDY_AUTH_TOKEN">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="codebuddy-profile-api-key" value="${escapeHtml(draft.apiKey || '')}" placeholder="CODEBUDDY_API_KEY">
        </div>
        <div class="settings-inline-note">
          至少填写一项凭据。保存后仅影响新建的 CodeBuddy 会话；已有会话会继续使用原先绑定的 Profile。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codebuddy-profile-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#codebuddy-profile-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#codebuddy-profile-ok').addEventListener('click', () => {
        const name = modal.querySelector('#codebuddy-profile-name').value.trim();
        const authToken = modal.querySelector('#codebuddy-profile-auth-token').value.trim();
        const apiKey = modal.querySelector('#codebuddy-profile-api-key').value.trim();
        if (!name) {
          alert('请输入 Profile 名称');
          return;
        }
        if (!authToken && !apiKey) {
          alert('Auth Token 和 API Key 至少填写一项');
          return;
        }
        const duplicated = codebuddyEditingProfiles.find((profile) => profile.name === name && profile.name !== draft._originalName);
        if (duplicated) {
          alert('Profile 名称已存在');
          return;
        }
        const next = {
          name,
          authToken,
          apiKey,
          _originalName: draft._originalName,
        };
        if (draft._originalName) {
          const index = codebuddyEditingProfiles.findIndex((profile) => profile.name === draft._originalName);
          if (index >= 0) codebuddyEditingProfiles[index] = next;
          else codebuddyEditingProfiles.push(next);
        } else {
          codebuddyEditingProfiles.push(next);
        }
        codebuddyActiveProfile = name;
        closeModal();
        renderCodebuddyConfigArea();
      });
    }

    codebuddySaveBtn.addEventListener('click', () => {
      const isLocal = codebuddyActiveProfile === '';
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeProfile: isLocal ? '' : codebuddyActiveProfile,
        profiles: codebuddyEditingProfiles,
      };
      send({ type: 'save_codebuddy_config', config });
      showCodebuddyStatus('已保存', 'success');
    });

    _onCodebuddyConfig = (config) => {
      currentCodebuddyConfig = config;
      codebuddyEditingProfiles = (config?.profiles || []).map((profile) => ({ ...profile, _originalName: profile.name }));
      if (config?.mode === 'local') {
        codebuddyActiveProfile = '';
      } else {
        codebuddyActiveProfile = config?.activeProfile || (codebuddyEditingProfiles[0]?.name || '');
      }
      renderCodebuddyConfigArea();
    };

    // === Claude Config UI ===
    const claudeConfigArea = panel.querySelector('#claude-config-area');
    const modelStatusDiv = panel.querySelector('#model-status');
    const modelSaveBtn = panel.querySelector('#model-save-btn');

    let modelCurrentConfig = null;
    let modelEditingTemplates = [];
    let modelActiveTemplate = '';

    function showModelStatus(msg, type) {
      modelStatusDiv.textContent = msg;
      modelStatusDiv.className = 'settings-status ' + (type || '');
    }

    function renderClaudeConfigArea() {
      const isLocal = modelActiveTemplate === '';
      const tplOptions = modelEditingTemplates.map(t =>
        `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`
      ).join('');

      if (isLocal) {
        const hasSnapshot = modelCurrentConfig?.localSnapshot && Object.keys(modelCurrentConfig.localSnapshot).length > 0
          && (modelCurrentConfig.localSnapshot.apiKey || modelCurrentConfig.localSnapshot.apiBase);
        claudeConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活模板</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="claude-tpl-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${tplOptions}
                <option value="__new__">+ 新建模板</option>
              </select>
              <button class="btn-test" id="claude-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="claude-read-local-btn" style="padding:4px 10px">读取当前配置</button>
              ${hasSnapshot ? '<button class="btn-test" id="claude-restore-btn" style="padding:4px 10px">恢复快照</button>' : ''}
            </div>
          </div>
          <div class="settings-inline-note">
            Agent 直接使用本机 <code>~/.claude/settings.json</code> 中的 API 信息，不会覆盖或修改本机配置。
          </div>
        `;
        panel.querySelector('#claude-tpl-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            const newName = prompt('输入新模板名称:');
            if (!newName || !newName.trim()) { e.target.value = '__local__'; return; }
            const n = newName.trim();
            if (modelEditingTemplates.find(t => t.name === n)) { alert('模板名称已存在'); e.target.value = '__local__'; return; }
            modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
            modelActiveTemplate = n;
            renderClaudeConfigArea();
            openTplEditModal();
          } else {
            modelActiveTemplate = e.target.value;
            renderClaudeConfigArea();
          }
        });
        panel.querySelector('#claude-info-btn').addEventListener('click', showClaudeLocalInfoModal);
        panel.querySelector('#claude-read-local-btn').addEventListener('click', () => send({ type: 'read_claude_local_config' }));
        const restoreBtn = panel.querySelector('#claude-restore-btn');
        if (restoreBtn) restoreBtn.addEventListener('click', () => send({ type: 'restore_claude_local_snapshot' }));
        return;
      }

      // Custom template selected
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      const summary = tpl ? `API Key: <code>${tpl.apiKey ? '已设置' : '未设置'}</code> · Base: <code>${escapeHtml(tpl.apiBase || '默认')}</code>` : '';
      claudeConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活模板</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="claude-tpl-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${tplOptions}
              <option value="__new__">+ 新建模板</option>
            </select>
            <button class="btn-test" id="model-tpl-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="model-tpl-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">${summary}</div>
      `;

      panel.querySelector('#claude-tpl-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          const newName = prompt('输入新模板名称:');
          if (!newName || !newName.trim()) { e.target.value = escapeHtml(modelActiveTemplate); return; }
          const n = newName.trim();
          if (modelEditingTemplates.find(t => t.name === n)) { alert('模板名称已存在'); e.target.value = escapeHtml(modelActiveTemplate); return; }
          modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
          modelActiveTemplate = n;
          renderClaudeConfigArea();
          openTplEditModal();
        } else if (e.target.value === '__local__') {
          modelActiveTemplate = '';
          renderClaudeConfigArea();
        } else {
          modelActiveTemplate = e.target.value;
          renderClaudeConfigArea();
        }
      });
      panel.querySelector('#model-tpl-edit').addEventListener('click', () => openTplEditModal());
      const delBtn = panel.querySelector('#model-tpl-del');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (!modelActiveTemplate) return;
          if (!confirm(`确认删除模板「${modelActiveTemplate}」?`)) return;
          modelEditingTemplates = modelEditingTemplates.filter(t => t.name !== modelActiveTemplate);
          modelActiveTemplate = modelEditingTemplates[0]?.name || '';
          renderClaudeConfigArea();
        });
      }
    }

    function openTplEditModal() {
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      if (!tpl) return;
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>编辑模板: ${escapeHtml(tpl.name)}</h3>
          <button class="settings-close" id="tpl-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>模板名称</label>
          <input type="text" id="tpl-ed-name" value="${escapeHtml(tpl.name)}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="tpl-ed-apikey" placeholder="sk-ant-..." value="${escapeHtml(tpl.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="tpl-ed-apibase" placeholder="https://api.anthropic.com" value="${escapeHtml(tpl.apiBase || '')}">
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">获取上游模型列表</label>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="tpl-ed-custom-endpoint"> 端点
            </label>
            <input type="text" id="tpl-ed-models-endpoint" placeholder="/v1/models" style="flex:1;display:none" value="">
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <button class="btn-test" id="tpl-ed-fetch-models" style="padding:4px 12px;white-space:nowrap">获取模型</button>
            <span id="tpl-ed-fetch-status" style="font-size:0.85em;color:var(--text-secondary)"></span>
          </div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label>默认模型 (ANTHROPIC_MODEL)</label>
          <input type="text" id="tpl-ed-default" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.defaultModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Opus 模型名</label>
          <input type="text" id="tpl-ed-opus" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.opusModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Sonnet 模型名</label>
          <input type="text" id="tpl-ed-sonnet" list="tpl-dl-models" placeholder="claude-sonnet-4-6" value="${escapeHtml(tpl.sonnetModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Haiku 模型名</label>
          <input type="text" id="tpl-ed-haiku" list="tpl-dl-models" placeholder="claude-haiku-4-5-20251001" value="${escapeHtml(tpl.haikuModel || '')}" autocomplete="off">
        </div>
        <datalist id="tpl-dl-models"></datalist>
        <div class="settings-actions">
          <button class="btn-save" id="tpl-ed-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const customEndpointCb = modal.querySelector('#tpl-ed-custom-endpoint');
      const endpointInput = modal.querySelector('#tpl-ed-models-endpoint');
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });
      const fetchBtn = modal.querySelector('#tpl-ed-fetch-models');
      const fetchStatus = modal.querySelector('#tpl-ed-fetch-status');
      const datalist = modal.querySelector('#tpl-dl-models');
      fetchBtn.addEventListener('click', () => {
        const apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        const apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        if (!apiBase || !apiKey) {
          fetchStatus.textContent = '请先填写 API Base 和 API Key';
          fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          return;
        }
        const modelsEndpoint = customEndpointCb.checked ? endpointInput.value.trim() : '';
        fetchBtn.disabled = true;
        fetchStatus.textContent = '正在获取...';
        fetchStatus.style.color = 'var(--text-secondary)';
        _onFetchModelsResult = (result) => {
          _onFetchModelsResult = null;
          fetchBtn.disabled = false;
          if (result.success) {
            datalist.innerHTML = result.models.map(m => `<option value="${escapeHtml(m)}">`).join('');
            fetchStatus.textContent = `获取到 ${result.models.length} 个模型`;
            fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
          } else {
            fetchStatus.textContent = result.message || '获取失败';
            fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          }
        };
        send({ type: 'fetch_models', apiBase, apiKey, modelsEndpoint: modelsEndpoint || undefined, templateName: tpl.name });
      });
      const closeModal = () => {
        _onFetchModelsResult = null;
        document.body.removeChild(modalOverlay);
      };
      modal.querySelector('#tpl-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#tpl-ed-ok').addEventListener('click', () => {
        const newName = modal.querySelector('#tpl-ed-name').value.trim();
        if (newName && newName !== tpl.name) {
          if (modelEditingTemplates.find(t => t.name === newName && t !== tpl)) { alert('模板名称已存在'); return; }
          tpl.name = newName;
          modelActiveTemplate = newName;
        }
        tpl.apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        tpl.apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        tpl.defaultModel = modal.querySelector('#tpl-ed-default').value.trim();
        tpl.opusModel = modal.querySelector('#tpl-ed-opus').value.trim();
        tpl.sonnetModel = modal.querySelector('#tpl-ed-sonnet').value.trim();
        tpl.haikuModel = modal.querySelector('#tpl-ed-haiku').value.trim();
        closeModal();
        renderClaudeConfigArea();
      });
    }

    function showClaudeLocalInfoModal() {
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>本地配置说明</h3>
          <button class="settings-close" id="claude-info-close">&times;</button>
        </div>
        <div class="settings-inline-note">
          选中"本地配置"时，Agent 直接使用本机原生配置文件中的 API 信息，不会覆盖或修改本机配置。
          <br><br>
          <strong>• Claude：</strong>切换到自定义模板时，本机 ~/.claude/settings.json 中的 API 配置会被替换为模板值。再次切回"本地配置"时，可一键恢复之前保存的快照到 settings.json。
          <br><br>
          <strong>• Codex：</strong>自定义模板不会修改本机 ~/.codex/，切回"本地配置"时自动恢复本机直通，无需恢复操作。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="claude-info-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#claude-info-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#claude-info-ok').addEventListener('click', closeModal);
    }

    function showCodexLocalInfoModal() {
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>Codex 本地配置说明</h3>
          <button class="settings-close" id="codex-info-close">&times;</button>
        </div>
        <div class="settings-inline-note">
          选中"本地配置"时，CC-Web 会直接复用本机 <code>codex</code> 的登录态与 <code>~/.codex/config.toml</code>，不会覆盖或修改本机文件。
          <br><br>
          切换到自定义 Profile 后，只会在 CC-Web 为当前会话准备独立的运行时目录与 API 凭据，不会改写你的本地 Codex 配置。
          <br><br>
          切回"本地配置"后会立即恢复本机直通模式，不需要像 Claude 那样手动恢复快照。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codex-info-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#codex-info-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#codex-info-ok').addEventListener('click', closeModal);
    }

    function showCodebuddyLocalInfoModal() {
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>CodeBuddy CLI 配置说明</h3>
          <button class="settings-close" id="codebuddy-info-close">&times;</button>
        </div>
        <div class="settings-inline-note">
          当前接入方式会直接调用本机 <code>codebuddy</code>（或别名 <code>cbc</code>）CLI。
          <br><br>
          选中"本地登录态"时，会直接沿用你本机已有的 CodeBuddy CLI 登录态，不改写本机 <code>.codebuddy</code>。
          <br><br>
          选中自定义 Profile 后，CC-Web 只会在启动新的 CodeBuddy 会话时注入对应的 <code>CODEBUDDY_AUTH_TOKEN</code> / <code>CODEBUDDY_API_KEY</code>，用于实现多账号切换；已有会话不会被强行切换。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codebuddy-info-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#codebuddy-info-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#codebuddy-info-ok').addEventListener('click', closeModal);
    }

    function showKimiLocalInfoModal() {
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>Kimi 本地配置说明</h3>
          <button class="settings-close" id="kimi-info-close">&times;</button>
        </div>
        <div class="settings-inline-note">
          选中"本地配置"时，CC-Web 会直接复用本机 <code>~/.kimi/config.toml</code>（或旧版 <code>config.json</code>）中的 Kimi CLI 配置，不会覆盖或修改本机文件。
          <br><br>
          切换到自定义 Profile 后，CC-Web 会为当前运行生成独立的 Kimi JSON 配置，并通过 <code>kimi --config-file ...</code> 启动，不会改写你的本地 <code>~/.kimi</code>。
          <br><br>
          模型切换只会使用当前激活 Profile 中定义的模型别名；如果需要在 Web 里切模型，请先把对应模型加入该 Profile。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="kimi-info-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#kimi-info-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#kimi-info-ok').addEventListener('click', closeModal);
    }

    modelSaveBtn.addEventListener('click', () => {
      const isLocal = modelActiveTemplate === '';
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeTemplate: isLocal ? '' : modelActiveTemplate,
        templates: modelEditingTemplates,
        localSnapshot: modelCurrentConfig?.localSnapshot || {},
      };
      send({ type: 'save_model_config', config });
      showModelStatus('已保存', 'success');
    });

    _onModelConfig = (config) => {
      modelCurrentConfig = config;
      modelEditingTemplates = (config.templates || []).map(t => Object.assign({}, t));
      if (config.mode === 'local') {
        modelActiveTemplate = '';
      } else {
        modelActiveTemplate = config.activeTemplate || (modelEditingTemplates[0]?.name || '');
      }
      renderClaudeConfigArea();
    };

    _onClaudeLocalConfig = (msg) => {
      const config = msg.config || {};
      const hasData = config.apiKey || config.apiBase;
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      const fields = [
        ['API Key', config.apiKey || '(空)'],
        ['API Base URL', config.apiBase || '(空)'],
        ['默认模型', config.defaultModel || '(空)'],
        ['Opus 模型', config.opusModel || '(空)'],
        ['Sonnet 模型', config.sonnetModel || '(空)'],
        ['Haiku 模型', config.haikuModel || '(空)'],
      ];
      modal.innerHTML = `
        <div class="settings-header">
          <h3>当前 Claude 本地配置</h3>
          <button class="settings-close" id="read-local-close">&times;</button>
        </div>
        ${msg.sourceFound ? '' : '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.claude/settings.json，以下为空值。</div>'}
        ${fields.map(([label, val]) => `
          <div class="settings-field">
            <label>${label}</label>
            <div style="font-size:0.9em;word-break:break-all;color:var(--text-secondary)">${escapeHtml(val)}</div>
          </div>
        `).join('')}
        ${hasData ? '<div class="settings-actions"><button class="btn-save" id="save-snapshot-btn">保存为快照</button></div>' : ''}
        <div class="settings-actions"><button class="btn-save" id="read-local-ok">关闭</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#read-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#read-local-ok').addEventListener('click', closeModal);
      const saveBtn = modal.querySelector('#save-snapshot-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          send({ type: 'save_local_snapshot', snapshot: config });
          closeModal();
        });
      }
    };

    // === Codex Config UI ===
    const codexConfigArea = panel.querySelector('#codex-config-area');
    const codexStatus = panel.querySelector('#codex-status');
    const codexSaveBtn = panel.querySelector('#codex-save-btn');

    let currentCodexConfig = null;
    let codexEditingProfiles = [];
    let codexActiveProfile = '';

    function showCodexStatus(msg, type) {
      codexStatus.textContent = msg;
      codexStatus.className = 'settings-status ' + (type || '');
    }

    function renderCodexConfigArea() {
      const isLocal = codexActiveProfile === '';
      const profileOptions = codexEditingProfiles.map((profile) =>
        `<option value="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</option>`
      ).join('');

      if (isLocal) {
        codexConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活 Profile</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="codex-profile-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${profileOptions}
                <option value="__new__">+ 新建 Profile</option>
              </select>
              <button class="btn-test" id="codex-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="codex-read-local-btn" style="padding:4px 10px">读取当前配置</button>
            </div>
          </div>
          <div class="settings-inline-note">
            直接复用本机 <code>codex</code> 的登录态与 <code>~/.codex/config.toml</code>。
          </div>
        `;
        panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            openCodexProfileModal();
          } else if (e.target.value === '__local__') {
            codexActiveProfile = '';
            renderCodexConfigArea();
          } else {
            codexActiveProfile = e.target.value;
            renderCodexConfigArea();
          }
        });
        panel.querySelector('#codex-info-btn').addEventListener('click', showCodexLocalInfoModal);
        panel.querySelector('#codex-read-local-btn').addEventListener('click', () => send({ type: 'read_codex_local_config' }));
        return;
      }

      // Custom profile selected
      const currentProfile = codexEditingProfiles.find((profile) => profile.name === codexActiveProfile);
      const summaryBase = currentProfile?.apiBase ? escapeHtml(currentProfile.apiBase) : '默认';

      codexConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活 Profile</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="codex-profile-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${profileOptions}
              <option value="__new__">+ 新建 Profile</option>
            </select>
            <button class="btn-test" id="codex-profile-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="codex-profile-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">
          当前 Profile：<strong>${escapeHtml(currentProfile?.name || '未选择')}</strong> · API Base：<code>${summaryBase}</code>
        </div>
      `;

      panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openCodexProfileModal();
        } else if (e.target.value === '__local__') {
          codexActiveProfile = '';
          renderCodexConfigArea();
        } else {
          codexActiveProfile = e.target.value;
          renderCodexConfigArea();
        }
      });
      panel.querySelector('#codex-profile-edit').addEventListener('click', () => {
        openCodexProfileModal(codexActiveProfile);
      });
      panel.querySelector('#codex-profile-del').addEventListener('click', () => {
        if (!codexActiveProfile) return;
        if (!confirm(`确认删除 Codex Profile「${codexActiveProfile}」?`)) return;
        codexEditingProfiles = codexEditingProfiles.filter((profile) => profile.name !== codexActiveProfile);
        codexActiveProfile = codexEditingProfiles[0]?.name || '';
        renderCodexConfigArea();
      });
    }

    function openCodexProfileModal(profileName = '') {
      const current = profileName
        ? codexEditingProfiles.find((profile) => profile.name === profileName)
        : null;
      const draft = current || { name: '', apiKey: '', apiBase: '' };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${current ? `编辑 Profile: ${escapeHtml(current.name)}` : '新建 Codex Profile'}</h3>
          <button class="settings-close" id="codex-profile-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>Profile 名称</label>
          <input type="text" id="codex-profile-name" placeholder="例如 OpenRouter Work" value="${escapeHtml(draft.name || '')}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="codex-profile-apikey" placeholder="sk-..." value="${escapeHtml(draft.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="codex-profile-apibase" placeholder="https://api.openai.com/v1" value="${escapeHtml(draft.apiBase || '')}">
        </div>
        <div class="settings-inline-note">
          Codex 只把 API 入口和密钥切换到当前 Profile，模型 ID 仍由会话内模型切换逻辑控制。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codex-profile-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#codex-profile-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#codex-profile-ok').addEventListener('click', () => {
        const name = modal.querySelector('#codex-profile-name').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        if (!name) { alert('请填写 Profile 名称'); return; }
        if (!apiKey) { alert('请填写 API Key'); return; }
        if (!apiBase) { alert('请填写 API Base URL'); return; }
        const existing = codexEditingProfiles.find((profile) => profile.name === name);
        if (existing && existing !== current) { alert('Profile 名称已存在'); return; }
        if (current) {
          current.name = name;
          current.apiKey = apiKey;
          current.apiBase = apiBase;
        } else {
          codexEditingProfiles.push({ name, apiKey, apiBase });
        }
        codexActiveProfile = name;
        closeModal();
        renderCodexConfigArea();
      });
    }

    _onCodexConfig = (config) => {
      currentCodexConfig = config || {};
      codexEditingProfiles = (currentCodexConfig.profiles || []).map((profile) => ({ ...profile }));
      if (currentCodexConfig.mode === 'local') {
        codexActiveProfile = '';
      } else {
        codexActiveProfile = currentCodexConfig.activeProfile || (codexEditingProfiles[0]?.name || '');
      }
      renderCodexConfigArea();
    };

    codexSaveBtn.addEventListener('click', () => {
      const isLocal = codexActiveProfile === '';
      if (!isLocal && codexEditingProfiles.length === 0) {
        showCodexStatus('自定义模式至少需要一个 Codex Profile', 'error');
        return;
      }
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeProfile: isLocal ? '' : codexActiveProfile,
        profiles: codexEditingProfiles,
        enableSearch: false,
        localSnapshot: currentCodexConfig?.localSnapshot || {},
      };
      send({ type: 'save_codex_config', config });
      showCodexStatus('已保存', 'success');
    });

    _onCodexLocalConfig = (msg) => {
      const config = msg.config || {};
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      const fields = [
        ['API Key', config.apiKey || '(空)'],
        ['API Base URL', config.apiBase || '(空)'],
      ];
      modal.innerHTML = `
        <div class="settings-header">
          <h3>当前 Codex 本地配置</h3>
          <button class="settings-close" id="read-codex-local-close">&times;</button>
        </div>
        ${msg.warning ? `<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">${escapeHtml(msg.warning)}</div>` : ''}
        ${!msg.sourceFound ? '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.codex/ 配置文件。</div>' : ''}
        ${fields.map(([label, val]) => `
          <div class="settings-field">
            <label>${label}</label>
            <div style="font-size:0.9em;word-break:break-all;color:var(--text-secondary)">${escapeHtml(val)}</div>
          </div>
        `).join('')}
        <div class="settings-actions"><button class="btn-save" id="read-codex-local-ok">关闭</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#read-codex-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#read-codex-local-ok').addEventListener('click', closeModal);
    };

    // === Kimi Config UI ===
    const kimiConfigArea = panel.querySelector('#kimi-config-area');
    const kimiStatus = panel.querySelector('#kimi-status');
    const kimiSaveBtn = panel.querySelector('#kimi-save-btn');

    let currentKimiConfig = null;
    let kimiEditingProfiles = [];
    let kimiActiveProfile = '';

    function cloneKimiProfile(profile = {}) {
      return {
        _originalName: profile._originalName || profile.name || '',
        name: profile.name || '',
        providerType: profile.providerType || 'kimi',
        apiKey: profile.apiKey || '',
        apiBase: profile.apiBase || '',
        defaultModel: profile.defaultModel || '',
        models: Array.isArray(profile.models) ? profile.models.map((model) => ({
          name: model?.name || '',
          model: model?.model || '',
          maxContextSize: model?.maxContextSize || 262144,
          capabilities: Array.isArray(model?.capabilities) ? [...model.capabilities] : [],
        })) : [],
        services: {
          searchBase: profile.services?.searchBase || '',
          searchApiKey: profile.services?.searchApiKey || '',
          fetchBase: profile.services?.fetchBase || '',
          fetchApiKey: profile.services?.fetchApiKey || '',
        },
      };
    }

    function normalizeKimiCapabilities(list) {
      const allowed = new Set(KIMI_CAPABILITY_OPTIONS.map((item) => item.value));
      const seen = new Set();
      const result = [];
      (Array.isArray(list) ? list : []).forEach((item) => {
        const value = String(item || '').trim();
        if (!value || !allowed.has(value) || seen.has(value)) return;
        seen.add(value);
        result.push(value);
      });
      return result;
    }

    function ensureKimiDefaultModel(profile) {
      const names = (Array.isArray(profile.models) ? profile.models : [])
        .map((model) => String(model?.name || '').trim())
        .filter(Boolean);
      if (!names.length) {
        profile.defaultModel = '';
        return;
      }
      if (!names.includes(profile.defaultModel)) {
        profile.defaultModel = names[0];
      }
    }

    function normalizeKimiProfile(profile = {}) {
      const next = cloneKimiProfile(profile);
      next.models = next.models.filter((model) => model.name && model.model);
      next.models.forEach((model) => {
        const parsed = parseInt(model.maxContextSize, 10);
        model.maxContextSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 262144;
        model.capabilities = normalizeKimiCapabilities(model.capabilities);
      });
      ensureKimiDefaultModel(next);
      return next;
    }

    function showKimiStatus(msg, type) {
      kimiStatus.textContent = msg;
      kimiStatus.className = 'settings-status ' + (type || '');
    }

    function renderKimiConfigArea() {
      const isLocal = kimiActiveProfile === '';
      const profileOptions = kimiEditingProfiles.map((profile) =>
        `<option value="${escapeHtml(profile.name)}" ${profile.name === kimiActiveProfile ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`
      ).join('');

      if (isLocal) {
        kimiConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活 Profile</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="kimi-profile-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${profileOptions}
                <option value="__new__">+ 新建 Profile</option>
              </select>
              <button class="btn-test" id="kimi-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="kimi-read-local-btn" style="padding:4px 10px">读取当前配置</button>
            </div>
          </div>
          <div class="settings-inline-note">
            直接复用本机 <code>~/.kimi/config.toml</code>（或旧版 <code>config.json</code>）中的 Kimi CLI 配置。
          </div>
        `;
        panel.querySelector('#kimi-profile-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            openKimiProfileModal();
          } else if (e.target.value === '__local__') {
            kimiActiveProfile = '';
            renderKimiConfigArea();
          } else {
            kimiActiveProfile = e.target.value;
            renderKimiConfigArea();
          }
        });
        panel.querySelector('#kimi-info-btn').addEventListener('click', showKimiLocalInfoModal);
        panel.querySelector('#kimi-read-local-btn').addEventListener('click', () => send({ type: 'read_kimi_local_config' }));
        return;
      }

      const currentProfile = kimiEditingProfiles.find((profile) => profile.name === kimiActiveProfile);
      const summaryProvider = currentProfile?.providerType || 'kimi';
      const summaryModel = currentProfile?.defaultModel || '未设置';
      const summaryCount = Array.isArray(currentProfile?.models) ? currentProfile.models.length : 0;

      kimiConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活 Profile</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="kimi-profile-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${profileOptions}
              <option value="__new__">+ 新建 Profile</option>
            </select>
            <button class="btn-test" id="kimi-profile-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="kimi-profile-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">
          当前 Profile：<strong>${escapeHtml(currentProfile?.name || '未选择')}</strong> · Provider：<code>${escapeHtml(summaryProvider)}</code> · 默认模型：<code>${escapeHtml(summaryModel)}</code> · 模型数：<code>${summaryCount}</code>
        </div>
      `;

      panel.querySelector('#kimi-profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openKimiProfileModal();
        } else if (e.target.value === '__local__') {
          kimiActiveProfile = '';
          renderKimiConfigArea();
        } else {
          kimiActiveProfile = e.target.value;
          renderKimiConfigArea();
        }
      });
      panel.querySelector('#kimi-profile-edit').addEventListener('click', () => openKimiProfileModal(kimiActiveProfile));
      panel.querySelector('#kimi-profile-del').addEventListener('click', () => {
        if (!kimiActiveProfile) return;
        if (!confirm(`确认删除 Kimi Profile「${kimiActiveProfile}」?`)) return;
        kimiEditingProfiles = kimiEditingProfiles.filter((profile) => profile.name !== kimiActiveProfile);
        kimiActiveProfile = kimiEditingProfiles[0]?.name || '';
        renderKimiConfigArea();
      });
    }

    function openKimiModelModal(targetProfile, modelIndex = -1, rerender = () => {}) {
      const currentModel = modelIndex >= 0 ? targetProfile.models[modelIndex] : null;
      const draftModel = currentModel
        ? { ...currentModel, capabilities: Array.isArray(currentModel.capabilities) ? [...currentModel.capabilities] : [] }
        : { name: '', model: '', maxContextSize: 262144, capabilities: [] };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${currentModel ? `编辑模型: ${escapeHtml(currentModel.name)}` : '添加模型'}</h3>
          <button class="settings-close" id="kimi-model-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>模型别名</label>
          <input type="text" id="kimi-model-name" placeholder="例如 kimi-for-coding" value="${escapeHtml(draftModel.name || '')}">
        </div>
        <div class="settings-field">
          <label>API 模型 ID</label>
          <input type="text" id="kimi-model-id" placeholder="例如 kimi-k2-thinking-turbo" value="${escapeHtml(draftModel.model || '')}">
        </div>
        <div class="settings-field">
          <label>最大上下文长度</label>
          <input type="number" id="kimi-model-context" min="1" step="1" value="${escapeHtml(String(draftModel.maxContextSize || 262144))}">
        </div>
        <div class="settings-field">
          <label>能力</label>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            ${KIMI_CAPABILITY_OPTIONS.map((item) => `
              <label style="font-size:0.88em;display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" data-kimi-cap="${escapeHtml(item.value)}" ${draftModel.capabilities.includes(item.value) ? 'checked' : ''} style="width:auto;margin:0">
                <span>${escapeHtml(item.label)}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="kimi-model-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#kimi-model-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#kimi-model-ok').addEventListener('click', () => {
        const name = modal.querySelector('#kimi-model-name').value.trim();
        const model = modal.querySelector('#kimi-model-id').value.trim();
        const parsedContext = parseInt(modal.querySelector('#kimi-model-context').value, 10);
        const maxContextSize = Number.isFinite(parsedContext) && parsedContext > 0 ? parsedContext : 0;
        const capabilities = normalizeKimiCapabilities(Array.from(modal.querySelectorAll('[data-kimi-cap]'))
          .filter((input) => input.checked)
          .map((input) => input.getAttribute('data-kimi-cap')));
        if (!name) { alert('请填写模型别名'); return; }
        if (!model) { alert('请填写 API 模型 ID'); return; }
        if (!maxContextSize) { alert('请填写有效的最大上下文长度'); return; }
        const existing = targetProfile.models.find((item, index) => item.name === name && index !== modelIndex);
        if (existing) { alert('模型别名已存在'); return; }
        const previousName = currentModel?.name || '';
        const nextModel = { name, model, maxContextSize, capabilities };
        if (modelIndex >= 0) {
          targetProfile.models[modelIndex] = nextModel;
        } else {
          targetProfile.models.push(nextModel);
        }
        if (!targetProfile.defaultModel || targetProfile.defaultModel === previousName) {
          targetProfile.defaultModel = name;
        }
        ensureKimiDefaultModel(targetProfile);
        closeModal();
        rerender();
      });
    }

    function openKimiProfileModal(profileName = '') {
      const current = profileName
        ? kimiEditingProfiles.find((profile) => profile.name === profileName)
        : null;
      const draft = normalizeKimiProfile(current || {
        name: '',
        providerType: 'kimi',
        apiKey: '',
        apiBase: '',
        defaultModel: '',
        models: [],
        services: { searchBase: '', searchApiKey: '', fetchBase: '', fetchApiKey: '' },
      });
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '560px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${current ? `编辑 Kimi Profile: ${escapeHtml(current.name)}` : '新建 Kimi Profile'}</h3>
          <button class="settings-close" id="kimi-profile-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>Profile 名称</label>
          <input type="text" id="kimi-profile-name" placeholder="例如 Moonshot Work" value="${escapeHtml(draft.name || '')}">
        </div>
        <div class="settings-field">
          <label>Provider 类型</label>
          <select class="settings-select" id="kimi-profile-provider">
            ${KIMI_PROVIDER_OPTIONS.map((item) => `<option value="${escapeHtml(item.value)}" ${draft.providerType === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="kimi-profile-apikey" placeholder="sk-..." value="${escapeHtml(draft.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="kimi-profile-apibase" placeholder="https://api.kimi.com/coding/v1" value="${escapeHtml(draft.apiBase || '')}">
        </div>
        <div class="settings-field">
          <label>默认模型</label>
          <select class="settings-select" id="kimi-profile-default-model"></select>
        </div>
        <div class="settings-field">
          <label>模型定义</label>
          <div id="kimi-model-list"></div>
          <div class="settings-actions" style="margin-top:10px">
            <button class="btn-test" id="kimi-model-add" style="padding:4px 12px">添加模型</button>
          </div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label>Search 服务 Base URL（可选）</label>
          <input type="text" id="kimi-search-base" placeholder="https://api.kimi.com/coding/v1/search" value="${escapeHtml(draft.services.searchBase || '')}">
        </div>
        <div class="settings-field">
          <label>Search 服务 API Key（可选）</label>
          <input type="text" id="kimi-search-apikey" placeholder="sk-..." value="${escapeHtml(draft.services.searchApiKey || '')}">
        </div>
        <div class="settings-field">
          <label>Fetch 服务 Base URL（可选）</label>
          <input type="text" id="kimi-fetch-base" placeholder="https://api.kimi.com/coding/v1/fetch" value="${escapeHtml(draft.services.fetchBase || '')}">
        </div>
        <div class="settings-field">
          <label>Fetch 服务 API Key（可选）</label>
          <input type="text" id="kimi-fetch-apikey" placeholder="sk-..." value="${escapeHtml(draft.services.fetchApiKey || '')}">
        </div>
        <div class="settings-inline-note">
          Kimi 会读取 Profile 里定义的模型别名。会话内的模型切换只会在这些别名之间生效；搜索和抓取服务不填则按 Kimi CLI 默认行为处理。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="kimi-profile-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);

      const defaultModelSelect = modal.querySelector('#kimi-profile-default-model');
      const modelList = modal.querySelector('#kimi-model-list');

      function renderDraftModels() {
        ensureKimiDefaultModel(draft);
        const options = draft.models.map((model) =>
          `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}</option>`
        ).join('');
        defaultModelSelect.innerHTML = options || '<option value="">请先添加模型</option>';
        defaultModelSelect.value = draft.defaultModel || '';
        modelList.innerHTML = draft.models.length ? draft.models.map((model, index) => `
          <div class="settings-inline-note" style="margin-top:${index === 0 ? '0' : '8px'}">
            <strong>${escapeHtml(model.name)}</strong> → <code>${escapeHtml(model.model)}</code> · ${escapeHtml(String(model.maxContextSize))} tokens · ${escapeHtml(model.capabilities.join(', ') || '无额外能力')}
            <span style="float:right;display:flex;gap:6px">
              <button class="btn-test" type="button" data-kimi-model-edit="${index}" style="padding:2px 10px">编辑</button>
              <button class="btn-test" type="button" data-kimi-model-del="${index}" style="padding:2px 10px">删除</button>
            </span>
          </div>
        `).join('') : '<div class="settings-inline-note">还没有配置模型，请至少添加一个模型。</div>';
        modelList.querySelectorAll('[data-kimi-model-edit]').forEach((btn) => {
          btn.addEventListener('click', () => {
            openKimiModelModal(draft, parseInt(btn.getAttribute('data-kimi-model-edit'), 10), renderDraftModels);
          });
        });
        modelList.querySelectorAll('[data-kimi-model-del]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const index = parseInt(btn.getAttribute('data-kimi-model-del'), 10);
            const removed = draft.models[index];
            if (!removed) return;
            draft.models.splice(index, 1);
            if (draft.defaultModel === removed.name) {
              draft.defaultModel = draft.models[0]?.name || '';
            }
            renderDraftModels();
          });
        });
      }

      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#kimi-profile-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#kimi-model-add').addEventListener('click', () => openKimiModelModal(draft, -1, renderDraftModels));
      renderDraftModels();

      modal.querySelector('#kimi-profile-ok').addEventListener('click', () => {
        const name = modal.querySelector('#kimi-profile-name').value.trim();
        const providerType = modal.querySelector('#kimi-profile-provider').value;
        const apiKey = modal.querySelector('#kimi-profile-apikey').value.trim();
        const apiBase = modal.querySelector('#kimi-profile-apibase').value.trim();
        const defaultModel = defaultModelSelect.value.trim();
        const searchBase = modal.querySelector('#kimi-search-base').value.trim();
        const searchApiKey = modal.querySelector('#kimi-search-apikey').value.trim();
        const fetchBase = modal.querySelector('#kimi-fetch-base').value.trim();
        const fetchApiKey = modal.querySelector('#kimi-fetch-apikey').value.trim();
        if (!name) { alert('请填写 Profile 名称'); return; }
        if (!apiKey) { alert('请填写 API Key'); return; }
        if (!apiBase) { alert('请填写 API Base URL'); return; }
        if (draft.models.length === 0) { alert('请至少添加一个模型'); return; }
        if (!defaultModel) { alert('请选择默认模型'); return; }
        if ((searchBase && !searchApiKey) || (!searchBase && searchApiKey)) {
          alert('搜索服务需要同时填写 Base URL 和 API Key');
          return;
        }
        if ((fetchBase && !fetchApiKey) || (!fetchBase && fetchApiKey)) {
          alert('抓取服务需要同时填写 Base URL 和 API Key');
          return;
        }
        const existing = kimiEditingProfiles.find((profile) => profile.name === name);
        if (existing && existing !== current) { alert('Profile 名称已存在'); return; }

        const nextProfile = normalizeKimiProfile({
          _originalName: current?._originalName || current?.name || '',
          name,
          providerType,
          apiKey,
          apiBase,
          defaultModel,
          models: draft.models,
          services: {
            searchBase,
            searchApiKey,
            fetchBase,
            fetchApiKey,
          },
        });

        if (current) {
          Object.assign(current, nextProfile);
        } else {
          kimiEditingProfiles.push(nextProfile);
        }
        kimiActiveProfile = name;
        closeModal();
        renderKimiConfigArea();
      });
    }

    _onKimiConfig = (config) => {
      currentKimiConfig = config || {};
      kimiEditingProfiles = (currentKimiConfig.profiles || []).map((profile) =>
        normalizeKimiProfile({ ...profile, _originalName: profile.name })
      );
      if (currentKimiConfig.mode === 'local') {
        kimiActiveProfile = '';
      } else {
        kimiActiveProfile = currentKimiConfig.activeProfile || (kimiEditingProfiles[0]?.name || '');
      }
      renderKimiConfigArea();
    };

    kimiSaveBtn.addEventListener('click', () => {
      const isLocal = kimiActiveProfile === '';
      if (!isLocal && kimiEditingProfiles.length === 0) {
        showKimiStatus('自定义模式至少需要一个 Kimi Profile', 'error');
        return;
      }
      const profiles = kimiEditingProfiles.map((profile) => normalizeKimiProfile(profile));
      send({
        type: 'save_kimi_config',
        config: {
          mode: isLocal ? 'local' : 'custom',
          activeProfile: isLocal ? '' : kimiActiveProfile,
          profiles,
        },
      });
      showKimiStatus('已保存', 'success');
    });

    _onKimiLocalConfig = (msg) => {
      const config = msg.config || {};
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '500px';
      const fields = [
        ['配置文件', config.sourcePath || '(空)'],
        ['默认模型', config.defaultModel || '(空)'],
        ['可用模型', Array.isArray(config.models) && config.models.length ? config.models.join(', ') : '(空)'],
        ['Provider 名称', config.providerName || '(空)'],
        ['Provider 类型', config.providerType || '(空)'],
        ['API Base URL', config.apiBase || '(空)'],
        ['API Key', config.apiKey || '(空)'],
        ['当前默认模型 ID', config.modelName || '(空)'],
        ['最大上下文长度', config.maxContextSize ? String(config.maxContextSize) : '(空)'],
        ['模型能力', Array.isArray(config.capabilities) && config.capabilities.length ? config.capabilities.join(', ') : '(空)'],
        ['Search 服务', config.searchBase || '(空)'],
        ['Search API Key', config.searchApiKey || '(空)'],
        ['Fetch 服务', config.fetchBase || '(空)'],
        ['Fetch API Key', config.fetchApiKey || '(空)'],
      ];
      modal.innerHTML = `
        <div class="settings-header">
          <h3>当前 Kimi 本地配置</h3>
          <button class="settings-close" id="read-kimi-local-close">&times;</button>
        </div>
        ${!msg.sourceFound ? '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.kimi/config.toml 或 config.json。</div>' : ''}
        ${fields.map(([label, val]) => `
          <div class="settings-field">
            <label>${label}</label>
            <div style="font-size:0.9em;word-break:break-all;color:var(--text-secondary)">${escapeHtml(val)}</div>
          </div>
        `).join('')}
        <div class="settings-actions"><button class="btn-save" id="read-kimi-local-ok">关闭</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#read-kimi-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#read-kimi-local-ok').addEventListener('click', closeModal);
    };

    // === System UI ===
    const closeBtn = panel.querySelector('.settings-close');
    const pwOpenModalBtn = panel.querySelector('#pw-open-modal-btn');
    pwOpenModalBtn.addEventListener('click', openPasswordModal);

    // Check update button
    const checkUpdateBtn = panel.querySelector('#check-update-btn');
    const updateStatusEl = panel.querySelector('#update-status');
    let _onUpdateInfo = null;
    checkUpdateBtn.addEventListener('click', () => {
      updateStatusEl.textContent = '正在检查...';
      updateStatusEl.className = 'settings-status';
      _onUpdateInfo = (info) => {
        _onUpdateInfo = null;
        if (info.error) {
          updateStatusEl.textContent = '检查失败: ' + info.error;
          updateStatusEl.className = 'settings-status error';
          return;
        }
        if (info.hasUpdate) {
          updateStatusEl.innerHTML = `有新版本 <strong>v${escapeHtml(info.latestVersion)}</strong>（当前 v${escapeHtml(info.localVersion)}）&nbsp;<a href="${escapeHtml(info.releaseUrl)}" target="_blank" style="color:var(--accent)">查看更新</a>`;
          updateStatusEl.className = 'settings-status success';
        } else {
          updateStatusEl.textContent = `已是最新版本 v${info.localVersion}`;
          updateStatusEl.className = 'settings-status success';
        }
      };
      send({ type: 'check_update' });
    });

    // Wire _onUpdateInfo into WS handler via closure
    const _origOnUpdateInfo = window._ccOnUpdateInfo;
    window._ccOnUpdateInfo = (info) => { if (_onUpdateInfo) _onUpdateInfo(info); };

    closeBtn.addEventListener('click', hideSettingsPanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSettingsPanel(); });

    document.addEventListener('keydown', _settingsEscape);
  }

  function hideSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.remove();
    document.querySelectorAll('.settings-subpage-overlay').forEach((node) => node.remove());
    _onNotifyConfig = null;
    _onNotifyTestResult = null;
    _onModelConfig = null;
    _onAiConfig = null;
    _onCodexConfig = null;
    _onKimiConfig = null;
    _onFetchModelsResult = null;
    _onClaudeLocalConfig = null;
    _onCodexLocalConfig = null;
    _onKimiLocalConfig = null;
    _onCliInstallStatus = null;
    _onDevConfig = null;
    window._ccOnUpdateInfo = null;
    document.removeEventListener('keydown', _settingsEscape);
  }

  function _settingsEscape(e) {
    if (e.key === 'Escape') hideSettingsPanel();
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', showSettingsPanel);
  }

  // --- Force Change Password ---
  function showForceChangePassword() {
    const overlay = document.createElement('div');
    overlay.className = 'force-change-overlay';
    overlay.id = 'force-change-overlay';

    const panel = document.createElement('div');
    panel.className = 'force-change-panel';

    panel.innerHTML = `
      <div class="login-logo">CC</div>
      <h2>修改初始密码</h2>
      <p>首次登录需要设置新密码</p>
      <div class="force-change-form">
        <input type="password" id="fc-new-pw" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="fc-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
        <input type="password" id="fc-confirm-pw" placeholder="确认新密码" autocomplete="new-password">
        <button id="fc-submit-btn" class="fc-submit-btn" disabled>确认修改</button>
        <div class="fc-status" id="fc-status"></div>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const newPwInput = panel.querySelector('#fc-new-pw');
    const confirmPwInput = panel.querySelector('#fc-confirm-pw');
    const hintEl = panel.querySelector('#fc-hint');
    const submitBtn = panel.querySelector('#fc-submit-btn');
    const statusEl = panel.querySelector('#fc-status');

    function checkStrength() {
      const pw = newPwInput.value;
      const confirm = confirmPwInput.value;
      if (!pw) {
        hintEl.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hintEl.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(pw);
      if (!result.valid) {
        hintEl.textContent = result.message;
        hintEl.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hintEl.textContent = '密码强度符合要求';
      hintEl.className = 'password-hint success';
      submitBtn.disabled = !confirm || confirm !== pw;
    }

    newPwInput.addEventListener('input', checkStrength);
    confirmPwInput.addEventListener('input', checkStrength);

    submitBtn.addEventListener('click', () => {
      const newPw = newPwInput.value;
      const confirmPw = confirmPwInput.value;
      if (newPw !== confirmPw) {
        statusEl.textContent = '两次密码不一致';
        statusEl.className = 'fc-status error';
        return;
      }
      submitBtn.disabled = true;
      statusEl.textContent = '正在修改...';
      statusEl.className = 'fc-status';
      send({ type: 'change_password', currentPassword: loginPasswordValue || localStorage.getItem('cc-web-pw') || '', newPassword: newPw });
    });

    newPwInput.focus();
  }

  function hideForceChangePassword() {
    const overlay = document.getElementById('force-change-overlay');
    if (overlay) overlay.remove();
  }

  function clientValidatePassword(pw) {
    if (!pw || pw.length < 8) {
      return { valid: false, message: '密码长度至少 8 位' };
    }
    let types = 0;
    if (/[a-z]/.test(pw)) types++;
    if (/[A-Z]/.test(pw)) types++;
    if (/[0-9]/.test(pw)) types++;
    if (/[^a-zA-Z0-9]/.test(pw)) types++;
    if (types < 2) {
      return { valid: false, message: '需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
    }
    return { valid: true, message: '' };
  }

  // --- Password Changed Handler ---
  let _onPasswordChanged = null;

  function handlePasswordChanged(msg) {
    if (msg.success) {
      // Update token
      authToken = msg.token;
      localStorage.setItem('cc-web-token', msg.token);
      // Update remembered password
      if (localStorage.getItem('cc-web-pw')) {
        // Clear old remembered password since it's changed
        localStorage.removeItem('cc-web-pw');
      }

      // If force-change overlay is open, close it and load sessions
      const fcOverlay = document.getElementById('force-change-overlay');
      if (fcOverlay) {
        hideForceChangePassword();
        syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
        showToast('密码修改成功');
      }

      // If settings panel change password
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: true, message: msg.message });
        _onPasswordChanged = null;
      }
    } else {
      // Force-change error
      const fcStatus = document.querySelector('#fc-status');
      if (fcStatus) {
        fcStatus.textContent = msg.message || '修改失败';
        fcStatus.className = 'fc-status error';
        const btn = document.querySelector('#fc-submit-btn');
        if (btn) btn.disabled = false;
      }

      // Settings panel error
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: false, message: msg.message });
        _onPasswordChanged = null;
      }
    }
  }

  // --- Recent CWD memory (localStorage) ---
  const RECENT_CWD_KEY = 'cc-web-recent-cwds';
  const RECENT_CWD_MAX = 5;

  function getRecentCwds() {
    try {
      const raw = localStorage.getItem(RECENT_CWD_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveRecentCwd(cwd) {
    if (!cwd) return;
    let list = getRecentCwds().filter(p => p !== cwd);
    list.unshift(cwd);
    if (list.length > RECENT_CWD_MAX) list = list.slice(0, RECENT_CWD_MAX);
    try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(list)); } catch {}
  }

  // --- Pinned CWD helpers ---
  function getPinnedCwds(agent) {
    try {
      const raw = localStorage.getItem('cc-web-pinned-cwds-' + agent);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function savePinnedCwd(agent, cwd) {
    if (!cwd) return;
    let list = getPinnedCwds(agent);
    if (list.includes(cwd)) return;
    list.unshift(cwd);
    if (list.length > 5) list = list.slice(0, 5);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
  }

  function removePinnedCwd(agent, cwd) {
    let list = getPinnedCwds(agent).filter(p => p !== cwd);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
  }

  // --- New Session Modal ---
  let _onCwdSuggestions = null;
  let _onDirectoryBrowser = null;

  function buildCwdSuggestionMeta(item) {
    if (!item || typeof item !== 'object') return '';
    const sourceKinds = Array.isArray(item.sourceKinds) ? item.sourceKinds : [];
    const parts = [];
    if (sourceKinds.includes('cc-web')) parts.push('cc-web 已导入');
    if (sourceKinds.includes('claude-native')) parts.push('Claude 未导入');
    if (sourceKinds.includes('codex-rollout')) parts.push('Codex 未导入');
    if (sourceKinds.includes('kimi-native')) parts.push('Kimi 未导入');
    if (sourceKinds.includes('opencode-native')) parts.push('OpenCode 未导入');
    if (item.importedCount || item.unimportedCount) {
      const counts = [];
      if (item.importedCount) counts.push(`${item.importedCount} 个已导入`);
      if (item.unimportedCount) counts.push(`${item.unimportedCount} 个未导入`);
      parts.push(counts.join(' / '));
    }
    if (item.updatedAt) parts.push(timeAgo(item.updatedAt));
    if (item.title) parts.push(item.title);
    return parts.filter(Boolean).join(' · ');
  }

  function showDirectoryPickerModal(initialPath) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-panel modal-panel-wide">
          <div class="modal-header">
            <span class="modal-title">选择服务器文件夹</span>
            <button class="modal-close-btn" id="dir-close-btn">✕</button>
          </div>
          <div class="modal-body">
            <div class="settings-inline-note" style="margin-bottom:12px">
              浏览的是运行 CC-Web 这台电脑上的目录。点击子文件夹进入，确认时使用当前目录。
            </div>
            <div class="modal-field-row" style="margin-bottom:10px;align-items:center">
              <input type="text" id="dir-path-input" class="modal-text-input" placeholder="输入目录后回车或点前往">
              <button class="btn-test" id="dir-go-btn" style="padding:8px 14px;white-space:nowrap">前往</button>
            </div>
            <div id="dir-browser-note" class="settings-inline-note" style="margin-bottom:10px;display:none"></div>
            <div id="dir-roots" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px"></div>
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">当前目录</div>
            <div id="dir-current-path" class="settings-inline-note" style="margin-bottom:12px;word-break:break-all"></div>
            <div id="dir-list" style="display:flex;flex-direction:column;gap:8px"></div>
          </div>
          <div class="modal-footer">
            <button class="modal-btn-secondary" id="dir-cancel-btn">取消</button>
            <button class="modal-btn-primary" id="dir-confirm-btn">使用当前目录</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const prevOnDirectoryBrowser = _onDirectoryBrowser;
      const pathInput = overlay.querySelector('#dir-path-input');
      const noteEl = overlay.querySelector('#dir-browser-note');
      const rootsEl = overlay.querySelector('#dir-roots');
      const currentPathEl = overlay.querySelector('#dir-current-path');
      const listEl = overlay.querySelector('#dir-list');
      const confirmBtn = overlay.querySelector('#dir-confirm-btn');
      let currentPath = '';

      function close(result) {
        overlay.remove();
        _onDirectoryBrowser = prevOnDirectoryBrowser;
        resolve(result || null);
      }

      function browse(pathValue) {
        listEl.innerHTML = '<div class="modal-loading" style="padding:20px 0">正在读取目录…</div>';
        send({ type: 'browse_directories', path: pathValue || '' });
      }

      function bindBrowserButtons() {
        rootsEl.querySelectorAll('[data-dir-root]').forEach((button) => {
          button.addEventListener('click', () => browse(button.dataset.dirRoot));
        });
        listEl.querySelectorAll('[data-dir-nav]').forEach((button) => {
          button.addEventListener('click', () => browse(button.dataset.dirNav));
        });
      }

      _onDirectoryBrowser = (payload) => {
        currentPath = payload.currentPath || '';
        pathInput.value = currentPath;
        currentPathEl.textContent = currentPath || '未选择';
        const note = payload.error
          ? payload.error
          : (payload.truncated ? '子目录较多，仅显示前 200 个。' : '');
        noteEl.style.display = note ? '' : 'none';
        noteEl.textContent = note;
        rootsEl.innerHTML = (payload.roots || []).map((root) => `
          <button class="btn-test" data-dir-root="${escapeHtml(root.path)}" style="padding:6px 10px">
            ${escapeHtml(root.label || root.path)}
          </button>
        `).join('');
        const rows = [];
        if (payload.parentPath) {
          rows.push(`
            <button class="btn-test" data-dir-nav="${escapeHtml(payload.parentPath)}" style="display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
              <span>↑</span>
              <span>上一级</span>
            </button>
          `);
        }
        if (Array.isArray(payload.entries) && payload.entries.length > 0) {
          rows.push(...payload.entries.map((entry) => `
            <button class="btn-test" data-dir-nav="${escapeHtml(entry.path)}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;justify-content:flex-start;text-align:left">
              <span style="flex-shrink:0">📁</span>
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(entry.name)}</span>
            </button>
          `));
        } else {
          rows.push('<div class="modal-empty" style="padding:20px 0">当前目录下没有子文件夹</div>');
        }
        listEl.innerHTML = rows.join('');
        confirmBtn.disabled = !currentPath;
        bindBrowserButtons();
      };

      overlay.querySelector('#dir-close-btn').addEventListener('click', () => close(null));
      overlay.querySelector('#dir-cancel-btn').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector('#dir-go-btn').addEventListener('click', () => browse(pathInput.value.trim()));
      pathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          browse(pathInput.value.trim());
        }
      });
      confirmBtn.addEventListener('click', () => close(currentPath || pathInput.value.trim()));

      browse(initialPath || '');
    });
  }

  function showNewSessionModal(options = {}) {
    const projectOnly = options.projectOnly === true;
    const agentOrder = ['codex', 'opencode', 'codebuddy', 'kimi', 'claude'];
    const orderedAgents = AGENT_CATALOG.slice().sort((a, b) => {
      const aIndex = agentOrder.indexOf(a.id);
      const bIndex = agentOrder.indexOf(b.id);
      return (aIndex < 0 ? agentOrder.length : aIndex) - (bIndex < 0 ? agentOrder.length : bIndex);
    });
    const getNewSessionAgentLabel = (agentId) => {
      if (agentId === 'claude') return 'Claude Code';
      return getAgentDefinition(agentId)?.label || 'Agent';
    };
    let selectedAgent = projectOnly ? DEFAULT_AGENT : normalizeAgent(currentAgent);
    let selectedCodebuddyProfile = '';
    const initialLabel = projectOnly ? '项目' : getNewSessionAgentLabel(selectedAgent);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'new-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title" id="ns-title">${projectOnly ? '新建项目' : `新建 ${escapeHtml(initialLabel)} 会话`}</span>
          <button class="modal-close-btn" id="ns-close-btn">✕</button>
        </div>
        <div class="modal-body">
          ${projectOnly ? `
            <div>
              <div class="modal-field-label" style="margin-bottom:6px">项目名称</div>
              <input type="text" id="ns-project-name" class="modal-text-input" placeholder="输入项目名称" maxlength="100">
            </div>
          ` : `
            <div>
              <div class="modal-field-label" style="margin-bottom:6px">选择 Agent</div>
              <div class="ns-agent-grid" id="ns-agent-grid"></div>
            </div>
          `}
          <div class="agent-context-card" style="margin-bottom:12px">
            <div class="agent-context-kicker" id="ns-task-label">${projectOnly ? '项目' : escapeHtml(initialLabel)} · 本地任务</div>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn-test ns-task-tab active" id="ns-tab-local" style="flex:1;padding:6px 12px">本地任务</button>
            <button class="btn-test ns-task-tab" id="ns-tab-remote" style="flex:1;padding:6px 12px">远程任务</button>
          </div>
          <div id="ns-local-view"></div>
          <div id="ns-remote-view" style="display:none"></div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn-secondary" id="ns-cancel-btn">取消</button>
          <button class="modal-btn-primary" id="ns-create-btn">创建</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let currentTab = 'local';
    let selectedHostId = '';
    const titleEl = overlay.querySelector('#ns-title');
    const agentGrid = overlay.querySelector('#ns-agent-grid');
    const tabLocal = overlay.querySelector('#ns-tab-local');
    const tabRemote = overlay.querySelector('#ns-tab-remote');
    const localView = overlay.querySelector('#ns-local-view');
    const remoteView = overlay.querySelector('#ns-remote-view');
    const taskLabel = overlay.querySelector('#ns-task-label');

    function getSelectedAgentLabel() {
      return projectOnly ? '项目' : getNewSessionAgentLabel(selectedAgent);
    }

    function getSelectedAgentMode() {
      return localStorage.getItem(getAgentModeStorageKey(selectedAgent)) || 'yolo';
    }

    function getCodebuddyProfileOptions() {
      const profiles = Array.isArray(codebuddyConfigCache?.profiles) ? codebuddyConfigCache.profiles : [];
      return profiles.filter((profile) => profile && profile.name);
    }

    function syncSelectedCodebuddyProfile() {
      if (selectedAgent !== 'codebuddy') {
        selectedCodebuddyProfile = '';
        return;
      }
      const profiles = getCodebuddyProfileOptions();
      const localMode = (codebuddyConfigCache?.mode || 'local') === 'local';
      if (localMode) {
        selectedCodebuddyProfile = '';
        return;
      }
      const activeProfile = String(codebuddyConfigCache?.activeProfile || '').trim();
      const fallback = profiles[0]?.name || '';
      if (!selectedCodebuddyProfile || !profiles.some((profile) => profile.name === selectedCodebuddyProfile)) {
        selectedCodebuddyProfile = activeProfile || fallback;
      }
    }

    function renderAgentOptions() {
      if (!agentGrid) return;
      agentGrid.innerHTML = orderedAgents.map((agent) => {
        const displayLabel = getNewSessionAgentLabel(agent.id);
        return `
        <button
          type="button"
          class="ns-agent-card${agent.id === selectedAgent ? ' active' : ''}"
          data-ns-agent="${escapeHtml(agent.id)}"
          aria-pressed="${agent.id === selectedAgent ? 'true' : 'false'}"
        >
          <span class="ns-agent-card-kicker">Agent</span>
          <span class="ns-agent-card-label">${escapeHtml(displayLabel)}</span>
          <span class="ns-agent-card-desc">用于创建新的 ${escapeHtml(displayLabel)} 会话</span>
        </button>
      `;
      }).join('');
      agentGrid.querySelectorAll('[data-ns-agent]').forEach((button) => {
        button.addEventListener('click', () => {
          const nextAgent = normalizeAgent(button.dataset.nsAgent);
          if (nextAgent === selectedAgent) return;
          selectedAgent = nextAgent;
          syncSelectedCodebuddyProfile();
          selectedQuickCwd = '';
          selectedSuggestedCwd = '';
          cwdSuggestionItems = [];
          cwdSuggestionsLoading = true;
          renderAgentOptions();
          switchTab(currentTab);
          renderLocalView();
          renderRemoteView();
          send({ type: 'list_cwd_suggestions', agent: selectedAgent });
        });
      });
    }

    function switchTab(tab) {
      currentTab = tab;
      tabLocal.classList.toggle('active', tab === 'local');
      tabRemote.classList.toggle('active', tab === 'remote');
      tabLocal.style.opacity = tab === 'local' ? '1' : '0.6';
      tabRemote.style.opacity = tab === 'remote' ? '1' : '0.6';
      localView.style.display = tab === 'local' ? '' : 'none';
      remoteView.style.display = tab === 'remote' ? '' : 'none';
      if (titleEl) titleEl.textContent = projectOnly ? '新建项目' : `新建 ${getSelectedAgentLabel()} 会话`;
      taskLabel.textContent = getSelectedAgentLabel() + (tab === 'local' ? ' · 本地任务' : ' · 远程任务');
    }
    tabLocal.addEventListener('click', () => switchTab('local'));
    tabRemote.addEventListener('click', () => switchTab('remote'));
    if (!projectOnly) renderAgentOptions();
    switchTab('local');
    syncSelectedCodebuddyProfile();

    // --- Local task view ---
    let selectedLocalMode = 'manual';
    let selectedQuickCwd = '';
    let selectedSuggestedCwd = '';
    let manualCwd = currentCwd || '';
    let cwdSuggestionItems = [];
    let cwdSuggestionsLoading = true;
    const prevOnCwdSuggestions = _onCwdSuggestions;

    function getQuickDirs() {
      const pinned = getPinnedCwds(selectedAgent);
      const recent = getRecentCwds().filter(p => !pinned.includes(p));
      return [...pinned, ...recent].slice(0, 5);
    }

    function syncLocalSelection(quickDirs, historyItems) {
      if (selectedLocalMode === 'quick') {
        if (!quickDirs.includes(selectedQuickCwd)) {
          selectedQuickCwd = quickDirs[0] || '';
          if (!selectedQuickCwd) selectedLocalMode = historyItems.length ? 'history' : 'manual';
        }
      } else if (selectedLocalMode === 'history') {
        if (!historyItems.some((item) => item.path === selectedSuggestedCwd)) {
          selectedSuggestedCwd = historyItems[0]?.path || '';
          if (!selectedSuggestedCwd) selectedLocalMode = quickDirs.length ? 'quick' : 'manual';
        }
      }

      if (selectedLocalMode === 'manual') {
        if (!manualCwd && quickDirs.length > 0) {
          selectedLocalMode = 'quick';
          selectedQuickCwd = quickDirs[0];
        } else if (!manualCwd && historyItems.length > 0) {
          selectedLocalMode = 'history';
          selectedSuggestedCwd = historyItems[0].path;
        }
      }
    }

    function renderLocalView() {
      const currentPinned = getPinnedCwds(selectedAgent);
      const quickDirs = getQuickDirs();
      const historyItems = cwdSuggestionItems.filter((item) => !quickDirs.includes(item.path));
      syncLocalSelection(quickDirs, historyItems);
      const codebuddyProfiles = getCodebuddyProfileOptions();
      const showCodebuddyProfilePicker = selectedAgent === 'codebuddy' && codebuddyProfiles.length > 0 && (codebuddyConfigCache?.mode || 'local') === 'custom';

      localView.innerHTML = `
        <div class="ns-local-layout">
          ${showCodebuddyProfilePicker ? `
            <div>
              <div class="modal-field-label" style="margin-bottom:6px">CodeBuddy 账号</div>
              <select class="settings-select" id="ns-codebuddy-profile-select">
                ${codebuddyProfiles.map((profile) => `<option value="${escapeHtml(profile.name)}" ${profile.name === selectedCodebuddyProfile ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`).join('')}
              </select>
            </div>
          ` : ''}
          ${quickDirs.length > 0 ? `
            <div>
              <div class="modal-field-label" style="margin-bottom:6px">常用目录</div>
              <div class="ns-cwd-list">
                ${quickDirs.map((dir) => {
                  const isPinned = currentPinned.includes(dir);
                  const isSelected = selectedLocalMode === 'quick' && selectedQuickCwd === dir;
                  return `
                    <div class="ns-cwd-row ns-cwd-row--quick" data-select-mode="quick" data-cwd="${escapeHtml(dir)}" style="border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border-color)'};background:${isSelected ? 'var(--accent-dim,rgba(100,150,255,0.08))' : 'transparent'}">
                      <input type="radio" class="ns-cwd-radio" name="ns-local-cwd" ${isSelected ? 'checked' : ''}>
                      <div class="ns-cwd-content">
                        <div class="ns-cwd-path">${escapeHtml(dir)}</div>
                        <div class="ns-cwd-meta">${isPinned ? '已固定目录' : '最近使用'}</div>
                      </div>
                      <div class="ns-cwd-actions">
                        <button class="btn-test ns-pin-btn ns-cwd-action-btn" data-cwd="${escapeHtml(dir)}" style="${isPinned ? 'color:var(--accent)' : ''}" title="${isPinned ? '取消固定' : '固定'}">${isPinned ? '★' : '☆'}</button>
                        <button class="btn-test ns-del-dir-btn ns-cwd-action-btn" data-cwd="${escapeHtml(dir)}" title="移除">✕</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          ` : ''}
          <div>
            <div class="modal-field-label" style="margin-bottom:6px">已有对话目录</div>
            ${cwdSuggestionsLoading ? `
              <div class="modal-loading" style="padding:18px 0">正在整理已有会话目录…</div>
            ` : historyItems.length > 0 ? `
              <div class="ns-cwd-list ns-cwd-list--scroll">
                ${historyItems.map((item) => {
                  const isSelected = selectedLocalMode === 'history' && selectedSuggestedCwd === item.path;
                  return `
                    <div class="ns-cwd-row ns-cwd-row--history" data-select-mode="history" data-cwd="${escapeHtml(item.path)}" style="border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border-color)'};background:${isSelected ? 'var(--accent-dim,rgba(100,150,255,0.08))' : 'transparent'}">
                      <input type="radio" class="ns-cwd-radio" name="ns-local-cwd" ${isSelected ? 'checked' : ''}>
                      <div class="ns-cwd-content">
                        <div class="ns-cwd-path">${escapeHtml(item.path)}</div>
                        <div class="ns-cwd-meta">${escapeHtml(buildCwdSuggestionMeta(item))}</div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `
              <div class="settings-inline-note">还没有可复用的已有会话目录。</div>
            `}
          </div>
          <div>
            <div class="modal-field-label" style="margin-bottom:6px">手动输入或浏览</div>
            <div class="ns-cwd-row ns-cwd-row--manual" data-select-mode="manual" style="border:1px solid ${selectedLocalMode === 'manual' ? 'var(--accent)' : 'var(--border-color)'};background:${selectedLocalMode === 'manual' ? 'var(--accent-dim,rgba(100,150,255,0.08))' : 'transparent'}">
              <input type="radio" class="ns-cwd-radio" name="ns-local-cwd" ${selectedLocalMode === 'manual' ? 'checked' : ''}>
              <div class="ns-manual-fields">
                <input type="text" id="ns-cwd-custom" class="modal-text-input" placeholder="输入工作目录" value="${escapeHtml(manualCwd)}">
                <button class="btn-test ns-browse-dir-btn" id="ns-browse-dir-btn">浏览文件夹</button>
              </div>
            </div>
            <div class="settings-inline-note" style="margin-top:8px">
              文件夹选择器浏览的是运行 CC-Web 这台电脑上的目录，适合手机远程控制时使用。
            </div>
          </div>
        </div>
      `;

      localView.querySelectorAll('[data-select-mode]').forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.ns-pin-btn') || e.target.closest('.ns-del-dir-btn')) return;
          const mode = row.dataset.selectMode;
          if (mode === 'quick') {
            selectedLocalMode = 'quick';
            selectedQuickCwd = row.dataset.cwd || '';
          } else if (mode === 'history') {
            selectedLocalMode = 'history';
            selectedSuggestedCwd = row.dataset.cwd || '';
          } else {
            selectedLocalMode = 'manual';
          }
          renderLocalView();
        });
      });

      const customInput = localView.querySelector('#ns-cwd-custom');
      if (customInput) {
        customInput.addEventListener('focus', () => {
          if (selectedLocalMode === 'manual') return;
          selectedLocalMode = 'manual';
          renderLocalView();
          const freshInput = localView.querySelector('#ns-cwd-custom');
          if (freshInput) {
            const val = freshInput.value;
            freshInput.focus();
            if (typeof freshInput.setSelectionRange === 'function') freshInput.setSelectionRange(val.length, val.length);
          }
        });
        customInput.addEventListener('input', () => {
          manualCwd = customInput.value;
          selectedLocalMode = 'manual';
        });
      }

      localView.querySelectorAll('.ns-pin-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const cwd = btn.dataset.cwd;
          if (!cwd) return;
          const currentPinned2 = getPinnedCwds(selectedAgent);
          if (currentPinned2.includes(cwd)) {
            removePinnedCwd(selectedAgent, cwd);
          } else {
            savePinnedCwd(selectedAgent, cwd);
          }
          selectedLocalMode = 'quick';
          selectedQuickCwd = cwd;
          renderLocalView();
        });
      });

      localView.querySelectorAll('.ns-del-dir-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const cwd = btn.dataset.cwd;
          if (!cwd) return;
          removePinnedCwd(selectedAgent, cwd);
          const recents = getRecentCwds().filter(p => p !== cwd);
          try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(recents)); } catch {}
          if (selectedQuickCwd === cwd) selectedQuickCwd = '';
          renderLocalView();
        });
      });

      const browseBtn = localView.querySelector('#ns-browse-dir-btn');
      if (browseBtn) {
        browseBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const picked = await showDirectoryPickerModal(manualCwd || selectedQuickCwd || selectedSuggestedCwd || currentCwd || '');
          if (!picked) return;
          manualCwd = picked;
          selectedLocalMode = 'manual';
          renderLocalView();
          const freshInput = localView.querySelector('#ns-cwd-custom');
          if (freshInput) freshInput.focus();
        });
      }

      const codebuddyProfileSelect = localView.querySelector('#ns-codebuddy-profile-select');
      if (codebuddyProfileSelect) {
        codebuddyProfileSelect.addEventListener('change', () => {
          selectedCodebuddyProfile = codebuddyProfileSelect.value || '';
        });
      }
    }

    _onCwdSuggestions = (payload) => {
      if (normalizeAgent(payload.agent) !== selectedAgent) return;
      cwdSuggestionsLoading = false;
      cwdSuggestionItems = Array.isArray(payload.items)
        ? payload.items
        : (payload.paths || []).map((dir) => ({ path: dir, importedCount: 0, unimportedCount: 0, sourceKinds: [] }));
      renderLocalView();
    };

    send({ type: 'list_cwd_suggestions', agent: selectedAgent });
    renderLocalView();

    // --- Remote task view ---
    // Fetch dev config for SSH hosts
    let sshHosts = [];
    const prevOnDevConfig = _onDevConfig;
    send({ type: 'get_dev_config' });
    _onDevConfig = (config) => {
      sshHosts = config.ssh?.hosts || [];
      renderRemoteView();
    };

    function renderRemoteView() {
      if (sshHosts.length === 0) {
        remoteView.innerHTML = '<div class="settings-inline-note" style="text-align:center">请先在 设置 > 开发者设置 中添加 SSH 主机</div>';
        return;
      }
      remoteView.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${sshHosts.map((host) => `
            <div style="display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:6px;cursor:pointer;${selectedHostId === host.id ? 'border-color:var(--accent);background:var(--accent-dim,rgba(100,150,255,0.08))' : ''}" data-host-select="${host.id}">
              <input type="radio" name="ns-ssh-host" value="${escapeHtml(host.id)}" ${selectedHostId === host.id ? 'checked' : ''} style="margin:0">
              <div style="flex:1">
                <div style="font-weight:600">${escapeHtml(host.name || '未命名')}</div>
                <div style="font-size:0.85em;color:var(--text-secondary)">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
              </div>
            </div>
          `).join('')}
          ${selectedHostId ? `
            <div style="margin-top:8px">
              <label class="modal-field-label" style="margin-bottom:4px">远端工作目录（可选）</label>
              <input type="text" id="ns-remote-cwd" class="modal-text-input" placeholder="留空使用 SSH 默认目录">
            </div>
          ` : ''}
        </div>
      `;

      remoteView.querySelectorAll('[data-host-select]').forEach(el => {
        el.addEventListener('click', () => {
          selectedHostId = el.dataset.hostSelect;
          renderRemoteView();
        });
      });
    }
    renderRemoteView();

    function close() {
      overlay.remove();
      _onCwdSuggestions = prevOnCwdSuggestions;
      _onDevConfig = prevOnDevConfig;
    }

    overlay.querySelector('#ns-close-btn').addEventListener('click', close);
    overlay.querySelector('#ns-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#ns-create-btn').addEventListener('click', () => {
      if (currentTab === 'local') {
        let cwd = null;
        if (selectedLocalMode === 'manual') {
          cwd = localView.querySelector('#ns-cwd-custom')?.value?.trim() || null;
        } else if (selectedLocalMode === 'history') {
          cwd = selectedSuggestedCwd || null;
        } else {
          cwd = selectedQuickCwd || null;
        }
        if (!cwd) {
          alert('请选择或输入工作目录');
          return;
        }
        if (projectOnly) {
          const name = overlay.querySelector('#ns-project-name')?.value?.trim() || getPathLeaf(cwd);
          if (!name) {
            alert('请输入项目名称');
            return;
          }
          close();
          saveRecentCwd(cwd);
          send({ type: 'new_project', name, cwd, taskMode: 'local' });
          return;
        }
        close();
        saveRecentCwd(cwd);
        send({ type: 'new_session', cwd, agent: selectedAgent, mode: getSelectedAgentMode(), taskMode: 'local', codebuddyProfile: selectedAgent === 'codebuddy' ? selectedCodebuddyProfile : '' });
      } else {
        // Remote task
        if (!selectedHostId) {
          alert('请选择一个 SSH 主机');
          return;
        }
        const remoteCwd = remoteView.querySelector('#ns-remote-cwd')?.value?.trim() || '';
        if (projectOnly) {
          const host = sshHosts.find((item) => item.id === selectedHostId);
          const name = overlay.querySelector('#ns-project-name')?.value?.trim() || getPathLeaf(remoteCwd) || host?.name || '远程项目';
          close();
          send({ type: 'new_project', name, taskMode: 'remote', sshHostId: selectedHostId, remoteCwd });
          return;
        }
        close();
        send({ type: 'new_session', agent: selectedAgent, mode: getSelectedAgentMode(), taskMode: 'remote', sshHostId: selectedHostId, remoteCwd, codebuddyProfile: selectedAgent === 'codebuddy' ? selectedCodebuddyProfile : '' });
      }
    });
  }

  // --- Import Session Modal ---
  function buildImportPayload(agent, spec, item, extra = {}) {
    const payload = { agent };
    (spec?.payloadFields || []).forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(extra, field)) {
        payload[field] = extra[field];
      } else {
        payload[field] = item?.[field];
      }
    });
    return payload;
  }

  function createImportActionButton(agent, spec, item, close, extra = {}) {
    const btn = document.createElement('button');
    btn.className = 'import-item-btn';
    btn.textContent = item?.alreadyImported ? '重新导入' : '导入';
    btn.addEventListener('click', () => {
      const confirmed = item?.alreadyImported
        ? confirm(spec?.reimportConfirm || '确认重新导入当前会话？')
        : confirm(spec?.importConfirm || '确认导入当前会话？');
      if (!confirmed) return;
      close();
      send({
        type: spec.actionType,
        ...buildImportPayload(agent, spec, item, extra),
      });
    });
    return btn;
  }

  function renderGroupedImportSessions(body, agent, spec, groups, close) {
    if (!Array.isArray(groups) || groups.length === 0) {
      body.innerHTML = `${buildAgentContextCard(agent, spec.contextTitle, spec.contextCopy)}<div class="modal-empty">${escapeHtml(spec.emptyText || '未找到可导入会话')}</div>`;
      return;
    }
    body.innerHTML = buildAgentContextCard(agent, spec.contextTitle, spec.contextCopy);
    groups.forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'import-group';
      let readablePath = String(group?.dir || '').replace(/-/g, '/');
      if (!readablePath.startsWith('/')) readablePath = '/' + readablePath;
      readablePath = readablePath.replace(/\/+/g, '/');

      const groupTitle = document.createElement('div');
      groupTitle.className = 'import-group-title';
      groupTitle.textContent = readablePath;
      groupEl.appendChild(groupTitle);

      (group?.sessions || []).forEach((sess) => {
        const item = document.createElement('div');
        item.className = 'import-item';

        const info = document.createElement('div');
        info.className = 'import-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'import-item-title';
        titleEl.textContent = sess.title;

        const meta = document.createElement('div');
        meta.className = 'import-item-meta';
        meta.textContent = [sess.cwd || '', sess.updatedAt ? timeAgo(sess.updatedAt) : ''].filter(Boolean).join(' · ');

        info.appendChild(titleEl);
        info.appendChild(meta);
        item.appendChild(info);
        item.appendChild(createImportActionButton(agent, spec, sess, close, { projectDir: group.dir }));
        groupEl.appendChild(item);
      });

      body.appendChild(groupEl);
    });
  }

  function renderFlatImportSessions(body, agent, spec, items, close) {
    if (!Array.isArray(items) || items.length === 0) {
      body.innerHTML = `${buildAgentContextCard(agent, spec.contextTitle, spec.contextCopy)}<div class="modal-empty">${escapeHtml(spec.emptyText || '未找到可导入会话')}</div>`;
      return;
    }

    body.innerHTML = buildAgentContextCard(agent, spec.contextTitle, spec.contextCopy);
    items.forEach((sess) => {
      const item = document.createElement('div');
      item.className = 'import-item';

      const info = document.createElement('div');
      info.className = 'import-item-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'import-item-title';
      titleEl.textContent = sess.title || sess.threadId || sess.sessionId || 'Untitled';

      const meta = document.createElement('div');
      meta.className = 'import-item-meta';
      meta.textContent = [
        sess.cwd || '',
        sess.source ? `source:${sess.source}` : '',
        sess.updatedAt ? timeAgo(sess.updatedAt) : '',
      ].filter(Boolean).join(' · ');

      const tags = document.createElement('div');
      tags.className = 'import-item-tags';
      if (sess.cliVersion) {
        const ver = document.createElement('span');
        ver.className = 'import-item-tag';
        ver.textContent = `CLI ${sess.cliVersion}`;
        tags.appendChild(ver);
      }
      if (sess.source) {
        const source = document.createElement('span');
        source.className = 'import-item-tag';
        source.textContent = sess.source;
        tags.appendChild(source);
      }

      info.appendChild(titleEl);
      info.appendChild(meta);
      if (tags.children.length > 0) info.appendChild(tags);

      item.appendChild(info);
      item.appendChild(createImportActionButton(agent, spec, sess, close));
      body.appendChild(item);
    });
  }

  function showImportSessionModalForAgent(agent) {
    const normalizedAgent = normalizeAgent(agent);
    const spec = getAgentImportSpec(normalizedAgent);
    if (!spec) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = `import-${normalizedAgent}-session-overlay`;

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(spec.modalTitle || '导入本地会话')}</span>
          <button class="modal-close-btn" id="import-session-close-btn">✕</button>
        </div>
        <div class="modal-body" id="import-session-body">
          ${buildAgentContextCard(normalizedAgent, spec.contextTitle, spec.contextCopy)}
          <div class="modal-loading">${escapeHtml(spec.loadingText || '正在加载…')}</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      _onAgentImportSessions = null;
    }

    overlay.querySelector('#import-session-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    _onAgentImportSessions = (payload) => {
      if (normalizeAgent(payload?.agent) !== normalizedAgent) return;
      const body = overlay.querySelector('#import-session-body');
      if (!body) return;
      const data = payload?.data;
      if (spec.listStyle === 'grouped') {
        renderGroupedImportSessions(body, normalizedAgent, spec, data, close);
      } else {
        renderFlatImportSessions(body, normalizedAgent, spec, data, close);
      }
    };

    send({ type: spec.requestType, agent: normalizedAgent });
  }

  // --- Helpers ---
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return new Date(dateStr).toLocaleDateString('zh-CN');
  }

  // --- Init ---
  applyTheme(currentTheme);
  applyFont(currentFont);
  setCurrentAgent(currentAgent);
  renderSessionList();
  connect();

  // Register Service Worker for mobile push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Restore remembered password
  const savedPw = localStorage.getItem('cc-web-pw');
  if (savedPw) {
    loginPassword.value = savedPw;
    rememberPw.checked = true;
  }

  // Visibility change: re-sync state when user returns to tab (critical for mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) {
      // WS is dead, force reconnect
      connect();
    } else if (ws.readyState === 1) {
      send({ type: 'list_sessions' });
      // Only re-sync the current session while a task is still running.
      // Reloading an idle session rebuilds the message list and forces scroll to bottom.
      if (currentSessionId && (isGenerating || currentSessionRunning)) {
        send({ type: 'load_session', sessionId: currentSessionId });
      }
    }
  });

  if (!authToken) {
    loginOverlay.hidden = false;
    app.hidden = true;
  } else {
    loginOverlay.hidden = true;
    app.hidden = false;
  }
})();

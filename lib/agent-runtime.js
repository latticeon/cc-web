const { DEFAULT_AGENT, getAgentConfig, normalizeAgent } = require('./agent-registry');
const fs = require('fs');
const { countLineChanges } = require('./line-change-stats');

function createAgentRuntime(deps) {
  const {
    processEnv,
    CLAUDE_PATH,
    CODEX_PATH,
    CODEBUDDY_PATH,
    KIMI_PATH,
    OPENCODE_PATH,
    MODEL_MAP,
    loadModelConfig,
    applyCustomTemplateToSettings,
    loadCodexConfig,
    prepareCodexCustomRuntime,
    loadCodebuddyConfig,
    loadKimiConfig,
    prepareKimiCustomRuntime,
    wsSend,
    truncateObj,
    sanitizeToolInput,
    loadSession,
    saveSession,
    setRuntimeSessionId,
    getRuntimeSessionId,
    getGitWorkingTreeStats,
  } = deps;

  function quoteWindowsCmdArg(value) {
    const text = String(value ?? '');
    if (!text) return '""';
    if (!/[\s"&()^<>|]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function resolveWindowsCliCommand(cliPath, cliArgs) {
    if (process.platform !== 'win32') {
      return { command: cliPath, args: cliArgs };
    }
    if (/\.ps1$/i.test(cliPath)) {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cliPath, ...cliArgs],
      };
    }
    if (/\.(cmd|bat)$/i.test(cliPath)) {
      const commandLine = [quoteWindowsCmdArg(cliPath), ...cliArgs.map(quoteWindowsCmdArg)].join(' ');
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', commandLine],
      };
    }
    return { command: cliPath, args: cliArgs };
  }

  function buildClaudeSpawnSpec(session, options = {}) {
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (hasAttachments) args.push('--input-format', 'stream-json');
    const permMode = session.permissionMode || 'yolo';
    switch (permMode) {
      case 'yolo':
        args.push('--dangerously-skip-permissions');
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
      case 'default':
        args.push('--permission-mode', 'default');
        break;
    }
    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }
    if (session.model) {
      args.push('--model', session.model);
    }

    const env = { ...processEnv };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CC_WEB_PASSWORD;
    for (const k of Object.keys(env)) {
      if (k.startsWith('ANTHROPIC_')) delete env[k];
    }

    const modelCfg = loadModelConfig();
    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate);
      if (tpl) applyCustomTemplateToSettings(tpl);
    }

    const commandSpec = resolveWindowsCliCommand(CLAUDE_PATH, args);
    return {
      command: commandSpec.command,
      args: commandSpec.args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'claude',
      mode: permMode,
      resume: !!session.claudeSessionId,
    };
  }

  function resolveActiveCodebuddyProfile(config, session) {
    if (!config || config.mode !== 'custom') return null;
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const profileName = String(session?.codebuddyProfile || config.activeProfile || '').trim();
    if (!profileName) return null;
    return profiles.find((profile) => profile.name === profileName) || null;
  }

  function buildCodexSpawnSpec(session, options = {}) {
    const codexConfig = loadCodexConfig();
    const runtimeConfig = prepareCodexCustomRuntime(codexConfig);
    if (runtimeConfig?.error) {
      return { error: runtimeConfig.error };
	    }
	    const runtimeId = getRuntimeSessionId(session);
	    const args = ['exec'];
	    args.push('--json', '--skip-git-repo-check');

	    const permMode = session.permissionMode || 'yolo';
	    // `-s/--sandbox` is an option for `codex exec`, but not for `codex exec resume`.
	    // When resuming, it must appear before the `resume` subcommand, otherwise Codex CLI errors
	    // with: "unexpected argument '-s' found".
	    if (runtimeId && permMode === 'plan') {
	      args.push('-s', 'read-only');
	    }
	    switch (permMode) {
	      case 'yolo':
	        args.push('--dangerously-bypass-approvals-and-sandbox');
	        break;
	      case 'plan':
	        if (!runtimeId) args.push('-s', 'read-only');
	        break;
	      case 'default':
	      default:
	        args.push('--full-auto');
        break;
    }

    const effectiveModel = session.model;
    if (effectiveModel) {
      const raw = String(effectiveModel).trim();
      // cc-web UI supports "gpt-5.4(high)" style selection, but Codex CLI expects:
      // - model: "gpt-5.4"
      // - reasoning effort: config key `model_reasoning_effort = "high"`
      const m = raw.match(/^(.*)\((low|medium|high|xhigh)\)\s*$/i);
      if (m) {
        const base = String(m[1] || '').trim();
        const lvl = String(m[2] || '').trim().toLowerCase();
        if (base) args.push('--model', base);
        // Keep the override quote-free so Windows cmd.exe forwards it unchanged.
        args.push('-c', `model_reasoning_effort=${lvl}`);
      } else {
        args.push('--model', raw);
      }
    }
    if (runtimeId) args.push('resume');
    if (Array.isArray(options.attachments)) {
      for (const attachment of options.attachments) {
        if (attachment?.path) args.push('--image', attachment.path);
      }
    }
    if (runtimeId) {
      args.push(runtimeId, '-');
    } else {
      if (session.cwd) args.push('-C', session.cwd);
      args.push('-');
    }

    const env = { ...processEnv };
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    if (runtimeConfig?.mode === 'custom') {
      env.CODEX_HOME = runtimeConfig.homeDir;
      env.OPENAI_API_KEY = runtimeConfig.apiKey;
      delete env.OPENAI_BASE_URL;
    }

    const commandSpec = resolveWindowsCliCommand(CODEX_PATH, args);
    return {
      command: commandSpec.command,
      args: commandSpec.args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'codex',
      mode: permMode,
      resume: !!runtimeId,
    };
  }

  function buildKimiSpawnSpec(session, options = {}) {
    const kimiConfig = loadKimiConfig();
    const runtimeConfig = prepareKimiCustomRuntime(kimiConfig);
    if (runtimeConfig?.error) {
      return { error: runtimeConfig.error };
    }

    let runtimeId = getRuntimeSessionId(session);
    if (!runtimeId) {
      runtimeId = String(session?.id || '').trim() || `cc-web-kimi-${Date.now()}`;
      setRuntimeSessionId(session, runtimeId);
      saveSession(session);
    }

    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--session', runtimeId];
    if (runtimeConfig?.mode === 'custom' && runtimeConfig.configFilePath) {
      args.push('--config-file', runtimeConfig.configFilePath);
    }
    const permMode = session.permissionMode || 'yolo';
    if (permMode === 'plan') {
      args.push('--plan');
    } else if (permMode === 'yolo') {
      args.push('--yolo');
    }
    if (session.model) args.push('--model', String(session.model));
    if (session.cwd) args.push('--work-dir', session.cwd);

    const env = { ...processEnv };
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    // Kimi CLI runs on Python; force UTF-8 stdio on Windows to avoid mojibake
    // and surrogate-escape artifacts when cc-web pipes stream-json into stdin.
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';

    const commandSpec = resolveWindowsCliCommand(KIMI_PATH, args);
    return {
      command: commandSpec.command,
      args: commandSpec.args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'kimi',
      mode: permMode,
      resume: true,
      stdinMode: 'stream-json',
      streamJsonFormat: 'kimi-message',
    };
  }

  function buildCodebuddySpawnSpec(session, options = {}) {
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    const args = ['-p', '--output-format', 'stream-json'];
    if (hasAttachments) args.push('--input-format', 'stream-json');

    const permMode = session.permissionMode || 'yolo';
    switch (permMode) {
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
      case 'default':
        args.push('--permission-mode', 'default');
        break;
      case 'yolo':
      default:
        args.push('--permission-mode', 'bypassPermissions');
        break;
    }

    if (session.codebuddySessionId) {
      args.push('--resume', session.codebuddySessionId);
    }
    if (session.model) {
      args.push('--model', String(session.model));
    }

    const env = { ...processEnv };
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    const codebuddyConfig = loadCodebuddyConfig();
    const activeProfile = resolveActiveCodebuddyProfile(codebuddyConfig, session);
    if (activeProfile) {
      if (activeProfile.authToken) env.CODEBUDDY_AUTH_TOKEN = activeProfile.authToken;
      else delete env.CODEBUDDY_AUTH_TOKEN;
      if (activeProfile.apiKey) env.CODEBUDDY_API_KEY = activeProfile.apiKey;
      else delete env.CODEBUDDY_API_KEY;
    }

    const commandSpec = resolveWindowsCliCommand(CODEBUDDY_PATH, args);
    return {
      command: commandSpec.command,
      args: commandSpec.args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'codebuddy',
      mode: permMode,
      resume: !!session.codebuddySessionId,
      stdinMode: hasAttachments ? 'stream-json' : 'file',
      streamJsonFormat: 'claude-message',
    };
  }

  function buildOpencodeSpawnSpec(session, options = {}) {
    const runtimeId = getRuntimeSessionId(session);
    const cliArgs = ['run', '--format', 'json'];
    const permMode = session.permissionMode || 'yolo';

    cliArgs.push('--agent', permMode === 'plan' ? 'plan' : 'build');

    if (runtimeId) cliArgs.push('--session', runtimeId);
    if (session.model) cliArgs.push('--model', String(session.model));
    if (session.cwd) cliArgs.push('--dir', session.cwd);
    if (Array.isArray(options.attachments)) {
      for (const attachment of options.attachments) {
        if (attachment?.path) cliArgs.push('--file', attachment.path);
      }
    }

    const promptText = String(options.text || '').trim();
    if (promptText) cliArgs.push(promptText);

    const env = { ...processEnv };
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;

    const commandSpec = resolveWindowsCliCommand(OPENCODE_PATH, cliArgs);

    return {
      command: commandSpec.command,
      args: commandSpec.args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'opencode',
      mode: permMode,
      resume: !!runtimeId,
      stdinMode: 'ignore',
    };
  }

  function ensureAssistantSteps(entry) {
    if (!Array.isArray(entry.assistantSteps)) entry.assistantSteps = [];
    return entry.assistantSteps;
  }

  function appendAssistantTextStep(entry, text) {
    if (!text) return;
    entry.fullText += text;
    const steps = ensureAssistantSteps(entry);
    const last = steps[steps.length - 1];
    if (last && last.type === 'text') {
      last.content = `${last.content || ''}${text}`;
    } else {
      steps.push({ type: 'text', content: text });
    }
    wsSend(entry.ws, { type: 'text_delta', text });
  }

  function attachAssistantToolStep(entry, toolCall) {
    if (!toolCall) return;
    const steps = ensureAssistantSteps(entry);
    if (!steps.includes(toolCall)) steps.push(toolCall);
  }

  function codexToolName(item) {
    switch (item?.type) {
      case 'command_execution':
        return 'CommandExecution';
      case 'mcp_tool_call':
        return 'McpToolCall';
      case 'file_change':
        return 'FileChange';
      case 'reasoning':
        return 'Reasoning';
      default:
        return item?.type || 'CodexItem';
    }
  }

  function codexToolInput(item) {
    if (!item) return null;
    if (item.type === 'command_execution') return { command: item.command || '' };
    return truncateObj(item, 500);
  }

  function codexToolMeta(item) {
    if (!item) return null;
    switch (item.type) {
      case 'command_execution':
        return {
          kind: 'command_execution',
          title: 'Shell Command',
          subtitle: item.command || '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          status: item.status || null,
        };
      case 'mcp_tool_call':
        return {
          kind: 'mcp_tool_call',
          title: 'MCP Tool',
          subtitle: item.tool_name || item.name || item.server_name || '',
          status: item.status || null,
        };
      case 'file_change':
        return {
          kind: 'file_change',
          title: 'File Change',
          subtitle: '',
          changes: (Array.isArray(item.changes) ? item.changes : []).map((change) => ({
            path: String(change?.path || ''),
            kind: String(change?.kind || 'update'),
          })).filter((change) => change.path),
          status: item.status || null,
        };
      case 'reasoning':
        return {
          kind: 'reasoning',
          title: 'Reasoning',
          subtitle: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
          status: item.status || null,
        };
      default:
        return {
          kind: item.type || 'codex_item',
          title: codexToolName(item),
          subtitle: '',
          status: item.status || null,
        };
    }
  }

  function codexToolResult(item) {
    if (!item) return '';
    if (typeof item.aggregated_output === 'string' && item.aggregated_output) return item.aggregated_output;
    if (typeof item.message === 'string' && item.message) return item.message;
    if (typeof item.text === 'string' && item.text) return item.text;
    return JSON.stringify(truncateObj(item, 1200));
  }

  function isCodexDeprecatedFeatureWarning(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    return /\[features\]\.[a-z0-9_]+\s+is deprecated\./i.test(raw);
  }

  function shouldIgnoreCodexItem(item) {
    if (!item || item.type !== 'error') return false;
    return isCodexDeprecatedFeatureWarning(codexToolResult(item));
  }

  function ensureCodexToolCall(entry, item) {
    let tc = entry.toolCalls.find((t) => t.id === item.id);
    if (tc) {
      tc.type = 'tool_call';
      tc.name = codexToolName(item);
      tc.kind = item.type || tc.kind || null;
      tc.meta = codexToolMeta(item) || tc.meta || null;
      if (tc.input == null) tc.input = codexToolInput(item);
      attachAssistantToolStep(entry, tc);
      return tc;
    }
    tc = {
      type: 'tool_call',
      name: codexToolName(item),
      id: item.id,
      kind: item.type || null,
      meta: codexToolMeta(item),
      input: codexToolInput(item),
      done: false,
    };
    entry.toolCalls.push(tc);
    attachAssistantToolStep(entry, tc);
    wsSend(entry.ws, {
      type: 'tool_start',
      name: tc.name,
      toolUseId: item.id,
      input: tc.input,
      kind: tc.kind,
      meta: tc.meta,
    });
    return tc;
  }

  function readFileChangeSnapshot(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  function captureCodexFileChanges(entry, item) {
    if (item?.type !== 'file_change' || !item.id) return;
    if (!(entry.codexFileSnapshots instanceof Map)) entry.codexFileSnapshots = new Map();
    const snapshots = new Map();
    for (const change of Array.isArray(item.changes) ? item.changes : []) {
      const filePath = String(change?.path || '');
      if (filePath) snapshots.set(filePath, readFileChangeSnapshot(filePath));
    }
    entry.codexFileSnapshots.set(item.id, snapshots);
  }

  function completeCodexFileChanges(entry, item, toolCall) {
    if (item?.type !== 'file_change' || !toolCall?.meta) return;
    const snapshots = entry.codexFileSnapshots instanceof Map ? entry.codexFileSnapshots.get(item.id) : null;
    const currentGitStats = typeof getGitWorkingTreeStats === 'function'
      ? getGitWorkingTreeStats(entry.cwd)
      : new Map();
    toolCall.meta.changes = (toolCall.meta.changes || []).map((change) => {
      const statsKey = process.platform === 'win32' ? change.path.toLowerCase() : change.path;
      const currentStats = currentGitStats.get(statsKey);
      const baselineStats = entry.fileChangeBaseline instanceof Map ? entry.fileChangeBaseline.get(statsKey) : null;
      if (currentStats) {
        const additionsDelta = currentStats.additions - (baselineStats?.additions || 0);
        const deletionsDelta = currentStats.deletions - (baselineStats?.deletions || 0);
        return {
          ...change,
          additions: Math.max(0, additionsDelta) + Math.max(0, -deletionsDelta),
          deletions: Math.max(0, deletionsDelta) + Math.max(0, -additionsDelta),
        };
      }
      const before = snapshots instanceof Map ? snapshots.get(change.path) : null;
      const after = readFileChangeSnapshot(change.path);
      if (before === null || after === null) return change;
      const fallbackStats = countLineChanges(before, after);
      return fallbackStats.additions || fallbackStats.deletions ? { ...change, ...fallbackStats } : change;
    });
    entry.fileChangeBaseline = currentGitStats;
    if (entry.codexFileSnapshots instanceof Map) entry.codexFileSnapshots.delete(item.id);
  }

  function processClaudeEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system':
        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session) {
            session.claudeSessionId = event.session_id;
            saveSession(session);
          }
        }
        break;

      case 'assistant': {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            appendAssistantTextStep(entry, block.text);
          } else if (block.type === 'tool_use') {
            const toolInput = sanitizeToolInput(block.name, block.input);
            const tc = { type: 'tool_call', name: block.name, id: block.id, input: toolInput, done: false };
            entry.toolCalls.push(tc);
            attachAssistantToolStep(entry, tc);
            wsSend(entry.ws, { type: 'tool_start', name: block.name, toolUseId: block.id, input: tc.input });
          } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => c.text || '').join('\n')
                : JSON.stringify(block.content);
            let tc = entry.toolCalls.find((t) => t.id === block.tool_use_id);
            if (!tc) {
              tc = { type: 'tool_call', name: 'Tool', id: block.tool_use_id, input: null, done: false };
              entry.toolCalls.push(tc);
            }
            attachAssistantToolStep(entry, tc);
            tc.done = true;
            tc.result = resultText.slice(0, 2000);
            wsSend(entry.ws, { type: 'tool_end', toolUseId: block.tool_use_id, result: resultText.slice(0, 2000) });
          }
        }

        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session && !session.claudeSessionId) {
            session.claudeSessionId = event.session_id;
            saveSession(session);
          }
        }
        break;
      }

      case 'result': {
        const session = loadSession(sessionId);
        if (session) {
          if (event.session_id) session.claudeSessionId = event.session_id;
          if (event.total_cost_usd) session.totalCost = (session.totalCost || 0) + event.total_cost_usd;
          saveSession(session);
        }
        entry.lastCost = event.total_cost_usd || null;
        if (entry.ws && event.total_cost_usd !== undefined) {
          wsSend(entry.ws, { type: 'cost', costUsd: session?.totalCost || 0 });
        }
        break;
      }
    }
  }

  function processCodexEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'thread.started': {
        if (!event.thread_id) break;
        const session = loadSession(sessionId);
        if (session) {
          setRuntimeSessionId(session, event.thread_id);
          saveSession(session);
        }
        break;
      }

      case 'item.started': {
        const item = event.item;
        if (!item || !item.id || item.type === 'agent_message') break;
        if (shouldIgnoreCodexItem(item)) break;
        captureCodexFileChanges(entry, item);
        ensureCodexToolCall(entry, item);
        break;
      }

      case 'item.completed': {
        const item = event.item;
        if (!item || !item.id) break;
        if (shouldIgnoreCodexItem(item)) break;
        if (item.type === 'agent_message') {
          if (item.text) {
            appendAssistantTextStep(entry, item.text);
          }
          break;
        }
        const tc = ensureCodexToolCall(entry, item);
        completeCodexFileChanges(entry, item, tc);
        const resultText = codexToolResult(item).slice(0, 2000);
        tc.done = true;
        tc.result = resultText;
        wsSend(entry.ws, {
          type: 'tool_end',
          toolUseId: item.id,
          result: resultText,
          kind: tc.kind,
          meta: tc.meta,
        });
        break;
      }

      case 'turn.completed': {
        const usage = event.usage || null;
        entry.lastUsage = usage;
        const session = loadSession(sessionId);
        if (session && usage) {
          session.totalUsage = {
            inputTokens: (session.totalUsage?.inputTokens || 0) + (usage.input_tokens || 0),
            cachedInputTokens: (session.totalUsage?.cachedInputTokens || 0) + (usage.cached_input_tokens || 0),
            outputTokens: (session.totalUsage?.outputTokens || 0) + (usage.output_tokens || 0),
            contextTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          };
          saveSession(session);
          wsSend(entry.ws, { type: 'usage', totalUsage: session.totalUsage });
        }
        break;
      }

      case 'turn.failed': {
        const message = event.error?.message || 'Codex 任务失败';
        entry.lastError = message;
        break;
      }

      case 'error':
        if (event.message) {
          if (isCodexDeprecatedFeatureWarning(event.message)) break;
          if (/^Reconnecting\.\.\./.test(event.message)) {
            wsSend(entry.ws, { type: 'system_message', message: event.message });
          } else {
            entry.lastError = event.message;
          }
        }
        break;
    }
  }

  function ensureKimiToolCall(entry, toolCall) {
    const toolId = String(toolCall?.id || '').trim();
    const functionName = String(toolCall?.function?.name || toolCall?.name || 'Tool').trim() || 'Tool';
    const rawArgs = toolCall?.function?.arguments ?? toolCall?.arguments ?? null;
    let tc = entry.toolCalls.find((item) => item.id === toolId);
    if (tc) {
      tc.type = 'tool_call';
      tc.name = functionName;
      if (tc.input == null) tc.input = sanitizeToolInput(functionName, rawArgs);
      attachAssistantToolStep(entry, tc);
      return tc;
    }
    tc = {
      type: 'tool_call',
      name: functionName,
      id: toolId || `kimi-tool-${Math.random().toString(36).slice(2)}`,
      kind: 'tool_call',
      input: sanitizeToolInput(functionName, rawArgs),
      done: false,
    };
    entry.toolCalls.push(tc);
    attachAssistantToolStep(entry, tc);
    wsSend(entry.ws, {
      type: 'tool_start',
      name: tc.name,
      toolUseId: tc.id,
      input: tc.input,
      kind: tc.kind,
    });
    return tc;
  }

  function appendKimiContent(entry, content) {
    if (!content) return;
    if (typeof content === 'string') {
      appendAssistantTextStep(entry, content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const partType = String(part.type || '').trim().toLowerCase();
      if (partType === 'text' && part.text) {
        appendAssistantTextStep(entry, part.text);
      } else if ((partType === 'think' || partType === 'reasoning') && part.text) {
        const tc = {
          type: 'tool_call',
          name: 'Reasoning',
          id: `kimi-reasoning-${Math.random().toString(36).slice(2)}`,
          kind: 'reasoning',
          meta: {
            kind: 'reasoning',
            title: 'Reasoning',
            subtitle: String(part.text).slice(0, 120),
            status: 'completed',
          },
          input: null,
          done: true,
          result: String(part.text).slice(0, 2000),
        };
        entry.toolCalls.push(tc);
        attachAssistantToolStep(entry, tc);
        wsSend(entry.ws, {
          type: 'tool_start',
          name: tc.name,
          toolUseId: tc.id,
          input: null,
          kind: tc.kind,
          meta: tc.meta,
        });
        wsSend(entry.ws, {
          type: 'tool_end',
          toolUseId: tc.id,
          result: tc.result,
          kind: tc.kind,
          meta: tc.meta,
        });
      }
    }
  }

  function kimiToolMessageText(event) {
    const content = event?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (part && typeof part === 'object' && typeof part.text === 'string') ? part.text : '')
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  function processKimiEvent(entry, event, sessionId) {
    if (!event || typeof event !== 'object') return;
    const role = String(event.role || '').trim().toLowerCase();

    if (role === 'assistant') {
      appendKimiContent(entry, event.content);
      if (Array.isArray(event.tool_calls)) {
        for (const toolCall of event.tool_calls) {
          ensureKimiToolCall(entry, toolCall);
        }
      }
      return;
    }

    if (role === 'tool') {
      const toolId = String(event.tool_call_id || '').trim();
      if (!toolId) return;
      let tc = entry.toolCalls.find((item) => item.id === toolId);
      if (!tc) {
        tc = {
          type: 'tool_call',
          name: String(event.name || 'Tool').trim() || 'Tool',
          id: toolId,
          kind: 'tool_call',
          input: null,
          done: false,
        };
        entry.toolCalls.push(tc);
      }
      attachAssistantToolStep(entry, tc);
      tc.done = true;
      tc.result = kimiToolMessageText(event).slice(0, 2000);
      wsSend(entry.ws, {
        type: 'tool_end',
        toolUseId: tc.id,
        result: tc.result,
        kind: tc.kind,
      });
    }
  }

  function appendCodebuddyContent(entry, content) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text) {
        appendAssistantTextStep(entry, block.text);
        continue;
      }
      if (block.type === 'thinking' && block.thinking) {
        const tc = {
          type: 'tool_call',
          name: 'Reasoning',
          id: `codebuddy-thinking-${Math.random().toString(36).slice(2)}`,
          kind: 'reasoning',
          meta: {
            kind: 'reasoning',
            title: 'Reasoning',
            subtitle: String(block.thinking).slice(0, 120),
            status: 'completed',
          },
          input: null,
          done: true,
          result: String(block.thinking).slice(0, 2000),
        };
        entry.toolCalls.push(tc);
        attachAssistantToolStep(entry, tc);
        wsSend(entry.ws, {
          type: 'tool_start',
          name: tc.name,
          toolUseId: tc.id,
          input: null,
          kind: tc.kind,
          meta: tc.meta,
        });
        wsSend(entry.ws, {
          type: 'tool_end',
          toolUseId: tc.id,
          result: tc.result,
          kind: tc.kind,
          meta: tc.meta,
        });
        continue;
      }
      if (block.type === 'tool_use') {
        const toolInput = sanitizeToolInput(block.name, block.input);
        const tc = { type: 'tool_call', name: block.name, id: block.id, input: toolInput, done: false };
        entry.toolCalls.push(tc);
        attachAssistantToolStep(entry, tc);
        wsSend(entry.ws, { type: 'tool_start', name: block.name, toolUseId: block.id, input: tc.input });
        continue;
      }
      if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((item) => item.text || '').join('\n')
            : JSON.stringify(block.content);
        let tc = entry.toolCalls.find((item) => item.id === block.tool_use_id);
        if (!tc) {
          tc = { type: 'tool_call', name: 'Tool', id: block.tool_use_id, input: null, done: false };
          entry.toolCalls.push(tc);
        }
        attachAssistantToolStep(entry, tc);
        tc.done = true;
        tc.result = resultText.slice(0, 2000);
        wsSend(entry.ws, { type: 'tool_end', toolUseId: block.tool_use_id, result: resultText.slice(0, 2000) });
      }
    }
  }

  function maybeUpdateCodebuddyModel(entry, sessionId, modelName) {
    const nextModel = String(modelName || '').trim();
    if (!nextModel) return;
    const session = loadSession(sessionId);
    if (!session || session.model === nextModel) return;
    session.model = nextModel;
    saveSession(session);
    wsSend(entry.ws, { type: 'model_changed', model: nextModel });
  }

  function processCodebuddyEvent(entry, event, sessionId) {
    if (!event || typeof event !== 'object' || !event.type) return;

    switch (event.type) {
      case 'system':
        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session && !session.codebuddySessionId) {
            session.codebuddySessionId = event.session_id;
            saveSession(session);
          }
        }
        break;

      case 'assistant': {
        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session && !session.codebuddySessionId) {
            session.codebuddySessionId = event.session_id;
            saveSession(session);
          }
        }
        maybeUpdateCodebuddyModel(entry, sessionId, event.message?.model);
        appendCodebuddyContent(entry, event.message?.content);
        break;
      }

      case 'result': {
        const session = loadSession(sessionId);
        const usage = event.usage || null;
        if (session) {
          if (event.session_id) session.codebuddySessionId = event.session_id;
          if (usage) {
            session.totalUsage = {
              inputTokens: (session.totalUsage?.inputTokens || 0) + (usage.input_tokens || 0),
              cachedInputTokens: (session.totalUsage?.cachedInputTokens || 0) + (usage.cache_read_input_tokens || 0),
              outputTokens: (session.totalUsage?.outputTokens || 0) + (usage.output_tokens || 0),
              contextTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.output_tokens || 0),
            };
          }
          if (typeof event.total_cost_usd === 'number') {
            session.totalCost = (session.totalCost || 0) + event.total_cost_usd;
          }
          saveSession(session);
          if (usage) {
            wsSend(entry.ws, { type: 'usage', totalUsage: session.totalUsage });
          }
          if (event.total_cost_usd !== undefined) {
            wsSend(entry.ws, { type: 'cost', costUsd: session.totalCost || 0 });
          }
        }
        entry.lastCost = event.total_cost_usd || null;
        entry.lastUsage = usage;
        break;
      }

      case 'error':
        if (event.error) {
          entry.lastError = String(event.error);
        }
        break;
    }
  }

  function normalizeOpencodeName(value) {
    return String(value || '').trim().toLowerCase().replace(/_/g, '-');
  }

  function extractOpencodeSessionId(event) {
    return String(event?.sessionID || event?.sessionId || event?.session_id || '').trim();
  }

  function updateOpencodeSessionId(sessionId, runtimeId) {
    if (!runtimeId) return;
    const session = loadSession(sessionId);
    if (!session || getRuntimeSessionId(session) === runtimeId) return;
    setRuntimeSessionId(session, runtimeId);
    saveSession(session);
  }

  function getOpencodePart(event) {
    if (event?.part && typeof event.part === 'object') return event.part;
    if (event?.data?.part && typeof event.data.part === 'object') return event.data.part;
    if (event?.delta && typeof event.delta === 'object') return event.delta;
    const eventType = normalizeOpencodeName(event?.type);
    if (eventType.startsWith('text')) {
      return { type: 'text', text: event?.text || event?.content || event?.delta || '' };
    }
    if (eventType.startsWith('reasoning')) {
      return { type: 'reasoning', text: event?.text || event?.content || event?.delta || '' };
    }
    if (eventType.startsWith('tool')) {
      return { ...event, type: 'tool' };
    }
    if (eventType.startsWith('patch')) {
      return { ...event, type: 'patch' };
    }
    if (eventType.startsWith('file')) {
      return { ...event, type: 'file' };
    }
    if (eventType === 'step-start' || eventType === 'step-finish') {
      return event;
    }
    return null;
  }

  function opencodeToolName(part) {
    const partType = normalizeOpencodeName(part?.type);
    if (partType === 'tool') return String(part?.tool || 'Tool');
    if (partType === 'reasoning') return 'Reasoning';
    if (partType === 'patch') return 'Patch';
    if (partType === 'file') return 'File';
    return partType || 'OpenCodePart';
  }

  function opencodeToolInput(part) {
    const partType = normalizeOpencodeName(part?.type);
    if (partType === 'tool') return sanitizeToolInput(part?.tool || 'tool', part?.state?.input || null);
    if (partType === 'patch') return truncateObj({ hash: part?.hash || '', files: part?.files || [] }, 500);
    if (partType === 'file') return truncateObj({ filename: part?.filename || '', mime: part?.mime || '' }, 500);
    return truncateObj(part, 500);
  }

  function opencodeToolMeta(part) {
    const partType = normalizeOpencodeName(part?.type);
    if (partType === 'tool') {
      return {
        kind: 'tool',
        title: 'Tool',
        subtitle: String(part?.tool || ''),
        status: part?.state?.status || null,
      };
    }
    if (partType === 'reasoning') {
      return {
        kind: 'reasoning',
        title: 'Reasoning',
        subtitle: typeof part?.text === 'string' ? part.text.slice(0, 120) : '',
        status: null,
      };
    }
    if (partType === 'patch') {
      return {
        kind: 'patch',
        title: 'Patch',
        subtitle: Array.isArray(part?.files) ? part.files.slice(0, 2).join(', ') : '',
        status: null,
      };
    }
    if (partType === 'file') {
      return {
        kind: 'file',
        title: 'File',
        subtitle: String(part?.filename || ''),
        status: null,
      };
    }
    return {
      kind: partType || 'opencode_part',
      title: opencodeToolName(part),
      subtitle: '',
      status: part?.state?.status || null,
    };
  }

  function opencodeToolResult(part) {
    const partType = normalizeOpencodeName(part?.type);
    if (partType === 'tool') {
      if (typeof part?.state?.output === 'string' && part.state.output) return part.state.output;
      if (typeof part?.state?.error === 'string' && part.state.error) return part.state.error;
      return JSON.stringify(truncateObj(part?.state || {}, 1200));
    }
    if (partType === 'reasoning') return part?.text || '';
    if (partType === 'patch') {
      return Array.isArray(part?.files) ? part.files.join('\n') : JSON.stringify(truncateObj(part, 1200));
    }
    if (partType === 'file') return part?.filename || part?.url || '';
    return JSON.stringify(truncateObj(part, 1200));
  }

  function getOpencodeToolCallId(part) {
    return String(part?.callID || part?.callId || part?.id || '').trim() || `opencode-${Math.random().toString(36).slice(2)}`;
  }

  function ensureOpencodeToolCall(entry, part) {
    const toolId = getOpencodeToolCallId(part);
    let tc = entry.toolCalls.find((item) => item.id === toolId);
    if (tc) {
      tc.type = 'tool_call';
      tc.name = opencodeToolName(part);
      tc.kind = normalizeOpencodeName(part?.type) || tc.kind || null;
      tc.meta = opencodeToolMeta(part) || tc.meta || null;
      if (tc.input == null) tc.input = opencodeToolInput(part);
      attachAssistantToolStep(entry, tc);
      return tc;
    }
    tc = {
      type: 'tool_call',
      name: opencodeToolName(part),
      id: toolId,
      kind: normalizeOpencodeName(part?.type) || null,
      meta: opencodeToolMeta(part),
      input: opencodeToolInput(part),
      done: false,
    };
    entry.toolCalls.push(tc);
    attachAssistantToolStep(entry, tc);
    wsSend(entry.ws, {
      type: 'tool_start',
      name: tc.name,
      toolUseId: tc.id,
      input: tc.input,
      kind: tc.kind,
      meta: tc.meta,
    });
    return tc;
  }

  function shouldAppendOpencodeText(eventType) {
    return !eventType.endsWith('start') && !eventType.endsWith('end');
  }

  function opencodeUsageFromTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return null;
    return {
      input_tokens: Number(tokens.input_tokens || tokens.input || 0) || 0,
      cached_input_tokens: Number(tokens.cached_input_tokens || tokens.cache?.read || 0) || 0,
      output_tokens: Number(tokens.output_tokens || tokens.output || 0) || 0,
      reasoning_tokens: Number(tokens.reasoning_tokens || tokens.reasoning || 0) || 0,
    };
  }

  function processOpencodeEvent(entry, event, sessionId) {
    if (!event || typeof event !== 'object') return;

    const runtimeId = extractOpencodeSessionId(event);
    if (runtimeId) updateOpencodeSessionId(sessionId, runtimeId);

    const eventType = normalizeOpencodeName(event.type);
    if (eventType === 'error') {
      const message = event?.error?.data?.message || event?.error?.message || event?.message || '';
      if (message) entry.lastError = String(message);
      return;
    }

    const part = getOpencodePart(event);
    const partType = normalizeOpencodeName(part?.type);

    if (partType === 'text') {
      if (typeof part?.text === 'string' && shouldAppendOpencodeText(eventType || partType)) {
        appendAssistantTextStep(entry, part.text);
      }
      return;
    }

    if (partType === 'reasoning') {
      if (!part?.text) return;
      const tc = ensureOpencodeToolCall(entry, part);
      tc.done = true;
      tc.result = String(part.text).slice(0, 2000);
      wsSend(entry.ws, {
        type: 'tool_end',
        toolUseId: tc.id,
        result: tc.result,
        kind: tc.kind,
        meta: tc.meta,
      });
      return;
    }

    if (partType === 'tool' || partType === 'patch' || partType === 'file') {
      const tc = ensureOpencodeToolCall(entry, part);
      const status = normalizeOpencodeName(part?.state?.status);
      const isDone = ['completed', 'complete', 'failed', 'error'].includes(status)
        || eventType.endsWith('finish')
        || eventType.endsWith('result')
        || !!part?.state?.output
        || !!part?.state?.error
        || partType === 'patch'
        || partType === 'file';
      if (isDone) {
        tc.done = true;
        tc.result = opencodeToolResult(part).slice(0, 2000);
        wsSend(entry.ws, {
          type: 'tool_end',
          toolUseId: tc.id,
          result: tc.result,
          kind: tc.kind,
          meta: tc.meta,
        });
      }
      return;
    }

    if (partType === 'step-finish') {
      const usage = opencodeUsageFromTokens(part?.tokens || event?.tokens);
      const session = loadSession(sessionId);
      if (session && usage) {
        session.totalUsage = {
          inputTokens: (session.totalUsage?.inputTokens || 0) + usage.input_tokens,
          cachedInputTokens: (session.totalUsage?.cachedInputTokens || 0) + usage.cached_input_tokens,
          outputTokens: (session.totalUsage?.outputTokens || 0) + usage.output_tokens,
          contextTokens: usage.input_tokens + usage.cached_input_tokens + usage.output_tokens,
        };
        if (typeof part?.cost === 'number' && Number.isFinite(part.cost)) {
          session.totalCost = (session.totalCost || 0) + part.cost;
        }
        saveSession(session);
        wsSend(entry.ws, { type: 'usage', totalUsage: session.totalUsage });
      }
      entry.lastUsage = usage;
      if (typeof part?.cost === 'number' && Number.isFinite(part.cost)) {
        entry.lastCost = part.cost;
      }
    }
  }

  const runtimeHandlers = {
    claude: {
      buildSpawnSpec: buildClaudeSpawnSpec,
      processEvent: processClaudeEvent,
    },
    codex: {
      buildSpawnSpec: buildCodexSpawnSpec,
      processEvent: processCodexEvent,
    },
    kimi: {
      buildSpawnSpec: buildKimiSpawnSpec,
      processEvent: processKimiEvent,
    },
    codebuddy: {
      buildSpawnSpec: buildCodebuddySpawnSpec,
      processEvent: processCodebuddyEvent,
    },
    opencode: {
      buildSpawnSpec: buildOpencodeSpawnSpec,
      processEvent: processOpencodeEvent,
    },
  };

  function getRuntimeHandler(agent) {
    const agentId = normalizeAgent(agent);
    return runtimeHandlers[agentId] || runtimeHandlers[DEFAULT_AGENT] || runtimeHandlers[getAgentConfig(agentId).id];
  }

  function buildSpawnSpec(session, options = {}) {
    return getRuntimeHandler(session?.agent).buildSpawnSpec(session, options);
  }

  function processRuntimeEvent(entry, event, sessionId) {
    getRuntimeHandler(entry?.agent).processEvent(entry, event, sessionId);
  }

  return {
    buildSpawnSpec,
    buildClaudeSpawnSpec,
    buildCodexSpawnSpec,
    buildCodebuddySpawnSpec,
    buildKimiSpawnSpec,
    buildOpencodeSpawnSpec,
    processClaudeEvent,
    processCodexEvent,
    processCodebuddyEvent,
    processKimiEvent,
    processOpencodeEvent,
    processRuntimeEvent,
  };
}

module.exports = { createAgentRuntime };

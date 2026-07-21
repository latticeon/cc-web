#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const REPO_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_DIR, 'server.js');
const MOCK_CLAUDE = path.join(REPO_DIR, 'scripts', process.platform === 'win32' ? 'mock-claude.cmd' : 'mock-claude.js');
const MOCK_CODEX = path.join(REPO_DIR, 'scripts', process.platform === 'win32' ? 'mock-codex.cmd' : 'mock-codex.js');
const MOCK_CODEBUDDY = path.join(REPO_DIR, 'scripts', process.platform === 'win32' ? 'mock-codebuddy.cmd' : 'mock-codebuddy.js');
const MOCK_KIMI = path.join(REPO_DIR, 'scripts', process.platform === 'win32' ? 'mock-kimi.cmd' : 'mock-kimi.js');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close(() => resolve(port));
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sql(dbPath, statement) {
  const result = spawnSync('sqlite3', [dbPath, statement], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 failed: ${statement}`);
  return result.stdout.trim();
}

async function waitForPort(port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function withServer(env, fn) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForPort(env.PORT, 10000);
    await fn({ child, stdout: () => stdout, stderr: () => stderr });
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
}

function connectWs(port, password) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', password }));
    });
    ws.on('message', (buf) => {
      const msg = JSON.parse(String(buf));
      messages.push(msg);
      if (msg.type === 'auth_result' && msg.success) resolve({ ws, messages, token: msg.token });
      if (msg.type === 'auth_result' && !msg.success) reject(new Error('Auth failed'));
    });
    ws.on('error', reject);
  });
}

async function uploadAttachment(port, token, { filename, mime, data }) {
  const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mime,
      'X-Filename': encodeURIComponent(filename),
    },
    body: data,
  });
  const payload = await response.json();
  assert(response.ok && payload.ok, `Attachment upload failed: ${payload.message || response.status}`);
  return payload.attachment;
}

function nextMessage(messages, ws, predicate, timeoutMs = 15000) {
  const callSite = (() => {
    const stack = String(new Error().stack || '').split('\n');
    return (stack[3] || stack[2] || '').trim();
  })();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const idx = messages.findIndex(predicate);
      if (idx !== -1) {
        clearInterval(timer);
        const found = messages.splice(idx, 1)[0];
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        const recentTypes = messages.slice(-12).map((m) => m?.type).join(', ');
        const pendingTypes = messages.slice(0, 12).map((m) => m?.type).join(', ');
        reject(new Error(`Timed out waiting for expected WebSocket message (wsState=${ws.readyState}, callSite=${callSite}, pendingTypes=[${pendingTypes}], recentTypes=[${recentTypes}])`));
      }
    }, 50);
  });
}

function createFakeClaudeHistory(homeDir) {
  const projectDir = path.join(homeDir, '.claude', 'projects', 'tmp-project');
  mkdirp(projectDir);
  const sessionId = 'claude-import-test';
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'user',
      cwd: '/tmp/project-a',
      timestamp: '2026-03-12T00:00:00.000Z',
      message: { content: 'Claude import prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-12T00:00:02.000Z',
      message: { content: [{ type: 'text', text: 'Claude import answer' }] },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return { sessionId, projectDir: 'tmp-project', filePath };
}

function createFakeCodexHistory(homeDir) {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '12');
  mkdirp(sessionsDir);
  const threadId = 'codex-import-thread';
  const rolloutPath = path.join(sessionsDir, 'rollout-2026-03-12T00-00-00-codex-import-thread.jsonl');
  const rolloutLines = [
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project-b', cli_version: '0.114.0', source: 'exec' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md wrapper should be ignored' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Codex import prompt' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex import answer' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 } },
      },
    }),
  ];
  fs.writeFileSync(rolloutPath, `${rolloutLines.join('\n')}\n`);

  const stateDb = path.join(homeDir, '.codex', 'state_5.sqlite');
  mkdirp(path.dirname(stateDb));
  sql(stateDb, `
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled'
    );
    CREATE TABLE IF NOT EXISTS stage1_outputs (
      thread_id TEXT PRIMARY KEY,
      source_updated_at INTEGER NOT NULL,
      raw_memory TEXT NOT NULL,
      rollout_summary TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_dynamic_tools (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      PRIMARY KEY(thread_id, position)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      message TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version)
    VALUES ('${threadId}', '${rolloutPath.replace(/'/g, "''")}', 1, 2, 'exec', 'OpenAI', '/tmp/project-b', 'Codex import prompt', '{}', 'never', '0.114.0');
    INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', '${threadId}');
  `);

  const logsDb = path.join(homeDir, '.codex', 'logs_1.sqlite');
  sql(logsDb, `
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      message TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', '${threadId}');
  `);

  return { threadId, rolloutPath, stateDb, logsDb };
}

function createFakeKimiConfig(homeDir) {
  const shareDir = path.join(homeDir, '.kimi');
  mkdirp(shareDir);
  fs.writeFileSync(path.join(shareDir, 'config.toml'), [
    'default_model = "kimi-k2-turbo-preview"',
    '',
    '[models.kimi-k2-turbo-preview]',
    'description = "Regression default model"',
    '',
    '[models.kimi-k2-0905-preview]',
    'description = "Regression preview model"',
    '',
  ].join('\n'));
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-regression-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  fs.writeFileSync(path.join(configDir, 'notify.json'), JSON.stringify({
    provider: 'off',
    pushplus: { token: '' },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
  }, null, 2));

  createFakeClaudeHistory(homeDir);
  const codexFixture = createFakeCodexHistory(homeDir);
  createFakeKimiConfig(homeDir);

  const port = await getFreePort();
  const password = 'Regression!234';

  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
    CODEBUDDY_PATH: MOCK_CODEBUDDY,
    KIMI_PATH: MOCK_KIMI,
  }, async () => {
    const { ws, messages, token } = await connectWs(port, password);

    await nextMessage(messages, ws, (msg) => msg.type === 'session_list');

    ws.send(JSON.stringify({
      type: 'save_codex_config',
      config: {
        mode: 'custom',
        activeProfile: 'Regression Profile',
        profiles: [{ name: 'Regression Profile', apiKey: 'sk-regression', apiBase: 'https://example.com/v1' }],
        enableSearch: true,
      },
    }));
    const codexConfigMsg = await nextMessage(messages, ws, (msg) => msg.type === 'codex_config');
    assert(codexConfigMsg.config.mode === 'custom', 'Codex config mode save/load failed');
    assert(codexConfigMsg.config.activeProfile === 'Regression Profile', 'Codex active profile save/load failed');
    assert(Array.isArray(codexConfigMsg.config.profiles) && codexConfigMsg.config.profiles[0]?.apiKey.includes('****'), 'Codex profile API key should be masked');
    assert(codexConfigMsg.config.supportsSearch === false, 'Codex config should expose unsupported search capability');
    assert(codexConfigMsg.config.enableSearch === false, 'Codex config should ignore unsupported search toggle');

    const codexInitCwd = path.join(tempRoot, 'codex-space');
    mkdirp(codexInitCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'codex', cwd: codexInitCwd, mode: 'plan' }));
    const codexSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.cwd === codexInitCwd);
    assert(codexSession.mode === 'plan', 'Codex new_session should follow requested mode');
    assert(codexSession.model === 'gpt-5.4', 'Codex new_session should inject default model gpt-5.4');

    ws.send(JSON.stringify({ type: 'message', text: '/init', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    const codexInitStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /AGENTS\.md/.test(msg.message || ''));
    assert(/AGENTS\.md/.test(codexInitStart.message || ''), 'Codex /init should announce AGENTS.md generation');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codexSession.sessionId);
    assert(fs.existsSync(path.join(codexInitCwd, 'AGENTS.md')), 'Codex /init should generate AGENTS.md in the workspace');

    ws.send(JSON.stringify({ type: 'message', text: 'wait for abort', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && msg.sessions.some((s) => s.id === codexSession.sessionId && s.isRunning));
    const abortStartedAt = Date.now();
    ws.send(JSON.stringify({ type: 'abort' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codexSession.sessionId, 2500);
    assert(Date.now() - abortStartedAt < 2500, 'Codex abort should not wait for the old three-second force-kill fallback');

    const protocolCompleteStartedAt = Date.now();
    ws.send(JSON.stringify({ type: 'message', text: 'complete then linger', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codexSession.sessionId, 2500);
    assert(Date.now() - protocolCompleteStartedAt < 2500, 'Codex protocol completion should not wait for the CLI process to exit on its own');

    ws.send(JSON.stringify({ type: 'message', text: '/model gpt-5.6-luna(low)', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    const codexModelChanged = await nextMessage(messages, ws, (msg) => msg.type === 'model_changed' && msg.model === 'gpt-5.6-luna(low)');
    assert(codexModelChanged.model === 'gpt-5.6-luna(low)', 'Codex /model should accept model names with reasoning effort');

    const codexAttachment = await uploadAttachment(port, token, {
      filename: 'codex-test.png',
      mime: 'image/png',
      data: Buffer.from('codex-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'first codex prompt', attachments: [codexAttachment], mode: 'yolo', agent: 'codex' }));
    const firstMessageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.title === 'first codex prompt');
    assert(firstMessageSession.agent === 'codex', 'First-message path created wrong agent');
    const runningSessionList = await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && msg.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning));
    assert(runningSessionList.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning), 'Running Codex session should be marked as isRunning');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);

    // Switching permission mode must not clear Codex thread id (otherwise resume loses context).
    const codexSessionPath = path.join(sessionsDir, `${firstMessageSession.sessionId}.json`);
    await waitForFile(codexSessionPath, 15000);
    const storedAfterFirst = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    const threadIdBeforeMode = storedAfterFirst.codexThreadId;
    assert(threadIdBeforeMode, 'Codex thread id should be persisted after first run');

    ws.send(JSON.stringify({ type: 'set_mode', sessionId: firstMessageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    await waitForFile(codexSessionPath, 15000);
    const storedAfterMode = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    assert(storedAfterMode.codexThreadId === threadIdBeforeMode, 'Codex thread id should survive mode switch');

    ws.send(JSON.stringify({ type: 'message', text: 'second codex prompt', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);

    const processLog = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8');
    const spawnLine = processLog
      .trim()
      .split('\n')
      .find((line) => line.includes(`"event":"process_spawn"`) && line.includes(firstMessageSession.sessionId.slice(0, 8)));
    assert(spawnLine && !spawnLine.includes('--search') && spawnLine.includes('--image'), 'Codex exec should attach images and not append unsupported --search flag');
    const spawnEntry = JSON.parse(spawnLine);
    assert(spawnEntry.args.includes('--model gpt-5.6-luna'), 'Codex exec should pass the base model without reasoning suffix');
    assert(!spawnEntry.args.includes('--model "gpt-5.6-luna(low)"') && !spawnEntry.args.includes("--model 'gpt-5.6-luna(low)'"), 'Codex exec should not pass reasoning effort as part of the model name');
    assert(spawnEntry.args.includes('model_reasoning_effort=low'), 'Codex exec should pass low reasoning effort as a quote-free config override');

	    const allSpawnsForSession = processLog
	      .trim()
	      .split('\n')
	      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(firstMessageSession.sessionId.slice(0, 8)));
	    const lastSpawn = allSpawnsForSession[allSpawnsForSession.length - 1] || '';
	    const lastSpawnArgs = lastSpawn ? String(JSON.parse(lastSpawn).args || '') : '';
	    assert(lastSpawnArgs.includes('resume') && lastSpawnArgs.includes(threadIdBeforeMode), 'Codex mode switch should keep resume thread id');
	    assert(lastSpawnArgs.includes('-s read-only'), 'Codex plan mode should set sandbox read-only');
	    assert(lastSpawnArgs.indexOf('-s read-only') < lastSpawnArgs.indexOf('resume'), 'Codex resume in plan mode must place -s before resume subcommand');

    const runtimeToml = fs.readFileSync(path.join(configDir, 'codex-runtime-home', 'config.toml'), 'utf8');
    assert(runtimeToml.includes('preferred_auth_method = "apikey"'), 'Codex custom profile should write isolated runtime auth mode');
    assert(runtimeToml.includes('base_url = "https://example.com/v1"'), 'Codex custom profile should write isolated runtime base_url');

    ws.send(JSON.stringify({ type: 'message', text: '/model gpt-5.3-codex', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'model_changed' && msg.model === 'gpt-5.3-codex');

    ws.send(JSON.stringify({ type: 'message', text: '/compact', sessionId: firstMessageSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /正在执行/.test(msg.message || '') && /Codex \/compact/.test(msg.message || ''));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);
    const compactDoneMsg = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(compactDoneMsg.message || ''), 'Codex /compact should complete with Codex-specific status message');

    const autoCompactCwd = path.join(tempRoot, 'codex-auto-compact');
    mkdirp(autoCompactCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'codex', cwd: autoCompactCwd, mode: 'yolo' }));
    const autoCompactSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.cwd === autoCompactCwd);
    ws.send(JSON.stringify({ type: 'message', text: 'warm up auto compact', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === autoCompactSession.sessionId);
    ws.send(JSON.stringify({ type: 'message', text: 'trigger codex context limit', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    const autoCompactStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /正在按 Codex \/compact 自动压缩/.test(msg.message || ''));
    assert(/Codex \/compact/.test(autoCompactStart.message || ''), 'Codex auto /compact should announce auto compact start');
    const autoCompactDone = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(autoCompactDone.message || ''), 'Codex auto /compact should finish compact step');
	    const autoCompactResume = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /按 Codex 压缩计划继续执行/.test(msg.message || ''));
	    assert(/继续执行/.test(autoCompactResume.message || ''), 'Codex auto /compact should announce retry');
	    // Some Codex builds won't echo the original prompt text as a text delta on retry; accept either.
    const autoCompactRetry = await nextMessage(messages, ws, (msg) => (
	      (msg.type === 'text_delta' && /trigger codex context limit/.test(msg.text || '')) ||
	      (msg.type === 'done' && msg.sessionId === autoCompactSession.sessionId)
	    ), 20000);
	    if (autoCompactRetry.type === 'text_delta') {
	      assert(/trigger codex context limit/.test(autoCompactRetry.text || ''), 'Codex auto /compact should replay the failed prompt after compact');
	    }

    ws.send(JSON.stringify({ type: 'list_agent_models', agent: 'codebuddy', requestId: 'codebuddy-models' }));
    const codebuddyModels = await nextMessage(messages, ws, (msg) => msg.type === 'agent_models_result' && msg.agent === 'codebuddy');
    assert(codebuddyModels.success === true, 'CodeBuddy model list should load from CLI');
    const codebuddyModelIds = (codebuddyModels.models || []).map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean);
    assert(codebuddyModelIds.includes('glm-5.1'), 'CodeBuddy model list missing glm-5.1');
    assert(codebuddyModelIds.includes('glm-5.0'), 'CodeBuddy model list missing glm-5.0');

    const codebuddyInitCwd = path.join(tempRoot, 'codebuddy-space');
    mkdirp(codebuddyInitCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'codebuddy', cwd: codebuddyInitCwd, mode: 'plan' }));
    const codebuddySession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codebuddy' && msg.cwd === codebuddyInitCwd);
    assert(codebuddySession.mode === 'plan', 'CodeBuddy new_session should follow requested mode');

    ws.send(JSON.stringify({ type: 'message', text: '/init', sessionId: codebuddySession.sessionId, mode: 'plan', agent: 'codebuddy' }));
    const codebuddyInitSignal = await nextMessage(messages, ws, (msg) => (
      (msg.type === 'system_message' && /AGENTS\.md/.test(msg.message || ''))
      || (msg.type === 'done' && msg.sessionId === codebuddySession.sessionId)
    ), 20000);
    if (codebuddyInitSignal.type === 'system_message') {
      assert(/AGENTS\.md/.test(codebuddyInitSignal.message || ''), 'CodeBuddy /init should announce AGENTS.md generation');
      await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codebuddySession.sessionId, 20000);
    }
    assert(fs.existsSync(path.join(codebuddyInitCwd, 'AGENTS.md')), 'CodeBuddy /init should generate AGENTS.md in the workspace');

    ws.send(JSON.stringify({ type: 'message', text: '/model glm-5.0', sessionId: codebuddySession.sessionId, mode: 'plan', agent: 'codebuddy' }));
    const codebuddyModelChanged = await nextMessage(messages, ws, (msg) => msg.type === 'model_changed' && msg.model === 'glm-5.0');
    assert(codebuddyModelChanged.model === 'glm-5.0', 'CodeBuddy /model should accept arbitrary model names');

    const codebuddyAttachment = await uploadAttachment(port, token, {
      filename: 'codebuddy-test.png',
      mime: 'image/png',
      data: Buffer.from('codebuddy-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'first codebuddy prompt', attachments: [codebuddyAttachment], mode: 'yolo', agent: 'codebuddy' }));
    const codebuddyImageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codebuddy' && msg.title === 'first codebuddy prompt');
    const runtimeModelChanged = await nextMessage(messages, ws, (msg) => msg.type === 'model_changed' && msg.model === 'glm-5.1');
    assert(runtimeModelChanged.model === 'glm-5.1', 'CodeBuddy runtime should report the effective default model');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codebuddyImageSession.sessionId);

    const storedCodebuddySession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${codebuddyImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedCodebuddySession.messages?.[0]?.attachments) && storedCodebuddySession.messages[0].attachments.length === 1, 'CodeBuddy message should persist attachment metadata');
    assert(storedCodebuddySession.codebuddySessionId, 'CodeBuddy session id should be persisted after first run');
    const codebuddySessionIdBeforeMode = storedCodebuddySession.codebuddySessionId;

    const codebuddySpawnLine = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .find((line) => line.includes(`"event":"process_spawn"`) && line.includes(codebuddyImageSession.sessionId.slice(0, 8)));
    assert(codebuddySpawnLine && codebuddySpawnLine.includes('--output-format stream-json'), 'CodeBuddy message should request stream-json output');
    assert(codebuddySpawnLine.includes('--input-format stream-json'), 'CodeBuddy image message should switch stdin to stream-json');
    assert(codebuddySpawnLine.includes('--permission-mode bypassPermissions'), 'CodeBuddy yolo mode should map to bypassPermissions');

    ws.send(JSON.stringify({ type: 'set_mode', sessionId: codebuddyImageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    const storedCodebuddyAfterMode = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${codebuddyImageSession.sessionId}.json`), 'utf8'));
    assert(storedCodebuddyAfterMode.codebuddySessionId === codebuddySessionIdBeforeMode, 'CodeBuddy session id should survive mode switch');
    assert(storedCodebuddyAfterMode.model === 'glm-5.1', 'CodeBuddy runtime model should be persisted after first run');

    ws.send(JSON.stringify({ type: 'message', text: 'second codebuddy prompt', sessionId: codebuddyImageSession.sessionId, mode: 'plan', agent: 'codebuddy' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codebuddyImageSession.sessionId);
    const codebuddySpawns = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(codebuddyImageSession.sessionId.slice(0, 8)));
    const lastCodebuddySpawn = codebuddySpawns[codebuddySpawns.length - 1] || '';
    assert(lastCodebuddySpawn.includes(`--resume ${codebuddySessionIdBeforeMode}`), 'CodeBuddy mode switch should keep --resume session id');
    assert(lastCodebuddySpawn.includes('--permission-mode plan'), 'CodeBuddy plan mode should pass --permission-mode plan');
    assert(lastCodebuddySpawn.includes('--model glm-5.1'), 'CodeBuddy resumed run should reuse the persisted runtime model');

    ws.send(JSON.stringify({ type: 'list_agent_models', agent: 'kimi', requestId: 'kimi-models' }));
    const kimiModels = await nextMessage(messages, ws, (msg) => msg.type === 'agent_models_result' && msg.agent === 'kimi');
    assert(kimiModels.success === true, 'Kimi model list should load from ~/.kimi/config.toml');
    assert(kimiModels.models.includes('kimi-k2-turbo-preview'), 'Kimi model list missing default model');
    assert(kimiModels.models.includes('kimi-k2-0905-preview'), 'Kimi model list missing extra model');

    const kimiInitCwd = path.join(tempRoot, 'kimi-space');
    mkdirp(kimiInitCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'kimi', cwd: kimiInitCwd, mode: 'plan' }));
    const kimiSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'kimi' && msg.cwd === kimiInitCwd);
    assert(kimiSession.mode === 'plan', 'Kimi new_session should follow requested mode');
    assert(kimiSession.model === 'kimi-k2-turbo-preview', 'Kimi new_session should inject default model from config');

    ws.send(JSON.stringify({ type: 'message', text: '/init', sessionId: kimiSession.sessionId, mode: 'plan', agent: 'kimi' }));
    const kimiInitStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /AGENTS\.md/.test(msg.message || '') && /Kimi|分析项目/.test(msg.message || ''));
    assert(/AGENTS\.md/.test(kimiInitStart.message || ''), 'Kimi /init should announce AGENTS.md generation');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === kimiSession.sessionId);
    assert(fs.existsSync(path.join(kimiInitCwd, 'AGENTS.md')), 'Kimi /init should generate AGENTS.md in the workspace');

    const kimiAttachment = await uploadAttachment(port, token, {
      filename: 'kimi-test.png',
      mime: 'image/png',
      data: Buffer.from('kimi-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'first kimi prompt', attachments: [kimiAttachment], mode: 'yolo', agent: 'kimi' }));
    const kimiImageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'kimi' && msg.title === 'first kimi prompt');
    const kimiToolStart = await nextMessage(messages, ws, (msg) => msg.type === 'tool_start' && msg.name === 'shell_command');
    assert(kimiToolStart.input?.command === 'pwd', 'Kimi tool call should expose parsed tool input');
    await nextMessage(messages, ws, (msg) => msg.type === 'tool_end' && msg.toolUseId === kimiToolStart.toolUseId);
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === kimiImageSession.sessionId);

    const storedKimiSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${kimiImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedKimiSession.messages?.[0]?.attachments) && storedKimiSession.messages[0].attachments.length === 1, 'Kimi message should persist attachment metadata');
    assert(storedKimiSession.kimiSessionId, 'Kimi session id should be persisted after first run');
    const kimiSessionIdBeforeMode = storedKimiSession.kimiSessionId;

    const kimiSpawnLine = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .find((line) => line.includes(`"event":"process_spawn"`) && line.includes(kimiImageSession.sessionId.slice(0, 8)));
    assert(kimiSpawnLine && kimiSpawnLine.includes('--input-format stream-json') && kimiSpawnLine.includes('--output-format stream-json'), 'Kimi message should use stream-json print mode');
    assert(kimiSpawnLine.includes('--yolo'), 'Kimi yolo mode should pass --yolo');
    assert(kimiSpawnLine.includes(`--session ${kimiSessionIdBeforeMode}`), 'Kimi first run should bind to a named session');

    ws.send(JSON.stringify({ type: 'set_mode', sessionId: kimiImageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    const storedKimiAfterMode = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${kimiImageSession.sessionId}.json`), 'utf8'));
    assert(storedKimiAfterMode.kimiSessionId === kimiSessionIdBeforeMode, 'Kimi session id should survive mode switch');

    ws.send(JSON.stringify({ type: 'message', text: 'second kimi prompt', sessionId: kimiImageSession.sessionId, mode: 'plan', agent: 'kimi' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === kimiImageSession.sessionId);
    const kimiSpawns = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(kimiImageSession.sessionId.slice(0, 8)));
    const lastKimiSpawn = kimiSpawns[kimiSpawns.length - 1] || '';
    assert(lastKimiSpawn.includes(`--session ${kimiSessionIdBeforeMode}`), 'Kimi mode switch should keep named session id');
    assert(lastKimiSpawn.includes('--plan'), 'Kimi plan mode should pass --plan');

    ws.send(JSON.stringify({ type: 'message', text: '/compact', sessionId: kimiImageSession.sessionId, mode: 'yolo', agent: 'kimi' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /正在执行 Kimi \/compact/.test(msg.message || ''));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === kimiImageSession.sessionId);
    const kimiCompactDone = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已执行 Kimi \/compact/.test(msg.message || ''));
    assert(/已执行 Kimi \/compact/.test(kimiCompactDone.message || ''), 'Kimi /compact should complete with Kimi-specific status message');

    const claudeAttachment = await uploadAttachment(port, token, {
      filename: 'claude-test.png',
      mime: 'image/png',
      data: Buffer.from('claude-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'describe attachment', attachments: [claudeAttachment], mode: 'yolo', agent: 'claude' }));
    const claudeImageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'claude' && msg.title === 'describe attachment');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawnLine = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .find((line) => line.includes(`"event":"process_spawn"`) && line.includes(claudeImageSession.sessionId.slice(0, 8)));
    assert(claudeSpawnLine && claudeSpawnLine.includes('--input-format stream-json'), 'Claude image message should switch stdin to stream-json');
    const storedClaudeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedClaudeSession.messages?.[0]?.attachments) && storedClaudeSession.messages[0].attachments.length === 1, 'Claude message should persist attachment metadata');
    assert(storedClaudeSession.claudeSessionId, 'Claude session id should be persisted after first run');
    const claudeSessionIdBeforeMode = storedClaudeSession.claudeSessionId;

    // Mode switching must not clear Claude runtime session id (resume should keep context).
    ws.send(JSON.stringify({ type: 'set_mode', sessionId: claudeImageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    const storedClaudeAfterMode = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(storedClaudeAfterMode.claudeSessionId === claudeSessionIdBeforeMode, 'Claude session id should survive mode switch');

    ws.send(JSON.stringify({ type: 'message', text: 'second claude prompt', sessionId: claudeImageSession.sessionId, mode: 'plan', agent: 'claude' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawns = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(claudeImageSession.sessionId.slice(0, 8)));
    const lastClaudeSpawn = claudeSpawns[claudeSpawns.length - 1] || '';
    assert(lastClaudeSpawn.includes(`--resume ${claudeSessionIdBeforeMode}`), 'Claude mode switch should keep --resume session id');
    assert(lastClaudeSpawn.includes('--permission-mode plan'), 'Claude plan mode should set --permission-mode plan');

    ws.send(JSON.stringify({ type: 'list_native_sessions' }));
    const nativeSessions = await nextMessage(messages, ws, (msg) => msg.type === 'native_sessions');
    assert(nativeSessions.groups?.length > 0, 'Claude native session listing failed');
    const firstClaude = nativeSessions.groups[0].sessions[0];
    ws.send(JSON.stringify({ type: 'import_native_session', sessionId: firstClaude.sessionId, projectDir: nativeSessions.groups[0].dir }));
    const importedClaude = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'claude' && msg.title === 'Claude import prompt');
    assert(importedClaude.messages?.[0]?.content === 'Claude import prompt', 'Claude import parsed wrong first message');

    ws.send(JSON.stringify({ type: 'list_codex_sessions' }));
    const codexSessions = await nextMessage(messages, ws, (msg) => msg.type === 'codex_sessions');
    const importedCodexItem = codexSessions.sessions.find((item) => item.threadId === codexFixture.threadId);
    assert(importedCodexItem, 'Codex session listing failed');

    ws.send(JSON.stringify({ type: 'import_codex_session', threadId: importedCodexItem.threadId, rolloutPath: importedCodexItem.rolloutPath }));
    const importedCodex = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.title === 'Codex import prompt');
    assert(importedCodex.messages?.[0]?.content === 'Codex import prompt', 'Codex import kept wrapper instructions');
    assert(importedCodex.totalUsage?.inputTokens === 20, 'Codex import usage parse failed');

    const importedSessionId = importedCodex.sessionId;
    ws.send(JSON.stringify({ type: 'delete_session', sessionId: importedSessionId }));
    await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && !msg.sessions.some((s) => s.id === importedSessionId));

    assert(!fs.existsSync(path.join(sessionsDir, `${importedSessionId}.json`)), 'Deleting Codex session did not remove session JSON');
    assert(!fs.existsSync(codexFixture.rolloutPath), 'Deleting Codex session did not remove rollout file');
    assert(sql(codexFixture.stateDb, `select count(*) from threads where id='${codexFixture.threadId}'`) === '0', 'Deleting Codex session did not remove thread row');

    ws.close();
    console.log('Regression checks passed.');
  });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
